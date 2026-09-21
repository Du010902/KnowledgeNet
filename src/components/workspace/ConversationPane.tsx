/**
 * 对话工作区
 *
 * 对话从右栏的一个标签升级成主工作区：节点上下文条 + 消息阅读区 + 底部输入区。
 * 结构上只有三条硬约束：
 *
 * 1. **正文最大阅读宽度 840px**：宽屏上把一行拉到 1600px，眼睛会找不到下一行的开头；
 *    上限写在 CSS 里（`--reading-width`），窄屏自然退化成满宽。
 * 2. **输入区固定在底部**：不随消息滚动。生成中发送键变成停止键，入口不移动。
 * 3. **切换模式/节点不丢滚动位置**：滚动容器不卸载，切节点只是换内容；
 *    从书签或来源跳回来时按消息 ID 定位，而不是靠偏移猜。
 *
 * `ChatMessages` 与 `ChatComposer` 原样复用；这一层负责它们之间的编排
 * （草稿、线程选择、发送、重试、复制、记录疑问）。
 */
import { useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/ChatComposer";
import { ChatMessages } from "@/components/ChatMessages";
import { formatTokens } from "@/data/contextBudget";
import { Icon } from "@/components/icons";
import { hasRealAi } from "@/data/aiProvider";
import { isImeComposing } from "@/keyboard";
import type { ChatMessage } from "@/data/chatTypes";
import {
  chatApi,
  chatMessagesSnapshot,
  useChat,
  useCurrentNode,
  useNodeThreads,
  useThreadMessages,
  useWorkspace,
  workspaceApi,
} from "./bridge";
import { useWorkspaceCommands } from "./commands";
import { NodeContextBar } from "./NodeContextBar";
import { SidePanel } from "./SidePanel";

/**
 * 每个知识点没写完的问题。
 *
 * 放在模块级而不是组件状态里：切换模式会卸载对话工作区，
 * 组件状态随之丢失，而「刚才打了一半的问题」是最不该丢的东西。
 * 按节点分开存：换一个知识点时不该看到上一条没发出去的问题。
 */
const drafts = new Map<string, string>();

/**
 * 每个对话的阅读位置。
 *
 * 与草稿同样放在模块级：切模式会把对话工作区整棵卸载重建（对话独占与分屏里
 * 它挂在不同的父节点下），组件状态与 DOM 滚动位置都留不住。
 * 记「离顶部多少像素」与「当时是不是贴着底部」两件事：
 * 贴底的人应该继续跟着新消息走，读中间的人应该回到原来那一行。
 */
const scrollMemory = new Map<string, { top: number; pinned: boolean }>();

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 复制到剪贴板。
 *
 * 桌面端（Tauri 自定义协议）不一定是安全上下文，`navigator.clipboard` 可能不存在；
 * 因此保留一条 textarea + execCommand 的退路。两条路都失败才报失败——
 * 复制这种动作最忌讳提示成功却什么都没进剪贴板。
 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  if (!ok) throw new Error("当前环境不允许访问剪贴板");
}

