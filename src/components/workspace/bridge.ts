/**
 * 工作台与状态层之间的边界
 *
 * 本目录一律按《v2 冻结契约》§5.3 / §5.5 / §5.6 的公开面调用状态层，不自己发明名字。
 * 之所以还在中间放这一层，有两个具体原因：
 *
 * 1. 契约冻结的名字（`uiStore.mode`、`chatStore.openNode`、`store.removeNodeIdentity`）
 *    与磁盘上正在被替换的旧实现（`load()` / `select()` / `deleteNode()`）会并存一段时间。
 *    这里按「契约名优先、旧名回退」解析，工作台不必跟着状态层的迁移来回改，
 *    组件里也不会散落 `s.removeNodeIdentity ?? s.deleteNode` 这种判断。
 * 2. 每个组件都要读同一批字段。把「哪个字段叫什么、缺省值是什么、v2 新增字段缺席时怎么退化」
 *    集中在这一个文件里，组件里就只剩业务判断。
 *
 * frontend-data 的状态层落地后，本文件的回退分支可以整体删除，组件侧无需改动。
 */
import { useEffect, useMemo, useState } from "react";

import { useChatStore } from "@/chatStore";
import { useStore } from "@/store";
import { useUiStore } from "@/uiStore";
import type { Bookmark, ChatMessage, ChatThread } from "@/data/chatTypes";
import type { ContextUsage } from "@/data/contextBudget";
import type { ScanReport, RecentLibrary } from "@/data/types";
import type { Evidence } from "@/data/types";
import type { Repository } from "@/data/repository";
import type {
  DependencyEdge,
  GraphSnapshot,
  KnowledgeNode,
  LearnStatus,
  LibraryInfo,
  NodeBackup,
  NodeErasure,
  NodeFolderUsage,
  NodeHealth,
  NodePatch,
} from "@/data/types";
import type { LibraryState, Notice, SaveState } from "@/store";

/* ============================== §5.3 uiStore ============================== */

export type WorkspaceMode = "chat" | "split" | "graph";
export type SplitOrientation = "horizontal" | "vertical";
export type NavDrawerKind = "search";
export type InspectorTab = "detail" | "notes" | "resources";
export type MaximizedPane = "graph" | "chat";
/** 图谱观察方式：空间（球体，默认）/ 聚焦（二维一跳） */
export type GraphViewMode = "focus" | "space";
/** 分屏顺序：哪一侧在左（横屏）/ 上（竖屏） */
export type SplitOrder = "graph-first" | "chat-first";

/** 契约 §5.3 的 `WorkspaceLayoutState`，字段名逐字对应 */
export interface WorkspaceLayoutState {
  mode: WorkspaceMode;
  previousSplitMode: boolean;
  horizontalGraphRatio: number;
  verticalGraphRatio: number;
  graphViewMode: GraphViewMode;
  splitOrder: SplitOrder;
  navDrawer: NavDrawerKind | null;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  threadListOpen: boolean;
  maximizedPane: MaximizedPane | null;
  commandPaletteOpen: boolean;
}

export interface UiSurface extends WorkspaceLayoutState {
  setMode(mode: WorkspaceMode): void;
  setRatio(orientation: SplitOrientation, ratio: number): void;
  resetRatio(orientation: SplitOrientation): void;
  maximizePane(pane: MaximizedPane): void;
  restoreSplit(): void;
  setGraphViewMode(mode: GraphViewMode): void;
  /** 在当前视图右侧打开另一半（分屏）；顺序由当前所在视图决定 */
  openSidePane(): void;
  /** 收起侧边窗格，回到主窗格 */
  closeSidePane(): void;
  primaryPane(): MaximizedPane;
  /** 侧边栏（对话 / 脉络）的总开关：开着就关，关着就打开上次那一页 */
  toggleSidePanel(): void;
  setNavDrawer(kind: NavDrawerKind | null): void;
  setInspectorOpen(open: boolean): void;
  setInspectorTab(tab: InspectorTab): void;
  setThreadListOpen(open: boolean): void;
  setCommandPaletteOpen(open: boolean): void;
  hydrateLayout(persisted: Partial<WorkspaceLayoutState> | null): void;
  snapshotLayout(): WorkspaceLayoutState;
  /**
   * 绑定到某个知识库：布局按 libraryId 分区持久化。
   *
   * uiStore 自己负责读回该库上次的布局并落盘（契约 §5.3 的持久化要求），
   * 因此工作台只需要在切库时通知它一声，不必自己碰存储。
   */
  attachLibrary?(libraryId: string | null): void;
}

