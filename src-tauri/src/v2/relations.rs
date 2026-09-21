//! 出边（依赖关系）读写：`relations.json` 只存**本节点发出的边**。
//!
//! 契约 `docs/v2-contract.md` §3.7，语义见设计文档 §4.4。
//!
//! 只存出边带来三个必须守住的性质：
//!
//! 1. **写关系只动一个节点目录**（源节点），不会出现两个目录双写不一致。
//! 2. **目标节点缺失时保留这条边**（dangling + 标题快照），绝不自动删除。
//! 3. **同一 (toNodeId, type) 只有一条边**：重复添加是复用，不是插入第二条。

use std::fs;
use std::path::PathBuf;

use crate::models::{code, CmdError, CmdResult};
use crate::paths;

use super::atomic::{self, Fingerprint};
use super::ctx::LibCtx;
use super::nodes;
use super::schema::{
    Evidence, RelationEdge, RelationsFile, Validate, RELATIONS_FORMAT, RELATIONS_FORMAT_VERSION,
};
use super::vpaths;

/// 「文件不存在」时给调用方的指纹：空哈希 + 0 字节。
///
/// 调用方把它原样回传给 [`write`]，写入端据此知道「这是第一次创建」。
pub fn empty_fingerprint() -> Fingerprint {
    Fingerprint {
        sha256: String::new(),
        bytes: 0,
        modified_ms: 0,
    }
}

fn default_relation_type() -> &'static str {
    "prerequisite"
}

/// 读 `relations.json`；文件不存在按「还没有任何出边」处理。
///
/// 返回的文件在「文件不存在」时 revision 为 0——0 就是「磁盘上还没有这份文件」，
/// 这样调用方拿它当 `expected_revision` 回写时不会被自己误判成外部冲突。
pub fn read_or_empty(
    ctx: &LibCtx,
    node_rel: &str,
    node_id: &str,
) -> CmdResult<(RelationsFile, Fingerprint)> {
    let node_dir = ctx.node_dir(node_rel)?;
    let path = vpaths::relations_file(&node_dir);
    let relative = nodes::rel_of(ctx, &path);
    if !path.is_file() {
        let mut file = RelationsFile::empty(node_id.to_string());
        file.revision = 0;
        return Ok((file, empty_fingerprint()));
    }
    let (mut file, fp): (RelationsFile, Fingerprint) = atomic::read_typed(
        &path,
        RELATIONS_FORMAT,
        RELATIONS_FORMAT_VERSION,
        "relations.json",
        Some(&relative),
    )?;
    file.revision = file.revision.max(0);
    Ok((file, fp))
}

/// 严格读：文件不存在时报 `not_found`。
pub fn read(ctx: &LibCtx, node_rel: &str) -> CmdResult<(RelationsFile, Fingerprint)> {
    let node_dir = ctx.node_dir(node_rel)?;
    let path = vpaths::relations_file(&node_dir);
    let relative = nodes::rel_of(ctx, &path);
    if !path.is_file() {
        return Err(CmdError::new(
            code::NOT_FOUND,
            format!("{} 还不存在：这个节点还没有任何出边", relative),
        )
        .with_detail(serde_json::json!({ "relativePath": relative })));
    }
    atomic::read_typed::<RelationsFile>(
        &path,
        RELATIONS_FORMAT,
        RELATIONS_FORMAT_VERSION,
        "relations.json",
        Some(&relative),
    )
}

