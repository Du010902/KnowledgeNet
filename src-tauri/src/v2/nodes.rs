//! 节点身份生命周期：新建 / 认领 / 移除身份 / 恢复 / 重编重复 ID。
//!
//! 契约 `docs/v2-contract.md` §3.6，语义见设计文档 §6.1–§6.4。
//!
//! 三条贯穿本模块的规则：
//!
//! 1. **节点是普通文件夹**。身份只由 `.meta/knowledgenet/node.json` 里的 `id` 决定，
//!    文件夹名、所在层级都不参与身份判断；改名与移动都不改变身份。
//! 2. **默认不动用户的文件**。「从图谱移除」只搬走 `.meta/knowledgenet`，
//!    节点文件夹和里面的全部普通文件原位保留；永久清理只删回收站里的元数据副本。
//!    唯一的例外是 [`erase_node_folder`]（界面上的「彻底删除」）：它按用户的明确要求
//!    删掉整个文件夹，因此界面必须先用文字说清后果并提供备份入口。
//! 3. **默认绝不覆盖**。改 `node.json` 前同时校验调用方手上的修订号与磁盘 SHA-256，
//!    只要有一个不符就返回 `external_change_conflict`，把决定权交回用户。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models::{code, CmdError, CmdResult, LearnStatus};
use crate::paths;

use super::atomic::{self, Fingerprint};
use super::ctx::LibCtx;
use super::scanner::ScannedNode;
use super::schema::{
    validate_primary_document, NodeMeta, NODE_FORMAT, NODE_FORMAT_VERSION,
};
use super::vpaths;

/* --------------------------------- 常量 --------------------------------- */

/// 归档元数据时写在回收站里的位置说明文件（在归档目录内，不进入节点目录）。
pub const REMOVED_RECORD_FILE: &str = "removed.json";
pub const REMOVED_RECORD_FORMAT: &str = "knowledgenet-removed-identity";
pub const REMOVED_RECORD_FORMAT_VERSION: i64 = 1;
/// 回收站里资料文件的位置（`remove_resource(delete_file=true)` 用）
pub const TRASH_RESOURCES_DIR: &str = "resources";

/// 健康节点的 `health` 取值（与 `ScannedNode.health` 的契约一致）。
pub const HEALTH_OK: &str = "ok";

/* --------------------------------- 小工具 --------------------------------- */

/// 绝对路径 → 知识库内相对路径；失败时退回可读的绝对路径（只用于错误 detail）。
pub(crate) fn rel_of(ctx: &LibCtx, path: &Path) -> String {
    ctx.relative_of(path).unwrap_or_else(|_| {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .to_string()
    })
}

/// 节点文件夹名（根节点没有名字，退回知识库标题）。
fn folder_name_of(ctx: &LibCtx, node_dir: &Path) -> String {
    node_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| ctx.manifest().title.clone())
}

/// 组装扫描结果里的一行节点。业务写入后的返回值必须与扫描器看到的完全一致，
/// 否则前端刚写完拿到的节点与下一次扫描拿到的节点会对不上。
fn scanned_node_of(
    ctx: &LibCtx,
    node_dir: &Path,
    meta: &NodeMeta,
    fp: &Fingerprint,
) -> CmdResult<ScannedNode> {
    let relative_path = ctx.relative_of(node_dir)?;
    let depth = if relative_path.is_empty() {
        0
    } else {
        relative_path.split('/').count() as i64
    };
    Ok(ScannedNode {
        id: meta.id.clone(),
        relative_path,
        folder_name: folder_name_of(ctx, node_dir),
        title: meta.title.clone(),
        aliases: meta.aliases.clone(),
        status: meta.status,
        primary_document: meta.primary_document.clone(),
        created_at: meta.created_at.clone(),
        updated_at: meta.updated_at.clone(),
        revision: meta.revision,
        health: HEALTH_OK.to_string(),
        meta_sha256: fp.sha256.clone(),
        meta_bytes: fp.bytes as i64,
        meta_modified_ms: fp.modified_ms,
        depth,
        nested_node_paths: nested_node_paths_of(ctx, node_dir)?,
    })
}

/// 这个目录是不是「另一个节点」的根（精确路径 `.meta/knowledgenet/node.json`）。
fn is_node_boundary(dir: &Path) -> bool {
    dir.join(vpaths::NODE_MARKER_RELATIVE).is_file()
}

/// **最近的**节点子目录（相对知识库根，已排序）。
///
/// 一个目录里的普通文件归最近的那个节点：找到了子节点就不再往下走，
/// 否则孙节点会被算成父节点的资源。
fn nested_node_paths_of(ctx: &LibCtx, node_dir: &Path) -> CmdResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    collect_nested_nodes(ctx, node_dir, &mut out);
    out.sort();
    out.dedup();
    Ok(out)
}

fn collect_nested_nodes(ctx: &LibCtx, dir: &Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // 权限不足 / 目录刚被删掉：不是错误，只是这一层看不到
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let path = entry.path();
        if entry.file_name().to_string_lossy() == vpaths::META_DIR {
            continue;
        }
        if is_node_boundary(&path) {
            if let Ok(relative) = ctx.relative_of(&path) {
                out.push(relative);
            }
            continue;
        }
        // 嵌套的另一个知识库：整棵子树都不属于本库
        if path.join(paths::MANIFEST_NAME).is_file() {
            continue;
        }
        collect_nested_nodes(ctx, &path, out);
    }
}

