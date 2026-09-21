/**
 * 对话状态（v2：节点 / 线程级懒加载）
 *
 * 刻意与知识图的 store 分开：
 * - 流式生成会高频更新消息内容，若与图的快照放在一起，每个字都会触发画布重渲染；
 * - 对话写入不触发整张图重新载入。
 *
 * v2 的加载模型（契约 §5.6、设计 §8.3）：
 * ```text
 * openNode(nodeId)      只读该节点的 thread.json（线程头）+ bookmarks.json
 * selectThread(threadId) 才读该线程的 messages/*.json（正文）
 * ```
 * 一条消息一个文件意味着「进入节点」不再需要把全库对话正文读进内存——
 * 100k 条消息的知识库打开时也只读几十个线程头。
 *
 * 两条必须保留的竞态纪律：
 * 1. **请求令牌**：`openNode` / `selectThread` 各自持有令牌，晚到的响应直接丢弃，
 *    否则用户快速点选节点时，先发出的慢响应会覆盖后选中的节点内容；
 * 2. **会话隔离**：切库（sessionId 变化）时取消一切在途生成并清空内存，
 *    旧库晚到的 delta / done / error 一律不许写进新库的界面。
 */
import { create } from "zustand";

import { getAiProvider, hasRealAi, type AiConfig, type ChatTurn } from "@/data/aiProvider";
import { defaultAiConfig } from "@/data/aiProvider";
import type { Repository } from "@/data/repository";
import { getCurrentSession } from "@/data/session";
import { RepositoryError, toRepositoryError } from "@/data/errors";
import { isDefaultThreadTitle, titleFromQuestion } from "@/data/threadTitle";
import { newUuid } from "@/data/uuid";
import type { Bookmark, ChatMessage, ChatThread } from "@/data/chatTypes";
import type { Evidence } from "@/data/types";
import { prerequisitesOf } from "@/data/engine";
import type { GraphSnapshot } from "@/data/types";

/**
 * 与工作台 store 的接缝。
 *
 * 对话这一层需要知道两件只有工作台 store 才知道的事：**当前知识库是不是只读**、
 * 以及**当前的图**（拼上下文时要挑出直接前置）。直接 `import { useStore }`
 * 会形成 `store ↔ chatStore` 的循环依赖——打包器会因此把 `store.ts` 里的
 * 动态 `import()` 判定为「无法单独分包」，两边的模块初始化顺序也变得脆弱。
 *
 * 因此这里只留一个小小的注入点，由 `store.ts` 在模块初始化时接上；
 * 默认实现是「非只读 + 空图」，即使某个测试单独加载它也不会炸，
 * 只是拼不出前置知识而已。
 */
export interface ChatHost {
  isReadonly(): boolean;
  graph(): GraphSnapshot;
}

const EMPTY_GRAPH: GraphSnapshot = { nodes: [], edges: [], goals: [], session: null, revision: 0 };

let host: ChatHost = { isReadonly: () => false, graph: () => EMPTY_GRAPH };

/** 由 `store.ts` 调用一次；重复调用以最后一次为准（热更新时也安全） */
export function bindChatHost(next: ChatHost): void {
  host = next;
}

const MAX_CONTEXT_MESSAGES = 20;

/**
 * 按 ID 去重，保留最后一条。
 *
 * 为什么需要：ID 取号与「正在生成」的占位集合都是模块级状态。
 * 开发模式下 Vite 热更新会重新求值模块，而此时旧实例仍被组件引用，
 * 于是出现两个模块实例：各自持有计数器和守卫，却写同一份状态，
 * 结果同一条消息被追加两次（ID 相同、内容重复）。
 *
 * 与其依赖「只可能有一个实例」，不如让写入本身幂等——
 * 这样无论被调用几次、由谁调用，状态都收敛到正确结果。
 */
function dedupeById(messages: ChatMessage[]): ChatMessage[] {
  const lastIndex = new Map<string, number>();
  messages.forEach((m, i) => lastIndex.set(m.id, i));
  if (lastIndex.size === messages.length) return messages;
  return messages.filter((m, i) => lastIndex.get(m.id) === i);
}

/** 幂等追加：已存在的 ID 不再重复追加 */
function appendMessages(existing: ChatMessage[], ...added: ChatMessage[]): ChatMessage[] {
  const known = new Set(existing.map((m) => m.id));
  const fresh = added.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return dedupeById(existing);
  return dedupeById([...existing, ...fresh]);
}

