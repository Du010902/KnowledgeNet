//! Tauri 命令层：前端唯一的数据出入口（契约 `docs/v2-contract.md` §4 / §4.1）。
//!
//! 这一层只做四件事：取会话、校验入参形状、调用领域模块、把结果翻译成前端认识的形状。
//! 业务规则在 `v2::nodes` / `relations` / `notes` / `resources` / `chats` / `migrate` 里，
//! 命令层不重复实现任何一条规则。
//!
//! 三条纪律：
//! 1. 前端只传 `nodeId` / `resourceId` / `threadId` 与业务字段，**不传路径**；
//!    认领文件夹时传的是**相对知识库根**的路径字符串，由 Rust 做边界校验；
//! 2. 写命令一律走「串行写队列 + 当前知识库」，只读知识库在入口就被挡住；
//! 3. 错误是结构化的 `CmdError { code, message, detail }`，
//!    `external_change_conflict` / `metadata_invalid` / `duplicate_node_id` / `node_missing`
//!    这类情况前端必须能分支处理。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::deepseek::{self, AiConfig, AiState, ChatRequest, StreamEvent, TestResult};
use crate::device;
use crate::library::{self, LibraryLock, LockInfo};
use crate::models::{code, CmdError, CmdResult, CopyMode, CopyResult, LearnStatus};
use crate::paths;

use super::atomic;
use super::chats;
use super::ctx::LibCtx;
use super::index::IndexHandle;
use super::migrate;
use super::nodes;
use super::notes;
use super::relations;
use super::resources;
use super::schema::{
    BookmarkEntry, Evidence, GoalsFile, LibraryManifest, MessageFile, MessageStatus, NodeMeta,
    RelationEdge, RelationsFile, ResourceEntry, ThreadFile,
};
use super::scanner::{ScanIssue, ScanReport, ScannedEdge, ScannedNode, ScannedThread};
use super::state::{
    self, AppState, IntegrityReport, LibraryInfo, OpenLibrary, OpenOptions,
};
use super::vpaths;

fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/* ------------------------------- 前端形状 ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeNodeView {
    pub id: String,
    pub title: String,
    pub aliases: Vec<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// 只读扫描结果：节点目录相对知识库根（正斜杠）
    pub relative_path: String,
    pub folder_name: String,
    /// `ok` | `metadata_invalid` | `metadata_unsupported` | `duplicate_id`
    pub health: String,
    pub revision: i64,
    /// 这次会话内刚被改过（界面据此提示「已保存，索引待刷新」）
    pub local_mutation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdgeView {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub relation: String,
    pub relation_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalView {
    pub id: String,
    pub title: String,
    pub root_node_id: String,
    pub created_at: i64,
}

/// 学习位置的线上形状（同样是 `save_session` 的入参）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnSessionView {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub goal_id: String,
    pub current_node_id: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshotView {
    pub revision: i64,
    pub nodes: Vec<KnowledgeNodeView>,
    pub edges: Vec<DependencyEdgeView>,
    pub goals: Vec<GoalView>,
    pub session: Option<LearnSessionView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateIdGroupView {
    pub node_id: String,
    pub relative_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReportView {
    pub full: bool,
    pub duration_ms: i64,
    pub scanned_dirs: i64,
    pub nodes: Vec<KnowledgeNodeView>,
    pub edges: Vec<DependencyEdgeView>,
    pub goals: Vec<GoalView>,
    pub threads: Vec<ChatThreadView>,
    pub issues: Vec<ScanIssue>,
    pub duplicate_ids: Vec<DuplicateIdGroupView>,
    pub root_is_node: bool,
    pub truncated: bool,
    /// 扫描代次：前端用它丢弃旧库/旧代的迟到事件
    pub generation: i64,
}

/// 对话线程的线上形状。
///
/// **这些 View 同时是「返回值」与「入参」**（`save_thread` 收的就是它）。
/// 作为入参时必须容忍前端领域类型里**可选**的字段：
/// `ChatThread.messageCount?` / `nodeRelativePath?` 是扫描派生值，前端手里不一定有。
/// 少写一个 `#[serde(default)]`，Tauri 就会在反序列化时报
/// `invalid args ...: missing field ...`，而这条错误只在真机运行时才出现。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadView {
    pub id: String,
    pub node_id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub message_count: i64,
    #[serde(default)]
    pub node_relative_path: String,
    #[serde(default)]
    pub revision: i64,
}

/// 对话消息的线上形状（同样是 `save_message` 的入参）。
///
/// 前端 `ChatMessage` 里 `updatedAt?` 是可选的，而且**根本没有 `sequence` 字段**
/// ——序号是磁盘文件名的概念，由 Rust 侧分配。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageView {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    #[serde(default)]
    pub content: String,
    pub status: String,
    pub finish_reason: Option<String>,
    pub request_id: Option<String>,
    /// 前端既有类型是字符串，这里把 usage JSON 序列化回字符串
    pub usage: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 前端不传：0 表示「由 Rust 分配」
    #[serde(default)]
    pub sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedThreadView {
    pub thread: ChatThreadView,
    pub messages: Vec<ChatMessageView>,
    /// 解析失败被跳过的消息文件数量（如实报告，不静默吞掉）
    pub skipped: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedIdentityView {
    pub node_id: String,
    pub title: String,
    pub relative_path: String,
    pub trashed_relative: String,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeFileEntryView {
    pub relative_path: String,
    pub name: String,
    pub byte_length: i64,
    pub modified_ms: i64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeResourceView {
    pub id: String,
    pub node_id: String,
    pub resource_type: String,
    pub relative_path: Option<String>,
    pub source_url: Option<String>,
    pub original_name: String,
    pub display_name: String,
    pub mime_type: String,
    pub byte_length: i64,
    pub sha256: String,
    pub description: String,
    pub sort_order: i64,
    pub state: String,
    pub missing: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 书签的线上形状（同样是 `save_bookmark` 的入参）。
///
/// 前端 `Bookmark` 里 `id` 可以是空串（表示新建），时间字段缺失时由 Rust 补当前时间。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkView {
    #[serde(default)]
    pub id: String,
    pub node_id: String,
    pub thread_id: Option<String>,
    pub message_id: Option<String>,
    #[serde(default)]
    pub scroll_offset: f64,
    #[serde(default)]
    pub question: String,
    pub return_node_id: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeNoteView {
    pub node_id: String,
    pub relative_path: String,
    pub content: String,
    pub document_revision: i64,
    pub sha256: String,
    pub byte_length: i64,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDiskStateView {
    pub node_id: String,
    pub exists: bool,
    pub sha256: String,
    pub byte_length: i64,
    pub modified_at: i64,
    pub document_revision: i64,
    pub changed_on_disk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteConflictView {
    pub disk: NodeNoteView,
    pub expected_revision: i64,
    pub reason: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteNoteOutcomeView {
    Saved {
        note: NodeNoteView,
        revision: i64,
        conflict_copy: Option<String>,
    },
    Conflict {
        conflict: NoteConflictView,
        conflict_copy: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSnapshotView {
    pub node: KnowledgeNodeView,
    pub revision: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddOutcome<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle: Option<Vec<String>>,
}

fn ok_outcome<T>(value: T) -> AddOutcome<T> {
    AddOutcome {
        ok: true,
        value: Some(value),
        reason: None,
        cycle: None,
    }
}

fn cycle_outcome<T>(cycle: Vec<String>) -> AddOutcome<T> {
    AddOutcome {
        ok: false,
        value: None,
        reason: Some("cycle".to_string()),
        cycle: Some(cycle),
    }
}

/// 「字段没传」与「字段显式传了 null」的区别。
///
/// 直接写 `Option<Option<T>>` 是**区分不出来**的：serde 的 `Option` 反序列化把 JSON `null`
/// 直接变成外层的 `None`，于是「不改这一项」和「把这一项清空」变成同一件事。
/// 这个辅助函数让字段存在时（哪怕是 `null`）一定得到 `Some(..)`，
/// 配合 `#[serde(default)]` 就能表达三态：不传 / 传 null / 传值。
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePatchView {
    pub title: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub status: Option<String>,
    /// 主文档三态：不传 = 不改这一项；`null` = 取消主文档；字符串 = 设成它
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub primary_document: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePatchView {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationEdgeInput {
    pub id: Option<String>,
    pub to_node_id: String,
    #[serde(rename = "type")]
    pub type_: Option<String>,
    pub description: Option<String>,
    pub to_title_snapshot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationEdgeView {
    pub id: String,
    pub to_node_id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub description: String,
    pub to_title_snapshot: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub evidence: Vec<EvidenceView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceView {
    pub id: String,
    pub thread_id: Option<String>,
    pub message_id: Option<String>,
    pub snippet: String,
    pub question: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationsSnapshotView {
    pub outgoing: Vec<RelationEdgeView>,
    pub revision: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddPrerequisitesPayloadView {
    pub parent_id: String,
    pub created: Vec<KnowledgeNodeView>,
    pub reused: Vec<KnowledgeNodeView>,
    pub edges: Vec<DependencyEdgeView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedEdgeRefView {
    pub dropped_edge_id: String,
    pub replacement_edge_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePayloadView {
    pub source_id: String,
    pub target: KnowledgeNodeView,
    pub removed_node_id: String,
    pub moved_edges: Vec<DependencyEdgeView>,
    pub dropped_edges: Vec<DroppedEdgeRefView>,
    pub goals_repointed: Vec<GoalView>,
    pub moved_threads: i64,
    pub moved_bookmarks: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedIdentitySummaryView {
    pub moved_metadata_to_trash: bool,
    pub kept_user_files: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReportView {
    pub from_version: i64,
    pub to_version: i64,
    pub recovery_relative: String,
    pub before: serde_json::Value,
    pub after: serde_json::Value,
    pub warnings: Vec<String>,
    pub verified: bool,
    pub published: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUiState {
    #[serde(default)]
    pub last_node_id: Option<String>,
    #[serde(default)]
    pub last_goal_id: Option<String>,
    /// 工作台布局（面板比例、模式…）：属于设备交互状态，不是知识内容
    #[serde(default)]
    pub workspace: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairActionView {
    pub action: String,
    pub entity_id: String,
    #[serde(default)]
    pub argument: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairOutcomeView {
    pub action: String,
    pub entity_id: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReportView {
    pub applied: Vec<RepairOutcomeView>,
    pub report: IntegrityReport,
}

/* ------------------------------- 形状翻译 ------------------------------- */

