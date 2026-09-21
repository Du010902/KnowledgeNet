//! 主文档（`primaryDocument`）读写与冲突保护。
//!
//! 契约 `docs/v2-contract.md` §3.8。
//!
//! **文档修订号不进 `node.json`**。`node.json` 是节点的身份与元数据，正文属于用户文件，
//! 两者被外部编辑器改动的频率完全不同；把正文修订号塞进 `node.json` 会让「用记事本
//! 改一句笔记」变成「改节点元数据」，也会让每个节点多一次元数据写入。
//!
//! 这里改用节点自己的记账文件
//! `<节点>/.meta/knowledgenet/notes-index.json`（格式见 [`NOTES_INDEX_FORMAT`]）：
//! 每个文档一条「上次已知哈希 + 字节数 + 修订号 + 时间」。修订号是乐观并发用的计数器，
//! 哈希是判断「磁盘上这份内容是不是我上次见过的那份」的依据。索引丢失或损坏时
//! 修订号退回 0（未知），下次保存会要求用户重新载入，而不是拿一个可能过期的版本去覆盖。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models::{code, CmdError, CmdResult};
use crate::paths;

use super::atomic::{self, Fingerprint};
use super::ctx::LibCtx;
use super::nodes::{self, NodeMetaPatch};
use super::schema::{validate_primary_document, NodeMeta, Validate};
use super::vpaths;

/* --------------------------------- 常量 --------------------------------- */

/// 记账文件在 `.meta/knowledgenet/` 下的文件名。
pub const NOTES_INDEX_FILE: &str = "notes-index.json";
/// `notes-index.json` 的格式标记（自描述，便于人工识别与以后升级）。
pub const NOTES_INDEX_FORMAT: &str = "knowledgenet-notes-index";
pub const NOTES_INDEX_FORMAT_VERSION: i64 = 1;
/// `primaryDocument` 为空时，第一次保存落在哪个文件。
pub const DEFAULT_DOCUMENT: &str = "note.md";

/* --------------------------------- 模型 --------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesIndexEntry {
    pub relative_path: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub byte_length: i64,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub modified_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotesIndex {
    pub format: String,
    pub format_version: i64,
    pub node_id: String,
    #[serde(default)]
    pub entries: Vec<NotesIndexEntry>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl NotesIndex {
    pub fn empty(node_id: &str) -> Self {
        Self {
            format: NOTES_INDEX_FORMAT.to_string(),
            format_version: NOTES_INDEX_FORMAT_VERSION,
            node_id: node_id.to_string(),
            entries: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }

    pub fn entry(&self, relative_path: &str) -> Option<&NotesIndexEntry> {
        self.entries.iter().find(|e| e.relative_path == relative_path)
    }

    pub fn upsert(&mut self, entry: NotesIndexEntry) {
        match self
            .entries
            .iter_mut()
            .find(|e| e.relative_path == entry.relative_path)
        {
            Some(existing) => *existing = entry,
            None => self.entries.push(entry),
        }
        self.entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    }
}

/// 记账文件没有「必须拒绝」的字段：格式头由 `atomic::read_typed` 先校验，
/// 剩下的内容是修订号账本，读不出来时按「未知」处理而不是让笔记读写失败。
impl Validate for NotesIndex {
    fn validate_typed(&self) -> CmdResult<()> {
        Ok(())
    }
}

/// 一份文档在某个瞬间的完整快照。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    /// 节点目录内的相对路径；`primaryDocument` 为空且文件不存在时是空串
    pub relative_path: String,
    pub content: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub byte_length: i64,
    #[serde(default)]
    pub modified_ms: i64,
    /// 乐观并发用的文档修订号；0 表示「未知 / 还没有这份文档」
    #[serde(default)]
    pub revision: i64,
}

impl DocumentSnapshot {
    fn empty(relative_path: &str) -> Self {
        Self {
            relative_path: relative_path.to_string(),
            content: String::new(),
            sha256: String::new(),
            byte_length: 0,
            modified_ms: 0,
            revision: 0,
        }
    }

    pub fn is_empty_document(&self) -> bool {
        self.relative_path.is_empty()
    }
}

/// 写文档的结果。冲突是**正常返回值**而不是异常：界面必须能拿到磁盘版本，
/// 让用户选「重新载入 / 覆盖保存（自动留副本）」。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum WriteDocumentOutcome {
    Saved {
        document: DocumentSnapshot,
        /// 「覆盖保存」时磁盘旧版本被另存的位置（相对知识库根）
        #[serde(default)]
        conflict_copy: Option<String>,
    },
    Conflict {
        disk: DocumentSnapshot,
        expected_revision: i64,
        /// `revision_mismatch` | `external_edit` | `disk_missing`
        reason: String,
        detail: String,
    },
}

/* ------------------------------ 记账文件读写 ------------------------------ */

