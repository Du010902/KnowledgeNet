//! v2 文件格式的 JSON 模型与校验（冻结契约见 `docs/v2-contract.md` §1、§3.1）。
//!
//! 三条不能破的规则：
//!
//! 1. **未知字段原样保留**：每个模型都带 `#[serde(flatten)] extra`，旧版本改写文件时
//!    不得抹掉别人（或以后版本的自己）写进去的扩展字段。
//! 2. **路径不是身份**：`node.json` 里不写目录路径，路径是扫描结果。
//! 3. **错误码可区分**：`metadata_invalid`（JSON 坏了 / 必填字段类型不对）与
//!    `metadata_unsupported`（format 或 formatVersion 不是本实现支持的版本）必须分开，
//!    否则界面没法告诉用户「是文件坏了」还是「需要升级 App」。
//!
//! 解析一律分两步：先把文本解析成 `serde_json::Value` 读出 `format` / `formatVersion`，
//! 再反序列化成具体模型。这样 `{"format":"other-tool"}` 这种文件得到的是
//! `metadata_unsupported`，而不是因为缺字段被判成「坏 JSON」。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};

use crate::models::{code, CmdError, CmdResult, LearnStatus};

/* --------------------------------- 常量 --------------------------------- */

pub const LIBRARY_FORMAT: &str = "knowledgenet-library";
pub const LIBRARY_FORMAT_VERSION: i64 = 2;
pub const NODE_FORMAT: &str = "knowledgenet-node";
pub const NODE_FORMAT_VERSION: i64 = 1;
pub const RELATIONS_FORMAT: &str = "knowledgenet-relations";
pub const RELATIONS_FORMAT_VERSION: i64 = 1;
pub const RESOURCES_FORMAT: &str = "knowledgenet-resources";
pub const RESOURCES_FORMAT_VERSION: i64 = 1;
pub const BOOKMARKS_FORMAT: &str = "knowledgenet-bookmarks";
pub const BOOKMARKS_FORMAT_VERSION: i64 = 1;
pub const GOALS_FORMAT: &str = "knowledgenet-goals";
pub const GOALS_FORMAT_VERSION: i64 = 1;
pub const THREAD_FORMAT: &str = "knowledgenet-chat-thread";
pub const THREAD_FORMAT_VERSION: i64 = 1;
pub const MESSAGE_FORMAT: &str = "knowledgenet-chat-message";
pub const MESSAGE_FORMAT_VERSION: i64 = 1;

/// 节点元数据的命名空间目录（相对节点文件夹）：`.meta/knowledgenet`
pub const NS_RELATIVE: &str = ".meta/knowledgenet";

pub const STATUS_TODO: &str = "todo";
pub const STATUS_LEARNING: &str = "learning";
pub const STATUS_DONE: &str = "done";

/* -------------------------------- 状态解析 -------------------------------- */

/// 学习状态宽松反序列化。
///
/// `status` 写错一个字母不应该让整个节点从图谱里消失——那不是「节点身份无效」，
/// 只是一处笔误。未知取值落到 `todo`，与设计文档「校验、报告、保留，而不是拒绝」一致。
fn de_status<'de, D: Deserializer<'de>>(deserializer: D) -> Result<LearnStatus, D::Error> {
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match raw {
        Some(serde_json::Value::String(s)) => match s.as_str() {
            STATUS_LEARNING => LearnStatus::Learning,
            STATUS_DONE => LearnStatus::Done,
            _ => LearnStatus::Todo,
        },
        _ => LearnStatus::Todo,
    })
}

/* -------------------------------- 解析工具 -------------------------------- */

/// 支持「两阶段解析」的模型：先看 format 头，再反序列化，最后做业务校验。
pub trait Validate {
    fn validate_typed(&self) -> CmdResult<()>;
}

pub fn empty_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

