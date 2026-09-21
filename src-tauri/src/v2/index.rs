//! AppData 里的设备本地派生索引（可删除、可重建）。实现者：rust-scan-index。
//!
//! 契约 `docs/v2-contract.md` §3.5、设计文档 §8.5。
//!
//! 索引的全部意义可以用一句话说清：**它是缓存，不是资产**。
//! 所以这个模块的每一处设计都偏向「坏了就重建」，而不是「坏了让用户修」：
//!
//! - `open` 发现 `schema_version` 不符、`library_id` 不符、或者文件根本读不出来
//!   （`SQLITE_CORRUPT`、半截文件、被别的程序改成垃圾），**直接删掉整个 `index.sqlite`
//!   重建**。没有「请修复缓存」这种要求。
//! - `apply_scan` 是**单个事务**的整表替换：要么整份新图生效，要么什么都没有发生。
//!   绝不出现「节点更新了、边还是上一轮」的中间态。
//! - 只存轻量元数据：没有消息正文、没有笔记正文、没有资源内容。
//!   图快照可以被前端随便拉，不会把几万条消息读进内存。
//!
//! 路径：`<app_data>/indexes/<libraryId>/index.sqlite`（`vpaths::index_dir`）。
//! 这里**只接受已经给好的目录**，不依赖 `AppHandle`：`state.rs` 用
//! `app.path().app_data_dir()` 拼出目录再传进来。

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use crate::models::{code, CmdError, CmdResult, LearnStatus};

use super::atomic;
use super::schema::Evidence;
use super::scanner::{
    DuplicateIdGroup, ScanIssue, ScanReport, ScannedEdge, ScannedNode, ScannedThread,
};
use super::vpaths;

/// 索引 schema 版本。**改了表结构就要 +1**：旧版本会在下次打开时被整份删掉重建。
pub const INDEX_SCHEMA_VERSION: i64 = 1;

/// 索引文件名（放在 `<app_data>/indexes/<libraryId>/` 下）
pub const INDEX_FILE_NAME: &str = "index.sqlite";

/// 无 `AppHandle` 时的兜底标识符，与 `tauri.conf.json` 的 `identifier` 一致。
pub const APP_IDENTIFIER: &str = "com.knowledgenet.app";

const SCHEMA_SQL: &str = r#"
PRAGMA foreign_keys = OFF;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  relative_path           TEXT PRIMARY KEY,
  id                      TEXT NOT NULL,
  folder_name             TEXT NOT NULL,
  title                   TEXT NOT NULL,
  aliases_json            TEXT NOT NULL,
  status                  TEXT NOT NULL,
  primary_document        TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  revision                INTEGER NOT NULL,
  health                  TEXT NOT NULL,
  meta_sha256             TEXT NOT NULL,
  meta_bytes              INTEGER NOT NULL,
  meta_modified_ms        INTEGER NOT NULL,
  depth                   INTEGER NOT NULL,
  nested_node_paths_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_id ON nodes(id);

CREATE TABLE IF NOT EXISTS edges (
  id                  TEXT PRIMARY KEY,
  from_node_id        TEXT NOT NULL,
  to_node_id          TEXT NOT NULL,
  relation            TEXT NOT NULL,
  relation_type       TEXT NOT NULL,
  description         TEXT NOT NULL,
  to_title_snapshot   TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  from_relative_path  TEXT NOT NULL,
  dangling            INTEGER NOT NULL,
  evidence_json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node_id);

CREATE TABLE IF NOT EXISTS threads (
  id                  TEXT PRIMARY KEY,
  node_id             TEXT NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  revision            INTEGER NOT NULL,
  message_count       INTEGER NOT NULL,
  node_relative_path  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_node ON threads(node_id);

CREATE TABLE IF NOT EXISTS issues (
  code            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  relative_path   TEXT,
  node_id         TEXT,
  detail          TEXT NOT NULL,
  parse_position  TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  root_node_id  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
"#;

/* --------------------------------- 模型 --------------------------------- */

/// 索引里的行数摘要。界面上的「几个节点、几条关系」直接来自这里，
/// 不走全表扫描。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub nodes: i64,
    pub edges: i64,
    pub threads: i64,
    pub issues: i64,
}

/// 轻量图快照：**只含元数据**，绝不含任何正文。
///
/// `threads` 不在契约 §3.5 的 `IndexGraph` 里，但命令层合并节点时要按
/// `node_id` 找线程（`commands::merge_nodes`），所以这里一并给出。
/// 见 `docs/v2-deviations.md`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexGraph {
    pub nodes: Vec<ScannedNode>,
    pub edges: Vec<ScannedEdge>,
    pub threads: Vec<ScannedThread>,
    pub goals: Vec<super::schema::GoalEntry>,
    pub issues: Vec<ScanIssue>,
    /// 索引里记录的扫描代次（每次 `apply_scan` +1）。
    /// 命令层若要用会话代次，用 `set_scan_revision` 对齐。
    pub revision: i64,
}

