//! 领域模型：与前端 `src/data/types.ts` 一一对应
//!
//! 统一使用 camelCase 序列化，前端不需要做字段名转换。
//!
//! 便携知识库的关键约定（见 `design/便携式知识库数据存储与实现方案.md`）：
//! - 所有实体 ID 都是 UUIDv7 字符串，**只是身份，不是路径**；
//! - 节点标题可以与节点目录名完全不同，目录名永远是节点 ID；
//! - 知识库内部一律使用相对路径（正斜杠分隔），绝不写入绝对路径；
//! - 笔记正文的权威版本是 `nodes/<id>/note.md`，数据库只登记哈希与修订号。
//!
//! 约定：边 from → to 表示「为了理解 from，需要先理解 to」。

use serde::{Deserialize, Serialize};

/// `library.json` 的 `format` 必须精确匹配，不能因为某个文件夹恰好有 SQLite 就打开它
pub const LIBRARY_FORMAT: &str = "knowledgenet-library";
/// 目录容器格式版本（与 SQLite 的 `PRAGMA user_version` 是两件事）
pub const LIBRARY_FORMAT_VERSION: i64 = 1;
/// 当前实现支持的 SQLite schema 版本
pub const SCHEMA_VERSION: i64 = 1;

/* ---------------------------------- 错误 ---------------------------------- */

/// 命令层错误：前端需要按 `code` 分支处理（尤其是修订冲突与笔记冲突），
/// 因此不能只回传一句字符串。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

/// 错误码常量：前端 `src/data/errors.ts` 与本表保持一致
pub mod code {
    pub const NOT_OPEN: &str = "not_open";
    pub const READ_ONLY: &str = "read_only";
    pub const REVISION_CONFLICT: &str = "revision_conflict";
    pub const NOTE_CONFLICT: &str = "note_conflict";
    pub const NOT_FOUND: &str = "not_found";
    pub const INVALID_INPUT: &str = "invalid_input";
    pub const CYCLE: &str = "cycle";
    pub const IO: &str = "io";
    pub const LOCKED: &str = "locked";
    pub const UNSUPPORTED_VERSION: &str = "unsupported_version";
    pub const ALREADY_OPEN: &str = "already_open";
    pub const CONFLICT: &str = "conflict";
    pub const INTERNAL: &str = "internal";

    /* ---------------------------- v2 新增（见 docs/v2-contract.md §2） ---------------------------- */

