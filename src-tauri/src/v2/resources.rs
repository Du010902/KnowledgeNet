//! 普通文件枚举与 `resources.json`（只保存**可选注释**）。
//!
//! 契约 `docs/v2-contract.md` §3.9，语义见设计文档 §4.6。
//!
//! 核心原则：**节点目录里的文件默认就是用户资产**，不需要先「导入」才算存在。
//! `resources.json` 只是增强信息（展示名、说明、排序、URL 资料），
//! 所以：
//!
//! - [`list_plain_files`] 列出节点目录里的普通文件，不管它们有没有被注释；
//! - 软件**不得**因为某个文件没出现在 `resources.json` 里就把它当垃圾文件；
//! - 子节点目录下的文件属于子节点，不能递归算作父节点的资料。

use std::path::{Path, PathBuf};

use crate::models::{code, CmdError, CmdResult};
use crate::paths;

use super::atomic::{self, Fingerprint};
use super::ctx::LibCtx;
use super::nodes;
use super::scanner::DirFilter;
use super::schema::{
    ResourceEntry, ResourcesFile, Validate, RESOURCES_FORMAT, RESOURCES_FORMAT_VERSION,
};
use super::vpaths;

/* --------------------------------- 模型 --------------------------------- */

/// 节点目录里的一个普通文件（或目录项）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeFileEntry {
    /// **相对知识库根**的正斜杠路径（例如 `Nodes/Attention/note.md`）。
    /// 与 `ResourceEntry.relativePath`（相对**节点目录**）不同，这一点在契约里没有写死，
    /// 这里按扫描夹具 `fixtures/v2/expected/scan.json` 的 `plainFiles` 取库内相对路径。
    pub relative_path: String,
    pub name: String,
    pub byte_length: i64,
    pub modified_ms: i64,
    /// 目前恒为 `false`：契约只要求列出普通文件（空目录不属于「尚未添加说明的文件」）
    pub is_dir: bool,
}

/* ------------------------------ 普通文件枚举 ------------------------------ */

/// 列出节点目录下的普通文件（递归）。
///
/// 排除：
///
/// - `.meta/**`（KnowledgeNet 以及别的软件的元数据）；
/// - **嵌套节点子树**：子目录里只要有 `.meta/knowledgenet/node.json`，
///   整棵子树都属于那个子节点（`fixtures/v2/expected/scan.json` 的
///   `nested.plainFiles` 锁定了这条规则）；
/// - 嵌套知识库（子目录里有别人的 `library.json`）：那些文件不属于本库；
/// - 符号链接 / junction（不跟随，避免逃出知识库或成环）。
///
/// 返回值按相对路径排序，稳定可比对。
pub fn list_plain_files(ctx: &LibCtx, node_rel: &str) -> CmdResult<Vec<NodeFileEntry>> {
    let node_dir = ctx.node_dir(node_rel)?;
    let mut out: Vec<NodeFileEntry> = Vec::new();
    // 排除规则复用扫描器的唯一实现（固定排除名 + `library.json.scan.exclude` 的
    // 名字与通配模式）：两处各写一份迟早会出现「扫描说不是、资源面板却列出来」。
    let filter = DirFilter::new(&ctx.manifest().scan.exclude);

    let walker = walkdir::WalkDir::new(&node_dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name == vpaths::META_DIR {
                return false;
            }
            if !entry.file_type().is_dir() {
                return true;
            }
            if filter.is_skipped_dir_name(&name) {
                return false;
            }
            // 嵌套节点 / 嵌套知识库：整棵子树都不属于本节点
            let path = entry.path();
            if is_node_boundary(path) || path.join(paths::MANIFEST_NAME).is_file() {
                return false;
            }
            match ctx.relative_of(path) {
                Ok(relative) => !filter.matches_pattern(&relative),
                // 算不出相对路径说明它已经不在库里了，别把它当成资产
                Err(_) => false,
            }
        });

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            // 单个条目读不了（权限、被占用）不该让整次列举失败
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if paths::is_link_like(entry.path()) {
            continue;
        }
        let relative_path = match ctx.relative_of(entry.path()) {
            Ok(rel) => rel,
            Err(_) => continue,
        };
        if vpaths::is_meta_relative(&relative_path) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        out.push(NodeFileEntry {
            relative_path,
            name: entry.file_name().to_string_lossy().to_string(),
            byte_length: meta.len() as i64,
            modified_ms: paths::modified_ms(&meta),
            is_dir: false,
        });
    }

    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(out)
}