/// 带冲突保护的整文件写入（前端「关系编辑器」提交整份出边列表时用）。
///
/// `expected_revision` / `expected_hash` 必须与磁盘一致，否则返回
/// `external_change_conflict` 且**一个字节都不写**。文件原本不存在时只接受
/// 「空」修订号（0 或 1），把「文件被外部删掉」如实报成冲突。
pub fn write(
    ctx: &LibCtx,
    node_rel: &str,
    file: &RelationsFile,
    expected_revision: i64,
    expected_hash: Option<&str>,
) -> CmdResult<Fingerprint> {
    ctx.require_writable()?;
    let node_dir = ctx.node_dir(node_rel)?;
    let path = vpaths::relations_file(&node_dir);
    let relative = nodes::rel_of(ctx, &path);
    let node_id = nodes::node_id_of(ctx, node_rel)?;

    let existing = atomic::fingerprint_opt(&path)?;
    let actual_revision = match &existing {
        Some(fp) => atomic::revision_of(fp, &path)?,
        None => 0,
    };

    match &existing {
        Some(fp) => atomic::ensure_unchanged(
            &relative,
            actual_revision,
            expected_revision,
            &fp.sha256,
            expected_hash,
        )?,
        None => {
            if expected_revision > 1 || expected_hash.map(|h| !h.is_empty()).unwrap_or(false) {
                return Err(atomic::external_conflict(
                    &relative,
                    expected_revision,
                    0,
                    expected_hash,
                    "",
                ));
            }
        }
    }

    let mut out = file.clone();
    // 文件身份由磁盘上的 `node.json` 决定，不接受调用方传进来的 nodeId
    out.node_id = node_id;
    out.revision = actual_revision + 1;
    out.validate_typed()?;
    atomic::write_json(&path, &out)
}

/* ------------------------------ 内部读改写骨架 ------------------------------ */

struct Loaded {
    node_id: String,
    path: PathBuf,
    relative: String,
    file: RelationsFile,
    fingerprint: Option<Fingerprint>,
}

fn load(ctx: &LibCtx, node_rel: &str) -> CmdResult<Loaded> {
    let node_dir = ctx.node_dir(node_rel)?;
    let node_id = nodes::node_id_of(ctx, node_rel)?;
    let path = vpaths::relations_file(&node_dir);
    let relative = nodes::rel_of(ctx, &path);
    let fingerprint = atomic::fingerprint_opt(&path)?;
    let file = match &fingerprint {
        Some(_) => {
            let (file, _fp): (RelationsFile, Fingerprint) = atomic::read_typed(
                &path,
                RELATIONS_FORMAT,
                RELATIONS_FORMAT_VERSION,
                "relations.json",
                Some(&relative),
            )?;
            file
        }
        None => {
            let mut file = RelationsFile::empty(node_id.clone());
            file.revision = 0;
            file
        }
    };
    Ok(Loaded {
        node_id,
        path,
        relative,
        file,
        fingerprint,
    })
}

impl Loaded {
    /// 读改写之后的落盘：守卫用「我们刚读到的那一份」，因此外部编辑器在这之间
    /// 插进来的改动会被抓住，而不是被覆盖。
    fn persist(&self, mut updated: RelationsFile) -> CmdResult<Fingerprint> {
        let actual_revision = match &self.fingerprint {
            Some(fp) => atomic::revision_of(fp, &self.path)?,
            None => 0,
        };
        if let Some(fp) = &self.fingerprint {
            atomic::ensure_unchanged(
                &self.relative,
                actual_revision,
                self.file.revision,
                &fp.sha256,
                Some(&fp.sha256),
            )?;
        } else if self.path.exists() {
            // 读的时候没有、写的时候冒出来了：这是外部改动，必须报冲突
            let fp = atomic::fingerprint(&self.path)?;
            let revision = atomic::revision_of(&fp, &self.path)?;
            return Err(atomic::external_conflict(
                &self.relative,
                self.file.revision,
                revision,
                None,
                &fp.sha256,
            ));
        }
        updated.revision = actual_revision + 1;
        updated.node_id = self.node_id.clone();
        updated.validate_typed()?;
        atomic::write_json(&self.path, &updated)
    }
}

/* --------------------------------- 增删改 --------------------------------- */