    /// `node.json` 等元数据 JSON 解析失败或必填字段类型不对
    pub const METADATA_INVALID: &str = "metadata_invalid";
    /// `format` / `formatVersion` 不是本实现支持的版本
    pub const METADATA_UNSUPPORTED: &str = "metadata_unsupported";
    /// 同一知识库内出现相同 node id：两个副本都停写，等用户决定
    pub const DUPLICATE_NODE_ID: &str = "duplicate_node_id";
    /// 磁盘文件已被外部修改（修订号或哈希不符）：默认绝不覆盖
    pub const EXTERNAL_CHANGE_CONFLICT: &str = "external_change_conflict";
    /// 索引里的节点目录已不存在，且受限重定位也找不到
    pub const NODE_MISSING: &str = "node_missing";
    /// 解析出的规范化路径逃出了知识库根目录
    pub const NODE_OUTSIDE_LIBRARY: &str = "node_outside_library";
    /// 触碰了嵌套的另一个知识库边界
    pub const NESTED_LIBRARY_BOUNDARY: &str = "nested_library_boundary";
    /// 扫描提前中止，报告不完整
    pub const SCAN_INCOMPLETE: &str = "scan_incomplete";
}

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }

    /// 普通错误：没有专门的 code，前端按 `message` 展示即可
    pub fn msg(message: impl Into<String>) -> Self {
        Self::new(code::INTERNAL, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(code::IO, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(code::INVALID_INPUT, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(code::NOT_FOUND, message)
    }

    /// 内部错误：调用方明确知道这是「不该发生」的情况，而不是用户输入问题
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(code::INTERNAL, message)
    }

    pub fn read_only() -> Self {
        Self::new(code::READ_ONLY, "当前知识库以只读方式打开，无法写入")
    }

    pub fn not_open() -> Self {
        Self::new(code::NOT_OPEN, "尚未打开知识库")
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CmdError {}

impl From<String> for CmdError {
    fn from(value: String) -> Self {
        CmdError::msg(value)
    }
}

impl From<&str> for CmdError {
    fn from(value: &str) -> Self {
        CmdError::msg(value)
    }
}

impl From<std::io::Error> for CmdError {
    fn from(value: std::io::Error) -> Self {
        CmdError::new(code::IO, format!("文件操作失败：{value}"))
    }
}

impl From<rusqlite::Error> for CmdError {
    fn from(value: rusqlite::Error) -> Self {
        CmdError::new(code::INTERNAL, format!("数据库操作失败：{value}"))
    }
}

impl From<serde_json::Error> for CmdError {
    fn from(value: serde_json::Error) -> Self {
        CmdError::new(code::INTERNAL, format!("JSON 处理失败：{value}"))
    }
}

pub type CmdResult<T> = Result<T, CmdError>;

/* -------------------------------- 知识库清单 -------------------------------- */

/// `library.json`：轻量、可人工识别的知识库清单。
///
/// 未知字段用 `flatten` 原样保留：以后加字段时，旧版本改写清单不能把它们抹掉。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryManifest {
    pub format: String,
    pub format_version: i64,
    pub library_id: String,
    pub title: String,
    /// ISO-8601 字符串，便于人工阅读
    pub created_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// 打开中的知识库摘要，界面用它显示「我在看哪个库」
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub library_id: String,
    pub title: String,
    pub root_path: String,
    pub read_only: bool,
    /// 知识库修订号：每次成功写入递增，前端提交时携带期望值
    pub revision: i64,
    pub format_version: i64,
    pub schema_version: i64,
    pub node_count: i64,
    pub edge_count: i64,
    pub goal_count: i64,
    pub resource_count: i64,
    pub trashed_node_count: i64,
    pub created_at: String,
    /// 打开时发现的未完成文件操作数量（>0 表示做过崩溃恢复）
    pub recovered_operations: i64,
    /// 打开知识库时的快速检查问题数
    pub quick_check_issues: i64,
}

/* ---------------------------------- 图谱 ---------------------------------- */

/// 学习状态：未开始 / 学习中 / 已理解
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LearnStatus {
    Todo,
    Learning,
    Done,
}

impl Default for LearnStatus {
    fn default() -> Self {
        LearnStatus::Todo
    }
}

impl LearnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LearnStatus::Todo => "todo",
            LearnStatus::Learning => "learning",
            LearnStatus::Done => "done",
        }
    }

    /// 数据库里的脏值统一回落到「未开始」，不让一条坏记录导致整库读不出来
    pub fn from_db(value: &str) -> Self {
        match value {
            "learning" => LearnStatus::Learning,
            "done" => LearnStatus::Done,
            _ => LearnStatus::Todo,
        }
    }
}

/// 节点目录状态机：跨 SQLite 与文件系统的操作靠它表达「走到哪一步了」
pub mod storage_state {
    pub const PENDING_CREATE: &str = "pending_create";
    pub const READY: &str = "ready";
    pub const PENDING_TRASH: &str = "pending_trash";
    pub const TRASHED: &str = "trashed";
    pub const MISSING: &str = "missing";
    pub const PENDING_PURGE: &str = "pending_purge";
}

/// 知识节点：**只有元数据**。
///
/// 正文在 `nodes/<id>/note.md`，通过 `read_node_note` / `write_node_note` 按需读写。
/// 把正文塞进图快照会让一万个节点的库每次加载都读进全部 Markdown。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub status: LearnStatus,
    /// 节点资料目录的状态；界面据此显示「目录缺失」而不是假装一切正常
    #[serde(default = "default_storage_state")]
    pub storage_state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_storage_state() -> String {
    storage_state::READY.to_string()
}

/// 依赖关系。from 依赖 to（to 是 from 的前置知识）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdge {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    /// 「为什么 from 需要 to」——回来后用于恢复上下文，而不是只看到一个箭头
    #[serde(default)]
    pub relation: String,
    /// 关系类型；第一版只有 prerequisite，留字段是为了以后扩展而不改 schema
    #[serde(default = "default_relation_type")]
    pub relation_type: String,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_relation_type() -> String {
    "prerequisite".to_string()
}

/// 学习目标：一个入口节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub title: String,
    pub root_node_id: String,
    pub created_at: i64,
}

/// 上次的学习位置（只记「最后在看哪个节点」）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnSession {
    pub id: String,
    pub goal_id: String,
    pub current_node_id: Option<String>,
    pub updated_at: i64,
}