/** 宽高比的安全区间：两侧都不小于 25% */
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 0.75;
export const DEFAULT_GRAPH_RATIO = 0.42;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_GRAPH_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** 布局 store 的实时读取（`.getState()` 之外的地方一律用 `useLayout`） */
export function layoutApi(): UiSurface {
  return useUiStore.getState() as unknown as UiSurface;
}

/**
 * 订阅一条媒体查询。
 *
 * 契约里唯一允许组件判断宽度的规则是「< 740px 不显示硬分屏」，
 * 这里把它做成一个可复用的钩子，避免每个组件各写一遍 matchMedia。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/** 窄屏：不显示硬分屏，退化为对话 / 图谱切换 */
export const NARROW_QUERY = "(max-width: 740px)";

export function useNarrowLayout(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

/**
 * 订阅布局状态。
 *
 * 选择器必须返回稳定值（基本类型或 store 里的同一个引用），否则 zustand 会认为
 * 快照一直在变。布局字段全是基本类型，因此这里不需要额外做记忆化。
 */
export function useLayout<T>(selector: (state: UiSurface) => T): T {
  return useUiStore(selector as (state: unknown) => T);
}

/* ============================== §5.5 useStore ============================== */

/** 扫描问题：字段与契约 §5.1 的 `ScanIssue` 一致 */
export interface ScanIssueLike {
  code: string;
  severity: "error" | "warning" | "info";
  relativePath: string | null;
  nodeId: string | null;
  detail: string;
  parsePosition: string | null;
}

export interface DuplicateGroupLike {
  nodeId: string;
  relativePaths: string[];
}

/** 节点上由扫描给出的只读信息（契约 §5.1 新增，旧实现缺席时按 ok 处理） */
export interface NodeHealthInfo {
  health: NodeHealth;
  relativePath: string;
  folderName: string;
}

export interface NodeRef {
  id: string;
  title: string;
}

export interface WorkspaceSurface {
  /* ------------------------------ 知识库生命周期 ------------------------------ */
  libraryState: LibraryState;
  libraryInfo: LibraryInfo | null;
  libraryError: string | null;
  isDemo: boolean;
  busy: string | null;
  demoAccepted: boolean;
  recentLibraries: RecentLibrary[];
  recentError: string | null;

  /* -------------------------------- 数据 -------------------------------- */
  graph: GraphSnapshot;
  loading: boolean;
  selectedId: string | null;
  repo: Record<string, unknown> | null;

  /* ------------------------------ 状态反馈 ------------------------------ */
  saveState: SaveState;
  saveError: string | null;
  notice: Notice | null;

  /* --------------------------- v2 新增（可能缺席） --------------------------- */
  scanState?: "idle" | "scanning" | "error";
  scanReport?: ScanReport | null;
  scanError?: string | null;

  /* ------------------------------- 周期动作 ------------------------------- */
  init(): Promise<void>;
  closeLibrary(): Promise<void>;
  refreshRecent(): Promise<void>;
  removeRecentLibrary(path: string): Promise<void>;
  resetToPicker(): void;
  openDemoLibrary(): Promise<boolean>;
  createLibrary(parentDir: string, name: string, title?: string): Promise<boolean>;
  pickDirectory(title?: string): Promise<string | null>;
  setDemoAccepted(): void;

  /* -------------------------------- 写入口 -------------------------------- */
  /** 只读 / 修复中 / 有独占操作 / 未打开时返回 false，界面据此禁用按钮 */
  canWrite(): boolean;
}

type RawState = Record<string, unknown>;

function rawStore(): RawState {
  return useStore.getState() as unknown as RawState;
}

/** 订阅知识图 store（选择器同样要返回稳定值） */
export function useWorkspace<T>(selector: (state: WorkspaceSurface) => T): T {
  return useStore(selector as (state: unknown) => T);
}

/** 从当前状态里取第一个存在的函数，并绑定到状态对象上 */
type AnyFn = (...args: never[]) => unknown;

function pickFn(state: RawState, ...names: string[]): AnyFn | null {
  for (const name of names) {
    const candidate = state[name];
    if (typeof candidate === "function") return candidate.bind(state) as AnyFn;
  }
  return null;
}

function missing(name: string): never {
  throw new Error(`当前状态层没有提供「${name}」，请确认 v2 契约 §5.5 / §5.6 的公开面已经落地。`);
}

/** 包装成 Promise：契约里 sync / async 都允许，调用方只关心「做完没有」 */
async function invoke(state: RawState, names: string[], ...args: unknown[]): Promise<unknown> {
  const fn = pickFn(state, ...names);
  if (!fn) missing(names[0]);
  return await (fn as (...a: unknown[]) => unknown)(...args);
}

/**
 * 工作台用到的写动作。
 *
 * 每次调用都重新从 store 取函数：切库之后会话对象会换，缓存下来的引用会指向旧库。
 */
export function workspaceApi() {
  const state = () => rawStore();
  return {
    /** 契约新增动作在旧实现里不存在：界面据此决定是否显示入口 */
    supports(name: string): boolean {
      return typeof rawStore()[name] === "function";
    },

    selectNode(nodeId: string | null): void {
      const s = state();
      const fn = pickFn(s, "selectNode", "select");
      if (fn) (fn as (id: string | null) => void)(nodeId);
    },

    /** 「设为当前所在节点」：选中 + 记入会话（旧实现叫 enterNode） */
    async enterNode(nodeId: string): Promise<void> {
      await invoke(state(), ["selectNodeAndEnter", "enterNode"], nodeId);
    },

    /** 新建一个普通知识点：它和别的节点没有地位差别。失败时返回 null（store 已提示） */
    async createNode(title: string): Promise<KnowledgeNode | null> {
      return (await invoke(state(), ["createNode"], title)) as KnowledgeNode | null;
    },

    async setStatus(nodeId: string, status: LearnStatus): Promise<void> {
      await invoke(state(), ["setStatus"], nodeId, status);
    },

    async updateNode(nodeId: string, patch: NodePatch): Promise<void> {
      await invoke(state(), ["updateNode"], nodeId, patch);
    },

    /** 契约语义：移除节点身份，不删除任何用户文件 */
    async removeNodeIdentity(nodeId: string): Promise<void> {
      await invoke(state(), ["removeNodeIdentity", "deleteNode"], nodeId);
    },

    /** 删除前的体检：文件夹里有多少文件、多大（只读，只读知识库也能看） */
    async inspectNodeFolder(nodeId: string): Promise<NodeFolderUsage | null> {
      const fn = pickFn(state(), "inspectNodeFolder");
      if (!fn) return null;
      return (await (fn as (id: string) => Promise<NodeFolderUsage | null>)(nodeId)) ?? null;
    },

    /** 删除前把整个文件夹整份备份到 `.knowledgenet/backups/` */
    async backupNodeResources(nodeId: string): Promise<NodeBackup | null> {
      const fn = pickFn(state(), "backupNodeResources");
      if (!fn) {
        missing("backupNodeResources");
      }
      return (await (fn as (id: string) => Promise<NodeBackup | null>)(nodeId)) ?? null;
    },

    /** **彻底删除**：文件夹连同里面的文件一起删掉，不可撤销 */
    async eraseNode(nodeId: string): Promise<NodeErasure | null> {
      const fn = pickFn(state(), "eraseNode");
      if (!fn) {
        missing("eraseNode");
      }
      return (await (fn as (id: string) => Promise<NodeErasure | null>)(nodeId)) ?? null;
    },

    /** 在文件管理器里打开备份目录；演示后端没有文件管理器，返回 false */
    async revealBackup(backupRelativePath: string): Promise<boolean> {
      const fn = pickFn(state(), "revealBackup");
      if (!fn) return false;
      return Boolean(await (fn as (p: string) => Promise<boolean>)(backupRelativePath));
    },

    async removeEdge(edgeId: string): Promise<void> {
      await invoke(state(), ["removeEdge"], edgeId);
    },

    async updateEdgeRelation(edgeId: string, relation: string): Promise<void> {
      await invoke(state(), ["updateEdgeRelation", "setEdgeRelation"], edgeId, relation);
    },

    async mergeNodes(sourceId: string, targetId: string): Promise<void> {
      await invoke(state(), ["mergeNodes"], sourceId, targetId);
    },

    /** 返回「新建了哪些、复用了哪些」，失败或成环时为 null */
    async addPrerequisites(parentId: string, titles: string[]): Promise<PrereqOutcome | null> {
      const s = state();
      const fn = pickFn(s, "addPrerequisites", "createPrerequisites");
      if (!fn) missing("addPrerequisites");
      const raw = await (fn as (a: string, b: string[]) => unknown)(parentId, titles);
      return normalizePrereqOutcome(raw);
    },


    notify(kind: Notice["kind"], text: string): void {
      const fn = pickFn(state(), "notify");
      if (fn) (fn as (k: Notice["kind"], t: string) => void)(kind, text);
    },

    dismissNotice(): void {
      const fn = pickFn(state(), "dismissNotice");
      if (fn) (fn as () => void)();
    },

    async closeLibrary(): Promise<void> {
      await invoke(state(), ["closeLibrary"]);
    },

    /** 打开一个知识库：契约把它叫 `openLibraryAt`，旧实现叫 `openLibrary` */
    async openLibrary(rootPath: string, allowReadOnly = false): Promise<boolean> {
      return Boolean(await invoke(state(), ["openLibraryAt", "openLibrary"], rootPath, allowReadOnly));
    },

    async openDemoLibrary(): Promise<boolean> {
      return Boolean(await invoke(state(), ["openDemoLibrary"]));
    },

    async createLibrary(parentDir: string, name: string, title?: string): Promise<boolean> {
      return Boolean(await invoke(state(), ["createLibrary"], parentDir, name, title));
    },

    async pickDirectory(title?: string): Promise<string | null> {
      return (await invoke(state(), ["pickDirectory"], title)) as string | null;
    },

    async pickFiles(): Promise<string[]> {
      const picked = (await invoke(state(), ["pickFiles"])) as string[] | null;
      return Array.isArray(picked) ? picked : [];
    },

    async refreshRecent(): Promise<void> {
      await invoke(state(), ["refreshRecent"]);
    },

    async removeRecentLibrary(path: string): Promise<void> {
      await invoke(state(), ["removeRecentLibrary"], path);
    },

    resetToPicker(): void {
      const fn = pickFn(state(), "resetToPicker");
      if (fn) (fn as () => void)();
    },

    setDemoAccepted(): void {
      const fn = pickFn(state(), "setDemoAccepted");
      if (fn) (fn as () => void)();
    },

    canWrite(): boolean {
      const fn = pickFn(state(), "canWrite");
      return fn ? Boolean((fn as () => boolean)()) : false;
    },

    /* ------------------------------ v2 新增 ------------------------------ */

    async pullScan(full = false): Promise<void> {
      await invoke(state(), ["pullScan"], full);
    },

    async adoptFolder(relativePath: string, title?: string): Promise<unknown> {
      return await invoke(state(), ["adoptFolder"], relativePath, title);
    },

    async reassignDuplicate(relativePath: string): Promise<unknown> {
      return await invoke(state(), ["reassignDuplicate"], relativePath);
    },

    openGraphOfNode(nodeId: string): void {
      const fn = pickFn(state(), "openGraphOfNode");
      if (fn) (fn as (id: string) => void)(nodeId);
    },

    duplicateGroups(): DuplicateGroupLike[] {
      const fn = pickFn(state(), "duplicateGroups");
      return fn ? ((fn as () => DuplicateGroupLike[])() ?? []) : [];
    },

    /** 「打开节点文件夹」属于仓储能力，不在 §5.5 的 store 动作里 */
    async openNodeFolder(nodeId: string): Promise<void> {
      const repo = state().repo as { openNodeFolder?: (id: string) => Promise<void> } | null;
      if (!repo?.openNodeFolder) missing("openNodeFolder");
      await repo.openNodeFolder(nodeId);
    },

    async scanLibrary(full = false): Promise<unknown> {
      const repo = state().repo as { scanLibrary?: (f: boolean) => Promise<unknown> } | null;
      if (!repo?.scanLibrary) missing("scanLibrary");
      return await repo.scanLibrary(full);
    },
  };
}

export interface PrereqOutcome {
  created: NodeRef[];
  reused: NodeRef[];
  /** 非空表示这次没有落地（会形成循环依赖） */
  blocked: string | null;
}

/**
 * 归一化「新增前置知识」的返回值。
 *
 * 旧实现返回 `{ok:false, cycle}` 或 `{ok:true, value:{created,reused}}`，
 * 契约里 store 直接返回 payload 或 null。两种形状都在这里收敛成一种，
 * 上层只面对 `{created, reused, blocked}`。
 */
function normalizePrereqOutcome(raw: unknown): PrereqOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const box = raw as Record<string, unknown>;
  if (box.ok === false) return { created: [], reused: [], blocked: "会形成循环依赖" };
  const payload = (box.ok === true && box.value ? box.value : box) as Record<string, unknown>;
  const pick = (key: string): NodeRef[] =>
    Array.isArray(payload[key])
      ? (payload[key] as { id?: unknown; title?: unknown }[])
          .filter((n) => typeof n?.id === "string")
          .map((n) => ({ id: String(n.id), title: String(n.title ?? "") }))
      : [];
  const created = pick("created");
  const reused = pick("reused");
  if (created.length === 0 && reused.length === 0 && payload.parentId === undefined) return null;
  return { created, reused, blocked: null };
}