struct IndexState {
    index: NotesIndex,
    /// 记录可信（修订号可用）
    trusted: bool,
    /// 可以覆盖写（损坏的文件可以重建；更高版本的别人家的文件不动）
    replaceable: bool,
}

fn index_path(node_dir: &Path) -> PathBuf {
    vpaths::ns_dir(node_dir).join(NOTES_INDEX_FILE)
}

fn load_index(ctx: &LibCtx, node_dir: &Path, node_id: &str) -> IndexState {
    let path = index_path(node_dir);
    let empty = NotesIndex::empty(node_id);
    if !path.is_file() {
        return IndexState {
            index: empty,
            trusted: true,
            replaceable: true,
        };
    }
    let relative = nodes::rel_of(ctx, &path);
    match atomic::read_typed::<NotesIndex>(
        &path,
        NOTES_INDEX_FORMAT,
        NOTES_INDEX_FORMAT_VERSION,
        "notes-index.json",
        Some(&relative),
    ) {
        Ok((mut index, _fp)) => {
            index.node_id = node_id.to_string();
            IndexState {
                index,
                trusted: true,
                replaceable: true,
            }
        }
        Err(err) if err.code == code::METADATA_UNSUPPORTED => {
            // 更高版本的记账文件：不认识就不动它，修订号按「未知」处理
            eprintln!("{relative} 的版本不受支持，本次不改写它：{}", err.message);
            IndexState {
                index: empty,
                trusted: false,
                replaceable: false,
            }
        }
        Err(err) => {
            eprintln!("{relative} 无法解析，将按未知修订号处理：{}", err.message);
            IndexState {
                index: empty,
                trusted: false,
                replaceable: true,
            }
        }
    }
}

fn store_index(path: &Path, index: &NotesIndex) -> CmdResult<()> {
    let mut value = index.clone();
    value.entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    atomic::write_json(path, &value).map(|_| ())
}

/* --------------------------------- 读取 --------------------------------- */

/// 决定这次读写落在哪个文件：显式给路径就用它，否则用 `node.json` 的 `primaryDocument`。
fn resolve_document_rel(meta: &NodeMeta, document_rel: &str) -> CmdResult<Option<String>> {
    let explicit = document_rel.trim();
    if !explicit.is_empty() {
        return Ok(Some(validate_primary_document(explicit)?));
    }
    match &meta.primary_document {
        Some(raw) if !raw.trim().is_empty() => Ok(Some(validate_primary_document(raw)?)),
        _ => Ok(None),
    }
}

/// 修订号推导：索引记住了这份内容 → 用它记的修订号；
/// 磁盘内容和索引记的不一样（外部改过 / 从没见过）→ 索引修订号 + 1；
/// 索引不可信（没有 / 损坏 / 高版本）→ 0（未知，必须重新载入）。
fn derive_revision(state: &IndexState, relative_path: &str, disk_sha256: &str) -> i64 {
    if !state.trusted {
        return 0;
    }
    match state.index.entry(relative_path) {
        Some(entry) if entry.sha256.eq_ignore_ascii_case(disk_sha256) && !disk_sha256.is_empty() => {
            entry.revision.max(0)
        }
        Some(entry) => entry.revision.max(0) + 1,
        None => 1,
    }
}