/// 轻量图快照：不含任何笔记正文与附件内容
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub revision: i64,
    #[serde(default)]
    pub nodes: Vec<KnowledgeNode>,
    #[serde(default)]
    pub edges: Vec<DependencyEdge>,
    #[serde(default)]
    pub goals: Vec<Goal>,
    #[serde(default)]
    pub session: Option<LearnSession>,
}

/* ------------------------------- 版本化变更集 ------------------------------- */

/// 单实体操作走细粒度命令；批量图操作走变更集。
///
/// `expected_revision` 不匹配时整批拒绝：旧快照不能覆盖新数据。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphChangeSet {
    pub expected_revision: i64,
    #[serde(default)]
    pub upsert_nodes: Vec<NodeUpsert>,
    #[serde(default)]
    pub delete_node_ids: Vec<String>,
    #[serde(default)]
    pub upsert_edges: Vec<EdgeUpsert>,
    #[serde(default)]
    pub delete_edge_ids: Vec<String>,
    #[serde(default)]
    pub upsert_goals: Vec<Goal>,
    #[serde(default)]
    pub delete_goal_ids: Vec<String>,
    #[serde(default)]
    pub session: Option<LearnSession>,
    /// 为 true 时 `session` 会被写入（含 None 表示清空），否则保持原值
    #[serde(default)]
    pub replace_session: bool,
    /// 合并节点时对话域的转移计划，必须与图谱写入在同一事务里完成
    #[serde(default)]
    pub merge_transfer: Option<MergeTransfer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUpsert {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub status: LearnStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeUpsert {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    #[serde(default)]
    pub relation: String,
    #[serde(default = "default_relation_type")]
    pub relation_type: String,
}

/// 写操作的统一回执：前端据此更新修订号
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub revision: i64,
}

/// 可预期失败的结果类型。
///
/// 「会形成循环依赖」不是异常，而是用户需要看到并据此判断的业务结果，
/// 所以用数据返回，而不是抛错让界面只显示一句「操作失败」。
///
/// 线上格式：`{ "ok": true, "value": … }` 或
/// `{ "ok": false, "reason": "cycle", "cycle": [节点 id…] }`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult<T> {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<T>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cycle: Option<Vec<String>>,
}

impl<T> AddResult<T> {
    pub fn ok(value: T) -> Self {
        Self {
            ok: true,
            value: Some(value),
            reason: None,
            cycle: None,
        }
    }

    pub fn cycle(cycle: Vec<String>) -> Self {
        Self {
            ok: false,
            value: None,
            reason: Some("cycle".to_string()),
            cycle: Some(cycle),
        }
    }

    /// 把 `code::CYCLE` 错误转成 `ok:false`；其它错误原样抛出
    pub fn from_cycle_error(err: CmdError) -> CmdResult<Self> {
        if err.code == code::CYCLE {
            let cycle = err
                .detail
                .as_ref()
                .and_then(|d| d.get("cycle"))
                .and_then(|c| c.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(AddResult::cycle(cycle))
        } else {
            Err(err)
        }
    }
}

/* --------------------------------- 笔记 ---------------------------------- */

/// `note.md` 的当前状态（权威版本在磁盘上）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeNote {
    pub node_id: String,
    pub content: String,
    pub document_revision: i64,
    pub sha256: String,
    pub byte_length: i64,
    pub modified_at: i64,
}

/// 保存冲突：磁盘上的版本与前端手上的版本不是同一个
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteConflict {
    /// 磁盘当前版本（前端可展示「对方改了什么」）
    pub disk: NodeNote,
    pub expected_revision: i64,
    /// `revision_mismatch` | `hash_mismatch` | `disk_missing`
    pub reason: String,
    pub detail: String,
}

/// 保存结果。冲突是**正常返回**而不是异常：
/// 界面必须能拿到磁盘版本并让用户选择「重新加载 / 覆盖保存 / 另存冲突副本」。
///
/// `rename_all_fields` 不能省：`rename_all` 只改变体名，不变体里的字段名，
/// 少了它前端拿到的会是 `conflict_copy` 而不是 `conflictCopy`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum WriteNoteOutcome {
    /// 已保存
    Saved {
        note: NodeNote,
        revision: i64,
        /// 「覆盖保存」时磁盘旧版本被另存的位置（相对知识库根）；
        /// 界面要把它显示出来，否则用户不知道被自己覆盖掉的那一版去哪了
        #[serde(default)]
        conflict_copy: Option<String>,
    },
    /// 没有覆盖任何东西，等待用户决定
    Conflict {
        conflict: NoteConflict,
        /// 用户要求「另存冲突副本」时写入的相对路径
        #[serde(default)]
        conflict_copy: Option<String>,
    },
}