/// 这个目录是不是「另一个节点」的根（精确路径 `.meta/knowledgenet/node.json`）。
fn is_node_boundary(dir: &Path) -> bool {
    dir.join(vpaths::NODE_MARKER_RELATIVE).is_file()
}

/* ------------------------------ resources.json ------------------------------ */

/// 读 `resources.json`；文件不存在返回空列表（资料注释是可选的）。
pub fn list_resources(ctx: &LibCtx, node_rel: &str) -> CmdResult<Vec<ResourceEntry>> {
    let node_dir = ctx.node_dir(node_rel)?;
    let path = vpaths::resources_file(&node_dir);
    let relative = nodes::rel_of(ctx, &path);
    let mut file = match atomic::read_typed::<ResourcesFile>(
        &path,
        RESOURCES_FORMAT,
        RESOURCES_FORMAT_VERSION,
        "resources.json",
        Some(&relative),
    ) {
        Ok((file, _fp)) => file,
        Err(err) if !path.exists() => {
            let _ = err;
            ResourcesFile::empty(nodes::node_id_of(ctx, node_rel)?)
        }
        Err(err) => return Err(err),
    };
    file.entries
        .sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
    Ok(file.entries)
}

struct Loaded {
    node_id: String,
    node_dir: PathBuf,
    path: PathBuf,
    relative: String,
    file: ResourcesFile,
    fingerprint: Option<Fingerprint>,
}

fn load(ctx: &LibCtx, node_rel: &str) -> CmdResult<Loaded> {
    let node_dir = ctx.node_dir(node_rel)?;
    let node_id = nodes::node_id_of(ctx, node_rel)?;
    let path = vpaths::resources_file(&node_dir);
    let relative = nodes::rel_of(ctx, &path);
    let fingerprint = atomic::fingerprint_opt(&path)?;
    let file = match &fingerprint {
        Some(_) => {
            let (file, _fp): (ResourcesFile, Fingerprint) = atomic::read_typed(
                &path,
                RESOURCES_FORMAT,
                RESOURCES_FORMAT_VERSION,
                "resources.json",
                Some(&relative),
            )?;
            file
        }
        None => {
            let mut file = ResourcesFile::empty(node_id.clone());
            file.revision = 0;
            file
        }
    };
    Ok(Loaded {
        node_id,
        node_dir,
        path,
        relative,
        file,
        fingerprint,
    })
}

impl Loaded {
    fn persist(&self, mut updated: ResourcesFile) -> CmdResult<Fingerprint> {
        let actual_revision = match &self.fingerprint {
            Some(fp) => atomic::revision_of(fp, &self.path)?,
            None => 0,
        };
        if let Some(fp) = &self.fingerprint {
            atomic::ensure_unchanged(
                &self.relative,
                actual_revision,
                self.file.revision,
                &fp.sha256,
                Some(&fp.sha256),
            )?;
        } else if self.path.exists() {
            let fp = atomic::fingerprint(&self.path)?;
            let revision = atomic::revision_of(&fp, &self.path)?;
            return Err(atomic::external_conflict(
                &self.relative,
                self.file.revision,
                revision,
                None,
                &fp.sha256,
            ));
        }
        updated.revision = actual_revision + 1;
        updated.node_id = self.node_id.clone();
        updated.validate_typed()?;
        atomic::write_json(&self.path, &updated)
    }
}

/// 节点目录内唯一的文件名：`报告.pdf`、`报告 (2).pdf`……
fn unique_file_name(dir: &Path, base: &str) -> String {
    if !dir.join(base).exists() {
        return base.to_string();
    }
    let (stem, extension) = match base.rfind('.') {
        Some(index) if index > 0 && index + 1 < base.len() => {
            (base[..index].to_string(), base[index..].to_string())
        }
        _ => (base.to_string(), String::new()),
    };
    for index in 2..=1000 {
        let candidate = format!("{stem} ({index}){extension}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-{}", paths::now_ms())
}

/// URL 只允许 http / https。
///
/// `javascript:` / `data:` / `file:` 这类写法一旦被存进资料并在「打开」时交给系统，
/// 就等于把本地文件或脚本执行权交给了知识库内容。
pub fn validate_url(raw: &str) -> CmdResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CmdError::invalid("链接不能为空"));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(CmdError::invalid(format!(
            "链接不能包含空白或控制字符：{trimmed}"
        )));
    }
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| {
            CmdError::invalid(format!(
                "只允许 http/https 链接，已拒绝：{trimmed}。\
                 javascript:、file:、data: 这类写法不会被系统浏览器安全打开"
            ))
        })?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.starts_with(':') || host.contains('@') {
        return Err(CmdError::invalid(format!("链接缺少有效主机名：{trimmed}")));
    }
    Ok(trimmed.to_string())
}

