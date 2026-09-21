/**
 * 对话文件：`chats/<threadId>/{thread.json,messages/<6 位序号>_<id>.json}`
 *
 * 为什么一条消息一个文件（设计 §4.5）：
 * - 流式生成只需要更新当前消息，不会反复重写整段长对话；
 * - 单条消息可以原子替换，崩溃影响面小；
 * - 引用仍可稳定指向 `messageId`；
 * - 加载节点时先只读 `thread.json`，进入具体对话后才加载消息正文。
 *
 * 扫描到 `status: "streaming"` 时**转为 `incomplete`**（保留已生成正文），
 * 由 `recoverIncomplete` 在打开知识库时补写，而不是在扫描中改盘。
 *
 * 安全底线：API Key、鉴权头、完整请求日志绝不写入节点目录——本模块只写
 * 契约 §1.6 列出的字段，任何多余字段都由调用方自己负责。
 */
import { RepositoryError, externalChangeConflict } from "../errors.ts";
import type { ChatMessage, ChatThread, MessageStatus } from "../chatTypes.ts";
import { newUuid } from "../uuid.ts";
import {
  isoFromMs,
  newMessageFile,
  newThreadFile,
  parseIsoMs,
  parseMessageFile,
  parseThreadFile,
  serializeJson,
  type MessageFileRole,
  type MessageFileStatus,
  type V2MessageFile,
  type V2ThreadFile,
} from "./schema.ts";
import { sha256Hex } from "./hash.ts";
import { writeTextAtomic, type Vfs } from "./fs.ts";
import {
  chatsDir,
  joinRel,
  messageFileName,
  messagesDir,
  parseMessageFileName,
  threadDir,
  threadFile,
} from "./paths.ts";

export interface LoadedThread {
  thread: ChatThread;
  messages: ChatMessage[];
}

/* ------------------------------ 状态换算 ------------------------------ */

/** 前端状态 -> 文件状态（`cancelled` 落盘为 `stopped`，`failed` 落盘为 `error`） */
export function messageStatusToFile(status: MessageStatus): MessageFileStatus {
  switch (status) {
    case "cancelled":
      return "stopped";
    case "failed":
      return "error";
    case "streaming":
      return "streaming";
    case "incomplete":
      return "incomplete";
    default:
      return "complete";
  }
}

export function messageStatusFromFile(status: MessageFileStatus): MessageStatus {
  switch (status) {
    case "stopped":
      return "cancelled";
    case "error":
      return "failed";
    case "streaming":
      // 进程重启后不可能还有请求在跑：原样载入会让界面一直转圈且没有重试入口
      return "incomplete";
    default:
      return status;
  }
}

function roleFromFile(role: MessageFileRole): ChatMessage["role"] {
  return role;
}

function usageToFile(usage: string | null | undefined): unknown {
  if (usage === null || usage === undefined || usage === "") return null;
  try {
    return JSON.parse(usage);
  } catch {
    // 不是合法 JSON 的用量原文不要丢：原样存字符串，至少不产生坏文件
    return usage;
  }
}

