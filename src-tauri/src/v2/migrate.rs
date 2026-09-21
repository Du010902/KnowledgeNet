//! v1 → v2 一次性迁移：恢复点 → 转换 → 重扫比对 → **只在全部一致后**发布（契约 §3.12）。
//!
//! 步骤严格按设计文档 §10.2 的十二步，其中**第 11 步（改写 `library.json` 的
//! `formatVersion`）是唯一发布点**：
//!
//! ```text
//! 1  只读打开 knowledge.sqlite；有未完成的 file_operations 就停（先跑旧恢复逻辑）
//! 2  read_only 会话直接拒绝（独占写锁由调用方负责）
//! 3  .knowledgenet/recovery/pre-v2-<时间戳>/ 建立恢复点（knowledge.sqlite + library.json）
//! 4  读 v1 全部权威数据，得到 before 计数
//! 5  每个节点写 .meta/knowledgenet/node.json
//! 6  按 from_node_id 分组写 relations.json（discoveries → evidence）
//! 7  写 chats/<threadId>/{thread.json,messages/<6 位序号>_<id>.json}
//! 8  写 bookmarks.json / resources.json；note.md 与 files 下的附件原地保留
//! 9  goals 写进 .knowledgenet/goals.json
//! 10 从新文件完整重扫，逐项比对计数（不一致 → 整体失败、不发布）
//! 11 全部一致后才把 library.json.formatVersion 原子改成 2   ← 发布点
//! 12 旧 knowledge.sqlite 移到 .knowledgenet/legacy/knowledge-v1.sqlite（重名加序号）
//! ```
//!
//! 失败语义：第 11 步之前任何失败，`library.json` 必须仍是 v1（旧版仍能打开）。
//! 迁移产生的中间文件允许残留（错误详情里说明位置），但**绝不覆盖任何用户内容**：
//! 目标位置已有「不是本次迁移写的」文件时，宁可整体失败。
//!
//! 本模块**不依赖** `db.rs`：v1 的 SQL 与结构在这里就地重写，
//! 这样 Lead 删掉旧模块时迁移不会跟着碎掉。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::models::{code, CmdError, CmdResult, LearnStatus};
use crate::paths;

use super::atomic;
use super::chats;
use super::schema::{
    self, BookmarkEntry, BookmarksFile, Evidence, GoalEntry, GoalsFile, LibraryManifest,
    MessageFile, MessageStatus, NodeMeta, RelationEdge, RelationsFile, ResourceEntry,
    ResourcesFile, ThreadFile, Validate, BOOKMARKS_FORMAT, BOOKMARKS_FORMAT_VERSION, GOALS_FORMAT,
    GOALS_FORMAT_VERSION, LIBRARY_FORMAT, LIBRARY_FORMAT_VERSION, MESSAGE_FORMAT,
    MESSAGE_FORMAT_VERSION, NODE_FORMAT, NODE_FORMAT_VERSION, RELATIONS_FORMAT,
    RELATIONS_FORMAT_VERSION, RESOURCES_FORMAT, RESOURCES_FORMAT_VERSION, THREAD_FORMAT,
    THREAD_FORMAT_VERSION,
};
use super::vpaths;

/* --------------------------------- 对外类型 --------------------------------- */

/// 迁移前后必须逐项相等的计数。任何一项不等都拒绝发布。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCounts {
    pub nodes: i64,
    pub edges: i64,
    pub goals: i64,
    pub threads: i64,
    pub messages: i64,
    /// 写进 `relations.json` 的 evidence 条数（没有对应关系的 discoveries 走 `warnings`）
    pub discoveries: i64,
    pub bookmarks: i64,
    pub resources: i64,
    /// 有 `primaryDocument` 的节点数
    pub notes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub from_version: i64,
    pub to_version: i64,
    /// 恢复点相对知识库根的路径（`v2` 无需迁移时是空字符串）
    pub recovery_relative: String,
    pub before: MigrationCounts,
    pub after: MigrationCounts,
    pub warnings: Vec<String>,
    /// 第 10 步重扫比对是否通过
    pub verified: bool,
    /// 第 11 步是否已经把 `library.json` 改成 v2（唯一发布点）
    pub published: bool,
}

/* -------------------------------- 版本探测 -------------------------------- */

/// 读 `library.json`：1 = 需要迁移的 v1，2 = 已是 v2。
///
/// 其它版本（未来格式、0、负数）返回 `metadata_unsupported`：
/// 猜着迁移一个不认识的库比拒绝它危险得多。
pub fn detect_version(root: &Path) -> CmdResult<i64> {
    let path = root.join(paths::MANIFEST_NAME);
    if !path.is_file() {
        return Err(CmdError::not_found(format!(
            "{} 不是 KnowledgeNet 知识库：找不到 {}",
            root.display(),
            paths::MANIFEST_NAME
        )));
    }
    let text = atomic::read_text(&path)?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("{} 不是合法的 JSON：{e}", path.display()),
        )
    })?;
    let format = value
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if format != LIBRARY_FORMAT {
        return Err(CmdError::new(
            code::METADATA_UNSUPPORTED,
            format!("这不是 KnowledgeNet 知识库：library.json 的 format 是「{format}」"),
        ));
    }
    let version = value
        .get("formatVersion")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    match version {
        1 => Ok(1),
        2 => Ok(2),
        other => Err(CmdError::new(
            code::METADATA_UNSUPPORTED,
            format!(
                "library.json 的 formatVersion 是 {other}，本实现只认识 1（v1，需要迁移）与 2（v2）"
            ),
        )),
    }
}

/* -------------------------------- 迁移主流程 -------------------------------- */

/// 一次性的 v1 → v2 迁移。调用方负责独占写锁（函数内只拒绝 `read_only` 会话）。
pub fn migrate_v1_to_v2(root: &Path, read_only: bool) -> CmdResult<MigrationReport> {
    // 第 2 步（提前到这里 fail fast）：只读会话不能迁移
    if read_only {
        return Err(CmdError::read_only());
    }
    let root_paths = paths::LibraryPaths::for_existing(root)?;
    let root_path = root_paths.root().to_path_buf();

    let from_version = detect_version(&root_path)?;
    if from_version == 2 {
        // 幂等：已经是 v2 就什么都不做，也不重复转换
        let mut issues: Vec<String> = Vec::new();
        let counts = rescan(&root_path, &mut issues)?;
        let mut warnings =
            vec!["知识库已经是 v2（formatVersion=2），无需迁移；本次没有写入任何文件。".to_string()];
        warnings.extend(issues);
        return Ok(MigrationReport {
            from_version: 2,
            to_version: 2,
            recovery_relative: String::new(),
            before: counts,
            after: counts,
            warnings,
            verified: true,
            published: false,
        });
    }

    // 第 1 步：只读打开 v1 数据库，并确认没有未完成的文件操作
    let db_path = vpaths::database_file(&root_path);
    if !db_path.is_file() {
        return Err(CmdError::not_found(format!(
            "知识库的 formatVersion 是 1，但找不到 v1 数据库：{}。请先用旧版本打开一次，或从备份恢复。",
            db_path.display()
        )));
    }
    let conn = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| CmdError::io(format!("只读打开 {} 失败：{e}", db_path.display())))?;
    ensure_v1_schema(&conn)?;
    ensure_no_pending_operations(&conn)?;

    // 第 3 步：恢复点（先有退路，再动数据）
    let stamp = format!("pre-v2-{}", recovery_stamp());
    let recovery = vpaths::recovery_dir(&root_path, &stamp);
    atomic::ensure_dir(&recovery)?;
    let mut warnings: Vec<String> = Vec::new();
    copy_recovery_point(&conn, &db_path, &root_path, &recovery, &mut warnings)?;
    let recovery_relative = vpaths::relative_path_string(&root_path, &recovery)
        .unwrap_or_else(|| recovery.display().to_string());

    // 第 4 步：读 v1 全部权威数据
    let manifest = read_manifest(&root_path)?;
    let data = match read_v1(&conn) {
        Ok(data) => data,
        Err(err) => return Err(unpublished(err, "read", &recovery_relative)),
    };

    // 第 5–9 步：写开放文件
    let before = match convert(&root_path, &manifest, &data, &mut warnings) {
        Ok(counts) => counts,
        Err(err) => return Err(unpublished(err, "convert", &recovery_relative)),
    };

    // 第 10 步：从新文件完整重扫并逐项比对
    let after = match verify(&root_path, &before, &mut warnings) {
        Ok(counts) => counts,
        Err(err) => return Err(unpublished(err, "verify", &recovery_relative)),
    };

    // 第 11 步：唯一发布点
    publish(&root_path, &manifest).map_err(|err| unpublished(err, "publish", &recovery_relative))?;

    // 第 12 步：旧数据库归档（暂不删除）
    drop(conn);
    if let Err(err) = archive_legacy_database(&root_path, &db_path) {
        warnings.push(format!(
            "v2 已经发布，但旧数据库移动失败：{}。请手工把 {} 移到 {}/ 下（旧文件留在原位不影响 v2 使用）。",
            err.message,
            db_path.display(),
            vpaths::legacy_dir(&root_path).display()
        ));
    }

    Ok(MigrationReport {
        from_version: 1,
        to_version: 2,
        recovery_relative,
        before,
        after,
        warnings,
        verified: true,
        published: true,
    })
}

