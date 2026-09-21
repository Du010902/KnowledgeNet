//! 节点书签与知识库级学习目标。
//!
//! 契约 `docs/v2-contract.md` §3.10，归属见设计文档 §4.7：
//!
//! - 书签是**节点资产**：`<节点>/.meta/knowledgenet/bookmarks.json`，随节点一起移动；
//! - 学习目标属于**整个知识库**：`<根>/.knowledgenet/goals.json`。
//!
//! 两个文件都是可选文件：不存在时读操作给出「空」而不是报错，
//! 第一次写入时才真正创建。所有写入都带修订号守卫，外部编辑过的文件不会被静默覆盖。

use std::path::{Path, PathBuf};

use crate::models::{CmdError, CmdResult};
use crate::paths;

use super::atomic::{self, Fingerprint};
use super::ctx::LibCtx;
use super::nodes;
use super::schema::{
    BookmarkEntry, BookmarksFile, GoalEntry, GoalsFile, Validate, BOOKMARKS_FORMAT,
    BOOKMARKS_FORMAT_VERSION, GOALS_FORMAT, GOALS_FORMAT_VERSION,
};
use super::vpaths;

/// 「文件不存在」的指纹：调用方拿它当「这是第一次创建」的依据。
fn empty_fingerprint() -> Fingerprint {
    Fingerprint {
        sha256: String::new(),
        bytes: 0,
        modified_ms: 0,
    }
}

/* --------------------------------- 书签 --------------------------------- */

/// 读节点书签；文件不存在时返回空文件（修订号 0）。
pub fn read(ctx: &LibCtx, node_rel: &str) -> CmdResult<(BookmarksFile, Fingerprint)> {
    let node_dir = ctx.node_dir(node_rel)?;
    let node_id = nodes::node_id_of(ctx, node_rel)?;
    let path = vpaths::bookmarks_file(&node_dir);
    if !path.is_file() {
        let mut file = BookmarksFile::empty(node_id);
        file.revision = 0;
        return Ok((file, empty_fingerprint()));
    }
    let relative = nodes::rel_of(ctx, &path);
    let (mut file, fp): (BookmarksFile, Fingerprint) = atomic::read_typed(
        &path,
        BOOKMARKS_FORMAT,
        BOOKMARKS_FORMAT_VERSION,
        "bookmarks.json",
        Some(&relative),
    )?;
    file.revision = file.revision.max(0);
    Ok((file, fp))
}

struct LoadedBookmarks {
    node_id: String,
    path: PathBuf,
    relative: String,
    file: BookmarksFile,
    fingerprint: Option<Fingerprint>,
}

fn load(ctx: &LibCtx, node_rel: &str) -> CmdResult<LoadedBookmarks> {
    let node_dir = ctx.node_dir(node_rel)?;
    let node_id = nodes::node_id_of(ctx, node_rel)?;
    let path = vpaths::bookmarks_file(&node_dir);
    let relative = nodes::rel_of(ctx, &path);
    let fingerprint = atomic::fingerprint_opt(&path)?;
    let file = match &fingerprint {
        Some(_) => {
            let (file, _fp): (BookmarksFile, Fingerprint) = atomic::read_typed(
                &path,
                BOOKMARKS_FORMAT,
                BOOKMARKS_FORMAT_VERSION,
                "bookmarks.json",
                Some(&relative),
            )?;
            file
        }
        None => {
            let mut file = BookmarksFile::empty(node_id.clone());
            file.revision = 0;
            file
        }
    };
    Ok(LoadedBookmarks {
        node_id,
        path,
        relative,
        file,
        fingerprint,
    })
}