fn json_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// 阶段一：读 `format` / `formatVersion`，判断这是不是本实现认识的文件。
pub fn check_format_header(
    text: &str,
    expected_format: &str,
    expected_version: i64,
    what: &str,
    relative_path: Option<&str>,
) -> CmdResult<()> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| {
        metadata_invalid(what, relative_path, format!("JSON 解析失败：{e}"))
    })?;
    let object = value.as_object().ok_or_else(|| {
        metadata_invalid(what, relative_path, "顶层不是一个 JSON 对象".to_string())
    })?;

    match object.get("format") {
        Some(serde_json::Value::String(found)) if found == expected_format => {}
        Some(other) => {
            return Err(metadata_unsupported(
                what,
                relative_path,
                format!(
                    "format 是 {}（{}），本实现只认 {}",
                    json_kind(other),
                    other.as_str().unwrap_or("非字符串"),
                    expected_format
                ),
            ))
        }
        None => {
            return Err(metadata_invalid(
                what,
                relative_path,
                "缺少 format 字段".to_string(),
            ))
        }
    }

    match object.get("formatVersion") {
        Some(serde_json::Value::Number(n)) if n.as_i64() == Some(expected_version) => {}
        Some(other) => {
            return Err(metadata_unsupported(
                what,
                relative_path,
                format!(
                    "formatVersion 是 {}，本实现只支持 {}",
                    other, expected_version
                ),
            ))
        }
        None => {
            return Err(metadata_invalid(
                what,
                relative_path,
                "缺少 formatVersion 字段".to_string(),
            ))
        }
    }
    Ok(())
}

/// 阶段二：反序列化并做业务校验。
pub fn parse_typed<T: DeserializeOwned + Validate>(
    text: &str,
    expected_format: &str,
    expected_version: i64,
    what: &str,
    relative_path: Option<&str>,
) -> CmdResult<T> {
    check_format_header(text, expected_format, expected_version, what, relative_path)?;
    let value: T = serde_json::from_str(text).map_err(|e| {
        metadata_invalid(what, relative_path, format!("字段校验失败：{e}"))
    })?;
    value.validate_typed().map_err(|e| {
        metadata_invalid(what, relative_path, e.message)
    })?;
    Ok(value)
}

pub fn metadata_invalid(what: &str, relative_path: Option<&str>, detail: String) -> CmdError {
    let mut err = CmdError::new(code::METADATA_INVALID, format!("{what} 不合法：{detail}"));
    let mut payload = serde_json::Map::new();
    payload.insert("what".into(), serde_json::Value::String(what.to_string()));
    if let Some(p) = relative_path {
        payload.insert("relativePath".into(), serde_json::Value::String(p.to_string()));
    }
    payload.insert("detail".into(), serde_json::Value::String(detail));
    err.detail = Some(serde_json::Value::Object(payload));
    err
}

pub fn metadata_unsupported(what: &str, relative_path: Option<&str>, detail: String) -> CmdError {
    let mut err = CmdError::new(
        code::METADATA_UNSUPPORTED,
        format!("{what} 的格式版本不受支持：{detail}"),
    );
    let mut payload = serde_json::Map::new();
    payload.insert("what".into(), serde_json::Value::String(what.to_string()));
    if let Some(p) = relative_path {
        payload.insert("relativePath".into(), serde_json::Value::String(p.to_string()));
    }
    payload.insert("detail".into(), serde_json::Value::String(detail));
    err.detail = Some(serde_json::Value::Object(payload));
    err
}

/* -------------------------------- 时间工具 -------------------------------- */

pub fn parse_iso_ms(raw: &str) -> CmdResult<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.timestamp_millis())
        .map_err(|e| CmdError::invalid(format!("时间戳不是合法的 ISO 8601：{raw}（{e}）")))
}

/// 容错版：用于扫描阶段把 ISO 时间转成前端用的毫秒数，解析不了就返回 0。
pub fn iso_to_ms_lossy(raw: &str) -> i64 {
    parse_iso_ms(raw).unwrap_or(0)
}

/// 毫秒 → ISO 8601 UTC。命令层把前端的毫秒数翻回磁盘格式时用。
pub fn iso_from_ms(ms: i64) -> String {
    crate::paths::iso_from_ms(ms)
}

/* ------------------------------ library.json ------------------------------ */

fn default_true() -> bool {
    // 设计文档 §4.2：默认**不**跟随符号链接
    true
}