fn node_view(node: &ScannedNode) -> KnowledgeNodeView {
    KnowledgeNodeView {
        id: node.id.clone(),
        title: node.title.clone(),
        aliases: node.aliases.clone(),
        status: node.status.as_str().to_string(),
        created_at: super::schema::iso_to_ms_lossy(&node.created_at),
        updated_at: super::schema::iso_to_ms_lossy(&node.updated_at),
        relative_path: node.relative_path.clone(),
        folder_name: node.folder_name.clone(),
        health: node.health.clone(),
        revision: node.revision,
        local_mutation: false,
    }
}

fn edge_view(edge: &ScannedEdge) -> DependencyEdgeView {
    DependencyEdgeView {
        id: edge.id.clone(),
        from_id: edge.from_node_id.clone(),
        to_id: edge.to_node_id.clone(),
        relation: edge.description.clone(),
        relation_type: edge.relation_type.clone(),
        created_at: super::schema::iso_to_ms_lossy(&edge.created_at),
        updated_at: super::schema::iso_to_ms_lossy(&edge.updated_at),
    }
}

fn goal_view(goal: &super::schema::GoalEntry) -> GoalView {
    GoalView {
        id: goal.id.clone(),
        title: goal.title.clone(),
        root_node_id: goal.root_node_id.clone(),
        created_at: super::schema::iso_to_ms_lossy(&goal.created_at),
    }
}

fn thread_view(thread: &ScannedThread) -> ChatThreadView {
    ChatThreadView {
        id: thread.id.clone(),
        node_id: thread.node_id.clone(),
        title: thread.title.clone(),
        summary: thread.summary.clone(),
        created_at: super::schema::iso_to_ms_lossy(&thread.created_at),
        updated_at: super::schema::iso_to_ms_lossy(&thread.updated_at),
        message_count: thread.message_count,
        node_relative_path: thread.node_relative_path.clone(),
        revision: thread.revision,
    }
}

/// 磁盘上的 `stopped` / `error` 在前端叫 `cancelled` / `failed`（既有类型不改）。
fn status_to_view(status: MessageStatus) -> &'static str {
    match status {
        MessageStatus::Streaming => "streaming",
        MessageStatus::Complete => "complete",
        MessageStatus::Stopped => "cancelled",
        MessageStatus::Error => "failed",
        MessageStatus::Incomplete => "incomplete",
    }
}

fn status_from_view(raw: &str) -> MessageStatus {
    match raw {
        "streaming" => MessageStatus::Streaming,
        "cancelled" | "stopped" => MessageStatus::Stopped,
        "failed" | "error" => MessageStatus::Error,
        "incomplete" => MessageStatus::Incomplete,
        _ => MessageStatus::Complete,
    }
}

fn message_view(message: &MessageFile) -> ChatMessageView {
    ChatMessageView {
        id: message.id.clone(),
        thread_id: message.thread_id.clone(),
        role: message.role.clone(),
        content: message.content.clone(),
        status: status_to_view(message.status).to_string(),
        finish_reason: message.finish_reason.clone(),
        request_id: message.request_id.clone(),
        usage: message
            .usage
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default()),
        model: message.model.clone(),
        created_at: super::schema::iso_to_ms_lossy(&message.created_at),
        updated_at: super::schema::iso_to_ms_lossy(&message.updated_at),
        sequence: message.sequence,
    }
}

fn relation_edge_view(edge: &RelationEdge) -> RelationEdgeView {
    RelationEdgeView {
        id: edge.id.clone(),
        to_node_id: edge.to_node_id.clone(),
        type_: edge.type_.clone(),
        description: edge.description.clone(),
        to_title_snapshot: edge.to_title_snapshot.clone(),
        created_at: super::schema::iso_to_ms_lossy(&edge.created_at),
        updated_at: super::schema::iso_to_ms_lossy(&edge.updated_at),
        evidence: edge
            .evidence
            .iter()
            .map(|e| EvidenceView {
                id: e.id.clone(),
                thread_id: e.thread_id.clone(),
                question: e.question.clone(),
                message_id: e.message_id.clone(),
                snippet: e.snippet.clone(),
                created_at: super::schema::iso_to_ms_lossy(&e.created_at),
            })
            .collect(),
    }
}

fn resource_view(node_id: &str, entry: &ResourceEntry, exists: bool) -> NodeResourceView {
    NodeResourceView {
        id: entry.id.clone(),
        node_id: node_id.to_string(),
        resource_type: entry.kind.clone(),
        relative_path: entry.relative_path.clone(),
        source_url: entry.url.clone(),
        original_name: entry.original_name.clone(),
        display_name: entry.display_name.clone(),
        mime_type: entry.mime_type.clone(),
        byte_length: entry.byte_length,
        sha256: entry.sha256.clone(),
        description: entry.description.clone(),
        sort_order: entry.sort_order,
        state: if exists { "ready" } else { "missing" }.to_string(),
        missing: !exists,
        created_at: super::schema::iso_to_ms_lossy(&entry.created_at),
        updated_at: super::schema::iso_to_ms_lossy(&entry.updated_at),
    }
}

fn bookmark_view(node_id: &str, entry: &BookmarkEntry) -> BookmarkView {
    BookmarkView {
        id: entry.id.clone(),
        node_id: node_id.to_string(),
        thread_id: entry.thread_id.clone(),
        message_id: entry.message_id.clone(),
        scroll_offset: entry.scroll_offset,
        question: entry.question.clone(),
        return_node_id: entry.return_node_id.clone(),
        created_at: super::schema::iso_to_ms_lossy(&entry.created_at),
        updated_at: super::schema::iso_to_ms_lossy(&entry.updated_at),
    }
}

fn scan_report_view(report: &ScanReport, generation: u64) -> ScanReportView {
    ScanReportView {
        full: report.full,
        duration_ms: report.duration_ms,
        scanned_dirs: report.scanned_dirs,
        nodes: report.nodes.iter().map(node_view).collect(),
        edges: report.edges.iter().map(edge_view).collect(),
        goals: report.goals.iter().map(goal_view).collect(),
        threads: report.threads.iter().map(thread_view).collect(),
        issues: report.issues.clone(),
        duplicate_ids: report
            .duplicate_ids
            .iter()
            .map(|g| DuplicateIdGroupView {
                node_id: g.node_id.clone(),
                relative_paths: g.relative_paths.clone(),
            })
            .collect(),
        root_is_node: report.root_is_node,
        truncated: report.truncated,
        generation: generation as i64,
    }
}

/* ------------------------------ 会话与设备目录 ------------------------------ */

fn app_data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| CmdError::io(format!("无法确定设备数据目录（AppData）：{e}")))
}

fn ui_state_path(app: &AppHandle, library_id: &str) -> CmdResult<PathBuf> {
    let dir = app_data_dir(app)?.join("library-state");
    atomic::ensure_dir(&dir)?;
    Ok(dir.join(format!("{library_id}.json")))
}

fn read_ui_state(app: &AppHandle, library_id: &str) -> CmdResult<LibraryUiState> {
    let path = ui_state_path(app, library_id)?;
    // 设备侧的小文件不套知识资产的格式头校验：坏了直接回默认值，
    // 为了「上次看到哪」这种便利信息让界面打不开是不划算的。
    match atomic::read_json_opt::<LibraryUiState>(&path) {
        Ok(Some((value, _))) => Ok(value),
        Ok(None) => Ok(LibraryUiState::default()),
        Err(err) => {
            eprintln!("每库 UI 状态无法解析（忽略并回默认值）：{}", err.message);
            Ok(LibraryUiState::default())
        }
    }
}

fn write_ui_state(app: &AppHandle, library_id: &str, value: &LibraryUiState) -> CmdResult<()> {
    let path = ui_state_path(app, library_id)?;
    atomic::write_json(&path, value)?;
    Ok(())
}

/// 当前打开的知识库；未打开返回 `not_open`。
fn with_read<R>(state: &AppState, f: impl FnOnce(&OpenLibrary) -> CmdResult<R>) -> CmdResult<R> {
    let session = state::read_session(state)?;
    f(session.lib()?)
}

/// 写会话：串行写队列 + 只读拒绝。
fn with_write<R>(
    state: &AppState,
    f: impl FnOnce(&mut OpenLibrary) -> CmdResult<R>,
) -> CmdResult<R> {
    let mut session = state::write_session(state)?;
    f(session.lib()?)
}

/// 读写都做得来的会话（扫描要写索引，但只读库上也允许扫描）。
fn with_inspect<R>(state: &AppState, f: impl FnOnce(&mut OpenLibrary) -> CmdResult<R>) -> CmdResult<R> {
    let mut session = state::inspection_session(state)?;
    f(session.lib()?)
}

fn node_ctx(lib: &OpenLibrary, node_id: &str) -> CmdResult<(LibCtx, String)> {
    let rel = state::node_relative_path(lib, node_id)?;
    Ok((state::ctx_of(lib), rel))
}

