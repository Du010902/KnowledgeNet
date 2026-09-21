//! 打开的知识库会话：锁、清单、设备索引、扫描代次、文件监听。
//!
//! 这里是**唯一**知道「当前打开的是哪个库」的地方。命令层只跟它打交道：
//!
//! ```text
//! nodeId -> 索引里的相对路径 -> 根目录内安全解析 -> canonicalize 边界校验 -> 文件操作
//! ```
//!
//! 前端永远只传实体 ID，不传任何绝对路径。节点目录被外部移动、索引还没更新时，
//! 按 ID 触发一次**受限重定位重扫**；仍然找不到才返回 `node_missing`，
//! 绝不使用陈旧的绝对路径去猜。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::library::{self, LibraryLock, LockInfo};
use crate::models::{code, CmdError, CmdResult};
use crate::paths::{self, LibraryPaths};

use super::atomic;
use super::ctx::LibCtx;
use super::index::IndexHandle;
use super::scanner::{self, ScanOptions, ScanReport, ScannedNode};
use super::schema::{LibraryManifest, Validate};
use super::vpaths;
use super::watcher::{self, WatcherHandle};

/* ------------------------------ 打开中的知识库 ------------------------------ */

/// 扫描摘要：界面每次都要显示「这个库有多少节点/边/问题」，但不需要整份报告。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    pub nodes: i64,
    pub edges: i64,
    pub threads: i64,
    pub goals: i64,
    pub issues: i64,
    pub duplicate_groups: i64,
    pub revision: i64,
    pub duration_ms: i64,
    pub scanned_at_ms: i64,
    pub truncated: bool,
    pub root_is_node: bool,
}

/// 打开中的知识库摘要（前端 `LibraryInfo` 一一对应）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub library_id: String,
    pub title: String,
    pub root_path: String,
    pub read_only: bool,
    pub format_version: i64,
    pub node_count: i64,
    pub edge_count: i64,
    pub goal_count: i64,
    pub thread_count: i64,
    pub issue_count: i64,
    pub created_at: String,
    pub scan_duration_ms: i64,
    pub root_is_node: bool,
}

/// 一次打开会话的全部上下文。它**不是**单例：同一个进程可以先后打开不同知识库。
#[derive(Debug)]
pub struct OpenLibrary {
    pub paths: LibraryPaths,
    pub manifest: LibraryManifest,
    pub read_only: bool,
    pub session_id: String,
    /// 扫描代次：每完成一次全量/增量扫描 +1。前端按它丢弃旧库的迟到事件。
    pub generation: Arc<AtomicU64>,
    /// 设备本地派生索引。可随时删除并重建，**不是**知识资产的权威来源。
    pub index: Arc<Mutex<IndexHandle>>,
    pub report: Arc<Mutex<ReportSummary>>,
    pub watcher: Option<WatcherHandle>,
    /// 只读打开时为 None
    pub lock: Option<LibraryLock>,
    pub opened_at_ms: i64,
}

/// 进程级状态：一个可空的当前知识库 + 一个串行写队列。
pub struct AppState {
    pub library: Mutex<Option<OpenLibrary>>,
    pub write_queue: Mutex<()>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            library: Mutex::new(None),
            write_queue: Mutex::new(()),
        }
    }
}

/// 可写会话：**先拿串行写队列，再拿当前知识库**。
/// 顺序不能反：切库、关库都按同一顺序加锁，反序会形成 AB-BA 死锁。
pub struct WriteSession<'a> {
    _queue: MutexGuard<'a, ()>,
    library: MutexGuard<'a, Option<OpenLibrary>>,
    allow_read_only: bool,
}

impl<'a> WriteSession<'a> {
    pub fn lib(&mut self) -> CmdResult<&mut OpenLibrary> {
        let lib = self.library.as_mut().ok_or_else(CmdError::not_open)?;
        if lib.read_only && !self.allow_read_only {
            return Err(CmdError::read_only());
        }
        Ok(lib)
    }
}

/// 只读会话：不占用写队列，读命令之间可以并发。
pub struct ReadSession<'a> {
    library: MutexGuard<'a, Option<OpenLibrary>>,
}

impl<'a> ReadSession<'a> {
    pub fn lib(&self) -> CmdResult<&OpenLibrary> {
        self.library.as_ref().ok_or_else(CmdError::not_open)
    }
}

pub fn write_session(state: &AppState) -> CmdResult<WriteSession<'_>> {
    let queue = library::lock_ignoring_poison(&state.write_queue);
    let library = library::lock_ignoring_poison(&state.library);
    let mut session = WriteSession {
        _queue: queue,
        library,
        allow_read_only: false,
    };
    session.lib()?;
    Ok(session)
}

