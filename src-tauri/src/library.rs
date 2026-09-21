//! 知识库容器：身份清单（`library.json`）、跨平台写锁、新建 / 打开 / 复制。
//!
//! 容器层只回答三个问题：**这是哪一份知识库、现在谁在写它、能不能安全地碰它**。
//!
//! v2 与 v1 的关键差别：这里**不再有数据库**。知识资产是节点文件夹里的开放文件，
//! `library.json` 只是身份与人类可读入口；设备本地的派生索引在 `v2::index`，
//! 打开会话在 `v2::state`。因此容器层不再需要「跨 SQLite 与文件系统」的操作日志，
//! 只剩「原子写 JSON」与「复制目录」两件事——而它们都由 `v2::atomic` 与 `paths` 提供。

use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::models::{code, CmdError, CmdResult};
use crate::paths::{self, LibraryPaths};
use crate::v2::atomic::{self, Fingerprint};
use crate::v2::schema::{self, LibraryManifest, Validate};
use crate::v2::vpaths;

/* ---------------------------------- 锁 ---------------------------------- */

/// 锁文件里的诊断信息。
///
/// 它的作用不是互斥，而是让「被占用」这件事可解释：谁、在哪台机器、什么时候打开的。
/// 进程崩溃留下的陈旧内容会在**成功取得系统锁之后**被覆盖。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub library_id: String,
    pub session_id: String,
    pub hostname: String,
    pub pid: u32,
    pub app_version: String,
    pub opened_at: String,
}

/// 可写会话锁：真正的系统文件锁（`File::try_lock`），JSON 只是诊断信息。
///
/// 用 `try_lock` 而不是阻塞式 `lock`：抢占失败要立刻给出「只读打开 / 取消」的选择，
/// 而不是让界面无声地卡住。
#[derive(Debug)]
pub struct LibraryLock {
    file: File,
    path: PathBuf,
    holder_path: PathBuf,
}

impl LibraryLock {
    /// 取不到锁返回 `code = locked`。
    pub fn acquire(lock_path: &Path, info: &LockInfo) -> CmdResult<Self> {
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                CmdError::new(
                    code::LOCKED,
                    format!("无法创建锁目录 {}：{e}", parent.display()),
                )
            })?;
        }
        // 不用 truncate：截断会和「别人正持锁」的进程抢同一份诊断信息。
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(lock_path)
            .map_err(|e| {
                CmdError::new(
                    code::LOCKED,
                    format!(
                        "无法打开锁文件 {}：{e}。如果知识库放在只读介质或网络盘上，请改用只读方式打开。",
                        lock_path.display()
                    ),
                )
            })?;

        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                let holder = read_lock_info(lock_path)
                    .map(|held| {
                        format!(
                            "；当前持有者：{} 上的进程 {}（会话 {}，于 {} 打开）",
                            held.hostname, held.pid, held.session_id, held.opened_at
                        )
                    })
                    .unwrap_or_default();
                return Err(CmdError::new(
                    code::LOCKED,
                    format!(
                        "知识库被另一个实例占用{holder}。请先关闭那个窗口，或选择以只读方式打开。"
                    ),
                ));
            }
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(CmdError::new(
                    code::LOCKED,
                    format!("无法锁定 {}：{e}", lock_path.display()),
                ));
            }
        }

        let mut lock = Self {
            file,
            path: lock_path.to_path_buf(),
            holder_path: holder_path_of(lock_path),
        };
        lock.write_info(info)?;
        Ok(lock)
    }

    fn write_info(&mut self, info: &LockInfo) -> CmdResult<()> {
        let text = serde_json::to_string_pretty(info)?;
        let file = &mut self.file;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| CmdError::io(format!("写入锁信息失败（{}）：{e}", self.path.display())))?;
        file.set_len(0)
            .map_err(|e| CmdError::io(format!("写入锁信息失败（{}）：{e}", self.path.display())))?;
        file.write_all(text.as_bytes())
            .map_err(|e| CmdError::io(format!("写入锁信息失败（{}）：{e}", self.path.display())))?;
        file.flush()
            .map_err(|e| CmdError::io(format!("写入锁信息失败（{}）：{e}", self.path.display())))?;
        // 诊断副本：Windows 上被独占锁住的 `lock` 连读都读不了（ERROR_LOCK_VIOLATION），
        // 而「谁占着库」正是抢占失败的实例最需要告诉用户的信息。
        let _ = fs::write(&self.holder_path, text.as_bytes());
        Ok(())
    }
}