/* -------------------------------- 设备级命令 -------------------------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettingsView {
    pub recent_libraries: Vec<crate::models::RecentLibrary>,
    pub has_api_key: bool,
    pub ai_config: AiConfig,
}

#[tauri::command]
pub fn load_device_settings(app: AppHandle) -> CmdResult<DeviceSettingsView> {
    let path = device::settings_path(&app)?;
    Ok(DeviceSettingsView {
        recent_libraries: device::list_recent(&path)?,
        has_api_key: deepseek::has_api_key(),
        ai_config: device::load_ai_config(&path)?,
    })
}

#[tauri::command]
pub fn remove_recent_library(app: AppHandle, path: String) -> CmdResult<()> {
    let settings = device::settings_path(&app)?;
    device::forget(&settings, &path)
}

#[tauri::command]
pub async fn pick_directory(app: AppHandle, title: Option<String>) -> CmdResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(title) = title {
            dialog = dialog.set_title(title);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|e| CmdError::msg(format!("打开文件夹选择器失败: {e}")))?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn pick_files(app: AppHandle) -> CmdResult<Vec<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择要加入知识库的文件")
            .blocking_pick_files()
    })
    .await
    .map_err(|e| CmdError::msg(format!("打开文件选择器失败: {e}")))?;
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
pub fn load_library_ui_state(app: AppHandle, library_id: String) -> CmdResult<LibraryUiState> {
    read_ui_state(&app, &library_id)
}

#[tauri::command]
pub fn save_library_ui_state(
    app: AppHandle,
    library_id: String,
    ui_state: LibraryUiState,
) -> CmdResult<()> {
    write_ui_state(&app, &library_id, &ui_state)
}

/* ------------------------------- 知识库生命周期 ------------------------------- */

#[tauri::command]
pub fn create_library(
    app: AppHandle,
    state: State<'_, AppState>,
    parent_dir: String,
    name: String,
    title: Option<String>,
) -> CmdResult<LibraryInfo> {
    let parent = PathBuf::from(parent_dir);
    if !parent.is_dir() {
        return Err(CmdError::invalid(format!(
            "父目录不存在：{}",
            parent.display()
        )));
    }
    let safe = paths::validate_simple_name(&name, "知识库文件夹名")?;
    let root = parent.join(safe);
    library::create_library_dir(&root, title.as_deref().unwrap_or(&name))?;
    open_library(app, state, root.to_string_lossy().to_string(), Some(false))
}

#[tauri::command]
pub fn open_library(
    app: AppHandle,
    state: State<'_, AppState>,
    root_path: String,
    allow_read_only: Option<bool>,
) -> CmdResult<LibraryInfo> {
    let root = PathBuf::from(root_path.trim());
    state::close(&state)?;
    let info = state::open(
        &state,
        &root,
        OpenOptions {
            allow_read_only: allow_read_only.unwrap_or(false),
            app_data_dir: app_data_dir(&app)?,
            app: Some(app.clone()),
            app_version: app_version(),
        },
    )?;
    let settings = device::settings_path(&app)?;
    device::remember(
        &settings,
        &info.root_path,
        &info.title,
        &info.library_id,
    )?;
    Ok(info)
}

#[tauri::command]
pub fn close_library(state: State<'_, AppState>) -> CmdResult<()> {
    state::close(&state)
}

#[tauri::command]
pub fn current_library_info(state: State<'_, AppState>) -> CmdResult<Option<LibraryInfo>> {
    let guard = library::lock_ignoring_poison(&state.library);
    Ok(guard.as_ref().map(state::info_of))
}

#[tauri::command]
pub fn create_library_copy(
    state: State<'_, AppState>,
    target_parent_dir: String,
    name: String,
    mode: CopyMode,
) -> CmdResult<CopyResult> {
    with_read(&state, |lib| {
        let parent = PathBuf::from(target_parent_dir.trim());
        if !parent.is_dir() {
            return Err(CmdError::invalid(format!(
                "目标父目录不存在：{}",
                parent.display()
            )));
        }
        let safe = paths::validate_simple_name(&name, "副本文件夹名")?;
        let dst = parent.join(safe);
        let (files, bytes) = library::copy_library_tree(lib.paths.root(), &dst)?;
        let manifest = match mode {
            CopyMode::Independent => library::reidentify_library(&dst, None)?,
            CopyMode::Snapshot => {
                let (manifest, _) = library::read_manifest(&dst)?;
                manifest
            }
        };
        Ok(CopyResult {
            library_id: manifest.library_id.clone(),
            title: manifest.title.clone(),
            root_path: dst.to_string_lossy().to_string(),
            mode,
            file_count: files,
            byte_length: bytes as i64,
        })
    })
}

#[tauri::command]
pub fn check_library_integrity(
    state: State<'_, AppState>,
    deep: bool,
) -> CmdResult<IntegrityReport> {
    with_inspect(&state, |lib| state::check_integrity(lib, deep))
}

#[tauri::command]
pub fn repair_library(
    state: State<'_, AppState>,
    actions: Vec<RepairActionView>,
) -> CmdResult<RepairReportView> {
    let mut applied = Vec::new();
    for action in &actions {
        let outcome = with_write(&state, |lib| match action.action.as_str() {
            // 「两份文件夹其实是同一个节点」：这是新节点，给副本重新发 ID
            // （两个名字都接受：契约里叫 reassign_duplicate_node_id，前端类型里叫 reassign_duplicate_id）
            "reassign_duplicate_node_id" | "reassign_duplicate_id" => {
                let rel = if action.entity_id.trim().is_empty() {
                    action.argument.clone().unwrap_or_default()
                } else {
                    action.entity_id.clone()
                };
                let ctx = state::ctx_of(lib);
                match nodes::reassign_duplicate_node_id(&ctx, &rel) {
                    Ok(node) => {
                        state::refresh_node(lib, &node.relative_path)?;
                        Ok(RepairOutcomeView {
                            action: action.action.clone(),
                            entity_id: rel,
                            ok: true,
                            detail: format!("已分配新 ID：{}", node.id),
                        })
                    }
                    Err(e) => Ok(RepairOutcomeView {
                        action: action.action.clone(),
                        entity_id: rel,
                        ok: false,
                        detail: e.message,
                    }),
                }
            }
            "rescan_library" | "rebuild_index" => match state::rescan(lib) {
                Ok(report) => Ok(RepairOutcomeView {
                    action: action.action.clone(),
                    entity_id: action.entity_id.clone(),
                    ok: true,
                    detail: format!("重新扫描完成：{} 个节点", report.nodes.len()),
                }),
                Err(e) => Ok(RepairOutcomeView {
                    action: action.action.clone(),
                    entity_id: action.entity_id.clone(),
                    ok: false,
                    detail: e.message,
                }),
            },
            other => Ok(RepairOutcomeView {
                action: other.to_string(),
                entity_id: action.entity_id.clone(),
                ok: false,
                detail: "不支持的修复动作：v2 只自动执行「重复 ID 重新发号」与「重新扫描」这两件意图唯一、无数据损失的事"
                    .to_string(),
            }),
        })?;
        applied.push(outcome);
    }
    let report = with_inspect(&state, |lib| state::check_integrity(lib, true))?;
    Ok(RepairReportView { applied, report })
}

#[tauri::command]
pub fn scan_library(state: State<'_, AppState>, full: bool) -> CmdResult<ScanReportView> {
    let _ = full; // v2 的扫描本身总是「全量读头、不读正文」，full 只影响调用方语义
    with_inspect(&state, |lib| {
        let report = state::rescan(lib)?;
        Ok(scan_report_view(&report, state::generation_of(lib)))
    })
}

/// 删掉设备本地索引并当场重建：这是「索引可删除」的可执行证明。
#[tauri::command]
pub fn rebuild_device_index(
    state: State<'_, AppState>,
) -> CmdResult<super::state::ReportSummary> {
    with_inspect(&state, |lib| state::rebuild_index(lib))
}

#[tauri::command]
pub fn needs_migration(root_path: String) -> CmdResult<Option<i64>> {
    let root = PathBuf::from(root_path.trim());
    let text = library::read_manifest_text(&root)?;
    let version = library::peek_format_version(&text)?;
    if version == super::schema::LIBRARY_FORMAT_VERSION {
        Ok(None)
    } else {
        Ok(Some(version))
    }
}

#[tauri::command]
pub fn migrate_library(
    state: State<'_, AppState>,
    root_path: String,
) -> CmdResult<MigrationReportView> {
    let root = PathBuf::from(root_path.trim());
    // 迁移会整体换掉存储形态，先把当前会话关掉（含写锁），
    // 迁移结束后由界面重新 `open_library`——那一步才会建立 v2 的设备索引。
    state::close(&state)?;
    let report = migrate::migrate_v1_to_v2(&root, false)?;
    Ok(MigrationReportView {
        from_version: report.from_version,
        to_version: report.to_version,
        recovery_relative: report.recovery_relative,
        before: serde_json::to_value(&report.before).unwrap_or(serde_json::Value::Null),
        after: serde_json::to_value(&report.after).unwrap_or(serde_json::Value::Null),
        warnings: report.warnings,
        verified: report.verified,
        published: report.published,
    })
}

/* --------------------------------- 图谱 --------------------------------- */

#[tauri::command]
pub fn load_graph(app: AppHandle, state: State<'_, AppState>) -> CmdResult<GraphSnapshotView> {
    with_read(&state, |lib| {
        let graph = state::index_of(lib).load_graph()?;
        let ui = read_ui_state(&app, &lib.manifest.library_id).unwrap_or_default();
        let session = ui.last_node_id.map(|node_id| LearnSessionView {
            id: lib.session_id.clone(),
            goal_id: ui.last_goal_id.clone().unwrap_or_default(),
            current_node_id: Some(node_id),
            updated_at: paths::now_ms(),
        });
        Ok(GraphSnapshotView {
            revision: graph.revision,
            nodes: graph.nodes.iter().map(node_view).collect(),
            edges: graph.edges.iter().map(edge_view).collect(),
            goals: graph.goals.iter().map(goal_view).collect(),
            session,
        })
    })
}

#[tauri::command]
pub fn create_node(
    state: State<'_, AppState>,
    title: String,
    parent_relative_path: Option<String>,
) -> CmdResult<serde_json::Value> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let node = nodes::create_node(&ctx, &title, parent_relative_path.as_deref())?;
        state::rescan(lib)?;
        Ok(serde_json::json!({
            "node": node_view(&node),
            "revision": state::generation_of(lib),
        }))
    })
}