/** 直接读一次图快照：异步回调里要按当前数据判断，不能看渲染时捕获的那份 */
export function graphSnapshot(): GraphSnapshot {
  return rawStore().graph as GraphSnapshot;
}

/** 直接读一次最新提示：写操作失败的原因由 store 写在 notice 里 */
export function noticeSnapshot(): Notice | null {
  return (rawStore().notice as Notice | null) ?? null;
}

/** 当前会话的 repository（切库后会换成新的那个，所以每次都要重新取） */
export function repoSnapshot(): Repository | null {
  const repo = rawStore().repo as Repository | null | undefined;
  return repo && typeof repo === "object" ? repo : null;
}

/**
 * 解析一个低频动作：先看 store，再看它持有的 repository。
 *
 * 知识库那一块（迁移、完整性、已移除的节点身份）在契约里落在 repository 上，
 * 而旧实现把它们放在 store 上。这里按「store 优先、repo 其次」解析，
 * 返回 null 表示当前实现确实没有这个能力——界面据此隐藏入口，
 * 而不是点下去才报「不是一个函数」。
 */
export function resolveAction(...names: string[]): ((...args: any[]) => unknown) | null {
  const state = rawStore();
  const direct = pickFn(state, ...names);
  if (direct) return direct as (...args: any[]) => unknown;
  const repo = state.repo as Record<string, unknown> | null;
  if (repo && typeof repo === "object") {
    return pickFn(repo, ...names) as ((...args: any[]) => unknown) | null;
  }
  return null;
}