impl Drop for LibraryLock {
    fn drop(&mut self) {
        // 只解锁，**不删除锁文件**：删掉它会让第三个实例新建一个 inode 并加锁成功，
        // 而某个还没退出的实例可能仍持着旧 inode 的锁——两个进程都会以为自己是唯一写者。
        let _ = self.file.unlock();
    }
}

/// 诊断副本路径：`.knowledgenet/lock.holder`
fn holder_path_of(lock_path: &Path) -> PathBuf {
    let mut name = lock_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "lock".to_string());
    name.push_str(".holder");
    lock_path.with_file_name(name)
}

fn read_lock_info(path: &Path) -> Option<LockInfo> {
    if let Ok(text) = fs::read_to_string(path) {
        if let Ok(info) = serde_json::from_str::<LockInfo>(&text) {
            return Some(info);
        }
    }
    let text = fs::read_to_string(holder_path_of(path)).ok()?;
    serde_json::from_str::<LockInfo>(&text).ok()
}

pub fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

pub fn new_session_id() -> String {
    paths::new_id()
}

/// 互斥锁中毒（某条命令 panic）不该让整个会话永久不可用。继续用 `into_inner()`
/// 比把用户锁在「必须重启 App」里更合理。
pub fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 等待另一个进程释放写锁（只用于「复制」这类希望尽量一致的操作，最多等这么久）。
pub const LOCK_WAIT: Duration = Duration::from_millis(1500);

/* -------------------------------- 清单 -------------------------------- */

pub fn manifest_path(root: &Path) -> PathBuf {
    root.join(paths::MANIFEST_NAME)
}

/// 读取 `library.json` 的原文（还没解析）。找不到文件时给出可执行的解释。
pub fn read_manifest_text(root: &Path) -> CmdResult<String> {
    let path = manifest_path(root);
    if !path.is_file() {
        return Err(CmdError::not_found(format!(
            "{} 不是 KnowledgeNet 知识库：目录里找不到 {}。请选择包含 library.json 的知识库目录。",
            root.display(),
            paths::MANIFEST_NAME
        )));
    }
    paths::read_text(&path)
}

/// 解析 `library.json`（三阶段：format 头 → 字段 → 业务校验）。
pub fn parse_manifest(text: &str, root: &Path) -> CmdResult<LibraryManifest> {
    schema::parse_typed::<LibraryManifest>(
        text,
        schema::LIBRARY_FORMAT,
        schema::LIBRARY_FORMAT_VERSION,
        "library.json",
        Some(&root.join(paths::MANIFEST_NAME).display().to_string()),
    )
}

/// 只探测版本：v1 的 `library.json` 也要能读出来（迁移入口）。
pub fn peek_format_version(text: &str) -> CmdResult<i64> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| CmdError::invalid(format!("library.json 不是合法的 JSON：{e}")))?;
    let format = value
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if format != schema::LIBRARY_FORMAT {
        return Err(CmdError::new(
            code::METADATA_UNSUPPORTED,
            format!("这不是 KnowledgeNet 知识库：library.json 的 format 是「{format}」"),
        ));
    }
    Ok(value
        .get("formatVersion")
        .and_then(|v| v.as_i64())
        .unwrap_or(1))
}

pub fn read_manifest(root: &Path) -> CmdResult<(LibraryManifest, Fingerprint)> {
    let text = read_manifest_text(root)?;
    let manifest = parse_manifest(&text, root)?;
    let fp = atomic::fingerprint(&manifest_path(root))?;
    Ok((manifest, fp))
}

