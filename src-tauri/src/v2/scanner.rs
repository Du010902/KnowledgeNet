//! 递归扫描知识库目录：发现节点、处理边界、报告问题。实现者：rust-scan-index。
//!
//! 契约 `docs/v2-contract.md` §3.4。扫描器的职责只有一个：
//! **把「磁盘上的文件夹」翻译成一份完整、可复现的图快照**，并且永不因为一棵子树坏掉
//! 就放弃整次扫描。它不写任何文件、不改任何元数据、不读消息正文。
//!
//! 几条不能破的规则：
//!
//! 1. **节点只认精确路径** `.meta/knowledgenet/node.json`。只有 `.meta` 或者
//!    `.meta/别的软件/` 的目录不是节点，也**不产生任何问题**——那是别人的地盘。
//! 2. **不跟随符号链接 / junction / reparse point**：链接可能指回根目录形成死循环，
//!    也可能把整块盘拖进一次扫描。
//! 3. **嵌套节点边界**：一个目录里的普通文件归**最近的**那个节点。父节点的资源枚举
//!    必须能排除子节点子树，所以每个节点都记下 `nested_node_paths`。
//! 4. **碰见另一个 `library.json` 就停**：那是别人的知识库，扫进去会把两个库混成一个。
//! 5. **坏元数据是「问题」不是「失败」**：坏掉的节点进不了 `nodes`，其余节点照常可用。
//! 6. **重复 node id 两份都留**：不按扫描顺序偷偷选一个，交给用户决定（设计 §5.4）。
//! 7. **dangling 边保留**：目标缺失只标记不删除，否则用户一移动文件夹就丢关系。
//!
//! 时间字段一律保留磁盘上的 ISO 8601 字符串，毫秒换算留给命令层
//! （`KnowledgeNode.createdAt` 是毫秒，磁盘是 ISO 字符串）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::models::{code, CmdError, CmdResult, LearnStatus};

use super::atomic;
use super::schema::{
    Evidence, GoalEntry, GoalsFile, LibraryManifest, NodeMeta, RelationsFile, ThreadFile,
    GOALS_FORMAT, GOALS_FORMAT_VERSION, NODE_FORMAT, NODE_FORMAT_VERSION, RELATIONS_FORMAT,
    RELATIONS_FORMAT_VERSION, THREAD_FORMAT, THREAD_FORMAT_VERSION,
};
use super::vpaths;

/* --------------------------------- 常量 --------------------------------- */

/// 关系目标不在本次扫描结果里的问题码。
///
/// 它只出现在 `ScanIssue.code` 上，不是 `CmdError`（`crate::models::code` 里没有对应项，
/// 而本模块不允许修改那个文件）。见 `docs/v2-deviations.md`。
pub const DANGLING_RELATION: &str = "dangling_relation";

/// 固定排除的目录名：无论 `library.json` 怎么写都不扫。
pub const FIXED_EXCLUDED_NAMES: [&str; 3] = [".git", "node_modules", ".knowledgenet"];

/// `node.json` 的 `health` 取值（契约 §5.1 的 `NodeHealth`）。
pub mod health {
    pub const OK: &str = "ok";
    pub const METADATA_INVALID: &str = "metadata_invalid";
    pub const METADATA_UNSUPPORTED: &str = "metadata_unsupported";
    pub const DUPLICATE_ID: &str = "duplicate_id";
}

/// 问题严重度
pub mod severity {
    pub const ERROR: &str = "error";
    pub const WARNING: &str = "warning";
    pub const INFO: &str = "info";
}

