//! 路径边界与文件系统原语
//!
//! 便携知识库的第一条安全规则：**知识库里的一切路径都是相对路径**，
//! 而且必须能证明解析结果仍然落在知识库根目录内。
//!
//! 这一层只做「怎么安全地碰文件」，不做业务判断：节点目录生命周期在 `nodes.rs`，
//! 资料在 `resources.rs`，跨阶段恢复在 `fsops.rs`。

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};

use crate::models::{CmdError, CmdResult};

/// 知识库内部固定名称
pub const MANIFEST_NAME: &str = "library.json";
pub const DATABASE_NAME: &str = "knowledge.sqlite";
pub const NODES_DIR: &str = "nodes";
pub const FILES_DIR: &str = "files";
pub const NOTE_NAME: &str = "note.md";
pub const TRASH_DIR: &str = "trash";
pub const TRASH_NODES_DIR: &str = "nodes";
pub const TRASH_RESOURCES_DIR: &str = "resources";
pub const META_DIR: &str = ".knowledgenet";
pub const OPERATIONS_DIR: &str = "operations";
pub const RECOVERY_DIR: &str = "recovery";
pub const LOCK_NAME: &str = "lock";
/// 冲突副本目录（放在操作目录里，不污染节点目录）
pub const CONFLICT_DIR: &str = "conflicts";

/* ---------------------------------- 时间 ---------------------------------- */

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let nanos = (ms.rem_euclid(1000) * 1_000_000) as u32;
    match DateTime::<Utc>::from_timestamp(secs, nanos) {
        Some(dt) => dt.to_rfc3339_opts(SecondsFormat::Millis, true),
        None => "1970-01-01T00:00:00.000Z".to_string(),
    }
}

pub fn iso_now() -> String {
    iso_from_ms(now_ms())
}

/// 修改时间（毫秒）；拿不到时返回 0，界面显示「未知」而不是崩溃
pub fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ---------------------------------- ID ---------------------------------- */

/// 新建实体 ID：UUIDv7。
/// 由 Rust 统一发号，前端不得用 `Date.now() + random` 自行拼 ID。
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

/// 校验 ID 形状。ID 是身份而不是路径，形状不对一律拒绝，
/// 避免把 `..` 之类的东西当成 ID 传进路径拼接。
pub fn require_uuid(value: &str, what: &str) -> CmdResult<()> {
    if is_uuid(value) {
        Ok(())
    } else {
        Err(CmdError::invalid(format!(
            "{what} 不是合法的 UUID：{value}"
        )))
    }
}

/* ------------------------------- 相对路径 ------------------------------- */

/// 校验并规范化知识库内部的相对路径。
///
/// 拒绝：绝对路径、盘符、UNC、`..`、空组件、反斜杠以外的路径分隔写法、
/// 以及 Windows 上的设备名（`CON`、`NUL`…）。返回值统一用 `/` 分隔。
pub fn validate_relative_path(raw: &str) -> CmdResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CmdError::invalid("相对路径不能为空"));
    }
    if trimmed.contains('\0') {
        return Err(CmdError::invalid("相对路径包含非法字符"));
    }
    // 反斜杠一律当作分隔符，避免同一路径出现两种写法
    let unified = trimmed.replace('\\', "/");
    if unified.starts_with('/') {
        return Err(CmdError::invalid(format!("不允许绝对路径：{raw}")));
    }
    // `C:` 或 `\\server\share` 这类写法在统一分隔符后仍会露出冒号
    if unified.contains(':') {
        return Err(CmdError::invalid(format!("不允许盘符或设备路径：{raw}")));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        if part.is_empty() {
            return Err(CmdError::invalid(format!("路径含空组件：{raw}")));
        }
        if part == "." || part == ".." {
            return Err(CmdError::invalid(format!("路径不允许包含 . 或 ..：{raw}")));
        }
        if part.ends_with(' ') || part.ends_with('.') {
            return Err(CmdError::invalid(format!(
                "路径组件不能以空格或点结尾：{raw}"
            )));
        }
        if is_reserved_device_name(part) {
            return Err(CmdError::invalid(format!(
                "路径组件是 Windows 设备名：{part}"
            )));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

fn is_reserved_device_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).trim();
    let upper = stem.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$"
    ) || (upper.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && upper.as_bytes()[3].is_ascii_digit()
        && upper.as_bytes()[3] != b'0')
}