/// 设备本地索引句柄。`Connection` 不是 `Sync`，所以它总是被包在
/// `Arc<Mutex<…>>` 里（见 `state.rs`）。
pub struct IndexHandle {
    conn: Connection,
    file: PathBuf,
    dir: PathBuf,
    library_id: String,
}

impl std::fmt::Debug for IndexHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexHandle")
            .field("file", &self.file)
            .field("library_id", &self.library_id)
            .finish()
    }
}

/* --------------------------------- 路径 --------------------------------- */

/// `dir/index.sqlite`
pub fn index_file_path(dir: &Path) -> PathBuf {
    dir.join(INDEX_FILE_NAME)
}

/// 契约 §3.5 的 `default_index_dir`。
///
/// **本模块不依赖 `AppHandle`**：运行时目录由 `state.rs` 用
/// `vpaths::index_dir(app.path().app_data_dir()?, library_id)` 算出来。
/// 这个函数只提供同一形状的兜底（平台数据目录 + 应用标识符），
/// 供没有 `AppHandle` 的调用方与测试使用。见 `docs/v2-deviations.md`。
pub fn default_index_dir(library_id: &str) -> CmdResult<PathBuf> {
    let base = platform_data_dir()?.join(APP_IDENTIFIER);
    Ok(vpaths::index_dir(&base, library_id))
}

fn platform_data_dir() -> CmdResult<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(dir) = std::env::var_os("APPDATA") {
            if !dir.is_empty() {
                return Ok(PathBuf::from(dir));
            }
        }
        Err(CmdError::io(
            "无法确定设备数据目录：环境变量 APPDATA 不存在".to_string(),
        ))
    }
    #[cfg(not(windows))]
    {
        if let Some(dir) = std::env::var_os("XDG_DATA_HOME") {
            if !dir.is_empty() {
                return Ok(PathBuf::from(dir));
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            if !home.is_empty() {
                return Ok(PathBuf::from(home).join(".local").join("share"));
            }
        }
        Err(CmdError::io(
            "无法确定设备数据目录：XDG_DATA_HOME 与 HOME 都不存在".to_string(),
        ))
    }
}

/// 允许把「索引目录」或「`index.sqlite` 文件路径」都传进来：
/// 两者都指向同一个文件，调用方不必记住契约里那个含糊的说法。
fn split_index_path(path: &Path) -> (PathBuf, PathBuf) {
    let looks_like_file = path
        .file_name()
        .map(|name| name.to_string_lossy() == INDEX_FILE_NAME)
        .unwrap_or(false);
    if looks_like_file && !path.is_dir() {
        let dir = path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        (dir, path.to_path_buf())
    } else {
        (path.to_path_buf(), index_file_path(path))
    }
}

/// 删掉索引文件本身与它的日志/共享内存伴生文件。
///
/// 必须在**没有打开的连接**时调用，否则 Windows 上删不掉。
fn remove_index_files(file: &Path) -> CmdResult<()> {
    let mut targets: Vec<PathBuf> = vec![file.to_path_buf()];
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = file.as_os_str().to_os_string();
        name.push(suffix);
        targets.push(PathBuf::from(name));
    }
    for target in targets {
        if !target.exists() {
            continue;
        }
        std::fs::remove_file(&target).map_err(|e| {
            CmdError::io(format!(
                "删除设备索引 {} 失败（它只是缓存，但删不掉就没法重建）：{e}",
                target.display()
            ))
        })?;
    }
    Ok(())
}

/* --------------------------------- 打开 --------------------------------- */

impl IndexHandle {
    /// 打开（必要时重建）某个知识库的设备索引。
    ///
    /// 以下任一情况都会**删除整个 `index.sqlite` 并重建**，不要求用户修复缓存：
    /// 目录/文件不存在、`schema_version` 不符、`library_id` 不符、文件损坏、
    /// 查询报错（缺表、缺列、`SQLITE_CORRUPT`…）。
    pub fn open(index_dir: &Path, library_id: &str) -> CmdResult<Self> {
        let (dir, file) = split_index_path(index_dir);
        atomic::ensure_dir(&dir)?;
        match Self::open_existing(&dir, &file, library_id) {
            Ok(handle) => Ok(handle),
            Err(_) => {
                remove_index_files(&file)?;
                Self::create_fresh(&dir, &file, library_id)
            }
        }
    }

    fn connect(file: &Path) -> CmdResult<Connection> {
        let conn = Connection::open(file).map_err(|e| {
            CmdError::new(
                code::IO,
                format!("打开设备索引 {} 失败：{e}", file.display()),
            )
        })?;
        conn.busy_timeout(Duration::from_millis(3_000))
            .map_err(CmdError::from)?;
        Ok(conn)
    }