#[tauri::command]
pub fn update_node(
    state: State<'_, AppState>,
    node_id: String,
    patch: NodePatchView,
) -> CmdResult<serde_json::Value> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let (meta, fp) = nodes::read_node_meta(&ctx, &rel)?;
        let new_patch = node_patch(&patch)?;
        let (updated, _) = nodes::update_node_meta(&ctx, &rel, &new_patch, meta.revision, Some(&fp.sha256))?;
        state::rescan(lib)?;
        let node = state::node_row(lib, &node_id)?;
        let _ = updated;
        Ok(serde_json::json!({
            "node": node_view(&node),
            "revision": state::generation_of(lib),
        }))
    })
}

fn node_patch(patch: &NodePatchView) -> CmdResult<nodes::NodeMetaPatch> {
    let status = match patch.status.as_deref() {
        None => None,
        Some("todo") => Some(LearnStatus::Todo),
        Some("learning") => Some(LearnStatus::Learning),
        Some("done") => Some(LearnStatus::Done),
        Some(other) => {
            return Err(CmdError::invalid(format!(
                "未知的学习状态：{other}（只接受 todo / learning / done）"
            )))
        }
    };
    Ok(nodes::NodeMetaPatch {
        title: patch.title.clone(),
        aliases: patch.aliases.clone(),
        status,
        primary_document: patch.primary_document.clone(),
    })
}

#[tauri::command]
pub fn read_node_metadata(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<MetadataSnapshotView> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let (meta, fp) = nodes::read_node_meta(&ctx, &rel)?;
        let node = state::node_row(lib, &node_id)?;
        let _ = meta;
        Ok(MetadataSnapshotView {
            node: node_view(&node),
            revision: node.revision,
            sha256: fp.sha256,
        })
    })
}

#[tauri::command]
pub fn update_node_metadata(
    state: State<'_, AppState>,
    node_id: String,
    patch: NodePatchView,
    expected_revision: i64,
    expected_hash: String,
) -> CmdResult<KnowledgeNodeView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let new_patch = node_patch(&patch)?;
        nodes::update_node_meta(&ctx, &rel, &new_patch, expected_revision, Some(&expected_hash))?;
        state::refresh_node(lib, &rel)?;
        Ok(node_view(&state::node_row(lib, &node_id)?))
    })
}

/// **移除节点身份**：只把 `.meta/knowledgenet` 移进回收站，用户文件原位不动。
#[tauri::command]
pub fn delete_node(state: State<'_, AppState>, node_id: String) -> CmdResult<RemovedIdentityView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let removed = nodes::remove_node_identity(&ctx, &rel)?;
        state::rescan(lib)?;
        Ok(RemovedIdentityView {
            node_id: removed.node_id,
            title: removed.title,
            relative_path: removed.relative_path,
            trashed_relative: removed.trashed_relative,
            deleted_at: removed.deleted_at,
        })
    })
}

#[tauri::command]
pub fn list_removed_identities(state: State<'_, AppState>) -> CmdResult<Vec<RemovedIdentityView>> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        Ok(nodes::list_removed_identities(&ctx)?
            .into_iter()
            .map(|r| RemovedIdentityView {
                node_id: r.node_id,
                title: r.title,
                relative_path: r.relative_path,
                trashed_relative: r.trashed_relative,
                deleted_at: r.deleted_at,
            })
            .collect())
    })
}

#[tauri::command]
pub fn restore_node(
    state: State<'_, AppState>,
    node_id: String,
    target_relative_path: Option<String>,
) -> CmdResult<KnowledgeNodeView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let node = nodes::restore_node_identity(&ctx, &node_id, target_relative_path.as_deref())?;
        state::rescan(lib)?;
        Ok(node_view(&state::node_row(lib, &node.id)?))
    })
}

#[tauri::command]
pub fn purge_removed_identity(
    state: State<'_, AppState>,
    node_id: String,
    deleted_at: i64,
) -> CmdResult<RemovedIdentitySummaryView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        nodes::purge_removed_identity(&ctx, &node_id, deleted_at)?;
        state::rescan(lib)?;
        Ok(RemovedIdentitySummaryView {
            moved_metadata_to_trash: true,
            kept_user_files: true,
            warnings: vec![
                "只删除了 .knowledgenet/trash 里的元数据副本；普通用户文件不在回收站里，永远不会被这一步删除。"
                    .to_string(),
            ],
        })
    })
}

#[tauri::command]
pub fn adopt_folder_as_node(
    state: State<'_, AppState>,
    relative_path: String,
    title: Option<String>,
) -> CmdResult<KnowledgeNodeView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let node = nodes::adopt_folder(&ctx, &relative_path, title.as_deref())?;
        state::rescan(lib)?;
        Ok(node_view(&state::node_row(lib, &node.id)?))
    })
}

#[tauri::command]
pub fn reassign_duplicate_node_id(
    state: State<'_, AppState>,
    relative_path: String,
) -> CmdResult<KnowledgeNodeView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let node = nodes::reassign_duplicate_node_id(&ctx, &relative_path)?;
        state::rescan(lib)?;
        Ok(node_view(&state::node_row(lib, &node.id)?))
    })
}

#[tauri::command]
pub fn open_node_folder(state: State<'_, AppState>, node_id: String) -> CmdResult<()> {
    with_read(&state, |lib| {
        let dir = state::node_dir(lib, &node_id)?;
        nodes::open_in_file_manager(&dir)
    })
}

/* ---------------------------- 彻底删除与备份 ---------------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeFolderUsageView {
    pub relative_path: String,
    pub file_count: i64,
    pub byte_size: i64,
    pub resource_count: i64,
    pub resource_bytes: i64,
    pub directory_count: i64,
    pub nested_node_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBackupView {
    pub node_id: String,
    pub title: String,
    pub relative_path: String,
    pub backup_relative_path: String,
    pub backup_path: String,
    pub file_count: i64,
    pub byte_size: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeErasureView {
    pub node_id: String,
    pub title: String,
    pub relative_path: String,
    pub deleted_files: i64,
    pub deleted_bytes: i64,
    pub purged_archives: i64,
}

/// 删除前的体检：文件夹里有多少文件、多大。对话框要把它写进那句文字提醒里。
#[tauri::command]
pub fn inspect_node_folder(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<NodeFolderUsageView> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let usage = nodes::inspect_node_folder(&ctx, &rel)?;
        Ok(NodeFolderUsageView {
            relative_path: usage.relative_path,
            file_count: usage.file_count,
            byte_size: usage.byte_size,
            resource_count: usage.resource_count,
            resource_bytes: usage.resource_bytes,
            directory_count: usage.directory_count,
            nested_node_count: usage.nested_node_count,
        })
    })
}

/// 删除前的「备份文件夹中的资源」：整份复制到 `<root>/.knowledgenet/backups/`。
#[tauri::command]
pub fn backup_node_resources(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<NodeBackupView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let backup = nodes::backup_node_folder(&ctx, &rel)?;
        Ok(NodeBackupView {
            node_id: backup.node_id,
            title: backup.title,
            relative_path: backup.relative_path,
            backup_relative_path: backup.backup_relative_path,
            backup_path: backup.backup_path,
            file_count: backup.file_count,
            byte_size: backup.byte_size,
            created_at: backup.created_at,
        })
    })
}

/// **彻底删除**：文件夹连同里面的文件一起删掉，不可撤销。界面必须先说清后果。
#[tauri::command]
pub fn erase_node(state: State<'_, AppState>, node_id: String) -> CmdResult<NodeErasureView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let erased = nodes::erase_node_folder(&ctx, &rel)?;
        state::rescan(lib)?;
        Ok(NodeErasureView {
            node_id: erased.node_id,
            title: erased.title,
            relative_path: erased.relative_path,
            deleted_files: erased.deleted_files,
            deleted_bytes: erased.deleted_bytes,
            purged_archives: erased.purged_archives,
        })
    })
}

/// 在文件管理器里打开一个备份目录。只接受 `.knowledgenet/backups/` 里的路径。
#[tauri::command]
pub fn reveal_backup(state: State<'_, AppState>, backup_relative_path: String) -> CmdResult<()> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let normalized = backup_relative_path.trim().replace('\\', "/");
        let prefix = format!("{}/{}/", vpaths::ROOT_META_DIR, vpaths::BACKUPS_DIR);
        if !normalized.starts_with(&prefix) {
            return Err(CmdError::invalid(format!(
                "拒绝打开知识库备份目录以外的路径：{backup_relative_path}"
            )));
        }
        // 词法前缀只是第一层：仍然走一遍逃逸校验
        let dir = ctx.resolve(&normalized)?;
        if !dir.is_dir() {
            return Err(CmdError::not_found(format!(
                "备份目录不存在：{normalized}"
            )));
        }
        nodes::open_in_file_manager(&dir)
    })
}

/* --------------------------------- 关系 --------------------------------- */

/// 加一条 `from → to`（「为了理解 from，需要先理解 to」）。成环时整批不落地。
#[tauri::command]
pub fn add_edge(
    state: State<'_, AppState>,
    from_id: String,
    to_id: String,
    relation: Option<String>,
) -> CmdResult<AddOutcome<DependencyEdgeView>> {
    with_write(&state, |lib| {
        if from_id == to_id {
            return Err(CmdError::invalid("不能把一个知识点设成它自己的前置"));
        }
        let index = state::index_of(lib);
        let graph = index.load_graph()?;
        if let Some(cycle) = find_cycle(&graph.edges, &from_id, &to_id) {
            return Ok(cycle_outcome(cycle));
        }
        let to_title = graph
            .nodes
            .iter()
            .find(|n| n.id == to_id)
            .map(|n| n.title.clone())
            .unwrap_or_default();
        drop(index);

        let ctx = state::ctx_of(lib);
        let from_rel = state::node_relative_path(lib, &from_id)?;
        let edge = relations::add_edge(
            &ctx,
            &from_rel,
            &to_id,
            &to_title,
            "prerequisite",
            relation.as_deref().unwrap_or(""),
        )?;
        state::rescan(lib)?;
        Ok(ok_outcome(DependencyEdgeView {
            id: edge.id,
            from_id: from_id.clone(),
            to_id: edge.to_node_id,
            relation: edge.description,
            relation_type: edge.type_,
            created_at: super::schema::iso_to_ms_lossy(&edge.created_at),
            updated_at: super::schema::iso_to_ms_lossy(&edge.updated_at),
        }))
    })
}