/// 把用户原始文件名安全化成磁盘文件名。
///
/// 数据库里始终保留原始名称，磁盘名只用于文件系统：
/// 替换 Windows 禁止字符、去掉尾部空格与点、处理保留设备名、限制单段长度。
pub fn safe_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        let bad = matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            || (ch as u32) < 0x20;
        out.push(if bad { '_' } else { ch });
    }
    // Windows 不允许文件名以空格或点结尾
    while out.ends_with(' ') || out.ends_with('.') {
        out.pop();
    }
    if out.is_empty() {
        out = "unnamed".to_string();
    }

    // 拆出扩展名，保留它比保留开头更重要（否则双击打不开）
    let (stem, ext) = match out.rfind('.') {
        Some(idx) if idx > 0 && idx + 1 < out.len() => {
            (out[..idx].to_string(), out[idx..].to_string())
        }
        _ => (out.clone(), String::new()),
    };
    let mut stem = if is_reserved_device_name(&stem) {
        format!("_{stem}")
    } else {
        stem
    };
    // 单段最长 180 个字符（NTFS 255 上限，留出资源目录与临时后缀的余量）
    let ext_len = ext.chars().count();
    let max_stem = 180usize.saturating_sub(ext_len).max(16);
    if stem.chars().count() > max_stem {
        stem = stem.chars().take(max_stem).collect();
    }
    format!("{stem}{ext}")
}

/* ----------------------------- 知识库路径集合 ----------------------------- */

