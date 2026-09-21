//! 节点元数据目录内的路径计算（纯函数，不碰文件系统）。
//!
//! 命名空间是 `.meta/knowledgenet`，而不是整个 `.meta`：
//! 别的软件可以在同一个 `.meta` 里放自己的东西，KnowledgeNet 不占用公共名字。
//! 节点身份的唯一判据是**精确路径** `.meta/knowledgenet/node.json` 存在且解析合法。

use std::path::{Path, PathBuf};

use crate::models::{CmdError, CmdResult};

pub const META_DIR: &str = ".meta";
pub const NS_DIR: &str = "knowledgenet";
pub const NODE_FILE: &str = "node.json";
pub const RELATIONS_FILE: &str = "relations.json";
pub const RESOURCES_FILE: &str = "resources.json";
pub const BOOKMARKS_FILE: &str = "bookmarks.json";
pub const CHATS_DIR: &str = "chats";
pub const THREAD_FILE: &str = "thread.json";
pub const MESSAGES_DIR: &str = "messages";

/// 节点标记文件的相对路径（相对**节点文件夹**），也是扫描器唯一认的路径。
pub const NODE_MARKER_RELATIVE: &str = ".meta/knowledgenet/node.json";

/// 知识库根目录下的固定位置
pub const ROOT_META_DIR: &str = ".knowledgenet";
pub const GOALS_FILE: &str = "goals.json";
pub const LOCK_FILE: &str = "lock";
pub const TRASH_DIR: &str = "trash";
pub const NODE_METADATA_TRASH_DIR: &str = "node-metadata";
pub const BACKUPS_DIR: &str = "backups";
pub const RECOVERY_DIR: &str = "recovery";
pub const LEGACY_DIR: &str = "legacy";
pub const LEGACY_DATABASE: &str = "knowledge-v1.sqlite";
pub const DATABASE_NAME: &str = "knowledge.sqlite";

/* --------------------------- 节点文件夹内的路径 --------------------------- */

pub fn ns_dir(node_dir: &Path) -> PathBuf {
    node_dir.join(META_DIR).join(NS_DIR)
}

pub fn node_meta_file(node_dir: &Path) -> PathBuf {
    ns_dir(node_dir).join(NODE_FILE)
}

pub fn relations_file(node_dir: &Path) -> PathBuf {
    ns_dir(node_dir).join(RELATIONS_FILE)
}

pub fn resources_file(node_dir: &Path) -> PathBuf {
    ns_dir(node_dir).join(RESOURCES_FILE)
}

pub fn bookmarks_file(node_dir: &Path) -> PathBuf {
    ns_dir(node_dir).join(BOOKMARKS_FILE)
}

pub fn chats_dir(node_dir: &Path) -> PathBuf {
    ns_dir(node_dir).join(CHATS_DIR)
}

pub fn thread_dir(node_dir: &Path, thread_id: &str) -> PathBuf {
    chats_dir(node_dir).join(thread_id)
}

pub fn thread_file(node_dir: &Path, thread_id: &str) -> PathBuf {
    thread_dir(node_dir, thread_id).join(THREAD_FILE)
}

pub fn messages_dir(node_dir: &Path, thread_id: &str) -> PathBuf {
    thread_dir(node_dir, thread_id).join(MESSAGES_DIR)
}

/* ------------------------------ 消息文件命名 ------------------------------ */

/// `<6 位零填充序号>_<messageId>.json`
///
/// 序号前缀让资源管理器里的顺序与对话顺序一致，也让「不读正文就能数出消息条数」
/// 这件事只靠文件名就能做到。
pub fn message_file_name(sequence: i64, message_id: &str) -> String {
    format!("{:06}_{message_id}.json", sequence.max(0))
}

pub fn parse_message_file_name(name: &str) -> Option<(i64, String)> {
    let stem = name.strip_suffix(".json")?;
    let (seq_part, id_part) = stem.split_once('_')?;
    if seq_part.is_empty() || seq_part.len() > 12 || !seq_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if id_part.is_empty() {
        return None;
    }
    let sequence: i64 = seq_part.parse().ok()?;
    Some((sequence, id_part.to_string()))
}

/* -------------------------------- 相对路径 -------------------------------- */

/// 元数据目录内的相对路径（相对节点文件夹），例如 `.meta/knowledgenet/chats/<id>/thread.json`
pub fn relative_in_node(parts: &[&str]) -> String {
    parts.join("/")
}

/// 相对路径是否落在 `.meta/` 命名空间内（判断「这是元数据还是用户资产」）
pub fn is_meta_relative(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    normalized == META_DIR || normalized.starts_with(&format!("{META_DIR}/"))
}