/// 笔记在磁盘上的变化检查（外部编辑器改过 note.md）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDiskState {
    pub node_id: String,
    pub exists: bool,
    pub sha256: String,
    pub byte_length: i64,
    pub modified_at: i64,
    pub document_revision: i64,
    /// 与数据库登记不一致时为 true：外部改动或文件被替换
    pub changed_on_disk: bool,
}

/* --------------------------------- 资料 ---------------------------------- */

pub mod resource_type {
    pub const FILE: &str = "file";
    pub const URL: &str = "url";
    pub const CITATION: &str = "citation";
}

pub mod resource_state {
    pub const PENDING: &str = "pending";
    pub const READY: &str = "ready";
    pub const TRASHED: &str = "trashed";
    pub const MISSING: &str = "missing";
}

/// 节点资料：文件（复制进知识库）或 URL
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeResource {
    pub id: String,
    pub node_id: String,
    pub resource_type: String,
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub original_name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub byte_length: i64,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub sort_order: i64,
    pub state: String,
    /// 计算字段：登记的文件在磁盘上不存在（外部移动/删除）
    #[serde(default)]
    pub missing: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePatch {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

/// 未登记文件扫描结果（用户直接在资源管理器里放进节点目录的文件）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnregisteredFile {
    /// 相对知识库根目录的路径
    pub relative_path: String,
    pub byte_length: i64,
    pub modified_at: i64,
}

/* ------------------------------ 合并与回收站 ------------------------------ */

/// 被丢弃的关系，以及它改挂到的那条边（自环没有替代边）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedEdgeRef {
    pub dropped_edge_id: String,
    #[serde(default)]
    pub replacement_edge_id: Option<String>,
}

/// 合并节点时对话域的转移计划
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTransfer {
    pub source_node_id: String,
    pub target_node_id: String,
    #[serde(default)]
    pub dropped_edges: Vec<DroppedEdgeRef>,
}

/// 合并结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub target: KnowledgeNode,
    pub removed_node_id: String,
    pub moved_edges: Vec<DependencyEdge>,
    pub dropped_edges: Vec<DroppedEdgeRef>,
    pub goals_repointed: Vec<Goal>,
    pub moved_resources: i64,
    pub moved_threads: i64,
    pub revision: i64,
}

/// 批量新增前置知识的结果：界面要能说清「新建了几个、复用了几个」
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPrerequisitesResult {
    pub parent_id: String,
    pub created: Vec<KnowledgeNode>,
    pub reused: Vec<KnowledgeNode>,
    pub edges: Vec<DependencyEdge>,
    pub revision: i64,
}

/// 回收站中的一条记录（节点或资料）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// `node` | `resource`
    pub kind: String,
    pub id: String,
    /// 节点标题 / 资料展示名
    pub title: String,
    /// 资料所属节点
    #[serde(default)]
    pub node_id: Option<String>,
    pub deleted_at: i64,
    /// 相对知识库根的回收站路径
    pub trashed_relpath: String,
    pub resource_count: i64,
    pub note_present: bool,
    /// 回收站里的实际文件是否还在（被手工删掉时为 false）
    pub files_present: bool,
}

/// 永久清理前的统计，界面必须先列出来再让用户确认
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgePreview {
    pub node_ids: Vec<String>,
    pub node_count: i64,
    pub edge_count: i64,
    pub resource_count: i64,
    pub thread_count: i64,
    pub message_count: i64,
    pub bookmark_count: i64,
    pub discovery_count: i64,
    pub goal_reference_count: i64,
    pub byte_length: i64,
    pub warnings: Vec<String>,
}

/* ------------------------------- 文件操作日志 ------------------------------- */

/// 通用阶段：崩溃恢复靠它 + 实际文件存在性判断，而不是只相信字符串
pub mod op_phase {
    pub const PREPARED: &str = "prepared";
    pub const DB_PENDING_COMMITTED: &str = "db_pending_committed";
    pub const FILES_APPLIED: &str = "files_applied";
    pub const DB_FINALIZED: &str = "db_finalized";
    pub const CLEANED: &str = "cleaned";
    pub const FAILED: &str = "failed";
}