/// 去掉 Windows 的 `\\?\` verbatim 前缀。
///
/// `fs::canonicalize` 在 Windows 上返回的是 verbatim 路径（`\\?\C:\...`）：
/// 它适合做边界比较（长路径、不做额外解析），但**不适合显示给用户**，
/// 也不适合与用户选择器/`tempdir` 给出的普通绝对路径直接拼比较。
/// 所以：`canonical_root` 保留 verbatim 形式用于边界检查，`root` 用去前缀后的形式，
/// 相对路径转换对两种写法都容忍。
pub fn strip_verbatim(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// 知识库的路径解析器。
///
/// 业务层只传 `nodeId` / `resourceId`，由这里根据数据库登记的 `storage_relpath`
/// 解析实际文件，从根上避免前端拼出逃出知识库的路径。
#[derive(Debug, Clone)]
pub struct LibraryPaths {
    /// 用于拼接与显示（Windows 上不含 `\\?\` 前缀）
    root: PathBuf,
    /// 用于边界检查：canonicalize 之后的真实路径（可能含 `\\?\`）
    canonical_root: PathBuf,
}

impl LibraryPaths {
    /// 打开已有知识库：根目录必须存在，canonicalize 之后作为边界
    pub fn for_existing(root: &Path) -> CmdResult<Self> {
        let canonical_root = fs::canonicalize(root)
            .map_err(|e| CmdError::io(format!("无法解析知识库根目录 {}：{e}", root.display())))?;
        if !canonical_root.is_dir() {
            return Err(CmdError::invalid(format!(
                "知识库根目录不是一个目录：{}",
                canonical_root.display()
            )));
        }
        Ok(Self {
            root: strip_verbatim(&canonical_root),
            canonical_root,
        })
    }

    /// 新建知识库：目标目录还不存在，先 canonicalize 父目录
    pub fn for_new(root: &Path) -> CmdResult<Self> {
        let parent = root
            .parent()
            .ok_or_else(|| CmdError::invalid("目标路径没有父目录"))?;
        let canonical_parent =
            fs::canonicalize(parent).map_err(|e| CmdError::io(format!("无法解析父目录 {}：{e}", parent.display())))?;
        let name = root
            .file_name()
            .ok_or_else(|| CmdError::invalid("目标路径没有目录名"))?;
        let canonical_root = canonical_parent.join(name);
        Ok(Self {
            root: strip_verbatim(&canonical_root),
            canonical_root,
        })
    }

    /// 从已知的规范根目录重建（复制、恢复之后使用）
    pub fn from_canonical(canonical_root: PathBuf) -> Self {
        Self {
            root: strip_verbatim(&canonical_root),
            canonical_root,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn manifest(&self) -> PathBuf {
        self.root.join(MANIFEST_NAME)
    }

    pub fn database(&self) -> PathBuf {
        self.root.join(DATABASE_NAME)
    }

    pub fn nodes_dir(&self) -> PathBuf {
        self.root.join(NODES_DIR)
    }

    pub fn node_dir(&self, node_id: &str) -> PathBuf {
        self.nodes_dir().join(node_id)
    }

    pub fn node_note(&self, node_id: &str) -> PathBuf {
        self.node_dir(node_id).join(NOTE_NAME)
    }

    pub fn node_files_dir(&self, node_id: &str) -> PathBuf {
        self.node_dir(node_id).join(FILES_DIR)
    }

    pub fn resource_dir(&self, node_id: &str, resource_id: &str) -> PathBuf {
        self.node_files_dir(node_id).join(resource_id)
    }

    pub fn trash_dir(&self) -> PathBuf {
        self.root.join(TRASH_DIR)
    }

    pub fn trash_nodes_dir(&self) -> PathBuf {
        self.trash_dir().join(TRASH_NODES_DIR)
    }

    /// `trash/nodes/<node-id>/<deletedAt>/`
    pub fn trash_node_dir(&self, node_id: &str, deleted_at: i64) -> PathBuf {
        self.trash_nodes_dir().join(node_id).join(deleted_at.to_string())
    }

    /// `trash/nodes/<node-id>/`：恢复时按节点找最近一次删除
    pub fn trash_node_parent(&self, node_id: &str) -> PathBuf {
        self.trash_nodes_dir().join(node_id)
    }

    pub fn trash_resources_dir(&self) -> PathBuf {
        self.trash_dir().join(TRASH_RESOURCES_DIR)
    }

    pub fn trash_resource_dir(&self, resource_id: &str, deleted_at: i64) -> PathBuf {
        self.trash_resources_dir()
            .join(resource_id)
            .join(deleted_at.to_string())
    }

    pub fn meta_dir(&self) -> PathBuf {
        self.root.join(META_DIR)
    }

    pub fn operations_dir(&self) -> PathBuf {
        self.meta_dir().join(OPERATIONS_DIR)
    }

    pub fn operation_dir(&self, operation_id: &str) -> PathBuf {
        self.operations_dir().join(operation_id)
    }

    pub fn recovery_dir(&self) -> PathBuf {
        self.meta_dir().join(RECOVERY_DIR)
    }

    pub fn lock_file(&self) -> PathBuf {
        self.meta_dir().join(LOCK_NAME)
    }

    pub fn conflicts_dir(&self, operation_id: &str) -> PathBuf {
        self.operation_dir(operation_id).join(CONFLICT_DIR)
    }

    /// 建立标准目录骨架（幂等）
    pub fn ensure_skeleton(&self) -> CmdResult<()> {
        for dir in [
            self.nodes_dir(),
            self.trash_nodes_dir(),
            self.trash_resources_dir(),
            self.operations_dir(),
            self.recovery_dir(),
        ] {
            fs::create_dir_all(&dir)
                .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", dir.display())))?;
        }
        Ok(())
    }

    /// 相对路径 → 绝对路径，并证明结果仍在知识库根目录内
    pub fn resolve_rel(&self, rel: &str) -> CmdResult<PathBuf> {
        let normalized = validate_relative_path(rel)?;
        let joined = self.root.join(normalized.replace('/', std::path::MAIN_SEPARATOR_STR));
        self.ensure_within(&joined)?;
        Ok(joined)
    }

    /// 边界检查：目标（或它最近的已存在祖先）必须落在 canonical 根目录内。
    ///
    /// 用 canonicalize 而不是字符串前缀比较，是为了让符号链接 / Windows
    /// reparse point 在指到知识库外面时被抓住。
    pub fn ensure_within(&self, target: &Path) -> CmdResult<PathBuf> {
        let mut probe = target.to_path_buf();
        loop {
            match fs::symlink_metadata(&probe) {
                Ok(_) => break,
                Err(_) => {
                    if !probe.pop() {
                        return Err(CmdError::invalid(format!(
                            "无法确定路径边界：{}",
                            target.display()
                        )));
                    }
                }
            }
        }
        let canonical_probe = fs::canonicalize(&probe)
            .map_err(|e| CmdError::io(format!("解析路径 {} 失败：{e}", probe.display())))?;
        if !canonical_probe.starts_with(&self.canonical_root) {
            return Err(CmdError::invalid(format!(
                "路径逃出了知识库根目录：{}",
                target.display()
            )));
        }
        Ok(target.to_path_buf())
    }

    /// 绝对路径 → 相对知识库根的 `/` 分隔路径。
    ///
    /// 对两种写法都容忍：`fs::canonicalize` 给出的 verbatim 路径（`\\?\C:\…`）
    /// 与用户选择器/`tempdir` 给出的普通绝对路径。
    pub fn relative_of(&self, absolute: &Path) -> CmdResult<String> {
        let normalized = strip_verbatim(absolute);
        let stripped = normalized.strip_prefix(&self.root).map_err(|_| {
            CmdError::invalid(format!("路径不在知识库内：{}", absolute.display()))
        })?;
        let mut parts: Vec<String> = Vec::new();
        for component in stripped.components() {
            match component {
                Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
                Component::CurDir => {}
                _ => {
                    return Err(CmdError::invalid(format!(
                        "路径含无法表示的部分：{}",
                        absolute.display()
                    )))
                }
            }
        }
        Ok(parts.join("/"))
    }
}

/* ------------------------------- 文件原语 ------------------------------- */

/// 是否为符号链接 / Windows reparse point（目录联接、OneDrive 占位符等）。
/// 默认策略：不跟随逃出知识库根目录的链接。
pub fn is_link_like(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return true;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                return meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
            }
            #[cfg(not(windows))]
            false
        }
        Err(_) => false,
    }
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 流式计算文件的 SHA-256 与字节数；不把大文件读进内存
pub fn sha256_file(path: &Path) -> CmdResult<(String, u64)> {
    let file = File::open(path)
        .map_err(|e| CmdError::io(format!("无法读取 {}：{e}", path.display())))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = reader
            .read(&mut buf)
            .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", path.display())))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        total += read as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// 流式复制并同时计算哈希。返回 `(sha256, 字节数)`。
/// 源文件在复制途中变化时，哈希与长度描述的是**实际写出的内容**。
pub fn copy_stream(src: &Path, dst: &Path) -> CmdResult<(String, u64)> {
    if is_link_like(src) {
        return Err(CmdError::invalid(format!(
            "源文件是符号链接或重解析点，已拒绝复制：{}",
            src.display()
        )));
    }
    let source = File::open(src)
        .map_err(|e| CmdError::io(format!("无法读取源文件 {}：{e}", src.display())))?;
    let source_len = source.metadata().map(|m| m.len()).ok();
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", parent.display())))?;
    }
    let target = File::create(dst)
        .map_err(|e| CmdError::io(format!("无法写入 {}：{e}", dst.display())))?;
    let mut reader = BufReader::with_capacity(256 * 1024, source);
    let mut writer = BufWriter::with_capacity(256 * 1024, target);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = reader
            .read(&mut buf)
            .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", src.display())))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buf[..read])
            .map_err(|e| CmdError::io(format!("写入 {} 失败：{e}", dst.display())))?;
        hasher.update(&buf[..read]);
        total += read as u64;
    }
    writer
        .flush()
        .map_err(|e| CmdError::io(format!("写入 {} 失败：{e}", dst.display())))?;
    // 复制过程中源文件被改小/不断增长时，落盘内容与元数据不一致要如实报错
    if let Some(expected) = source_len {
        if expected != total {
            return Err(CmdError::io(format!(
                "源文件在复制过程中发生变化（预期 {expected} 字节，实际 {total} 字节）：{}",
                src.display()
            )));
        }
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// 读出全部字节（仅用于小文件：note.md、清单、锁）
pub fn read_bytes(path: &Path) -> CmdResult<Vec<u8>> {
    fs::read(path).map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", path.display())))
}

/// 按 UTF-8 读取文本；非法字节用替换字符兜底，不让一个坏字节挡住整篇笔记
pub fn read_text(path: &Path) -> CmdResult<String> {
    let bytes = read_bytes(path)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// 就地写入新文件（**不**做替换）：边写边算哈希，写完 flush。
/// 返回 `(sha256, 字节数, 修改时间)`。
pub fn write_file_stream(path: &Path, content: &[u8]) -> CmdResult<(String, u64, i64)> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", parent.display())))?;
    }
    let mut file = File::create(path)
        .map_err(|e| CmdError::io(format!("无法写入 {}：{e}", path.display())))?;
    let mut hasher = Sha256::new();
    hasher.update(content);
    file.write_all(content)
        .map_err(|e| CmdError::io(format!("写入 {} 失败：{e}", path.display())))?;
    file.flush()
        .map_err(|e| CmdError::io(format!("刷新 {} 失败：{e}", path.display())))?;
    file.sync_all()
        .map_err(|e| CmdError::io(format!("同步 {} 失败：{e}", path.display())))?;
    let modified = file
        .metadata()
        .map(|m| modified_ms(&m))
        .unwrap_or_else(|_| now_ms());
    Ok((hex::encode(hasher.finalize()), content.len() as u64, modified))
}

/// 把已经写好的临时文件安全替换到目标位置。
///
/// 不能假设 Rust 的 `rename` 在 Windows 上会覆盖已有文件——那是 Unix 语义。
/// 这里走 `tempfile` 的 `persist`：Windows 上底层是 `MoveFileExW` +
/// `MOVEFILE_REPLACE_EXISTING`，目标存在时才会真正替换。
pub fn persist_temp_file(temp: tempfile::NamedTempFile, target: &Path) -> CmdResult<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", parent.display())))?;
    }
    temp.persist(target)
        .map_err(|e| CmdError::io(format!("替换 {} 失败：{}", target.display(), e.error)))?;
    Ok(())
}