/// 加一条出边：同 `toNodeId` + 同 `type` 已经存在时**复用**那条边（保持 v1 的
/// `UNIQUE(from,to,type)` 行为），只有快照为空时才顺手补全标题快照。
///
/// 自环（源节点依赖自己）没有语义，直接拒绝。
pub fn add_edge(
    ctx: &LibCtx,
    node_rel: &str,
    to_node_id: &str,
    to_title: &str,
    relation_type: &str,
    description: &str,
) -> CmdResult<RelationEdge> {
    ctx.require_writable()?;
    paths::require_uuid(to_node_id, "toNodeId")?;

    let loaded = load(ctx, node_rel)?;
    if loaded.node_id == to_node_id {
        return Err(CmdError::invalid(
            "节点不能依赖自己：自环关系没有学习上的意义".to_string(),
        ));
    }
    let type_ = {
        let raw = relation_type.trim();
        if raw.is_empty() {
            default_relation_type().to_string()
        } else {
            raw.to_string()
        }
    };

    if let Some(existing) = loaded
        .file
        .outgoing
        .iter()
        .find(|edge| edge.to_node_id == to_node_id && edge.type_ == type_)
    {
        let mut reused = existing.clone();
        if reused.to_title_snapshot.trim().is_empty() && !to_title.trim().is_empty() {
            let mut file = loaded.file.clone();
            if let Some(edge) = file.outgoing.iter_mut().find(|edge| edge.id == reused.id) {
                edge.to_title_snapshot = to_title.trim().to_string();
                edge.updated_at = paths::iso_now();
            }
            reused.to_title_snapshot = to_title.trim().to_string();
            loaded.persist(file)?;
        }
        return Ok(reused);
    }

    let now = paths::iso_now();
    let mut edge = RelationEdge::new(to_node_id.to_string(), to_title.to_string(), now);
    edge.type_ = type_;
    edge.description = description.to_string();
    edge.validate_typed()?;

    let mut file = loaded.file.clone();
    file.outgoing.push(edge.clone());
    loaded.persist(file)?;
    Ok(edge)
}

/// 删一条出边；找不到时返回 `false`（幂等删除，不报错）。
pub fn remove_edge(ctx: &LibCtx, node_rel: &str, edge_id: &str) -> CmdResult<bool> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    if !loaded.file.outgoing.iter().any(|edge| edge.id == edge_id) {
        return Ok(false);
    }
    let mut file = loaded.file.clone();
    file.outgoing.retain(|edge| edge.id != edge_id);
    loaded.persist(file)?;
    Ok(true)
}

/// 改一条边的「为什么依赖」说明。
pub fn update_edge_description(
    ctx: &LibCtx,
    node_rel: &str,
    edge_id: &str,
    description: &str,
) -> CmdResult<RelationEdge> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    let mut file = loaded.file.clone();
    let edge = file
        .outgoing
        .iter_mut()
        .find(|edge| edge.id == edge_id)
        .ok_or_else(|| {
            CmdError::not_found(format!("{} 里没有 ID 为 {edge_id} 的关系", loaded.relative))
        })?;
    edge.description = description.to_string();
    edge.updated_at = paths::iso_now();
    let updated = edge.clone();
    loaded.persist(file)?;
    Ok(updated)
}

/// 给一条边加来源（选中文字 → 这条依赖是怎么被发现的）。
///
/// 同 ID 视为更新；`id` / `createdAt` 为空时由这里补上。
pub fn add_evidence(
    ctx: &LibCtx,
    node_rel: &str,
    edge_id: &str,
    evidence: &Evidence,
) -> CmdResult<Evidence> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    let mut record = evidence.clone();
    if record.id.trim().is_empty() {
        record.id = paths::new_id();
    }
    if record.created_at.trim().is_empty() {
        record.created_at = paths::iso_now();
    }
    record.validate_typed()?;

    let mut file = loaded.file.clone();
    let edge = file
        .outgoing
        .iter_mut()
        .find(|edge| edge.id == edge_id)
        .ok_or_else(|| {
            CmdError::not_found(format!("{} 里没有 ID 为 {edge_id} 的关系", loaded.relative))
        })?;
    match edge
        .evidence
        .iter_mut()
        .find(|existing| existing.id == record.id)
    {
        Some(existing) => *existing = record.clone(),
        None => edge.evidence.push(record.clone()),
    }
    edge.updated_at = paths::iso_now();
    loaded.persist(file)?;
    Ok(record)
}

/// 删一条来源；不存在时是空操作（重复点击不该报错）。
pub fn delete_evidence(
    ctx: &LibCtx,
    node_rel: &str,
    edge_id: &str,
    evidence_id: &str,
) -> CmdResult<()> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    let mut file = loaded.file.clone();
    let edge = file
        .outgoing
        .iter_mut()
        .find(|edge| edge.id == edge_id)
        .ok_or_else(|| {
            CmdError::not_found(format!("{} 里没有 ID 为 {edge_id} 的关系", loaded.relative))
        })?;
    let before = edge.evidence.len();
    edge.evidence.retain(|item| item.id != evidence_id);
    if edge.evidence.len() == before {
        return Ok(());
    }
    edge.updated_at = paths::iso_now();
    loaded.persist(file)?;
    Ok(())
}