pub mod op_type {
    pub const CREATE_NODE: &str = "create_node";
    pub const WRITE_NOTE: &str = "write_note";
    pub const IMPORT_RESOURCE: &str = "import_resource";
    pub const TRASH_NODE: &str = "trash_node";
    pub const RESTORE_NODE: &str = "restore_node";
    pub const PURGE_NODE: &str = "purge_node";
    pub const MERGE_NODE: &str = "merge_node";
    pub const TRASH_RESOURCE: &str = "trash_resource";
    pub const RESTORE_RESOURCE: &str = "restore_resource";
    pub const PURGE_RESOURCE: &str = "purge_resource";
}

/// 文件操作日志：不是审计日志，而是崩溃恢复机制。
/// 只有操作达到最终状态并清理暂存文件后才能删除记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperation {
    pub id: String,
    pub operation_type: String,
    pub entity_type: String,
    pub entity_id: String,
    #[serde(default)]
    pub source_relpath: Option<String>,
    #[serde(default)]
    pub target_relpath: Option<String>,
    #[serde(default)]
    pub expected_sha256: Option<String>,
    pub phase: String,
    #[serde(default)]
    pub payload_json: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub last_error: Option<String>,
}

/// 打开知识库时做过的恢复动作
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOutcome {
    pub operation_id: String,
    pub operation_type: String,
    pub entity_id: String,
    /// `continued` | `finalized` | `rolled_back` | `needs_repair` | `failed`
    pub action: String,
    pub detail: String,
}

/* ------------------------------- 完整性检查 ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityIssue {
    /// 稳定标识：修复时回传它，而不是回传路径
    pub id: String,
    /// `missing_note` | `orphan_directory` | `unregistered_file` | `hash_mismatch` | ...
    pub kind: String,
    /// `error` | `warning` | `info`
    pub severity: String,
    /// `node` | `resource` | `library` | `file` | `operation` | `edge` | `chat`
    pub entity_type: String,
    pub entity_id: String,
    #[serde(default)]
    pub path: Option<String>,
    pub detail: String,
    pub repairable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityCounts {
    pub nodes: i64,
    pub edges: i64,
    pub goals: i64,
    pub resources: i64,
    pub trashed_nodes: i64,
    pub trashed_resources: i64,
    pub pending_operations: i64,
    pub files_checked: i64,
    pub bytes_checked: i64,
    pub unregistered_files: i64,
    pub orphan_directories: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub deep: bool,
    pub checked_at: i64,
    pub revision: i64,
    pub issues: Vec<IntegrityIssue>,
    pub counts: IntegrityCounts,
    /// 没有 error 级问题时为 true
    pub ok: bool,
    /// 扫描提前中止（例如文件被占用）时为 true，报告不完整
    pub truncated: bool,
    pub warnings: Vec<String>,
}

/// 一项修复动作。只自动执行「意图唯一、无数据损失」的修复。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairAction {
    /// `create_empty_note` | `mark_node_missing` | `quarantine_orphan_directory`
    /// | `register_unregistered_file` | `drop_dangling_edge` | `drop_dangling_goal`
    /// | `reset_revision_hint` | `clear_completed_operations`
    pub action: String,
    pub entity_id: String,
    #[serde(default)]
    pub argument: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairOutcome {
    pub action: String,
    pub entity_id: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    pub applied: Vec<RepairOutcome>,
    pub report: IntegrityReport,
}

/* ------------------------------ 复制与备份 ------------------------------ */

/// `snapshot`：备份快照，保留原 libraryId；
/// `independent`：另存为独立知识库，必须生成新 libraryId。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CopyMode {
    Snapshot,
    Independent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub library_id: String,
    pub title: String,
    pub root_path: String,
    pub mode: CopyMode,
    pub file_count: i64,
    pub byte_length: i64,
}

/* ------------------------------ 设备级设置 ------------------------------ */

/// 最近打开的知识库。设备信息只存在 AppData，删除它不会丢知识内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentLibrary {
    pub path: String,
    pub title: String,
    pub library_id: String,
    pub last_opened_at: i64,
    /// 记录时路径是否还能读到 library.json
    #[serde(default)]
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    pub format: String,
    pub version: i64,
    #[serde(default)]
    pub recent_libraries: Vec<RecentLibrary>,
    /// 模型名、接口地址这类「按机器选择」的配置；API Key 始终在系统凭据存储里
    #[serde(default)]
    pub ai_config: serde_json::Value,
}

/* --------------------------------- 对话 ---------------------------------- */