interface ChatState {
  /** 当前对话所属的节点：null 表示没有进入任何节点 */
  nodeId: string | null;
  loading: boolean;
  /** 当前节点的线程头是否已就绪 */
  ready: boolean;
  /** 只含当前节点的线程头 */
  threads: ChatThread[];
  activeThreadId: string | null;
  /** 只含当前线程的消息 */
  messages: ChatMessage[];
  messagesLoading: boolean;
  /** 当前节点的书签 */
  bookmarks: Bookmark[];
  /**
   * 每个线程当前的活动请求（正在生成的那一条）。
   *
   * 从请求启动一直保留到真正终止（完成 / 失败 / 用户停止），而不是
   * 「provider.stream() 返回」——那只代表网络任务已经发出，生成还在继续。
   */
  activeRequests: Record<string, ActiveRequestInfo>;
  /** 打开某个对话时要恢复到的阅读位置（书签/来源定位用） */
  pendingScroll: ScrollRequest | null;
  error: string | null;
  aiLabel: string;
  configured: boolean;
  /** 已记下的来源（按 `fromNodeId:edgeId` 分组），只作为界面缓存 */
  evidence: Record<string, Evidence[]>;

  /** 进入节点：只拉线程头 + 书签，不拉消息正文 */
  openNode(nodeId: string | null): Promise<void>;
  /** 选中线程：懒加载该线程消息 */
  selectThread(threadId: string | null): Promise<void>;
  createThread(nodeId: string, title?: string): Promise<ChatThread>;
  deleteThread(threadId: string): Promise<void>;
  renameThread(threadId: string, title: string): Promise<void>;
  send(nodeId: string, text: string): Promise<void>;
  stop(threadId: string): void;
  retry(nodeId: string, messageId: string): Promise<void>;
  saveBookmark(input: {
    nodeId: string;
    threadId: string;
    messageId: string;
    scrollOffset: number;
    question: string;
    returnNodeId?: string | null;
  }): Promise<void>;
  deleteBookmark(bookmarkId: string): Promise<void>;
  /** 选中文字 → 来源记录，写进该关系所在的 relations.json */
  addEvidence(input: {
    fromNodeId: string;
    edgeId: string;
    threadId: string | null;
    messageId: string | null;
    snippet: string;
    question: string;
  }): Promise<void>;
  clearScrollRequest(): void;
  /** 切库/关库时清空并解除异步绑定 */
  reset(): void;

  /* --------------------- 以下为界面便利方法（附加，不改契约） --------------------- */

  /** 某条边已记下的来源（顺序即记录顺序） */
  evidenceForEdge(fromNodeId: string, edgeId: string): Evidence[];
  refreshConfigured(): Promise<void>;
  saveConfig(config: AiConfig): Promise<void>;
  saveApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
  setThinking(thinking: boolean): Promise<void>;
  requestScroll(request: Omit<ScrollRequest, "nonce">): void;
  bookmarkFor(nodeId: string): Bookmark | undefined;
  /** 当前线程的消息（懒加载下 `messages` 只含当前线程） */
  messagesForThread(threadId: string): ChatMessage[];
  threadsForNode(nodeId: string): ChatThread[];
}

/** 对外暴露的活动请求信息（内部还带终止标记） */
interface ActiveRequestInfo {
  messageId: string;
  /** 请求 ID 要等 invoke 返回才拿到，之前为 null */
  requestId: string | null;
}

interface ActiveRequest extends ActiveRequestInfo {
  threadId: string;
  /** 已经终止（完成/失败/被停止）：晚到的事件一律忽略 */
  done: boolean;
}

/** 一次「打开对话并回到原处」的请求 */
export interface ScrollRequest {
  threadId: string;
  offset: number;
  messageId: string | null;
  /** 每次请求都不同，重复点击同一个按钮也能再次触发 */
  nonce: number;
}

/**
 * 新对话 / 新消息的 ID。
 *
 * 知识库里的实体 ID 由 Rust 发号（UUIDv7）；对话实体是前端先造出来再落盘的
 * （流式生成时消息还不存在于磁盘上），所以这里生成同样形状的 UUIDv7 字符串，
 * 两种后端都能接受，也不会出现「m1」这类顺序 ID 混进正式知识库。
 */
function makeId(): string {
  return newUuid();
}