    fn open_existing(dir: &Path, file: &Path, library_id: &str) -> CmdResult<Self> {
        if !file.is_file() {
            return Err(CmdError::io(format!(
                "设备索引还不存在：{}",
                file.display()
            )));
        }
        let conn = Self::connect(file)?;
        // 便宜的完整性检查：真正的损坏（半截文件、页校验失败）在这里就露出来
        let check: String = conn
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(CmdError::from)?;
        if check != "ok" {
            return Err(CmdError::internal(format!("设备索引损坏：{check}")));
        }
        let version = read_meta(&conn, "schema_version")?
            .ok_or_else(|| CmdError::internal("设备索引缺少 schema_version".to_string()))?;
        if version != INDEX_SCHEMA_VERSION.to_string() {
            return Err(CmdError::internal(format!(
                "设备索引 schema 版本是 {version}，本实现是 {INDEX_SCHEMA_VERSION}"
            )));
        }
        let stored = read_meta(&conn, "library_id")?
            .ok_or_else(|| CmdError::internal("设备索引缺少 library_id".to_string()))?;
        if stored != library_id {
            return Err(CmdError::internal(format!(
                "设备索引属于知识库 {stored}，当前是 {library_id}"
            )));
        }
        // 表结构真的在不在，最后确认一次（有人手工删过表也算「坏了」）
        conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get::<_, i64>(0))
            .map_err(CmdError::from)?;
        Ok(Self {
            conn,
            file: file.to_path_buf(),
            dir: dir.to_path_buf(),
            library_id: library_id.to_string(),
        })
    }

    fn create_fresh(dir: &Path, file: &Path, library_id: &str) -> CmdResult<Self> {
        let conn = Self::connect(file)?;
        conn.execute_batch(SCHEMA_SQL).map_err(CmdError::from)?;
        write_meta(&conn, "schema_version", &INDEX_SCHEMA_VERSION.to_string())?;
        write_meta(&conn, "library_id", library_id)?;
        write_meta(&conn, "scan_revision", "0")?;
        write_meta(&conn, "scanned_at_ms", &crate::paths::now_ms().to_string())?;
        Ok(Self {
            conn,
            file: file.to_path_buf(),
            dir: dir.to_path_buf(),
            library_id: library_id.to_string(),
        })
    }

    /// 索引文件路径（`…/index.sqlite`）
    pub fn path(&self) -> &Path {
        &self.file
    }

    /// 索引所在目录（`…/indexes/<libraryId>/`）
    pub fn index_dir(&self) -> &Path {
        &self.dir
    }

    pub fn library_id(&self) -> &str {
        &self.library_id
    }

    /// 索引里记录的扫描代次
    pub fn scan_revision(&self) -> CmdResult<i64> {
        Ok(read_meta(&self.conn, "scan_revision")?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0))
    }

    /// 让命令层把索引代次对齐到会话代次（`state.rs` 的 `generation`）。
    pub fn set_scan_revision(&mut self, revision: i64) -> CmdResult<()> {
        write_meta(&self.conn, "scan_revision", &revision.max(0).to_string())
    }
}

/* ------------------------------- 整表替换 ------------------------------- */