/** 指定名字的动作是否可用（用于决定要不要显示某个入口） */
export function hasAction(...names: string[]): boolean {
  return resolveAction(...names) !== null;
}

/* ============================ §5.6 useChatStore ============================ */

export interface ActiveRequestLike {
  messageId: string;
  requestId: string | null;
}

export interface ScrollRequestLike {
  threadId: string;
  offset: number;
  messageId: string | null;
  nonce: number;
}

export interface ChatSurface {
  nodeId?: string | null;
  loading: boolean;
  ready: boolean;
  threads: ChatThread[];
  activeThreadId: string | null;
  messages: ChatMessage[];
  messagesLoading?: boolean;
  bookmarks: Bookmark[];
  /** 关系上的来源记录（按 `${fromNodeId}:${edgeId}` 归组），随当前会话载入 */
  evidence?: Record<string, Evidence[]>;
  activeRequests: Record<string, ActiveRequestLike>;
  pendingScroll: ScrollRequestLike | null;
  error: string | null;
  /**
   * 生成过程中的状态：正在联网检索、上游不可用正在重试……
   *
   * 可选：旧实现没有这个字段，缺席时界面只是不显示过程状态，不该报错。
   */
  activity?: string | null;
  /** 最近一次组装请求的上下文用量估算；旧实现缺席时输入区不显示这一项 */
  contextUsage?: ContextUsage | null;
  aiLabel: string;
  configured: boolean;
}