fn mime_of(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string()
}

fn require_entry<'a>(loaded: &'a Loaded, resource_id: &str) -> CmdResult<&'a ResourceEntry> {
    loaded
        .file
        .entries
        .iter()
        .find(|entry| entry.id == resource_id)
        .ok_or_else(|| {
            CmdError::not_found(format!(
                "{} 里没有 ID 为 {resource_id} 的资料",
                loaded.relative
            ))
        })
}

/* --------------------------------- 增加 --------------------------------- */

/// 把用户选中的文件**复制进**节点目录，并写一条 `resources.json` 注释。
///
/// 复制而不是引用：知识库必须能整体拷走，绝不能记住库外的绝对路径。
/// 文件名安全化，同名一律加序号，**绝不覆盖**用户已有的文件。
pub fn add_file_resource(
    ctx: &LibCtx,
    node_rel: &str,
    source_path: &Path,
    display_name: Option<&str>,
) -> CmdResult<ResourceEntry> {
    ctx.require_writable()?;
    if !source_path.is_file() {
        return Err(CmdError::not_found(format!(
            "源文件不存在或不是一个文件：{}",
            source_path.display()
        )));
    }
    if paths::is_link_like(source_path) {
        return Err(CmdError::invalid(format!(
            "源文件是符号链接或重解析点，已拒绝复制：{}",
            source_path.display()
        )));
    }

    let loaded = load(ctx, node_rel)?;
    let original_name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());
    let safe_name = paths::safe_file_name(&original_name);
    let file_name = unique_file_name(&loaded.node_dir, &safe_name);
    let destination = loaded.node_dir.join(&file_name);

    let (sha256, byte_length) = paths::copy_stream(source_path, &destination)?;
    let now = paths::iso_now();
    let relative_path = file_name.clone();
    let display = display_name
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or(&original_name)
        .to_string();

    let next_order = loaded
        .file
        .entries
        .iter()
        .map(|entry| entry.sort_order)
        .max()
        .unwrap_or(0)
        + 1;

    let entry = ResourceEntry {
        id: paths::new_id(),
        kind: "file".to_string(),
        relative_path: Some(relative_path),
        url: None,
        original_name,
        display_name: display,
        mime_type: mime_of(&destination),
        byte_length: byte_length as i64,
        sha256,
        description: String::new(),
        sort_order: next_order,
        created_at: now.clone(),
        updated_at: now,
        extra: serde_json::Map::new(),
    };

    let mut file = loaded.file.clone();
    file.entries.push(entry.clone());
    if let Err(err) = loaded.persist(file) {
        // 注释写不进去就别留下一个没人认领的副本
        let _ = std::fs::remove_file(&destination);
        return Err(err);
    }
    Ok(entry)
}

/// 加一条 URL 资料（只允许 http/https）。同一 URL 已经存在时复用它，不重复添加。
pub fn add_url_resource(
    ctx: &LibCtx,
    node_rel: &str,
    node_id: &str,
    url: &str,
    display_name: Option<&str>,
    description: Option<&str>,
) -> CmdResult<ResourceEntry> {
    ctx.require_writable()?;
    let url = validate_url(url)?;
    let loaded = load(ctx, node_rel)?;
    // 命令层必须把 nodeId 传对：它只是校验，真实的文件身份以磁盘上的 node.json 为准
    if !node_id.trim().is_empty() && node_id != loaded.node_id {
        return Err(CmdError::invalid(format!(
            "nodeId 与 {} 的 node.json 不一致：资料必须记在它所属的节点上",
            loaded.relative
        )));
    }

    if let Some(existing) = loaded
        .file
        .entries
        .iter()
        .find(|entry| entry.kind == "url" && entry.url.as_deref() == Some(url.as_str()))
    {
        return Ok(existing.clone());
    }

    let now = paths::iso_now();
    let next_order = loaded
        .file
        .entries
        .iter()
        .map(|entry| entry.sort_order)
        .max()
        .unwrap_or(0)
        + 1;
    let entry = ResourceEntry {
        id: paths::new_id(),
        kind: "url".to_string(),
        relative_path: None,
        url: Some(url.clone()),
        original_name: String::new(),
        display_name: display_name
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .unwrap_or(&url)
            .to_string(),
        mime_type: String::new(),
        byte_length: 0,
        sha256: String::new(),
        description: description.unwrap_or("").to_string(),
        sort_order: next_order,
        created_at: now.clone(),
        updated_at: now,
        extra: serde_json::Map::new(),
    };

    let mut file = loaded.file.clone();
    file.entries.push(entry.clone());
    loaded.persist(file)?;
    Ok(entry)
}