/* --------------------------------- 模型 --------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    /// 全量扫描。当前实现总是完整遍历目录树（增量由设备索引负责），
    /// 这个标志只决定报告里 `full` 的值与调用方的语义。
    pub full: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self { full: true }
    }
}

/// 扫描中发现的一条问题。`code` 与前端 `src/data/errors.ts` 同表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub code: String,
    /// `error` | `warning` | `info`
    pub severity: String,
    pub relative_path: Option<String>,
    pub node_id: Option<String>,
    pub detail: String,
    /// 可选的解析位置（JSON 行/列、字段名），只用于向用户解释「坏在哪」
    pub parse_position: Option<String>,
}

impl ScanIssue {
    pub fn new(code: &str, severity: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            severity: severity.to_string(),
            relative_path: None,
            node_id: None,
            detail: detail.into(),
            parse_position: None,
        }
    }

    pub fn with_path(mut self, relative_path: impl Into<String>) -> Self {
        self.relative_path = Some(relative_path.into());
        self
    }

    pub fn with_node(mut self, node_id: impl Into<String>) -> Self {
        self.node_id = Some(node_id.into());
        self
    }

    pub fn is_error(&self) -> bool {
        self.severity == severity::ERROR
    }
}

/// 一次扫描发现的节点。**路径不是身份**：`relative_path` 是扫描结果，
/// `id` 才是身份；文件夹改名/移动后 `id` 不变。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedNode {
    pub id: String,
    /// 相对知识库根的正斜杠路径；根目录本身是节点时为空串
    pub relative_path: String,
    pub folder_name: String,
    pub title: String,
    pub aliases: Vec<String>,
    pub status: LearnStatus,
    pub primary_document: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    /// `ok` | `metadata_invalid` | `metadata_unsupported` | `duplicate_id`
    pub health: String,
    pub meta_sha256: String,
    pub meta_bytes: i64,
    pub meta_modified_ms: i64,
    /// 相对知识库根的层级；根目录节点为 0
    pub depth: i64,
    /// **最近的**节点子目录（相对知识库根，正斜杠，已排序）。
    ///
    /// `resources::list_plain_files` 用它排除子节点子树：一个目录里的普通文件
    /// 归最近的那个节点，父节点不得把子节点的文件算成自己的资源（§3.4）。
    /// 契约 §3.4 的 `ScannedNode` 没有这个字段，是本实现的补充，
    /// 见 `docs/v2-deviations.md`。
    #[serde(default)]
    pub nested_node_paths: Vec<String>,
}

impl ScannedNode {
    pub fn is_healthy(&self) -> bool {
        self.health == health::OK
    }

    pub fn is_root(&self) -> bool {
        self.relative_path.is_empty()
    }
}

/// 一条出边。归属**源节点**，来源是该节点目录里的 `relations.json`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedEdge {
    pub id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    /// 人类可读的「为什么 from 需要 to」；与 `description` 同值，
    /// 保留两个名字是为了兼容前端既有的 `DependencyEdge.relation`。
    pub relation: String,
    pub relation_type: String,
    pub description: String,
    pub to_title_snapshot: String,
    pub created_at: String,
    pub updated_at: String,
    /// 源节点的相对路径（出边存在源节点目录里）
    pub from_relative_path: String,
    /// 目标节点不在本次扫描结果里。**保留这条边**，不自动删除（设计 §5.4）。
    pub dangling: bool,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

/// 一个对话线程的头部摘要。扫描**只读线程头**，不读任何消息正文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedThread {
    pub id: String,
    pub node_id: String,
    pub title: String,
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    /// 由 `messages/` 下的**文件名**数出来（`parse_message_file_name` 校验），
    /// 不打开任何消息文件。
    pub message_count: i64,
    pub node_relative_path: String,
}

/// 同一知识库里出现相同 node id 的一组副本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateIdGroup {
    pub node_id: String,
    pub relative_paths: Vec<String>,
}

/// 一次扫描的完整结果。`duration_ms` / `scanned_dirs` 是诊断信息，
/// 也是「扫描是不是变慢了」的唯一可见证据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub full: bool,
    pub duration_ms: i64,
    pub scanned_dirs: i64,
    pub nodes: Vec<ScannedNode>,
    pub edges: Vec<ScannedEdge>,
    pub threads: Vec<ScannedThread>,
    pub issues: Vec<ScanIssue>,
    pub duplicate_ids: Vec<DuplicateIdGroup>,
    pub root_is_node: bool,
    pub goals: Vec<GoalEntry>,
    /// 有目录读不出来（权限、被占用）时为 true：报告是完整的意图，但不是完整的事实。
    pub truncated: bool,
}

impl ScanReport {
    pub fn error_count(&self) -> i64 {
        self.issues.iter().filter(|i| i.is_error()).count() as i64
    }

    pub fn node_by_path(&self, relative_path: &str) -> Option<&ScannedNode> {
        self.nodes.iter().find(|n| n.relative_path == relative_path)
    }

    pub fn node_by_id(&self, node_id: &str) -> Option<&ScannedNode> {
        self.nodes.iter().find(|n| n.id == node_id)
    }
}

/* --------------------------------- 入口 --------------------------------- */

/// 递归扫描知识库。
///
/// 只有**根目录读不出来**才返回 `Err`；子树读不出来记成 `warning` 问题并继续
/// （同时把 `truncated` 置为 true，让调用方知道报告不完整）。
pub fn scan_library(
    root: &Path,
    manifest: &LibraryManifest,
    opts: &ScanOptions,
) -> CmdResult<ScanReport> {
    let started = Instant::now();
    let root = canonical_root(root)?;
    let mut state = ScanState::new(&root, manifest, opts);
    state.walk()?;
    Ok(state.finish(started))
}

/// 读知识库级学习目标；文件不存在时返回空文件（不是错误）。
///
/// `libraryId` 从根目录的 `library.json` 里读；读不到时用空串
/// （`scan_library` 内部走的是持有清单的重载，不会出现这种情况）。
pub fn read_goals(root: &Path) -> CmdResult<GoalsFile> {
    let library_id = read_library_id_lossy(root).unwrap_or_default();
    Ok(load_goals(root, &library_id).0)
}