fn snapshot_at(
    ctx: &LibCtx,
    node_dir: &Path,
    relative_path: &str,
    state: &IndexState,
) -> CmdResult<DocumentSnapshot> {
    let path = document_path(node_dir, relative_path)?;
    let Some(fp): Option<Fingerprint> = atomic::fingerprint_opt(&path)? else {
        return Ok(DocumentSnapshot::empty(relative_path));
    };
    let content = paths::read_text(&path)?;
    let _ = ctx;
    Ok(DocumentSnapshot {
        relative_path: relative_path.to_string(),
        content,
        sha256: fp.sha256.clone(),
        byte_length: fp.bytes as i64,
        modified_ms: fp.modified_ms,
        revision: derive_revision(state, relative_path, &fp.sha256),
    })
}

fn document_path(node_dir: &Path, relative_path: &str) -> CmdResult<PathBuf> {
    let cleaned = validate_primary_document(relative_path)?;
    Ok(node_dir.join(cleaned.replace('/', std::path::MAIN_SEPARATOR_STR)))
}

/// 读主文档。
///
/// - `document_rel` 为空时读 `node.json` 的 `primaryDocument`；
/// - `primaryDocument` 也是空时返回空内容 + 修订号 0（保存时会自动落到 `note.md`）；
/// - 登记了主文档但文件不在磁盘上时同样返回空内容 + 修订号 0（保存能重新创建它）。
pub fn read_document(
    ctx: &LibCtx,
    node_rel: &str,
    document_rel: &str,
) -> CmdResult<DocumentSnapshot> {
    let node_dir = ctx.node_dir(node_rel)?;
    let (meta, _fp) = nodes::read_node_meta(ctx, node_rel)?;
    let Some(target) = resolve_document_rel(&meta, document_rel)? else {
        return Ok(DocumentSnapshot::empty(""));
    };
    let state = load_index(ctx, &node_dir, &meta.id);
    snapshot_at(ctx, &node_dir, &target, &state)
}

/// 命令层 `check_node_note` 用：磁盘上的文档状态 + 「它与我们上次记的不一样」。
///
/// 第二个返回值是 `changed_on_disk`：索引记的哈希与磁盘不符（外部编辑器改过），
/// 或者文件消失了。界面据此在保存前提醒用户。
pub fn check_document(ctx: &LibCtx, node_rel: &str) -> CmdResult<(DocumentSnapshot, bool)> {
    let node_dir = ctx.node_dir(node_rel)?;
    let (meta, _fp) = nodes::read_node_meta(ctx, node_rel)?;
    let state = load_index(ctx, &node_dir, &meta.id);
    let Some(target) = resolve_document_rel(&meta, "")? else {
        return Ok((DocumentSnapshot::empty(""), false));
    };
    let snapshot = snapshot_at(ctx, &node_dir, &target, &state)?;
    let changed = match state.index.entry(&target) {
        Some(entry) => {
            snapshot.sha256.is_empty() || !entry.sha256.eq_ignore_ascii_case(&snapshot.sha256)
        }
        None => !snapshot.sha256.is_empty(),
    };
    Ok((snapshot, changed))
}

/* --------------------------------- 写入 --------------------------------- */

/// 把磁盘上的旧版本另存到 `.knowledgenet/conflicts/<nodeId>/<时间戳>-<文件名>`。
///
/// 放在知识库根下的 `.knowledgenet/` 里而不是节点目录里：冲突副本不是知识资产，
/// 不该混进用户的文件夹；但它也不该被自动删除，用户自己决定何时清理。
fn save_conflict_copy(ctx: &LibCtx, node_id: &str, source: &Path, target_rel: &str) -> CmdResult<String> {
    let dir = vpaths::root_meta_dir(ctx.root())
        .join(paths::CONFLICT_DIR)
        .join(node_id);
    atomic::ensure_dir(&dir)?;
    let stamp = paths::now_ms();
    let name = target_rel
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("document");
    let mut destination = dir.join(format!("{stamp}-{name}"));
    let mut suffix = 1;
    while destination.exists() {
        destination = dir.join(format!("{stamp}-{suffix}-{name}"));
        suffix += 1;
        if suffix > 1000 {
            return Err(CmdError::io(format!(
                "冲突副本目录 {} 里同名文件过多",
                dir.display()
            )));
        }
    }
    paths::copy_stream(source, &destination)?;
    ctx.relative_of(&destination)
}