/* --------------------------------- 合并 --------------------------------- */

/// 一次跨文件写入计划：内存里先算好，再逐个原子写。
struct FilePlan {
    path: PathBuf,
    relative: String,
    original: Option<RelationsFile>,
    updated: RelationsFile,
}

/// 把一组改动逐个原子写盘；中途失败就把已经写好的按原值回滚，
/// 并把失败详情放进错误 `detail`（合并节点是多文件操作，失败必须可解释）。
fn write_all_or_rollback(plans: Vec<FilePlan>) -> CmdResult<()> {
    let mut written: Vec<usize> = Vec::new();
    for (index, plan) in plans.iter().enumerate() {
        match atomic::write_json(&plan.path, &plan.updated) {
            Ok(_) => written.push(index),
            Err(err) => {
                let mut rolled_back: Vec<String> = Vec::new();
                let mut rollback_errors: Vec<serde_json::Value> = Vec::new();
                for done in written.iter().rev() {
                    let plan = &plans[*done];
                    let result = match &plan.original {
                        Some(original) => atomic::write_json(&plan.path, original).map(|_| ()),
                        None => match fs::remove_file(&plan.path) {
                            Ok(()) => Ok(()),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                            Err(e) => Err(CmdError::io(format!(
                                "删除 {} 失败：{e}",
                                plan.path.display()
                            ))),
                        },
                    };
                    match result {
                        Ok(()) => rolled_back.push(plan.relative.clone()),
                        Err(rollback_error) => rollback_errors.push(serde_json::json!({
                            "relativePath": plan.relative,
                            "message": rollback_error.message,
                        })),
                    }
                }
                let detail = serde_json::json!({
                    "failedRelativePath": plan.relative,
                    "failedCode": err.code,
                    "failedMessage": err.message,
                    "rolledBack": rolled_back,
                    "rollbackErrors": rollback_errors,
                });
                let mut wrapped = CmdError::new(
                    &err.code,
                    format!(
                        "改接关系失败（{}）：{}；已回滚 {} 个文件",
                        plan.relative,
                        err.message,
                        rolled_back.len()
                    ),
                );
                wrapped.detail = Some(detail);
                return Err(wrapped);
            }
        }
    }
    Ok(())
}

/// 读一个源节点的出边；节点目录不存在时返回 `None`（合并时对缺失节点宽容）。
fn load_or_empty(ctx: &LibCtx, node_rel: &str) -> CmdResult<Option<Loaded>> {
    match ctx.node_dir(node_rel) {
        Ok(_dir) => Ok(Some(load(ctx, node_rel)?)),
        Err(err) if err.code == code::NODE_MISSING => Ok(None),
        Err(err) => Err(err),
    }
}