/// 移动目录：目标已存在一律拒绝；跨卷（`rename` 失败）时退回复制 + 删除。
fn move_dir(src: &Path, dst: &Path) -> CmdResult<()> {
    if dst.exists() {
        return Err(CmdError::new(
            code::CONFLICT,
            format!("目标已存在，已拒绝覆盖：{}", dst.display()),
        ));
    }
    if let Some(parent) = dst.parent() {
        atomic::ensure_dir(parent)?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            if !src.exists() {
                return Err(CmdError::io(format!(
                    "移动 {} 到 {} 失败：{rename_error}",
                    src.display(),
                    dst.display()
                )));
            }
            // 跨卷 / 被占用：改走「复制 → 删除源」，失败时源目录保持原样
            paths::copy_dir_recursive(src, dst).map_err(|e| {
                CmdError::io(format!(
                    "移动 {} 到 {} 失败（{rename_error}），改用复制也失败：{}",
                    src.display(),
                    dst.display(),
                    e.message
                ))
            })?;
            fs::remove_dir_all(src).map_err(|e| {
                CmdError::io(format!(
                    "元数据已经复制到 {}，但删除原目录 {} 失败：{e}",
                    dst.display(),
                    src.display()
                ))
            })
        }
    }
}

/// 拒绝在「嵌套知识库」内部创建节点元数据：那里属于另一个知识库，
/// 建出来的节点本库永远扫不到，只会让用户困惑。
fn assert_not_in_nested_library(ctx: &LibCtx, dir: &Path) -> CmdResult<()> {
    let root = ctx.root();
    let mut current = dir.to_path_buf();
    while current.starts_with(root) && current != root {
        if current.join(paths::MANIFEST_NAME).is_file() {
            return Err(CmdError::new(
                code::NESTED_LIBRARY_BOUNDARY,
                format!(
                    "{} 位于另一个知识库内（它自己有 library.json），不能在本库中作为节点",
                    rel_of(ctx, dir)
                ),
            )
            .with_detail(serde_json::json!({
                "relativePath": rel_of(ctx, dir),
                "boundary": rel_of(ctx, &current),
            })));
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => break,
        }
    }
    Ok(())
}

/* ------------------------------ 文件夹命名 ------------------------------ */

/// 标题 → 磁盘文件夹名。
///
/// 用户标题里可以出现任何字符（含 `/ : * ? " < > |` 与 Windows 设备名 `CON`），
/// 但文件夹名必须是合法的一段路径。这里把路径分隔符换成下划线而不是截断，
/// 「数学/线性代数」应该得到「数学_线性代数」，而不是丢掉前半截。
///
/// 长度按**字节**收敛到 180：中文标题按字符数截断会得到 500+ 字节的名字，
/// 加上知识库路径后很容易越过 Windows 的 MAX_PATH。
pub fn sanitize_folder_name(title: &str) -> String {
    let flattened = title.replace(['/', '\\'], "_");
    let cleaned = paths::safe_file_name(&flattened);
    let limited = truncate_utf8(&cleaned, MAX_FOLDER_NAME_BYTES);
    if limited.is_empty() {
        "unnamed".to_string()
    } else {
        limited
    }
}

/// 单段文件夹名上限（字节）。`safe_file_name` 已按 180 **字符**截断，
/// 这里再按字节收一次，保证多字节标题不会撑爆路径长度。
const MAX_FOLDER_NAME_BYTES: usize = 180;

