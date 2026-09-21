/**
 * 图数据交换格式（导出 / 导入）
 *
 * **这不是完整备份。** 一份完整副本必须同时包含 `knowledge.sqlite`、全部
 * `nodes/<id>/note.md`、附件、回收站与 `.knowledgenet`（锁、操作日志、恢复点），
 * 也就是「直接复制整个知识库文件夹」，或者用运行中的一致性副本命令。
 * 这个 JSON 只承担三件事：
 *
 * 1. 调试与人工检查图结构；
 * 2. 把知识结构迁移进另一个知识库（导入是**替换**，不合并、不带正文）；
 * 3. 消化旧预览版导出的 `nodes/edges/goals/session` 结构。
 *
 * 文件里刻意没有笔记正文与附件：正文在文件系统里，靠复制文件夹保留。
 * 线上格式与 Rust 侧 `export_graph_json` 完全一致（`format: "knowledgenet"`、`version: 2`），
 * 因此两端导出的文件可以互相导入。
 *
 * 解析仍要做引用校验：丢弃指向不存在节点的关系与目标、给重号/缺失的 ID 重新编号
 * （旧文件里可能是 n1 这类顺序 ID），对话域的引用必须同步改写。重新编号只在
 * 「这个 ID 本来不指向任何节点」时改写引用，保证原 ID 仍然指向第一个出现的节点。
 */
import { newUniqueUuid } from "./uuid.ts";
import type { ChatData, ChatMessage, ChatThread, Discovery, Bookmark } from "./chatTypes.ts";
import { emptyChatData, normalizeLoadedMessages } from "./chatTypes.ts";
import type {
  DependencyEdge,
  Goal,
  GraphSnapshot,
  KnowledgeNode,
  LearnSession,
  LearnStatus,
} from "./types.ts";
import { normalizeTitle } from "./types.ts";

export const GRAPH_EXCHANGE_FORMAT = "knowledgenet";
/** v1 = 只有知识图；v2 = 线上格式与 Rust 一致（含对话域，仍不含正文与附件） */
export const GRAPH_EXCHANGE_VERSION = 2;
export const GRAPH_EXCHANGE_NOTE = "图数据交换格式：不含笔记正文与附件，不能当作完整备份";

const STATUSES: LearnStatus[] = ["todo", "learning", "done"];