/// 在指定目录创建临时文件（用于「先写到操作目录、再替换」的流程）
pub fn new_temp_in(dir: &Path) -> CmdResult<tempfile::NamedTempFile> {
    fs::create_dir_all(dir)
        .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", dir.display())))?;
    tempfile::Builder::new()
        .prefix(".kn-op-")
        .tempfile_in(dir)
        .map_err(|e| CmdError::io(format!("创建临时文件失败：{e}")))
}

/// 写入文本并在写入处安全替换：临时文件放在**目标同目录**，保证同一卷。
pub fn write_text_atomic(target: &Path, content: &str) -> CmdResult<(String, u64, i64)> {
    let parent = target
        .parent()
        .ok_or_else(|| CmdError::invalid("目标路径没有父目录"))?;
    fs::create_dir_all(parent)
        .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", parent.display())))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".kn-tmp-")
        .tempfile_in(parent)
        .map_err(|e| CmdError::io(format!("创建临时文件失败：{e}")))?;
    let (sha, len) = {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        temp.write_all(content.as_bytes())
            .map_err(|e| CmdError::io(format!("写入临时文件失败：{e}")))?;
        temp.flush()
            .map_err(|e| CmdError::io(format!("刷新临时文件失败：{e}")))?;
        temp.as_file()
            .sync_all()
            .map_err(|e| CmdError::io(format!("同步临时文件失败：{e}")))?;
        (hex::encode(hasher.finalize()), content.len() as u64)
    };
    temp.persist(target)
        .map_err(|e| CmdError::io(format!("替换 {} 失败：{e}", target.display())))?;
    let modified = fs::metadata(target)
        .map(|m| modified_ms(&m))
        .unwrap_or_else(|_| now_ms());
    Ok((sha, len, modified))
}