/// 合并节点时改接：把所有源节点出边里指向 `old_to_id` 的边改成 `new_to_id`。
///
/// 同时做三件事：改接、**去重**（同 `toNodeId` + 同 `type` 只留最早的一条，
/// 被丢掉那条的来源合并进来）、**去掉自环**（改接后指向自己的边没有意义）。
/// 返回改动的边数。写入是「先全部算好，再逐个原子写，失败回滚」。
pub fn repoint_target(
    ctx: &LibCtx,
    from_rels: &[String],
    old_to_id: &str,
    new_to_id: &str,
    new_title: &str,
) -> CmdResult<i64> {
    ctx.require_writable()?;
    paths::require_uuid(old_to_id, "oldToId")?;
    paths::require_uuid(new_to_id, "newToId")?;
    if old_to_id == new_to_id {
        return Ok(0);
    }

    let now = paths::iso_now();
    let mut plans: Vec<FilePlan> = Vec::new();
    let mut changed: i64 = 0;

    for source_rel in from_rels {
        let Some(loaded) = load_or_empty(ctx, source_rel)? else {
            continue;
        };
        // 文件不存在时没有「指向 old 的边」，跳过而不是创建一个空文件
        if loaded.fingerprint.is_none() {
            continue;
        }

        let mut updated = loaded.file.clone();
        let mut changed_here = 0i64;
        for edge in updated.outgoing.iter_mut() {
            if edge.to_node_id == old_to_id {
                edge.to_node_id = new_to_id.to_string();
                if !new_title.trim().is_empty() {
                    edge.to_title_snapshot = new_title.trim().to_string();
                }
                edge.updated_at = now.clone();
                changed_here += 1;
            }
        }

        // 去重 + 去自环（保持原有顺序，保留最早出现的那条）
        let self_id = updated.node_id.clone();
        let mut seen: Vec<(String, String)> = Vec::new();
        let mut kept: Vec<RelationEdge> = Vec::new();
        let mut dropped: Vec<RelationEdge> = Vec::new();
        for edge in updated.outgoing.drain(..) {
            if edge.to_node_id == self_id {
                changed_here += 1;
                dropped.push(edge);
                continue;
            }
            let key = (edge.to_node_id.clone(), edge.type_.clone());
            if seen.contains(&key) {
                changed_here += 1;
                dropped.push(edge);
                continue;
            }
            seen.push(key);
            kept.push(edge);
        }
        // 被丢掉的重复边的来源不能一起丢：合并进保留的那条
        for edge in dropped {
            if edge.to_node_id == self_id {
                continue;
            }
            if let Some(target) = kept.iter_mut().find(|kept_edge| {
                kept_edge.to_node_id == edge.to_node_id && kept_edge.type_ == edge.type_
            }) {
                for evidence in edge.evidence {
                    if !target.evidence.iter().any(|item| item.id == evidence.id) {
                        target.evidence.push(evidence);
                    }
                }
            }
        }
        updated.outgoing = kept;

        if changed_here == 0 {
            continue;
        }
        changed += changed_here;
        plans.push(FilePlan {
            path: loaded.path.clone(),
            relative: loaded.relative.clone(),
            original: Some(loaded.file.clone()),
            updated,
        });
    }

    if plans.is_empty() {
        return Ok(0);
    }
    write_all_or_rollback(plans)?;
    Ok(changed)
}

/// 合并节点时迁移出边：把源节点的出边并入目标节点的 `relations.json`。
///
/// 去重（目标已有的 (toNodeId,type) 不再重复插入，来源合并）、去自环
/// （源依赖目标时，迁移后目标不能依赖自己）。迁移完成后源文件的出边清空。
/// 返回迁移过去的边数。
pub fn move_edges(ctx: &LibCtx, source_rel: &str, target_rel: &str) -> CmdResult<i64> {
    ctx.require_writable()?;
    if source_rel == target_rel {
        return Err(CmdError::invalid(
            "不能把关系迁移到它自己所在的节点".to_string(),
        ));
    }

    let source = load(ctx, source_rel)?;
    let target = load(ctx, target_rel)?;
    if source.fingerprint.is_none() || source.file.outgoing.is_empty() {
        return Ok(0);
    }

    let mut target_file = target.file.clone();
    let mut moved: i64 = 0;
    for edge in source.file.outgoing.iter() {
        if edge.to_node_id == target.node_id {
            // 迁移后就是自环，丢掉（与 repoint_target 的自环规则一致）
            moved += 1;
            continue;
        }
        let key = (edge.to_node_id.clone(), edge.type_.clone());
        if let Some(existing) = target_file
            .outgoing
            .iter_mut()
            .find(|item| (item.to_node_id.clone(), item.type_.clone()) == key)
        {
            for evidence in edge.evidence.iter() {
                if !existing.evidence.iter().any(|item| item.id == evidence.id) {
                    existing.evidence.push(evidence.clone());
                }
            }
            moved += 1;
            continue;
        }
        target_file.outgoing.push(edge.clone());
        moved += 1;
    }

    if moved == 0 {
        return Ok(0);
    }

    let mut source_file = source.file.clone();
    source_file.outgoing.clear();

    write_all_or_rollback(vec![
        FilePlan {
            path: target.path.clone(),
            relative: target.relative.clone(),
            original: target.fingerprint.as_ref().map(|_| target.file.clone()),
            updated: target_file,
        },
        FilePlan {
            path: source.path.clone(),
            relative: source.relative.clone(),
            original: source.fingerprint.as_ref().map(|_| source.file.clone()),
            updated: source_file,
        },
    ])?;
    Ok(moved)
}