/// 只读知识库上的「检验会话」：**只给纯读的完整性检查用**。
pub fn inspection_session(state: &AppState) -> CmdResult<WriteSession<'_>> {
    let queue = library::lock_ignoring_poison(&state.write_queue);
    let library = library::lock_ignoring_poison(&state.library);
    let session = WriteSession {
        _queue: queue,
        library,
        allow_read_only: true,
    };
    if session.library.is_none() {
        return Err(CmdError::not_open());
    }
    Ok(session)
}

pub fn read_session(state: &AppState) -> CmdResult<ReadSession<'_>> {
    let library = library::lock_ignoring_poison(&state.library);
    let session = ReadSession { library };
    session.lib()?;
    Ok(session)
}

/* --------------------------------- 上下文 --------------------------------- */

/// 从打开会话构造业务上下文。`LibCtx` 是纯值对象，克隆很便宜。
pub fn ctx_of(lib: &OpenLibrary) -> LibCtx {
    LibCtx::from_paths(lib.paths.clone(), lib.manifest.clone(), lib.read_only)
}

pub fn index_of(lib: &OpenLibrary) -> MutexGuard<'_, IndexHandle> {
    library::lock_ignoring_poison(&lib.index)
}

pub fn summary_of(lib: &OpenLibrary) -> ReportSummary {
    library::lock_ignoring_poison(&lib.report).clone()
}

pub fn generation_of(lib: &OpenLibrary) -> u64 {
    lib.generation.load(Ordering::SeqCst)
}