/// 失败时把「没有发布」这件事说清楚：用户最需要知道的是「旧版还能打开」。
fn unpublished(err: CmdError, stage: &str, recovery_relative: &str) -> CmdError {
    CmdError::new(
        &err.code,
        format!(
            "迁移未发布（library.json 仍是 v1，旧版本仍能正常打开）：{}",
            err.message
        ),
    )
    .with_detail(serde_json::json!({
        "stage": stage,
        "recoveryRelativePath": recovery_relative,
        "note": "迁移已经写出的中间文件可能残留在节点 .meta/knowledgenet 目录下；\
                 重试时只会覆盖迁移自己写的文件，不会覆盖用户内容。",
        "cause": err.detail,
    }))
}

/* ------------------------------ 恢复点与归档 ------------------------------ */

fn recovery_stamp() -> String {
    // Windows 文件名不允许冒号
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(':', "-")
}

fn copy_recovery_point(
    conn: &Connection,
    db_path: &Path,
    root: &Path,
    recovery: &Path,
    warnings: &mut Vec<String>,
) -> CmdResult<()> {
    let manifest_src = root.join(paths::MANIFEST_NAME);
    let manifest_dst = recovery.join(paths::MANIFEST_NAME);
    fs::copy(&manifest_src, &manifest_dst).map_err(|e| {
        CmdError::io(format!(
            "复制 {} 到恢复点失败：{e}",
            manifest_src.display()
        ))
    })?;

    let db_dst = recovery.join(vpaths::DATABASE_NAME);
    // 优先 VACUUM INTO：单文件、且包含 WAL 里已提交但尚未 checkpoint 的内容。
    // 失败则退回「文件复制 + 一并复制 -wal/-shm」，两条路都能得到一个可用的恢复点。
    let escaped = db_dst.display().to_string().replace('\'', "''");
    let vacuum = conn.execute(&format!("VACUUM INTO '{escaped}'"), []);
    if let Err(err) = vacuum {
        warnings.push(format!(
            "VACUUM INTO 建立恢复点失败（{err}），已改用文件复制（可能不含 WAL 里未 checkpoint 的提交）"
        ));
        if db_dst.exists() {
            paths::remove_file_if_exists(&db_dst)?;
        }
        fs::copy(db_path, &db_dst).map_err(|e| {
            CmdError::io(format!("复制 {} 到恢复点失败：{e}", db_path.display()))
        })?;
        for suffix in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{}", db_path.display(), suffix));
            if side.is_file() {
                let side_dst = recovery.join(format!("{}{}", vpaths::DATABASE_NAME, suffix));
                fs::copy(&side, &side_dst).map_err(|e| {
                    CmdError::io(format!("复制 {} 到恢复点失败：{e}", side.display()))
                })?;
            }
        }
    }

    // 恢复点必须真的能用：节点数对不上就整体中止（此刻还没写任何 v2 文件）
    let check = Connection::open_with_flags(&db_dst, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| CmdError::io(format!("恢复点数据库打不开（{}）：{e}", db_dst.display())))?;
    let source_nodes: i64 = conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))?;
    let copied_nodes: i64 = check
        .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
        .map_err(|e| CmdError::io(format!("恢复点数据库读不出 nodes 表：{e}")))?;
    drop(check);
    if source_nodes != copied_nodes {
        return Err(CmdError::io(format!(
            "恢复点数据库不完整（节点数 {copied_nodes} ≠ {source_nodes}），已中止迁移"
        )));
    }
    Ok(())
}

fn archive_legacy_database(root: &Path, db_path: &Path) -> CmdResult<PathBuf> {
    atomic::ensure_dir(&vpaths::legacy_dir(root))?;
    let target = unique_path(&vpaths::legacy_database(root));
    // 绝不覆盖已有文件（重名时加序号）
    paths::move_no_overwrite(db_path, &target)?;
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{}", db_path.display(), suffix));
        if side.is_file() {
            let side_target = PathBuf::from(format!("{}{}", target.display(), suffix));
            paths::move_no_overwrite(&side, &side_target)?;
        }
    }
    Ok(target)
}

/// `base` 已被占用时依次尝试 `stem-2.ext`、`stem-3.ext`…
fn unique_path(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_path_buf();
    }
    let stem = base
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "legacy".to_string());
    let ext = base
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for index in 2..10_000 {
        let name = if ext.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{ext}")
        };
        let candidate = base.with_file_name(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    base.to_path_buf()
}

/* -------------------------------- v1 前置检查 -------------------------------- */

const REQUIRED_V1_TABLES: &[&str] = &[
    "nodes",
    "node_aliases",
    "node_documents",
    "edges",
    "goals",
    "chat_threads",
    "chat_messages",
    "discoveries",
    "bookmarks",
    "node_resources",
    "file_operations",
];

fn ensure_v1_schema(conn: &Connection) -> CmdResult<()> {
    let mut missing: Vec<&str> = Vec::new();
    for table in REQUIRED_V1_TABLES {
        let found: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        if found == 0 {
            missing.push(table);
        }
    }
    if !missing.is_empty() {
        return Err(CmdError::new(
            code::METADATA_INVALID,
            format!(
                "knowledge.sqlite 缺少 v1 结构（{}），这不是一个可以迁移的 v1 知识库",
                missing.join("、")
            ),
        ));
    }
    Ok(())
}

/// `file_operations` 里只要还有没走到 `cleaned` 的记录，就说明上一次文件操作没走完。
/// 此时迁移等于在「半成品状态」上再叠一层，必须先让旧版本的恢复逻辑收尾。
fn ensure_no_pending_operations(conn: &Connection) -> CmdResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, operation_type, phase, COALESCE(last_error, '')
         FROM file_operations
         WHERE phase <> 'cleaned'
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.is_empty() {
        return Ok(());
    }
    let pending: Vec<serde_json::Value> = rows
        .iter()
        .map(|(id, kind, phase, last_error)| {
            serde_json::json!({
                "id": id,
                "operationType": kind,
                "phase": phase,
                "lastError": last_error,
            })
        })
        .collect();
    Err(CmdError::new(
        code::CONFLICT,
        format!(
            "v1 数据库里还有 {} 条未完成的文件操作，请先用旧版本打开一次知识库让恢复流程收尾，再迁移",
            rows.len()
        ),
    )
    .with_detail(serde_json::json!({ "pendingOperations": pending })))
}

/* -------------------------------- v1 数据读取 -------------------------------- */