impl LoadedBookmarks {
    fn persist(&self, mut updated: BookmarksFile) -> CmdResult<Fingerprint> {
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

/// 保存（新增或覆盖同 ID）一条书签，`revision += 1`。
pub fn save(ctx: &LibCtx, node_rel: &str, bookmark: &BookmarkEntry) -> CmdResult<BookmarkEntry> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;

    let mut record = bookmark.clone();
    if record.id.trim().is_empty() {
        record.id = paths::new_id();
    }
    paths::require_uuid(&record.id, "bookmarkId")?;
    if record.created_at.trim().is_empty() {
        record.created_at = paths::iso_now();
    }
    record.updated_at = paths::iso_now();
    record.validate_typed()?;

    let mut file = loaded.file.clone();
    // 覆盖同 ID：保留原始创建时间，其余字段以本次为准
    let stored = match file
        .bookmarks
        .iter_mut()
        .find(|existing| existing.id == record.id)
    {
        Some(existing) => {
            let created = existing.created_at.clone();
            *existing = record.clone();
            if !created.trim().is_empty() {
                existing.created_at = created;
            }
            existing.clone()
        }
        None => {
            file.bookmarks.push(record.clone());
            record.clone()
        }
    };
    loaded.persist(file)?;
    // 返回磁盘上真实存下来的那一条（overwrite 时 createdAt 来自原记录）
    Ok(stored)
}

/// 删一条书签；找不到时返回 `false`（幂等）。
pub fn delete(ctx: &LibCtx, node_rel: &str, bookmark_id: &str) -> CmdResult<bool> {
    ctx.require_writable()?;
    let loaded = load(ctx, node_rel)?;
    if !loaded
        .file
        .bookmarks
        .iter()
        .any(|item| item.id == bookmark_id)
    {
        return Ok(false);
    }
    let mut file = loaded.file.clone();
    file.bookmarks.retain(|item| item.id != bookmark_id);
    loaded.persist(file)?;
    Ok(true)
}

/* --------------------------------- 目标 --------------------------------- */

/// 读 `.knowledgenet/goals.json`；文件不存在时返回空目标列表（修订号 0）。
pub fn read_goals(ctx: &LibCtx) -> CmdResult<(GoalsFile, Fingerprint)> {
    let path = vpaths::root_goals_file(ctx.root());
    if !path.is_file() {
        let mut file = GoalsFile::empty(ctx.manifest().library_id.clone());
        file.revision = 0;
        return Ok((file, empty_fingerprint()));
    }
    let relative = nodes::rel_of(ctx, &path);
    let (mut file, fp): (GoalsFile, Fingerprint) = atomic::read_typed(
        &path,
        GOALS_FORMAT,
        GOALS_FORMAT_VERSION,
        "goals.json",
        Some(&relative),
    )?;
    file.revision = file.revision.max(0);
    Ok((file, fp))
}

struct LoadedGoals {
    path: PathBuf,
    relative: String,
    file: GoalsFile,
    fingerprint: Option<Fingerprint>,
}

fn load_goals(ctx: &LibCtx) -> CmdResult<LoadedGoals> {
    let path = vpaths::root_goals_file(ctx.root());
    let relative = nodes::rel_of(ctx, &path);
    let fingerprint = atomic::fingerprint_opt(&path)?;
    let file = match &fingerprint {
        Some(_) => {
            let (file, _fp): (GoalsFile, Fingerprint) = atomic::read_typed(
                &path,
                GOALS_FORMAT,
                GOALS_FORMAT_VERSION,
                "goals.json",
                Some(&relative),
            )?;
            file
        }
        None => {
            let mut file = GoalsFile::empty(ctx.manifest().library_id.clone());
            file.revision = 0;
            file
        }
    };
    Ok(LoadedGoals {
        path,
        relative,
        file,
        fingerprint,
    })
}

impl LoadedGoals {
    fn persist(&self, mut updated: GoalsFile) -> CmdResult<Fingerprint> {
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
        updated.library_id = self.file.library_id.clone();
        updated.validate_typed()?;
        atomic::ensure_dir(self.path.parent().unwrap_or(Path::new(".")))?;
        atomic::write_json(&self.path, &updated)
    }
}

/// 新建学习目标。同一个根节点已经有一个目标时复用它（幂等，不重复建）。
pub fn save_goal(ctx: &LibCtx, title: &str, root_node_id: &str) -> CmdResult<GoalEntry> {
    ctx.require_writable()?;
    let title = title.trim();
    if title.is_empty() {
        return Err(CmdError::invalid("目标标题不能为空"));
    }
    paths::require_uuid(root_node_id, "rootNodeId")?;

    let loaded = load_goals(ctx)?;
    if let Some(existing) = loaded
        .file
        .goals
        .iter()
        .find(|goal| goal.root_node_id == root_node_id)
    {
        return Ok(existing.clone());
    }

    let goal = GoalEntry {
        id: paths::new_id(),
        title: title.to_string(),
        root_node_id: root_node_id.to_string(),
        created_at: paths::iso_now(),
        extra: serde_json::Map::new(),
    };
    goal.validate_typed()?;

    let mut file = loaded.file.clone();
    file.goals.push(goal.clone());
    loaded.persist(file)?;
    Ok(goal)
}

/// 改目标标题。
pub fn rename_goal(ctx: &LibCtx, goal_id: &str, title: &str) -> CmdResult<GoalEntry> {
    ctx.require_writable()?;
    let title = title.trim();
    if title.is_empty() {
        return Err(CmdError::invalid("目标标题不能为空"));
    }
    let loaded = load_goals(ctx)?;
    let mut file = loaded.file.clone();
    let goal = file
        .goals
        .iter_mut()
        .find(|goal| goal.id == goal_id)
        .ok_or_else(|| {
            CmdError::not_found(format!("{} 里没有 ID 为 {goal_id} 的目标", loaded.relative))
        })?;
    goal.title = title.to_string();
    let updated = goal.clone();
    loaded.persist(file)?;
    Ok(updated)
}

/// 删一个目标；找不到时返回 `false`（幂等）。
pub fn delete_goal(ctx: &LibCtx, goal_id: &str) -> CmdResult<bool> {
    ctx.require_writable()?;
    let loaded = load_goals(ctx)?;
    if !loaded.file.goals.iter().any(|goal| goal.id == goal_id) {
        return Ok(false);
    }
    let mut file = loaded.file.clone();
    file.goals.retain(|goal| goal.id != goal_id);
    loaded.persist(file)?;
    Ok(true)
}

/// 合并节点时改接目标：把根节点是 `old_root` 的目标改挂到 `new_root`。返回改动条数。
pub fn repoint_goals(ctx: &LibCtx, old_root: &str, new_root: &str) -> CmdResult<i64> {
    ctx.require_writable()?;
    paths::require_uuid(old_root, "oldRoot")?;
    paths::require_uuid(new_root, "newRoot")?;
    if old_root == new_root {
        return Ok(0);
    }
    let loaded = load_goals(ctx)?;
    let affected = loaded
        .file
        .goals
        .iter()
        .filter(|goal| goal.root_node_id == old_root)
        .count() as i64;
    if affected == 0 {
        return Ok(0);
    }
    let mut file = loaded.file.clone();
    for goal in file.goals.iter_mut() {
        if goal.root_node_id == old_root {
            goal.root_node_id = new_root.to_string();
        }
    }
    loaded.persist(file)?;
    Ok(affected)
}