/// 移动目录或文件：**目标已存在时报错**，绝不静默覆盖
pub fn move_no_overwrite(src: &Path, dst: &Path) -> CmdResult<()> {
    if dst.exists() {
        return Err(CmdError::new(
            crate::models::code::CONFLICT,
            format!("目标已存在，已拒绝覆盖：{}", dst.display()),
        ));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", parent.display())))?;
    }
    fs::rename(src, dst).map_err(|e| {
        CmdError::io(format!(
            "移动失败（{} → {}）：{e}",
            src.display(),
            dst.display()
        ))
    })
}

/// 递归复制目录（保留结构，跟随普通文件，不跟随链接逃逸）
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> CmdResult<(i64, u64)> {
    let mut files = 0i64;
    let mut bytes = 0u64;
    if !src.exists() {
        return Ok((0, 0));
    }
    fs::create_dir_all(dst)
        .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", dst.display())))?;
    for entry in fs::read_dir(src)
        .map_err(|e| CmdError::io(format!("读取目录 {} 失败：{e}", src.display())))?
    {
        let entry = entry.map_err(|e| CmdError::io(format!("读取目录项失败：{e}")))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let meta = entry
            .metadata()
            .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", from.display())))?;
        if meta.is_dir() {
            let (f, b) = copy_dir_recursive(&from, &to)?;
            files += f;
            bytes += b;
        } else if meta.is_file() {
            let (_, len) = copy_stream(&from, &to)?;
            files += 1;
            bytes += len;
        } else if is_link_like(&from) {
            // 链接不复制：复制知识库时跟随链接会让副本指向原机器上的路径
            continue;
        }
    }
    Ok((files, bytes))
}