export interface GraphExchange {
  /** 导出这份文件的知识库 ID；仅用于显示来源，导入不沿用 */
  libraryId: string | null;
  exportedAt: number;
  /** 文件里记录的源库修订号；导入后的修订号由当前知识库自己递增 */
  sourceRevision: number | null;
  snapshot: GraphSnapshot;
  chat: ChatData;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** 未知状态一律视为「未完成」：文件里停在 streaming 的消息本来就没有生成完 */
function asMessageStatus(value: unknown): ChatMessage["status"] {
  switch (value) {
    case "complete":
    case "cancelled":
    case "failed":
    case "incomplete":
      return value;
    default:
      return "incomplete";
  }
}

function asRole(value: unknown): ChatMessage["role"] {
  return value === "system" || value === "assistant" ? value : "user";
}

/**
 * 组装图数据交换文件（导出用）。
 * 线上格式与 Rust `export_graph_json` 对齐：`format` / `version` / `note` / `libraryId` /
 * `exportedAt` / `revision` / nodes / edges / goals / session / threads / messages /
 * discoveries / bookmarks。
 */
export function buildGraphExchange(
  snapshot: GraphSnapshot,
  chat: ChatData = emptyChatData(),
  options: { libraryId?: string | null; exportedAt?: number } = {},
): string {
  return JSON.stringify(
    {
      format: GRAPH_EXCHANGE_FORMAT,
      version: GRAPH_EXCHANGE_VERSION,
      note: GRAPH_EXCHANGE_NOTE,
      libraryId: options.libraryId ?? null,
      exportedAt: options.exportedAt ?? Date.now(),
      revision: snapshot.revision,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      goals: snapshot.goals,
      session: snapshot.session,
      threads: chat.threads,
      messages: chat.messages,
      discoveries: chat.discoveries,
      bookmarks: chat.bookmarks,
    },
    null,
    2,
  );
}

/** 解析知识图部分，并把「旧 ID → 新 ID」的改写表交出来（对话域引用要跟着改） */
function parseGraphPart(root: Record<string, unknown>): {
  snapshot: GraphSnapshot;
  nodeIdRemap: Map<string, string>;
} {
  if (!Array.isArray(root.nodes) || !Array.isArray(root.edges)) {
    throw new Error("文件格式无法识别：缺少 nodes / edges");
  }
  const now = Date.now();
  const usedIds = new Set<string>();
  const reservedIds = new Set<string>(
    asArray(root.nodes)
      .map((n) => asString(asRecord(n).id))
      .filter((id) => id.length > 0 && id !== "undefined"),
  );
  /** 只有「这个 ID 本来不指向任何节点」时才改写引用，见文件头说明 */
  const nodeIdRemap = new Map<string, string>();

  const nodes: KnowledgeNode[] = asArray(root.nodes).map((item) => {
    const n = asRecord(item);
    let id = asString(n.id);
    if (!id || id === "undefined" || usedIds.has(id)) {
      const fresh = newUniqueUuid(new Set([...usedIds, ...reservedIds]));
      if (!usedIds.has(id)) nodeIdRemap.set(id, fresh);
      id = fresh;
    }
    usedIds.add(id);
    return {
      id,
      title: normalizeTitle(asString(n.title)),
      aliases: asArray(n.aliases)
        .map((a) => normalizeTitle(asString(a)))
        .filter(Boolean),
      status: STATUSES.includes(n.status as LearnStatus) ? (n.status as LearnStatus) : "todo",
      createdAt: asNumber(n.createdAt, now),
      updatedAt: asNumber(n.updatedAt, now),
      // 交换格式不含磁盘位置：导入方落地后由自己的扫描给出真实路径。
      // 旧文件里的 storageState 直接忽略（v2 已经没有这个状态机）。
      relativePath: asString(n.relativePath),
      folderName: asString(n.folderName),
      health: "ok" as const,
      revision: asNumber(n.revision, 0),
      localMutation: false,
    };
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const remap = (value: unknown): string => {
    const key = asString(value);
    return nodeIdRemap.get(key) ?? key;
  };

  const edgeIds = new Set<string>();
  const reservedEdgeIds = new Set<string>(
    asArray(root.edges)
      .map((e) => asString(asRecord(e).id))
      .filter((id) => id.length > 0 && id !== "undefined"),
  );
  const edges: DependencyEdge[] = [];
  for (const item of asArray(root.edges)) {
    const e = asRecord(item);
    const fromId = remap(e.fromId);
    const toId = remap(e.toId);
    // 指向不存在节点的关系必须丢弃，否则界面上会出现指向空气的箭头
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) continue;
    let id = asString(e.id);
    if (!id || id === "undefined" || edgeIds.has(id)) {
      id = newUniqueUuid(new Set([...edgeIds, ...reservedEdgeIds]));
    }
    edgeIds.add(id);
    edges.push({
      id,
      fromId,
      toId,
      relation: asString(e.relation),
      relationType: asString(e.relationType, "prerequisite") || "prerequisite",
      createdAt: asNumber(e.createdAt, now),
      updatedAt: asNumber(e.updatedAt, now),
    });
  }

  const goalIds = new Set<string>();
  const reservedGoalIds = new Set<string>(
    asArray(root.goals)
      .map((g) => asString(asRecord(g).id))
      .filter((id) => id.length > 0 && id !== "undefined"),
  );
  const goals: Goal[] = [];
  for (const item of asArray(root.goals)) {
    const g = asRecord(item);
    const rootNodeId = remap(g.rootNodeId);
    if (!nodeIds.has(rootNodeId)) continue;
    let id = asString(g.id);
    if (!id || id === "undefined" || goalIds.has(id)) {
      id = newUniqueUuid(new Set([...goalIds, ...reservedGoalIds]));
    }
    goalIds.add(id);
    goals.push({
      id,
      title: normalizeTitle(asString(g.title)),
      rootNodeId,
      createdAt: asNumber(g.createdAt, now),
    });
  }

  /*
   * 会话同样逐字段校验后再用：文件里少一个字段时，演示端能靠默认值兜住，
   * 桌面端却会在 Rust 反序列化处直接失败（报一句「invalid args」），
   * 同一份文件两端行为不一致。缺关键信息就整条丢弃。
   */
  const rawSession = asRecord(root.session);
  const hasSession = root.session !== null && root.session !== undefined;
  const rawCurrent = rawSession.currentNodeId ?? null;
  const currentNodeId =
    typeof rawCurrent === "string" && nodeIds.has(rawCurrent) ? rawCurrent : null;
  const session: LearnSession | null =
    hasSession && (rawCurrent === null || currentNodeId !== null)
      ? {
          id: asString(rawSession.id) || "session",
          goalId: asString(rawSession.goalId),
          currentNodeId,
          updatedAt: asNumber(rawSession.updatedAt, now),
        }
      : null;

  return { snapshot: { revision: 0, nodes, edges, goals, session }, nodeIdRemap };
}

/** 逐级校验对话域的交叉引用：对话挂节点、消息挂对话、来源挂边与节点、书签挂节点 */
function parseChatPart(root: Record<string, unknown>, remap: (value: unknown) => string, nodeIds: Set<string>, edgeIds: Set<string>): ChatData {
  const threadIds = new Set<string>();
  const threads: ChatThread[] = [];
  for (const item of asArray(root.threads)) {
    const t = asRecord(item);
    const id = asString(t.id);
    if (!id || threadIds.has(id)) continue;
    const nodeId = remap(t.nodeId);
    // 对话必须挂在存在的节点上，否则恢复出来是一条看不见也删不掉的记录
    if (!nodeIds.has(nodeId)) continue;
    threadIds.add(id);
    threads.push({
      id,
      nodeId,
      title: asString(t.title, "新对话"),
      summary: asString(t.summary),
      createdAt: asNumber(t.createdAt, Date.now()),
      updatedAt: asNumber(t.updatedAt, Date.now()),
    });
  }

  const messageIds = new Set<string>();
  const messages: ChatMessage[] = [];
  for (const item of asArray(root.messages)) {
    const m = asRecord(item);
    const id = asString(m.id);
    if (!id || messageIds.has(id)) continue;
    const threadId = asString(m.threadId);
    if (!threadIds.has(threadId)) continue;
    messageIds.add(id);
    messages.push({
      id,
      threadId,
      role: asRole(m.role),
      content: asString(m.content),
      status: asMessageStatus(m.status),
      finishReason: typeof m.finishReason === "string" ? m.finishReason : null,
      requestId: typeof m.requestId === "string" ? m.requestId : null,
      usage: typeof m.usage === "string" ? m.usage : null,
      createdAt: asNumber(m.createdAt, Date.now()),
    });
  }

  const discoveryIds = new Set<string>();
  const discoveries: Discovery[] = [];
  for (const item of asArray(root.discoveries)) {
    const d = asRecord(item);
    const id = asString(d.id);
    if (!id || discoveryIds.has(id)) continue;
    const fromNodeId = remap(d.fromNodeId);
    const toNodeId = remap(d.toNodeId);
    if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) continue;
    const rawEdgeId = typeof d.edgeId === "string" ? d.edgeId : null;
    // 来源挂在依赖边上；边没了就退化为「无依赖边」，选段内容本身仍然保留
    const edgeId = rawEdgeId && edgeIds.has(rawEdgeId) ? rawEdgeId : null;
    discoveryIds.add(id);
    discoveries.push({
      id,
      edgeId,
      fromNodeId,
      toNodeId,
      threadId: threadIds.has(asString(d.threadId)) ? asString(d.threadId) : null,
      messageId: messageIds.has(asString(d.messageId)) ? asString(d.messageId) : null,
      snippet: asString(d.snippet),
      question: asString(d.question),
      createdAt: asNumber(d.createdAt, Date.now()),
    });
  }

  const bookmarkIds = new Set<string>();
  const bookmarks: Bookmark[] = [];
  for (const item of asArray(root.bookmarks)) {
    const b = asRecord(item);
    const id = asString(b.id);
    if (!id || bookmarkIds.has(id)) continue;
    const nodeId = remap(b.nodeId);
    if (!nodeIds.has(nodeId)) continue;
    const returnNodeId = typeof b.returnNodeId === "string" ? remap(b.returnNodeId) : null;
    bookmarkIds.add(id);
    bookmarks.push({
      id,
      nodeId,
      threadId: threadIds.has(asString(b.threadId)) ? asString(b.threadId) : null,
      messageId: messageIds.has(asString(b.messageId)) ? asString(b.messageId) : null,
      scrollOffset: asNumber(b.scrollOffset, 0),
      question: asString(b.question),
      returnNodeId: returnNodeId && nodeIds.has(returnNodeId) ? returnNodeId : null,
      createdAt: asNumber(b.createdAt, Date.now()),
      updatedAt: asNumber(b.updatedAt, Date.now()),
    });
  }

  return { threads, messages, discoveries, bookmarks };
}

/**
 * 解析图数据交换文件。
 *
 * 返回的快照 `revision` 固定为 0：修订号是「当前这个知识库」的值，
 * 导入方在自己那边递增，沿用文件里的数字只会得到一个对不上任何后端状态的假值。
 * 文件里的数字放在 `sourceRevision` 里，仅供界面显示来源。
 */
export function parseGraphExchange(json: string): GraphExchange {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("文件格式无法识别：不是合法的 JSON");
  }
  const root = asRecord(raw);
  if (!Array.isArray(root.nodes) || !Array.isArray(root.edges)) {
    throw new Error("文件格式无法识别：缺少 nodes / edges");
  }

  const { snapshot, nodeIdRemap } = parseGraphPart(root);
  const nodeIds = new Set(snapshot.nodes.map((n) => n.id));
  const edgeIds = new Set(snapshot.edges.map((e) => e.id));
  const remap = (value: unknown): string => {
    const key = asString(value);
    return nodeIdRemap.get(key) ?? key;
  };

  const chat = parseChatPart(root, remap, nodeIds, edgeIds);
  // 载入时归一消息状态：进程重启后不可能还有请求在跑
  chat.messages = normalizeLoadedMessages(chat.messages);

  return {
    libraryId: typeof root.libraryId === "string" ? root.libraryId : null,
    exportedAt: asNumber(root.exportedAt, Date.now()),
    sourceRevision: typeof root.revision === "number" ? root.revision : null,
    snapshot,
    chat,
  };
}