export function useChat<T>(selector: (state: ChatSurface) => T): T {
  return useChatStore(selector as (state: unknown) => T);
}

function rawChat(): RawState {
  return useChatStore.getState() as unknown as RawState;
}

/** 直接读一次线程快照：删除确认要判「它到底还在不在」，不能看渲染时捕获的那份数组 */
export function chatThreadsSnapshot(): ChatThread[] {
  const threads = rawChat().threads;
  return Array.isArray(threads) ? (threads as ChatThread[]) : [];
}

/** 直接读一次消息快照：判断刚发出去的问题有没有真的落地 */
export function chatMessagesSnapshot(): ChatMessage[] {
  const messages = rawChat().messages;
  return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
}

export function chatApi() {
  const state = () => rawChat();
  return {
    /**
     * 契约：选中节点后只拉该节点的线程头，不拉消息正文。
     * 旧实现是一次性 `load()` 全库对话，这里保留一条过渡分支。
     */
    async openNode(nodeId: string | null): Promise<void> {
      const s = state();
      const fn = pickFn(s, "openNode");
      if (fn) {
        await (fn as (id: string | null) => unknown)(nodeId);
        return;
      }
      /*
       * 旧实现的 `load()` 自带「同一会话只读一次」的判断，
       * 因此这里每次切节点都调用也不会重复读库。
       */
      const load = pickFn(s, "load");
      if (load) await (load as (force?: boolean) => unknown)(false);
    },

    async selectThread(threadId: string | null): Promise<void> {
      await invoke(state(), ["selectThread"], threadId);
    },

    async createThread(nodeId: string, title?: string): Promise<ChatThread> {
      return (await invoke(state(), ["createThread"], nodeId, title)) as ChatThread;
    },

    async deleteThread(threadId: string): Promise<void> {
      await invoke(state(), ["deleteThread"], threadId);
    },

    async renameThread(threadId: string, title: string): Promise<void> {
      await invoke(state(), ["renameThread"], threadId, title);
    },

    async send(nodeId: string, text: string): Promise<void> {
      await invoke(state(), ["send"], nodeId, text);
    },

    async stop(threadId: string): Promise<void> {
      await invoke(state(), ["stop"], threadId);
    },

    async retry(nodeId: string, messageId: string): Promise<void> {
      await invoke(state(), ["retry"], nodeId, messageId);
    },

    async saveBookmark(input: {
      nodeId: string;
      threadId: string;
      messageId: string;
      scrollOffset: number;
      question: string;
    }): Promise<void> {
      await invoke(state(), ["saveBookmark"], input);
    },

    async deleteBookmark(bookmarkId: string): Promise<void> {
      await invoke(state(), ["deleteBookmark"], bookmarkId);
    },

    /** 选中文字 → 来源记录，写进该关系所在的 relations.json */
    async addEvidence(input: {
      fromNodeId: string;
      edgeId: string;
      threadId: string | null;
      messageId: string | null;
      snippet: string;
      question: string;
    }): Promise<void> {
      const s = state();
      const fn = pickFn(s, "addEvidence");
      if (fn) {
        await (fn as (i: unknown) => unknown)(input);
        return;
      }
      // 旧实现把「来源」存在 discoveries 里，并且需要目标节点 ID
      const legacy = pickFn(s, "recordDiscovery");
      if (!legacy) missing("addEvidence");
      const graph = rawStore().graph as GraphSnapshot | undefined;
      const edge = graph?.edges.find((e) => e.id === input.edgeId);
      if (!edge) throw new Error("找不到这条依赖关系，来源未记录");
      await (legacy as (i: unknown) => unknown)({
        edgeId: input.edgeId,
        fromNodeId: input.fromNodeId,
        toNodeId: edge.toId,
        snippet: input.snippet,
        question: input.question,
        threadId: input.threadId,
        messageId: input.messageId,
      });
    },

    clearScrollRequest(): void {
      const fn = pickFn(state(), "clearScrollRequest");
      if (fn) (fn as () => void)();
    },

    /**
     * 请求把某个对话滚动到指定位置（书签「回到原处」用）。
     *
     * 契约 §5.6 冻结了 `pendingScroll` 与 `clearScrollRequest`，但没有列出
     * 「谁来写 pendingScroll」。这里优先用同名动作，缺席时直接写那个字段。
     */
    requestScroll(request: Omit<ScrollRequestLike, "nonce">): void {
      const s = state();
      const fn = pickFn(s, "requestScroll");
      if (fn) {
        (fn as (r: unknown) => void)(request);
        return;
      }
      const setState = useChatStore.setState as unknown as (partial: {
        pendingScroll: ScrollRequestLike;
      }) => void;
      setState({ pendingScroll: { ...request, nonce: Date.now() + Math.random() } });
    },

    /** 只切「深度思考」一项；旧实现与新实现同名，缺席时输入区的开关不渲染 */
    async setThinking(thinking: boolean): Promise<void> {
      await invoke(state(), ["setThinking"], thinking);
    },

    /**
     * 只切「联网检索」一项。
     *
     * 与 setThinking 同样走状态层：这项设置要在提问前那一刻改，
     * 不能在设置弹窗里改完再回来问。缺席时输入区不渲染这个开关。
     */
    async setWebSearch(webSearch: boolean): Promise<void> {
      await invoke(state(), ["setWebSearch"], webSearch);
    },

    setError(message: string | null): void {
      const fn = pickFn(state(), "setError");
      if (fn) {
        (fn as (m: string | null) => void)(message);
        return;
      }
      // 旧实现没有 setError：直接写状态字段（`error` 两种实现都有）
      const setState = useChatStore.setState as unknown as (partial: {
        error: string | null;
      }) => void;
      setState({ error: message });
    },
  };
}