impl IndexHandle {
    /// 用一次扫描的结果**整体替换**索引内容（单事务）。
    ///
    /// 失败时事务回滚：索引要么是上一轮的完整图，要么是这一轮的完整图，
    /// 不会是两者的混合。索引写失败**不影响**已经落盘的资产文件。
    pub fn apply_scan(&mut self, report: &ScanReport) -> CmdResult<()> {
        let next_revision = self.scan_revision()?.saturating_add(1);

        // 「坏 JSON 不被旧缓存覆盖」的另一半：扫描本身**不**把解析失败的目录当成节点
        // （只报一条 metadata_invalid 的问题），但索引不该因此丢掉用户上一次看到的内容——
        // 界面需要能只读地显示「它还在，只是元数据坏了」，并给出文件路径与解析错误。
        //
        // 反过来的方向是**禁止**的：这里保留的是索引里的只读快照，
        // 任何情况下都不会拿它去反写磁盘上的 node.json。
        let previous = self.all_nodes()?;
        let mut retained: Vec<ScannedNode> = Vec::new();
        for issue in &report.issues {
            if issue.code != crate::models::code::METADATA_INVALID
                && issue.code != crate::models::code::METADATA_UNSUPPORTED
            {
                continue;
            }
            let Some(path) = issue.relative_path.as_deref() else {
                continue;
            };
            let Some(folder) = path.strip_suffix(super::vpaths::NODE_MARKER_RELATIVE) else {
                continue;
            };
            let folder = folder.trim_end_matches('/');
            // 这一轮已经正常解析出来的路径，不要被旧快照盖住
            if report.nodes.iter().any(|n| n.relative_path == folder) {
                continue;
            }
            if retained.iter().any(|n| n.relative_path == folder) {
                continue;
            }
            if let Some(old) = previous.iter().find(|n| n.relative_path == folder) {
                let mut stale = old.clone();
                stale.health = issue.code.clone();
                retained.push(stale);
            }
        }

        let tx = self.conn.transaction().map_err(CmdError::from)?;
        tx.execute("DELETE FROM nodes", []).map_err(CmdError::from)?;
        tx.execute("DELETE FROM edges", []).map_err(CmdError::from)?;
        tx.execute("DELETE FROM threads", []).map_err(CmdError::from)?;
        tx.execute("DELETE FROM issues", []).map_err(CmdError::from)?;
        tx.execute("DELETE FROM goals", []).map_err(CmdError::from)?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO nodes (
                        relative_path, id, folder_name, title, aliases_json, status,
                        primary_document, created_at, updated_at, revision, health,
                        meta_sha256, meta_bytes, meta_modified_ms, depth, nested_node_paths_json
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                )
                .map_err(CmdError::from)?;
            for node in report.nodes.iter().chain(retained.iter()) {
                stmt.execute(params![
                    node.relative_path,
                    node.id,
                    node.folder_name,
                    node.title,
                    json_of(&node.aliases)?,
                    node.status.as_str(),
                    node.primary_document,
                    node.created_at,
                    node.updated_at,
                    node.revision,
                    node.health,
                    node.meta_sha256,
                    node.meta_bytes,
                    node.meta_modified_ms,
                    node.depth,
                    json_of(&node.nested_node_paths)?,
                ])
                .map_err(CmdError::from)?;
            }
        }
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO edges (
                        id, from_node_id, to_node_id, relation, relation_type, description,
                        to_title_snapshot, created_at, updated_at, from_relative_path,
                        dangling, evidence_json
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                )
                .map_err(CmdError::from)?;
            for edge in &report.edges {
                stmt.execute(params![
                    edge.id,
                    edge.from_node_id,
                    edge.to_node_id,
                    edge.relation,
                    edge.relation_type,
                    edge.description,
                    edge.to_title_snapshot,
                    edge.created_at,
                    edge.updated_at,
                    edge.from_relative_path,
                    if edge.dangling { 1i64 } else { 0i64 },
                    json_of(&edge.evidence)?,
                ])
                .map_err(CmdError::from)?;
            }
        }
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO threads (
                        id, node_id, title, summary, created_at, updated_at, revision,
                        message_count, node_relative_path
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                )
                .map_err(CmdError::from)?;
            for thread in &report.threads {
                stmt.execute(params![
                    thread.id,
                    thread.node_id,
                    thread.title,
                    thread.summary,
                    thread.created_at,
                    thread.updated_at,
                    thread.revision,
                    thread.message_count,
                    thread.node_relative_path,
                ])
                .map_err(CmdError::from)?;
            }
        }
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO issues (code, severity, relative_path, node_id, detail, parse_position)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                )
                .map_err(CmdError::from)?;
            for issue in &report.issues {
                stmt.execute(params![
                    issue.code,
                    issue.severity,
                    issue.relative_path,
                    issue.node_id,
                    issue.detail,
                    issue.parse_position,
                ])
                .map_err(CmdError::from)?;
            }
        }
        {
            let mut stmt = tx
                .prepare("INSERT INTO goals (id, title, root_node_id, created_at) VALUES (?1,?2,?3,?4)")
                .map_err(CmdError::from)?;
            for goal in &report.goals {
                stmt.execute(params![goal.id, goal.title, goal.root_node_id, goal.created_at])
                    .map_err(CmdError::from)?;
            }
        }

        write_meta_tx(&tx, "scan_revision", &next_revision.to_string())?;
        write_meta_tx(
            &tx,
            "scanned_at_ms",
            &crate::paths::now_ms().to_string(),
        )?;
        write_meta_tx(&tx, "scanned_dirs", &report.scanned_dirs.to_string())?;
        write_meta_tx(&tx, "truncated", if report.truncated { "1" } else { "0" })?;
        tx.commit().map_err(CmdError::from)?;
        Ok(())
    }

    /// 清空全部派生数据，保留 schema 与 `library_id`（重建索引的第一步）。
    pub fn clear(&mut self) -> CmdResult<()> {
        let tx = self.conn.transaction().map_err(CmdError::from)?;
        for table in ["nodes", "edges", "threads", "issues", "goals"] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(CmdError::from)?;
        }
        tx.commit().map_err(CmdError::from)?;
        Ok(())
    }
}

/* --------------------------------- 读取 --------------------------------- */

impl IndexHandle {
    /// 轻量图快照。**不读任何正文**：节点、边、目标、问题都只是元数据。
    pub fn load_graph(&self) -> CmdResult<IndexGraph> {
        Ok(IndexGraph {
            nodes: self.all_nodes()?,
            edges: self.all_edges()?,
            threads: self.all_threads()?,
            goals: self.all_goals()?,
            issues: self.issues()?,
            revision: self.scan_revision()?,
        })
    }

    pub fn node(&self, node_id: &str) -> CmdResult<Option<ScannedNode>> {
        self.query_node(
            "SELECT * FROM nodes WHERE id = ?1 ORDER BY relative_path LIMIT 1",
            params![node_id],
        )
    }

    pub fn node_by_path(&self, relative_path: &str) -> CmdResult<Option<ScannedNode>> {
        self.query_node(
            "SELECT * FROM nodes WHERE relative_path = ?1 LIMIT 1",
            params![relative_path],
        )
    }

