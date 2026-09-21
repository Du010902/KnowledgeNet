/**
 * 对话域的两条纯函数规则
 *
 * 桌面端的对话写入直接走会话里的 `Repository`（SQLite），合并与删除由 Rust 在
 * 同一事务里完成，因此这里不再有「对话仓库接口」。
 *
 * 保留下来的两个函数服务于浏览器演示后端：`localStorage` 没有外键级联，
 * 节点合并/删除时必须显式地把挂在旧节点、旧关系上的数据搬走，
 * 规则与 Rust 侧 `transfer_chat_on_merge` / 级联删除保持一致，两端行为不能各说各话。
 */
import type { Bookmark, ChatData, Discovery } from "./chatTypes.ts";
import type { DroppedEdgeRef } from "./types.ts";

/** 一次节点合并对对话域的影响（与 Rust 的 `MergeTransfer` 同构） */
export interface ChatMergeTransfer {
  sourceNodeId: string;
  targetNodeId: string;
  droppedEdges: DroppedEdgeRef[];
}

/**
 * 把一次节点合并应用到对话数据上。
 *
 * 规则与 Rust 侧 `transfer_chat_on_merge` 保持一致：
 * - 对话改挂到目标节点，消息不动；
 * - 每个节点至多一条书签：目标已有书签时把源书签的非空字段并进去，否则整条改挂；
 * - 来源改挂到目标节点；挂在被去重边上的来源改挂到保留边，
 *   自环（没有替代边）的来源保留内容但断开 edgeId，而不是删掉。
 */
export function applyMergeToChatData(data: ChatData, transfer: ChatMergeTransfer): ChatData {
  const { sourceNodeId: source, targetNodeId: target, droppedEdges } = transfer;

  const threads = data.threads.map((t) =>
    t.nodeId === source ? { ...t, nodeId: target } : t,
  );

  const replacement = new Map<string, string | null>();
  for (const d of droppedEdges) replacement.set(d.droppedEdgeId, d.replacementEdgeId);

  const discoveries = data.discoveries.map((d) => {
    const next: Discovery = { ...d };
    if (next.fromNodeId === source) next.fromNodeId = target;
    if (next.toNodeId === source) next.toNodeId = target;
    if (next.edgeId && replacement.has(next.edgeId)) {
      next.edgeId = replacement.get(next.edgeId) ?? null;
    }
    return next;
  });

  /*
   * 每个节点至多一条书签。目标已有书签时把源书签的非空字段并进去；
   * 目标没有书签时把源书签改挂过去。
   *
   * 选取规则与 Rust 侧 `transfer_chat_on_merge` 一致：都按 updated_at 取最新的一条，
   * 多余的历史书签删除（正常流程下不会出现，但库被手工改过时要收敛到同一条）。
   */
  const byUpdatedDesc = (a: Bookmark, b: Bookmark) => b.updatedAt - a.updatedAt;
  const sourceBookmarks = data.bookmarks
    .filter((b) => b.nodeId === source)
    .sort(byUpdatedDesc);
  const targetBookmarks = data.bookmarks
    .filter((b) => b.nodeId === target)
    .sort(byUpdatedDesc);
  let bookmarks = data.bookmarks.filter((b) => b.nodeId !== source && b.nodeId !== target);

  const targetBookmark = targetBookmarks[0];
  if (sourceBookmarks.length > 0) {
    const newest = sourceBookmarks[0] as Bookmark;
    const now = Date.now();
    if (targetBookmark) {
      const merged: Bookmark = {
        ...targetBookmark,
        threadId: targetBookmark.threadId ?? newest.threadId ?? null,
        messageId: targetBookmark.messageId ?? newest.messageId ?? null,
        scrollOffset: targetBookmark.scrollOffset || newest.scrollOffset,
        question: targetBookmark.question || newest.question,
        returnNodeId: targetBookmark.returnNodeId ?? newest.returnNodeId ?? null,
        updatedAt: now,
      };
      bookmarks = [...bookmarks, merged];
    } else {
      bookmarks = [...bookmarks, { ...newest, nodeId: target, updatedAt: now }];
    }
  } else if (targetBookmark) {
    bookmarks = [...bookmarks, targetBookmark];
  }

  return { threads, messages: data.messages, discoveries, bookmarks };
}

/**
 * 把一次节点删除应用到对话数据上，对齐 SQLite 的外键级联语义。
 *
 * - 挂在被删节点上的对话与其消息一起消失（`chat_threads` → `nodes` 级联，消息随对话级联）；
 * - 该节点的书签消失（`bookmarks` → `nodes` 级联）；
 * - 挂在被删关系上的来源消失（`discoveries` → `edges` 级联）。
 *
 * 注意与 SQLite 保持一致的地方：来源本身没有指向节点的外键，
 * 因此 `edge_id` 为空、或边仍在的来源**不会**因为删节点而消失。
 */
export function applyNodeDeleteToChatData(
  data: ChatData,
  nodeId: string,
  removedEdgeIds: string[],
): ChatData {
  const goneEdges = new Set(removedEdgeIds);
  const goneThreads = new Set(
    data.threads.filter((t) => t.nodeId === nodeId).map((t) => t.id),
  );

  return {
    threads: data.threads.filter((t) => !goneThreads.has(t.id)),
    messages: data.messages.filter((m) => !goneThreads.has(m.threadId)),
    discoveries: data.discoveries.filter(
      (d) => !(d.edgeId && goneEdges.has(d.edgeId)),
    ),
    bookmarks: data.bookmarks.filter((b) => b.nodeId !== nodeId),
  };
}