fn truncate_utf8(raw: &str, max_bytes: usize) -> String {
    if raw.len() <= max_bytes {
        return raw.to_string();
    }
    let mut out = String::new();
    for ch in raw.chars() {
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

/// 在 `parent` 下找一个还不存在的目录名：`标题`、`标题 (2)`、`标题 (3)`…
///
/// 同名节点是正常操作（两个「注意力机制」），绝不能覆盖已有文件夹。
pub fn unique_child_dir(parent: &Path, base: &str) -> CmdResult<PathBuf> {
    let base = if base.trim().is_empty() {
        "unnamed".to_string()
    } else {
        base.to_string()
    };
    let first = parent.join(&base);
    if !first.exists() {
        return Ok(first);
    }
    for index in 2..=1000 {
        let candidate = parent.join(format!("{base} ({index})"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(CmdError::new(
        code::CONFLICT,
        format!(
            "{} 下同名文件夹过多，无法为新节点找到可用名字",
            parent.display()
        ),
    ))
}

/* -------------------------------- 新建节点 -------------------------------- */

/// 在 `parent_rel`（默认 `library.json.scan` 之外的 `defaults.newNodeParent`）下
/// 新建节点：安全化标题文件夹 + `node.json`。不写笔记、不建关系、不建对话。
///
/// `parent_rel` 为 `None`/空白时用清单里的默认位置；显式传空串表示知识库根目录。
pub fn create_node(ctx: &LibCtx, title: &str, parent_rel: Option<&str>) -> CmdResult<ScannedNode> {
    ctx.require_writable()?;
    let title = title.trim();
    if title.is_empty() {
        return Err(CmdError::invalid("节点标题不能为空"));
    }

    let parent_relative = match parent_rel {
        None => ctx.manifest().new_node_parent().to_string(),
        Some(raw) if raw.trim().is_empty() => String::new(), // 显式要求放在库根
        Some(raw) => raw.trim().trim_matches('/').to_string(),
    };

    let parent_dir = if parent_relative.is_empty() {
        ctx.root().to_path_buf()
    } else {
        ctx.resolve_new(&parent_relative)?
    };
    atomic::ensure_dir(&parent_dir)?;
    assert_not_in_nested_library(ctx, &parent_dir)?;

    let folder = sanitize_folder_name(title);
    let node_dir = unique_child_dir(&parent_dir, &folder)?;
    atomic::ensure_dir(&node_dir)?;

    let meta = NodeMeta::new(
        paths::new_id(),
        title.to_string(),
        paths::iso_now(),
    );
    let meta_path = vpaths::node_meta_file(&node_dir);
    let fp = atomic::write_json(&meta_path, &meta)?;
    scanned_node_of(ctx, &node_dir, &meta, &fp)
}

/* -------------------------------- 认领文件夹 -------------------------------- */

/// 把一个**已存在**的普通文件夹认领为节点：只在其中创建
/// `.meta/knowledgenet/node.json`，不移动、不改名、不动任何已有文件。
///
/// 已经存在合法标记时返回 `conflict`（而不是覆盖）——调用方应该改用
/// `reassign_duplicate_node_id` 或直接读取它；标记存在但坏了时把解析错误原样抛出，
/// 让用户先修文件，绝不静默替换别人的内容。
pub fn adopt_folder(
    ctx: &LibCtx,
    relative_path: &str,
    title: Option<&str>,
) -> CmdResult<ScannedNode> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(relative_path)?;
    assert_not_in_nested_library(ctx, &node_dir)?;

    let meta_path = vpaths::node_meta_file(&node_dir);
    if meta_path.exists() {
        let relative = rel_of(ctx, &meta_path);
        if meta_path.is_file() {
            // 合法标记 → 冲突；损坏/高版本 → 原样抛解析错误
            let (existing, _fp): (NodeMeta, Fingerprint) = atomic::read_typed(
                &meta_path,
                NODE_FORMAT,
                NODE_FORMAT_VERSION,
                "node.json",
                Some(&relative),
            )?;
            return Err(CmdError::new(
                code::CONFLICT,
                format!(
                    "{} 已经是一个节点（「{}」），已拒绝覆盖它的元数据",
                    rel_of(ctx, &node_dir),
                    existing.title
                ),
            )
            .with_detail(serde_json::json!({
                "relativePath": rel_of(ctx, &node_dir),
                "nodeId": existing.id,
                "reason": "already_node",
            })));
        }
        return Err(CmdError::new(
            code::CONFLICT,
            format!("{relative} 已被占用（不是一个普通文件），已拒绝覆盖"),
        )
        .with_detail(serde_json::json!({
            "relativePath": relative,
            "reason": "marker_occupied",
        })));
    }

    let fallback_title = folder_name_of(ctx, &node_dir);
    let title = title
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .unwrap_or(&fallback_title)
        .to_string();

    let meta = NodeMeta::new(paths::new_id(), title, paths::iso_now());
    let fp = atomic::write_json(&meta_path, &meta)?;
    scanned_node_of(ctx, &node_dir, &meta, &fp)
}

/* -------------------------------- 读取元数据 -------------------------------- */

/// 读 `node.json`（含指纹）。文件缺失/坏掉/版本不支持都返回结构化错误码。
pub fn read_node_meta(ctx: &LibCtx, relative_path: &str) -> CmdResult<(NodeMeta, Fingerprint)> {
    let node_dir = ctx.node_dir(relative_path)?;
    let meta_path = vpaths::node_meta_file(&node_dir);
    let relative = rel_of(ctx, &meta_path);
    atomic::read_typed::<NodeMeta>(
        &meta_path,
        NODE_FORMAT,
        NODE_FORMAT_VERSION,
        "node.json",
        Some(&relative),
    )
}

/// 读节点 ID（大多数写操作都要用它给 `relations.json` / `resources.json` 定身份）。
pub(crate) fn node_id_of(ctx: &LibCtx, relative_path: &str) -> CmdResult<String> {
    Ok(read_node_meta(ctx, relative_path)?.0.id)
}

/* -------------------------------- 更新元数据 -------------------------------- */

/// 元数据补丁：字段为 `None` 表示不动；`primary_document` 用两层 `Option`
/// 区分「不动」与「清空」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetaPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub aliases: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<LearnStatus>,
    #[serde(default)]
    pub primary_document: Option<Option<String>>,
}

/// 改元数据：**同时**校验修订号与磁盘 SHA-256，不符即 `external_change_conflict`。
///
/// `expected_revision` 传负数表示「只校验哈希」（首次写入等场景）；
/// `expected_hash` 传 `None`/空串表示「只校验修订号」。
pub fn update_node_meta(
    ctx: &LibCtx,
    relative_path: &str,
    patch: &NodeMetaPatch,
    expected_revision: i64,
    expected_hash: Option<&str>,
) -> CmdResult<(NodeMeta, Fingerprint)> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(relative_path)?;
    let meta_path = vpaths::node_meta_file(&node_dir);
    let relative = rel_of(ctx, &meta_path);
    let (mut meta, fp): (NodeMeta, Fingerprint) = atomic::read_typed(
        &meta_path,
        NODE_FORMAT,
        NODE_FORMAT_VERSION,
        "node.json",
        Some(&relative),
    )?;

    atomic::ensure_unchanged(
        &relative,
        meta.revision,
        expected_revision,
        &fp.sha256,
        expected_hash,
    )?;

    if let Some(title) = &patch.title {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(CmdError::invalid("节点标题不能为空"));
        }
        meta.title = trimmed.to_string();
    }
    if let Some(aliases) = &patch.aliases {
        meta.aliases = aliases
            .iter()
            .map(|alias| alias.trim().to_string())
            .filter(|alias| !alias.is_empty())
            .collect();
    }
    if let Some(status) = patch.status {
        meta.status = status;
    }
    if let Some(document) = &patch.primary_document {
        meta.primary_document = match document {
            Some(raw) if !raw.trim().is_empty() => Some(validate_primary_document(raw)?),
            _ => None,
        };
    }

    meta.bump(paths::iso_now());
    let new_fp = atomic::write_json(&meta_path, &meta)?;
    Ok((meta, new_fp))
}

/* ------------------------------ 移除节点身份 ------------------------------ */

/// 一条已移除的节点身份（回收站里的元数据归档）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedIdentity {
    pub node_id: String,
    /// 原来所在的相对路径（恢复时的默认位置）
    pub relative_path: String,
    /// 归档位置（相对知识库根）：`.knowledgenet/trash/node-metadata/<id>/<time>`
    pub trashed_relative: String,
    pub deleted_at: i64,
    pub title: String,
    /// 与 `relative_path` 同值；保留这个字段是为了和前端既有类型对齐
    pub node_relative_path: String,
}