pub fn dir_usage(path: &Path) -> CmdResult<(i64, u64)> {
    let mut files = 0i64;
    let mut bytes = 0u64;
    if !path.exists() {
        return Ok((0, 0));
    }
    for entry in walkdir::WalkDir::new(path).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.file_type().is_file() {
            files += 1;
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok((files, bytes))
}

pub fn remove_file_if_exists(path: &Path) -> CmdResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(CmdError::io(format!("删除 {} 失败：{e}", path.display()))),
    }
}

pub fn remove_dir_if_exists(path: &Path) -> CmdResult<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(CmdError::io(format!("删除目录 {} 失败：{e}", path.display()))),
    }
}

/// 校验一个用户可见名称（知识库名、目录名片段）：不能是空、不能含路径分隔符
pub fn validate_simple_name(raw: &str, what: &str) -> CmdResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CmdError::invalid(format!("{what}不能为空")));
    }
    if trimmed.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(CmdError::invalid(format!(
            "{what}不能包含 / \\ : * ? \" < > | 这些字符"
        )));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(CmdError::invalid(format!("{what}不合法")));
    }
    if is_reserved_device_name(trimmed) {
        return Err(CmdError::invalid(format!(
            "{what}不能使用 Windows 设备名（CON、NUL、COM1…）"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 相对路径拒绝逃逸写法() {
        for bad in [
            "../outside",
            "nodes/../..",
            "C:/windows",
            "\\\\server\\share",
            "/etc/passwd",
            "nodes//x",
            "nodes/./x",
            "CON",
            "nodes/NUL/note.md",
            "nodes/trailing /note.md",
        ] {
            assert!(
                validate_relative_path(bad).is_err(),
                "应当拒绝：{bad}"
            );
        }
        assert_eq!(
            validate_relative_path("nodes/019f/note.md").unwrap(),
            "nodes/019f/note.md"
        );
        assert_eq!(
            validate_relative_path("nodes\\019f\\files\\a.pdf").unwrap(),
            "nodes/019f/files/a.pdf"
        );
    }

    #[test]
    fn 文件名安全化处理保留名与非法字符() {
        assert_eq!(safe_file_name("a:b*c?.pdf"), "a_b_c_.pdf");
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("con.txt"), "_con.txt");
        assert_eq!(safe_file_name("报告.pdf "), "报告.pdf");
        assert_eq!(safe_file_name(""), "unnamed");
        assert_eq!(safe_file_name("..."), "unnamed");
        assert!(safe_file_name(&format!("{}.md", "长".repeat(400)))
            .chars()
            .count()
            <= 180);
    }

    #[test]
    fn 原子写入替换已有文件并给出哈希() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        fs::write(&target, "旧内容").unwrap();
        let (sha, len, _) = write_text_atomic(&target, "新内容").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "新内容");
        assert_eq!(sha, sha256_bytes("新内容".as_bytes()));
        assert_eq!(len, "新内容".len() as u64);
        // 目录里不留临时文件
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".kn-tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn 边界检查拦住逃出根目录的路径() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lib");
        fs::create_dir_all(root.join("nodes")).unwrap();
        let paths = LibraryPaths::for_existing(&root).unwrap();
        assert!(paths.resolve_rel("nodes/a.md").is_ok());
        assert!(paths.resolve_rel("../outside.md").is_err());
        // 中间组件是符号链接指向外部时也要拦住
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path(), root.join("escape")).unwrap();
            assert!(paths.resolve_rel("escape/secret.md").is_err());
        }
    }

    #[test]
    fn 流式复制报告真实字节数() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.bin");
        fs::write(&src, vec![7u8; 300_000]).unwrap();
        let dst = dir.path().join("out/dst.bin");
        let (sha, len) = copy_stream(&src, &dst).unwrap();
        assert_eq!(len, 300_000);
        assert_eq!(sha, sha256_file(&src).unwrap().0);
    }

    #[test]
    fn 相对路径转换对verbatim与普通写法都成立() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("库");
        fs::create_dir_all(root.join("nodes")).unwrap();
        let paths = LibraryPaths::for_existing(&root).unwrap();
        fs::write(root.join("nodes").join("a.md"), "正文").unwrap();

        // 普通绝对路径（用户选择器/tempdir 给出的形式）
        let plain = root.join("nodes").join("a.md");
        assert_eq!(paths.relative_of(&plain).unwrap(), "nodes/a.md");
        // verbatim 形式（fs::canonicalize 给出的形式）
        let canonical = fs::canonicalize(&plain).unwrap();
        assert_eq!(paths.relative_of(&canonical).unwrap(), "nodes/a.md");
        // 混用分隔符也要能归一到 `/`
        assert_eq!(
            paths.relative_of(&root.join("nodes/a.md")).unwrap(),
            "nodes/a.md"
        );
        // 显示给用户的根目录不带 Windows verbatim 前缀
        #[cfg(windows)]
        assert!(
            !paths.root().to_string_lossy().starts_with(r"\\?\"),
            "根目录不应把 \\\\?\\ 前缀显示给用户：{}",
            paths.root().display()
        );
        // 知识库之外的路径仍然拒绝
        let outside = dir.path().join("outside.md");
        assert!(paths.relative_of(&outside).is_err());
    }

    #[test]
    fn 移动不覆盖已有目标() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let err = move_no_overwrite(&a, &b).unwrap_err();
        assert_eq!(err.code, crate::models::code::CONFLICT);
    }
}
