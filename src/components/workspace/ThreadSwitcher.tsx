/**
 * 对话列表（侧边栏「对话」页签里的那一栏）
 *
 * 原来的窄标签栏在节点有多个对话时会横向溢出：标签越挤越窄，最后一个被裁掉，
 * 既看不到名字也点不中。现在只有一种呈现——侧边栏里的一栏列表
 * （入口是上下文栏最左那颗「对话列表」图标，见 NodeContextBar / SidePanel）。
 *
 * 行为一个都没有丢：单击切换、双击重命名（输入法组词期间的回车不提交）、
 * 右键「重命名 / 删除」、删除前弹窗确认、删除失败留在弹窗里说明原因。
 */
import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/icons";
import type { ChatThread } from "@/data/chatTypes";
import { isImeComposing } from "@/keyboard";
import { chatApi, chatThreadsSnapshot, useChat, useNodeThreads, useWorkspace, workspaceApi } from "./bridge";
import { Dialog } from "@/components/Dialog";
import { useEscape } from "./useEscape";

/**
 * 线程的增删改查。
 *
 * 抽成 hook 是因为删除确认与重命名要同时被列表行、右键菜单与弹窗用到，
 * 各写一份的话，重命名与删除的确认逻辑迟早会漏一处。
 */
export function useThreadActions(nodeId: string | null) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [threadToDelete, setThreadToDelete] = useState<ChatThread | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /*
   * 只读知识库：新建 / 重命名 / 删除对话都是写入，一律拦在这里。
   * 两个呈现（下拉与左侧列表）共用这一个 hook，因此门禁只需要写一遍。
   */
  const writable = useWorkspace((s) => s.canWrite());
  const blockedReason = useWorkspace((s) =>
    s.libraryState === "readonly"
      ? "这是只读知识库：没有取得写锁，或知识库版本高于本应用。"
      : "正在检查/修复知识库，对话编辑暂时禁用。",
  );

  /**
   * 打开一个新的对话窗口。
   *
   * **不创建任何文件**：只是把当前对话清空，让输入区变成一张白纸。
   * 对话文件（`thread.json`）在第一条消息发出去的那一刻才建立——
   * 先建文件再等用户说话，会留下一堆只有「新对话」标题的空目录。
   */
  const startThread = () => {
    if (!nodeId) return;
    if (!writable) {
      workspaceApi().notify("warn", blockedReason);
      return;
    }
    void chatApi().selectThread(null);
  };

  const beginRename = (thread: ChatThread) => {
    setRenaming(thread.id);
    setRenameDraft(thread.title);
  };

  const commitRename = (thread: ChatThread) => {
    setRenaming(null);
    const clean = renameDraft.trim();
    if (!clean || clean === thread.title) return;
    if (!writable) {
      workspaceApi().notify("warn", blockedReason);
      return;
    }
    void chatApi().renameThread(thread.id, clean);
  };

  const removeThread = async (thread: ChatThread) => {
    if (!writable) {
      setDeleteError(blockedReason);
      return;
    }
    setDeleteError(null);
    await chatApi().deleteThread(thread.id);
    // 失败时 store 只把原因写进 error，对话仍在列表里：弹窗留着说明原因
    const alive = chatThreadsSnapshot().some((t) => t.id === thread.id);
    if (alive) {
      setDeleteError("删除对话失败，请重试。");
      return;
    }
    setThreadToDelete(null);
  };

  return {
    writable,
    blockedReason,
    renaming,
    renameDraft,
    setRenameDraft,
    beginRename,
    commitRename,
    cancelRename: () => setRenaming(null),
    startThread,
    threadToDelete,
    requestDelete: (thread: ChatThread) => {
      setDeleteError(null);
      setThreadToDelete(thread);
    },
    cancelDelete: () => setThreadToDelete(null),
    removeThread,
    deleteError,
  };
}

type ThreadActions = ReturnType<typeof useThreadActions>;