    pub fn all_nodes(&self) -> CmdResult<Vec<ScannedNode>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM nodes ORDER BY relative_path")
            .map_err(CmdError::from)?;
        let rows = stmt
            .query_map([], raw_node)
            .map_err(CmdError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CmdError::from)?;
        rows.into_iter().map(RawNode::into_node).collect()
    }

    /// `nodeId` → 相对路径。重复 ID 时给字典序最小的那个（确定性，且两个副本的
    /// `health` 都是 `duplicate_id`，写操作本来就会被挡下）。
    pub fn resolve_path(&self, node_id: &str) -> CmdResult<Option<String>> {
        self.conn
            .query_row(
                "SELECT relative_path FROM nodes WHERE id = ?1 ORDER BY relative_path LIMIT 1",
                params![node_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(CmdError::from)
    }

    pub fn edges_from(&self, node_id: &str) -> CmdResult<Vec<ScannedEdge>> {
        self.query_edges(
            "SELECT * FROM edges WHERE from_node_id = ?1 ORDER BY id",
            params![node_id],
        )
    }

    pub fn edges_to(&self, node_id: &str) -> CmdResult<Vec<ScannedEdge>> {
        self.query_edges(
            "SELECT * FROM edges WHERE to_node_id = ?1 ORDER BY id",
            params![node_id],
        )
    }

    pub fn threads_for_node(&self, node_id: &str) -> CmdResult<Vec<ScannedThread>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM threads WHERE node_id = ?1 ORDER BY id")
            .map_err(CmdError::from)?;
        let rows = stmt
            .query_map(params![node_id], raw_thread)
            .map_err(CmdError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CmdError::from)?;
        Ok(rows.into_iter().map(RawThread::into_thread).collect())
    }

    pub fn thread(&self, thread_id: &str) -> CmdResult<Option<ScannedThread>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM threads WHERE id = ?1 LIMIT 1")
            .map_err(CmdError::from)?;
        let row = stmt
            .query_row(params![thread_id], raw_thread)
            .optional()
            .map_err(CmdError::from)?;
        Ok(row.map(RawThread::into_thread))
    }

    pub fn stats(&self) -> CmdResult<IndexStats> {
        Ok(IndexStats {
            nodes: self.count("nodes")?,
            edges: self.count("edges")?,
            threads: self.count("threads")?,
            issues: self.count("issues")?,
        })
    }

    pub fn issues(&self) -> CmdResult<Vec<ScanIssue>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT code, severity, relative_path, node_id, detail, parse_position
                 FROM issues ORDER BY rowid",
            )
            .map_err(CmdError::from)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ScanIssue {
                    code: row.get(0)?,
                    severity: row.get(1)?,
                    relative_path: row.get(2)?,
                    node_id: row.get(3)?,
                    detail: row.get(4)?,
                    parse_position: row.get(5)?,
                })
            })
            .map_err(CmdError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CmdError::from)?;
        Ok(rows)
    }

    /// 重复 node id 分组。由 `nodes.health = duplicate_id` 派生，
    /// 不再单独存一张表：同一份事实只有一个来源，就不会对不上。
    pub fn duplicate_ids(&self) -> CmdResult<Vec<DuplicateIdGroup>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, relative_path FROM nodes WHERE health = 'duplicate_id'
                 ORDER BY id, relative_path",
            )
            .map_err(CmdError::from)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(CmdError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CmdError::from)?;
        let mut groups: Vec<DuplicateIdGroup> = Vec::new();
        for (node_id, relative_path) in rows {
            match groups.last_mut() {
                Some(group) if group.node_id == node_id => group.relative_paths.push(relative_path),
                _ => groups.push(DuplicateIdGroup {
                    node_id,
                    relative_paths: vec![relative_path],
                }),
            }
        }
        Ok(groups)
    }

    fn all_edges(&self) -> CmdResult<Vec<ScannedEdge>> {
        self.query_edges("SELECT * FROM edges ORDER BY id", [])
    }

    fn all_threads(&self) -> CmdResult<Vec<ScannedThread>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM threads ORDER BY node_relative_path, id")
            .map_err(CmdError::from)?;
        let rows = stmt
            .query_map([], raw_thread)
            .map_err(CmdError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CmdError::from)?;
        Ok(rows.into_iter().map(RawThread::into_thread).collect())
    }

    fn all_goals(&self) -> CmdResult<Vec<super::schema::GoalEntry>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, title, root_node_id, created_at FROM goals ORDER BY created_at, id")
            .map_err(CmdError::from)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(super::schema::GoalEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    root_node_id: row.get(2)?,
                    created_at: row.get(3)?,
                    extra: serde_json::Map::new(),
                })
            })
            .map_err(CmdError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CmdError::from)?;
        Ok(rows)
    }

    fn count(&self, table: &str) -> CmdResult<i64> {
        self.conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(CmdError::from)
    }

    fn query_node<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> CmdResult<Option<ScannedNode>> {
        let mut stmt = self.conn.prepare(sql).map_err(CmdError::from)?;
        let row = stmt
            .query_row(params, raw_node)
            .optional()
            .map_err(CmdError::from)?;
        match row {
            Some(raw) => Ok(Some(raw.into_node()?)),
            None => Ok(None),
        }
    }

    fn query_edges<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> CmdResult<Vec<ScannedEdge>> {
        let mut stmt = self.conn.prepare(sql).map_err(CmdError::from)?;
        let rows = stmt
            .query_map(params, raw_edge)
            .map_err(CmdError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CmdError::from)?;
        rows.into_iter().map(RawEdge::into_edge).collect()
    }
}