/// 把绝对路径转成相对知识库根的正斜杠相对路径。
///
/// 失败（不在根目录内）时返回 `None`；调用方据此报 `node_outside_library`。
pub fn relative_path_string(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for component in rel.components() {
        match component {
            std::path::Component::Normal(raw) => parts.push(raw.to_string_lossy().to_string()),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        // 根目录本身
        return Some(String::new());
    }
    Some(parts.join("/"))
}

/// 校验线程 ID 形状：它会直接参与路径拼接，必须先证明它是 UUID。
pub fn require_thread_id(thread_id: &str) -> CmdResult<()> {
    if crate::paths::is_uuid(thread_id) {
        Ok(())
    } else {
        Err(CmdError::invalid(format!(
            "threadId 不是合法的 UUID：{thread_id}"
        )))
    }
}

/// 校验消息 ID 形状
pub fn require_message_id(message_id: &str) -> CmdResult<()> {
    if crate::paths::is_uuid(message_id) {
        Ok(())
    } else {
        Err(CmdError::invalid(format!(
            "messageId 不是合法的 UUID：{message_id}"
        )))
    }
}

/// 知识库根下的固定位置
pub fn root_meta_dir(root: &Path) -> PathBuf {
    root.join(ROOT_META_DIR)
}

pub fn root_goals_file(root: &Path) -> PathBuf {
    root_meta_dir(root).join(GOALS_FILE)
}

pub fn root_lock_file(root: &Path) -> PathBuf {
    root_meta_dir(root).join(LOCK_FILE)
}

pub fn root_trash_dir(root: &Path) -> PathBuf {
    root_meta_dir(root).join(TRASH_DIR)
}

/// `.knowledgenet/trash/node-metadata/<nodeId>/<deletedAt>/`
pub fn removed_identity_dir(root: &Path, node_id: &str, deleted_at_ms: i64) -> PathBuf {
    root_trash_dir(root)
        .join(NODE_METADATA_TRASH_DIR)
        .join(node_id)
        .join(deleted_at_ms.to_string())
}

pub fn removed_identity_parent(root: &Path, node_id: &str) -> PathBuf {
    root_trash_dir(root).join(NODE_METADATA_TRASH_DIR).join(node_id)
}

/// `.knowledgenet/backups/`：删除节点文件夹之前，用户选择「备份」时整份复制到这里。
///
/// 放在 `.knowledgenet` 下有两个原因：扫描器本来就整棵跳过它（备份不会被当成节点），
/// 而且备份跟着知识库一起走——把知识库整个拷到别处，备份也还在。
pub fn root_backups_dir(root: &Path) -> PathBuf {
    root_meta_dir(root).join(BACKUPS_DIR)
}

pub fn recovery_dir(root: &Path, stamp: &str) -> PathBuf {
    root_meta_dir(root).join(RECOVERY_DIR).join(stamp)
}

pub fn legacy_dir(root: &Path) -> PathBuf {
    root_meta_dir(root).join(LEGACY_DIR)
}

pub fn legacy_database(root: &Path) -> PathBuf {
    legacy_dir(root).join(LEGACY_DATABASE)
}

pub fn database_file(root: &Path) -> PathBuf {
    root.join(DATABASE_NAME)
}

/// AppData 下的设备本地索引目录：`<app_data>/indexes/<libraryId>/index.sqlite`
pub fn index_dir(app_data: &Path, library_id: &str) -> PathBuf {
    app_data.join("indexes").join(library_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_file_names_round_trip() {
        let id = "0199ffff-0000-7000-8000-000000000101";
        let name = message_file_name(7, id);
        assert_eq!(name, format!("000007_{id}.json"));
        assert_eq!(parse_message_file_name(&name), Some((7, id.to_string())));
        assert_eq!(parse_message_file_name("000007.json"), None);
        assert_eq!(parse_message_file_name("abc_0199.json"), None);
    }

    #[test]
    fn meta_relative_detection() {
        assert!(is_meta_relative(".meta"));
        assert!(is_meta_relative(".meta/knowledgenet/node.json"));
        assert!(!is_meta_relative("note.md"));
        assert!(!is_meta_relative("meta/x.txt"));
    }

    #[test]
    fn relative_path_string_uses_forward_slashes() {
        let root = Path::new("/kb");
        let path = Path::new("/kb/Root/Child/note.md");
        assert_eq!(
            relative_path_string(root, path),
            Some("Root/Child/note.md".to_string())
        );
        assert_eq!(relative_path_string(root, root), Some(String::new()));
        assert_eq!(relative_path_string(root, Path::new("/elsewhere/x")), None);
    }
}