fn default_new_node_parent() -> String {
    "Nodes".to_string()
}

fn default_exclude() -> Vec<String> {
    vec![
        ".git".to_string(),
        "node_modules".to_string(),
        ".knowledgenet".to_string(),
        "**/.meta/knowledgenet".to_string(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanConfig {
    #[serde(default = "default_exclude")]
    pub exclude: Vec<String>,
    /// 保留字段：契约固定为 false，这里只做反序列化（永远不跟随链接）
    #[serde(default = "default_true")]
    pub follow_symlinks: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            exclude: default_exclude(),
            follow_symlinks: false,
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDefaults {
    #[serde(default = "default_new_node_parent")]
    pub new_node_parent: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for LibraryDefaults {
    fn default() -> Self {
        Self {
            new_node_parent: default_new_node_parent(),
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryManifest {
    pub format: String,
    pub format_version: i64,
    pub library_id: String,
    pub title: String,
    pub created_at: String,
    #[serde(default)]
    pub scan: ScanConfig,
    #[serde(default)]
    pub defaults: LibraryDefaults,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl LibraryManifest {
    pub fn new(library_id: String, title: String, created_at: String) -> Self {
        Self {
            format: LIBRARY_FORMAT.to_string(),
            format_version: LIBRARY_FORMAT_VERSION,
            library_id,
            title,
            created_at,
            scan: ScanConfig::default(),
            defaults: LibraryDefaults::default(),
            extra: serde_json::Map::new(),
        }
    }

    /// 新建节点时默认落在哪个目录（可能是多层，例如 `Nodes/数学`）
    pub fn new_node_parent(&self) -> &str {
        let raw = self.defaults.new_node_parent.trim();
        if raw.is_empty() {
            "Nodes"
        } else {
            raw
        }
    }

    /// 扫描时要整体跳过的目录名（`**/.meta/knowledgenet` 这类通配条目由扫描器单独处理）
    pub fn excluded_names(&self) -> Vec<String> {
        self.scan
            .exclude
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && !s.contains('/') && !s.contains('*'))
            .collect()
    }
}

impl Validate for LibraryManifest {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.library_id) {
            return Err(CmdError::invalid(format!(
                "libraryId 不是合法的 UUID：{}",
                self.library_id
            )));
        }
        Ok(())
    }
}

/* --------------------------------- node.json -------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeMeta {
    pub format: String,
    pub format_version: i64,
    pub id: String,
    #[serde(default)]
    pub revision: i64,
    pub title: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default, deserialize_with = "de_status")]
    pub status: LearnStatus,
    #[serde(default)]
    pub primary_document: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "empty_object")]
    pub extensions: serde_json::Value,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl NodeMeta {
    pub fn new(id: String, title: String, now: String) -> Self {
        Self {
            format: NODE_FORMAT.to_string(),
            format_version: NODE_FORMAT_VERSION,
            id,
            revision: 1,
            title,
            aliases: Vec::new(),
            status: LearnStatus::Todo,
            primary_document: None,
            created_at: now.clone(),
            updated_at: now,
            extensions: empty_object(),
            extra: serde_json::Map::new(),
        }
    }

    pub fn bump(&mut self, now: String) {
        self.revision += 1;
        self.updated_at = now;
    }
}

impl Validate for NodeMeta {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("id 不是合法的 UUID：{}", self.id)));
        }
        if self.title.trim().is_empty() {
            return Err(CmdError::invalid("title 不能为空"));
        }
        parse_iso_ms(&self.created_at)
            .map_err(|_| CmdError::invalid(format!("createdAt 不是 ISO 8601：{}", self.created_at)))?;
        parse_iso_ms(&self.updated_at)
            .map_err(|_| CmdError::invalid(format!("updatedAt 不是 ISO 8601：{}", self.updated_at)))?;
        if let Some(doc) = &self.primary_document {
            validate_primary_document(doc)?;
        }
        Ok(())
    }
}

/// `primaryDocument` 只能是节点目录内的规范化相对路径：不允许绝对路径、盘符、`..`。
pub fn validate_primary_document(raw: &str) -> CmdResult<String> {
    let cleaned = crate::paths::validate_relative_path(raw)?;
    if cleaned.starts_with(".meta/") || cleaned == ".meta" {
        return Err(CmdError::invalid(
            "primaryDocument 不能指向节点元数据目录 .meta/".to_string(),
        ));
    }
    Ok(cleaned)
}

/* ------------------------------ relations.json ----------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub question: String,
    pub created_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Evidence {
    pub fn new(now: String) -> Self {
        Self {
            id: crate::paths::new_id(),
            thread_id: None,
            message_id: None,
            snippet: String::new(),
            question: String::new(),
            created_at: now,
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for Evidence {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("evidence.id 不是 UUID：{}", self.id)));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelationEdge {
    pub id: String,
    pub to_node_id: String,
    #[serde(rename = "type", default = "default_relation_type")]
    pub type_: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub to_title_snapshot: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_relation_type() -> String {
    "prerequisite".to_string()
}

impl RelationEdge {
    pub fn new(to_node_id: String, to_title_snapshot: String, now: String) -> Self {
        Self {
            id: crate::paths::new_id(),
            to_node_id,
            type_: default_relation_type(),
            description: String::new(),
            to_title_snapshot,
            created_at: now.clone(),
            updated_at: now,
            evidence: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for RelationEdge {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("outgoing[].id 不是 UUID：{}", self.id)));
        }
        if !crate::paths::is_uuid(&self.to_node_id) {
            return Err(CmdError::invalid(format!(
                "outgoing[].toNodeId 不是 UUID：{}",
                self.to_node_id
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelationsFile {
    pub format: String,
    pub format_version: i64,
    pub node_id: String,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub outgoing: Vec<RelationEdge>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl RelationsFile {
    pub fn empty(node_id: String) -> Self {
        Self {
            format: RELATIONS_FORMAT.to_string(),
            format_version: RELATIONS_FORMAT_VERSION,
            node_id,
            revision: 1,
            outgoing: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for RelationsFile {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.node_id) {
            return Err(CmdError::invalid(format!(
                "relations.nodeId 不是 UUID：{}",
                self.node_id
            )));
        }
        for edge in &self.outgoing {
            edge.validate_typed()?;
        }
        Ok(())
    }
}

/* ------------------------------ resources.json ----------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEntry {
    pub id: String,
    /// `file` | `url` | `citation`
    pub kind: String,
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
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
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Validate for ResourceEntry {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("entries[].id 不是 UUID：{}", self.id)));
        }
        match self.kind.as_str() {
            "file" => {
                let rel = self.relative_path.as_deref().ok_or_else(|| {
                    CmdError::invalid("kind=file 的资源必须有 relativePath".to_string())
                })?;
                crate::paths::validate_relative_path(rel)?;
            }
            "url" => {
                if self.url.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(CmdError::invalid("kind=url 的资源必须有 url".to_string()));
                }
            }
            "citation" => {}
            other => {
                return Err(CmdError::invalid(format!("未知的 kind：{other}")));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesFile {
    pub format: String,
    pub format_version: i64,
    pub node_id: String,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub entries: Vec<ResourceEntry>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ResourcesFile {
    pub fn empty(node_id: String) -> Self {
        Self {
            format: RESOURCES_FORMAT.to_string(),
            format_version: RESOURCES_FORMAT_VERSION,
            node_id,
            revision: 1,
            entries: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for ResourcesFile {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.node_id) {
            return Err(CmdError::invalid(format!(
                "resources.nodeId 不是 UUID：{}",
                self.node_id
            )));
        }
        for entry in &self.entries {
            entry.validate_typed()?;
        }
        Ok(())
    }
}

/* ------------------------------ bookmarks.json ----------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkEntry {
    pub id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub scroll_offset: f64,
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub return_node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Validate for BookmarkEntry {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("bookmarks[].id 不是 UUID：{}", self.id)));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarksFile {
    pub format: String,
    pub format_version: i64,
    pub node_id: String,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub bookmarks: Vec<BookmarkEntry>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl BookmarksFile {
    pub fn empty(node_id: String) -> Self {
        Self {
            format: BOOKMARKS_FORMAT.to_string(),
            format_version: BOOKMARKS_FORMAT_VERSION,
            node_id,
            revision: 1,
            bookmarks: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for BookmarksFile {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.node_id) {
            return Err(CmdError::invalid(format!(
                "bookmarks.nodeId 不是 UUID：{}",
                self.node_id
            )));
        }
        for entry in &self.bookmarks {
            entry.validate_typed()?;
        }
        Ok(())
    }
}

/* -------------------------------- goals.json ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GoalEntry {
    pub id: String,
    pub title: String,
    pub root_node_id: String,
    pub created_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Validate for GoalEntry {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("goals[].id 不是 UUID：{}", self.id)));
        }
        if !crate::paths::is_uuid(&self.root_node_id) {
            return Err(CmdError::invalid(format!(
                "goals[].rootNodeId 不是 UUID：{}",
                self.root_node_id
            )));
        }
        if self.title.trim().is_empty() {
            return Err(CmdError::invalid("goals[].title 不能为空"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GoalsFile {
    pub format: String,
    pub format_version: i64,
    pub library_id: String,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub goals: Vec<GoalEntry>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl GoalsFile {
    pub fn empty(library_id: String) -> Self {
        Self {
            format: GOALS_FORMAT.to_string(),
            format_version: GOALS_FORMAT_VERSION,
            library_id,
            revision: 1,
            goals: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for GoalsFile {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.library_id) {
            return Err(CmdError::invalid(format!(
                "goals.libraryId 不是 UUID：{}",
                self.library_id
            )));
        }
        for goal in &self.goals {
            goal.validate_typed()?;
        }
        Ok(())
    }
}

/* -------------------------------- thread.json ------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadFile {
    pub format: String,
    pub format_version: i64,
    pub id: String,
    pub node_id: String,
    #[serde(default)]
    pub revision: i64,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ThreadFile {
    pub fn new(node_id: String, title: String, now: String) -> Self {
        Self {
            format: THREAD_FORMAT.to_string(),
            format_version: THREAD_FORMAT_VERSION,
            id: crate::paths::new_id(),
            node_id,
            revision: 1,
            title,
            summary: String::new(),
            created_at: now.clone(),
            updated_at: now,
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for ThreadFile {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("thread.id 不是 UUID：{}", self.id)));
        }
        if !crate::paths::is_uuid(&self.node_id) {
            return Err(CmdError::invalid(format!(
                "thread.nodeId 不是 UUID：{}",
                self.node_id
            )));
        }
        if self.title.trim().is_empty() {
            return Err(CmdError::invalid("thread.title 不能为空"));
        }
        Ok(())
    }
}

/* ------------------------------- 消息文件 ------------------------------- */

/// 消息生成状态。`streaming` 是「正在写」的中间态，重启后必须转成 `incomplete`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Streaming,
    Complete,
    Stopped,
    Error,
    Incomplete,
}

impl MessageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageStatus::Streaming => "streaming",
            MessageStatus::Complete => "complete",
            MessageStatus::Stopped => "stopped",
            MessageStatus::Error => "error",
            MessageStatus::Incomplete => "incomplete",
        }
    }
}

impl Default for MessageStatus {
    fn default() -> Self {
        MessageStatus::Complete
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageFile {
    pub format: String,
    pub format_version: i64,
    pub id: String,
    pub thread_id: String,
    pub sequence: i64,
    /// `user` | `assistant` | `system`
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub status: MessageStatus,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub usage: Option<serde_json::Value>,
    #[serde(default)]
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl MessageFile {
    pub fn new(thread_id: String, sequence: i64, role: &str, content: String, now: String) -> Self {
        Self {
            format: MESSAGE_FORMAT.to_string(),
            format_version: MESSAGE_FORMAT_VERSION,
            id: crate::paths::new_id(),
            thread_id,
            sequence,
            role: role.to_string(),
            content,
            status: MessageStatus::Complete,
            finish_reason: None,
            request_id: None,
            usage: None,
            model: None,
            created_at: now.clone(),
            updated_at: now,
            extra: serde_json::Map::new(),
        }
    }
}

impl Validate for MessageFile {
    fn validate_typed(&self) -> CmdResult<()> {
        if !crate::paths::is_uuid(&self.id) {
            return Err(CmdError::invalid(format!("message.id 不是 UUID：{}", self.id)));
        }
        if !crate::paths::is_uuid(&self.thread_id) {
            return Err(CmdError::invalid(format!(
                "message.threadId 不是 UUID：{}",
                self.thread_id
            )));
        }
        if self.sequence < 1 {
            return Err(CmdError::invalid(format!(
                "message.sequence 必须 >= 1：{}",
                self.sequence
            )));
        }
        match self.role.as_str() {
            "user" | "assistant" | "system" => {}
            other => return Err(CmdError::invalid(format!("未知的 role：{other}"))),
        }
        Ok(())
    }
}

/* ---------------------------------- 测试 ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn node_json(extra: &str) -> String {
        format!(
            r#"{{
              "format": "knowledgenet-node",
              "formatVersion": 1,
              "id": "0199aaaa-0000-7000-8000-000000000001",
              "revision": 3,
              "title": "注意力机制",
              "aliases": ["Attention"],
              "status": "learning",
              "primaryDocument": "note.md",
              "createdAt": "2026-09-20T10:00:00.000Z",
              "updatedAt": "2026-09-20T10:20:00.000Z",
              "extensions": {{}},
              "futureField": {{"keep": [1, 2, 3]}}{extra}
            }}"#
        )
    }

    #[test]
    fn node_unknown_fields_are_preserved() {
        let text = node_json(", \"anotherFuture\": \"值\"");
        let meta: NodeMeta = parse_typed(
            &text,
            NODE_FORMAT,
            NODE_FORMAT_VERSION,
            "node.json",
            Some("Nodes/A/.meta/knowledgenet/node.json"),
        )
        .expect("应能解析");
        assert_eq!(meta.title, "注意力机制");
        assert_eq!(meta.status, LearnStatus::Learning);
        assert!(meta.extra.contains_key("futureField"));
        assert!(meta.extra.contains_key("anotherFuture"));

        let round_trip = serde_json::to_string(&meta).expect("应能序列化");
        let value: serde_json::Value = serde_json::from_str(&round_trip).unwrap();
        assert!(value.get("futureField").is_some(), "未知字段不能被抹掉");
        assert!(value.get("anotherFuture").is_some(), "未知字段不能被抹掉");
    }

    #[test]
    fn node_missing_title_is_metadata_invalid() {
        let text = r#"{"format":"knowledgenet-node","formatVersion":1,"id":"0199aaaa-0000-7000-8000-000000000001"}"#;
        let err = parse_typed::<NodeMeta>(text, NODE_FORMAT, NODE_FORMAT_VERSION, "node.json", None)
            .expect_err("缺字段必须失败");
        assert_eq!(err.code, code::METADATA_INVALID);
    }

    #[test]
    fn wrong_format_is_metadata_unsupported() {
        let text = r#"{"format":"other-tool-node","formatVersion":1,"id":"0199cccc-0000-7000-8000-0000000000f1","title":"x"}"#;
        let err = parse_typed::<NodeMeta>(text, NODE_FORMAT, NODE_FORMAT_VERSION, "node.json", None)
            .expect_err("别的格式必须拒绝");
        assert_eq!(err.code, code::METADATA_UNSUPPORTED);
    }

    #[test]
    fn future_version_is_metadata_unsupported() {
        let text = node_json("").replace("\"formatVersion\": 1", "\"formatVersion\": 99");
        let err = parse_typed::<NodeMeta>(&text, NODE_FORMAT, NODE_FORMAT_VERSION, "node.json", None)
            .expect_err("高版本必须拒绝");
        assert_eq!(err.code, code::METADATA_UNSUPPORTED);
    }

    #[test]
    fn broken_json_is_metadata_invalid() {
        let err = parse_typed::<NodeMeta>("{ this is not json", NODE_FORMAT, NODE_FORMAT_VERSION, "node.json", None)
            .expect_err("坏 JSON 必须失败");
        assert_eq!(err.code, code::METADATA_INVALID);
    }

    #[test]
    fn non_uuid_id_is_metadata_invalid() {
        let text = node_json("").replace(
            "0199aaaa-0000-7000-8000-000000000001",
            "not-a-uuid",
        );
        let err = parse_typed::<NodeMeta>(&text, NODE_FORMAT, NODE_FORMAT_VERSION, "node.json", None)
            .expect_err("ID 形状不对必须失败");
        assert_eq!(err.code, code::METADATA_INVALID);
    }

    #[test]
    fn unknown_status_falls_back_to_todo() {
        let text = node_json("").replace("\"status\": \"learning\"", "\"status\": \"studying\"");
        let meta: NodeMeta =
            parse_typed(&text, NODE_FORMAT, NODE_FORMAT_VERSION, "node.json", None).unwrap();
        assert_eq!(meta.status, LearnStatus::Todo);
    }

    #[test]
    fn primary_document_rejects_escape() {
        assert!(validate_primary_document("../outside.md").is_err());
        assert!(validate_primary_document("C:/abs.md").is_err());
        assert!(validate_primary_document(".meta/knowledgenet/node.json").is_err());
        assert_eq!(validate_primary_document("docs/note.md").unwrap(), "docs/note.md");
    }

    #[test]
    fn relations_round_trip_keeps_unknown_fields() {
        let text = r#"{
          "format": "knowledgenet-relations",
          "formatVersion": 1,
          "nodeId": "0199eeee-0000-7000-8000-000000000001",
          "revision": 2,
          "outgoing": [
            {
              "id": "0199eeee-0000-7000-8000-0000000000e1",
              "toNodeId": "0199eeee-0000-7000-8000-0000000000ff",
              "type": "prerequisite",
              "description": "理解它需要先理解向量点积",
              "toTitleSnapshot": "向量点积",
              "createdAt": "2026-09-20T10:00:00.000Z",
              "updatedAt": "2026-09-20T10:00:00.000Z",
              "evidence": [],
              "customWeight": 0.75
            }
          ],
          "libraryHint": "keep-me"
        }"#;
        let file: RelationsFile = parse_typed(
            text,
            RELATIONS_FORMAT,
            RELATIONS_FORMAT_VERSION,
            "relations.json",
            None,
        )
        .unwrap();
        assert_eq!(file.outgoing.len(), 1);
        assert!(file.outgoing[0].extra.contains_key("customWeight"));
        assert!(file.extra.contains_key("libraryHint"));
    }

    #[test]
    fn library_manifest_defaults_are_applied() {
        let text = r#"{
          "format": "knowledgenet-library",
          "formatVersion": 2,
          "libraryId": "01990000-0000-7000-8000-000000000001",
          "title": "我的知识库",
          "createdAt": "2026-09-20T10:00:00.000Z"
        }"#;
        let manifest: LibraryManifest = parse_typed(
            text,
            LIBRARY_FORMAT,
            LIBRARY_FORMAT_VERSION,
            "library.json",
            None,
        )
        .unwrap();
        assert_eq!(manifest.new_node_parent(), "Nodes");
        assert!(!manifest.scan.follow_symlinks);
        assert!(manifest.excluded_names().contains(&".git".to_string()));
    }

    #[test]
    fn thread_and_message_validate() {
        let thread = ThreadFile {
            format: THREAD_FORMAT.to_string(),
            format_version: 1,
            id: "not-a-uuid".to_string(),
            node_id: "0199ffff-0000-7000-8000-000000000001".to_string(),
            revision: 1,
            title: "数学推导".to_string(),
            summary: String::new(),
            created_at: "2026-09-20T10:00:00.000Z".to_string(),
            updated_at: "2026-09-20T10:00:00.000Z".to_string(),
            extra: serde_json::Map::new(),
        };
        assert!(thread.validate_typed().is_err());

        let message = MessageFile::new(
            "0199ffff-0000-7000-8000-0000000000aa".to_string(),
            1,
            "user",
            "你好".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        );
        assert!(message.validate_typed().is_ok());

        let mut bad = message.clone();
        bad.role = "robot".to_string();
        assert!(bad.validate_typed().is_err());
    }
}