export function ConversationPane() {
  const node = useCurrentNode();
  const nodeId = node?.id ?? null;
  const writable = useWorkspace((s) => s.canWrite());
  const scanState = useWorkspace((s) => s.scanState);

  const threads = useNodeThreads(nodeId);
  const activeThreadId = useChat((s) => s.activeThreadId);
  const messages = useThreadMessages(activeThreadId);
  const activeRequests = useChat((s) => s.activeRequests);
  const pendingScroll = useChat((s) => s.pendingScroll);
  const error = useChat((s) => s.error);
  const activity = useChat((s) => s.activity);
  const contextUsage = useChat((s) => s.contextUsage);
  const configured = useChat((s) => s.configured);
  const aiLabel = useChat((s) => s.aiLabel);
  const messagesLoading = useChat((s) => s.messagesLoading);

  const commands = useWorkspaceCommands();

  const [draft, setDraft] = useState(() => (nodeId ? (drafts.get(nodeId) ?? "") : ""));
  /** 空库时的「第一个知识点」输入：空态本身就是入口，不必先学会打开抽屉 */
  const [firstNodeDraft, setFirstNodeDraft] = useState("");
  const firstNodeRef = useRef<HTMLInputElement>(null);
  const [scrollTarget, setScrollTarget] = useState<typeof pendingScroll>(null);

  const listRef = useRef<HTMLDivElement>(null);
  /**
   * **真正的滚动容器**是 `.conversation-reader`，不是 `.messages`——
   * 后者被 CSS 设成 `overflow: visible`（滚动交给 reader，输入区才能固定）。
   * 之前所有滚动都写在 `.messages` 上，等于什么都没做：
   * 演示回答短、容器不滚动时看不出来，答案一长（公式/表格）就暴露了。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 消息内容列：观察它的高度变化，用于「内容变高后继续贴底」 */
  const columnRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handledScrollNonce = useRef(0);
  /** 用户是不是贴着底部看：不贴底时新消息不该把视线硬拽下去 */
  const pinnedToBottom = useRef(true);
  /** 上一次「贴底」时的 scrollTop：用来区分「用户往回滚」与「内容自己变高」 */
  const lastPinnedTop = useRef(0);

  /* ------------------------- 载入：节点 → 线程头 → 消息 ------------------------- */

  useEffect(() => {
    void chatApi().openNode(nodeId);
  }, [nodeId]);

  // 切节点时换上那个节点自己的草稿
  useEffect(() => {
    setDraft(nodeId ? (drafts.get(nodeId) ?? "") : "");
  }, [nodeId]);

  const setDraftValue = (value: string) => {
    setDraft(value);
    if (nodeId) drafts.set(nodeId, value);
  };

  /*
   * 切**节点**时选中该节点上次使用的对话；没有就留空，第一条消息会自动建立。
   *
   * 只在节点真的换了的时候做这件事：否则用户点「新对话窗口」把当前对话清空之后，
   * 这个 effect 会立刻把最近那个对话又选回来——看起来就像按钮没反应。
   */
  const lastAutoNode = useRef<string | null>(null);
  useEffect(() => {
    if (!nodeId) return;
    const nodeChanged = lastAutoNode.current !== nodeId;
    lastAutoNode.current = nodeId;
    if (!nodeChanged) return;
    if (threads.some((t) => t.id === activeThreadId)) return;
    const latest = threads.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
    void chatApi().selectThread(latest?.id ?? null);
  }, [nodeId, threads, activeThreadId]);

  // 新建对话后自动聚焦输入框
  const wasThreadCount = useRef(threads.length);
  useEffect(() => {
    if (threads.length > wasThreadCount.current) inputRef.current?.focus();
    wasThreadCount.current = threads.length;
  }, [threads.length]);

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  const running = activeThread ? Boolean(activeRequests[activeThread.id]) : false;
  const activeMessageId = activeThread ? (activeRequests[activeThread.id]?.messageId ?? null) : null;

  /*
   * 切换工作区模式会**重建**对话工作区：对话独占时它挂在 `.workspace-area` 下，
   * 分屏时挂在 `.split-slot` 下——React 眼里那是两棵不同的树，于是滚动容器被换掉，
   * 阅读位置随之归零。而「切模式不丢对话滚动位置」是验收项之一（设计 §12.5）。
   *
   * 因此在渲染期间（不是副作用里）就把上一份位置认领回来：
   * 贴底看的人继续贴底，读到中间的人回到原来那一行。
   * 放在渲染期间是必须的——下面「新消息自动贴底」那条 effect 会先跑，
   * 它必须已经看到正确的 pinned 值，否则一进来就把人拽到底部。
   */
  const scrollKey = activeThread?.id ?? nodeId ?? "";
  const claimedKey = useRef<string | null>(null);
  const restoreRef = useRef<{ pinned: boolean; top: number } | null>(null);
  if (claimedKey.current !== scrollKey) {
    claimedKey.current = scrollKey;
    const saved = scrollMemory.get(scrollKey);
    pinnedToBottom.current = saved ? saved.pinned : true;
    restoreRef.current = saved && !saved.pinned ? saved : null;
  }

  // 认领之后按记下的位置恢复：等消息渲染出来再滚，不然滚的是一个还不存在的高度
  useEffect(() => {
    const pending = restoreRef.current;
    if (!pending) return;
    restoreRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    const timer = window.setTimeout(() => {
      el.scrollTop = Math.max(0, pending.top);
    }, 40);
    return () => window.clearTimeout(timer);
  }, [scrollKey, messages.length]);

  /*
   * 「回到原处」的两种触发：书签（回到跳走时的阅读位置）与来源定位（跳到具体那条消息）。
   * 请求先落到本地状态，等消息渲染完成后再滚动，避免滚到一个还不存在的高度。
   */
  useEffect(() => {
    setScrollTarget(null);
  }, [activeThreadId]);

  useEffect(() => {
    if (!pendingScroll) return;
    if (pendingScroll.threadId !== activeThreadId) return;
    if (pendingScroll.nonce === handledScrollNonce.current) return;
    handledScrollNonce.current = pendingScroll.nonce;
    setScrollTarget(pendingScroll);
    chatApi().clearScrollRequest();
  }, [pendingScroll, activeThreadId]);

  useEffect(() => {
    if (!scrollTarget) return;
    const el = scrollRef.current;
    if (!el) return;
    const timer = window.setTimeout(() => {
      let top = scrollTarget.offset;
      if (scrollTarget.messageId) {
        const target = el.querySelector<HTMLElement>(`[data-message-id="${scrollTarget.messageId}"]`);
        if (target) {
          const containerTop = el.getBoundingClientRect().top;
          top = target.getBoundingClientRect().top - containerTop + el.scrollTop - 12;
        }
      }
      el.scrollTop = Math.max(0, top);
    }, 40);
    return () => window.clearTimeout(timer);
  }, [scrollTarget, messages.length]);

  // 生成过程中保持滚动到底部。正在展示「回到原处」时不抢滚动位置。
  useEffect(() => {
    if (scrollTarget) return;
    const el = scrollRef.current;
    if (!el) return;
    if (!pinnedToBottom.current && messages.length > 0) return;
    pinToBottom(el);
  }, [messages, running, scrollTarget]);

  /*
   * 内容自己变高时重新贴底。
   *
   * 不只是「窗口变宽导致折行」——公式字体加载完、图片到位、表格与代码块撑开，
   * 都会在**首屏渲染之后**再改变高度。这时如果停在原来的 scrollTop 上，
   * 已经贴着底部看的人会被悄悄甩到上面去（公式一多尤其明显）。
   * 所以观察内容列本身，而不是只看容器宽度。
   */
  useEffect(() => {
    const el = scrollRef.current;
    const column = columnRef.current;
    if (!el || !column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current) pinToBottom(el);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [nodeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (pinnedToBottom.current) pinToBottom(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [nodeId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    /*
     * 「用户是不是还贴着底部看」不能只看当前距离。
     *
     * 程序性地贴底、以及内容在渲染后自己变高（公式字体加载完、表格撑开），
     * 都会触发 scroll 事件；如果一看到「不在底部」就当成用户滚上去了，
     * 就会把自己的贴底动作误判成用户意图，然后**停止**继续贴底——
     * 结果是正在生成的长回答停在半路，新内容全在屏幕外。
     *
     * 判据改成「往回滚了」：只有 scrollTop 明显小于上一次贴底的位置，才算用户离开。
     */
    if (gap < 80) {
      pinnedToBottom.current = true;
      lastPinnedTop.current = el.scrollTop;
    } else if (el.scrollTop < lastPinnedTop.current - 4) {
      pinnedToBottom.current = false;
    }
    // 顺手记下位置：切模式时容器会被重建，只有这里记得住「刚才读到哪」
    if (scrollKey) scrollMemory.set(scrollKey, { top: el.scrollTop, pinned: pinnedToBottom.current });
  };

  /** 贴底并把「上次贴底的位置」记下来，供 onScroll 判断用户有没有往回滚 */
  const pinToBottom = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    lastPinnedTop.current = el.scrollTop;
  };

  /* --------------------------------- 动作 --------------------------------- */

  const sendMessage = async (text: string) => {
    if (!node) return;
    // 只读知识库：对话写不进去，宁可不发，也不产生一条只存在于界面里的假消息
    if (!writable) {
      workspaceApi().notify("warn", "这是只读知识库：对话不会保存，因此不能发送。");
      return;
    }
    let thread = activeThread;
    if (!thread) {
      // 第一条消息顺手把对话建出来：不必先点「新建对话」再回来输入
      try {
        thread = await chatApi().createThread(node.id);
      } catch (err) {
        workspaceApi().notify("error", `新建对话失败：${messageOf(err)}`);
        return; // 草稿留在输入框里
      }
    }
    const targetThread = thread;
    setDraftValue("");
    setScrollTarget(null);
    pinnedToBottom.current = true;
    await chatApi().send(node.id, text);

    // 没落地（生成守卫拦下、写库失败）就把问题放回输入框，别让它凭空消失
    const landed = chatMessagesSnapshot().some(
      (m) => m.threadId === targetThread.id && m.role === "user" && m.content === text,
    );
    if (!landed) setDraftValue(text);
  };

  /** 空态里创建第一个知识点：建完 store 会自动选中它，这里随之进入对话 */
  const createFirstNode = async () => {
    const title = firstNodeDraft.trim();
    if (!title) return;
    setFirstNodeDraft("");
    await workspaceApi().createNode(title);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || running) return;
    void sendMessage(text);
  };

  const copyMessage = async (message: ChatMessage) => {
    try {
      await copyText(message.content);
      workspaceApi().notify("success", "回答已复制到剪贴板");
    } catch (err) {
      workspaceApi().notify("error", `复制失败：${messageOf(err)}`);
    }
  };

  /** 代码块右上角的「复制」：只复制那段代码，不是整条回答 */
  const copyCode = async (code: string) => {
    try {
      await copyText(code);
      workspaceApi().notify("success", "代码已复制到剪贴板");
    } catch (err) {
      workspaceApi().notify("error", `复制失败：${messageOf(err)}`);
    }
  };

  const recordQuestion = async (message: ChatMessage) => {
    if (!node) return;
    try {
      /*
       * 疑问记在节点上（一个节点一条待解决疑问），并带上这条消息的 ID——
       * 「回到原处」靠的就是它；只记滚动偏移的话，消息一多就找不回去了。
       */
      await chatApi().saveBookmark({
        nodeId: node.id,
        threadId: message.threadId,
        messageId: message.id,
        scrollOffset: 0,
        question: "对这段回答还有疑问",
      });
      workspaceApi().notify("info", "已记为待解决疑问，可以在「详情」里回到这条回答");
    } catch (err) {
      workspaceApi().notify("error", `记录疑问失败：${messageOf(err)}`);
    }
  };

  const mockAi = !hasRealAi();

  return (
    <section className="conversation-pane" data-pane="chat" aria-label="对话工作区">
      <NodeContextBar />

      {scanState === "scanning" && (
        <div className="chat-banner info" role="status">
          <Icon name="refresh" />
          <span>正在扫描知识库：列表与图谱会在扫描结束后对齐磁盘现状。</span>
        </div>
      )}

      <div className="conversation-body">
        {/* 侧边栏（对话 / 脉络 两个页签）：对话工作区里它是一列，不遮正文 */}
        <SidePanel />

        <div className="conversation-main">
          {!node ? (
            /*
             * 空库/未选中：**这里必须能直接开始**。
             *
             * 没有「学习目标」这种入口之后，第一个知识点不能再靠「新建目标」产生；
             * 让用户先学会「打开抽屉 → 找到新建」是把门槛放在了错误的地方。
             * 所以空态本身就是那个入口：写下一个想搞懂的问题，回车即可。
             */
            <div className="chat-empty">
              <div className="empty-mark">
                <Icon name="panel" />
              </div>
              <h3>从一个问题开始</h3>
              <p>
                写下一个你想搞懂的问题，它就是一个知识点——一个普通文件夹。
                <br />
                以后每个知识点都是这样长出来的，彼此之间没有地位差别。
              </p>
              <div className="field first-node">
                <input
                  ref={firstNodeRef}
                  value={firstNodeDraft}
                  data-first-node
                  aria-label="第一个知识点"
                  placeholder="例如：反向传播"
                  spellCheck={false}
                  disabled={!writable}
                  onChange={(e) => setFirstNodeDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return;
                    if (e.key === "Enter") void createFirstNode();
                  }}
                />
                <button
                  type="button"
                  className="btn primary"
                  data-first-node-create
                  disabled={!writable || firstNodeDraft.trim() === ""}
                  onClick={() => void createFirstNode()}
                >
                  新建知识点
                </button>
              </div>
              <div className="prompt-chips">
                <button type="button" onClick={() => commands.setMode("graph")}>
                  打开图谱挑一个节点
                </button>
                <button type="button" onClick={() => commands.focusSearch()}>
                  搜索已有知识点
                </button>
              </div>
            </div>
          ) : (
            <>
              {mockAi && (
                <div className="chat-banner info" role="status">
                  <Icon name="info" />
                  <span>
                    浏览器开发模式：回答来自内置的模拟服务，用于验证交互流程。真实对话请在桌面版中使用。
                  </span>
                </div>
              )}
              {!mockAi && !configured && (
                <div className="chat-banner warn" role="status">
                  <Icon name="alert" />
                  <span>还没有配置 DeepSeek API Key，无法真正发起对话。</span>
                  <button type="button" className="btn btn-sm" onClick={commands.openAiSettings}>
                    去设置
                  </button>
                </div>
              )}
              {error && (
                <div className="chat-banner warn" role="alert">
                  <Icon name="alert" />
                  <span>{error}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => chatApi().setError(null)}
                  >
                    知道了
                  </button>
                </div>
              )}
              {messagesLoading && messages.length === 0 && (
                <div className="chat-banner info" role="status">
                  <Icon name="refresh" />
                  <span>正在载入这个对话的消息…</span>
                </div>
              )}

              <div className="conversation-reader" ref={scrollRef} onScroll={onScroll}>
                <div className="conversation-column" ref={columnRef}>
                  <ChatMessages
                    nodeId={node.id}
                    nodeTitle={node.title}
                    threadId={activeThread?.id ?? null}
                    messages={messages}
                    activeMessageId={activeMessageId}
                    listRef={listRef}
                    onPrompt={(text) => {
                      setDraftValue(text);
                      inputRef.current?.focus();
                    }}
                    onCopy={(m) => void copyMessage(m)}
                    onCopyCode={(code) => void copyCode(code)}
                    onRecordQuestion={(m) => void recordQuestion(m)}
                    onRetry={(m) => void chatApi().retry(node.id, m.id)}
                    activity={activity}
                  />
                </div>
              </div>

              <div className="conversation-composer">
                <div className="conversation-column">
                  <ChatComposer
                    value={draft}
                    onChange={setDraftValue}
                    onSend={submit}
                    onStop={() => activeThread && void chatApi().stop(activeThread.id)}
                    running={running}
                    disabled={!writable}
                    modelLabel={mockAi ? `${aiLabel} · 浏览器模拟` : aiLabel}
                    placeholder={
                      writable ? "关于这个知识点，你想知道什么？" : "只读知识库：对话不会保存，无法发送"
                    }
                    textareaRef={inputRef}
                    activity={activity}
                    contextLabel={
                      contextUsage
                        ? `上下文 ${formatTokens(contextUsage.total)} / ${formatTokens(contextUsage.window)}`
                        : null
                    }
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- 小工具 ------------------------------- */