/** 一个线程在一行里的样子：名字（双击重命名）+ 删除按钮 */
function ThreadRow({
  thread,
  active,
  actions,
  onSelect,
  wide = false,
}: {
  thread: ChatThread;
  active: boolean;
  actions: ThreadActions;
  onSelect: () => void;
  /** 左侧列表里显示摘要，下拉里不显示（宽度不够） */
  wide?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // 右键菜单是浮层：Esc、点别处、滚动都该收起
  useEscape(menu !== null, () => setMenu(null));
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  if (actions.renaming === thread.id) {
    return (
      <div className="thread-row renaming">
        <input
          className="thread-rename"
          autoFocus
          value={actions.renameDraft}
          maxLength={40}
          spellCheck={false}
          aria-label="对话名称"
          onChange={(e) => actions.setRenameDraft(e.target.value)}
          onBlur={() => actions.commitRename(thread)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") actions.cancelRename();
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={active ? "thread-row active" : "thread-row"}
      data-thread-id={thread.id}
      // 右键给出「重命名 / 删除」：双击也能改名，但右键是能看见入口的那条路
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        className="thread-name"
        aria-pressed={active}
        title={`${thread.title}（双击或右键重命名）`}
        onClick={onSelect}
        onDoubleClick={() => actions.beginRename(thread)}
      >
        <span className="thread-name-text">{thread.title}</span>
        {wide && thread.summary && <span className="thread-summary">{thread.summary}</span>}
      </button>
      <button
        type="button"
        className="thread-del"
        aria-label={`删除对话「${thread.title}」`}
        title="删除这个对话"
        onClick={(e) => {
          e.stopPropagation();
          actions.requestDelete(thread);
        }}
      >
        <Icon name="close" />
      </button>

      {menu && (
        <div
          className="thread-menu"
          role="menu"
          aria-label={`对话「${thread.title}」的操作`}
          data-thread-menu
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            data-thread-rename
            disabled={!actions.writable}
            title={actions.writable ? "重命名这个对话" : actions.blockedReason}
            onClick={() => {
              setMenu(null);
              actions.beginRename(thread);
            }}
          >
            <Icon name="note" />
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            data-thread-delete
            disabled={!actions.writable}
            title={actions.writable ? "删除这个对话" : actions.blockedReason}
            onClick={() => {
              setMenu(null);
              actions.requestDelete(thread);
            }}
          >
            <Icon name="close" />
            删除
          </button>
        </div>
      )}
    </div>
  );
}

/** 删除确认弹窗：两个呈现共用同一份文案 */
function DeleteThreadDialog({ actions }: { actions: ThreadActions }) {
  const thread = actions.threadToDelete;
  if (!thread) return null;
  return (
    <Dialog
      title="删除这个对话？"
      subtitle="删除后无法撤销"
      onClose={actions.cancelDelete}
      footer={
        <>
          <button type="button" className="btn" onClick={actions.cancelDelete}>
            取消
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={!actions.writable}
            title={actions.writable ? undefined : actions.blockedReason}
            onClick={() => void actions.removeThread(thread)}
          >
            删除对话
          </button>
        </>
      }
    >
      <p className="secondary-text">
        「{thread.title}」及其全部消息会从节点文件夹里一起删除，知识点、笔记与关系说明不受影响。
      </p>
      {actions.deleteError && (
        <p className="field-error" role="alert">
          {actions.deleteError}
        </p>
      )}
    </Dialog>
  );
}
/* ------------------------------ 对话列表正文 ------------------------------ */

/**
 * 线程列表正文（侧边栏「对话」页签里的内容）。
 *
 * 它不再自带标题栏与关闭按钮：那是侧边栏的事（见 SidePanel）。
 * 这里只负责「新建 / 列出 / 选中 / 重命名 / 删除」，
 * 并且保留 `.thread-list` 与 `[data-new-thread]` 这两个类与属性——
 * 自检脚本（ui-check / release-check）按它们找入口。
 */
export function ThreadListBody({ nodeId }: { nodeId: string | null }) {
  const threads = useNodeThreads(nodeId);
  const activeThreadId = useChat((s) => s.activeThreadId);
  const actions = useThreadActions(nodeId);

  // 最新用过的排前面：切换对话时找的是「刚才那个」，不是「最早建的那个」
  const ordered = useMemo(
    () => threads.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  );

  return (
    <div className="thread-list" aria-label="对话列表">
      <div className="thread-list-actions">
        <button
          type="button"
          className="btn sm thread-new"
          data-new-thread
          aria-label="新对话窗口"
          title="打开一个新的对话窗口（发出第一条消息时才建立对话文件）"
          onClick={() => actions.startThread()}
        >
          <Icon name="plus" />
          新对话
        </button>
      </div>

      <div className="thread-list-body">
        {ordered.length === 0 && (
          <p className="empty">还没有对话。在下面写下第一个问题，对话会在那一刻建立。</p>
        )}
        {ordered.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === activeThreadId}
            actions={actions}
            wide
            onSelect={() => void chatApi().selectThread(t.id)}
          />
        ))}
      </div>

      <DeleteThreadDialog actions={actions} />
    </div>
  );
}