/// 写主文档（带冲突保护）。
///
/// 三条分支：
///
/// - 修订号与磁盘一致 → 直接保存；
/// - 修订号过期且 `force = false` → 返回 [`WriteDocumentOutcome::Conflict`]，**不写盘**；
/// - 修订号过期且 `force = true` → 先把磁盘旧内容复制到 `.knowledgenet/conflicts/...`
///   再覆盖（覆盖掉的那一版永远找得回来）。
///
/// `primaryDocument` 为空（或与本次写入的文档不一致）时顺带把它登记进 `node.json`
/// （这一步会 bump 节点修订号）；登记发生在写正文**之前**，这样不会出现
/// 「正文写了、节点却还不知道自己有哪些文档」的半截状态。
pub fn write_document(
    ctx: &LibCtx,
    node_rel: &str,
    document_rel: &str,
    content: &str,
    expected_revision: i64,
    force: bool,
) -> CmdResult<WriteDocumentOutcome> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(node_rel)?;
    let (meta, meta_fp) = nodes::read_node_meta(ctx, node_rel)?;

    let target = resolve_document_rel(&meta, document_rel)?
        .unwrap_or_else(|| DEFAULT_DOCUMENT.to_string());
    let path = document_path(&node_dir, &target)?;

    let state = load_index(ctx, &node_dir, &meta.id);
    let disk_fp = atomic::fingerprint_opt(&path)?;
    let disk_revision = match &disk_fp {
        Some(fp) => derive_revision(&state, &target, &fp.sha256),
        None => 0,
    };

    // 修订号不符 = 磁盘上的东西不是调用方手上那一份
    let mismatch = expected_revision >= 0 && expected_revision != disk_revision;
    let reason = if !mismatch {
        String::new()
    } else if disk_fp.is_none() && expected_revision > 0 {
        "disk_missing".to_string()
    } else {
        match state.index.entry(&target) {
            Some(entry) => match &disk_fp {
                Some(fp) if entry.sha256.eq_ignore_ascii_case(&fp.sha256) => {
                    "revision_mismatch".to_string()
                }
                _ => "external_edit".to_string(),
            },
            None => "external_edit".to_string(),
        }
    };

    if !reason.is_empty() && !force {
        let disk = snapshot_at(ctx, &node_dir, &target, &state)?;
        let detail = format!(
            "{} 期望修订号 {}，磁盘上是 {}（{} 字节，sha256 {}…）",
            target,
            expected_revision,
            disk_revision,
            disk.byte_length,
            disk.sha256.chars().take(12).collect::<String>()
        );
        return Ok(WriteDocumentOutcome::Conflict {
            disk,
            expected_revision,
            reason,
            detail,
        });
    }

    // 「覆盖保存」：先把被覆盖的那一版留一份副本
    let mut conflict_copy = None;
    if !reason.is_empty() && force && path.is_file() {
        conflict_copy = Some(save_conflict_copy(ctx, &meta.id, &path, &target)?);
    }

    // 先登记主文档（失败时一个正文字节都没动）
    if meta.primary_document.as_deref() != Some(target.as_str()) {
        let patch = NodeMetaPatch {
            primary_document: Some(Some(target.clone())),
            ..Default::default()
        };
        nodes::update_node_meta(ctx, node_rel, &patch, meta.revision, Some(&meta_fp.sha256))?;
    }

    atomic::ensure_dir(path.parent().unwrap_or(&node_dir))?;
    let fp = atomic::write_text(&path, content)?;

    let issued_revision = disk_revision + 1;
    let mut fresh = load_index(ctx, &node_dir, &meta.id);
    if fresh.replaceable {
        fresh.index.node_id = meta.id.clone();
        fresh.index.upsert(NotesIndexEntry {
            relative_path: target.clone(),
            sha256: fp.sha256.clone(),
            byte_length: fp.bytes as i64,
            revision: issued_revision,
            modified_at: paths::iso_from_ms(fp.modified_ms),
            extra: serde_json::Map::new(),
        });
        store_index(&index_path(&node_dir), &fresh.index)?;
    }

    Ok(WriteDocumentOutcome::Saved {
        document: DocumentSnapshot {
            relative_path: target,
            content: content.to_string(),
            sha256: fp.sha256,
            byte_length: fp.bytes as i64,
            modified_ms: fp.modified_ms,
            revision: issued_revision,
        },
        conflict_copy,
    })
}
