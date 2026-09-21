/**
 * 知识点详情
 *
 * 状态、前置知识、被依赖、疑问与来源，以及两个危险入口（合并 / 添加）都收在这里。
 * 「疑问与来源」保留原来的处理：**先切到来源所属节点再滚动**——
 * 来源是在依赖方（fromNodeId）的对话里记下来的，而这里看的可能是它指向的前置知识，
 * 不先切过去，聊天面板会因为「这个对话不属于当前节点」立刻把对话切走，定位就落空了。
 */
import { useMemo, useState } from "react";

import { STATUS_ORDER } from "@/data/types";
import { STATUS_DISPLAY } from "@/store";
import type { DependencyEdge } from "@/data/types";
import { dependentsOf, prerequisitesOf } from "@/data/engine";
import { AddPrerequisiteDialog } from "./AddPrerequisiteDialog";
import { Icon } from "./icons";
import { MergeNodeDialog } from "./NodeDialogs";
import { chatApi, evidenceCount, layoutApi, useChat, useEvidenceMap, useWorkspace, workspaceApi } from "./workspace/bridge";

/**
 * 一条依赖上记录了几段来源。
 *
 * v2 把「来源」从独立的 discoveries 表改成关系文件里的 `evidence`（契约 §1.4），
 * 会话内的那份缓存由 chatStore 持有；边界数据里也可能带上 `evidence`，
 * 因此两处都读，取较大值：界面上宁可多显示一条，也不要让使用者以为记录丢了。
 */
function evidenceCountOf(
  edge: DependencyEdge | undefined,
  sessionMap: Record<string, unknown[]>,
  fromNodeId: string,
): number {
  if (!edge) return 0;
  const inline = (edge as unknown as { evidence?: unknown[] }).evidence;
  const fromEdge = Array.isArray(inline) ? inline.length : 0;
  const fromSession = evidenceCount(sessionMap as never, fromNodeId, edge.id);
  return Math.max(fromEdge, fromSession);
}