/// 加一条 `from → to` 会不会成环：当且仅当 `to` 已经（经出边）可达 `from`。
fn find_cycle(edges: &[ScannedEdge], from_id: &str, to_id: &str) -> Option<Vec<String>> {
    let mut adjacency: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for edge in edges {
        adjacency
            .entry(edge.from_node_id.as_str())
            .or_default()
            .push(edge.to_node_id.as_str());
    }
    let mut queue: std::collections::VecDeque<Vec<&str>> = std::collections::VecDeque::new();
    queue.push_back(vec![to_id]);
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    seen.insert(to_id);
    while let Some(path) = queue.pop_front() {
        let last = *path.last()?;
        if last == from_id {
            let mut cycle: Vec<String> = vec![from_id.to_string()];
            cycle.extend(path.iter().map(|s| s.to_string()));
            return Some(cycle);
        }
        for next in adjacency.get(last).into_iter().flatten() {
            if seen.insert(next) {
                let mut extended = path.clone();
                extended.push(next);
                queue.push_back(extended);
            }
        }
    }
    None
}

#[tauri::command]
pub fn remove_edge(
    state: State<'_, AppState>,
    from_node_id: String,
    edge_id: String,
) -> CmdResult<i64> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &from_node_id)?;
        relations::remove_edge(&ctx, &rel, &edge_id)?;
        state::rescan(lib)?;
        Ok(state::generation_of(lib) as i64)
    })
}

#[tauri::command]
pub fn update_edge_relation(
    state: State<'_, AppState>,
    from_node_id: String,
    edge_id: String,
    relation: String,
) -> CmdResult<i64> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &from_node_id)?;
        relations::update_edge_description(&ctx, &rel, &edge_id, &relation)?;
        state::rescan(lib)?;
        Ok(state::generation_of(lib) as i64)
    })
}

#[tauri::command]
pub fn read_relations(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<RelationsSnapshotView> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let (file, fp) = relations::read_or_empty(&ctx, &rel, &node_id)?;
        Ok(RelationsSnapshotView {
            outgoing: file.outgoing.iter().map(relation_edge_view).collect(),
            revision: file.revision,
            sha256: fp.sha256,
        })
    })
}

#[tauri::command]
pub fn write_relations(
    state: State<'_, AppState>,
    node_id: String,
    outgoing: Vec<RelationEdgeInput>,
    expected_revision: i64,
    expected_hash: String,
) -> CmdResult<i64> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &node_id)?;
        let (existing, _) = relations::read_or_empty(&ctx, &rel, &node_id)?;
        let now = paths::iso_now();
        let mut file: RelationsFile = existing;
        file.outgoing = outgoing
            .iter()
            .map(|input| RelationEdge {
                id: input.id.clone().unwrap_or_else(paths::new_id),
                to_node_id: input.to_node_id.clone(),
                type_: input
                    .type_
                    .clone()
                    .unwrap_or_else(|| "prerequisite".to_string()),
                description: input.description.clone().unwrap_or_default(),
                to_title_snapshot: input.to_title_snapshot.clone().unwrap_or_default(),
                created_at: now.clone(),
                updated_at: now.clone(),
                evidence: Vec::new(),
                extra: serde_json::Map::new(),
            })
            .collect();
        file.node_id = node_id.clone();
        file.revision += 1;
        let written = relations::write(&ctx, &rel, &file, expected_revision, Some(&expected_hash))?;
        let _ = written;
        state::rescan(lib)?;
        Ok(file.revision)
    })
}

#[tauri::command]
pub fn add_evidence(
    state: State<'_, AppState>,
    from_node_id: String,
    edge_id: String,
    thread_id: Option<String>,
    message_id: Option<String>,
    snippet: String,
    question: String,
) -> CmdResult<EvidenceView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let rel = state::node_relative_path(lib, &from_node_id)?;
        let mut evidence = Evidence::new(paths::iso_now());
        evidence.thread_id = thread_id;
        evidence.message_id = message_id;
        evidence.snippet = snippet;
        evidence.question = question;
        let saved = relations::add_evidence(&ctx, &rel, &edge_id, &evidence)?;
        Ok(EvidenceView {
            id: saved.id,
            thread_id: saved.thread_id,
            message_id: saved.message_id,
            snippet: saved.snippet,
            question: saved.question,
            created_at: super::schema::iso_to_ms_lossy(&saved.created_at),
        })
    })
}

/// 批量新增前置知识：同名/同别名复用，其余新建；整批一个原子操作。
#[tauri::command]
pub fn add_prerequisites(
    state: State<'_, AppState>,
    parent_id: String,
    titles: Vec<String>,
) -> CmdResult<AddOutcome<AddPrerequisitesPayloadView>> {
    with_write(&state, |lib| {
        let cleaned: Vec<String> = titles
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if cleaned.is_empty() {
            return Err(CmdError::invalid("至少要有一个前置知识名称"));
        }

        let mut created: Vec<ScannedNode> = Vec::new();
        let mut reused: Vec<ScannedNode> = Vec::new();
        let ctx = state::ctx_of(lib);

        for title in &cleaned {
            let existing = {
                let index = state::index_of(lib);
                let all = index.all_nodes()?;
                all.into_iter()
                    .find(|n| n.health == "ok" && matches_title(n, title))
            };
            match existing {
                Some(node) => reused.push(node),
                None => {
                    let node = nodes::create_node(&ctx, title, None)?;
                    created.push(node);
                }
            }
        }

        // 边一条条加：成环时整批回滚（把这次新建的节点身份撤掉）
        let mut edges: Vec<DependencyEdgeView> = Vec::new();
        for node in created.iter().chain(reused.iter()) {
            let graph = state::index_of(lib).load_graph()?;
            if let Some(cycle) = find_cycle(&graph.edges, &parent_id, &node.id) {
                for rollback in &created {
                    let _ = nodes::remove_node_identity(&ctx, &rollback.relative_path);
                }
                return Ok(cycle_outcome(cycle));
            }
            let parent_rel = state::node_relative_path(lib, &parent_id)?;
            let edge = relations::add_edge(
                &ctx,
                &parent_rel,
                &node.id,
                &node.title,
                "prerequisite",
                "",
            )?;
            edges.push(DependencyEdgeView {
                id: edge.id,
                from_id: parent_id.clone(),
                to_id: node.id.clone(),
                relation: edge.description,
                relation_type: edge.type_,
                created_at: super::schema::iso_to_ms_lossy(&edge.created_at),
                updated_at: super::schema::iso_to_ms_lossy(&edge.updated_at),
            });
        }

        state::rescan(lib)?;
        let refreshed: Vec<ScannedNode> = {
            let index = state::index_of(lib);
            index.all_nodes()?
        };
        let view = |node: &ScannedNode| {
            refreshed
                .iter()
                .find(|n| n.id == node.id)
                .map(node_view)
                .unwrap_or_else(|| node_view(node))
        };
        Ok(ok_outcome(AddPrerequisitesPayloadView {
            parent_id: parent_id.clone(),
            created: created.iter().map(view).collect(),
            reused: reused.iter().map(view).collect(),
            edges,
        }))
    })
}

fn matches_title(node: &ScannedNode, title: &str) -> bool {
    let key = title.trim().to_lowercase();
    if node.title.trim().to_lowercase() == key {
        return true;
    }
    node.aliases
        .iter()
        .any(|alias| alias.trim().to_lowercase() == key)
}