/* ------------------------------- 派生选择器 ------------------------------- */

/** 当前选中的知识点（不存在时为 null） */
export function useCurrentNode(): KnowledgeNode | null {
  return useWorkspace((s) => {
    if (!s.selectedId) return null;
    return s.graph.nodes.find((n) => n.id === s.selectedId) ?? null;
  });
}

/** 当前学习目标 */

/**
 * 节点的扫描健康信息。
 *
 * 契约 §5.1 给 `KnowledgeNode` 增加了 `health` / `relativePath` / `folderName`，
 * 旧实现没有这三项。这里统一按「ok / 空路径」退化，界面不必到处写 `?? "ok"`。
 */
export function nodeHealth(node: KnowledgeNode | null | undefined): NodeHealthInfo {
  return {
    health: node?.health ?? "ok",
    relativePath: node?.relativePath ?? "",
    folderName: node?.folderName ?? "",
  };
}

export const HEALTH_LABEL: Record<NodeHealthInfo["health"], string> = {
  ok: "元数据正常",
  metadata_invalid: "元数据文件无法解析",
  metadata_unsupported: "元数据版本不受支持",
  duplicate_id: "节点 ID 与另一个文件夹重复",
};

/**
 * 当前节点的线程（按创建时间升序）。
 *
 * 契约里 `chatStore.threads` 只含当前节点的线程头；旧实现含全库线程。
 * 这里统一按节点过滤，两种实现下行为一致。
 */