pub fn bump_generation(lib: &OpenLibrary) -> u64 {
    lib.generation.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn info_of(lib: &OpenLibrary) -> LibraryInfo {
    let summary = summary_of(lib);
    LibraryInfo {
        library_id: lib.manifest.library_id.clone(),
        title: lib.manifest.title.clone(),
        root_path: lib.paths.root().to_string_lossy().to_string(),
        read_only: lib.read_only,
        format_version: lib.manifest.format_version,
        node_count: summary.nodes,
        edge_count: summary.edges,
        goal_count: summary.goals,
        thread_count: summary.threads,
        issue_count: summary.issues,
        created_at: lib.manifest.created_at.clone(),
        scan_duration_ms: summary.duration_ms,
        root_is_node: summary.root_is_node,
    }
}

/* --------------------------------- 打开 --------------------------------- */

pub struct OpenOptions {
    pub allow_read_only: bool,
    pub app_data_dir: PathBuf,
    pub app: Option<AppHandle>,
    pub app_version: String,
}

/// v1 需要迁移时抛出的结构化错误：前端据此弹「迁移」而不是「打不开」。
pub fn needs_migration_error(root: &Path, version: i64) -> CmdError {
    CmdError::new(
        code::UNSUPPORTED_VERSION,
        format!(
            "这个知识库还是 v{version} 格式（结构化数据存在 knowledge.sqlite 里），\
             需要先迁移成 v2 的开放文件格式。迁移不会删除任何用户文件。"
        ),
    )
    .with_detail(serde_json::json!({
        "needsMigration": true,
        "formatVersion": version,
        "rootPath": root.to_string_lossy(),
    }))
}

/// 打开知识库：校验清单 → 取写锁 → 打开/重建设备索引 → 全量扫描 → 启动监听。
pub fn open(state: &AppState, root: &Path, opts: OpenOptions) -> CmdResult<LibraryInfo> {
    let paths = LibraryPaths::for_existing(root)?;
    let root_path = paths.root().to_path_buf();

    let text = library::read_manifest_text(&root_path)?;
    let version = library::peek_format_version(&text)?;
    if version != super::schema::LIBRARY_FORMAT_VERSION {
        return Err(needs_migration_error(&root_path, version));
    }
    let manifest = library::parse_manifest(&text, &root_path)?;
    manifest
        .validate_typed()
        .map_err(|e| CmdError::invalid(format!("library.json 不合法：{}", e.message)))?;

    // 先取锁：拿不到就尝试只读打开（用户仍然应该能看自己的知识资产）
    let session_id = library::new_session_id();
    let lock_info = LockInfo {
        library_id: manifest.library_id.clone(),
        session_id: session_id.clone(),
        hostname: library::hostname(),
        pid: std::process::id(),
        app_version: opts.app_version.clone(),
        opened_at: paths::iso_now(),
    };
    let (lock, read_only) = match LibraryLock::acquire(&vpaths::root_lock_file(&root_path), &lock_info)
    {
        Ok(lock) => (Some(lock), false),
        Err(err) => {
            if opts.allow_read_only {
                (None, true)
            } else {
                return Err(err);
            }
        }
    };

    let index_dir = vpaths::index_dir(&opts.app_data_dir, &manifest.library_id);
    let index = IndexHandle::open(&index_dir, &manifest.library_id)?;

    let library = OpenLibrary {
        paths,
        manifest,
        read_only,
        session_id,
        generation: Arc::new(AtomicU64::new(0)),
        index: Arc::new(Mutex::new(index)),
        report: Arc::new(Mutex::new(ReportSummary::default())),
        watcher: None,
        lock,
        opened_at_ms: paths::now_ms(),
    };

    // 首次扫描：没有索引也能重建出完整图谱，这就是「索引可删除」的含义
    rescan(&library)?;

    let watcher = start_watcher(&opts, &library);
    let mut library = library;
    library.watcher = watcher;

    let info = info_of(&library);
    let mut guard = library::lock_ignoring_poison(&state.library);
    *guard = Some(library);
    Ok(info)
}

fn start_watcher(opts: &OpenOptions, lib: &OpenLibrary) -> Option<WatcherHandle> {
    let app = opts.app.clone()?;
    let exclude = lib.manifest.excluded_names();
    match watcher::start(
        app,
        lib.paths.root(),
        &lib.manifest.library_id,
        Arc::clone(&lib.generation),
        exclude,
    ) {
        Ok(handle) => Some(handle),
        Err(err) => {
            // 监听失败不该让「打开知识库」失败：重新扫描永远是可靠兜底。
            eprintln!("文件监听启动失败（不影响使用，可手动重新扫描）：{err}");
            None
        }
    }
}

pub fn close(state: &AppState) -> CmdResult<()> {
    let mut guard = library::lock_ignoring_poison(&state.library);
    // 先丢掉 watcher（Drop 里停线程），再丢库（Drop 里释放锁）
    if let Some(mut lib) = guard.take() {
        lib.watcher = None;
    }
    Ok(())
}

/// 关窗时的收尾：停掉监听、释放写锁。
pub fn shutdown(state: &AppState) {
    let _ = close(state);
}

/* --------------------------------- 扫描 --------------------------------- */

/// 全量/增量扫描并把结果写进设备索引，然后更新摘要与代次。
///
/// 顺序有意为之：**先扫描文件、后写索引**。索引写失败不影响资产，
/// 下一次扫描照样能重建——绝不出现「用索引覆盖文件」的逻辑。
pub fn rescan(lib: &OpenLibrary) -> CmdResult<ScanReport> {
    let opts = ScanOptions { full: true };
    let report = scanner::scan_library(lib.paths.root(), &lib.manifest, &opts)?;
    let mut index = index_of(lib);
    index.apply_scan(&report)?;
    let stats = index.stats()?;
    drop(index);

    {
        let mut summary = library::lock_ignoring_poison(&lib.report);
        *summary = ReportSummary {
            nodes: stats.nodes,
            edges: stats.edges,
            threads: stats.threads,
            goals: report.goals.len() as i64,
            issues: stats.issues,
            duplicate_groups: report.duplicate_ids.len() as i64,
            revision: (generation_of(lib) + 1) as i64,
            duration_ms: report.duration_ms,
            scanned_at_ms: paths::now_ms(),
            truncated: report.truncated,
            root_is_node: report.root_is_node,
        };
    }
    bump_generation(lib);
    Ok(report)
}

/// 扫描但**不**改索引（完整性检查用；检查不该顺手改缓存）。
pub fn scan_only(lib: &OpenLibrary) -> CmdResult<ScanReport> {
    scanner::scan_library(lib.paths.root(), &lib.manifest, &ScanOptions { full: true })
}

/* ------------------------------ 节点路径解析 ------------------------------ */

/// `nodeId` → 相对路径。索引过期（文件夹被外部移动）时做一次**受限重定位**。
pub fn node_relative_path(lib: &OpenLibrary, node_id: &str) -> CmdResult<String> {
    paths::require_uuid(node_id, "nodeId")?;

    let cached = {
        let index = index_of(lib);
        index.node(node_id)?
    };

    if let Some(node) = &cached {
        if node.health == "ok" {
            if let Ok(abs) = lib
                .paths
                .root()
                .join(node.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
                .canonicalize()
            {
                if abs.starts_with(lib.paths.canonical_root()) && abs.is_dir() {
                    return Ok(node.relative_path.clone());
                }
            }
        }
    }

    // 受限重定位：一次全量重扫，然后按 ID 重新查。找不到就是真的没了。
    rescan(lib)?;
    let index = index_of(lib);
    index
        .node(node_id)?
        .map(|node| node.relative_path)
        .ok_or_else(|| {
            CmdError::new(
                code::NODE_MISSING,
                format!("找不到节点 {node_id}：它的文件夹可能已被移出知识库或删除"),
            )
        })
}

/// `nodeId` → 索引里的节点行（含 `relativePath` / `folderName` / `health`）。
pub fn node_row(lib: &OpenLibrary, node_id: &str) -> CmdResult<ScannedNode> {
    paths::require_uuid(node_id, "nodeId")?;
    let rel = node_relative_path(lib, node_id)?;
    let index = index_of(lib);
    index
        .node_by_path(&rel)?
        .ok_or_else(|| CmdError::not_found(format!("索引里没有节点 {node_id}")))
}

/// 节点目录的绝对路径（业务模块统一从这里拿路径，不自己拼）。
pub fn node_dir(lib: &OpenLibrary, node_id: &str) -> CmdResult<PathBuf> {
    let rel = node_relative_path(lib, node_id)?;
    ctx_of(lib).node_dir(&rel)
}

/// 所有节点目录下有 `.meta/knowledgenet/chats` 的节点（重扫后的缓存清理等用）。
pub fn nodes_with_threads(lib: &OpenLibrary) -> CmdResult<Vec<ScannedNode>> {
    let index = index_of(lib);
    Ok(index
        .all_nodes()?
        .into_iter()
        .filter(|n| n.health == "ok")
        .collect())
}

/// 打开知识库时，把上次崩在 `streaming` 的消息收尾成 `incomplete`。
///
/// 有意做成**懒**的：只在线程真的被打开时收尾（见命令层 `load_thread`），
/// 而不是开库时遍历全部线程文件——一万个节点时那是几千次额外读盘。
pub fn write_guard(lib: &OpenLibrary) -> CmdResult<()> {
    if lib.read_only {
        Err(CmdError::read_only())
    } else {
        Ok(())
    }
}

/* ------------------------------ 完整性检查 ------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityIssue {
    pub id: String,
    pub kind: String,
    pub severity: String,
    pub entity_type: String,
    pub entity_id: String,
    pub path: Option<String>,
    pub detail: String,
    pub repairable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityCounts {
    pub nodes: i64,
    pub edges: i64,
    pub threads: i64,
    pub messages: i64,
    pub goals: i64,
    pub resources: i64,
    pub plain_files: i64,
    /// 深度检查时实际算过哈希/读过大小的文件数
    pub files_checked: i64,
    pub bytes_checked: i64,
    pub issues: i64,
    pub duplicate_groups: i64,
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
    /// 扫描提前中止时为 true，报告不完整
    pub truncated: bool,
    pub warnings: Vec<String>,
}

/// 完整性检查的判断依据是**资产文件**，不是缓存行数。
pub fn check_integrity(lib: &OpenLibrary, deep: bool) -> CmdResult<IntegrityReport> {
    let report = scan_only(lib)?;
    let mut issues: Vec<IntegrityIssue> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for (index, issue) in report.issues.iter().enumerate() {
        issues.push(IntegrityIssue {
            id: format!("scan-{index}"),
            kind: issue.code.clone(),
            severity: issue.severity.clone(),
            entity_type: if issue.node_id.is_some() { "node" } else { "library" }.to_string(),
            entity_id: issue.node_id.clone().unwrap_or_default(),
            path: issue.relative_path.clone(),
            detail: issue.detail.clone(),
            // 重复 ID 可以在界面上一键重编；其余交给用户手工修文件
            repairable: issue.code == code::DUPLICATE_NODE_ID,
        });
    }

    let mut messages = 0i64;
    let mut plain_files = 0i64;
    let mut files_checked = 0i64;
    let mut bytes_checked = 0i64;
    let mut resources = 0i64;
    if deep {
        for node in report.nodes.iter().filter(|n| n.health == "ok") {
            match super::resources::list_plain_files(&ctx_of(lib), &node.relative_path) {
                Ok(files) => {
                    plain_files += files.len() as i64;
                    for file in files {
                        if file.is_dir {
                            issues.push(IntegrityIssue {
                                id: format!("dir-{}", file.relative_path),
                                kind: "plain_directory".to_string(),
                                severity: "info".to_string(),
                                entity_type: "node".to_string(),
                                entity_id: node.id.clone(),
                                path: Some(file.relative_path.clone()),
                                detail: "节点目录里还有一个子目录，它本身不是节点（正常，仅列出）"
                                    .to_string(),
                                repairable: false,
                            });
                        } else {
                            files_checked += 1;
                            bytes_checked += file.byte_length;
                        }
                    }
                }
                Err(err) => warnings.push(format!("{}：{}", node.relative_path, err.message)),
            }
            if let Ok(entries) = super::resources::list_resources(&ctx_of(lib), &node.relative_path) {
                resources += entries.len() as i64;
            }
            match super::chats::list_threads(&ctx_of(lib), &node.relative_path) {
                Ok(threads) => {
                    for thread in threads {
                        messages += thread.message_count;
                        let primary = node.primary_document.clone();
                        if let Some(doc) = primary {
                            let node_dir = ctx_of(lib).node_dir_unchecked(&node.relative_path)?;
                            let doc_path = node_dir.join(doc.replace('/', std::path::MAIN_SEPARATOR_STR));
                            if !doc_path.is_file() {
                                issues.push(IntegrityIssue {
                                    id: format!("doc-{}", node.id),
                                    kind: "primary_document_missing".to_string(),
                                    severity: "warning".to_string(),
                                    entity_type: "node".to_string(),
                                    entity_id: node.id.clone(),
                                    path: Some(doc.clone()),
                                    detail: format!(
                                        "node.json 里登记的主文档不存在：{}",
                                        doc
                                    ),
                                    repairable: false,
                                });
                            }
                        }
                    }
                }
                Err(err) => warnings.push(format!("{}：{}", node.relative_path, err.message)),
            }
        }
    }

    let error_count = issues.iter().filter(|i| i.severity == "error").count();
    Ok(IntegrityReport {
        deep,
        checked_at: paths::now_ms(),
        revision: generation_of(lib) as i64,
        counts: IntegrityCounts {
            nodes: report.nodes.len() as i64,
            edges: report.edges.len() as i64,
            threads: report.threads.len() as i64,
            messages,
            goals: report.goals.len() as i64,
            resources,
            plain_files,
            files_checked,
            bytes_checked,
            issues: issues.len() as i64,
            duplicate_groups: report.duplicate_ids.len() as i64,
        },
        ok: error_count == 0,
        truncated: report.truncated,
        issues,
        warnings,
    })
}

/// 删除设备本地索引并重建——这就是「删掉 AppData 也不丢知识」的可执行证明。
pub fn rebuild_index(lib: &OpenLibrary) -> CmdResult<ReportSummary> {
    {
        let mut index = index_of(lib);
        let path = index.path().to_path_buf();
        drop(std::mem::replace(&mut *index, IndexHandle::open(&path, &lib.manifest.library_id)?));
        index.clear()?;
    }
    rescan(lib)?;
    Ok(summary_of(lib))
}

/// 写一次元数据资产后刷新索引。
///
/// 这里刻意选择「重新扫描一遍」而不是手写一份「只扫一个目录」的并行实现：
/// 扫描只读 `node.json` 头与线程头，正确性远比省下的那点读盘重要；
/// 真正需要热路径增量的场景（文件监听）走的是前端防抖后的一次 `scan_library(false)`。
pub fn refresh_node(lib: &OpenLibrary, relative_path: &str) -> CmdResult<()> {
    let _ = relative_path;
    rescan(lib)?;
    Ok(())
}

/// 刷新某个节点下的线程摘要（只读线程头，不读消息正文）。
pub fn refresh_threads(lib: &OpenLibrary, relative_path: &str, node_id: &str) -> CmdResult<()> {
    let ctx = ctx_of(lib);
    let threads = super::chats::list_threads(&ctx, relative_path)?;
    {
        let mut index = index_of(lib);
        for thread in &threads {
            index.upsert_thread(thread)?;
        }
        let stats = index.stats()?;
        let mut summary = library::lock_ignoring_poison(&lib.report);
        summary.threads = stats.threads;
    }
    let _ = node_id;
    bump_generation(lib);
    Ok(())
}

/// 原子写入 `library.json`（保留未知字段）。
pub fn save_manifest(lib: &OpenLibrary) -> CmdResult<()> {
    write_guard(lib)?;
    library::write_manifest(lib.paths.root(), &lib.manifest)?;
    Ok(())
}

/// 计算文件指纹（命令层回传 `sha256` 给前端做乐观并发用）。
pub fn fingerprint_of(path: &Path) -> CmdResult<atomic::Fingerprint> {
    atomic::fingerprint(path)
}