#[derive(Debug, Clone)]
struct V1Node {
    id: String,
    title: String,
    status: String,
    storage_relpath: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    merged_into_id: Option<String>,
}

#[derive(Debug, Clone)]
struct V1Document {
    node_id: String,
    kind: String,
    relative_path: String,
    revision: i64,
}

#[derive(Debug, Clone)]
struct V1Edge {
    id: String,
    from_node_id: String,
    to_node_id: String,
    relation_type: String,
    description: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct V1Goal {
    id: String,
    title: String,
    root_node_id: String,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct V1Thread {
    id: String,
    node_id: String,
    title: String,
    summary: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct V1Message {
    id: String,
    thread_id: String,
    role: String,
    content: String,
    status: String,
    finish_reason: Option<String>,
    request_id: Option<String>,
    usage: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct V1Discovery {
    id: String,
    edge_id: Option<String>,
    thread_id: Option<String>,
    message_id: Option<String>,
    snippet: String,
    question: String,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct V1Bookmark {
    id: String,
    node_id: String,
    thread_id: Option<String>,
    message_id: Option<String>,
    scroll_offset: f64,
    question: String,
    return_node_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone)]
struct V1Resource {
    id: String,
    node_id: String,
    resource_type: String,
    relative_path: Option<String>,
    source_url: Option<String>,
    original_name: String,
    display_name: String,
    mime_type: String,
    byte_length: i64,
    sha256: String,
    description: String,
    sort_order: i64,
    state: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

#[derive(Debug, Default)]
struct V1Data {
    nodes: Vec<V1Node>,
    aliases: BTreeMap<String, Vec<String>>,
    documents: Vec<V1Document>,
    edges: Vec<V1Edge>,
    goals: Vec<V1Goal>,
    threads: Vec<V1Thread>,
    messages: Vec<V1Message>,
    discoveries: Vec<V1Discovery>,
    bookmarks: Vec<V1Bookmark>,
    resources: Vec<V1Resource>,
    library_settings: i64,
    app_meta: i64,
    sessions: i64,
}

fn count_rows(conn: &Connection, table: &str) -> CmdResult<i64> {
    // table 只来自本文件的常量列表，不存在注入面
    let sql = format!("SELECT COUNT(*) FROM {table}");
    Ok(conn.query_row(&sql, [], |row| row.get(0))?)
}

fn read_v1(conn: &Connection) -> CmdResult<V1Data> {
    let mut data = V1Data::default();

    {
        let mut stmt = conn.prepare(
            "SELECT id, title, status, storage_relpath, created_at, updated_at, deleted_at, merged_into_id
             FROM nodes ORDER BY created_at, id",
        )?;
        data.nodes = stmt
            .query_map([], |row| {
                Ok(V1Node {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    status: row.get(2)?,
                    storage_relpath: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    deleted_at: row.get(6)?,
                    merged_into_id: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt = conn.prepare(
            "SELECT node_id, alias FROM node_aliases ORDER BY node_id, normalized_alias",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (node_id, alias) in rows {
            data.aliases.entry(node_id).or_default().push(alias);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT node_id, kind, relative_path, revision FROM node_documents ORDER BY node_id, kind",
        )?;
        data.documents = stmt
            .query_map([], |row| {
                Ok(V1Document {
                    node_id: row.get(0)?,
                    kind: row.get(1)?,
                    relative_path: row.get(2)?,
                    revision: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, from_node_id, to_node_id, relation_type, description, created_at, updated_at
             FROM edges ORDER BY created_at, id",
        )?;
        data.edges = stmt
            .query_map([], |row| {
                Ok(V1Edge {
                    id: row.get(0)?,
                    from_node_id: row.get(1)?,
                    to_node_id: row.get(2)?,
                    relation_type: row.get(3)?,
                    description: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt =
            conn.prepare("SELECT id, title, root_node_id, created_at FROM goals ORDER BY created_at, id")?;
        data.goals = stmt
            .query_map([], |row| {
                Ok(V1Goal {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    root_node_id: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, node_id, title, summary, created_at, updated_at
             FROM chat_threads ORDER BY created_at, id",
        )?;
        data.threads = stmt
            .query_map([], |row| {
                Ok(V1Thread {
                    id: row.get(0)?,
                    node_id: row.get(1)?,
                    title: row.get(2)?,
                    summary: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, thread_id, role, content, status, finish_reason, request_id, usage, created_at
             FROM chat_messages ORDER BY seq",
        )?;
        data.messages = stmt
            .query_map([], |row| {
                Ok(V1Message {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    status: row.get(4)?,
                    finish_reason: row.get(5)?,
                    request_id: row.get(6)?,
                    usage: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, edge_id, thread_id, message_id, snippet, question, created_at
             FROM discoveries ORDER BY created_at, id",
        )?;
        data.discoveries = stmt
            .query_map([], |row| {
                Ok(V1Discovery {
                    id: row.get(0)?,
                    edge_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    message_id: row.get(3)?,
                    snippet: row.get(4)?,
                    question: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, node_id, thread_id, message_id, scroll_offset, question, return_node_id,
                    created_at, updated_at
             FROM bookmarks ORDER BY updated_at DESC, id",
        )?;
        data.bookmarks = stmt
            .query_map([], |row| {
                Ok(V1Bookmark {
                    id: row.get(0)?,
                    node_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    message_id: row.get(3)?,
                    scroll_offset: row.get(4)?,
                    question: row.get(5)?,
                    return_node_id: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, node_id, resource_type, relative_path, source_url, original_name,
                    display_name, mime_type, byte_length, sha256, description, sort_order,
                    state, created_at, updated_at, deleted_at
             FROM node_resources ORDER BY node_id, sort_order, created_at, id",
        )?;
        data.resources = stmt
            .query_map([], |row| {
                Ok(V1Resource {
                    id: row.get(0)?,
                    node_id: row.get(1)?,
                    resource_type: row.get(2)?,
                    relative_path: row.get(3)?,
                    source_url: row.get(4)?,
                    original_name: row.get(5)?,
                    display_name: row.get(6)?,
                    mime_type: row.get(7)?,
                    byte_length: row.get(8)?,
                    sha256: row.get(9)?,
                    description: row.get(10)?,
                    sort_order: row.get(11)?,
                    state: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                    deleted_at: row.get(15)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }

    data.library_settings = count_rows(conn, "library_settings")?;
    data.app_meta = count_rows(conn, "app_meta")?;
    data.sessions = count_rows(conn, "sessions")?;
    Ok(data)
}

fn read_manifest(root: &Path) -> CmdResult<LibraryManifest> {
    let path = root.join(paths::MANIFEST_NAME);
    let text = atomic::read_text(&path)?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("{} 不是合法的 JSON：{e}", path.display()),
        )
    })?;
    // 直接反序列化（不走 parse_typed 的版本头检查）：v1 的 formatVersion 是 1，
    // `extra` 会把未知字段原样留住，发布时只改 formatVersion 这一个字段。
    serde_json::from_value(value).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("{} 的字段不符合 KnowledgeNet 清单结构：{e}", path.display()),
        )
    })
}

/* --------------------------------- 写文件 --------------------------------- */

#[derive(Debug, Clone)]
struct PlannedNode {
    id: String,
    rel: String,
    dir: PathBuf,
}

/// 目标位置已经有「不是本次迁移写的」文件时，宁可整体失败。
///
/// 允许覆盖的只有：不存在，或者内容是本迁移自己产物（format 与实体 ID 都对得上，
/// 例如上一次迁移在发布前失败留下的中间文件）。这条规则是「绝不覆盖用户内容」的落点。
fn write_guarded<T: Serialize>(
    path: &Path,
    value: &T,
    expected_format: &str,
    id_field: Option<(&str, &str)>,
    what: &str,
) -> CmdResult<()> {
    if path.exists() {
        let text = atomic::read_text(path)?;
        let existing: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            CmdError::new(
                code::CONFLICT,
                format!(
                    "{what} 已经存在（{}）且不是合法 JSON，已拒绝覆盖。\
                     若这是上一次迁移的残留，请先删除该文件再重试。解析错误：{e}",
                    path.display()
                ),
            )
            .with_detail(serde_json::json!({
                "path": path.display().to_string(),
                "detail": e.to_string(),
            }))
        })?;
        let format = existing
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if format != expected_format {
            return Err(CmdError::new(
                code::CONFLICT,
                format!(
                    "{what} 已经存在（{}）且不是 KnowledgeNet 的 {expected_format}（format=「{format}」），\
                     已拒绝覆盖；请先备份并移走该文件再迁移",
                    path.display()
                ),
            )
            .with_detail(serde_json::json!({
                "path": path.display().to_string(),
                "expectedFormat": expected_format,
                "actualFormat": format,
            })));
        }
        if let Some((field, want)) = id_field {
            let got = existing
                .get(field)
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if got != want {
                return Err(CmdError::new(
                    code::CONFLICT,
                    format!(
                        "{what} 已经存在（{}）但属于别的实体（{field}：期望 {want}，实际 {got}），已拒绝覆盖",
                        path.display()
                    ),
                )
                .with_detail(serde_json::json!({
                    "path": path.display().to_string(),
                    "field": field,
                    "expected": want,
                    "actual": got,
                })));
            }
        }
    }
    atomic::write_json(path, value)?;
    Ok(())
}

/// `<nodeRel>/<docRel>` → 节点内相对路径（`note.md`）
fn strip_node_prefix(node_rel: &str, doc_rel: &str) -> Option<String> {
    if node_rel.is_empty() {
        return Some(doc_rel.to_string());
    }
    doc_rel
        .strip_prefix(node_rel)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(|rest| rest.to_string())
}

/// v1 → v2 的消息状态映射。
///
/// v1 有 `streaming / complete / cancelled / failed`，v2 有
/// `streaming / complete / stopped / error / incomplete`：
/// `cancelled`（用户主动停）→ `stopped`，`failed` → `error`，
/// `streaming`（崩溃留下的中间态）→ `incomplete` 且保留已生成正文，
/// 来路不明的值也落到 `incomplete`（宁可显示「可能不完整」，也不要把半截回答当完整答案）。
fn map_status(raw: &str) -> (MessageStatus, bool) {
    match raw {
        "complete" => (MessageStatus::Complete, false),
        "streaming" => (MessageStatus::Incomplete, false),
        "stopped" | "cancelled" | "canceled" => (MessageStatus::Stopped, false),
        "error" | "failed" => (MessageStatus::Error, false),
        "incomplete" => (MessageStatus::Incomplete, false),
        _ => (MessageStatus::Incomplete, true),
    }
}

/// v1 的 `usage` 是一段 TEXT。能解析成 JSON 就写成结构化 `usage`；
/// 解析不了就原样塞进 `extra.legacyUsage` 并记一条 warning——**不丢数据**。
fn convert_usage(
    raw: Option<&str>,
    extra: &mut serde_json::Map<String, serde_json::Value>,
    message_id: &str,
    warnings: &mut Vec<String>,
) -> Option<serde_json::Value> {
    let raw = raw?;
    if raw.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => Some(value),
        Err(_) => {
            extra.insert(
                "legacyUsage".to_string(),
                serde_json::Value::String(raw.to_string()),
            );
            warnings.push(format!(
                "消息 {message_id} 的 usage 不是合法 JSON，原文已放进 legacyUsage 字段"
            ));
            None
        }
    }
}

/// 第 5–9 步：把 v1 数据写成开放文件，返回 `before` 计数。
fn convert(
    root: &Path,
    manifest: &LibraryManifest,
    data: &V1Data,
    warnings: &mut Vec<String>,
) -> CmdResult<MigrationCounts> {
    let lib_paths = paths::LibraryPaths::for_existing(root)?;
    let mut counts = MigrationCounts::default();

    /* ① 规划节点：已删除 / 已合并 / 目录缺失 / ID 非法的节点都不迁移 */
    let mut planned: Vec<PlannedNode> = Vec::new();
    let mut trashed = 0i64;
    let mut merged = 0i64;
    for node in &data.nodes {
        if node.deleted_at.is_some() {
            trashed += 1;
            continue;
        }
        if node.merged_into_id.is_some() {
            merged += 1;
            continue;
        }
        if !paths::is_uuid(&node.id) {
            warnings.push(format!(
                "节点 {} 的 id 不是合法 UUID，已跳过（记录仍保留在恢复点数据库里）",
                node.id
            ));
            continue;
        }
        let rel = match paths::validate_relative_path(&node.storage_relpath) {
            Ok(rel) => rel,
            Err(err) => {
                warnings.push(format!(
                    "节点 {} 的 storageRelpath「{}」不合法（{}），已跳过",
                    node.id, node.storage_relpath, err.message
                ));
                continue;
            }
        };
        let dir = match lib_paths.resolve_rel(&rel) {
            Ok(dir) => dir,
            Err(err) => {
                warnings.push(format!(
                    "节点 {} 的目录 {} 无法解析（{}），已跳过",
                    node.id, rel, err.message
                ));
                continue;
            }
        };
        if !dir.is_dir() {
            warnings.push(format!(
                "节点 {}「{}」的目录不存在（{}），已跳过；请确认它没有被手工删除",
                node.id, node.title, rel
            ));
            continue;
        }
        planned.push(PlannedNode {
            id: node.id.clone(),
            rel,
            dir,
        });
    }
    if trashed > 0 {
        warnings.push(format!(
            "v1 有 {trashed} 个已删除节点未迁移（目录在 trash/ 里）；它们的元数据与对话完整保留在恢复点的 knowledge.sqlite 中"
        ));
    }
    if merged > 0 {
        warnings.push(format!(
            "v1 有 {merged} 个已合并节点未迁移（身份已经并入别的节点）"
        ));
    }

    let planned_ids: BTreeSet<String> = planned.iter().map(|p| p.id.clone()).collect();

    /* ② 主体文档：primaryDocument 取 node_documents 里 kind='note' 的那条，转成节点内相对路径 */
    let mut primary_document: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut node_revision: BTreeMap<String, i64> = BTreeMap::new();
    let mut baseline_hashes: Vec<(PathBuf, String)> = Vec::new();
    for plan in &planned {
        let doc = data
            .documents
            .iter()
            .find(|d| d.node_id == plan.id && d.kind == "note");
        let revision = doc.map(|d| d.revision.max(1)).unwrap_or(1);
        node_revision.insert(plan.id.clone(), revision);
        let inner = match doc {
            None => None,
            Some(doc) => match paths::validate_relative_path(&doc.relative_path) {
                Ok(doc_rel) => match strip_node_prefix(&plan.rel, &doc_rel) {
                    Some(inner) => match schema::validate_primary_document(&inner) {
                        Ok(inner) => {
                            // 迁移前记录正文哈希：迁移结束后必须一字不差
                            if let Ok(abs) = lib_paths.resolve_rel(&doc_rel) {
                                if abs.is_file() {
                                    let sha = paths::sha256_file(&abs)?.0;
                                    baseline_hashes.push((abs, sha));
                                }
                            }
                            Some(inner)
                        }
                        Err(err) => {
                            warnings.push(format!(
                                "节点 {} 的主文档路径「{}」不合法（{}），primaryDocument 留空",
                                plan.id, inner, err.message
                            ));
                            None
                        }
                    },
                    None => {
                        warnings.push(format!(
                            "节点 {} 登记的主文档「{}」不在节点目录「{}」内，primaryDocument 留空",
                            plan.id, doc_rel, plan.rel
                        ));
                        None
                    }
                },
                Err(err) => {
                    warnings.push(format!(
                        "节点 {} 登记的主文档路径不合法（{}），primaryDocument 留空",
                        plan.id, err.message
                    ));
                    None
                }
            },
        };
        primary_document.insert(plan.id.clone(), inner);
    }

    /* ③ 每个节点写 node.json */
    let node_by_id: BTreeMap<&str, &V1Node> =
        data.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    for plan in &planned {
        let node = node_by_id
            .get(plan.id.as_str())
            .expect("planned 节点一定来自 data.nodes");
        let title = match node.title.trim() {
            "" => {
                warnings.push(format!("节点 {} 的标题为空，已回退为「未命名节点」", plan.id));
                "未命名节点".to_string()
            }
            _ => node.title.clone(),
        };
        let meta = NodeMeta {
            format: NODE_FORMAT.to_string(),
            format_version: NODE_FORMAT_VERSION,
            id: plan.id.clone(),
            revision: *node_revision.get(&plan.id).unwrap_or(&1),
            title,
            aliases: data.aliases.get(&plan.id).cloned().unwrap_or_default(),
            status: LearnStatus::from_db(&node.status),
            primary_document: primary_document.get(&plan.id).cloned().flatten(),
            created_at: paths::iso_from_ms(node.created_at),
            updated_at: paths::iso_from_ms(node.updated_at),
            extensions: schema::empty_object(),
            extra: serde_json::Map::new(),
        };
        meta.validate_typed()?;
        if meta.primary_document.is_some() {
            counts.notes += 1;
        }
        counts.nodes += 1;
        write_guarded(
            &vpaths::node_meta_file(&plan.dir),
            &meta,
            NODE_FORMAT,
            Some(("id", plan.id.as_str())),
            "node.json",
        )?;
    }

    /* ④ 关系：出边归属源节点 */
    let mut edges_by_from: BTreeMap<String, Vec<&V1Edge>> = BTreeMap::new();
    for edge in &data.edges {
        if !paths::is_uuid(&edge.id) || !paths::is_uuid(&edge.to_node_id) {
            warnings.push(format!(
                "关系 {} 的 id 或 toNodeId 不是合法 UUID，已跳过",
                edge.id
            ));
            continue;
        }
        if !planned_ids.contains(&edge.from_node_id) {
            warnings.push(format!(
                "关系 {}（{} → {}）的源节点没有被迁移，已跳过",
                edge.id, edge.from_node_id, edge.to_node_id
            ));
            continue;
        }
        edges_by_from
            .entry(edge.from_node_id.clone())
            .or_default()
            .push(edge);
    }

    let title_of = |node_id: &str| -> String {
        node_by_id
            .get(node_id)
            .map(|n| n.title.clone())
            .unwrap_or_default()
    };
    let mut migrated_edge_ids: BTreeSet<String> = BTreeSet::new();
    for plan in &planned {
        let Some(edges) = edges_by_from.get(&plan.id) else {
            continue;
        };
        let mut outgoing: Vec<RelationEdge> = Vec::new();
        for edge in edges {
            let mut evidence: Vec<Evidence> = Vec::new();
            for discovery in data
                .discoveries
                .iter()
                .filter(|d| d.edge_id.as_deref() == Some(edge.id.as_str()))
            {
                if !paths::is_uuid(&discovery.id) {
                    warnings.push(format!("来源 {} 的 id 不是合法 UUID，已跳过", discovery.id));
                    continue;
                }
                evidence.push(Evidence {
                    id: discovery.id.clone(),
                    thread_id: discovery.thread_id.clone(),
                    message_id: discovery.message_id.clone(),
                    snippet: discovery.snippet.clone(),
                    question: discovery.question.clone(),
                    created_at: paths::iso_from_ms(discovery.created_at),
                    extra: serde_json::Map::new(),
                });
            }
            counts.discoveries += evidence.len() as i64;
            let relation_type = match edge.relation_type.trim() {
                "" => "prerequisite".to_string(),
                value => value.to_string(),
            };
            outgoing.push(RelationEdge {
                id: edge.id.clone(),
                to_node_id: edge.to_node_id.clone(),
                type_: relation_type,
                description: edge.description.clone(),
                to_title_snapshot: title_of(&edge.to_node_id),
                created_at: paths::iso_from_ms(edge.created_at),
                updated_at: paths::iso_from_ms(edge.updated_at),
                evidence,
                extra: serde_json::Map::new(),
            });
            migrated_edge_ids.insert(edge.id.clone());
        }
        if outgoing.is_empty() {
            continue;
        }
        let file = RelationsFile {
            format: RELATIONS_FORMAT.to_string(),
            format_version: RELATIONS_FORMAT_VERSION,
            node_id: plan.id.clone(),
            revision: 1,
            outgoing,
            extra: serde_json::Map::new(),
        };
        file.validate_typed()?;
        counts.edges += file.outgoing.len() as i64;
        write_guarded(
            &vpaths::relations_file(&plan.dir),
            &file,
            RELATIONS_FORMAT,
            Some(("nodeId", plan.id.as_str())),
            "relations.json",
        )?;
    }

    // 没有对应关系的 discoveries 必须进报告，不静默丢弃（设计文档 §10.2 第 4 条）
    let orphan_discoveries = data
        .discoveries
        .iter()
        .filter(|d| {
            d.edge_id
                .as_deref()
                .map(|edge_id| !migrated_edge_ids.contains(edge_id))
                .unwrap_or(true)
        })
        .count();
    if orphan_discoveries > 0 {
        warnings.push(format!(
            "v1 有 {orphan_discoveries} 条来源记录（discoveries）没有对应的、已迁移的关系，未写进 relations.json；\
             它们完整保留在恢复点的 knowledge.sqlite 里，可在 v2 里重新挂到关系上"
        ));
    }

    /* ⑤ 对话：线程头 + 一条消息一个文件 */
    let mut unknown_status: BTreeMap<String, i64> = BTreeMap::new();
    let mut thread_of_node: BTreeMap<String, Vec<&V1Thread>> = BTreeMap::new();
    for thread in &data.threads {
        if !paths::is_uuid(&thread.id) {
            warnings.push(format!("对话 {} 的 id 不是合法 UUID，已跳过", thread.id));
            continue;
        }
        if !planned_ids.contains(&thread.node_id) {
            warnings.push(format!(
                "对话 {} 属于没有被迁移的节点 {}，已跳过",
                thread.id, thread.node_id
            ));
            continue;
        }
        thread_of_node
            .entry(thread.node_id.clone())
            .or_default()
            .push(thread);
    }
    for plan in &planned {
        let Some(threads) = thread_of_node.get(&plan.id) else {
            continue;
        };
        for thread in threads {
            let title = match thread.title.trim() {
                "" => {
                    warnings.push(format!("对话 {} 的标题为空，已回退为「新对话」", thread.id));
                    "新对话".to_string()
                }
                value => value.to_string(),
            };
            let file = ThreadFile {
                format: THREAD_FORMAT.to_string(),
                format_version: THREAD_FORMAT_VERSION,
                id: thread.id.clone(),
                node_id: thread.node_id.clone(),
                revision: 1,
                title,
                summary: thread.summary.clone(),
                created_at: paths::iso_from_ms(thread.created_at),
                updated_at: paths::iso_from_ms(thread.updated_at),
                extra: serde_json::Map::new(),
            };
            file.validate_typed()?;
            write_guarded(
                &vpaths::thread_file(&plan.dir, &thread.id),
                &file,
                THREAD_FORMAT,
                Some(("id", thread.id.as_str())),
                "thread.json",
            )?;
            counts.threads += 1;

            // v1 的 seq 只保证同一线程内递增；这里重新分配 1..n 的 6 位序号
            let mut sequence = 0i64;
            for message in data
                .messages
                .iter()
                .filter(|m| m.thread_id == thread.id)
            {
                if !paths::is_uuid(&message.id) {
                    warnings.push(format!("消息 {} 的 id 不是合法 UUID，已跳过", message.id));
                    continue;
                }
                sequence += 1;
                let mut extra = serde_json::Map::new();
                let role = match message.role.as_str() {
                    "user" | "assistant" | "system" => message.role.clone(),
                    other => {
                        extra.insert(
                            "legacyRole".to_string(),
                            serde_json::Value::String(other.to_string()),
                        );
                        warnings.push(format!(
                            "消息 {} 的 role「{other}」不是 v2 认识的取值，已按 assistant 写入（原值保留在 legacyRole）",
                            message.id
                        ));
                        "assistant".to_string()
                    }
                };
                let (status, unknown) = map_status(&message.status);
                if unknown {
                    *unknown_status.entry(message.status.clone()).or_insert(0) += 1;
                }
                let usage = convert_usage(
                    message.usage.as_deref(),
                    &mut extra,
                    &message.id,
                    warnings,
                );
                let mut file = MessageFile {
                    format: MESSAGE_FORMAT.to_string(),
                    format_version: MESSAGE_FORMAT_VERSION,
                    id: message.id.clone(),
                    thread_id: thread.id.clone(),
                    sequence,
                    role,
                    content: message.content.clone(),
                    status,
                    finish_reason: message.finish_reason.clone(),
                    request_id: message.request_id.clone(),
                    usage,
                    // v1 的 chat_messages 没有 model 列
                    model: None,
                    // v1 也没有思考过程这一列：迁移过来的老对话就是没有
                    reasoning: None,
                    // v1 更没有过程记录（思考 + 工具调用）：它连联网检索都没有过
                    steps: Vec::new(),
                    created_at: paths::iso_from_ms(message.created_at),
                    updated_at: paths::iso_from_ms(message.created_at),
                    extra,
                };
                for note in chats::sanitize_message_lossy(&mut file) {
                    warnings.push(note);
                }
                file.validate_typed()?;
                let name = vpaths::message_file_name(file.sequence, &file.id);
                write_guarded(
                    &vpaths::messages_dir(&plan.dir, &thread.id).join(&name),
                    &file,
                    MESSAGE_FORMAT,
                    Some(("id", file.id.as_str())),
                    "消息文件",
                )?;
                counts.messages += 1;
            }
        }
    }
    for (raw, count) in unknown_status {
        warnings.push(format!(
            "有 {count} 条消息的状态是 v1 不认识的取值「{raw}」，已按 incomplete 写入"
        ));
    }

    /* ⑥ 书签：按 node_id 分文件 */
    let mut bookmarks_by_node: BTreeMap<String, Vec<BookmarkEntry>> = BTreeMap::new();
    for bookmark in &data.bookmarks {
        if !paths::is_uuid(&bookmark.id) {
            warnings.push(format!("书签 {} 的 id 不是合法 UUID，已跳过", bookmark.id));
            continue;
        }
        if !planned_ids.contains(&bookmark.node_id) {
            warnings.push(format!(
                "书签 {} 属于没有被迁移的节点 {}，已跳过",
                bookmark.id, bookmark.node_id
            ));
            continue;
        }
        bookmarks_by_node
            .entry(bookmark.node_id.clone())
            .or_default()
            .push(BookmarkEntry {
                id: bookmark.id.clone(),
                thread_id: bookmark.thread_id.clone(),
                message_id: bookmark.message_id.clone(),
                scroll_offset: bookmark.scroll_offset,
                question: bookmark.question.clone(),
                return_node_id: bookmark.return_node_id.clone(),
                created_at: paths::iso_from_ms(bookmark.created_at),
                updated_at: paths::iso_from_ms(bookmark.updated_at),
                extra: serde_json::Map::new(),
            });
    }
    for plan in &planned {
        let Some(bookmarks) = bookmarks_by_node.get(&plan.id) else {
            continue;
        };
        let file = BookmarksFile {
            format: BOOKMARKS_FORMAT.to_string(),
            format_version: BOOKMARKS_FORMAT_VERSION,
            node_id: plan.id.clone(),
            revision: 1,
            bookmarks: bookmarks.clone(),
            extra: serde_json::Map::new(),
        };
        file.validate_typed()?;
        counts.bookmarks += file.bookmarks.len() as i64;
        write_guarded(
            &vpaths::bookmarks_file(&plan.dir),
            &file,
            BOOKMARKS_FORMAT,
            Some(("nodeId", plan.id.as_str())),
            "bookmarks.json",
        )?;
    }

    /* ⑦ 资料：relative_path 转成节点内相对路径；note.md 与 files 下的附件原地不动 */
    let mut resources_by_node: BTreeMap<String, Vec<ResourceEntry>> = BTreeMap::new();
    for resource in &data.resources {
        if !paths::is_uuid(&resource.id) {
            warnings.push(format!("资料 {} 的 id 不是合法 UUID，已跳过", resource.id));
            continue;
        }
        if resource.deleted_at.is_some() || resource.state == "trashed" {
            continue; // 已进回收站的资料不迁移（文件在 trash/ 里）
        }
        let Some(plan) = planned.iter().find(|p| p.id == resource.node_id) else {
            warnings.push(format!(
                "资料 {} 属于没有被迁移的节点 {}，已跳过",
                resource.id, resource.node_id
            ));
            continue;
        };
        let kind = match resource.resource_type.as_str() {
            "file" | "url" | "citation" => resource.resource_type.clone(),
            other => {
                warnings.push(format!(
                    "资料 {} 的 resourceType「{other}」不是 v2 认识的取值，已跳过",
                    resource.id
                ));
                continue;
            }
        };
        let relative_path = match resource.relative_path.as_deref() {
            None => None,
            Some(raw) => {
                let doc_rel = match paths::validate_relative_path(raw) {
                    Ok(rel) => rel,
                    Err(err) => {
                        warnings.push(format!(
                            "资料 {} 的 relativePath 不合法（{}），已跳过",
                            resource.id, err.message
                        ));
                        continue;
                    }
                };
                match strip_node_prefix(&plan.rel, &doc_rel) {
                    Some(inner) => Some(inner),
                    None => {
                        warnings.push(format!(
                            "资料 {} 的文件「{doc_rel}」不在节点目录「{}」内，已跳过",
                            resource.id, plan.rel
                        ));
                        continue;
                    }
                }
            }
        };
        if kind == "file" && relative_path.is_none() {
            warnings.push(format!("资料 {} 是文件类但没有相对路径，已跳过", resource.id));
            continue;
        }
        if kind == "url" && resource.source_url.as_deref().unwrap_or("").trim().is_empty() {
            warnings.push(format!("资料 {} 是 URL 类但没有地址，已跳过", resource.id));
            continue;
        }
        let mut extra = serde_json::Map::new();
        extra.insert(
            "legacyState".to_string(),
            serde_json::Value::String(resource.state.clone()),
        );
        resources_by_node
            .entry(resource.node_id.clone())
            .or_default()
            .push(ResourceEntry {
                id: resource.id.clone(),
                kind,
                relative_path,
                url: resource.source_url.clone(),
                original_name: resource.original_name.clone(),
                display_name: resource.display_name.clone(),
                mime_type: resource.mime_type.clone(),
                byte_length: resource.byte_length,
                sha256: resource.sha256.clone(),
                description: resource.description.clone(),
                sort_order: resource.sort_order,
                created_at: paths::iso_from_ms(resource.created_at),
                updated_at: paths::iso_from_ms(resource.updated_at),
                extra,
            });
    }
    for plan in &planned {
        let Some(entries) = resources_by_node.get(&plan.id) else {
            continue;
        };
        let file = ResourcesFile {
            format: RESOURCES_FORMAT.to_string(),
            format_version: RESOURCES_FORMAT_VERSION,
            node_id: plan.id.clone(),
            revision: 1,
            entries: entries.clone(),
            extra: serde_json::Map::new(),
        };
        file.validate_typed()?;
        counts.resources += file.entries.len() as i64;
        write_guarded(
            &vpaths::resources_file(&plan.dir),
            &file,
            RESOURCES_FORMAT,
            Some(("nodeId", plan.id.as_str())),
            "resources.json",
        )?;
    }

    /* ⑧ 学习目标：知识库级，写在根目录 */
    let mut goals: Vec<GoalEntry> = Vec::new();
    for goal in &data.goals {
        if !paths::is_uuid(&goal.id) || !paths::is_uuid(&goal.root_node_id) {
            warnings.push(format!("目标 {} 的 id 或 rootNodeId 不是合法 UUID，已跳过", goal.id));
            continue;
        }
        if goal.title.trim().is_empty() {
            warnings.push(format!("目标 {} 的标题为空，已跳过（v2 要求标题非空）", goal.id));
            continue;
        }
        if !planned_ids.contains(&goal.root_node_id) {
            warnings.push(format!(
                "目标「{}」的入口节点 {} 没有被迁移，目标仍会写入但成为悬空引用",
                goal.title, goal.root_node_id
            ));
        }
        goals.push(GoalEntry {
            id: goal.id.clone(),
            title: goal.title.clone(),
            root_node_id: goal.root_node_id.clone(),
            created_at: paths::iso_from_ms(goal.created_at),
            extra: serde_json::Map::new(),
        });
    }
    if !goals.is_empty() {
        let file = GoalsFile {
            format: GOALS_FORMAT.to_string(),
            format_version: GOALS_FORMAT_VERSION,
            library_id: manifest.library_id.clone(),
            revision: 1,
            goals,
            extra: serde_json::Map::new(),
        };
        file.validate_typed()?;
        counts.goals = file.goals.len() as i64;
        write_guarded(
            &vpaths::root_goals_file(root),
            &file,
            GOALS_FORMAT,
            Some(("libraryId", manifest.library_id.as_str())),
            "goals.json",
        )?;
    }

    if data.library_settings > 0 || data.app_meta > 0 || data.sessions > 0 {
        warnings.push(format!(
            "v1 的 library_settings（{} 条）、app_meta（{} 条）与 sessions（{} 条）没有 v2 对应位置，未迁移；\
             它们仍保留在恢复点的 knowledge.sqlite 里（sessions 属于设备交互状态，v2 放在 AppData）",
            data.library_settings, data.app_meta, data.sessions
        ));
    }

    /* ⑨ 用户文件一个字节都没动：对迁移前记录过哈希的主文档复核 */
    for (path, before_hash) in &baseline_hashes {
        let after_hash = paths::sha256_file(path)?.0;
        if &after_hash != before_hash {
            return Err(CmdError::new(
                code::CONFLICT,
                format!(
                    "迁移过程改变了用户文件（{}）：这是不允许的，已拒绝发布",
                    path.display()
                ),
            ));
        }
    }

    Ok(counts)
}

/* --------------------------------- 重扫比对 --------------------------------- */

/// 最小重扫：遍历 `**/.meta/knowledgenet/node.json`，读 node.json / relations.json /
/// resources.json / bookmarks.json / chats/*/thread.json + 数消息文件名，
/// 得到与 `before` 同构的计数。
///
/// 刻意不复用 `scanner.rs`：迁移的验收判据是「**从磁盘上真实存在的文件**重新数一遍」，
/// 借用被测实现自证会让这一步失去意义。
fn rescan(root: &Path, issues: &mut Vec<String>) -> CmdResult<MigrationCounts> {
    let mut counts = MigrationCounts::default();
    let mut node_ids: BTreeSet<String> = BTreeSet::new();
    let mut edge_targets: Vec<String> = Vec::new();
    scan_dir(
        root,
        root,
        &mut counts,
        &mut node_ids,
        &mut edge_targets,
        issues,
        0,
    )?;

    // 悬空关系要在**整棵树走完之后**才判定：目标节点可能在源节点之后才被遍历到
    let dangling = edge_targets
        .iter()
        .filter(|target| !node_ids.contains(*target))
        .count();
    if dangling > 0 {
        issues.push(format!(
            "重扫发现 {dangling} 条关系指向本库中不存在的节点：按设计保留为悬空关系，不自动删除"
        ));
    }

    let goals_path = vpaths::root_goals_file(root);
    if goals_path.is_file() {
        let text = atomic::read_text(&goals_path)?;
        let file: GoalsFile = schema::parse_typed(
            &text,
            GOALS_FORMAT,
            GOALS_FORMAT_VERSION,
            "goals.json",
            Some(&vpaths::relative_path_string(root, &goals_path).unwrap_or_default()),
        )?;
        counts.goals = file.goals.len() as i64;
    }
    Ok(counts)
}

#[allow(clippy::too_many_arguments)]
fn scan_dir(
    root: &Path,
    dir: &Path,
    counts: &mut MigrationCounts,
    node_ids: &mut BTreeSet<String>,
    edge_targets: &mut Vec<String>,
    issues: &mut Vec<String>,
    depth: usize,
) -> CmdResult<()> {
    if depth > 128 {
        issues.push(format!(
            "重扫在 {} 处超过最大深度，已停止下探",
            dir.display()
        ));
        return Ok(());
    }

    let ns = vpaths::ns_dir(dir);
    let meta_path = ns.join(vpaths::NODE_FILE);
    if meta_path.is_file() {
        let rel = vpaths::relative_path_string(root, dir).unwrap_or_default();
        let meta_rel = format!("{}/{}", rel, vpaths::NODE_MARKER_RELATIVE)
            .trim_start_matches('/')
            .to_string();
        let text = atomic::read_text(&meta_path)?;
        let meta: NodeMeta = schema::parse_typed(
            &text,
            NODE_FORMAT,
            NODE_FORMAT_VERSION,
            "node.json",
            Some(&meta_rel),
        )?;
        counts.nodes += 1;
        node_ids.insert(meta.id.clone());
        if meta.primary_document.is_some() {
            counts.notes += 1;
        }

        let relations_path = ns.join(vpaths::RELATIONS_FILE);
        if relations_path.is_file() {
            let text = atomic::read_text(&relations_path)?;
            let file: RelationsFile = schema::parse_typed(
                &text,
                RELATIONS_FORMAT,
                RELATIONS_FORMAT_VERSION,
                "relations.json",
                Some(&format!("{rel}/.meta/knowledgenet/relations.json")),
            )?;
            counts.edges += file.outgoing.len() as i64;
            for edge in &file.outgoing {
                counts.discoveries += edge.evidence.len() as i64;
                edge_targets.push(edge.to_node_id.clone());
            }
        }

        let resources_path = ns.join(vpaths::RESOURCES_FILE);
        if resources_path.is_file() {
            let text = atomic::read_text(&resources_path)?;
            let file: ResourcesFile = schema::parse_typed(
                &text,
                RESOURCES_FORMAT,
                RESOURCES_FORMAT_VERSION,
                "resources.json",
                Some(&format!("{rel}/.meta/knowledgenet/resources.json")),
            )?;
            counts.resources += file.entries.len() as i64;
        }

        let bookmarks_path = ns.join(vpaths::BOOKMARKS_FILE);
        if bookmarks_path.is_file() {
            let text = atomic::read_text(&bookmarks_path)?;
            let file: BookmarksFile = schema::parse_typed(
                &text,
                BOOKMARKS_FORMAT,
                BOOKMARKS_FORMAT_VERSION,
                "bookmarks.json",
                Some(&format!("{rel}/.meta/knowledgenet/bookmarks.json")),
            )?;
            counts.bookmarks += file.bookmarks.len() as i64;
        }

        let chats_dir = ns.join(vpaths::CHATS_DIR);
        for thread_id in subdir_names(&chats_dir)? {
            let thread_path = chats_dir.join(&thread_id).join(vpaths::THREAD_FILE);
            if !thread_path.is_file() {
                issues.push(format!(
                    "{rel}/.meta/knowledgenet/chats/{thread_id} 缺少 thread.json，已忽略"
                ));
                continue;
            }
            let text = atomic::read_text(&thread_path)?;
            // 线程头必须能解析（解析失败说明我们刚写出去的文件有问题，直接失败）
            let _thread: ThreadFile = schema::parse_typed(
                &text,
                THREAD_FORMAT,
                THREAD_FORMAT_VERSION,
                "thread.json",
                Some(&format!("{rel}/.meta/knowledgenet/chats/{thread_id}/thread.json")),
            )?;
            counts.threads += 1;
            counts.messages += count_message_files(&chats_dir.join(&thread_id).join(vpaths::MESSAGES_DIR))?;
        }
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            issues.push(format!("重扫无法读取目录 {}：{err}", dir.display()));
            return Ok(());
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if paths::is_link_like(&path) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(
            name.as_str(),
            vpaths::META_DIR | vpaths::ROOT_META_DIR | ".git" | "node_modules"
        ) {
            continue;
        }
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => {}
            _ => continue,
        }
        // 嵌套的另一个知识库：不下探（它有自己的 library.json，里面的节点不属于本库）
        if path.join(paths::MANIFEST_NAME).is_file() {
            continue;
        }
        scan_dir(
            root,
            &path,
            counts,
            node_ids,
            edge_targets,
            issues,
            depth + 1,
        )?;
    }
    Ok(())
}

fn subdir_names(dir: &Path) -> CmdResult<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(err) => return Err(CmdError::io(format!("读取目录 {} 失败：{err}", dir.display()))),
    };
    for entry in entries {
        let entry = entry.map_err(|e| CmdError::io(format!("读取目录项失败：{e}")))?;
        let path = entry.path();
        if paths::is_link_like(&path) {
            continue;
        }
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => names.push(entry.file_name().to_string_lossy().to_string()),
            _ => {}
        }
    }
    names.sort();
    Ok(names)
}

/// 消息条数只数文件名（`<6 位序号>_<id>.json`），不读正文。
fn count_message_files(dir: &Path) -> CmdResult<i64> {
    let mut count = 0i64;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(CmdError::io(format!("读取目录 {} 失败：{err}", dir.display()))),
    };
    for entry in entries {
        let entry = entry.map_err(|e| CmdError::io(format!("读取目录项失败：{e}")))?;
        match entry.metadata() {
            Ok(meta) if meta.is_file() => {}
            _ => continue,
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if vpaths::parse_message_file_name(&name).is_some() {
            count += 1;
        }
    }
    Ok(count)
}

fn verify(
    root: &Path,
    before: &MigrationCounts,
    warnings: &mut Vec<String>,
) -> CmdResult<MigrationCounts> {
    let mut issues: Vec<String> = Vec::new();
    let after = rescan(root, &mut issues)?;

    let pairs: [(&str, i64, i64); 9] = [
        ("节点", before.nodes, after.nodes),
        ("关系", before.edges, after.edges),
        ("目标", before.goals, after.goals),
        ("线程", before.threads, after.threads),
        ("消息", before.messages, after.messages),
        ("来源", before.discoveries, after.discoveries),
        ("书签", before.bookmarks, after.bookmarks),
        ("资料", before.resources, after.resources),
        ("主文档", before.notes, after.notes),
    ];
    let mismatches: Vec<String> = pairs
        .iter()
        .filter(|(_, expected, actual)| expected != actual)
        .map(|(label, expected, actual)| format!("{label} 期望 {expected} 实际 {actual}"))
        .collect();
    if !mismatches.is_empty() {
        return Err(CmdError::new(
            code::CONFLICT,
            format!(
                "迁移后的开放文件与 v1 数据不一致，已拒绝发布（library.json 仍是 v1）：{}",
                mismatches.join("；")
            ),
        )
        .with_detail(serde_json::json!({
            "expected": before,
            "actual": after,
            "mismatches": mismatches,
        })));
    }
    warnings.extend(issues);
    Ok(after)
}

/* ---------------------------------- 发布 ---------------------------------- */

/// **唯一发布点**：把 `library.json` 的 `formatVersion` 原子改成 2。
///
/// 反序列化成 [`LibraryManifest`] 再改字段再写回，未知字段（`extra`）原样保留。
fn publish(root: &Path, manifest: &LibraryManifest) -> CmdResult<()> {
    let path = root.join(paths::MANIFEST_NAME);
    let text = atomic::read_text(&path)?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("发布前重读 {} 失败：{e}", path.display()),
        )
    })?;
    let mut updated: LibraryManifest = serde_json::from_value(value).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("发布前解析 {} 失败：{e}", path.display()),
        )
    })?;
    if updated.library_id != manifest.library_id {
        return Err(CmdError::new(
            code::CONFLICT,
            format!(
                "发布前 library.json 的 libraryId 变成了 {}（迁移开始时是 {}），已拒绝发布",
                updated.library_id, manifest.library_id
            ),
        ));
    }
    updated.format_version = LIBRARY_FORMAT_VERSION;
    updated.validate_typed()?;
    atomic::write_json(&path, &updated)?;

    // 回读确认：发布出去的文件必须能被 v2 解析器读出来
    let check = atomic::read_text(&path)?;
    schema::parse_typed::<LibraryManifest>(
        &check,
        LIBRARY_FORMAT,
        LIBRARY_FORMAT_VERSION,
        "library.json",
        Some(&paths::MANIFEST_NAME),
    )?;
    Ok(())
}

/* ---------------------------------- 测试 ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 状态映射与_v1_对齐() {
        assert_eq!(map_status("complete").0, MessageStatus::Complete);
        assert_eq!(map_status("cancelled").0, MessageStatus::Stopped);
        assert_eq!(map_status("failed").0, MessageStatus::Error);
        assert_eq!(map_status("streaming").0, MessageStatus::Incomplete);
        assert_eq!(map_status("incomplete").0, MessageStatus::Incomplete);
        let (status, unknown) = map_status("who-knows");
        assert_eq!(status, MessageStatus::Incomplete);
        assert!(unknown);
    }

    #[test]
    fn 节点内相对路径转换() {
        assert_eq!(
            strip_node_prefix("nodes/0199", "nodes/0199/note.md").as_deref(),
            Some("note.md")
        );
        assert_eq!(
            strip_node_prefix("nodes/0199", "nodes/0199/files/a/b.pdf").as_deref(),
            Some("files/a/b.pdf")
        );
        assert_eq!(strip_node_prefix("nodes/0199", "nodes/0200/note.md"), None);
        assert_eq!(strip_node_prefix("nodes/0199", "nodes/01990/note.md"), None);
    }

    #[test]
    fn 重名归档加序号() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("knowledge-v1.sqlite");
        assert_eq!(unique_path(&base), base);
        fs::write(&base, b"x").unwrap();
        let second = unique_path(&base);
        assert_eq!(second.file_name().unwrap().to_string_lossy(), "knowledge-v1-2.sqlite");
        fs::write(&second, b"x").unwrap();
        let third = unique_path(&base);
        assert_eq!(third.file_name().unwrap().to_string_lossy(), "knowledge-v1-3.sqlite");
    }

    #[test]
    fn 恢复点时间戳不含冒号() {
        let stamp = recovery_stamp();
        assert!(!stamp.contains(':'), "Windows 文件名不允许冒号：{stamp}");
        assert!(stamp.ends_with('Z'));
    }

    #[test]
    fn 非法_json_的用途字段进_legacyUsage() {
        let mut extra = serde_json::Map::new();
        let mut warnings = Vec::new();
        let value = convert_usage(Some("not-json"), &mut extra, "m1", &mut warnings);
        assert!(value.is_none());
        assert!(extra.contains_key("legacyUsage"));
        assert_eq!(warnings.len(), 1);

        let mut extra = serde_json::Map::new();
        let value = convert_usage(Some(r#"{"prompt_tokens":3}"#), &mut extra, "m2", &mut warnings);
        assert_eq!(value.unwrap()["prompt_tokens"], 3);
        assert!(extra.is_empty());
    }
}