/// 把「尚未添加说明的文件」写成一条 `resources.json` 记录。**文件本身不动。**
///
/// `relative_path` 两种写法都接受：
///
/// - 相对节点目录（`ResourcesEntry.relativePath` 的规范形式，例如 `note.md`）；
/// - 相对知识库根（`list_plain_files` 给出的形式，例如 `Nodes/A/note.md`）。
pub fn annotate_file(
    ctx: &LibCtx,
    node_rel: &str,
    relative_path: &str,
) -> CmdResult<ResourceEntry> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err(CmdError::invalid("要添加说明的文件路径不能为空"));
    }

    let node_relative = normalize_node_relative(node_rel, &loaded.node_dir, trimmed)?;
    let path = loaded
        .node_dir
        .join(node_relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !path.is_file() {
        return Err(CmdError::not_found(format!(
            "{} 里没有这个文件：{}",
            loaded.relative, node_relative
        )));
    }
    // 子节点 / 元数据目录里的文件不属于本节点
    if vpaths::is_meta_relative(&node_relative) || inside_nested_node(ctx, node_rel, &path) {
        return Err(CmdError::invalid(format!(
            "{node_relative} 不属于本节点（它在元数据目录或子节点里）"
        )));
    }

    if let Some(existing) = loaded
        .file
        .entries
        .iter()
        .find(|entry| entry.kind == "file" && entry.relative_path.as_deref() == Some(node_relative.as_str()))
    {
        return Ok(existing.clone());
    }

    let fp = atomic::fingerprint(&path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| node_relative.clone());
    let now = paths::iso_now();
    let next_order = loaded
        .file
        .entries
        .iter()
        .map(|entry| entry.sort_order)
        .max()
        .unwrap_or(0)
        + 1;
    let entry = ResourceEntry {
        id: paths::new_id(),
        kind: "file".to_string(),
        relative_path: Some(node_relative),
        url: None,
        original_name: name.clone(),
        display_name: name,
        mime_type: mime_of(&path),
        byte_length: fp.bytes as i64,
        sha256: fp.sha256,
        description: String::new(),
        sort_order: next_order,
        created_at: now.clone(),
        updated_at: now,
        extra: serde_json::Map::new(),
    };

    let mut file = loaded.file.clone();
    file.entries.push(entry.clone());
    loaded.persist(file)?;
    Ok(entry)
}

/// 把调用方给的路径统一成「相对节点目录」的形式。
fn normalize_node_relative(node_rel: &str, node_dir: &Path, raw: &str) -> CmdResult<String> {
    let cleaned = crate::paths::validate_relative_path(raw)?;
    if node_dir
        .join(cleaned.replace('/', std::path::MAIN_SEPARATOR_STR))
        .is_file()
    {
        return Ok(cleaned);
    }
    // 库内相对路径（list_plain_files 的返回形式）
    let node_prefix = node_rel.trim().trim_matches('/');
    let stripped = if node_prefix.is_empty() {
        Some(cleaned.as_str())
    } else {
        cleaned
            .strip_prefix(node_prefix)
            .and_then(|rest| rest.strip_prefix('/'))
    };
    if let Some(rest) = stripped {
        if !rest.is_empty()
            && node_dir
                .join(rest.replace('/', std::path::MAIN_SEPARATOR_STR))
                .is_file()
        {
            return Ok(rest.to_string());
        }
    }
    Err(CmdError::not_found(format!(
        "节点目录里找不到这个文件：{raw}"
    )))
}

/// 文件是否落在某个**子节点**的子树里（子节点目录下的文件属于子节点）。
fn inside_nested_node(ctx: &LibCtx, node_rel: &str, path: &Path) -> bool {
    let root = ctx.root();
    let mut current = path.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if !dir.starts_with(root) {
            return false;
        }
        let relative = match ctx.relative_of(&dir) {
            Ok(rel) => rel,
            Err(_) => return false,
        };
        if relative != node_rel.trim().trim_matches('/') && is_node_boundary(&dir) {
            return true;
        }
        current = dir.parent().map(|p| p.to_path_buf());
    }
    false
}

/* --------------------------------- 修改 --------------------------------- */