/// 原子写回清单，**保留未知字段**（`LibraryManifest` 自带 `extra`）。
pub fn write_manifest(root: &Path, manifest: &LibraryManifest) -> CmdResult<Fingerprint> {
    atomic::write_json(&manifest_path(root), manifest)
}

/// 新建知识库目录：`library.json` + `.knowledgenet/` 骨架。
///
/// 不做「临时目录再改名」那套：v2 的知识库在创建时是空的，
/// 唯一需要原子性的是 `library.json` 本身，而它本来就是原子写的。
pub fn create_library_dir(root: &Path, title: &str) -> CmdResult<LibraryManifest> {
    if root.exists() {
        let mut entries = fs::read_dir(root)
            .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", root.display())))?;
        if entries.next().is_some() {
            return Err(CmdError::new(
                code::CONFLICT,
                format!("目标目录不是空的，已拒绝覆盖：{}", root.display()),
            ));
        }
    }
    fs::create_dir_all(root)
        .map_err(|e| CmdError::io(format!("创建知识库目录 {} 失败：{e}", root.display())))?;

    let manifest = LibraryManifest::new(
        paths::new_id(),
        title.trim().to_string(),
        paths::iso_now(),
    );
    manifest
        .validate_typed()
        .map_err(|e| CmdError::invalid(format!("新建知识库的清单不合法：{}", e.message)))?;
    atomic::write_json(&manifest_path(root), &manifest)?;

    // 骨架目录：让用户第一次打开资源管理器时就看得出「这是一个知识库」
    atomic::ensure_dir(&vpaths::root_meta_dir(root))?;
    atomic::ensure_dir(&vpaths::root_trash_dir(root))?;
    atomic::ensure_dir(&vpaths::root_meta_dir(root).join(vpaths::RECOVERY_DIR))?;
    atomic::ensure_dir(&vpaths::root_meta_dir(root).join(vpaths::LEGACY_DIR))?;
    let default_parent = manifest.new_node_parent().to_string();
    if !default_parent.is_empty() {
        atomic::ensure_dir(&root.join(default_parent.replace('/', std::path::MAIN_SEPARATOR_STR)))?;
    }
    Ok(manifest)
}

/// 递归复制整个知识库目录。v2 的资产就是文件，所以「复制目录」就是完整备份。
///
/// 每一步写入都是原子的，因此复制过程中即使另一个实例正在写，
/// 单个 JSON 文件也只会是「旧版本」或「新版本」，不会是半截内容。
pub fn copy_library_tree(src: &Path, dst: &Path) -> CmdResult<(i64, u64)> {
    if dst.exists() {
        let mut entries = fs::read_dir(dst)
            .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", dst.display())))?;
        if entries.next().is_some() {
            return Err(CmdError::new(
                code::CONFLICT,
                format!("复制目标不是空目录，已拒绝覆盖：{}", dst.display()),
            ));
        }
    }
    paths::copy_dir_recursive(src, dst)
}