/// 归档目录里的位置说明。**只在回收站里**，节点目录不受影响。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemovedRecord {
    format: String,
    format_version: i64,
    node_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    original_relative_path: String,
    #[serde(default)]
    deleted_at: i64,
    #[serde(default)]
    deleted_at_iso: String,
    #[serde(default)]
    node_file: String,
    #[serde(default)]
    note: String,
}

/// 「从知识库移除节点身份」：把 `<节点>/.meta/knowledgenet` 整体移到
/// `.knowledgenet/trash/node-metadata/<id>/<now_ms>/`。
///
/// **节点文件夹与其中全部用户文件原位不动**；`.meta` 里若还有别的软件的内容就保留，
/// 只有空了才删掉空目录（设计文档 §6.3）。
pub fn remove_node_identity(ctx: &LibCtx, relative_path: &str) -> CmdResult<RemovedIdentity> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(relative_path)?;
    let (meta, _fp) = read_node_meta(ctx, relative_path)?;

    let ns_dir = vpaths::ns_dir(&node_dir);
    if !ns_dir.is_dir() {
        return Err(CmdError::not_found(format!(
            "{} 里没有 .meta/knowledgenet，无法移除节点身份",
            rel_of(ctx, &node_dir)
        )));
    }

    let deleted_at = paths::now_ms();
    let trash_dir = vpaths::removed_identity_dir(ctx.root(), &meta.id, deleted_at);
    let original = ctx.relative_of(&node_dir)?;

    move_dir(&ns_dir, &trash_dir)?;

    // 归档里记下「原来在哪、什么时候移的」。写不进去不影响元数据本身，
    // 恢复时还可以由用户指定位置，所以这里不让它把整个操作判失败。
    let record = RemovedRecord {
        format: REMOVED_RECORD_FORMAT.to_string(),
        format_version: REMOVED_RECORD_FORMAT_VERSION,
        node_id: meta.id.clone(),
        title: meta.title.clone(),
        original_relative_path: original.clone(),
        deleted_at,
        deleted_at_iso: paths::iso_from_ms(deleted_at),
        node_file: vpaths::NODE_FILE.to_string(),
        note: "这是「移除节点身份」时归档的 KnowledgeNet 元数据；节点文件夹与用户文件没有被移动。"
            .to_string(),
    };
    if let Err(err) = atomic::write_json(&trash_dir.join(REMOVED_RECORD_FILE), &record) {
        eprintln!("写入归档说明失败（不影响元数据本身）：{}", err.message);
    }

    // `.meta` 空了才删；还有别的软件的内容就留着
    let meta_root = node_dir.join(vpaths::META_DIR);
    let _ = atomic::remove_dir_if_empty(&meta_root);

    Ok(RemovedIdentity {
        node_id: meta.id,
        relative_path: original.clone(),
        trashed_relative: ctx.relative_of(&trash_dir)?,
        deleted_at,
        title: meta.title,
        node_relative_path: original,
    })
}