/// 与 [`read_goals`] 相同，但由调用方提供 `libraryId`，并把解析失败变成一条问题。
///
/// `goals.json` 坏掉**不能**挡住打开知识库：目标列表是附加信息，
/// 而节点与关系才是资产（§3.4）。
pub fn read_goals_with(root: &Path, library_id: &str) -> (GoalsFile, Vec<ScanIssue>) {
    load_goals(root, library_id)
}

/* ------------------------------- 目录枚举工具 ------------------------------ */

/// 节点目录里「归它自己」的普通文件（相对知识库根，正斜杠，已排序）。
///
/// 规则的唯一一份实现放在这里，供 `resources::list_plain_files` 与扫描器测试共用：
///
/// - 不进入 `.meta/**`（那是元数据，不是用户资产）；
/// - 不进入固定排除目录与 `library.json.scan.exclude` 里的目录；
/// - 不进入嵌套的另一个知识库（`library.json` 边界）；
/// - 不进入子节点子树（`node.nested_node_paths`），子节点的文件不是父节点的资源；
/// - 不跟随符号链接。
pub fn list_plain_files_of_node(
    root: &Path,
    node: &ScannedNode,
    exclude: &[String],
) -> CmdResult<Vec<String>> {
    let root = canonical_root(root)?;
    let base = if node.relative_path.is_empty() {
        root.clone()
    } else {
        root.join(node.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    let filter = DirFilter::new(exclude);
    let nested: BTreeSet<String> = node.nested_node_paths.iter().cloned().collect();
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![base];
    while let Some(dir) = stack.pop() {
        let entries = read_dir_sorted(&dir)?;
        for entry in entries {
            let path = entry.path();
            if crate::paths::is_link_like(&path) {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if filter.is_skipped_dir_name(&name) {
                    continue;
                }
                let child_rel = match vpaths::relative_path_string(&root, &path) {
                    Some(rel) => rel,
                    None => continue,
                };
                if nested.contains(&child_rel) || filter.matches_pattern(&child_rel) {
                    continue;
                }
                if is_nested_library(&path) {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                if let Some(rel) = vpaths::relative_path_string(&root, &path) {
                    out.push(rel);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/* ------------------------------- 扫描状态机 ------------------------------- */

struct ScanState<'a> {
    root: PathBuf,
    manifest: &'a LibraryManifest,
    opts: &'a ScanOptions,
    filter: DirFilter,
    nodes: Vec<ScannedNode>,
    edges: Vec<ScannedEdge>,
    threads: Vec<ScannedThread>,
    issues: Vec<ScanIssue>,
    scanned_dirs: i64,
    truncated: bool,
}

impl<'a> ScanState<'a> {
    fn new(root: &Path, manifest: &'a LibraryManifest, opts: &'a ScanOptions) -> Self {
        Self {
            root: root.to_path_buf(),
            manifest,
            opts,
            filter: DirFilter::new(&manifest.scan.exclude),
            nodes: Vec::new(),
            edges: Vec::new(),
            threads: Vec::new(),
            issues: Vec::new(),
            scanned_dirs: 0,
            truncated: false,
        }
    }

    /// 深度优先遍历。子目录先按名字排序再入栈，保证同一棵树永远产出同一份报告
    /// （`read_dir` 的顺序在各文件系统上并不稳定，而索引与测试都依赖确定性）。
    fn walk(&mut self) -> CmdResult<()> {
        let mut stack: Vec<(PathBuf, i64)> = vec![(self.root.clone(), 0)];
        let mut at_root = true;
        while let Some((dir, depth)) = stack.pop() {
            let entries = match read_dir_sorted(&dir) {
                Ok(entries) => entries,
                Err(err) => {
                    if at_root {
                        // 根目录读不出来 = 这不是一个能打开的知识库
                        return Err(err);
                    }
                    self.truncated = true;
                    let rel = vpaths::relative_path_string(&self.root, &dir);
                    let mut issue = ScanIssue::new(
                        code::IO,
                        severity::WARNING,
                        format!("目录读不出来，已跳过其中的内容：{}", err.message),
                    );
                    issue.relative_path = rel;
                    self.issues.push(issue);
                    continue;
                }
            };
            at_root = false;
            self.scanned_dirs += 1;

            let rel = match vpaths::relative_path_string(&self.root, &dir) {
                Some(rel) => rel,
                None => continue,
            };
            self.visit_node(&dir, &rel, depth);

            for entry in entries {
                let path = entry.path();
                if crate::paths::is_link_like(&path) {
                    // 链接可能是回环，也可能指向别人盘上的目录：一律不跟随
                    continue;
                }
                let file_type = match entry.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if !file_type.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                // `.meta` 属于元数据目录，里面的东西不是用户资产，永不当作节点或资源
                if self.filter.is_skipped_dir_name(&name) {
                    continue;
                }
                let child_rel = match vpaths::relative_path_string(&self.root, &path) {
                    Some(rel) => rel,
                    None => continue,
                };
                if self.filter.matches_pattern(&child_rel) {
                    continue;
                }
                if is_nested_library(&path) {
                    self.issues.push(
                        ScanIssue::new(
                            code::NESTED_LIBRARY_BOUNDARY,
                            severity::WARNING,
                            format!(
                                "{child_rel} 里还有另一个 library.json：那是别人的知识库，\
                                 本次扫描在这里停止向下（含整棵子树）"
                            ),
                        )
                        .with_path(&child_rel),
                    );
                    continue;
                }
                stack.push((path, depth + 1));
            }
        }
        Ok(())
    }

    /// 当前目录本身是不是节点：**只看精确路径** `.meta/knowledgenet/node.json`。
    fn visit_node(&mut self, dir: &Path, rel: &str, depth: i64) {
        let marker = vpaths::node_meta_file(dir);
        if !marker.is_file() || crate::paths::is_link_like(&marker) {
            return;
        }
        let marker_rel = join_rel(rel, vpaths::NODE_MARKER_RELATIVE);
        let (meta, fp) = match atomic::read_typed::<NodeMeta>(
            &marker,
            NODE_FORMAT,
            NODE_FORMAT_VERSION,
            "node.json",
            Some(&marker_rel),
        ) {
            Ok(pair) => pair,
            Err(err) => {
                // 坏元数据的文件夹不进 nodes，但它下面的子目录照常继续遍历：
                // 父目录的元数据坏了不代表子节点也坏了。
                self.issues
                    .push(issue_from_error(&err, &marker_rel, None, "node.json 无法解析"));
                return;
            }
        };

        self.nodes.push(ScannedNode {
            id: meta.id.clone(),
            relative_path: rel.to_string(),
            folder_name: folder_name(dir),
            title: meta.title,
            aliases: meta.aliases,
            status: meta.status,
            primary_document: meta.primary_document,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
            revision: meta.revision,
            health: health::OK.to_string(),
            meta_sha256: fp.sha256,
            meta_bytes: fp.bytes as i64,
            meta_modified_ms: fp.modified_ms,
            depth,
            nested_node_paths: Vec::new(),
        });

        self.read_relations(dir, rel, &meta.id);
        self.read_threads(dir, rel, &meta.id);
    }

    /// 出边归属源节点：`fromNodeId` 取该节点 `node.json` 的 id，而不是文件里的 nodeId。
    fn read_relations(&mut self, dir: &Path, rel: &str, node_id: &str) {
        let path = vpaths::relations_file(dir);
        let file_rel = join_rel(rel, ".meta/knowledgenet/relations.json");
        let file = match atomic::read_typed_opt::<RelationsFile>(
            &path,
            RELATIONS_FORMAT,
            RELATIONS_FORMAT_VERSION,
            "relations.json",
            Some(&file_rel),
        ) {
            Ok(Some((file, _fp))) => file,
            Ok(None) => return,
            Err(err) => {
                self.issues.push(issue_from_error(
                    &err,
                    &file_rel,
                    Some(node_id),
                    "relations.json 无法解析",
                ));
                return;
            }
        };

        if file.node_id != node_id {
            // 边写在哪就是谁的：以目录里的 node.json 为准，但要让用户看见不一致
            self.issues.push(
                ScanIssue::new(
                    code::METADATA_INVALID,
                    severity::WARNING,
                    format!(
                        "relations.json 的 nodeId（{}）与 node.json 的 id（{}）不一致；\
                         出边归属以 node.json 为准",
                        file.node_id, node_id
                    ),
                )
                .with_path(&file_rel)
                .with_node(node_id),
            );
        }

        for edge in file.outgoing {
            self.edges.push(ScannedEdge {
                id: edge.id,
                from_node_id: node_id.to_string(),
                to_node_id: edge.to_node_id,
                relation: edge.description.clone(),
                relation_type: edge.type_,
                description: edge.description,
                to_title_snapshot: edge.to_title_snapshot,
                created_at: edge.created_at,
                updated_at: edge.updated_at,
                from_relative_path: rel.to_string(),
                dangling: false,
                evidence: edge.evidence,
            });
        }
    }

    /// 只读线程头；消息条数靠数文件名。
    fn read_threads(&mut self, dir: &Path, rel: &str, node_id: &str) {
        let chats = vpaths::chats_dir(dir);
        if !chats.is_dir() {
            return;
        }
        let entries = match read_dir_sorted(&chats) {
            Ok(entries) => entries,
            Err(err) => {
                self.issues.push(issue_from_error(
                    &err,
                    &join_rel(rel, ".meta/knowledgenet/chats"),
                    Some(node_id),
                    "chats 目录读不出来",
                ));
                return;
            }
        };
        for entry in entries {
            let path = entry.path();
            if crate::paths::is_link_like(&path) {
                continue;
            }
            if !matches!(entry.file_type(), Ok(t) if t.is_dir()) {
                continue;
            }
            let thread_dir_name = entry.file_name().to_string_lossy().to_string();
            let thread_rel = join_rel(
                rel,
                &format!(".meta/knowledgenet/chats/{thread_dir_name}/thread.json"),
            );
            let thread_file = path.join(vpaths::THREAD_FILE);
            let thread = match atomic::read_typed_opt::<ThreadFile>(
                &thread_file,
                THREAD_FORMAT,
                THREAD_FORMAT_VERSION,
                "thread.json",
                Some(&thread_rel),
            ) {
                Ok(Some((thread, _fp))) => thread,
                Ok(None) => continue,
                Err(err) => {
                    self.issues.push(issue_from_error(
                        &err,
                        &thread_rel,
                        Some(node_id),
                        "thread.json 无法解析",
                    ));
                    continue;
                }
            };

            if thread.node_id != node_id {
                self.issues.push(
                    ScanIssue::new(
                        code::METADATA_INVALID,
                        severity::WARNING,
                        format!(
                            "thread.json 的 nodeId（{}）与所在节点 node.json 的 id（{}）不一致；\
                             线程归属以它所在的节点目录为准",
                            thread.node_id, node_id
                        ),
                    )
                    .with_path(&thread_rel)
                    .with_node(node_id),
                );
            }

            self.threads.push(ScannedThread {
                id: thread.id,
                node_id: node_id.to_string(),
                title: thread.title,
                summary: thread.summary,
                created_at: thread.created_at,
                updated_at: thread.updated_at,
                revision: thread.revision,
                message_count: count_messages(&path.join(vpaths::MESSAGES_DIR)),
                node_relative_path: rel.to_string(),
            });
        }
    }

    fn finish(mut self, started: Instant) -> ScanReport {
        /* 1. 嵌套节点边界：每个节点记下「最近的」节点子目录 */
        let paths: Vec<String> = self.nodes.iter().map(|n| n.relative_path.clone()).collect();
        let nested = compute_nested_node_paths(&paths);
        for node in self.nodes.iter_mut() {
            node.nested_node_paths = nested.get(&node.relative_path).cloned().unwrap_or_default();
        }

        /* 2. 重复 node id：两份都留，都标 duplicate_id */
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for node in &self.nodes {
            groups
                .entry(node.id.clone())
                .or_default()
                .push(node.relative_path.clone());
        }
        let mut duplicate_ids: Vec<DuplicateIdGroup> = Vec::new();
        let mut duplicated: BTreeSet<String> = BTreeSet::new();
        for (node_id, mut relative_paths) in groups {
            if relative_paths.len() < 2 {
                continue;
            }
            relative_paths.sort();
            duplicated.insert(node_id.clone());
            let mut issue = ScanIssue::new(
                code::DUPLICATE_NODE_ID,
                severity::ERROR,
                format!(
                    "同一知识库里有 {} 个文件夹写着同一个 node id：{}。\
                     两份都保留、都停写，等用户决定保留哪一个或给副本分配新 ID",
                    relative_paths.len(),
                    relative_paths.join("、")
                ),
            )
            .with_node(&node_id);
            issue.relative_path = relative_paths.first().cloned();
            self.issues.push(issue);
            duplicate_ids.push(DuplicateIdGroup {
                node_id,
                relative_paths,
            });
        }
        for node in self.nodes.iter_mut() {
            if duplicated.contains(&node.id) {
                node.health = health::DUPLICATE_ID.to_string();
            }
        }

        /* 3. dangling 边：目标不在本次扫描结果里就标记，绝不丢弃 */
        let known: BTreeSet<&str> = self.nodes.iter().map(|n| n.id.as_str()).collect();
        for edge in self.edges.iter_mut() {
            if known.contains(edge.to_node_id.as_str()) {
                continue;
            }
            edge.dangling = true;
            let label = if edge.to_title_snapshot.trim().is_empty() {
                edge.to_node_id.clone()
            } else {
                format!("{}（{}）", edge.to_title_snapshot, edge.to_node_id)
            };
            self.issues.push(
                ScanIssue::new(
                    DANGLING_RELATION,
                    severity::WARNING,
                    format!(
                        "关系 {} 指向的节点不在本次扫描结果里：{}。\
                         这条边保留为「缺失引用」，节点回来时自动接上",
                        edge.id, label
                    ),
                )
                .with_path(&edge.from_relative_path)
                .with_node(&edge.from_node_id),
            );
        }

        /* 4. 学习目标：坏 goals.json 只报问题，不挡住整次扫描 */
        let (goals_file, goal_issues) = load_goals(&self.root, &self.manifest.library_id);
        self.issues.extend(goal_issues);

        /* 5. 排序：报告必须可复现，索引与测试都按顺序比较 */
        self.nodes
            .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        self.edges.sort_by(|a, b| a.id.cmp(&b.id));
        self.threads.sort_by(|a, b| {
            (a.node_relative_path.as_str(), a.id.as_str())
                .cmp(&(b.node_relative_path.as_str(), b.id.as_str()))
        });

        let root_is_node = self.nodes.iter().any(|n| n.relative_path.is_empty());

        ScanReport {
            full: self.opts.full,
            duration_ms: started.elapsed().as_millis() as i64,
            scanned_dirs: self.scanned_dirs,
            nodes: self.nodes,
            edges: self.edges,
            threads: self.threads,
            issues: self.issues,
            duplicate_ids,
            root_is_node,
            goals: goals_file.goals,
            truncated: self.truncated,
        }
    }
}

/* -------------------------------- 目录过滤 -------------------------------- */

/// 「哪些目录不扫」的唯一实现：固定排除名 + 清单里的排除名 + 清单里的通配模式。
pub struct DirFilter {
    names: BTreeSet<String>,
    patterns: Vec<String>,
}

impl DirFilter {
    pub fn new(exclude: &[String]) -> Self {
        let mut names: BTreeSet<String> = FIXED_EXCLUDED_NAMES
            .iter()
            .map(|s| s.to_string())
            .collect();
        // `.meta` 永不当作资产目录，也永不当作节点（别人软件可能也用它，那不是我们的）
        names.insert(vpaths::META_DIR.to_string());
        let mut patterns: Vec<String> = Vec::new();
        for raw in exclude {
            let entry = raw.trim();
            if entry.is_empty() {
                continue;
            }
            let unified = entry.replace('\\', "/");
            if unified.contains('/') || unified.contains('*') || unified.contains('?') {
                if !patterns.iter().any(|p| p == &unified) {
                    patterns.push(unified);
                }
            } else {
                names.insert(unified);
            }
        }
        Self { names, patterns }
    }

    pub fn is_skipped_dir_name(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    /// 通配排除模式是否命中某个目录的相对路径。
    pub fn matches_pattern(&self, relative_path: &str) -> bool {
        self.patterns
            .iter()
            .any(|pattern| glob_matches(pattern, relative_path))
    }
}

/// 轻量 glob：`*` 匹配段内任意字符，`?` 匹配段内一个字符，`**` 匹配零个或多个路径段。
///
/// 只实现 `library.json.scan.exclude` 真正会用到的形状（默认值 `**/.meta/knowledgenet`），
/// 不引入 glob 依赖：排除规则写得太复杂是配置错误，不是需求。
pub fn glob_matches(pattern: &str, text: &str) -> bool {
    let pattern_parts: Vec<&str> = pattern
        .trim_matches('/')
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    let text_parts: Vec<&str> = text
        .trim_matches('/')
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    glob_segments(&pattern_parts, &text_parts)
}

fn glob_segments(pattern: &[&str], text: &[&str]) -> bool {
    if pattern.is_empty() {
        return text.is_empty();
    }
    if pattern[0] == "**" {
        for skip in 0..=text.len() {
            if glob_segments(&pattern[1..], &text[skip..]) {
                return true;
            }
        }
        return false;
    }
    if text.is_empty() {
        return false;
    }
    if !segment_matches(pattern[0], text[0]) {
        return false;
    }
    glob_segments(&pattern[1..], &text[1..])
}

fn segment_matches(pattern: &str, text: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut mark = 0usize;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(star_at) = star {
            pi = star_at + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/* --------------------------------- 工具 --------------------------------- */

fn canonical_root(root: &Path) -> CmdResult<PathBuf> {
    let canonical = fs::canonicalize(root)
        .map_err(|e| CmdError::io(format!("无法解析知识库根目录 {}：{e}", root.display())))?;
    if !canonical.is_dir() {
        return Err(CmdError::invalid(format!(
            "知识库根目录不是一个目录：{}",
            canonical.display()
        )));
    }
    Ok(crate::paths::strip_verbatim(&canonical))
}

/// 读目录并按文件名排序。排序不是为了好看：`read_dir` 的顺序随文件系统变化，
/// 不排序就会让「同一棵树扫出不同报告」。
fn read_dir_sorted(dir: &Path) -> CmdResult<Vec<fs::DirEntry>> {
    let reader = fs::read_dir(dir)
        .map_err(|e| CmdError::io(format!("读取目录 {} 失败：{e}", dir.display())))?;
    let mut entries: Vec<fs::DirEntry> = Vec::new();
    for entry in reader {
        match entry {
            Ok(entry) => entries.push(entry),
            // 单个条目读不到不该让整个目录消失
            Err(_) => continue,
        }
    }
    entries.sort_by_key(|e| e.file_name());
    Ok(entries)
}

fn folder_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn join_rel(base: &str, tail: &str) -> String {
    if base.is_empty() {
        tail.to_string()
    } else {
        format!("{base}/{tail}")
    }
}

/// 目录里是否有**另一个**知识库清单。只看文件名，不解析内容：
/// 解析别人的库没有意义，而「这里不是我的地盘」这个判断只需要文件名。
fn is_nested_library(dir: &Path) -> bool {
    let marker = dir.join("library.json");
    marker.is_file() && !crate::paths::is_link_like(&marker)
}

/// 数 `messages/` 下合法命名的消息文件；**不打开任何文件**。
fn count_messages(messages_dir: &Path) -> i64 {
    let reader = match fs::read_dir(messages_dir) {
        Ok(reader) => reader,
        Err(_) => return 0,
    };
    let mut count = 0i64;
    for entry in reader.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if super::watcher::is_temp_name(&name) {
            continue;
        }
        if !matches!(entry.file_type(), Ok(t) if t.is_file()) {
            continue;
        }
        if vpaths::parse_message_file_name(&name).is_some() {
            count += 1;
        }
    }
    count
}

/// 最近的节点祖先：父节点的资源枚举靠它排除子节点子树。
///
/// 只看字符串前缀（路径已在扫描时规范化），不做文件系统访问。
fn compute_nested_node_paths(paths: &[String]) -> BTreeMap<String, Vec<String>> {
    let set: BTreeSet<&str> = paths.iter().map(|p| p.as_str()).collect();
    let mut out: BTreeMap<String, Vec<String>> =
        paths.iter().map(|p| (p.clone(), Vec::new())).collect();
    for path in paths {
        if let Some(parent) = nearest_node_ancestor(path, &set) {
            if let Some(list) = out.get_mut(&parent) {
                list.push(path.clone());
            }
        }
    }
    for list in out.values_mut() {
        list.sort();
    }
    out
}

fn nearest_node_ancestor(path: &str, set: &BTreeSet<&str>) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let mut end = path.len();
    loop {
        match path[..end].rfind('/') {
            Some(pos) => {
                let candidate = &path[..pos];
                if set.contains(candidate) {
                    return Some(candidate.to_string());
                }
                end = pos;
            }
            None => {
                return if set.contains("") {
                    Some(String::new())
                } else {
                    None
                };
            }
        }
    }
}

fn severity_for(error_code: &str) -> &'static str {
    match error_code {
        // 资产本身坏了才是 error；「读不出来」是环境问题，重复 ID 与嵌套边界
        // 都由扫描器自己用明确的 severity 构造，不走这里
        code::METADATA_INVALID | code::METADATA_UNSUPPORTED | code::DUPLICATE_NODE_ID => {
            severity::ERROR
        }
        _ => severity::WARNING,
    }
}

/// 解析错误 → 一条问题。`metadata_invalid` / `metadata_unsupported` 保持原码，
/// 其它（io 等）也保持原码并降为 warning：前端按 `code` 分支，不按消息猜。
fn issue_from_error(
    err: &CmdError,
    relative_path: &str,
    node_id: Option<&str>,
    what: &str,
) -> ScanIssue {
    let parse_position = err
        .detail
        .as_ref()
        .and_then(|detail| detail.get("detail"))
        .and_then(|value| value.as_str())
        .map(|s| s.to_string());
    let mut issue = ScanIssue::new(
        &err.code,
        severity_for(&err.code),
        format!("{what}：{}", err.message),
    )
    .with_path(relative_path);
    if let Some(node_id) = node_id {
        issue = issue.with_node(node_id);
    }
    issue.parse_position = parse_position;
    issue
}

/// 坏掉的 `goals.json` 不能让知识库打不开：返回空目标 + 一条问题。
fn load_goals(root: &Path, library_id: &str) -> (GoalsFile, Vec<ScanIssue>) {
    let path = vpaths::root_goals_file(root);
    if !path.is_file() {
        return (GoalsFile::empty(library_id.to_string()), Vec::new());
    }
    match atomic::read_typed::<GoalsFile>(
        &path,
        GOALS_FORMAT,
        GOALS_FORMAT_VERSION,
        "goals.json",
        Some(".knowledgenet/goals.json"),
    ) {
        Ok((file, _fp)) => (file, Vec::new()),
        Err(err) => (
            GoalsFile::empty(library_id.to_string()),
            vec![issue_from_error(
                &err,
                ".knowledgenet/goals.json",
                None,
                "goals.json 无法解析（已按空目标列表继续）",
            )],
        ),
    }
}

/// 尽力读出 `library.json` 的 `libraryId`，用于 [`read_goals`] 单独调用时补默认值。
fn read_library_id_lossy(root: &Path) -> Option<String> {
    let path = root.join("library.json");
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("libraryId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/* ---------------------------------- 测试 ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    fn node_json(id: &str, title: &str) -> String {
        format!(
            r#"{{
              "format": "knowledgenet-node",
              "formatVersion": 1,
              "id": "{id}",
              "revision": 1,
              "title": "{title}",
              "aliases": [],
              "status": "todo",
              "primaryDocument": null,
              "createdAt": "2026-09-20T10:00:00.000Z",
              "updatedAt": "2026-09-20T10:00:00.000Z",
              "extensions": {{}}
            }}"#
        )
    }

    fn manifest() -> LibraryManifest {
        LibraryManifest::new(
            "01990000-0000-7000-8000-000000000001".to_string(),
            "测试库".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        )
    }

    const A: &str = "0199aaaa-0000-7000-8000-000000000001";
    const B: &str = "0199bbbb-0000-7000-8000-000000000002";

    #[test]
    fn glob_matching_covers_the_default_pattern() {
        assert!(glob_matches("**/.meta/knowledgenet", "A/.meta/knowledgenet"));
        assert!(glob_matches("**/.meta/knowledgenet", ".meta/knowledgenet"));
        assert!(!glob_matches("**/.meta/knowledgenet", "A/.meta/other"));
        assert!(glob_matches("Nodes/**", "Nodes/A/B"));
        assert!(glob_matches("Nodes/*", "Nodes/A"));
        assert!(!glob_matches("Nodes/*", "Nodes/A/B"));
        assert!(glob_matches("*.tmp", "a.tmp"));
        assert!(!glob_matches("*.tmp", "a.txt"));
        assert!(glob_matches("A/?", "A/b"));
    }

    #[test]
    fn nested_node_paths_use_the_nearest_node_ancestor() {
        let paths = vec![
            String::new(),
            "Root".to_string(),
            "Root/Child".to_string(),
            "Root/Child/Deep".to_string(),
            "Other".to_string(),
        ];
        let nested = compute_nested_node_paths(&paths);
        assert_eq!(
            nested.get("").unwrap(),
            &vec!["Other".to_string(), "Root".to_string()]
        );
        assert_eq!(nested.get("Root").unwrap(), &vec!["Root/Child".to_string()]);
        assert_eq!(
            nested.get("Root/Child").unwrap(),
            &vec!["Root/Child/Deep".to_string()]
        );
        assert!(nested.get("Root/Child/Deep").unwrap().is_empty());
    }

    #[test]
    fn plain_files_belong_to_the_nearest_node() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("Root/.meta/knowledgenet/node.json"), &node_json(A, "父"));
        write(&root.join("Root/note.md"), "x");
        write(&root.join("Root/assets/diagram.txt"), "x");
        write(
            &root.join("Root/Child/.meta/knowledgenet/node.json"),
            &node_json(B, "子"),
        );
        write(&root.join("Root/Child/child.md"), "x");
        // 元数据目录里的文件永远不算用户资产
        write(&root.join("Root/.meta/other-tool/notes.txt"), "x");

        let report = scan_library(root, &manifest(), &ScanOptions { full: true }).unwrap();
        let parent = report.node_by_path("Root").unwrap();
        let child = report.node_by_path("Root/Child").unwrap();
        assert_eq!(parent.nested_node_paths, vec!["Root/Child".to_string()]);

        let parent_files =
            list_plain_files_of_node(root, parent, &manifest().scan.exclude).unwrap();
        assert_eq!(
            parent_files,
            vec![
                "Root/assets/diagram.txt".to_string(),
                "Root/note.md".to_string()
            ]
        );
        let child_files = list_plain_files_of_node(root, child, &manifest().scan.exclude).unwrap();
        assert_eq!(child_files, vec!["Root/Child/child.md".to_string()]);
    }

    #[test]
    fn message_count_only_counts_well_formed_names() {
        let dir = tempfile::tempdir().unwrap();
        let messages = dir.path().join("messages");
        fs::create_dir_all(&messages).unwrap();
        fs::write(
            messages.join("000001_0199ffff-0000-7000-8000-000000000101.json"),
            "{}",
        )
        .unwrap();
        fs::write(messages.join("000002.json"), "{}").unwrap();
        fs::write(messages.join(".kn-tmp-000003_x.json"), "{}").unwrap();
        fs::create_dir_all(messages.join("nested")).unwrap();
        assert_eq!(count_messages(&messages), 1);
    }

    #[test]
    fn broken_goals_do_not_break_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join(".knowledgenet/goals.json"), "{ not json");
        write(
            &root.join("Nodes/A/.meta/knowledgenet/node.json"),
            &node_json(A, "A"),
        );
        let report = scan_library(root, &manifest(), &ScanOptions { full: true }).unwrap();
        assert_eq!(report.nodes.len(), 1);
        assert!(report.goals.is_empty());
        assert!(report.issues.iter().any(|i| i.code == code::METADATA_INVALID
            && i.relative_path.as_deref() == Some(".knowledgenet/goals.json")));
    }

    #[test]
    fn only_dot_meta_is_not_a_node_and_not_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("Only/.meta/some-other-tool/notes.txt"), "x");
        let report = scan_library(root, &manifest(), &ScanOptions { full: true }).unwrap();
        assert!(report.nodes.is_empty());
        assert!(report.issues.is_empty(), "别人的 .meta 不该产生问题");
    }
}