/// 为一个复制出来的知识库重新发号（`independent` 语义）。
///
/// 节点 ID **不**改：两份库从此独立积累，节点 ID 只需要在**本库内**唯一，
/// 强行改 ID 反而会打断用户自己维护的引用关系。
pub fn reidentify_library(root: &Path, new_title: Option<String>) -> CmdResult<LibraryManifest> {
    let (mut manifest, _) = read_manifest(root)?;
    manifest.library_id = paths::new_id();
    if let Some(title) = new_title {
        manifest.title = title;
    }
    manifest.created_at = paths::iso_now();
    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// 目录里是否存在 v1 的 `knowledge.sqlite`（迁移判据之一）。
pub fn has_legacy_database(root: &Path) -> bool {
    vpaths::database_file(root).is_file()
}

/// 只读打开时的边界检查：目录必须存在。
pub fn existing_root(root: &Path) -> CmdResult<LibraryPaths> {
    LibraryPaths::for_existing(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_library_writes_manifest_and_skeleton() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("我的知识库");
        let manifest = create_library_dir(&root, "我的知识库").unwrap();
        assert_eq!(manifest.format_version, 2);
        assert!(vpaths::root_meta_dir(&root).is_dir());
        assert!(vpaths::root_trash_dir(&root).is_dir());
        assert!(root.join(manifest.new_node_parent()).is_dir());

        let (back, fp) = read_manifest(&root).unwrap();
        assert_eq!(back, manifest);
        assert!(fp.bytes > 0);
    }

    #[test]
    fn create_library_refuses_non_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("已有内容");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("用户文件.txt"), "不要覆盖我").unwrap();
        let err = create_library_dir(&root, "已有内容").unwrap_err();
        assert_eq!(err.code, code::CONFLICT);
        assert!(root.join("用户文件.txt").is_file());
    }

    #[test]
    fn manifest_unknown_fields_survive_rewrite() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("库");
        create_library_dir(&root, "库").unwrap();
        let text = fs::read_to_string(manifest_path(&root)).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
        value["futureSection"] = serde_json::json!({"a": 1});
        atomic::write_text(&manifest_path(&root), &serde_json::to_string_pretty(&value).unwrap())
            .unwrap();

        let (manifest, _) = read_manifest(&root).unwrap();
        write_manifest(&root, &manifest).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(manifest_path(&root)).unwrap()).unwrap();
        assert!(after.get("futureSection").is_some(), "未知字段不能被抹掉");
    }

    #[test]
    fn peek_format_version_reads_v1_manifest() {
        let text = r#"{"format":"knowledgenet-library","formatVersion":1,"libraryId":"x","title":"t","createdAt":"2026-09-20T10:00:00.000Z"}"#;
        assert_eq!(peek_format_version(text).unwrap(), 1);
        let bad = r#"{"format":"something-else","formatVersion":1}"#;
        assert_eq!(
            peek_format_version(bad).unwrap_err().code,
            code::METADATA_UNSUPPORTED
        );
    }

    #[test]
    fn copy_library_tree_copies_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        create_library_dir(&src, "源库").unwrap();
        fs::create_dir_all(src.join("Nodes/A")).unwrap();
        fs::write(src.join("Nodes/A/note.md"), "正文").unwrap();

        let dst = tmp.path().join("dst");
        let (files, bytes) = copy_library_tree(&src, &dst).unwrap();
        assert!(files >= 2);
        assert!(bytes > 0);
        assert_eq!(fs::read_to_string(dst.join("Nodes/A/note.md")).unwrap(), "正文");
        assert!(manifest_path(&dst).is_file());
    }

    #[test]
    fn reidentify_changes_library_id_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("库");
        let before = create_library_dir(&root, "库").unwrap();
        let after = reidentify_library(&root, Some("另一份".to_string())).unwrap();
        assert_ne!(before.library_id, after.library_id);
        assert_eq!(after.title, "另一份");
    }

    #[test]
    fn lock_is_exclusive_within_process() {
        let tmp = tempfile::tempdir().unwrap();
        let lock_path = vpaths::root_lock_file(tmp.path());
        let info = LockInfo {
            library_id: "01990000-0000-7000-8000-000000000001".to_string(),
            session_id: new_session_id(),
            hostname: hostname(),
            pid: std::process::id(),
            app_version: "0.1.0".to_string(),
            opened_at: paths::iso_now(),
        };
        let first = LibraryLock::acquire(&lock_path, &info).unwrap();
        let second = LibraryLock::acquire(&lock_path, &info);
        assert!(second.is_err(), "同一进程内第二次取锁必须失败");
        assert_eq!(second.unwrap_err().code, code::LOCKED);
        drop(first);
        let third = LibraryLock::acquire(&lock_path, &info);
        assert!(third.is_ok(), "释放后应能重新取锁");
    }
}