/// 列出回收站里的全部节点身份归档（按移除时间倒序）。
///
/// 归档里只有**元数据副本**，没有任何用户文件；读的是归档里的 `node.json`。
pub fn list_removed_identities(ctx: &LibCtx) -> CmdResult<Vec<RemovedIdentity>> {
    let base = vpaths::root_trash_dir(ctx.root()).join(vpaths::NODE_METADATA_TRASH_DIR);
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<RemovedIdentity> = Vec::new();
    let id_dirs = fs::read_dir(&base)
        .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", base.display())))?;
    for id_entry in id_dirs.flatten() {
        if !id_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id_path = id_entry.path();
        let stamps = fs::read_dir(&id_path)
            .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", id_path.display())))?;
        for stamp_entry in stamps.flatten() {
            if !stamp_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = stamp_entry.file_name().to_string_lossy().to_string();
            let Ok(deleted_at) = name.parse::<i64>() else {
                continue;
            };
            let archive = stamp_entry.path();
            let relative = rel_of(ctx, &archive);

            let record = atomic::read_json_opt::<RemovedRecord>(
                &archive.join(REMOVED_RECORD_FILE),
            )
            .ok()
            .flatten()
            .map(|(value, _fp)| value);

            // 归档里必须还有身份文件；读不出来的归档不列出来（损坏的归档不该被恢复）
            let meta = match atomic::read_typed::<NodeMeta>(
                &archive.join(vpaths::NODE_FILE),
                NODE_FORMAT,
                NODE_FORMAT_VERSION,
                "node.json",
                Some(&format!("{relative}/{}", vpaths::NODE_FILE)),
            ) {
                Ok((meta, _fp)) => meta,
                Err(_) => continue,
            };

            let original = record
                .as_ref()
                .map(|r| r.original_relative_path.clone())
                .filter(|p| !p.is_empty())
                .unwrap_or_default();

            out.push(RemovedIdentity {
                node_id: meta.id.clone(),
                relative_path: original.clone(),
                trashed_relative: relative,
                deleted_at: record
                    .as_ref()
                    .map(|r| r.deleted_at)
                    .filter(|v| *v > 0)
                    .unwrap_or(deleted_at),
                title: if meta.title.trim().is_empty() {
                    record
                        .as_ref()
                        .map(|r| r.title.clone())
                        .unwrap_or_default()
                } else {
                    meta.title.clone()
                },
                node_relative_path: original,
            });
        }
    }
    out.sort_by(|a, b| {
        b.deleted_at
            .cmp(&a.deleted_at)
            .then_with(|| a.node_id.cmp(&b.node_id))
    });
    Ok(out)
}

/// 找出某个节点 ID 最新的一份归档目录。
fn newest_archive(ctx: &LibCtx, node_id: &str) -> CmdResult<Option<(i64, PathBuf)>> {
    let parent = vpaths::removed_identity_parent(ctx.root(), node_id);
    if !parent.is_dir() {
        return Ok(None);
    }
    let mut stamps: Vec<(i64, PathBuf)> = Vec::new();
    let entries = fs::read_dir(&parent)
        .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", parent.display())))?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Ok(stamp) = name.parse::<i64>() {
            if entry.path().join(vpaths::NODE_FILE).is_file() {
                stamps.push((stamp, entry.path()));
            }
        }
    }
    stamps.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(stamps.into_iter().next())
}

/// 恢复节点身份：把归档元数据放回节点文件夹。
///
/// `target_relative` 为空时用归档里记录的原路径。原路径已被占用（已有另一份元数据、
/// 或那里是一个文件）时**停止并报错**，让用户另选位置，绝不覆盖任何东西。
pub fn restore_node_identity(
    ctx: &LibCtx,
    node_id: &str,
    target_relative: Option<&str>,
) -> CmdResult<ScannedNode> {
    ctx.require_writable()?;
    paths::require_uuid(node_id, "nodeId")?;

    let (_deleted_at, archive) = newest_archive(ctx, node_id)?.ok_or_else(|| {
        CmdError::not_found(format!(
            "回收站里没有节点 {node_id} 的元数据归档（可能已经被永久清理）"
        ))
    })?;

    let record = atomic::read_json_opt::<RemovedRecord>(&archive.join(REMOVED_RECORD_FILE))
        .ok()
        .flatten()
        .map(|(value, _fp)| value);

    let target = match target_relative.map(|t| t.trim()).filter(|t| !t.is_empty()) {
        Some(raw) => raw.trim_matches('/').to_string(),
        None => record
            .as_ref()
            .map(|r| r.original_relative_path.trim_matches('/').to_string())
            .filter(|p| !p.is_empty())
            .ok_or_else(|| {
                CmdError::invalid(
                    "这份归档没有记录原路径，请指定要恢复到哪个文件夹".to_string(),
                )
            })?,
    };

    let target_dir = ctx.node_dir_unchecked(&target)?;
    let marker = target_dir.join(vpaths::NODE_MARKER_RELATIVE);
    if marker.exists() {
        // 给界面一个可直接采用的替代位置（同层加序号），避免用户又要手打一遍路径
        let suggested = match (target_dir.parent(), target_dir.file_name()) {
            (Some(parent), Some(name)) => unique_child_dir(parent, &name.to_string_lossy())
                .ok()
                .and_then(|path| ctx.relative_of(&path).ok())
                .unwrap_or_else(|| rel_of(ctx, &target_dir)),
            _ => rel_of(ctx, &target_dir),
        };
        return Err(CmdError::new(
            code::CONFLICT,
            format!(
                "{} 里已经有一份节点元数据，已停止恢复；请选择另一个位置",
                rel_of(ctx, &target_dir)
            ),
        )
        .with_detail(serde_json::json!({
            "relativePath": target,
            "reason": "target_occupied",
            "suggestedRelativePath": suggested,
        })));
    }
    if target_dir.exists() && !target_dir.is_dir() {
        return Err(CmdError::new(
            code::CONFLICT,
            format!("{} 已经被一个同名文件占用", rel_of(ctx, &target_dir)),
        ));
    }
    assert_not_in_nested_library(ctx, &target_dir)?;

    atomic::ensure_dir(&vpaths::ns_dir(&target_dir))?;
    let ns_dir = vpaths::ns_dir(&target_dir);

    // 先搬内容文件，`node.json` 放最后：中途失败也不会留下一个「半份节点」
    let mut entries: Vec<PathBuf> = fs::read_dir(&archive)
        .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", archive.display())))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy() != REMOVED_RECORD_FILE)
                .unwrap_or(false)
        })
        .collect();
    entries.sort_by_key(|path| {
        let is_marker = path
            .file_name()
            .map(|name| name.to_string_lossy() == vpaths::NODE_FILE)
            .unwrap_or(false);
        if is_marker {
            1
        } else {
            0
        }
    });

    for source in entries {
        let name = source
            .file_name()
            .map(|n| n.to_os_string())
            .ok_or_else(|| CmdError::internal("归档目录里出现了没有名字的条目"))?;
        let destination = ns_dir.join(&name);
        if destination.exists() {
            return Err(CmdError::new(
                code::CONFLICT,
                format!(
                    "目标 {} 里已经有 {}，已停止恢复",
                    rel_of(ctx, &ns_dir),
                    name.to_string_lossy()
                ),
            ));
        }
        fs::rename(&source, &destination).map_err(|e| {
            CmdError::io(format!(
                "恢复 {} 到 {} 失败：{e}",
                source.display(),
                destination.display()
            ))
        })?;
    }

    // 收拾空壳归档：说明文件 + 空目录（父目录空了也一起收）
    let _ = fs::remove_file(archive.join(REMOVED_RECORD_FILE));
    let _ = atomic::remove_dir_if_empty(&archive);
    if let Some(parent) = archive.parent() {
        let _ = atomic::remove_dir_if_empty(parent);
    }

    let (meta, fp) = read_node_meta(ctx, &target)?;
    scanned_node_of(ctx, &target_dir, &meta, &fp)
}