export const useChatStore = create<ChatState>((set, get) => {
  /**
   * 取当前会话的 Repository。
   *
   * 每次调用都重新取：切库之后必须用新库的那一个，缓存下来的旧引用
   * 会抛出 session_closed，那时候再换就晚了。
   */
  function repoOrThrow(): Repository {
    const session = getCurrentSession();
    const repository = session && session.valid ? session.repository : null;
    if (!repository) throw new RepositoryError("not_open", "还没有打开知识库");
    return repository;
  }

  /** 当前会话不可用时，对话载入/发送直接拒绝，而不是去读一个已关闭的库 */
  function currentSessionId(): string | null {
    const session = getCurrentSession();
    return session && session.valid ? session.sessionId : null;
  }

  /* ---------------------------- 自动为对话起标题 ---------------------------- */

  /**
   * 已经问过 AI 要标题的对话（无论成功与否）。
   *
   * 放在模块级是因为热更新会重建 store：重复试一次只是多一次请求，无害；
   * 反过来漏掉一次的代价是「这个对话永远没有名字」。
   * 但对于「AI 明确说没有」的情况，同一个线程只问一次，避免每次回答都打一次 API。
   */
  const titleRequested = new Set<string>();

  /**
   * 「我们自己起的临时名字」：threadId → 名字。
   *
   * 发第一条消息时会立刻用一个由问题收敛出来的名字命名对话；等回答结束，
   * 再让模型给一个更好的。**只有当当前名字仍然等于我们设的那个临时名字时**才允许覆盖——
   * 也就是说用户中途自己改了名，那次优化主动让路（判据比「不是默认名」精确得多）。
   */
  const provisionalTitles = new Map<string, string>();

  /**
   * 发第一条消息时立刻给对话起名。
   *
   * 不依赖 AI：没配 Key、断网、模型抽风都不该让对话一直叫「新对话」。
   * 名字由用户自己那句话收敛而来，因此**永远是有意义的**；
   * 模型只是稍后把它润色得更好。
   */
  async function nameThreadFromQuestion(threadId: string, question: string): Promise<void> {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || !isDefaultThreadTitle(thread.title)) return;
    const title = titleFromQuestion(question);
    if (!title) return;
    provisionalTitles.set(threadId, title);
    try {
      await get().renameThread(threadId, title);
    } catch {
      // 起名失败不影响对话本身：保持默认名即可
    }
  }



  /**
   * 回答结束后，让模型把对话名字润色一遍。
   *
   * 三条自我约束：
   * 1. **只在第一轮回答之后**试一次——这时才有一问一答可以概括；
   * 2. **只覆盖我们自己起的临时名字**：用户中途改过名就主动让路
   *    （比「名字不是默认值」精确——那时名字早就不是默认值了）；
   * 3. **失败静默**：没配 Key、网络不通、模型没给出可用的一行字，都保持已有的名字，
   *    不弹错、不刷日志——它是锦上添花，不是功能路径。
   */
  async function autoTitleThread(threadId: string, sessionId: string): Promise<void> {
    if (titleRequested.has(threadId)) return;
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;
    // 名字不是我们起的那个（用户自己改过 / 别的路径改过）就别动它
    if (provisionalTitles.get(threadId) !== thread.title) return;
    if (get().messages.filter((m) => m.threadId === threadId).length > 2) return;

    titleRequested.add(threadId);
    let suggested: string | null = null;
    try {
      suggested = await repoOrThrow().suggestThreadTitle(threadId);
    } catch {
      return;
    }
    // 起名的这段时间里可能已经切库 / 用户自己改了名
    if (!suggested || currentSessionId() !== sessionId) return;
    const latest = get().threads.find((t) => t.id === threadId);
    if (!latest || provisionalTitles.get(threadId) !== latest.title) return;
    try {
      await get().renameThread(threadId, suggested);
    } catch {
      // 命名失败不影响对话本身：保持原名即可
    }
  }

  /**
   * 节点/线程级请求令牌。
   *
   * 每次 `openNode` / `selectThread` 递增：响应回来时令牌不是最新的就丢弃。
   * 没有它，快速点选节点会让先发出的慢响应覆盖后选中的内容。
   */
  let nodeToken = 0;
  let threadToken = 0;
  /** 已经加载完成的节点会话，避免同一节点重复读盘 */
  let loadedKey: string | null = null;

  /**
   * 读当前节点的笔记正文，作为提问上下文的一部分。
   *
   * 读不到（节点还没有正文、会话已关闭）就当作没有笔记：
   * 附带信息缺失不该让提问本身失败。
   */
  async function readNodeNote(nodeId: string): Promise<string> {
    try {
      return (await repoOrThrow().readNote(nodeId)).content;
    } catch {
      return "";
    }
  }

  /**
   * 每个对话的活动请求。
   *
   * 必须在发出请求前**同步**占位：流式请求要等 invoke 返回才拿到 requestId，
   * 在那之前状态里没有任何「生成中」标记，再次点击发送会插入重复消息。
   *
   * 占位一直保留到请求真正终止（done / error / 用户停止）。
   */
  const activeByThread = new Map<string, ActiveRequest>();

  function publishActive() {
    const next: Record<string, ActiveRequestInfo> = {};
    for (const [threadId, req] of activeByThread) {
      next[threadId] = { messageId: req.messageId, requestId: req.requestId };
    }
    set({ activeRequests: next });
  }

  /**
   * 终止一个请求。返回 false 表示它已经终止过了——
   * 此时晚到的 delta / done / error 必须被丢弃，不能让终止状态被逆转。
   */
  function terminate(token: ActiveRequest): boolean {
    if (token.done) return false;
    token.done = true;
    if (activeByThread.get(token.threadId) === token) {
      activeByThread.delete(token.threadId);
    }
    publishActive();
    return true;
  }

  /** 这个 token 是否仍是当前对话的活动请求（被新请求取代后就不再处理它的回调） */
  function isCurrent(token: ActiveRequest): boolean {
    return !token.done && activeByThread.get(token.threadId) === token;
  }

  /** 取消全部在途生成：切库、重新载入节点、reset 时调用 */
  function cancelAll(): void {
    const stale = [...activeByThread.values()];
    activeByThread.clear();
    for (const token of stale) {
      token.done = true;
      if (token.requestId) void getAiProvider().cancel(token.requestId).catch(() => undefined);
    }
    publishActive();
  }

  /**
   * 落盘失败的兜底。
   *
   * 回答平时只存在内存里（增量不落盘），完整内容是在结束时才写一次。
   * 这次写入如果被静默吞掉，界面显示的是完整回答、盘上却停在空白的 streaming：
   * 重启后内容凭空消失，而且没有任何提示。所以写失败必须让人看见。
   */
  function saveOrReport(what: string, action: () => Promise<void>) {
    void action().catch((err) => {
      const code = err instanceof RepositoryError ? err.code : toRepositoryError(err).code;
      // 会话已经结束：这条内容属于上一个知识库，报错只会误导人
      if (code === "session_closed" || code === "not_open") return;
      const message = describeChatError(err);
      console.error(`[KnowledgeNet] ${what}写入失败`, err);
      set({ error: `${what}没有保存成功：${message}。内容还在窗口里，建议先复制下来。` });
    });
  }

  function upsertMessageLocal(message: ChatMessage) {
    set((s) => {
      const next = s.messages.slice();
      const i = next.findIndex((m) => m.id === message.id);
      if (i < 0) next.push(message);
      else next[i] = message;
      return { messages: dedupeById(next) };
    });
  }

  /**
   * 组装上下文历史。
   *
   * 必须排除本次新增的用户消息与助手占位，并**截到上一条助手回答为止**：
   * 末尾的用户消息就是「本次的问题」，由 assembleTurns 追加一次。
   * 否则首次请求就会出现两个连续的相同 user turn，重试还会不断累积。
   */
  function contextHistory(threadId: string, assistantId: string, userId: string): ChatMessage[] {
    const usable = get()
      .messagesForThread(threadId)
      .filter((m) => m.id !== assistantId && m.id !== userId && m.status !== "failed");
    const lastAssistant = usable.map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistant < 0) return [];
    return usable.slice(0, lastAssistant + 1).slice(-MAX_CONTEXT_MESSAGES);
  }

  /** 列出某个节点的线程头（切节点时使用；失败返回空列表并报错） */
  async function fetchThreads(nodeId: string): Promise<ChatThread[]> {
    return repoOrThrow().listThreads(nodeId);
  }

  async function fetchBookmarks(nodeId: string): Promise<Bookmark[]> {
    try {
      return await repoOrThrow().listBookmarks(nodeId);
    } catch {
      // 书签是便利功能：读不到不该让整个节点打不开
      return [];
    }
  }

  /** 真正执行一次提问与生成 */
  async function runSend(
    nodeId: string,
    threadId: string,
    question: string,
    /** 重试时复用原来那条用户消息，不再新增一条内容相同的提问 */
    reuseUserMessage?: ChatMessage,
  ): Promise<void> {
    const now = Date.now();
    const userMessage: ChatMessage =
      reuseUserMessage ?? {
        id: makeId(),
        threadId,
        role: "user",
        content: question,
        status: "complete",
        createdAt: now,
      };
    const assistantMessage: ChatMessage = {
      id: makeId(),
      threadId,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: now + 1,
    };

    const token: ActiveRequest = {
      threadId,
      messageId: assistantMessage.id,
      requestId: null,
      done: false,
    };
    activeByThread.set(threadId, token);
    publishActive();

    // 记录这次写入属于哪个库：切库之后旧回调不许再写状态
    const sessionId = currentSessionId();

    try {
      if (!reuseUserMessage) await repoOrThrow().saveMessage(userMessage);
      await repoOrThrow().saveMessage(assistantMessage);
      if (currentSessionId() !== sessionId) {
        terminate(token);
        return;
      }
      set((s) => ({
        messages: appendMessages(
          s.messages,
          ...(reuseUserMessage ? [] : [userMessage]),
          assistantMessage,
        ),
        error: null,
      }));

      const turns = assembleTurns(
        nodeId,
        contextHistory(threadId, assistantMessage.id, userMessage.id),
        question,
        await readNodeNote(nodeId),
      );

      const requestId = await getAiProvider().stream(turns, await loadConfig(), {
        onDelta: (text) => {
          // 只处理仍然属于当前活动请求、且仍属于当前知识库的片段
          if (!isCurrent(token) || currentSessionId() !== sessionId) return;
          const current = get().messages.find((m) => m.id === assistantMessage.id);
          if (!current || current.status !== "streaming") return;
          upsertMessageLocal({ ...current, content: current.content + text });
        },
        onDone: (info) => {
          if (currentSessionId() !== sessionId) {
            terminate(token);
            return;
          }
          if (!terminate(token)) return;
          const current = get().messages.find((m) => m.id === assistantMessage.id);
          if (current) {
            /*
             * 上游断开、没有收到结束标记的回答不能算「完整」：
             * 半截内容会被当成最终答案，用户不会再追问也不会重试。
             */
            const finished: ChatMessage = {
              ...current,
              status: info.completed ? "complete" : "incomplete",
              finishReason: info.finishReason ?? null,
              requestId: token.requestId,
              usage: info.usage ? JSON.stringify(info.usage) : null,
            };
            upsertMessageLocal(finished);
            saveOrReport("这条回答", () => repoOrThrow().saveMessage(finished));
            // 达到输出上限被截断时必须说清楚，否则半截回答会被当成完整内容
            if (info.finishReason === "length") {
              set({
                error:
                  "回答达到输出长度上限被截断。可在设置里把「单次回答长度上限」调大或留空（交给服务端），也可以让它分段继续讲。",
              });
            } else if (!info.completed) {
              set({ error: "回答没有正常结束（连接可能中断），以上内容可能不完整。" });
            }
          }
          const thread = get().threads.find((t) => t.id === threadId);
          if (thread) {
            const nextThread = { ...thread, updatedAt: Date.now() };
            set((s) => ({
              threads: s.threads.map((t) => (t.id === threadId ? nextThread : t)),
            }));
            saveOrReport("对话更新时间", () => repoOrThrow().saveThread(nextThread));
            // 第一轮问答齐了、名字还是默认的：让 AI 起一个能认出来的名字
            const ownedSession = currentSessionId();
            if (ownedSession) void autoTitleThread(threadId, ownedSession);
          }
        },
        onError: (message) => {
          if (currentSessionId() !== sessionId) {
            terminate(token);
            return;
          }
          if (!terminate(token)) return;
          const current = get().messages.find((m) => m.id === assistantMessage.id);
          if (current) {
            // 失败的回答不能标记为完整；保留已生成的片段便于排查
            const failed: ChatMessage = { ...current, status: "failed" };
            upsertMessageLocal(failed);
            saveOrReport("失败状态", () => repoOrThrow().saveMessage(failed));
          }
          set({ error: message });
        },
      });

      /*
       * 事件可能先于 invoke 返回到达（本地模拟、立即失败）。此时 token 已经
       * 终止，再把 requestId 写回状态就会出现「消息已完成却仍显示生成中」。
       * 同时要把这个已经无人认领的请求取消掉，避免它继续消耗网络。
       */
      if (!isCurrent(token)) {
        await getAiProvider().cancel(requestId);
        return;
      }
      token.requestId = requestId;
      publishActive();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (terminate(token) && currentSessionId() === sessionId) {
        const current = get().messages.find((m) => m.id === assistantMessage.id);
        if (current) {
          const failed: ChatMessage = { ...current, status: "failed" };
          upsertMessageLocal(failed);
          await repoOrThrow().saveMessage(failed);
        }
      }
      if (currentSessionId() === sessionId) set({ error: message });
    }
  }

  return {
    nodeId: null,
    loading: false,
    ready: false,
    threads: [],
    activeThreadId: null,
    messages: [],
    messagesLoading: false,
    bookmarks: [],
    activeRequests: {},
    pendingScroll: null,
    error: null,
    aiLabel: getAiProvider().label,
    configured: false,
    evidence: {},

    /**
     * 进入节点：只读线程头与书签。
     *
     * 消息正文只属于「当前线程」，由 `selectThread` 懒加载——这样切换节点
     * 不会把上一条长对话的正文带进来，也不会为了显示线程下拉去读全库正文。
     */
    async openNode(nodeId) {
      const sessionId = currentSessionId();
      const token = ++nodeToken;
      // 线程级令牌也要推进：节点都换了，之前那次 selectThread 的响应不再有效
      threadToken += 1;
      if (!sessionId) {
        // 没有打开知识库：不加载、不发送，也不显示上一次库的对话
        set({
          nodeId: null,
          threads: [],
          messages: [],
          bookmarks: [],
          activeThreadId: null,
          ready: false,
          loading: false,
          messagesLoading: false,
          error: null,
        });
        loadedKey = null;
        return;
      }
      if (!nodeId) {
        loadedKey = null;
        set({
          nodeId: null,
          threads: [],
          messages: [],
          bookmarks: [],
          activeThreadId: null,
          ready: false,
          loading: false,
          messagesLoading: false,
        });
        return;
      }
      const key = `${sessionId}:${nodeId}`;
      if (loadedKey === key && get().ready) return;

      set({ loading: true, error: null, nodeId });
      try {
        const [threads, bookmarks] = await Promise.all([
          fetchThreads(nodeId),
          fetchBookmarks(nodeId),
        ]);
        // 期间用户又切了节点 / 切了库：这份响应已经不属于当前界面
        if (token !== nodeToken || currentSessionId() !== sessionId) return;
        const previousActive = get().activeThreadId;
        const active =
          previousActive && threads.some((t) => t.id === previousActive)
            ? previousActive
            : (threads[0]?.id ?? null);
        loadedKey = key;
        set({
          nodeId,
          threads,
          bookmarks,
          activeThreadId: active,
          messages: [],
          loading: false,
          ready: true,
          messagesLoading: active !== null,
        });
        if (active) await get().selectThread(active);
        else set({ messagesLoading: false });
      } catch (err) {
        if (token !== nodeToken || currentSessionId() !== sessionId) return;
        const message = describeChatError(err);
        console.error("[KnowledgeNet] 载入节点对话失败", err);
        set({
          nodeId,
          threads: [],
          messages: [],
          bookmarks: [],
          activeThreadId: null,
          loading: false,
          ready: true,
          messagesLoading: false,
          error: message,
        });
      }
      await get().refreshConfigured();
    },

    /** 选中线程并懒加载它的消息 */
    async selectThread(threadId) {
      const sessionId = currentSessionId();
      const token = ++threadToken;
      /*
       * 重新选中线程意味着「以磁盘上的那份为准」：这条线程正在生成的回答
       * 已经与磁盘内容分叉，必须先真的取消掉，否则它会继续消耗额度，
       * 而回调写入的那条消息已经不在界面上了。
       */
      if (threadId) {
        const active = activeByThread.get(threadId);
        if (active) {
          terminate(active);
          if (active.requestId) {
            void getAiProvider().cancel(active.requestId).catch(() => undefined);
          }
        }
      }
      set({ activeThreadId: threadId, messages: [], pendingScroll: null });
      if (!threadId) {
        set({ messages: [], messagesLoading: false });
        return;
      }
      if (!sessionId) return;
      set({ messagesLoading: true });
      try {
        const loaded = await repoOrThrow().loadThread(threadId);
        if (token !== threadToken || currentSessionId() !== sessionId) return;
        set({
          messages: dedupeById(loaded.messages),
          threads: get().threads.map((t) => (t.id === threadId ? loaded.thread : t)),
          messagesLoading: false,
          error: null,
        });
      } catch (err) {
        if (token !== threadToken || currentSessionId() !== sessionId) return;
        const message = describeChatError(err);
        console.error("[KnowledgeNet] 载入对话失败", err);
        set({ messages: [], messagesLoading: false, error: message });
      }
    },

    /* ------------------------------ 对话管理 ------------------------------ */

    async createThread(nodeId, title) {
      const thread = await repoOrThrow().createThread(nodeId, title);
      set((s) => ({
        nodeId,
        threads: [thread, ...s.threads.filter((t) => t.id !== thread.id)],
        activeThreadId: thread.id,
        messages: [],
        ready: true,
        messagesLoading: false,
      }));
      loadedKey = `${currentSessionId() ?? ""}:${nodeId}`;
      return thread;
    },

    async deleteThread(threadId) {
      // 正在生成的对话被删除时，先把它的在途请求掐掉
      const token = activeByThread.get(threadId);
      if (token) terminate(token);
      try {
        await repoOrThrow().deleteThread(threadId);
      } catch (err) {
        set({ error: `删除对话失败：${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      set((s) => ({
        threads: s.threads.filter((t) => t.id !== threadId),
        messages: s.activeThreadId === threadId ? [] : s.messages,
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      }));
    },

    async renameThread(threadId, title) {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const next = { ...thread, title: title.trim() || thread.title, updatedAt: Date.now() };
      try {
        await repoOrThrow().saveThread(next);
      } catch (err) {
        // 失败要报出来，否则界面上标题看起来变了、盘上其实没变
        set({ error: `重命名对话失败：${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      set((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? next : t)) }));
    },

    /* ------------------------------ 生成流程 ------------------------------ */

    async send(nodeId, question) {
      const clean = question.trim();
      if (!clean) return;

      // 没有打开知识库就没有可以落盘的地方：不发送，也不产生一条假消息
      if (!currentSessionId()) {
        set({ error: "还没有打开知识库：打开一个知识库后才能提问。" });
        return;
      }
      if (host.isReadonly()) {
        set({ error: "这是只读知识库：可以查看，但对话不会保存，因此不允许发送。" });
        return;
      }

      // 进入节点后对话面板就一直可用：没有线程时自动建一个，而不是让用户先点「新建对话」
      if (get().nodeId !== nodeId) await get().openNode(nodeId);
      let threadId = get().activeThreadId;
      if (!threadId) {
        const created = await get().createThread(nodeId);
        threadId = created.id;
      }
      // 互斥守卫持有到生成真正终止，而不是 invoke 返回
      if (activeByThread.has(threadId)) {
        set({ error: "这个对话还在生成回答，先停止它或等它结束" });
        return;
      }
      // 第一条消息顺手把对话命名：不依赖 AI，先保证它有个能认出来的名字
      await nameThreadFromQuestion(threadId, clean);
      await runSend(nodeId, threadId, clean);
    },

    stop(threadId) {
      const token = activeByThread.get(threadId);
      const requestId = token?.requestId ?? null;
      /*
       * 先终止状态，再取消网络任务：已经在途的 delta / done 回调
       * 不能在停止之后继续追加内容，也不能把「已停止」改回「完成」。
       */
      if (token) terminate(token);
      if (requestId) void getAiProvider().cancel(requestId).catch(() => undefined);

      // 停止后保留已生成的部分，并明确标记为「已停止」
      const draft =
        get().messages.find((m) => m.id === token?.messageId) ??
        get()
          .messagesForThread(threadId)
          .filter((m) => m.status === "streaming")
          .pop();
      if (draft && draft.status === "streaming") {
        const stopped: ChatMessage = { ...draft, status: "cancelled" };
        upsertMessageLocal(stopped);
        saveOrReport("停止状态", () => repoOrThrow().saveMessage(stopped));
      }
    },

    async retry(nodeId, messageId) {
      const failed = get().messages.find((m) => m.id === messageId);
      if (!failed || failed.role !== "assistant") return;
      if (activeByThread.has(failed.threadId)) {
        set({ error: "这个对话还在生成回答，先停止再重试" });
        return;
      }

      // 用这条回答之前的最后一条用户消息重新提问。
      // 重试产生新的回答，不会把内容拼接到失败的回答后面。
      const threadMessages = get().messagesForThread(failed.threadId);
      const index = threadMessages.findIndex((m) => m.id === messageId);
      const previousUser = [...threadMessages.slice(0, index)]
        .reverse()
        .find((m) => m.role === "user");
      if (!previousUser) return;

      await repoOrThrow().deleteMessage(failed.id);
      set((s) => ({ messages: s.messages.filter((m) => m.id !== failed.id) }));
      // 复用原来那条提问，重试不再往对话里堆一条内容相同的用户消息
      await runSend(nodeId, failed.threadId, previousUser.content, previousUser);
    },

    /* ------------------------------ 来源与书签 ------------------------------ */

    async addEvidence(input) {
      const saved = await repoOrThrow().addEvidence(input.fromNodeId, input.edgeId, {
        threadId: input.threadId,
        messageId: input.messageId,
        snippet: input.snippet,
        question: input.question,
      });
      const key = `${input.fromNodeId}:${input.edgeId}`;
      set((s) => ({ evidence: { ...s.evidence, [key]: [...(s.evidence[key] ?? []), saved] } }));
    },

    evidenceForEdge(fromNodeId, edgeId) {
      return get().evidence[`${fromNodeId}:${edgeId}`] ?? [];
    },

    async saveBookmark(input) {
      const now = Date.now();
      const existing = get().bookmarks.find((b) => b.nodeId === input.nodeId);
      const bookmark: Bookmark = {
        id: existing?.id ?? makeId(),
        nodeId: input.nodeId,
        threadId: input.threadId ?? existing?.threadId ?? null,
        messageId: input.messageId ?? existing?.messageId ?? null,
        scrollOffset: input.scrollOffset ?? existing?.scrollOffset ?? 0,
        question: input.question ?? existing?.question ?? "",
        returnNodeId: input.returnNodeId ?? existing?.returnNodeId ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await repoOrThrow().saveBookmark(bookmark);
      set((s) => ({
        bookmarks: [...s.bookmarks.filter((b) => b.id !== bookmark.id), bookmark],
      }));
    },

    bookmarkFor(nodeId) {
      return get().bookmarks.find((b) => b.nodeId === nodeId);
    },

    async deleteBookmark(bookmarkId) {
      await repoOrThrow().deleteBookmark(bookmarkId);
      set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== bookmarkId) }));
    },

    requestScroll(request) {
      set({ pendingScroll: { ...request, nonce: Date.now() + Math.random() } });
    },

    clearScrollRequest() {
      set({ pendingScroll: null });
    },

    /**
     * 切库/关库：取消进行中的生成并清空全部对话内存。
     *
     * 不能只清空列表——旧库那次生成还在消耗额度，它的回调会把内容写进
     * 已经不存在的状态里。所以先真的取消请求，再清空。
     */
    reset() {
      cancelAll();
      nodeToken += 1;
      threadToken += 1;
      loadedKey = null;
      set({
        nodeId: null,
        loading: false,
        ready: false,
        threads: [],
        activeThreadId: null,
        messages: [],
        messagesLoading: false,
        bookmarks: [],
        activeRequests: {},
        pendingScroll: null,
        error: null,
        evidence: {},
      });
    },

    /* -------------------------------- 设置 -------------------------------- */

    async refreshConfigured() {
      try {
        set({ configured: await getAiProvider().isConfigured() });
      } catch {
        set({ configured: false });
      }
    },

    async saveConfig(config) {
      await getAiProvider().saveConfig(config);
      await get().refreshConfigured();
    },

    async saveApiKey(key) {
      await getAiProvider().saveApiKey(key);
      await get().refreshConfigured();
    },

    async clearApiKey() {
      await getAiProvider().clearApiKey();
      await get().refreshConfigured();
    },

    async setThinking(thinking) {
      const provider = getAiProvider();
      // 先读回当前配置再改一项：组件不应该持有整份配置的副本
      const settings = await provider.loadSettings();
      await provider.saveConfig({ ...settings.config, thinking });
    },

    /* -------------------------------- 查询 -------------------------------- */

    messagesForThread(threadId) {
      return get().messages.filter((m) => m.threadId === threadId);
    },

    threadsForNode(nodeId) {
      return get()
        .threads.filter((t) => t.nodeId === nodeId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
});