function usageFromFile(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/* -------------------------------- 线程头 -------------------------------- */

function threadToDomain(file: V2ThreadFile, messageCount: number, nodeRel: string): ChatThread {
  return {
    id: file.id,
    nodeId: file.nodeId,
    title: file.title,
    summary: file.summary,
    createdAt: parseIsoMs(file.createdAt),
    updatedAt: parseIsoMs(file.updatedAt),
    messageCount,
    nodeRelativePath: nodeRel,
    // 修订号必须带回领域对象：保存时要拿它做乐观并发守卫，
    // 丢掉它就只能拿 0 去比，而磁盘上永远是 1 —— 那样每次保存都会「冲突」
    revision: file.revision,
  };
}

export function threadToFile(thread: ChatThread, revision = 1): V2ThreadFile {
  return {
    format: "knowledgenet-chat-thread",
    formatVersion: 1,
    id: thread.id,
    nodeId: thread.nodeId,
    revision,
    title: thread.title,
    summary: thread.summary,
    createdAt: isoFromMs(thread.createdAt),
    updatedAt: isoFromMs(thread.updatedAt),
  };
}

/** 数消息文件（只读文件名） */
export async function countMessages(
  vfs: Vfs,
  nodeRel: string,
  threadId: string,
): Promise<number> {
  try {
    const entries = await vfs.list(messagesDir(nodeRel, threadId));
    return entries.filter(
      (entry) => entry.kind === "file" && parseMessageFileName(entry.name) !== null,
    ).length;
  } catch {
    return 0;
  }
}

/** 列出一个节点的线程头（只读 `thread.json`，不读消息正文） */
export async function listThreads(
  vfs: Vfs,
  nodeRel: string,
  _nodeId?: string,
): Promise<ChatThread[]> {
  let entries;
  try {
    entries = await vfs.list(chatsDir(nodeRel));
  } catch {
    return [];
  }
  const out: ChatThread[] = [];
  for (const entry of entries) {
    if (entry.kind !== "dir") continue;
    const fileRel = threadFile(nodeRel, entry.name);
    let text: string;
    try {
      text = await vfs.read(fileRel);
    } catch {
      continue;
    }
    try {
      const file = parseThreadFile(text, fileRel);
      out.push(threadToDomain(file, await countMessages(vfs, nodeRel, entry.name), nodeRel));
    } catch {
      // 坏掉的 thread.json 由扫描器报告为问题；这里只是跳过，不让整列失败
      continue;
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createThread(
  vfs: Vfs,
  nodeRel: string,
  nodeId: string,
  title = "新对话",
  threadId?: string,
): Promise<ChatThread> {
  const now = Date.now();
  const id = threadId ?? newUuid(now);
  const file = newThreadFile({ id, nodeId, title: title.trim() || "新对话", now: isoFromMs(now) });
  await writeTextAtomic(vfs, threadFile(nodeRel, id), serializeJson(file));
  return threadToDomain(file, 0, nodeRel);
}

/**
 * 写线程头。
 *
 * `expectedRevision` 不为 null 时做修订守卫：外部改过就报
 * `external_change_conflict`，界面让用户决定怎么办。
 */
export async function saveThread(
  vfs: Vfs,
  nodeRel: string,
  thread: ChatThread,
  expectedRevision: number | null = null,
): Promise<ChatThread> {
  const rel = threadFile(nodeRel, thread.id);
  let existing: V2ThreadFile | null = null;
  let existingText = "";
  try {
    existingText = await vfs.read(rel);
    existing = parseThreadFile(existingText, rel);
  } catch {
    existing = null;
  }
  if (existing && expectedRevision !== null && existing.revision !== expectedRevision) {
    throw externalChangeConflict({
      relativePath: rel,
      expectedRevision,
      actualRevision: existing.revision,
      expectedHash: null,
      actualHash: sha256Hex(existingText),
      message: "磁盘上的 thread.json 已被外部修改，已拒绝覆盖",
    });
  }
  const revision = existing ? existing.revision + 1 : 1;
  const file: V2ThreadFile = { ...threadToFile(thread, revision), nodeId: thread.nodeId };
  const messageCount = existing ? await countMessages(vfs, nodeRel, thread.id) : 0;
  await writeTextAtomic(vfs, rel, serializeJson(file));
  return threadToDomain(file, messageCount, nodeRel);
}

export async function deleteThread(vfs: Vfs, nodeRel: string, threadId: string): Promise<void> {
  const dir = threadDir(nodeRel, threadId);
  if (!(await vfs.exists(dir))) {
    throw new RepositoryError("not_found", `对话不存在：${threadId}`);
  }
  await vfs.remove(dir);
}

/** 读线程头（不存在时返回 null） */
export async function readThreadFile(
  vfs: Vfs,
  nodeRel: string,
  threadId: string,
): Promise<V2ThreadFile | null> {
  const rel = threadFile(nodeRel, threadId);
  try {
    return parseThreadFile(await vfs.read(rel), rel);
  } catch {
    return null;
  }
}

/* --------------------------------- 消息 --------------------------------- */

export function messageToFile(message: ChatMessage, sequence: number): V2MessageFile {
  return newMessageFile({
    id: message.id,
    threadId: message.threadId,
    sequence,
    role: message.role as MessageFileRole,
    content: message.content,
    status: messageStatusToFile(message.status),
    now: isoFromMs(message.createdAt || Date.now()),
    finishReason: message.finishReason ?? null,
    requestId: message.requestId ?? null,
    usage: usageToFile(message.usage),
    model: message.model ?? null,
  });
}

export function messageFromFile(file: V2MessageFile): ChatMessage {
  const created = parseIsoMs(file.createdAt);
  const updated = parseIsoMs(file.updatedAt);
  return {
    id: file.id,
    threadId: file.threadId,
    role: roleFromFile(file.role),
    content: file.content,
    status: messageStatusFromFile(file.status),
    finishReason: file.finishReason,
    requestId: file.requestId,
    usage: usageFromFile(file.usage),
    model: file.model,
    createdAt: created,
    updatedAt: updated,
  };
}

/** 列出消息目录里的文件项（按序号排序） */
async function messageEntries(
  vfs: Vfs,
  nodeRel: string,
  threadId: string,
): Promise<Array<{ name: string; sequence: number; messageId: string }>> {
  let entries;
  try {
    entries = await vfs.list(messagesDir(nodeRel, threadId));
  } catch {
    return [];
  }
  const out: Array<{ name: string; sequence: number; messageId: string }> = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const parsed = parseMessageFileName(entry.name);
    if (!parsed) continue;
    out.push({ name: entry.name, sequence: parsed.sequence, messageId: parsed.messageId });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

/** 下一个可用序号（同目录里已有消息的最大序号 + 1） */
export async function nextSequence(
  vfs: Vfs,
  nodeRel: string,
  threadId: string,
): Promise<number> {
  const entries = await messageEntries(vfs, nodeRel, threadId);
  const max = entries.reduce((acc, entry) => Math.max(acc, entry.sequence), 0);
  return max + 1;
}

/** 懒加载一个线程的全部消息（按序号排序；正文只在这里读） */
export async function loadThread(
  vfs: Vfs,
  nodeRel: string,
  threadId: string,
): Promise<LoadedThread> {
  const file = await readThreadFile(vfs, nodeRel, threadId);
  if (!file) {
    throw new RepositoryError("not_found", `对话不存在：${threadId}`);
  }
  const entries = await messageEntries(vfs, nodeRel, threadId);
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    const rel = joinRel(messagesDir(nodeRel, threadId), entry.name);
    try {
      messages.push(messageFromFile(parseMessageFile(await vfs.read(rel), rel)));
    } catch {
      // 单条消息坏了：跳过它，但整段对话仍然可读（问题由完整性检查列出）
      continue;
    }
  }
  return { thread: threadToDomain(file, messages.length, nodeRel), messages };
}

/**
 * 保存一条消息（原子替换）。
 *
 * 已有同名 `messageId` 的文件会被就地更新并保留原序号：流式检查点因此
 * 不会在消息目录里留下越来越多文件。
 */
export async function saveMessage(
  vfs: Vfs,
  nodeRel: string,
  threadId: string,
  message: ChatMessage,
): Promise<ChatMessage> {
  const entries = await messageEntries(vfs, nodeRel, threadId);
  const existing = entries.find((entry) => entry.messageId === message.id);
  const sequence = existing?.sequence ?? (await nextSequence(vfs, nodeRel, threadId));
  const file = messageToFile(message, sequence);
  const dir = messagesDir(nodeRel, threadId);
  await writeTextAtomic(vfs, joinRel(dir, messageFileName(sequence, message.id)), serializeJson(file));
  if (existing && existing.name !== messageFileName(sequence, message.id)) {
    // 序号变了（例如导入的旧文件）：清掉旧名字，避免同一条消息出现两份
    await vfs.remove(joinRel(dir, existing.name));
  }
  return messageFromFile(file);
}

export async function deleteMessage(
  vfs: Vfs,
  nodeRel: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  const entries = await messageEntries(vfs, nodeRel, threadId);
  const existing = entries.find((entry) => entry.messageId === messageId);
  if (!existing) {
    throw new RepositoryError("not_found", `消息不存在：${messageId}`);
  }
  await vfs.remove(joinRel(messagesDir(nodeRel, threadId), existing.name));
}

/**
 * 把停在 `streaming` 的消息改写成 `incomplete`（打开知识库时调用）。
 *
 * 生成中途崩溃、关窗或断电会留下 `streaming`；保留已生成正文，
 * 但状态必须收敛，否则界面上会永远显示一个转圈的输入光标。
 */
export async function recoverIncomplete(vfs: Vfs, nodeRel: string): Promise<number> {
  let recovered = 0;
  let threadDirs;
  try {
    threadDirs = await vfs.list(chatsDir(nodeRel));
  } catch {
    return 0;
  }
  for (const dir of threadDirs) {
    if (dir.kind !== "dir") continue;
    const entries = await messageEntries(vfs, nodeRel, dir.name);
    for (const entry of entries) {
      const rel = joinRel(messagesDir(nodeRel, dir.name), entry.name);
      let file: V2MessageFile;
      try {
        file = parseMessageFile(await vfs.read(rel), rel);
      } catch {
        continue;
      }
      if (file.status !== "streaming") continue;
      file.status = "incomplete";
      file.updatedAt = isoFromMs(Date.now());
      await writeTextAtomic(vfs, rel, serializeJson(file));
      recovered += 1;
    }
  }
  return recovered;
}