/// 合并重复节点：只合并知识身份，**不动任何用户文件夹**。
#[tauri::command]
pub fn merge_nodes(
    state: State<'_, AppState>,
    source_id: String,
    target_id: String,
) -> CmdResult<AddOutcome<MergePayloadView>> {
    with_write(&state, |lib| {
        if source_id == target_id {
            return Err(CmdError::invalid("不能把节点合并到它自己"));
        }
        let graph = state::index_of(lib).load_graph()?;
        let target = graph
            .nodes
            .iter()
            .find(|n| n.id == target_id)
            .cloned()
            .ok_or_else(|| CmdError::not_found(format!("找不到目标节点 {target_id}")))?;
        let source = graph
            .nodes
            .iter()
            .find(|n| n.id == source_id)
            .cloned()
            .ok_or_else(|| CmdError::not_found(format!("找不到源节点 {source_id}")))?;

        // 预检：把源节点的出边接到目标后会不会成环
        let simulated: Vec<ScannedEdge> = graph
            .edges
            .iter()
            .filter(|e| e.from_node_id != source_id)
            .cloned()
            .collect();
        for edge in graph.edges.iter().filter(|e| e.from_node_id == source_id) {
            if edge.to_node_id == target_id {
                continue;
            }
            if let Some(cycle) = find_cycle(&simulated, &target_id, &edge.to_node_id) {
                return Ok(cycle_outcome(cycle));
            }
        }

        let ctx = state::ctx_of(lib);
        let mut moved_threads = 0i64;
        let mut moved_bookmarks = 0i64;
        let mut warnings: Vec<String> = Vec::new();

        // 1. 源节点的出边并入目标节点的 relations.json
        relations::move_edges(&ctx, &source.relative_path, &target.relative_path)?;

        // 2. 其它节点指向源 ID 的关系改接到目标 ID（去重、去自环）
        let all_paths: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| n.id != source_id)
            .map(|n| n.relative_path.clone())
            .collect();
        relations::repoint_target(&ctx, &all_paths, &source_id, &target_id, &target.title)?;

        // 3. 对话线程整体搬到目标节点的 chats 目录，并把 thread.json 的 nodeId 改成目标
        let source_dir = ctx.node_dir(&source.relative_path)?;
        let target_dir = ctx.node_dir(&target.relative_path)?;
        let source_threads: Vec<super::scanner::ScannedThread> = {
            let index = state::index_of(lib);
            index
                .threads_for_node(&source_id)?
                .into_iter()
                .collect()
        };
        for thread in source_threads.iter() {
            match move_thread(&source_dir, &target_dir, thread)
                .and_then(|()| repoint_thread_node(&target_dir, &thread.id, &target_id))
            {
                Ok(()) => moved_threads += 1,
                Err(e) => warnings.push(format!("对话 {} 迁移失败：{}", thread.title, e.message)),
            }
        }

        // 4. 书签并入目标
        if let Ok((file, _)) = super::bookmarks::read(&ctx, &source.relative_path) {
            for entry in &file.bookmarks {
                let mut entry = entry.clone();
                entry.id = paths::new_id();
                if super::bookmarks::save(&ctx, &target.relative_path, &entry).is_ok() {
                    moved_bookmarks += 1;
                }
            }
        }

        // 5. 别名并入目标 node.json
        {
            let (mut meta, fp) = nodes::read_node_meta(&ctx, &target.relative_path)?;
            let mut aliases = meta.aliases.clone();
            for alias in &source.aliases {
                if !aliases.contains(alias) {
                    aliases.push(alias.clone());
                }
            }
            if !aliases.contains(&source.title) && source.title != meta.title {
                aliases.push(source.title.clone());
            }
            let patch = nodes::NodeMetaPatch {
                aliases: Some(aliases),
                ..Default::default()
            };
            let _ = nodes::update_node_meta(&ctx, &target.relative_path, &patch, meta.revision, Some(&fp.sha256));
            let _ = &mut meta;
        }

        // 6. 目标节点上的学习目标引用改接
        let goals_repointed = super::bookmarks::repoint_goals(&ctx, &source_id, &target_id)?;
        let goals_after = super::bookmarks::read_goals(&ctx)?.0.goals.clone();
        let _ = goals_repointed;

        // 7. 源节点的元数据进回收站，**文件夹与用户文件原位保留**
        nodes::remove_node_identity(&ctx, &source.relative_path)?;

        state::rescan(lib)?;
        let refreshed = state::index_of(lib).load_graph()?;
        let target_node = refreshed
            .nodes
            .iter()
            .find(|n| n.id == target_id)
            .cloned()
            .ok_or_else(|| CmdError::not_found("合并后找不到目标节点"))?;

        Ok(ok_outcome(MergePayloadView {
            source_id: source_id.clone(),
            target: node_view(&target_node),
            removed_node_id: source_id,
            moved_edges: Vec::new(),
            dropped_edges: Vec::new(),
            goals_repointed: goals_after.iter().map(goal_view).collect(),
            moved_threads,
            moved_bookmarks,
        }))
    })
}

/// 把一个线程目录从源节点搬到目标节点（`thread.json` 的 `nodeId` 由
/// [`repoint_thread_node`] 随后改写）。
fn move_thread(source_dir: &Path, target_dir: &Path, thread: &ScannedThread) -> CmdResult<()> {
    let from = vpaths::thread_dir(source_dir, &thread.id);
    let to = vpaths::thread_dir(target_dir, &thread.id);
    if to.exists() {
        return Err(CmdError::new(
            code::CONFLICT,
            format!("目标节点里已经有同名对话 {}，已跳过", thread.id),
        ));
    }
    atomic::ensure_dir(&vpaths::chats_dir(target_dir))?;
    std::fs::rename(&from, &to).map_err(|e| CmdError::io(format!("移动对话目录失败：{e}")))?;
    Ok(())
}

/// 合并节点时把线程头的 `nodeId` 改写成目标节点（调用方给出确切 id）。
pub fn repoint_thread_node(
    target_dir: &Path,
    thread_id: &str,
    target_node_id: &str,
) -> CmdResult<()> {
    let path = vpaths::thread_file(target_dir, thread_id);
    let (mut file, _) = atomic::read_typed::<ThreadFile>(
        &path,
        super::schema::THREAD_FORMAT,
        super::schema::THREAD_FORMAT_VERSION,
        "thread.json",
        None,
    )?;
    file.node_id = target_node_id.to_string();
    file.revision += 1;
    file.updated_at = paths::iso_now();
    atomic::write_json(&path, &file)?;
    Ok(())
}

/* --------------------------------- 笔记 --------------------------------- */

fn primary_document_of(meta: &NodeMeta) -> Option<String> {
    meta.primary_document.clone()
}

fn note_view(node_id: &str, snapshot: &notes::DocumentSnapshot) -> NodeNoteView {
    NodeNoteView {
        node_id: node_id.to_string(),
        relative_path: snapshot.relative_path.clone(),
        content: snapshot.content.clone(),
        document_revision: snapshot.revision,
        sha256: snapshot.sha256.clone(),
        byte_length: snapshot.byte_length,
        modified_at: snapshot.modified_ms,
    }
}

#[tauri::command]
pub fn read_node_note(state: State<'_, AppState>, node_id: String) -> CmdResult<NodeNoteView> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let (meta, _) = nodes::read_node_meta(&ctx, &rel)?;
        let doc = primary_document_of(&meta).unwrap_or_else(|| notes::DEFAULT_DOCUMENT.to_string());
        let snapshot = notes::read_document(&ctx, &rel, &doc)?;
        Ok(note_view(&node_id, &snapshot))
    })
}

#[tauri::command]
pub fn write_node_note(
    state: State<'_, AppState>,
    node_id: String,
    content: String,
    expected_document_revision: i64,
    force: Option<bool>,
) -> CmdResult<WriteNoteOutcomeView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_ctx2, rel) = node_ctx(lib, &node_id)?;
        let (meta, _) = nodes::read_node_meta(&ctx, &rel)?;
        let doc = primary_document_of(&meta).unwrap_or_else(|| notes::DEFAULT_DOCUMENT.to_string());
        let outcome = notes::write_document(
            &ctx,
            &rel,
            &doc,
            &content,
            expected_document_revision,
            force.unwrap_or(false),
        )?;
        match outcome {
            notes::WriteDocumentOutcome::Saved {
                document,
                conflict_copy,
            } => {
                // `primaryDocument` 的登记由 `notes::write_document` 负责（它在写正文之前就登记好）。
                // 这里**不要**再用手上那份旧 revision 去改 node.json：那次写入必然被判成
                // 外部改动冲突，而冲突被吞掉之后就是一段永远不生效的死代码。
                state::refresh_node(lib, &rel)?;
                Ok(WriteNoteOutcomeView::Saved {
                    note: note_view(&node_id, &document),
                    revision: state::generation_of(lib) as i64,
                    conflict_copy,
                })
            }
            notes::WriteDocumentOutcome::Conflict {
                disk,
                expected_revision,
                reason,
                detail,
            } => Ok(WriteNoteOutcomeView::Conflict {
                conflict: NoteConflictView {
                    disk: note_view(&node_id, &disk),
                    expected_revision,
                    reason,
                    detail,
                },
                conflict_copy: None,
            }),
        }
    })
}

#[tauri::command]
pub fn check_node_note(state: State<'_, AppState>, node_id: String) -> CmdResult<NoteDiskStateView> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let (meta, _) = nodes::read_node_meta(&ctx, &rel)?;
        let doc = primary_document_of(&meta).unwrap_or_else(|| notes::DEFAULT_DOCUMENT.to_string());
        let snapshot = notes::read_document(&ctx, &rel, &doc)?;
        let last_known = notes_index_sha(&ctx, &rel, &doc).unwrap_or_default();
        let changed = !last_known.is_empty()
            && !last_known.eq_ignore_ascii_case(&snapshot.sha256);
        Ok(NoteDiskStateView {
            node_id,
            exists: !snapshot.sha256.is_empty(),
            sha256: snapshot.sha256.clone(),
            byte_length: snapshot.byte_length,
            modified_at: snapshot.modified_ms,
            document_revision: snapshot.revision,
            changed_on_disk: changed,
        })
    })
}

/// 直接读节点笔记索引里记录的「上次已知哈希」（格式见 `docs/v2-deviations.md`）。
fn notes_index_sha(ctx: &LibCtx, node_rel: &str, doc_rel: &str) -> Option<String> {
    let dir = ctx.node_dir_unchecked(node_rel).ok()?;
    let path = vpaths::ns_dir(&dir).join("notes-index.json");
    let (value, _) = atomic::read_json_value(&path).ok()?;
    let entries = value.get("entries")?.as_array()?;
    entries.iter().find_map(|entry| {
        let same = entry.get("relativePath")?.as_str()? == doc_rel;
        if same {
            entry.get("sha256")?.as_str().map(|s| s.to_string())
        } else {
            None
        }
    })
}

/* --------------------------------- 资料 --------------------------------- */

#[tauri::command]
pub fn list_node_resources(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<Vec<NodeResourceView>> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let node_dir = ctx.node_dir(&rel)?;
        let entries = resources::list_resources(&ctx, &rel)?;
        Ok(entries
            .iter()
            .map(|entry| {
                let exists = match &entry.relative_path {
                    Some(p) => node_dir
                        .join(p.replace('/', std::path::MAIN_SEPARATOR_STR))
                        .is_file(),
                    None => true,
                };
                resource_view(&node_id, entry, exists)
            })
            .collect())
    })
}

#[tauri::command]
pub fn list_node_plain_files(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<Vec<NodeFileEntryView>> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        Ok(resources::list_plain_files(&ctx, &rel)?
            .into_iter()
            .map(|f| NodeFileEntryView {
                relative_path: f.relative_path,
                name: f.name,
                byte_length: f.byte_length,
                modified_ms: f.modified_ms,
                is_dir: f.is_dir,
            })
            .collect())
    })
}