async function loadConfig(): Promise<AiConfig> {
  try {
    const settings = await getAiProvider().loadSettings();
    return settings.config;
  } catch {
    return defaultAiConfig();
  }
}

/**
 * 对话域的错误文案。
 *
 * 知识库没打开、会话已关闭都不是「出了故障」，而是「当前没有可以写入的知识库」，
 * 说清楚下一步该做什么，比抛一句原始错误有用。
 */
function describeChatError(err: unknown): string {
  const e = toRepositoryError(err);
  switch (e.code) {
    case "not_open":
      return "还没有打开知识库：打开一个知识库后才能保存对话。";
    case "session_closed":
      return "这个知识库会话已经关闭，对话内容没有保存。";
    case "read_only":
      return "这是只读知识库，不能写入对话。";
    case "node_missing":
      return "节点目录已经不在了：对话属于节点，找不到节点就读不到它。";
    case "metadata_invalid":
    case "metadata_unsupported":
      return "节点的元数据文件有问题，对话暂时读不出来。";
    default:
      return e.message;
  }
}

/**
 * 组装发给 AI 的消息。
 *
 * 只带当前节点、当前对话历史与直接依赖的简短状态；
 * 其它对话、整张图和全部笔记默认不发送——既省 token，也避免引入无关上下文。
 */
