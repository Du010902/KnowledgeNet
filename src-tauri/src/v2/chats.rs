//! 线程 / 消息文件、懒加载与流式检查点（契约 `docs/v2-contract.md` §3.11）。
//!
//! 对话是**节点资产**，完全住在节点目录里：
//!
//! ```text
//! <节点目录>/.meta/knowledgenet/chats/<threadId>/
//! ├── thread.json
//! └── messages/<6 位零填充 sequence>_<messageId>.json
//! ```
//!
//! 四条纪律：
//!
//! 1. **懒加载**：`list_threads` 只读 `thread.json`，消息条数靠**数文件名**
//!    （[`vpaths::parse_message_file_name`]），绝不读正文。设计文档 §4.5 要求
//!    「加载节点时先只读 thread.json；进入具体对话后再加载消息」，一万个节点打开时
//!    不能把十万条消息正文读进内存。
//! 2. **一条坏消息不能毁掉整段对话**：`load_thread` 逐条独立解析，坏的跳过并计数
//!    （[`LoadedThread::skipped`]），好的照常返回。
//! 3. **流式只改一个文件**：每条消息一个文件 + 原子替换，检查点重写同一条消息时
//!    磁盘上始终只有一个文件（见 [`checkpoint_message`]）。
//! 4. **凭据绝不进节点目录**：写盘前显式检查 `requestId` / `model` / `usage` 等字段，
//!    发现 `sk-`、`Bearer`、`authorization` 这类标记一律拒绝（[`sanitize_message`]）。

use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{code, CmdError, CmdResult};
use crate::paths;

use super::atomic::{self, Fingerprint};
use super::ctx::LibCtx;
use super::scanner::ScannedThread;
use super::schema::{
    self, MessageFile, ThreadFile, Validate, MESSAGE_FORMAT, MESSAGE_FORMAT_VERSION, THREAD_FORMAT,
    THREAD_FORMAT_VERSION,
};
use super::vpaths;

/* --------------------------------- 返回类型 --------------------------------- */

/// 一个线程的全部内容。`fingerprint` 是 `thread.json` 的指纹，
/// 命令层把它交给前端做 `save_thread` 的乐观并发守卫。
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedThread {
    pub thread: ThreadFile,
    pub messages: Vec<MessageFile>,
    pub fingerprint: Fingerprint,
    /// 解析失败（JSON 坏了 / 字段非法 / 版本不认识）而被跳过的消息文件数。
    /// 界面据此显示「有 N 条消息读不出来」，而不是假装对话完整。
    pub skipped: usize,
}

/// `list_threads` 的返回项就是契约 §3.4 的 [`ScannedThread`]：
/// 只含线程头 + 消息**条数**，不含任何消息正文。复用同一个类型，
/// 扫描索引与命令层就不必为「同一个线程摘要」维护两份结构。

/* ------------------------------- 内部文件清单 ------------------------------- */

/// 一条消息在磁盘上的位置，序号只来自文件名（不读正文）。
#[derive(Debug, Clone)]
struct MessageSlot {
    sequence: i64,
    id: String,
    path: PathBuf,
}

fn io_err(action: &str, path: &Path, err: std::io::Error) -> CmdError {
    CmdError::io(format!("{action} {} 失败：{err}", path.display()))
}