/* --------------------------------- 增量 --------------------------------- */

impl IndexHandle {
    /// 单节点 upsert。
    ///
    /// 键是 `relative_path`（一次扫描里一个目录最多一个节点），
    /// 所以**文件夹改名/移动要走整体重扫**：只有路径没变时才用它。
    /// 这也是设计文档 §5.2 要求「rename 之后重新扫描按 node ID 重定位」的原因。
    pub fn upsert_node(&mut self, node: &ScannedNode) -> CmdResult<()> {
        self.conn
            .execute(
                "INSERT INTO nodes (
                    relative_path, id, folder_name, title, aliases_json, status,
                    primary_document, created_at, updated_at, revision, health,
                    meta_sha256, meta_bytes, meta_modified_ms, depth, nested_node_paths_json
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                 ON CONFLICT(relative_path) DO UPDATE SET
                    id = excluded.id,
                    folder_name = excluded.folder_name,
                    title = excluded.title,
                    aliases_json = excluded.aliases_json,
                    status = excluded.status,
                    primary_document = excluded.primary_document,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    revision = excluded.revision,
                    health = excluded.health,
                    meta_sha256 = excluded.meta_sha256,
                    meta_bytes = excluded.meta_bytes,
                    meta_modified_ms = excluded.meta_modified_ms,
                    depth = excluded.depth,
                    nested_node_paths_json = excluded.nested_node_paths_json",
                params![
                    node.relative_path,
                    node.id,
                    node.folder_name,
                    node.title,
                    json_of(&node.aliases)?,
                    node.status.as_str(),
                    node.primary_document,
                    node.created_at,
                    node.updated_at,
                    node.revision,
                    node.health,
                    node.meta_sha256,
                    node.meta_bytes,
                    node.meta_modified_ms,
                    node.depth,
                    json_of(&node.nested_node_paths)?,
                ],
            )
            .map_err(CmdError::from)?;
        Ok(())
    }

    pub fn upsert_thread(&mut self, thread: &ScannedThread) -> CmdResult<()> {
        self.conn
            .execute(
                "INSERT INTO threads (
                    id, node_id, title, summary, created_at, updated_at, revision,
                    message_count, node_relative_path
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(id) DO UPDATE SET
                    node_id = excluded.node_id,
                    title = excluded.title,
                    summary = excluded.summary,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    revision = excluded.revision,
                    message_count = excluded.message_count,
                    node_relative_path = excluded.node_relative_path",
                params![
                    thread.id,
                    thread.node_id,
                    thread.title,
                    thread.summary,
                    thread.created_at,
                    thread.updated_at,
                    thread.revision,
                    thread.message_count,
                    thread.node_relative_path,
                ],
            )
            .map_err(CmdError::from)?;
        Ok(())
    }

    pub fn remove_thread(&mut self, thread_id: &str) -> CmdResult<()> {
        self.conn
            .execute("DELETE FROM threads WHERE id = ?1", params![thread_id])
            .map_err(CmdError::from)?;
        Ok(())
    }

    /// 替换某个源节点的全部出边（改接、删除边之后调用）。
    pub fn replace_edges_from(&mut self, node_id: &str, edges: &[ScannedEdge]) -> CmdResult<()> {
        let tx = self.conn.transaction().map_err(CmdError::from)?;
        tx.execute("DELETE FROM edges WHERE from_node_id = ?1", params![node_id])
            .map_err(CmdError::from)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO edges (
                        id, from_node_id, to_node_id, relation, relation_type, description,
                        to_title_snapshot, created_at, updated_at, from_relative_path,
                        dangling, evidence_json
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                )
                .map_err(CmdError::from)?;
            for edge in edges {
                stmt.execute(params![
                    edge.id,
                    edge.from_node_id,
                    edge.to_node_id,
                    edge.relation,
                    edge.relation_type,
                    edge.description,
                    edge.to_title_snapshot,
                    edge.created_at,
                    edge.updated_at,
                    edge.from_relative_path,
                    if edge.dangling { 1i64 } else { 0i64 },
                    json_of(&edge.evidence)?,
                ])
                .map_err(CmdError::from)?;
            }
        }
        tx.commit().map_err(CmdError::from)?;
        Ok(())
    }
}

/* ------------------------------ 行 ↔ 模型 ------------------------------ */

fn json_of<T: Serialize>(value: &T) -> CmdResult<String> {
    serde_json::to_string(value)
        .map_err(|e| CmdError::internal(format!("索引序列化失败：{e}")))
}

fn parse_json<T: for<'de> Deserialize<'de>>(text: &str, what: &str) -> CmdResult<T> {
    serde_json::from_str(text)
        .map_err(|e| CmdError::internal(format!("设备索引里的 {what} 解析失败（删除索引即可重建）：{e}")))
}