export function useNodeThreads(nodeId: string | null): ChatThread[] {
  const threads = useChat((s) => s.threads);
  return useMemo(() => {
    if (!nodeId || !Array.isArray(threads)) return [];
    return threads
      .filter((t) => t.nodeId === nodeId)
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [threads, nodeId]);
}

/**
 * 关系上的来源记录。
 *
 * v2 把来源写进**发起方**的 `relations.json`，聊天 store 在会话内按
 * `${fromNodeId}:${edgeId}` 归组缓存。这里读那份缓存：它是响应式的，
 * 节点详情里的「N 条来源」才会在记录动作之后立刻更新。
 */
export function useEvidenceMap(): Record<string, Evidence[]> {
  return useChat((s) => s.evidence) ?? {};
}

/** 某条依赖上记了几段来源 */
export function evidenceCount(
  map: Record<string, Evidence[]>,
  fromNodeId: string,
  edgeId: string,
): number {
  return map[`${fromNodeId}:${edgeId}`]?.length ?? 0;
}

/** 当前线程的消息（按时间升序） */
export function useThreadMessages(threadId: string | null): ChatMessage[] {
  const messages = useChat((s) => s.messages);
  return useMemo(() => {
    if (!threadId || !Array.isArray(messages)) return [];
    return messages
      .filter((m) => m.threadId === threadId)
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [messages, threadId]);
}

/** 这个节点有几条依赖 */
export function edgeCountOf(graph: GraphSnapshot, nodeId: string): number {
  return graph.edges.filter((e) => e.fromId === nodeId || e.toId === nodeId).length;
}

/** 关系两端的标题（用于提示文案） */
export function edgeLabel(graph: GraphSnapshot, edge: DependencyEdge): string {
  const from = graph.nodes.find((n) => n.id === edge.fromId)?.title ?? "?";
  const to = graph.nodes.find((n) => n.id === edge.toId)?.title ?? "?";
  return `${from} → ${to}`;
}