/// 列出 `messages/` 里所有合法命名的消息文件，按 (sequence, id) 排序。
///
/// 目录不存在 = 还没有消息，**不是**错误。
fn message_slots(messages_dir: &Path) -> CmdResult<Vec<MessageSlot>> {
    let mut slots: Vec<MessageSlot> = Vec::new();
    let entries = match fs::read_dir(messages_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(slots),
        Err(err) => return Err(io_err("读取目录", messages_dir, err)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| io_err("读取目录项", messages_dir, e))?;
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some((sequence, id)) = vpaths::parse_message_file_name(&name) {
            slots.push(MessageSlot {
                sequence,
                id,
                path: entry.path(),
            });
        }
    }
    slots.sort_by(|a, b| {
        a.sequence
            .cmp(&b.sequence)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(slots)
}

/// 节点 `chats/` 下的线程目录名（不解析内容，只列目录）。
fn thread_dir_names(chats_dir: &Path) -> CmdResult<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    let entries = match fs::read_dir(chats_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(err) => return Err(io_err("读取目录", chats_dir, err)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| io_err("读取目录项", chats_dir, e))?;
        let path = entry.path();
        if paths::is_link_like(&path) {
            continue;
        }
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => {}
            _ => continue,
        }
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    names.sort();
    Ok(names)
}

/// 错误详情里给人看的相对路径（`<nodeRel>/.meta/knowledgenet/...`）。
fn relative_hint(node_rel: &str, tail: &str) -> String {
    if node_rel.is_empty() {
        tail.to_string()
    } else {
        format!("{node_rel}/{tail}")
    }
}

fn thread_relative(node_rel: &str, thread_id: &str) -> String {
    relative_hint(
        node_rel,
        &format!("{}/{}/{}", vpaths::CHATS_DIR, thread_id, vpaths::THREAD_FILE),
    )
}

fn message_relative(node_rel: &str, thread_id: &str, file_name: &str) -> String {
    relative_hint(
        node_rel,
        &format!(
            "{}/{}/{}/{}",
            vpaths::CHATS_DIR,
            thread_id,
            vpaths::MESSAGES_DIR,
            file_name
        ),
    )
}

/* --------------------------------- 线程头 --------------------------------- */

/// 列出节点下的线程头（**只读 `thread.json`，绝不读消息正文**）。
///
/// - 消息条数来自 `messages/` 里的文件名，因此坏消息、超大消息都不影响本调用。
/// - 没有 `thread.json` 的目录不算线程（被跳过）；`thread.json` 坏掉的线程被跳过，
///   一条坏线程不能连累同一节点的其它线程。
pub fn list_threads(ctx: &LibCtx, node_rel: &str) -> CmdResult<Vec<ScannedThread>> {
    let node_dir = ctx.node_dir(node_rel)?;
    let chats_dir = vpaths::chats_dir(&node_dir);
    let mut out: Vec<ScannedThread> = Vec::new();

    for thread_id in thread_dir_names(&chats_dir)? {
        let path = vpaths::thread_file(&node_dir, &thread_id);
        let rel = thread_relative(node_rel, &thread_id);
        // 只读线程头，**不算哈希**：开库时会对每个节点调用本函数，
        // 指纹在这里没用（要指纹的是 load_thread / save_thread）。
        let thread = if path.is_file() {
            atomic::read_text(&path).ok().and_then(|text| {
                schema::parse_typed::<ThreadFile>(
                    &text,
                    THREAD_FORMAT,
                    THREAD_FORMAT_VERSION,
                    "thread.json",
                    Some(&rel),
                )
                .ok()
            })
        } else {
            None
        };
        // 没有 thread.json 的目录不是线程；坏 thread.json 的线程跳过，
        // 一条坏线程不连累同一节点的其它线程。
        let Some(thread) = thread else {
            continue;
        };
        let message_count = message_slots(&vpaths::messages_dir(&node_dir, &thread_id))?.len() as i64;
        out.push(ScannedThread {
            id: thread.id,
            node_id: thread.node_id,
            title: thread.title,
            summary: thread.summary,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            revision: thread.revision,
            message_count,
            node_relative_path: node_rel.to_string(),
        });
    }

    out.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

/// 新建线程：`chats/<threadId>/{messages/,thread.json}`。
///
/// 标题为空时用 v1 的默认值「新对话」——`thread.json` 的校验要求标题非空，
/// 空标题会让这个线程以后再也读不出来。
pub fn create_thread(
    ctx: &LibCtx,
    node_rel: &str,
    node_id: &str,
    title: &str,
) -> CmdResult<ThreadFile> {
    ctx.require_writable()?;
    paths::require_uuid(node_id, "nodeId")?;
    let node_dir = ctx.node_dir(node_rel)?;
    let title = match title.trim() {
        "" => "新对话",
        value => value,
    };
    let thread = ThreadFile::new(node_id.to_string(), title.to_string(), paths::iso_now());
    vpaths::require_thread_id(&thread.id)?;

    let dir = vpaths::thread_dir(&node_dir, &thread.id);
    if dir.exists() {
        return Err(CmdError::new(
            code::CONFLICT,
            format!("线程目录已存在，已拒绝覆盖：{}", dir.display()),
        ));
    }
    // 先建 messages/ 再写 thread.json：thread.json 存在就代表线程完整可读
    atomic::ensure_dir(&vpaths::messages_dir(&node_dir, &thread.id))?;
    atomic::write_json(&vpaths::thread_file(&node_dir, &thread.id), &thread)?;
    Ok(thread)
}

/// 读一个线程：线程头 + 全部消息（按 `sequence` 排序）。
///
/// 单条消息解析失败只跳过并计入 [`LoadedThread::skipped`]——磁盘是开放的，
/// 用户可能正在用编辑器改某一条消息，那不该让整段对话打不开。
pub fn load_thread(ctx: &LibCtx, node_rel: &str, thread_id: &str) -> CmdResult<LoadedThread> {
    vpaths::require_thread_id(thread_id)?;
    let node_dir = ctx.node_dir(node_rel)?;
    let path = vpaths::thread_file(&node_dir, thread_id);
    let rel = thread_relative(node_rel, thread_id);
    if !path.is_file() {
        return Err(CmdError::not_found(format!(
            "线程不存在：{thread_id}（{rel}）"
        )));
    }
    let (thread, fingerprint) = atomic::read_typed::<ThreadFile>(
        &path,
        THREAD_FORMAT,
        THREAD_FORMAT_VERSION,
        "thread.json",
        Some(&rel),
    )?;

    let mut messages: Vec<MessageFile> = Vec::new();
    let mut skipped: usize = 0;
    for slot in message_slots(&vpaths::messages_dir(&node_dir, thread_id))? {
        let rel = message_relative(
            node_rel,
            thread_id,
            &slot
                .path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        );
        let text = match atomic::read_text(&slot.path) {
            Ok(text) => text,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        match schema::parse_typed::<MessageFile>(
            &text,
            MESSAGE_FORMAT,
            MESSAGE_FORMAT_VERSION,
            "消息文件",
            Some(&rel),
        ) {
            Ok(message) => messages.push(message),
            Err(_) => skipped += 1,
        }
    }
    messages.sort_by(|a, b| {
        a.sequence
            .cmp(&b.sequence)
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(LoadedThread {
        thread,
        messages,
        fingerprint,
        skipped,
    })
}

/// 保存线程头：`expected_revision` 守卫 + 修订号自增。
///
/// 磁盘上的 `thread.json` 被外部改过（修订号不一致）时返回
/// `external_change_conflict`，**绝不覆盖**。
pub fn save_thread(
    ctx: &LibCtx,
    node_rel: &str,
    thread: &ThreadFile,
    expected_revision: i64,
) -> CmdResult<ThreadFile> {
    ctx.require_writable()?;
    vpaths::require_thread_id(&thread.id)?;
    let node_dir = ctx.node_dir(node_rel)?;
    let path = vpaths::thread_file(&node_dir, &thread.id);
    let rel = thread_relative(node_rel, &thread.id);

    let mut out = thread.clone();
    match atomic::read_typed_opt::<ThreadFile>(
        &path,
        THREAD_FORMAT,
        THREAD_FORMAT_VERSION,
        "thread.json",
        Some(&rel),
    )? {
        Some((current, fp)) => {
            atomic::ensure_unchanged(&rel, current.revision, expected_revision, &fp.sha256, None)?;
            out.revision = current.revision + 1;
        }
        None => {
            // 新建：调用方手上应该是「不存在」（expectedRevision 0 或 1）
            if expected_revision > 1 {
                return Err(CmdError::not_found(format!(
                    "{rel} 不存在，但调用方认为它已经是修订号 {expected_revision}"
                )));
            }
            out.revision = if out.revision > 0 { out.revision } else { 1 };
        }
    }
    out.updated_at = paths::iso_now();
    out.validate_typed()?;
    atomic::write_json(&path, &out)?;
    Ok(out)
}

/// 删除线程目录（含全部消息文件）。线程已不存在时是空操作。
pub fn delete_thread(ctx: &LibCtx, node_rel: &str, thread_id: &str) -> CmdResult<()> {
    ctx.require_writable()?;
    vpaths::require_thread_id(thread_id)?;
    let node_dir = ctx.node_dir(node_rel)?;
    let dir = vpaths::thread_dir(&node_dir, thread_id);
    atomic::remove_dir_all_if_exists(&dir)?;
    Ok(())
}

/* --------------------------------- 消息 --------------------------------- */

/// 下一条可用序号：磁盘上最大序号 + 1（空对话是 1）。
pub fn next_sequence(ctx: &LibCtx, node_rel: &str, thread_id: &str) -> CmdResult<i64> {
    vpaths::require_thread_id(thread_id)?;
    let node_dir = ctx.node_dir(node_rel)?;
    let slots = message_slots(&vpaths::messages_dir(&node_dir, thread_id))?;
    Ok(slots.iter().map(|s| s.sequence).max().unwrap_or(0) + 1)
}

/// 保存一条消息（沿用 v1 的 `save_message` 语义，但落盘是**一个消息一个文件**）。
///
/// 序号分配规则：
/// - 调用方没给序号（`sequence < 1`）→ 这条消息此前写过就沿用**它自己的**序号，
///   否则顺延 `max + 1`；
/// - 目标序号已经被**别的**消息占用 → 重新分配 `max + 1`，绝不覆盖别人的消息；
/// - 同一条消息此前写在另一个序号文件里（调用方改正了 `sequence`）→ 写新文件并删掉旧文件，
///   保证磁盘上一条消息只有一个文件。
///
/// `createdAt` / `updatedAt` 原样采纳调用方给的值：流式检查点由命令层负责把
/// `updatedAt` 刷成当前时间，迁移则要保留 v1 的原始时间。
pub fn save_message(
    ctx: &LibCtx,
    node_rel: &str,
    thread_id: &str,
    message: &MessageFile,
) -> CmdResult<MessageFile> {
    ctx.require_writable()?;
    vpaths::require_thread_id(thread_id)?;
    vpaths::require_message_id(&message.id)?;
    if message.thread_id != thread_id {
        return Err(CmdError::invalid(format!(
            "消息的 threadId（{}）与目标线程（{thread_id}）不一致，已拒绝写入",
            message.thread_id
        )));
    }
    // 凭据检查必须在任何写盘之前
    sanitize_message(message)?;

    let node_dir = ctx.node_dir(node_rel)?;
    if !vpaths::thread_file(&node_dir, thread_id).is_file() {
        return Err(CmdError::not_found(format!(
            "线程不存在：{thread_id}（{}）",
            thread_relative(node_rel, thread_id)
        )));
    }

    let messages_dir = vpaths::messages_dir(&node_dir, thread_id);
    let mut out = message.clone();
    // 快路径：流式检查点每次都写同一条消息，此时 `<序号>_<id>.json` 就是它自己的文件，
    // 直接原子替换即可，不必为了数序号而遍历整个消息目录（长对话里这是每秒一次的开销）。
    let mut target = messages_dir.join(vpaths::message_file_name(out.sequence, &out.id));
    let mut stale: Option<PathBuf> = None;
    if !target.is_file() {
        // 首次写这条消息、或调用方改了序号：这时才扫目录，处理撞号与旧序号文件
        let slots = message_slots(&messages_dir)?;
        let max_sequence = slots.iter().map(|s| s.sequence).max().unwrap_or(0);
        if out.sequence < 1 {
            // 调用方没给序号（前端的 `ChatMessage` 里根本没有这个字段）。
            // 这条消息此前写过就**沿用它自己的序号**：流式检查点每次都写同一条消息，
            // 沿用序号才能命中上面的快路径（原子替换同一个文件）。
            // 若改成一律顺延到末尾，每次检查点都会换一个新文件名并删掉旧的——
            // 长对话里那是每秒一次的多余扫描与改名。
            match slots.iter().find(|slot| slot.id == out.id) {
                Some(slot) => out.sequence = slot.sequence,
                None => out.sequence = max_sequence + 1,
            }
        } else if slots
            .iter()
            .any(|slot| slot.sequence == out.sequence && slot.id != out.id)
        {
            // 序号已被别人的消息占用：顺延，绝不覆盖别人的消息
            out.sequence = max_sequence + 1;
        }
        stale = slots.iter().find(|slot| slot.id == out.id).map(|s| s.path.clone());
        target = messages_dir.join(vpaths::message_file_name(out.sequence, &out.id));
    }
    if out.created_at.trim().is_empty() {
        out.created_at = paths::iso_now();
    }
    if out.updated_at.trim().is_empty() {
        out.updated_at = out.created_at.clone();
    }
    out.validate_typed()?;

    let file_name = vpaths::message_file_name(out.sequence, &out.id);
    let rel = message_relative(node_rel, thread_id, &file_name);
    atomic::write_json(&target, &out).map_err(|err| {
        CmdError::new(&err.code, err.message.clone()).with_detail(serde_json::json!({
            "relativePath": rel,
        }))
    })?;

    if let Some(old) = stale {
        if old != target {
            paths::remove_file_if_exists(&old)?;
        }
    }
    Ok(out)
}

/// **流式检查点**：语义与 [`save_message`] **完全相同**（就是同一份实现，
/// 因此不存在「检查点路径和最终写盘路径行为不一致」的可能）。
///
/// 调用节奏由命令层控制，设计文档 §4.5 的要求是：
///
/// - 内存里实时显示 token；
/// - **最多每 750～1000ms** 调一次本函数做原子检查点；
/// - 收到结束（`finish`）、用户停止、错误事件时**立即**做最终写盘；
/// - 重启后发现 `status: "streaming"` 的消息由 [`recover_incomplete`] 转成 `incomplete`。
pub fn checkpoint_message(
    ctx: &LibCtx,
    node_rel: &str,
    thread_id: &str,
    message: &MessageFile,
) -> CmdResult<MessageFile> {
    save_message(ctx, node_rel, thread_id, message)
}

/// 删除消息文件。消息已不存在时是空操作（幂等）。
pub fn delete_message(
    ctx: &LibCtx,
    node_rel: &str,
    thread_id: &str,
    message_id: &str,
) -> CmdResult<()> {
    ctx.require_writable()?;
    vpaths::require_thread_id(thread_id)?;
    vpaths::require_message_id(message_id)?;
    let node_dir = ctx.node_dir(node_rel)?;
    for slot in message_slots(&vpaths::messages_dir(&node_dir, thread_id))?
        .into_iter()
        .filter(|slot| slot.id == message_id)
    {
        paths::remove_file_if_exists(&slot.path)?;
    }
    Ok(())
}

/* ------------------------------- 崩溃恢复 ------------------------------- */

/// 把节点下所有 `status: "streaming"` 的消息改成 `incomplete`，返回改动条数。
///
/// 「杀进程模拟」场景：生成到一半的 assistant 消息最后一次检查点还写着 `streaming`，
/// 重启后它既不能继续流（请求已经没了），也不能当完整回答显示。
/// 这里**保留已生成正文**，只把状态改成 `incomplete`，并把这条消息的 `updatedAt`
/// 留在最后一次检查点的时间（那是内容真实产生的时间）。
///
/// 只读会话返回 `0`（不报错）：打开只读知识库不应该因为无法回收状态而失败。
/// 坏 JSON 的消息文件被跳过，不影响其它消息。
pub fn recover_incomplete(ctx: &LibCtx, node_rel: &str) -> CmdResult<i64> {
    if ctx.read_only() {
        return Ok(0);
    }
    let node_dir = ctx.node_dir(node_rel)?;
    let chats_dir = vpaths::chats_dir(&node_dir);
    let mut changed: i64 = 0;

    for thread_id in thread_dir_names(&chats_dir)? {
        for slot in message_slots(&vpaths::messages_dir(&node_dir, &thread_id))? {
            let text = match atomic::read_text(&slot.path) {
                Ok(text) => text,
                Err(_) => continue,
            };
            // 快速路径：绝大多数消息不是 streaming，连 JSON 都不用解析
            if !text.contains("\"streaming\"") {
                continue;
            }
            let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            let Some(object) = value.as_object_mut() else {
                continue;
            };
            let streaming = object
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s == "streaming")
                .unwrap_or(false);
            if !streaming {
                continue;
            }
            object.insert(
                "status".to_string(),
                serde_json::Value::String("incomplete".to_string()),
            );
            // 直接改 Value 再写回：正文与未知字段一个都不丢
            atomic::write_json(&slot.path, &value)?;
            changed += 1;
        }
    }
    Ok(changed)
}

/* ----------------------------- 按 threadId 重定位 ----------------------------- */

/// 只知道 `threadId` 时，在知识库内做**受限重定位**：遍历
/// `**/.meta/knowledgenet/chats/<threadId>/thread.json`，返回它所属节点目录的
/// 相对路径（根目录本身是节点时返回空字符串）。
///
/// 只跟随真实目录（不跟随符号链接 / junction），跳过 `.git`、`node_modules`、
/// `.knowledgenet`，并在嵌套知识库（子目录里还有 `library.json`）处停止下探。
pub fn find_node_of_thread(root: &Path, thread_id: &str) -> CmdResult<Option<String>> {
    vpaths::require_thread_id(thread_id)?;
    let root = fs::canonicalize(root)
        .map_err(|e| CmdError::io(format!("无法解析知识库根目录 {}：{e}", root.display())))?;
    let root = paths::strip_verbatim(&root);
    let mut found: Option<String> = None;
    search_thread(&root, &root, thread_id, &mut found, 0)?;
    Ok(found)
}

fn search_thread(
    root: &Path,
    dir: &Path,
    thread_id: &str,
    found: &mut Option<String>,
    depth: usize,
) -> CmdResult<()> {
    if found.is_some() || depth > 64 {
        return Ok(());
    }
    let marker = dir
        .join(vpaths::META_DIR)
        .join(vpaths::NS_DIR)
        .join(vpaths::CHATS_DIR)
        .join(thread_id)
        .join(vpaths::THREAD_FILE);
    if marker.is_file() {
        let rel = vpaths::relative_path_string(root, dir).unwrap_or_default();
        if let Ok((thread, _)) = atomic::read_typed::<ThreadFile>(
            &marker,
            THREAD_FORMAT,
            THREAD_FORMAT_VERSION,
            "thread.json",
            Some(&rel),
        ) {
            if thread.id == thread_id {
                *found = Some(rel);
                return Ok(());
            }
        }
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
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
        // 嵌套的另一个知识库：不下探
        if path.join(crate::paths::MANIFEST_NAME).is_file() {
            continue;
        }
        search_thread(root, &path, thread_id, found, depth + 1)?;
    }
    Ok(())
}

/* ------------------------------- 凭据卫生 ------------------------------- */

/// 绝不允许出现在节点目录里的标记（大小写不敏感）。
///
/// 只覆盖「凭据形状」而不是所有可能的字符串：`content`（用户与模型的正文）
/// **不参与检查**，否则用户把一段包含 `sk-` 的讨论粘进对话就会被拒绝保存。
pub const SECRET_MARKERS: &[&str] = &[
    "sk-",
    "bearer ",
    "authorization",
    "api_key",
    "apikey",
    "x-api-key",
    "secret_key",
    "client_secret",
];

/// 在文本里找一个凭据标记（返回命中的那个，便于错误信息说清楚原因）。
pub fn find_secret_marker(text: &str) -> Option<&'static str> {
    let lowered = text.to_lowercase();
    SECRET_MARKERS
        .iter()
        .copied()
        .find(|marker| lowered.contains(marker))
}

/// 会被检查的字段（不含正文）：请求 ID、模型名、结束原因、用量 JSON、扩展字段。
fn sensitive_fields(message: &MessageFile) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = Vec::new();
    if let Some(value) = &message.request_id {
        fields.push(("requestId".to_string(), value.clone()));
    }
    if let Some(value) = &message.model {
        fields.push(("model".to_string(), value.clone()));
    }
    if let Some(value) = &message.finish_reason {
        fields.push(("finishReason".to_string(), value.clone()));
    }
    if let Some(value) = &message.usage {
        fields.push(("usage".to_string(), value.to_string()));
    }
    for (key, value) in &message.extra {
        fields.push((format!("extra.{key}"), value.to_string()));
    }
    fields
}

/// 写盘前的显式检查：发现疑似凭据就**拒绝写入**并说明是哪个字段。
pub fn sanitize_message(message: &MessageFile) -> CmdResult<()> {
    for (field, text) in sensitive_fields(message) {
        if let Some(marker) = find_secret_marker(&text) {
            return Err(CmdError::invalid(format!(
                "拒绝把疑似凭据写入节点目录：{field} 里出现了「{marker}」。\
                 API Key、鉴权头和完整请求日志绝不进入知识库"
            ))
            .with_detail(serde_json::json!({
                "field": field,
                "marker": marker,
                "messageId": message.id,
                "threadId": message.thread_id,
            })));
        }
    }
    Ok(())
}

/// 迁移用的宽松版本：剥离有问题的字段并返回解释，而不是让整次迁移失败
/// （v1 的 `request_id` 列里出现 `sk-` 这种历史脏数据不该阻塞用户升级）。
pub fn sanitize_message_lossy(message: &mut MessageFile) -> Vec<String> {
    let offending: Vec<(String, &'static str)> = sensitive_fields(message)
        .into_iter()
        .filter_map(|(field, text)| find_secret_marker(&text).map(|marker| (field, marker)))
        .collect();
    let mut notes: Vec<String> = Vec::new();
    for (field, marker) in offending {
        match field.as_str() {
            "requestId" => message.request_id = None,
            "model" => message.model = None,
            "finishReason" => message.finish_reason = None,
            "usage" => message.usage = None,
            other => {
                if let Some(key) = other.strip_prefix("extra.") {
                    message.extra.remove(key);
                }
            }
        }
        notes.push(format!(
            "消息 {} 的 {field} 含疑似凭据「{marker}」，已剥离后写入",
            message.id
        ));
    }
    notes
}

/* ---------------------------------- 测试 ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn message(request_id: Option<&str>, model: Option<&str>) -> MessageFile {
        let mut message = MessageFile::new(
            "0199ffff-0000-7000-8000-0000000000aa".to_string(),
            1,
            "assistant",
            "正文".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        );
        message.request_id = request_id.map(|v| v.to_string());
        message.model = model.map(|v| v.to_string());
        message
    }

    #[test]
    fn 带密钥形状的请求_id_会被拒绝() {
        let bad = message(Some("sk-abcdef0123456789"), Some("deepseek-chat"));
        let err = sanitize_message(&bad).expect_err("必须拒绝");
        assert_eq!(err.code, code::INVALID_INPUT);
        assert_eq!(err.detail.unwrap()["field"], "requestId");
    }

    #[test]
    fn 鉴权头形状的用量_json_会被拒绝() {
        let mut bad = message(Some("req-1"), Some("deepseek-chat"));
        bad.usage = Some(serde_json::json!({ "headers": { "Authorization": "Bearer xyz" } }));
        assert!(sanitize_message(&bad).is_err());
    }

    #[test]
    fn 正常消息通过检查且正文里的密钥字样不拦() {
        let mut ok = message(Some("req-1"), Some("deepseek-chat"));
        ok.content = "用户粘贴了一段 sk-abcdef 的讨论".to_string();
        ok.usage = Some(serde_json::json!({ "prompt_tokens": 10, "completion_tokens": 3 }));
        assert!(sanitize_message(&ok).is_ok());
    }

    #[test]
    fn 宽松版剥离字段而不是整体失败() {
        let mut bad = message(Some("sk-live-123"), Some("deepseek-chat"));
        bad.extra.insert(
            "note".to_string(),
            serde_json::Value::String("api_key=abc".to_string()),
        );
        let notes = sanitize_message_lossy(&mut bad);
        assert_eq!(notes.len(), 2);
        assert!(bad.request_id.is_none());
        assert!(!bad.extra.contains_key("note"));
        assert_eq!(bad.model.as_deref(), Some("deepseek-chat"));
        assert!(sanitize_message(&bad).is_ok(), "剥离后必须能通过严格检查");
    }

    #[test]
    fn 线程相对路径提示() {
        assert_eq!(
            thread_relative("Nodes/A", "tid"),
            "Nodes/A/chats/tid/thread.json"
        );
        assert_eq!(message_relative("", "tid", "000001_x.json"), "chats/tid/messages/000001_x.json");
    }
}