export function NodeDetail({ nodeId }: { nodeId: string }) {
  const graph = useWorkspace((s) => s.graph);
  const node = graph.nodes.find((n) => n.id === nodeId) ?? null;
  const writable = useWorkspace((s) => s.canWrite());
  const readOnly = useWorkspace((s) => s.libraryState === "readonly");

  /*
   * 只订阅原始数组，筛选放到 useMemo 里做：在 selector 里 `.filter()` 每次都会返回
   * 新数组，zustand v5 的 useSyncExternalStore 会认为快照一直在变。
   */
  const allBookmarks = useChat((s) => s.bookmarks);
  const evidenceMap = useEvidenceMap();

  const [addOpen, setAddOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const prereqs = useMemo(() => (node ? prerequisitesOf(graph, node.id) : []), [graph, node]);
  const dependents = useMemo(() => (node ? dependentsOf(graph, node.id) : []), [graph, node]);
  const bookmark = useMemo(
    () => allBookmarks.find((b) => b.nodeId === nodeId),
    [allBookmarks, nodeId],
  );

  /**
   * 打开记录对应的对话，并滚动到原处（书签用偏移，来源优先用消息 ID）。
   *
   * v2 里对话是**主工作区**，不再是一个标签：图谱独占时先切回分屏，
   * 否则「回到原处」只是把消息滚到了看不见的地方。
   */
  const goToRecord = (threadId: string | null, messageId: string | null, offset: number) => {
    if (layoutApi().mode === "graph") layoutApi().setMode("split");
    if (!threadId) return;
    void chatApi().selectThread(threadId);
    chatApi().requestScroll({ threadId, messageId, offset });
  };

  if (!node) {
    return <p className="empty-text">这个知识点已经被移除了，详情不再可用。</p>;
  }

  const writeBlocked = readOnly
    ? "这是只读知识库：所有修改入口都已禁用。"
    : "正在检查/修复知识库，修改入口暂时禁用。";

  return (
    <>
      {/* ------------------------------ 学习状态 ------------------------------ */}
      <div className="block">
        <div className="block-head">
          <h3>学习状态</h3>
        </div>
        <div className="segmented" role="group" aria-label="学习状态">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              className={node.status === s ? "active" : undefined}
              aria-pressed={node.status === s}
              disabled={!writable}
              title={writable ? undefined : writeBlocked}
              onClick={() => void workspaceApi().setStatus(node.id, s)}
            >
              <i className={`status-dot ${STATUS_DISPLAY[s].cls}`} />
              {STATUS_DISPLAY[s].label}
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------ 前置知识 ------------------------------ */}
      <div className="block">
        <div className="block-head">
          <h3>
            前置知识 <span className="muted small">{prereqs.length}</span>
          </h3>
          <button
            type="button"
            disabled={!writable}
            title={writable ? undefined : writeBlocked}
            onClick={() => setAddOpen(true)}
          >
            <Icon name="plus" />
            添加
          </button>
        </div>

        {prereqs.length === 0 ? (
          <>
            <p className="empty-text">
              还没有前置知识。一行写一个知识点；在对话里选中不懂的概念也能直接建点。
            </p>
            <button
              type="button"
              className="btn section-action"
              disabled={!writable}
              title={writable ? undefined : writeBlocked}
              onClick={() => setAddOpen(true)}
            >
              <Icon name="plus" />
              添加前置知识
            </button>
          </>
        ) : (
          <>
            {/*
              掌握进度（参考图「3 / 7 个前置知识」那一行）。
              口径就是「直接前置里已经标为已理解的比例」：图上每个前置都有状态，
              这里只是把它们数出来，不做任何推断。
            */}
            <div className="progress-row">
              <span>
                {prereqs.filter((p) => p.status === "done").length} / {prereqs.length} 个前置知识
              </span>
              <span>{Math.round((prereqs.filter((p) => p.status === "done").length / prereqs.length) * 100)}%</span>
            </div>
            <div className="progress-track" role="presentation">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.round((prereqs.filter((p) => p.status === "done").length / prereqs.length) * 100)}%`,
                }}
              />
            </div>

            {prereqs.map((p) => {
            const edge = graph.edges.find((e) => e.fromId === node.id && e.toId === p.id);
            const sources = evidenceCountOf(edge, evidenceMap, node.id);
            return (
              /*
               * key 必须按**边**而不是按节点：A 与 B 都依赖 C 时，切换节点
               * 会让 React 认为「还是同一个 C」，于是复用同一个非受控输入框——
               * 框里留着 A→C 的说明，而失焦处理已经绑定到 B→C，
               * 一失焦就把 A 的说明写进了 B 的依赖。
               */
              <div key={edge?.id ?? `p-${p.id}`} className="relation">
                <div className="relation-name">
                  <i className={`status-dot ${STATUS_DISPLAY[p.status].cls}`} />
                  <button
                    type="button"
                    className="node-link"
                    title={`进入「${p.title}」`}
                    onClick={() => void workspaceApi().enterNode(p.id)}
                  >
                    {p.title}
                  </button>
                  {sources > 0 && (
                    <span
                      className="small muted"
                      title="这条依赖记录了几段来源，可在下方「疑问与来源」里查看与定位"
                    >
                      {sources} 条来源
                    </span>
                  )}
                  {edge && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`断开与「${p.title}」的依赖`}
                      title={
                        writable ? "断开这条依赖（知识点本身会保留）" : writeBlocked
                      }
                      disabled={!writable}
                      onClick={() => void workspaceApi().removeEdge(edge.id)}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </div>
                {edge && (
                  <input
                    className="relation-reason"
                    defaultValue={edge.relation}
                    placeholder="为什么需要它…"
                    aria-label={`为什么需要「${p.title}」`}
                    spellCheck={false}
                    disabled={!writable}
                    onBlur={(e) => {
                      if (e.target.value !== edge.relation) {
                        void workspaceApi().updateEdgeRelation(edge.id, e.target.value);
                      }
                    }}
                  />
                )}
              </div>
            );
            })}
          </>
        )}

        {prereqs.length > 0 && prereqs.every((p) => p.status === "done") && node.status !== "done" && (
          <p className="empty-text">它的前置知识都已理解，可以回来重新尝试理解「{node.title}」了。</p>
        )}
      </div>

      {/* ------------------------------- 被依赖 ------------------------------- */}
      <div className="block">
        <div className="block-head">
          <h3>
            被依赖 <span className="muted small">{dependents.length}</span>
          </h3>
        </div>
        {dependents.length === 0 ? (
          <p className="empty-text">目前没有其他知识点依赖它。</p>
        ) : (
          dependents.map((d) => (
            <div key={d.id} className="relation">
              <div className="relation-name">
                <Icon name="arrow-right" />
                <button
                  type="button"
                  className="node-link"
                  title={`进入「${d.title}」`}
                  onClick={() => void workspaceApi().enterNode(d.id)}
                >
                  {d.title}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ----------------------------- 待解决疑问 ----------------------------- */}
      <div className="block">
        <div className="block-head">
          <h3>待解决疑问</h3>
          <span className="muted small">{bookmark ? 1 : 0} 条</span>
        </div>

        {!bookmark && (
          <p className="empty-text">
            还没有记录。在对话里选中一段文字，点「仅记为疑问」，之后从这里回到原处。
            选中文字也可以直接把它设成前置知识——那条依赖的说明会写进本节点的关系文件。
          </p>
        )}

        {bookmark && (
          <div className="source-card">
            <blockquote>{bookmark.question || "（没有记录内容）"}</blockquote>
            <div className="row">
              <span>待解决疑问</span>
              <span className="spacer" />
              <button
                type="button"
                disabled={!bookmark.threadId}
                title={
                  bookmark.threadId
                    ? "打开当时的对话并回到这个位置"
                    : "这条疑问没有关联对话，无法定位"
                }
                onClick={() =>
                  goToRecord(
                    bookmark.threadId ?? null,
                    bookmark.messageId ?? null,
                    bookmark.scrollOffset,
                  )
                }
              >
                回到原处
              </button>
              <button
                type="button"
                disabled={!writable}
                title={writable ? "把它从待解决疑问里去掉" : writeBlocked}
                onClick={() => void chatApi().deleteBookmark(bookmark.id)}
              >
                已解决
              </button>
            </div>
          </div>
        )}

        {prereqs.some(
          (p) =>
            evidenceCountOf(
              graph.edges.find((e) => e.fromId === node.id && e.toId === p.id),
              evidenceMap,
              node.id,
            ) > 0,
        ) && (
          <p className="empty-text">
            依赖上的「来源」记录在节点自己的 <code>relations.json</code> 里，
            条目数显示在每条依赖的右侧。
          </p>
        )}
      </div>

      {/* -------------------------------- 危险区 -------------------------------- */}
      <div className="detail-danger">
        <button
          type="button"
          disabled={!writable}
          title={writable ? undefined : writeBlocked}
          onClick={() => setMergeOpen(true)}
        >
          <Icon name="merge" />
          合并重复知识点
        </button>
        <p>
          把它合并进另一个知识点：关系、笔记正文、附件、别名与对话一起转移，重复依赖自动归并。
          会形成循环依赖时整体不执行。
          「彻底删除」在右上角的「更多操作」里：<b>文件夹本身会被删掉</b>（不可撤销），
          所以那一步会先用文字说清会消失什么，并给一个「备份文件夹中的资源」按钮。
        </p>
      </div>

      {addOpen && <AddPrerequisiteDialog nodeId={node.id} onClose={() => setAddOpen(false)} />}
      {mergeOpen && <MergeNodeDialog nodeId={node.id} onClose={() => setMergeOpen(false)} />}
    </>
  );
}