/// 一个对话固定属于某一个知识节点；同一节点可以有多个对话。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: String,
    pub node_id: String,
    #[serde(default)]
    pub title: String,
    /// 长对话的压缩摘要；原始消息始终留在本地
    #[serde(default)]
    pub summary: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 消息生成状态。失败、取消、被截断或中途断流的回答不能标记为 complete。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    /// 正在生成
    Streaming,
    Complete,
    /// 用户主动停止，保留已生成的部分
    Cancelled,
    Failed,
    /// 流没有正常收尾（连接断开、没收到结束标记），内容残缺。
    ///
    /// 与 Cancelled 区分开：那一种是使用者主动停的，内容是他自己要的；
    /// 这一种是「不知道写没写完」，直接当完整回答存下来会误导后续阅读与再提问。
    Incomplete,
}

impl Default for MessageStatus {
    fn default() -> Self {
        MessageStatus::Complete
    }
}

impl MessageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageStatus::Streaming => "streaming",
            MessageStatus::Complete => "complete",
            MessageStatus::Cancelled => "cancelled",
            MessageStatus::Failed => "failed",
            MessageStatus::Incomplete => "incomplete",
        }
    }

    /// 数据库里的脏值（手工改过、旧版本写过、字段被截断）回落到「未完成」，
    /// 与备份解析端（backup.ts）保持一致：把来路不明的行当成完整回答，
    /// 会让半截内容被当成最终答案，比多显示一句「可能不完整」危险得多。
    pub fn from_db(value: &str) -> Self {
        match value {
            "streaming" => MessageStatus::Streaming,
            "complete" => MessageStatus::Complete,
            "cancelled" => MessageStatus::Cancelled,
            "failed" => MessageStatus::Failed,
            _ => MessageStatus::Incomplete,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub thread_id: String,
    /// system / user / assistant
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub status: MessageStatus,
    /// 停止原因。`length` 表示达到 max_tokens 被截断——
    /// 不区分的话，半截回答会被当成完整内容。
    #[serde(default)]
    pub finish_reason: Option<String>,
    /// 生成这条消息的请求 ID，用于避免流式回答写到错误的对话
    #[serde(default)]
    pub request_id: Option<String>,
    /// API 实际返回的用量（JSON 原文）
    #[serde(default)]
    pub usage: Option<String>,
    pub created_at: i64,
}

/// 一条依赖关系是「怎么被发现的」。
///
/// 同一个前置知识可能被多个节点依赖，两处卡住的原因未必相同，
/// 所以来源必须挂在依赖边上，而不是只写进目标节点的笔记。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub id: String,
    #[serde(default)]
    pub edge_id: Option<String>,
    pub from_node_id: String,
    pub to_node_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    /// 选中文字的快照：即使原消息被删，也能解释当初为什么建这条依赖
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub question: String,
    pub created_at: i64,
}

/// 学习书签：记录「从哪来、卡在哪」，用于深入学习后返回原处。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub node_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub scroll_offset: f64,
    /// 当时的疑问，回到这个节点时能恢复上下文
    #[serde(default)]
    pub question: String,
    /// 从哪个节点跳过来的
    #[serde(default)]
    pub return_node_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 对话与来源的一次性载入
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatData {
    #[serde(default)]
    pub threads: Vec<ChatThread>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub discoveries: Vec<Discovery>,
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
}

/* ------------------------------- 命令入参 ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLibraryRequest {
    /// 用户选择的父目录（绝对路径，来自系统文件夹选择器）
    pub parent_dir: String,
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLibraryRequest {
    pub root_path: String,
    /// 取得写锁失败时是否接受以只读方式打开
    #[serde(default)]
    pub allow_read_only: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNodeInput {
    pub title: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub status: Option<LearnStatus>,
    /// 创建时写入的初始正文；None 表示写一个空文件
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub aliases: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<LearnStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResourceRequest {
    pub node_id: String,
    /// 用户通过系统文件选择器选中的源文件绝对路径
    pub source_path: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddUrlResourceRequest {
    pub node_id: String,
    pub url: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteNoteRequest {
    pub node_id: String,
    pub content: String,
    /// 前端手上的文档修订号；不匹配即拒绝覆盖
    pub expected_document_revision: i64,
    /// 「覆盖保存」：明确要求忽略冲突，冲突版本会被另存为副本
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCopyRequest {
    pub target_parent_dir: String,
    pub name: String,
    pub mode: CopyMode,
}