function assembleTurns(
  nodeId: string,
  history: ChatMessage[],
  question: string,
  note: string,
): ChatTurn[] {
  const graph = host.graph();
  const node = graph.nodes.find((n) => n.id === nodeId);
  const prereqs = node ? prerequisitesOf(graph, nodeId) : [];

  const lines: string[] = [
    "你是学习助手，帮助使用者理解他正在攻克的知识点。",
    "要求：",
    "- 围绕当前知识点解释，不要发散到无关内容。",
    "- 根据使用者的反馈调整讲解深度。",
    "- 把「理解当前内容所必需的前置知识」和「延伸阅读」明确区分开。",
    "- 一次不要展开太多分支，优先讲清楚主线。",
    "- 不要替使用者判定他已经理解某个知识点。",
    "",
    `当前知识点：${node?.title ?? "（未知）"}`,
  ];

  if (node?.relativePath) lines.push(`它在知识库里的位置：${node.relativePath}`);
  if (prereqs.length > 0) {
    const done = prereqs.filter((p) => p.status === "done").map((p) => p.title);
    const pending = prereqs.filter((p) => p.status !== "done").map((p) => p.title);
    if (pending.length > 0) lines.push(`尚未理解的前置知识：${pending.join("、")}`);
    if (done.length > 0) lines.push(`已标记为理解的前置知识：${done.join("、")}`);
  }
  /*
   * 笔记正文不随节点元数据一起载入（一万个节点时那是全部 Markdown），
   * 提问时按需读当前节点这一份即可。
   */
  if (note.trim()) {
    lines.push("", "使用者为这个知识点记录的笔记：", note.trim());
  }
  lines.push("", "当他表示不理解某个概念时，先解释那个概念，再说明它与当前知识点的关系。");

  const turns: ChatTurn[] = [{ role: "system", content: lines.join("\n") }];
  for (const m of history) {
    if (m.role === "user" || m.role === "assistant") {
      turns.push({ role: m.role, content: m.content });
    }
  }
  if (question) turns.push({ role: "user", content: question });
  return turns;
}

/** 界面上用于提示「这是模拟回答」 */
export function usingMockAi(): boolean {
  return !hasRealAi();
}