/// 改资料的展示名 / 说明 / 排序（`None` 表示不动这个字段）。
pub fn update_resource(
    ctx: &LibCtx,
    node_rel: &str,
    resource_id: &str,
    display_name: Option<&str>,
    description: Option<&str>,
    sort_order: Option<i64>,
) -> CmdResult<ResourceEntry> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    require_entry(&loaded, resource_id)?;
    let mut file = loaded.file.clone();
    let entry = file
        .entries
        .iter_mut()
        .find(|entry| entry.id == resource_id)
        .ok_or_else(|| CmdError::not_found(format!("没有 ID 为 {resource_id} 的资料")))?;
    if let Some(name) = display_name {
        entry.display_name = name.trim().to_string();
    }
    if let Some(text) = description {
        entry.description = text.to_string();
    }
    if let Some(order) = sort_order {
        entry.sort_order = order;
    }
    entry.updated_at = paths::iso_now();
    let updated = entry.clone();
    loaded.persist(file)?;
    Ok(updated)
}

/// 删除一条资料注释。
///
/// `delete_file = false`（默认）只删注释，**文件留在原处**——它仍然是用户的普通文件；
/// `delete_file = true` 时把注释指向的文件移到
/// `.knowledgenet/trash/resources/<resourceId>/<time>/`（不是直接抹掉，可找回）。
pub fn remove_resource(
    ctx: &LibCtx,
    node_rel: &str,
    resource_id: &str,
    delete_file: bool,
) -> CmdResult<()> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    let entry = require_entry(&loaded, resource_id)?.clone();

    let mut file = loaded.file.clone();
    file.entries.retain(|item| item.id != resource_id);
    loaded.persist(file)?;

    if !delete_file || entry.kind != "file" {
        return Ok(());
    }
    let Some(relative) = entry.relative_path.as_deref() else {
        return Ok(());
    };
    let path = loaded
        .node_dir
        .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !path.is_file() {
        // 文件早就不在了：注释已经删掉，没有别的事要做
        return Ok(());
    }

    let trash_dir = vpaths::root_trash_dir(ctx.root())
        .join(nodes::TRASH_RESOURCES_DIR)
        .join(resource_id)
        .join(paths::now_ms().to_string());
    atomic::ensure_dir(&trash_dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| relative.to_string());
    let destination = trash_dir.join(&name);
    match std::fs::rename(&path, &destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => match paths::copy_stream(&path, &destination) {
            Ok(_) => std::fs::remove_file(&path).map_err(|e| {
                CmdError::io(format!(
                    "文件已复制到回收站 {}，但删除原文件 {} 失败：{e}",
                    destination.display(),
                    path.display()
                ))
            }),
            Err(copy_error) => Err(CmdError::io(format!(
                "资料注释已删除，但把文件移到回收站失败：{rename_error} / {}",
                copy_error.message
            ))),
        },
    }
}

/* --------------------------------- 解析 --------------------------------- */

/// 资料文件的绝对路径（打开 / 在文件管理器中显示时用）。
///
/// 只接受 `kind = file` 的资料；路径必须在节点目录内且不逃出知识库
/// （符号链接逃逸由 canonicalize 检查挡住）。
pub fn resolve_resource_path(
    ctx: &LibCtx,
    node_rel: &str,
    resource_id: &str,
) -> CmdResult<PathBuf> {
    let node_dir = ctx.node_dir(node_rel)?;
    let entries = list_resources(ctx, node_rel)?;
    let entry = entries
        .iter()
        .find(|entry| entry.id == resource_id)
        .ok_or_else(|| CmdError::not_found(format!("没有 ID 为 {resource_id} 的资料")))?;
    if entry.kind != "file" {
        return Err(CmdError::invalid(format!(
            "「{}」是 {} 资料，没有磁盘路径",
            entry.display_name, entry.kind
        )));
    }
    let relative = entry.relative_path.as_deref().ok_or_else(|| {
        CmdError::invalid(format!("资料「{}」没有登记磁盘路径", entry.display_name))
    })?;
    let cleaned = crate::paths::validate_relative_path(relative)?;
    let path = node_dir.join(cleaned.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !path.is_file() {
        return Err(CmdError::not_found(format!(
            "资料文件不在磁盘上：{}（它可能被移动或删除了）",
            path.display()
        )));
    }
    if let Ok(canonical) = std::fs::canonicalize(&path) {
        if !canonical.starts_with(ctx.paths().canonical_root()) {
            return Err(CmdError::new(
                code::NODE_OUTSIDE_LIBRARY,
                format!("资料文件指向知识库外，已拒绝：{}", path.display()),
            ));
        }
    }
    Ok(path)
}