fn read_meta(conn: &Connection, key: &str) -> CmdResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM index_meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(CmdError::from)
}

fn write_meta(conn: &Connection, key: &str, value: &str) -> CmdResult<()> {
    conn.execute(
        "INSERT INTO index_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(CmdError::from)?;
    Ok(())
}

fn write_meta_tx(tx: &Transaction<'_>, key: &str, value: &str) -> CmdResult<()> {
    tx.execute(
        "INSERT INTO index_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(CmdError::from)?;
    Ok(())
}

struct RawNode {
    id: String,
    relative_path: String,
    folder_name: String,
    title: String,
    aliases_json: String,
    status: String,
    primary_document: Option<String>,
    created_at: String,
    updated_at: String,
    revision: i64,
    health: String,
    meta_sha256: String,
    meta_bytes: i64,
    meta_modified_ms: i64,
    depth: i64,
    nested_node_paths_json: String,
}

impl RawNode {
    fn into_node(self) -> CmdResult<ScannedNode> {
        Ok(ScannedNode {
            id: self.id,
            relative_path: self.relative_path,
            folder_name: self.folder_name,
            title: self.title,
            aliases: parse_json(&self.aliases_json, "aliases")?,
            status: LearnStatus::from_db(&self.status),
            primary_document: self.primary_document,
            created_at: self.created_at,
            updated_at: self.updated_at,
            revision: self.revision,
            health: self.health,
            meta_sha256: self.meta_sha256,
            meta_bytes: self.meta_bytes,
            meta_modified_ms: self.meta_modified_ms,
            depth: self.depth,
            nested_node_paths: parse_json(&self.nested_node_paths_json, "nestedNodePaths")?,
        })
    }
}

fn raw_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawNode> {
    Ok(RawNode {
        relative_path: row.get("relative_path")?,
        id: row.get("id")?,
        folder_name: row.get("folder_name")?,
        title: row.get("title")?,
        aliases_json: row.get("aliases_json")?,
        status: row.get("status")?,
        primary_document: row.get("primary_document")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        revision: row.get("revision")?,
        health: row.get("health")?,
        meta_sha256: row.get("meta_sha256")?,
        meta_bytes: row.get("meta_bytes")?,
        meta_modified_ms: row.get("meta_modified_ms")?,
        depth: row.get("depth")?,
        nested_node_paths_json: row.get("nested_node_paths_json")?,
    })
}

struct RawEdge {
    id: String,
    from_node_id: String,
    to_node_id: String,
    relation: String,
    relation_type: String,
    description: String,
    to_title_snapshot: String,
    created_at: String,
    updated_at: String,
    from_relative_path: String,
    dangling: i64,
    evidence_json: String,
}

impl RawEdge {
    fn into_edge(self) -> CmdResult<ScannedEdge> {
        Ok(ScannedEdge {
            id: self.id,
            from_node_id: self.from_node_id,
            to_node_id: self.to_node_id,
            relation: self.relation,
            relation_type: self.relation_type,
            description: self.description,
            to_title_snapshot: self.to_title_snapshot,
            created_at: self.created_at,
            updated_at: self.updated_at,
            from_relative_path: self.from_relative_path,
            dangling: self.dangling != 0,
            evidence: parse_json::<Vec<Evidence>>(&self.evidence_json, "evidence")?,
        })
    }
}

fn raw_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawEdge> {
    Ok(RawEdge {
        id: row.get("id")?,
        from_node_id: row.get("from_node_id")?,
        to_node_id: row.get("to_node_id")?,
        relation: row.get("relation")?,
        relation_type: row.get("relation_type")?,
        description: row.get("description")?,
        to_title_snapshot: row.get("to_title_snapshot")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        from_relative_path: row.get("from_relative_path")?,
        dangling: row.get("dangling")?,
        evidence_json: row.get("evidence_json")?,
    })
}

struct RawThread {
    id: String,
    node_id: String,
    title: String,
    summary: String,
    created_at: String,
    updated_at: String,
    revision: i64,
    message_count: i64,
    node_relative_path: String,
}

impl RawThread {
    fn into_thread(self) -> ScannedThread {
        ScannedThread {
            id: self.id,
            node_id: self.node_id,
            title: self.title,
            summary: self.summary,
            created_at: self.created_at,
            updated_at: self.updated_at,
            revision: self.revision,
            message_count: self.message_count,
            node_relative_path: self.node_relative_path,
        }
    }
}

fn raw_thread(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawThread> {
    Ok(RawThread {
        id: row.get("id")?,
        node_id: row.get("node_id")?,
        title: row.get("title")?,
        summary: row.get("summary")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        revision: row.get("revision")?,
        message_count: row.get("message_count")?,
        node_relative_path: row.get("node_relative_path")?,
    })
}

/* ---------------------------------- 测试 ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::schema::LibraryManifest;
    use crate::v2::scanner::{self, ScanOptions};

    const LIB: &str = "01990000-0000-7000-8000-000000000001";

    fn fixture_root(group: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join("v2")
            .join(group)
    }

    fn scan(group: &str) -> (PathBuf, ScanReport) {
        let root = fixture_root(group);
        let manifest = LibraryManifest::new(
            LIB.to_string(),
            "夹具库".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        );
        let report = scanner::scan_library(&root, &manifest, &ScanOptions { full: true }).unwrap();
        (root, report)
    }

    #[test]
    fn index_survives_being_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("indexes").join(LIB);
        let (_root, report) = scan("nested");

        let first = {
            let mut handle = IndexHandle::open(&dir, LIB).unwrap();
            handle.apply_scan(&report).unwrap();
            handle.load_graph().unwrap()
        };
        assert!(index_file_path(&dir).is_file(), "索引落在 dir/index.sqlite");

        std::fs::remove_file(dir.join(INDEX_FILE_NAME)).unwrap();
        let second = {
            let mut handle = IndexHandle::open(&dir, LIB).unwrap();
            handle.apply_scan(&report).unwrap();
            handle.load_graph().unwrap()
        };
        assert_eq!(first.nodes, second.nodes);
        assert_eq!(first.edges, second.edges);
        assert_eq!(first.issues, second.issues);
    }

    #[test]
    fn wrong_library_id_rebuilds_the_index() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("idx");
        let (_root, report) = scan("minimal");
        {
            let mut handle = IndexHandle::open(&dir, LIB).unwrap();
            handle.apply_scan(&report).unwrap();
        }
        let other = "01990000-0000-7000-8000-0000000000ff";
        let handle = IndexHandle::open(&dir, other).unwrap();
        assert_eq!(handle.library_id(), other);
        assert_eq!(handle.stats().unwrap().nodes, 0, "换了库必须重建而不是复用");
    }

    #[test]
    fn corrupted_file_is_replaced_not_repaired() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("idx");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INDEX_FILE_NAME), b"this is not a database").unwrap();
        let mut handle = IndexHandle::open(&dir, LIB).unwrap();
        let (_root, report) = scan("minimal");
        handle.apply_scan(&report).unwrap();
        assert_eq!(handle.stats().unwrap().nodes, 1);
    }

    #[test]
    fn apply_scan_replaces_everything_in_one_transaction() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("idx");
        let mut handle = IndexHandle::open(&dir, LIB).unwrap();
        let (_root, nested) = scan("nested");
        handle.apply_scan(&nested).unwrap();
        assert_eq!(handle.stats().unwrap().nodes, 2);
        let (_root, minimal) = scan("minimal");
        handle.apply_scan(&minimal).unwrap();
        assert_eq!(handle.stats().unwrap().nodes, 1, "整表替换，不留上一轮的节点");
        assert_eq!(handle.stats().unwrap().edges, 0);
    }

    #[test]
    fn incremental_operations_keep_the_graph_consistent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("idx");
        let mut handle = IndexHandle::open(&dir, LIB).unwrap();
        let (_root, report) = scan("dangling-target");
        handle.apply_scan(&report).unwrap();

        let mut node = handle.node_by_path("Source").unwrap().unwrap();
        assert_eq!(handle.resolve_path(&node.id).unwrap().as_deref(), Some("Source"));

        node.title = "改过的标题".to_string();
        handle.upsert_node(&node).unwrap();
        assert_eq!(
            handle.node_by_path("Source").unwrap().unwrap().title,
            "改过的标题"
        );

        let edges = handle.edges_from(&node.id).unwrap();
        assert!(edges[0].dangling);
        assert_eq!(handle.edges_to(&edges[0].to_node_id).unwrap().len(), 1);

        handle.replace_edges_from(&node.id, &[]).unwrap();
        assert!(handle.edges_from(&node.id).unwrap().is_empty());

        let thread = ScannedThread {
            id: "0199ffff-0000-7000-8000-0000000000aa".to_string(),
            node_id: node.id.clone(),
            title: "数学推导".to_string(),
            summary: String::new(),
            created_at: "2026-09-20T10:00:00.000Z".to_string(),
            updated_at: "2026-09-20T10:00:00.000Z".to_string(),
            revision: 1,
            message_count: 3,
            node_relative_path: node.relative_path.clone(),
        };
        handle.upsert_thread(&thread).unwrap();
        assert_eq!(handle.threads_for_node(&node.id).unwrap().len(), 1);
        assert_eq!(handle.thread(&thread.id).unwrap().unwrap().message_count, 3);
        handle.remove_thread(&thread.id).unwrap();
        assert!(handle.thread(&thread.id).unwrap().is_none());
    }

    #[test]
    fn index_path_accepts_dir_or_file() {
        let dir = PathBuf::from("/tmp/idx");
        assert_eq!(index_file_path(&dir), dir.join(INDEX_FILE_NAME));
        let (parsed_dir, parsed_file) = split_index_path(&dir);
        assert_eq!(parsed_dir, dir);
        assert_eq!(parsed_file, dir.join(INDEX_FILE_NAME));
        let file = dir.join(INDEX_FILE_NAME);
        let (parsed_dir, parsed_file) = split_index_path(&file);
        assert_eq!(parsed_dir, dir);
        assert_eq!(parsed_file, file);
    }
}