/// 永久清理：只删 `.knowledgenet/trash` 里的**元数据副本**，不碰任何普通用户文件。
pub fn purge_removed_identity(ctx: &LibCtx, node_id: &str, deleted_at: i64) -> CmdResult<()> {
    ctx.require_writable()?;
    paths::require_uuid(node_id, "nodeId")?;

    let base = vpaths::root_trash_dir(ctx.root()).join(vpaths::NODE_METADATA_TRASH_DIR);
    let target = vpaths::removed_identity_dir(ctx.root(), node_id, deleted_at);
    // 只允许删 trash/node-metadata/<id>/<数字> 这一层，杜绝任何路径拼错的可能
    if !target.starts_with(&base) || target.parent().and_then(|p| p.parent()) != Some(base.as_path())
    {
        return Err(CmdError::invalid(format!(
            "拒绝清理不在回收站元数据目录内的路径：{}",
            target.display()
        )));
    }
    if !target.is_dir() {
        return Err(CmdError::not_found(format!(
            "回收站里没有这条归档：{}",
            rel_of(ctx, &target)
        )));
    }
    fs::remove_dir_all(&target)
        .map_err(|e| CmdError::io(format!("删除 {} 失败：{e}", target.display())))?;
    if let Some(parent) = target.parent() {
        let _ = atomic::remove_dir_if_empty(parent);
    }
    Ok(())
}

/* ----------------------------- 重复 ID 重编 ----------------------------- */

/// 把某个 JSON 文件里的 `nodeId` 换成新 ID（保留其它字段与未知字段）。
///
/// `format` 不匹配时什么都不做（返回 `false`），避免误改别的软件的文件。
fn rewrite_owner_node_id(path: &Path, expected_format: &str, new_id: &str) -> CmdResult<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let (mut value, _fp) = atomic::read_json_value(path)?;
    let Some(object) = value.as_object_mut() else {
        return Ok(false);
    };
    if object.get("format").and_then(|v| v.as_str()) != Some(expected_format) {
        return Ok(false);
    }
    object.insert(
        "nodeId".to_string(),
        serde_json::Value::String(new_id.to_string()),
    );
    if let Some(revision) = object.get("revision").and_then(|v| v.as_i64()) {
        object.insert("revision".to_string(), serde_json::json!(revision + 1));
    }
    if object.contains_key("updatedAt") {
        object.insert(
            "updatedAt".to_string(),
            serde_json::Value::String(paths::iso_now()),
        );
    }
    atomic::write_json(path, &value)?;
    Ok(true)
}