#[tauri::command]
pub fn add_resource_file(
    state: State<'_, AppState>,
    node_id: String,
    source_path: String,
    display_name: Option<String>,
) -> CmdResult<serde_json::Value> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let entry = resources::add_file_resource(
            &ctx,
            &rel,
            Path::new(&source_path),
            display_name.as_deref(),
        )?;
        state::refresh_node(lib, &rel)?;
        Ok(serde_json::json!({
            "resource": resource_view(&node_id, &entry, true),
            "revision": state::generation_of(lib),
        }))
    })
}

#[tauri::command]
pub fn add_resource_url(
    state: State<'_, AppState>,
    node_id: String,
    url: String,
    display_name: Option<String>,
    description: Option<String>,
) -> CmdResult<serde_json::Value> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let entry = resources::add_url_resource(
            &ctx,
            &rel,
            &node_id,
            &url,
            display_name.as_deref(),
            description.as_deref(),
        )?;
        Ok(serde_json::json!({
            "resource": resource_view(&node_id, &entry, true),
            "revision": state::generation_of(lib),
        }))
    })
}

#[tauri::command]
pub fn update_resource(
    state: State<'_, AppState>,
    node_id: String,
    resource_id: String,
    patch: ResourcePatchView,
) -> CmdResult<serde_json::Value> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let entry = resources::update_resource(
            &ctx,
            &rel,
            &resource_id,
            patch.display_name.as_deref(),
            patch.description.as_deref(),
            patch.sort_order,
        )?;
        Ok(serde_json::json!({
            "resource": resource_view(&node_id, &entry, true),
            "revision": state::generation_of(lib),
        }))
    })
}

#[tauri::command]
pub fn open_resource(
    state: State<'_, AppState>,
    node_id: String,
    resource_id: String,
) -> CmdResult<()> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let path = resources::resolve_resource_path(&ctx, &rel, &resource_id)?;
        open_path_with_default_app(&path)
    })
}

#[tauri::command]
pub fn reveal_resource(
    state: State<'_, AppState>,
    node_id: String,
    resource_id: String,
) -> CmdResult<()> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let path = resources::resolve_resource_path(&ctx, &rel, &resource_id)?;
        nodes::open_in_file_manager(&path)
    })
}

#[tauri::command]
pub fn delete_resource(
    state: State<'_, AppState>,
    node_id: String,
    resource_id: String,
    delete_file: Option<bool>,
) -> CmdResult<i64> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        resources::remove_resource(&ctx, &rel, &resource_id, delete_file.unwrap_or(false))?;
        state::refresh_node(lib, &rel)?;
        Ok(state::generation_of(lib) as i64)
    })
}

#[tauri::command]
pub fn annotate_plain_file(
    state: State<'_, AppState>,
    node_id: String,
    relative_path: String,
) -> CmdResult<serde_json::Value> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let entry = resources::annotate_file(&ctx, &rel, &relative_path)?;
        Ok(serde_json::json!({
            "resource": resource_view(&node_id, &entry, true),
            "revision": state::generation_of(lib),
        }))
    })
}

fn open_path_with_default_app(path: &Path) -> CmdResult<()> {
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();

    result
        .map(|_| ())
        .map_err(|e| CmdError::io(format!("无法打开 {}：{e}", path.display())))
}

/* ------------------------------ 位置与对话 ------------------------------ */

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session: Option<LearnSessionView>,
) -> CmdResult<i64> {
    with_read(&state, |lib| {
        let mut ui = read_ui_state(&app, &lib.manifest.library_id).unwrap_or_default();
        match session {
            Some(view) => {
                ui.last_node_id = view.current_node_id;
                if !view.goal_id.is_empty() {
                    ui.last_goal_id = Some(view.goal_id);
                }
            }
            None => {
                ui.last_node_id = None;
            }
        }
        write_ui_state(&app, &lib.manifest.library_id, &ui)?;
        Ok(state::generation_of(lib) as i64)
    })
}

#[tauri::command]
pub fn enter_node(
    app: AppHandle,
    state: State<'_, AppState>,
    node_id: String,
    goal_id: Option<String>,
) -> CmdResult<i64> {
    with_read(&state, |lib| {
        let mut ui = read_ui_state(&app, &lib.manifest.library_id).unwrap_or_default();
        ui.last_node_id = Some(node_id);
        if let Some(goal_id) = goal_id {
            ui.last_goal_id = Some(goal_id);
        }
        write_ui_state(&app, &lib.manifest.library_id, &ui)?;
        Ok(state::generation_of(lib) as i64)
    })
}

#[tauri::command]
pub fn list_threads(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<Vec<ChatThreadView>> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        Ok(chats::list_threads(&ctx, &rel)?
            .iter()
            .map(thread_view)
            .collect())
    })
}

#[tauri::command]
pub fn load_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> CmdResult<LoadedThreadView> {
    let mut session = state::write_session(&state).or_else(|_| {
        // 只读库上也要能读对话
        state::inspection_session(&state).map(|s| s)
    })?;
    let lib = session.lib()?;
    let ctx = state::ctx_of(lib);
    let thread_row = state::index_of(lib)
        .thread(&thread_id)?
        .ok_or_else(|| CmdError::not_found(format!("找不到对话 {thread_id}")))?;
    let loaded = chats::load_thread(&ctx, &thread_row.node_relative_path, &thread_id)?;

    // 重启后发现 `streaming`：转成 `incomplete`，**保留已生成正文**。
    let skipped = 0i64;
    let mut messages: Vec<ChatMessageView> = loaded.messages.iter().map(message_view).collect();
    if loaded
        .messages
        .iter()
        .any(|m| m.status == MessageStatus::Streaming)
    {
        if !lib.read_only {
            chats::recover_incomplete(&ctx, &thread_row.node_relative_path)?;
            let reloaded =
                chats::load_thread(&ctx, &thread_row.node_relative_path, &thread_id)?;
            messages = reloaded.messages.iter().map(message_view).collect();
        } else {
            for message in &mut messages {
                if message.status == "streaming" {
                    message.status = "incomplete".to_string();
                }
            }
        }
    }
    state::refresh_threads(lib, &thread_row.node_relative_path, &thread_row.node_id)?;

    Ok(LoadedThreadView {
        thread: thread_view(&thread_row),
        messages,
        skipped,
    })
}

#[tauri::command]
pub fn create_thread(
    state: State<'_, AppState>,
    node_id: String,
    title: Option<String>,
) -> CmdResult<ChatThreadView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let thread = chats::create_thread(
            &ctx,
            &rel,
            &node_id,
            title.as_deref().unwrap_or("新对话"),
        )?;
        state::refresh_threads(lib, &rel, &node_id)?;
        Ok(ChatThreadView {
            id: thread.id,
            node_id: thread.node_id,
            title: thread.title,
            summary: thread.summary,
            created_at: super::schema::iso_to_ms_lossy(&thread.created_at),
            updated_at: super::schema::iso_to_ms_lossy(&thread.updated_at),
            message_count: 0,
            node_relative_path: rel,
            revision: thread.revision,
        })
    })
}

#[tauri::command]
pub fn save_thread(
    state: State<'_, AppState>,
    thread: ChatThreadView,
    expected_revision: i64,
) -> CmdResult<ChatThreadView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        // `nodeRelativePath` 是**扫描派生值**，前端手里不一定有（`ChatThread` 里它是可选的）。
        // 拿不到就从设备索引按 nodeId 反查——这正是索引存在的意义，
        // 不该把「你必须先 list_threads 拿到路径」变成调用者的负担。
        let rel = if thread.node_relative_path.trim().is_empty() {
            state::node_relative_path(lib, &thread.node_id)?
        } else {
            thread.node_relative_path.clone()
        };
        let now = paths::now_ms();
        let file = ThreadFile {
            format: super::schema::THREAD_FORMAT.to_string(),
            format_version: super::schema::THREAD_FORMAT_VERSION,
            id: thread.id.clone(),
            node_id: thread.node_id.clone(),
            revision: thread.revision.max(1),
            title: thread.title.clone(),
            summary: thread.summary.clone(),
            created_at: super::schema::iso_from_ms(if thread.created_at > 0 {
                thread.created_at
            } else {
                now
            }),
            updated_at: super::schema::iso_from_ms(if thread.updated_at > 0 {
                thread.updated_at
            } else {
                now
            }),
            extra: serde_json::Map::new(),
        };
        let saved = chats::save_thread(&ctx, &rel, &file, expected_revision)?;
        state::refresh_threads(lib, &rel, &thread.node_id)?;
        Ok(ChatThreadView {
            revision: saved.revision,
            node_relative_path: rel,
            ..thread
        })
    })
}

#[tauri::command]
pub fn delete_thread(
    state: State<'_, AppState>,
    node_id: String,
    thread_id: String,
) -> CmdResult<()> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        chats::delete_thread(&ctx, &rel, &thread_id)?;
        state::refresh_threads(lib, &rel, &node_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn save_message(
    state: State<'_, AppState>,
    node_id: String,
    thread_id: String,
    message: ChatMessageView,
) -> CmdResult<ChatMessageView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let file = MessageFile {
            format: super::schema::MESSAGE_FORMAT.to_string(),
            format_version: super::schema::MESSAGE_FORMAT_VERSION,
            id: message.id.clone(),
            thread_id: thread_id.clone(),
            // 前端不传序号：0 交给 chats::save_message 决定
            // （同一条消息沿用它自己的序号，新消息顺延到末尾）
            sequence: message.sequence.max(0),
            role: message.role.clone(),
            content: message.content.clone(),
            status: status_from_view(&message.status),
            finish_reason: message.finish_reason.clone(),
            request_id: message.request_id.clone(),
            usage: message
                .usage
                .as_ref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok()),
            model: message.model.clone(),
            created_at: super::schema::iso_from_ms(if message.created_at > 0 {
                message.created_at
            } else {
                paths::now_ms()
            }),
            updated_at: super::schema::iso_from_ms(if message.updated_at > 0 {
                message.updated_at
            } else {
                paths::now_ms()
            }),
            extra: serde_json::Map::new(),
        };
        let saved = chats::save_message(&ctx, &rel, &thread_id, &file)?;
        state::refresh_threads(lib, &rel, &node_id)?;
        Ok(message_view(&saved))
    })
}