/// 给复制出来的节点分配新 ID。
///
/// 只改**这个副本自己**的文件：
///
/// - `node.json` 的 `id`；
/// - `chats/*/thread.json` 的 `nodeId`（消息文件里的 `threadId` 不动，消息根本没有
///   `nodeId` 字段）；
/// - 本目录 `relations.json` / `resources.json` / `bookmarks.json` / `notes-index.json`
///   的 `nodeId`。
///
/// **不得**修改其它节点对旧 ID 的引用：那些引用现在指向原来那个节点，
/// 副本只是多了一个新身份。
pub fn reassign_duplicate_node_id(ctx: &LibCtx, relative_path: &str) -> CmdResult<ScannedNode> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(relative_path)?;
    let meta_path = vpaths::node_meta_file(&node_dir);
    let relative = rel_of(ctx, &meta_path);
    let (mut meta, _fp): (NodeMeta, Fingerprint) = atomic::read_typed(
        &meta_path,
        NODE_FORMAT,
        NODE_FORMAT_VERSION,
        "node.json",
        Some(&relative),
    )?;

    let new_id = paths::new_id();
    meta.id = new_id.clone();
    meta.bump(paths::iso_now());
    let fp = atomic::write_json(&meta_path, &meta)?;

    let chats = vpaths::chats_dir(&node_dir);
    if chats.is_dir() {
        let entries = fs::read_dir(&chats)
            .map_err(|e| CmdError::io(format!("读取 {} 失败：{e}", chats.display())))?;
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let thread = entry.path().join(vpaths::THREAD_FILE);
            rewrite_owner_node_id(&thread, super::schema::THREAD_FORMAT, &new_id)?;
        }
    }

    rewrite_owner_node_id(
        &vpaths::relations_file(&node_dir),
        super::schema::RELATIONS_FORMAT,
        &new_id,
    )?;
    rewrite_owner_node_id(
        &vpaths::resources_file(&node_dir),
        super::schema::RESOURCES_FORMAT,
        &new_id,
    )?;
    rewrite_owner_node_id(
        &vpaths::bookmarks_file(&node_dir),
        super::schema::BOOKMARKS_FORMAT,
        &new_id,
    )?;
    rewrite_owner_node_id(
        &vpaths::ns_dir(&node_dir).join(super::notes::NOTES_INDEX_FILE),
        super::notes::NOTES_INDEX_FORMAT,
        &new_id,
    )?;

    scanned_node_of(ctx, &node_dir, &meta, &fp)
}

/* --------------------------- 彻底删除与删除前备份 --------------------------- */

/// 一个节点文件夹在磁盘上占了多少。
///
/// 只回答「文件夹里有什么」，不回答「知识图里连着谁」：关系与对话数量前端手上就有，
/// 而**删除前那句文字提醒必须说得具体**（几个文件、多大），只能从磁盘上量。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeFolderUsage {
    pub relative_path: String,
    /// 整个文件夹里的文件数（**含 `.meta/**` 的元数据**）：删除后真的会消失的就是这些
    pub file_count: i64,
    pub byte_size: i64,
    /// 普通用户文件（不含 `.meta/**`，也不含嵌套节点子树）
    pub resource_count: i64,
    pub resource_bytes: i64,
    /// 子目录数（不含文件夹自己）
    pub directory_count: i64,
    /// 文件夹里还嵌着几个**下级知识点**（子目录里带 `.meta/knowledgenet/node.json` 的）
    ///
    /// 必须单独报出来：删除父文件夹会把它们连同各自的文件一起带走，
    /// 而使用者很容易忘记「这个文件夹里还套着一个知识点」。
    pub nested_node_count: i64,
}

/// 删除前备份的结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBackup {
    pub node_id: String,
    pub title: String,
    /// 备份前节点所在的相对路径
    pub relative_path: String,
    /// 备份位置的**库内相对路径**（`.knowledgenet/backups/<时间戳>-<名字>`）
    pub backup_relative_path: String,
    /// 备份位置的绝对路径：界面上要能整段复制出来，去资源管理器里找得到
    pub backup_path: String,
    pub file_count: i64,
    pub byte_size: i64,
    pub created_at: i64,
}

/// 彻底删除的结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeErasure {
    pub node_id: String,
    pub title: String,
    pub relative_path: String,
    pub deleted_files: i64,
    pub deleted_bytes: i64,
    /// 顺带清掉的回收站元数据归档数（那些归档指向的文件夹已经不存在了）
    pub purged_archives: i64,
}

/// 根目录本身是节点时，删除与备份都不成立：删它会连整个知识库一起删掉。
fn assert_not_library_root_node(ctx: &LibCtx, node_dir: &Path) -> CmdResult<()> {
    if node_dir == ctx.root() {
        return Err(CmdError::new(
            code::CONFLICT,
            "知识库根目录本身是一个节点：删掉它会连整个知识库一起没了，这一步已拒绝"
                .to_string(),
        ));
    }
    Ok(())
}

/// 量一下节点文件夹：文件数、字节数、子目录数。
///
/// 这里数的是**文件夹里的一切**（含 `.meta/knowledgenet`）：删除会带走的就是这些，
/// 少算元数据会让那句提醒变得不诚实。`resource_*` 另外给一份「用户自己的东西」，
/// 因为「备份」按钮的意义主要在那儿。
pub fn inspect_node_folder(ctx: &LibCtx, node_rel: &str) -> CmdResult<NodeFolderUsage> {
    let node_dir = ctx.node_dir(node_rel)?;
    assert_not_library_root_node(ctx, &node_dir)?;
    let relative = ctx.relative_of(&node_dir)?;

    let mut file_count = 0i64;
    let mut byte_size = 0i64;
    let mut directory_count = 0i64;
    let mut nested_node_count = 0i64;
    for entry in walkdir::WalkDir::new(&node_dir).follow_links(false) {
        // 单个条目读不了（权限、被占用）不该让整次体检失败
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        if paths::is_link_like(entry.path()) {
            continue;
        }
        let file_type = entry.file_type();
        if file_type.is_dir() {
            directory_count += 1;
            // 嵌套节点不剪枝：删除会把它的文件一起带走，所以文件数照算，
            // 但要单独数出「里面还套着几个知识点」告诉使用者
            if entry.path().join(vpaths::NODE_MARKER_RELATIVE).is_file() {
                nested_node_count += 1;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        file_count += 1;
        byte_size += entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
    }

    let plain = super::resources::list_plain_files(ctx, node_rel).unwrap_or_default();
    let resource_count = plain.len() as i64;
    let resource_bytes: i64 = plain.iter().map(|file| file.byte_length).sum();

    Ok(NodeFolderUsage {
        relative_path: relative,
        file_count,
        byte_size,
        resource_count,
        resource_bytes,
        directory_count,
        nested_node_count,
    })
}

/// 备份目录名里的时间戳：`20260920-223012`（本地时间，用户要在资源管理器里认出来）。
fn backup_stamp(ms: i64) -> String {
    use chrono::{Local, TimeZone};

    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y%m%d-%H%M%S").to_string())
        .unwrap_or_else(|| ms.to_string())
}

/// 把整个节点文件夹**整份复制**到 `<root>/.knowledgenet/backups/<时间戳>-<文件夹名>/`。
///
/// 复制的是「原样的这一份」，连 `.meta` 一起：不但资料留着，知识身份也留着，
/// 需要时把备份目录拷回原处就又是一模一样的节点。
pub fn backup_node_folder(ctx: &LibCtx, node_rel: &str) -> CmdResult<NodeBackup> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(node_rel)?;
    assert_not_library_root_node(ctx, &node_dir)?;
    let (meta, _fp) = read_node_meta(ctx, node_rel)?;
    let relative = ctx.relative_of(&node_dir)?;

    let backups_root = vpaths::root_backups_dir(ctx.root());
    atomic::ensure_dir(&backups_root)?;
    let stamp = backup_stamp(paths::now_ms());
    let base = format!("{stamp}-{}", sanitize_folder_name(&folder_name_of(ctx, &node_dir)));
    // 同一秒里备份两次是正常操作（先备份、再改主意、再备份一次），不能覆盖前一份
    let destination = unique_child_dir(&backups_root, &base)?;

    let (file_count, byte_size) = paths::copy_dir_recursive(&node_dir, &destination)?;
    Ok(NodeBackup {
        node_id: meta.id,
        title: meta.title,
        relative_path: relative,
        backup_relative_path: ctx.relative_of(&destination)?,
        backup_path: destination.display().to_string(),
        file_count,
        byte_size: byte_size as i64,
        created_at: paths::now_ms(),
    })
}

/// **彻底删除**：节点文件夹连同里面的文件一起从磁盘上删掉，不可撤销。
///
/// 与 `remove_node_identity` 的区别就是这一个动作的全部意义：那一个只搬走元数据、
/// 把文件夹留在原地（于是它变成一个谁也看不见、却还占着磁盘的文件夹），
/// 这一步把文件夹本身也删掉。界面上按下它之前必须用文字说清后果，并提供备份入口；
/// **命令本身不做二次确认**——确认是界面的事，这里只保证守卫齐全、后果可计量。
///
/// 顺带清掉回收站里属于这个节点的元数据归档：文件夹都没了，留着归档只会让
/// 「恢复节点身份」变出一个空的、没有任何资料的节点。
pub fn erase_node_folder(ctx: &LibCtx, node_rel: &str) -> CmdResult<NodeErasure> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(node_rel)?;
    assert_not_library_root_node(ctx, &node_dir)?;
    let (meta, _fp) = read_node_meta(ctx, node_rel)?;
    let relative = ctx.relative_of(&node_dir)?;
    // 先量再删：删完就没得量了
    let usage = inspect_node_folder(ctx, &relative)?;

    fs::remove_dir_all(&node_dir).map_err(|e| {
        CmdError::io(format!(
            "删除文件夹 {} 失败：{e}（可能有文件正被其它程序占用）",
            node_dir.display()
        ))
    })?;

    let archives = vpaths::removed_identity_parent(ctx.root(), &meta.id);
    let mut purged_archives = 0i64;
    if archives.is_dir() {
        if let Ok(entries) = fs::read_dir(&archives) {
            purged_archives = entries
                .flatten()
                .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .count() as i64;
        }
        atomic::remove_dir_all_if_exists(&archives)?;
    }

    Ok(NodeErasure {
        node_id: meta.id,
        title: meta.title,
        relative_path: relative,
        deleted_files: usage.file_count,
        deleted_bytes: usage.byte_size,
        purged_archives,
    })
}

/* ------------------------------ 打开文件管理器 ------------------------------ */

/// 在系统文件管理器里显示路径：文件用「选中它」，目录用「打开它」。
///
/// 用 `std::process::Command` 直接调系统程序，不引入额外依赖；`spawn` 而不是 `wait`，
/// 因为文件管理器不会自己退出（`explorer` 甚至经常返回非零退出码）。
pub fn open_in_file_manager(path: &Path) -> CmdResult<()> {
    if !path.exists() {
        return Err(CmdError::not_found(format!(
            "路径不存在，无法在文件管理器中打开：{}",
            path.display()
        )));
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");
        if path.is_dir() {
            command.arg(path);
        } else {
            // `/select,` 与路径必须是同一个参数
            command.arg(format!("/select,{}", path.display()));
        }
        command
            .spawn()
            .map_err(|e| CmdError::io(format!("启动资源管理器失败：{e}")))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if !path.is_dir() {
            command.arg("-R");
        }
        command
            .arg(path)
            .spawn()
            .map_err(|e| CmdError::io(format!("启动访达失败：{e}")))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // 文件没有统一的「选中」协议，退回打开它所在目录
        let target = if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.to_path_buf())
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| CmdError::io(format!("启动文件管理器失败：{e}")))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(CmdError::internal("当前平台不支持打开文件管理器"))
}