#[tauri::command]
pub fn delete_message(
    state: State<'_, AppState>,
    node_id: String,
    thread_id: String,
    message_id: String,
) -> CmdResult<()> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        chats::delete_message(&ctx, &rel, &thread_id, &message_id)?;
        state::refresh_threads(lib, &rel, &node_id)?;
        Ok(())
    })
}

#[tauri::command]
pub fn list_bookmarks(
    state: State<'_, AppState>,
    node_id: String,
) -> CmdResult<Vec<BookmarkView>> {
    with_read(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let (file, _) = super::bookmarks::read(&ctx, &rel)?;
        Ok(file
            .bookmarks
            .iter()
            .map(|entry| bookmark_view(&node_id, entry))
            .collect())
    })
}

#[tauri::command]
pub fn save_bookmark(
    state: State<'_, AppState>,
    node_id: String,
    bookmark: BookmarkView,
) -> CmdResult<BookmarkView> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        let now = paths::iso_now();
        let entry = BookmarkEntry {
            id: if bookmark.id.is_empty() {
                paths::new_id()
            } else {
                bookmark.id.clone()
            },
            thread_id: bookmark.thread_id.clone(),
            message_id: bookmark.message_id.clone(),
            scroll_offset: bookmark.scroll_offset,
            question: bookmark.question.clone(),
            return_node_id: bookmark.return_node_id.clone(),
            created_at: if bookmark.created_at > 0 {
                super::schema::iso_from_ms(bookmark.created_at)
            } else {
                now.clone()
            },
            updated_at: now,
            extra: serde_json::Map::new(),
        };
        let saved = super::bookmarks::save(&ctx, &rel, &entry)?;
        Ok(bookmark_view(&node_id, &saved))
    })
}

#[tauri::command]
pub fn delete_bookmark(
    state: State<'_, AppState>,
    node_id: String,
    bookmark_id: String,
) -> CmdResult<()> {
    with_write(&state, |lib| {
        let ctx = state::ctx_of(lib);
        let (_, rel) = node_ctx(lib, &node_id)?;
        super::bookmarks::delete(&ctx, &rel, &bookmark_id)?;
        Ok(())
    })
}

/* ---------------------------- 自动为对话起标题 ---------------------------- */

/// 把模型吐出来的一行字整理成一个像样的标题。
///
/// 模型不总是听话：可能带引号、带「标题：」前缀、多给一行解释，或者干脆拒答。
/// 这里只做**确定性**的收敛；判断不了就返回 `None` 让界面保持原样——
/// 起不出标题是小事，塞一个「抱歉，我不能…」当标题才是真的难看。
pub fn normalize_suggested_title(raw: &str) -> Option<String> {
    let line = raw
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())?
        .trim_start_matches(|c: char| {
            c.is_whitespace() || "-*•·>#".contains(c) || c.is_ascii_digit() || c == '.'
        })
        .trim();

    // 去掉常见的包裹与前后缀
    let mut text = line.to_string();
    for prefix in ["标题：", "标题:", "题目：", "题目:", "Title:", "title:"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim().to_string();
            break;
        }
    }
    let text = text
        .trim_matches(|c: char| {
            c.is_whitespace()
                || "\"'“”‘’「」『』《》【】[]()（）".contains(c)
                || "。.，,；;：:！!？?".contains(c)
                // 模型常把标题写成 `**加粗**` 或 `` `代码` ``：首尾的强调符号不是标题的一部分
                || "*_`~".contains(c)
        })
        .trim()
        .to_string();

    if text.is_empty() {
        return None;
    }
    // 拒答 / 解释性开场白：宁可不起标题
    const REJECT: [&str; 6] = ["抱歉", "对不起", "无法", "不能", "作为 AI", "作为一个"];
    if REJECT.iter().any(|k| text.contains(k)) {
        return None;
    }
    // 太长就截断：标题要塞进一行按钮里
    let shortened: String = text.chars().take(24).collect();
    let shortened = shortened.trim().to_string();
    if shortened.is_empty() {
        None
    } else {
        Some(shortened)
    }
}

/// 按**字符**（不是字节）截断，中文不会被切碎
fn clip(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// 用**第一轮问答**让 AI 给这个对话起一个短标题。
///
/// 只读、不写盘：是否采纳由界面决定（界面才知道用户有没有手动改过标题）。
/// 起不出来（没配 Key、网络失败、模型返回空）返回 `None` 而**不是错误**——
/// 「起不出标题」不该变成一个报错弹窗。
#[tauri::command]
pub async fn suggest_thread_title(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> CmdResult<Option<String>> {
    // 同步把要用的东西取出来，然后**先释放知识库锁再发网络请求**：
    // 拿着互斥锁等网络，会让所有读写命令一起排在后面。
    let turns: Vec<deepseek::ChatTurn> = {
        let session = state::read_session(&state)?;
        let lib = session.lib()?;
        let ctx = state::ctx_of(lib);
        let row = state::index_of(lib)
            .thread(&thread_id)?
            .ok_or_else(|| CmdError::not_found(format!("找不到对话 {thread_id}")))?;
        let loaded = chats::load_thread(&ctx, &row.node_relative_path, &thread_id)?;

        let first_user = loaded
            .messages
            .iter()
            .find(|m| m.role == "user" && !m.content.trim().is_empty());
        let first_assistant = loaded
            .messages
            .iter()
            .find(|m| m.role == "assistant" && !m.content.trim().is_empty());
        // 只有第一轮（一问一答）齐了才值得起标题：只有问题时还没什么可概括的
        match (first_user, first_assistant) {
            (Some(user), Some(assistant)) => vec![deepseek::ChatTurn {
                role: "user".to_string(),
                content: format!(
                    "知识点：{}\n问题：{}\n回答要点：{}",
                    row.title,
                    clip(&user.content, 300),
                    clip(&assistant.content, 500)
                ),
            }],
            _ => Vec::new(),
        }
    };

    if turns.is_empty() {
        return Ok(None);
    }

    let mut messages = vec![deepseek::ChatTurn {
        role: "system".to_string(),
        content: "你在给一个学习笔记应用里的对话起标题。只输出标题本身：\
                  不超过 12 个字，不要引号，不要书名号，不要句末标点，不要解释，不要换行。"
            .to_string(),
    }];
    messages.extend(turns);

    let settings = device::settings_path(&app)?;
    let config = device::load_ai_config(&settings)?;
    match deepseek::complete_once(config, messages, 32).await {
        Ok(raw) => Ok(normalize_suggested_title(&raw)),
        Err(err) => {
            // 起标题是锦上添花：失败只记一行日志，不打扰用户
            eprintln!("自动起标题失败（已忽略）：{err}");
            Ok(None)
        }
    }
}

/* ---------------------------------- AI ---------------------------------- */

#[tauri::command]
pub fn save_ai_config(app: AppHandle, config: AiConfig) -> CmdResult<()> {
    let path = device::settings_path(&app)?;
    device::save_ai_config(&path, &config)
}

#[tauri::command]
pub fn save_api_key(key: String) -> CmdResult<()> {
    deepseek::save_api_key(&key).map_err(CmdError::msg)
}

#[tauri::command]
pub fn clear_api_key() -> CmdResult<()> {
    deepseek::clear_api_key().map_err(CmdError::msg)
}

#[tauri::command]
pub async fn test_ai_connection(config: AiConfig) -> CmdResult<TestResult> {
    Ok(deepseek::test_connection(config).await)
}

#[tauri::command]
pub fn start_chat(
    ai: State<'_, AiState>,
    channel: Channel<StreamEvent>,
    request: ChatRequest,
) -> CmdResult<()> {
    deepseek::start_chat(&ai, channel, request).map_err(CmdError::msg)
}

#[tauri::command]
pub fn cancel_chat(ai: State<'_, AiState>, request_id: String) -> CmdResult<bool> {
    Ok(ai.cancel(&request_id))
}

/* ------------------------------- 生命周期钩子 ------------------------------- */

pub fn cancel_all_chats(app: &AppHandle) {
    if let Some(ai) = app.try_state::<AiState>() {
        ai.cancel_all();
    }
}

/// 关窗前收尾：停监听、释放写锁。
///
/// v2 的资产就是文件，且每次写入都是原子的，所以这里**不需要** checkpoints 或 WAL；
/// 用户复制文件夹时不会拿到半截 JSON。
pub fn shutdown_library(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state::shutdown(&state);
    }
}

/// 给迁移/认领用的只读锁探测：另一个实例正开着时不要动文件。
pub fn try_lock_probe(root: &Path, library_id: &str) -> CmdResult<()> {
    let info = LockInfo {
        library_id: library_id.to_string(),
        session_id: library::new_session_id(),
        hostname: library::hostname(),
        pid: std::process::id(),
        app_version: app_version(),
        opened_at: paths::iso_now(),
    };
    let lock = LibraryLock::acquire(&vpaths::root_lock_file(root), &info)?;
    drop(lock);
    Ok(())
}

/// 迁移完成后重建索引（迁移会换掉整个知识库的存储形态）。
pub fn post_migration_reindex(
    app: &AppHandle,
    state: &AppState,
    root: &Path,
) -> CmdResult<LibraryInfo> {
    let info = state::open(
        state,
        root,
        OpenOptions {
            allow_read_only: false,
            app_data_dir: app_data_dir(app)?,
            app: Some(app.clone()),
            app_version: app_version(),
        },
    )?;
    Ok(info)
}

/// 让编译器提醒我们这些类型确实被用到了（对外契约的一部分）。
#[allow(dead_code)]
fn _type_anchors(_: &GoalsFile, _: &LibraryManifest, _: &RelationsFile, _: &ScanIssue, _: &IndexHandle) {}
