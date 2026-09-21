/**
 * 应用状态
 *
 * 与旧版最大的区别：知识图来自**开放文件的扫描结果**，而不是 SQLite 里的行。
 * 因此这里多了扫描状态（`scanState` / `scanReport` / `scanError`）与几个
 * 只有文件模型才有的动作（认领文件夹、修复重复 ID）。
 *
 * 四条硬规则：
 * 1. 任何写操作前先看状态：只读、修复中、未打开一律直接拒绝，而不是等后端报错；
 * 2. 任何异步返回写状态前先看「会话代次 + session.valid」：旧会话的响应直接丢弃；
 * 3. 写失败绝不发成功提示（`runWrite` 把失败原因显式交回调用方）；
 * 4. 布局状态不在这里（见 `src/uiStore.ts`）：聊天流式更新绝不能带着外壳一起重渲染。
 */
import { create } from "zustand";

import { bindChatHost, useChatStore } from "@/chatStore";
import { nodeMap } from "@/data/engine";
import { RepositoryError, toRepositoryError } from "@/data/errors";
import type { LibrarySession, Repository } from "@/data/repository";
import {
  getCurrentSession,
  getLibraryController,
  setCurrentSession,
  subscribeSession,
} from "@/data/session";
import type {
  AddPrerequisitesPayload,
  CopyMode,
  CopyResult,
  DependencyEdge,
  DuplicateIdGroup,
  GraphSnapshot,
  IntegrityReport,
  KnowledgeNode,
  LearnStatus,
  LibraryInfo,
  NodeBackup,
  NodeErasure,
  NodeFolderUsage,
  NodePatch,
  RecentLibrary,
  RemovedIdentity,
  RepairAction,
  RepairReport,
  ScanReport,
} from "@/data/types";
import { emptySnapshot, STATUS_LABEL } from "@/data/types";
import { formatBytes } from "@/format";
import { dropSpaceCache } from "@/graph3d/session";
import { useUiStore } from "@/uiStore";

/**
 * 知识库状态机。
 *
 * `none`     没有打开任何知识库：渲染库选择界面；
 * `opening`  正在打开/新建：只显示进度，不渲染外壳；
 * `open`     正常可写；
 * `readonly` 打开成功但拿不到写锁（或格式版本更高）：外壳 + 明显提示，禁用全部写入口；
 * `repairing` 完整性检查/修复进行中：禁用会与修复冲突的写操作；
 * `error`    打开失败：说明原因并给出重试 / 换一个库的出路。
 */
export type LibraryState = "none" | "opening" | "open" | "readonly" | "repairing" | "error";

export type SaveState = "idle" | "saving" | "saved" | "error";

/** 扫描状态：界面据此显示「正在重新扫描知识库…」而不是静默卡住 */
export type ScanState = "idle" | "scanning" | "error";

/**
 * 状态对应的展示文案与类名。
 *
 * 类名统一用 `is-todo / is-learning / is-done`，让状态圆点、状态胶囊、
 * 画布节点、详情里的状态选择器共用同一套样式，不必各写一份颜色映射。
 */
export const STATUS_DISPLAY: Record<LearnStatus, { label: string; cls: string }> = {
  todo: { label: STATUS_LABEL.todo, cls: "is-todo" },
  learning: { label: STATUS_LABEL.learning, cls: "is-learning" },
  done: { label: STATUS_LABEL.done, cls: "is-done" },
};

/** 顶部一次性的提示信息（操作结果、循环依赖警告等） */
export interface Notice {
  id: number;
  kind: "info" | "success" | "warn" | "error";
  text: string;
}

/**
 * 写操作的结果。
 *
 * `discarded` 表示「响应属于已经关闭的旧会话」：调用方既不该报成功，
 * 也不该报失败——那次操作的结果已经与当前界面无关了。
 */
export type RunResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; discarded?: boolean };

/** `runWrite` 的附加选项 */
interface WriteOptions {
  /**
   * 写完之后是否重新载入整张图。
   * 笔记与资料只改自己的文件与修订号，重载整图（一万个节点时）纯属浪费，
   * 因此它们传 false，由调用方自己维护本地那份数据。
   */
  reloadGraph?: boolean;
}

interface KnowledgeState {
  /* ---------------------------- 知识库生命周期 ---------------------------- */
  libraryState: LibraryState;
  libraryInfo: LibraryInfo | null;
  libraryError: string | null;
  isDemo: boolean;
  recentLibraries: RecentLibrary[];
  recentError: string | null;
  /** 演示模式下用户明确点过「继续使用演示库」 */
  demoAccepted: boolean;

  /* -------------------------------- 数据 -------------------------------- */
  repo: Repository | null;
  sessionId: string | null;
  graph: GraphSnapshot;
  loading: boolean;
  /** 最近一次扫描的报告：节点健康、问题清单、重复 ID 都从这里读 */
  scanReport: ScanReport | null;
  scanState: ScanState;
  scanError: string | null;

  /* ------------------------------ 界面状态 ------------------------------ */
  selectedId: string | null;

  saveState: SaveState;
  saveError: string | null;
  notice: Notice | null;
  /** 进行中的独占操作（创建副本、检查、修复）：非空时禁用一切写入口 */
  busy: string | null;

  integrity: IntegrityReport | null;

  /* ------------------------------- 生命周期 ------------------------------- */
  /** 启动：取最近列表与当前会话，有库就打开，没有就进 none */
  init(): Promise<void>;
  refreshRecent(): Promise<void>;
  setDemoAccepted(): void;
  /** 打开指定根目录的知识库（契约 §5.5 的冻结名） */
  openLibraryAt(rootPath: string, allowReadOnly?: boolean): Promise<boolean>;
  /** `openLibraryAt` 的旧名，保留给尚未迁移的调用方 */
  openLibrary(rootPath: string, allowReadOnly?: boolean): Promise<boolean>;
  /** 浏览器演示模式：打开内置演示库（不是便携知识库，数据不会落成文件夹） */
  openDemoLibrary(): Promise<boolean>;
  createLibrary(parentDir: string, name: string, title?: string): Promise<boolean>;
  pickDirectory(title?: string): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  closeLibrary(): Promise<void>;
  removeRecentLibrary(path: string): Promise<void>;
  /** 从 error 状态回到选择界面（重新选一个库，而不是卡在错误页） */
  resetToPicker(): void;
  /** 重新读取当前知识库摘要（计数、只读标记、扫描耗时） */
  refreshLibraryInfo(): Promise<void>;
  createLibraryCopy(
    targetParentDir: string,
    name: string,
    mode: CopyMode,
  ): Promise<CopyResult | null>;

  /* ------------------------------- 扫描与修复 ------------------------------- */
  /** 重新扫描知识库：文件监听事件的兜底，也是「刚在资源管理器里改过」后的刷新 */
  pullScan(full?: boolean): Promise<ScanReport | null>;
  /** 把已有文件夹认领为节点（只写元数据，不移动任何文件） */
  adoptFolder(relativePath: string, title?: string): Promise<KnowledgeNode | null>;
  /** 重复 ID 修复：给副本分配新 ID */
  reassignDuplicate(relativePath: string): Promise<KnowledgeNode | null>;
  /** 当前图里的重复 ID 分组（节点健康状态为 duplicate_id 的那些） */
  duplicateGroups(): DuplicateIdGroup[];
  /** 选中节点并切到图谱模式看它在结构里的位置 */
  openGraphOfNode(nodeId: string): void;

  /* ------------------------------ 完整性与回收站 ------------------------------ */
  checkIntegrity(deep: boolean): Promise<IntegrityReport | null>;
  repairLibrary(actions: RepairAction[]): Promise<RepairReport | null>;
  /** 被移除身份的节点（元数据在回收站，用户文件原位保留） */
  listRemovedIdentities(): Promise<RemovedIdentity[] | null>;
  restoreNodeIdentity(nodeId: string): Promise<void>;
  purgeRemovedIdentity(nodeId: string): Promise<boolean>;

  /* ---------------------------- 彻底删除与备份 ---------------------------- */
  /** 删除前的体检：这个文件夹里有多少文件、多大、里面还套着几个知识点 */
  inspectNodeFolder(nodeId: string): Promise<NodeFolderUsage | null>;
  /** 删除前把整个文件夹整份备份到 `.knowledgenet/backups/` */
  backupNodeResources(nodeId: string): Promise<NodeBackup | null>;
  /** 彻底删除：文件夹连同里面的文件一起删掉，不可撤销 */
  eraseNode(nodeId: string): Promise<NodeErasure | null>;
  /** 在文件管理器里打开一个备份目录（演示后端不支持） */
  revealBackup(backupRelativePath: string): Promise<boolean>;

  /* -------------------------------- 交互 -------------------------------- */
  /** 选中节点（对话面板跟着切到这个节点） */
  selectNode(nodeId: string | null): void;
  /** 选中并记录「当前所在节点」（防抖落盘） */
  enterNode(nodeId: string): Promise<void>;
  /** 从搜索结果等处进入节点：切换当前节点，但保持当前布局模式 */
  selectNodeAndEnter(nodeId: string): Promise<void>;
  notify(kind: Notice["kind"], text: string): void;
  dismissNotice(): void;

  /* -------------------------------- 写入口 -------------------------------- */
  /** 只读 / 修复中 / 有独占操作 / 未打开时返回 false；界面据此禁用按钮 */
  canWrite(): boolean;
  /** 统一的写操作包装：会话校验、错误分流、可选重载图 */
  runWrite<T>(
    label: string,
    fn: (repo: Repository) => Promise<T>,
    options?: WriteOptions,
  ): Promise<RunResult<T>>;

  /* -------------------------------- 目标 -------------------------------- */

  /* ----------------------------- 节点与关系 ----------------------------- */
  createNode(title: string): Promise<KnowledgeNode | null>;
  updateNode(id: string, patch: NodePatch): Promise<void>;
  setStatus(id: string, status: LearnStatus): Promise<void>;
  addPrerequisites(parentId: string, titles: string[]): Promise<AddPrerequisitesPayload | null>;
  /** 建立 from -> to 的依赖关系（复用已有节点） */
  addEdge(fromId: string, toId: string): Promise<boolean>;
  mergeNodes(sourceId: string, targetId: string): Promise<void>;
  /** 从知识库移除节点身份：不删除用户文件夹与其中的文件 */
  removeNodeIdentity(id: string): Promise<void>;
  removeEdge(edgeId: string): Promise<void>;
  updateEdgeRelation(edgeId: string, relation: string): Promise<void>;

  /* ----------------------------- 当前所在节点 ----------------------------- */
  /** 立刻把「当前在看哪个节点」写进设备侧状态 */
  saveSession(): Promise<void>;
  /** 保存失败时如实置为错误状态（后台写入失败不能被吞掉） */
  setSaveError(message: string): void;
}

let noticeSeq = 0;

/** 当前会话代次：每次打开/关闭知识库递增，用来识别「旧会话的晚到响应」 */
let generation = 0;

/** 切库/关库：取消进行中的生成并清空对话内存 */
async function resetChatData(): Promise<void> {
  await useChatStore.getState().reset();
}

/** 让对话面板跟着选中的节点走（只拉线程头，不拉消息正文） */
async function openChatNode(nodeId: string | null): Promise<void> {
  await useChatStore.getState().openNode(nodeId);
}

/** 错误提示要能指导下一步，而不是只说「失败」 */
function describeError(err: unknown): string {
  const e = toRepositoryError(err);
  switch (e.code) {
    case "read_only":
      return "这是只读知识库：没有取得写锁，或者知识库版本高于本应用。要修改请先关闭其它正在使用它的实例。";
    case "locked":
      return "知识库被另一个实例以可写方式打开。请先关闭那个实例，或以只读方式打开。";
    case "not_open":
      return "还没有打开知识库。";
    case "session_closed":
      return "这次操作属于已经关闭的知识库会话，结果已丢弃。";
    case "unsupported_version":
    case "metadata_unsupported":
      return "知识库或某个节点的格式版本高于本应用：请升级应用后再写入（现在可以只读查看）。";
    case "metadata_invalid":
      return "节点元数据文件坏了（JSON 不合法或字段类型不对）：文件没有被改动，修好它就能继续。";
    case "duplicate_node_id":
      return "同一个节点 ID 出现了两份：请先决定保留哪一个，或给副本分配新 ID。";
    case "external_change_conflict":
      return "磁盘上的文件已经被外部修改过：默认不会覆盖它，请选择重新载入或明确覆盖。";
    case "node_missing":
      return "节点目录已经不在了：它可能被外部移动或删除了。";
    case "node_outside_library":
      return "路径逃出了知识库根目录，已拒绝这次操作。";
    case "nested_library_boundary":
      return "这里还有一个嵌套的知识库，已经停止向下扫描。";
    case "scan_incomplete":
      return "扫描没有跑完（目录读不动）：报告不完整。";
    case "unsupported_in_demo":
      return "浏览器演示模式不支持这个操作。正式能力请在桌面版里使用。";
    case "not_found":
      return e.message || "对象不存在：它可能已经被删除。";
    default:
      return e.message;
  }
}

/*
 * 把「当前库是不是只读」与「当前的图」接给对话 store。
 *
 * 放在这里而不是让 chatStore 直接 import useStore：那会形成两个 store 之间的
 * 循环依赖（打包器报「动态导入无法分包」，模块初始化顺序也变得脆弱）。
 * 这两件事都只在事件回调里被读，因此模块初始化时接一次就够。
 */
bindChatHost({
  isReadonly: () => useStore.getState().libraryState === "readonly",
  graph: () => useStore.getState().graph,
});

export const useStore = create<KnowledgeState>((set, get) => {
  /** 「当前所在节点」的落盘防抖计时器 */
  let sessionSaveTimer: number | undefined;
  /** 会话订阅只装一次 */
  let subscribed = false;

  /** 拒绝写入时的一句话说明：说清是哪一种「不能写」 */
  function refuseText(): string {
    const state = get();
    if (state.busy) return `${state.busy}请等它结束再修改。`;
    if (state.libraryState === "readonly") return "这是只读知识库，不能修改。";
    if (state.libraryState === "repairing") return "正在检查/修复知识库，请等它结束再修改。";
    return "还没有打开知识库。";
  }

  /**
   * 统一的写操作包装。
   *
   * 只有 `ok` 为真时，调用方才允许发成功提示、改选择状态或做后续动作。
   */
  async function run<T>(
    label: string,
    fn: (repo: Repository) => Promise<T>,
    options: WriteOptions = {},
  ): Promise<RunResult<T>> {
    const { reloadGraph = true } = options;
    const repo = get().repo;
    if (!repo) {
      const text = "还没有打开知识库。";
      get().notify("warn", text);
      return { ok: false, error: text };
    }
    if (!get().canWrite()) {
      // 界面上的写入口本应已经禁用；走到这里说明还有别的触发路径，
      // 那就如实说清为什么没生效，而不是静默什么都不做
      const text = refuseText();
      get().notify("warn", text);
      return { ok: false, error: text };
    }

    const gen = generation;
    const repoAtStart = repo;
    set({ saveState: "saving", saveError: null });
    try {
      const value = await fn(repoAtStart);
      // 切库之后返回的旧响应：丢弃，不写任何状态
      if (gen !== generation) return { ok: false, error: "会话已关闭", discarded: true };
      if (reloadGraph) await loadGraphFor(repoAtStart, gen);
      if (gen !== generation) return { ok: false, error: "会话已关闭", discarded: true };
      set({ saveState: "saved" });
      window.setTimeout(() => {
        if (get().saveState === "saved") set({ saveState: "idle" });
      }, 1200);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, ...describeFailure(label, err, gen) };
    }
  }

  /**
   * 失败分流。
   *
   * - `session_closed`：那是旧库的响应，整条丢弃，连提示都不发（否则切库后
   *   屏幕上会冒出一句与当前知识库无关的报错）；
   * - `external_change_conflict`：不是「保存失败」，而是「磁盘上有人先改了」——
   *   重新载入图，并明确请用户决定怎么办；
   * - `read_only`：顺手把界面切成只读，避免用户继续点写入口。
   */
  function describeFailure(
    label: string,
    err: unknown,
    gen: number,
  ): { error: string; discarded?: boolean } {
    const e = err instanceof RepositoryError ? err : toRepositoryError(err);
    if (e.code === "session_closed") return { error: "会话已关闭", discarded: true };

    console.error(`[KnowledgeNet] ${label} 失败`, err);
    const message = describeError(e);
    if (gen !== generation) return { error: message, discarded: true };

    if (e.code === "external_change_conflict") {
      const repo = get().repo;
      if (repo) void loadGraphFor(repo, gen);
      set({ saveState: "error", saveError: "磁盘上的文件已被外部修改" });
      get().notify("warn", message);
      return { error: message };
    }

    if (e.code === "read_only") {
      const info = get().libraryInfo;
      set({
        libraryState: "readonly",
        libraryInfo: info ? { ...info, readOnly: true } : info,
      });
    }

    set({ saveState: "error", saveError: message });
    get().notify("error", `${label}失败：${message}`);
    return { error: message };
  }

  /** 载入轻量图快照：只含元数据，不含任何正文、附件与对话正文 */
  async function loadGraphFor(repo: Repository, gen: number): Promise<void> {
    const snapshot = await repo.loadGraph();
    if (gen !== generation) return;
    applyGraph(snapshot);
  }

  /**
   * 把一份新图快照放进界面状态。
   *
   * 选择与目标按 ID 重新对齐：切库或移除节点身份之后，旧 ID 可能已经不存在，
   * 留着会让面板显示一个不存在的知识点。
   */
  function applyGraph(snapshot: GraphSnapshot): void {
    const { selectedId } = get();
    const selectedAlive = snapshot.nodes.some((n) => n.id === selectedId);
    // 没有「目标根节点」可以回退了：选中项不在就回到上次打开的那个节点，再没有就空着
    const nextSelected = selectedAlive ? selectedId : (snapshot.session?.currentNodeId ?? null);
    set({ graph: snapshot, selectedId: nextSelected, loading: false });
  }

  /** 关库/切库后的整体清理：图、选中、目标、三维缓存、对话全部作废 */
  async function clearSessionState(): Promise<void> {
    set({
      sessionId: null,
      repo: null,
      libraryInfo: null,
      libraryState: "none",
      graph: emptySnapshot(),
      scanReport: null,
      scanState: "idle",
      scanError: null,
      selectedId: null,
      saveState: "idle",
      saveError: null,
      integrity: null,
      busy: null,
      loading: false,
    });
    // 三维布局按节点 ID 复用坐标：换库后必须显式失效，否则旧坐标会被套到新节点上
    dropSpaceCache();
    // 布局按 libraryId 分区：解绑当前库，下次打开时由 attachLibrary 读回它自己的那份
    useUiStore.getState().attachLibrary(null);
    await resetChatData();
  }

  /**
   * 采纳一个已经打开的会话。
   *
   * `sessionId` 是幂等标记：`subscribeSession` 的回调与主动打开路径都会走到这里，
   * 靠它保证同一会话只载入一次图。
   */
  async function adopt(session: LibrarySession, gen: number): Promise<boolean> {
    if (get().sessionId === session.sessionId) return true;
    const snapshot = await session.repository.loadGraph();
    if (gen !== generation) return false;
    const info = session.info;
    // 只恢复「上次在看哪个节点」；没有就空着，让画布走平铺兜底
    const selected = snapshot.session?.currentNodeId ?? null;
    set({
      sessionId: session.sessionId,
      repo: session.repository,
      libraryInfo: info,
      libraryState: info.readOnly ? "readonly" : "open",
      libraryError: null,
      graph: snapshot,
      selectedId: selected,
      loading: false,
      scanReport: null,
      scanState: "idle",
      scanError: null,
    });
    // 布局按 libraryId 分区：打开库就换回它自己的那份
    useUiStore.getState().attachLibrary(info.libraryId);
    if (info.issueCount > 0) {
      get().notify(
        "warn",
        `扫描发现 ${info.issueCount} 个问题（坏元数据、重复 ID、缺失目标…）。可在「知识库」里查看详情。`,
      );
    }
    /*
     * 对话属于节点：切库之后必须换成本库的那一份。
     * 这里只加载当前节点的线程头，消息正文等用户进入具体对话再读。
     */
    await openChatNode(selected);
    return true;
  }

  /** 打开失败：进 error 状态并说清原因，而不是把用户扔在没有出口的界面上 */
  function failOpen(gen: number, err: unknown): boolean {
    if (gen !== generation) return false;
    const message = describeError(err);
    console.error("[KnowledgeNet] 打开知识库失败", err);
    set({
      libraryState: "error",
      libraryError: message,
      loading: false,
      sessionId: null,
      repo: null,
      graph: emptySnapshot(),
      scanReport: null,
      selectedId: null,
    });
    return false;
  }

  /**
   * 「当前所在节点」的落盘防抖。
   *
   * 点选节点会立即更新选中状态，但只在停止操作 600ms 后才写一次——
   * 避免连续浏览十几个节点时写十几遍。
   */
  function scheduleSessionSave() {
    if (sessionSaveTimer !== undefined) window.clearTimeout(sessionSaveTimer);
    sessionSaveTimer = window.setTimeout(() => {
      sessionSaveTimer = undefined;
      void get().saveSession();
    }, 600);
  }

  return {
    libraryState: "none",
    libraryInfo: null,
    libraryError: null,
    isDemo: false,
    recentLibraries: [],
    recentError: null,
    demoAccepted: false,

    repo: null,
    sessionId: null,
    graph: emptySnapshot(),
    loading: true,
    scanReport: null,
    scanState: "idle",
    scanError: null,

    selectedId: null,

    saveState: "idle",
    saveError: null,
    notice: null,
    busy: null,
    integrity: null,

    /* ------------------------------ 生命周期 ------------------------------ */

    async init() {
      set({ libraryState: "opening", loading: true });
      const controller = getLibraryController();
      set({ isDemo: controller.isDemo });

      // 会话可能在别处被换掉（例如控制器自己关库）：订阅一次，跟着走
      if (!subscribed) {
        subscribed = true;
        subscribeSession((session) => {
          if (!session) {
            if (get().sessionId !== null) void clearSessionState();
            return;
          }
          if (get().sessionId === session.sessionId) return;
          const gen = generation;
          void adopt(session, gen);
        });
      }

      await get().refreshRecent();

      const existing = getCurrentSession();
      if (existing && (await adopt(existing, generation))) return;

      const info = await controller.currentLibraryInfo().catch(() => null);
      if (info && (await get().openLibraryAt(info.rootPath))) return;

      if (controller.isDemo) {
        // 演示模式自动打开演示库：否则一进来就停在选择界面，什么都看不到
        if (await get().openDemoLibrary()) return;
      }

      set({ libraryState: "none", loading: false });
    },

    async refreshRecent() {
      try {
        const controller = getLibraryController();
        const list = await controller.listRecentLibraries();
        set({ recentLibraries: list, recentError: null, isDemo: controller.isDemo });
      } catch (err) {
        // 最近列表只是便利功能：读不到也要让人能手动打开文件夹
        console.error("[KnowledgeNet] 读取最近知识库失败", err);
        set({
          recentLibraries: [],
          recentError: `读取最近知识库失败：${describeError(err)}`,
        });
      }
    },

    setDemoAccepted() {
      set({ demoAccepted: true });
    },

    async openLibraryAt(rootPath, allowReadOnly = false) {
      const gen = ++generation;
      set({ libraryState: "opening", libraryError: null, loading: false });
      try {
        const session = await getLibraryController().openLibrary(rootPath, allowReadOnly);
        if (gen !== generation) {
          // 用户在这期间又换了库：这个会话已经没有用了
          void session.close().catch(() => undefined);
          return false;
        }
        setCurrentSession(session);
        const ok = await adopt(session, gen);
        if (ok) await get().refreshRecent();
        return ok;
      } catch (err) {
        return failOpen(gen, err);
      }
    },

    async openLibrary(rootPath, allowReadOnly = false) {
      return get().openLibraryAt(rootPath, allowReadOnly);
    },

    async openDemoLibrary() {
      const gen = ++generation;
      set({ libraryState: "opening", libraryError: null, loading: false });
      try {
        // 演示后端不区分路径：给一个标识即可，数据不会落成便携知识库
        const session = await getLibraryController().openLibrary("knowledgenet-demo");
        if (gen !== generation) {
          void session.close().catch(() => undefined);
          return false;
        }
        setCurrentSession(session);
        set({ demoAccepted: true });
        return await adopt(session, gen);
      } catch (err) {
        return failOpen(gen, err);
      }
    },

    async createLibrary(parentDir, name, title) {
      const gen = ++generation;
      set({ libraryState: "opening", libraryError: null, loading: false });
      try {
        const session = await getLibraryController().createLibrary(parentDir, name, title);
        if (gen !== generation) {
          void session.close().catch(() => undefined);
          return false;
        }
        setCurrentSession(session);
        const ok = await adopt(session, gen);
        if (ok) {
          get().notify("success", `已新建知识库「${session.info.title}」：${session.info.rootPath}`);
          await get().refreshRecent();
        }
        return ok;
      } catch (err) {
        return failOpen(gen, err);
      }
    },

    async pickDirectory(title) {
      try {
        return await getLibraryController().pickDirectory(title);
      } catch (err) {
        get().notify("error", `选择文件夹失败：${describeError(err)}`);
        return null;
      }
    },

    async pickFiles() {
      try {
        return await getLibraryController().pickFiles();
      } catch (err) {
        get().notify("error", `选择文件失败：${describeError(err)}`);
        return [];
      }
    },

    async closeLibrary() {
      generation += 1;
      /*
       * 先把会话标记清掉，再通知 session 层（它会同步失效旧会话并按需关闭）：
       * `setCurrentSession(null)` 会立刻触发订阅回调，而回调看到 `sessionId`
       * 已经是 null 就不会再清一遍。
       */
      set({ sessionId: null });
      setCurrentSession(null);
      await clearSessionState();
      await get().refreshRecent();
    },

    async removeRecentLibrary(path) {
      try {
        await getLibraryController().removeRecentLibrary(path);
        set({ recentLibraries: get().recentLibraries.filter((r) => r.path !== path) });
      } catch (err) {
        get().notify("error", `移除最近记录失败：${describeError(err)}`);
      }
    },

    resetToPicker() {
      set({ libraryState: "none", libraryError: null });
    },

    async refreshLibraryInfo() {
      const gen = generation;
      try {
        const info = await getLibraryController().currentLibraryInfo();
        if (gen !== generation || !info) return;
        set({ libraryInfo: info });
      } catch (err) {
        console.error("[KnowledgeNet] 读取知识库信息失败", err);
      }
    },

    /**
     * 运行中创建一致性副本。
     *
     * 复制期间源库必须停止接受新的写操作（Rust 端会冻结写队列），
     * 所以这里挂上 `busy`：界面据此禁用会与复制冲突的操作。
     */
    async createLibraryCopy(targetParentDir, name, mode) {
      const gen = generation;
      set({ busy: mode === "snapshot" ? "正在创建副本（快照）…" : "正在另存为独立知识库…" });
      try {
        const result = await getLibraryController().createLibraryCopy(
          targetParentDir,
          name,
          mode,
        );
        if (gen !== generation) return null;
        await get().refreshLibraryInfo();
        return result;
      } catch (err) {
        if (gen !== generation) return null;
        get().notify("error", `创建副本失败：${describeError(err)}`);
        return null;
      } finally {
        if (gen === generation) set({ busy: null });
      }
    },

    /* --------------------------- 扫描与修复 --------------------------- */

    async pullScan(full = false) {
      const repo = get().repo;
      if (!repo) return null;
      const gen = generation;
      set({ scanState: "scanning", scanError: null });
      try {
        const report = await repo.scanLibrary(full);
        if (gen !== generation) return null;
        // 图快照的 revision 是「最近一次扫描代次」：由仓储在重扫后给出
        const snapshot = await repo.loadGraph();
        if (gen !== generation) return null;
        applyGraph(snapshot);
        set({ scanReport: report, scanState: "idle", scanError: null });
        return report;
      } catch (err) {
        if (gen !== generation) return null;
        const message = describeError(err);
        console.error("[KnowledgeNet] 重新扫描失败", err);
        set({ scanState: "error", scanError: message });
        get().notify("error", `重新扫描失败：${message}`);
        return null;
      }
    },

    async adoptFolder(relativePath, title) {
      const result = await run("把文件夹设为知识点", (repo) =>
        repo.adoptFolderAsNode(relativePath, title),
      );
      if (!result.ok) return null;
      get().notify(
        "success",
        `已把「${result.value.folderName}」设为知识点：只写了元数据，文件夹里的文件没有动`,
      );
      set({ selectedId: result.value.id });
      return result.value;
    },

    async reassignDuplicate(relativePath) {
      const result = await run("给副本分配新 ID", (repo) =>
        repo.reassignDuplicateNodeId(relativePath),
      );
      if (!result.ok) return null;
      get().notify("success", `已给副本分配新 ID：「${result.value.title}」现在是独立节点`);
      return result.value;
    },

    duplicateGroups() {
      const fromReport = get().scanReport?.duplicateIds ?? [];
      if (fromReport.length > 0) return fromReport;
      // 没有报告时（例如还没扫描过）从图里现算：健康状态本来就是扫描给出的
      const groups = new Map<string, string[]>();
      for (const node of get().graph.nodes) {
        if (node.health !== "duplicate_id") continue;
        const list = groups.get(node.id);
        if (list) list.push(node.relativePath);
        else groups.set(node.id, [node.relativePath]);
      }
      return [...groups.entries()]
        .filter(([, paths]) => paths.length > 1)
        .map(([nodeId, relativePaths]) => ({ nodeId, relativePaths: relativePaths.sort() }));
    },

    openGraphOfNode(nodeId) {
      get().selectNode(nodeId);
      void get().enterNode(nodeId);
      useUiStore.getState().setMode("graph");
    },

    /* ------------------------------ 完整性与回收站 ------------------------------ */

    async checkIntegrity(deep) {
      const repo = get().repo;
      if (!repo) return null;
      const gen = generation;
      const previous = get().libraryState;
      const restore: LibraryState = previous === "readonly" ? "readonly" : "open";
      // 检查期间禁止与检查冲突的写操作（界面据此禁用按钮）
      set({
        libraryState: "repairing",
        busy: deep ? "正在深度检查…" : "正在快速检查…",
      });
      try {
        const report = await repo.checkIntegrity(deep);
        if (gen !== generation) return null;
        set({ integrity: report, busy: null, libraryState: restore });
        return report;
      } catch (err) {
        if (gen !== generation) return null;
        const message = describeError(err);
        set({ busy: null, libraryState: restore });
        get().notify("error", `${deep ? "深度" : "快速"}检查失败：${message}`);
        return null;
      }
    },

    async repairLibrary(actions) {
      const repo = get().repo;
      if (!repo) return null;
      const gen = generation;
      const previous = get().libraryState;
      const restore: LibraryState = previous === "readonly" ? "readonly" : "open";
      set({ libraryState: "repairing", busy: "正在修复…" });
      try {
        const result = await repo.repairLibrary(actions);
        if (gen !== generation) return null;
        set({ integrity: result.report, busy: null, libraryState: restore });
        // 修复可能改动图与文件；界面上的那份图要跟上
        await loadGraphFor(repo, gen);
        return result;
      } catch (err) {
        if (gen !== generation) return null;
        const message = describeError(err);
        set({ busy: null, libraryState: restore });
        get().notify("error", `修复失败：${message}`);
        return null;
      }
    },

    async listRemovedIdentities() {
      const repo = get().repo;
      if (!repo) return null;
      const gen = generation;
      try {
        const entries = await repo.listRemovedIdentities();
        if (gen !== generation) return null;
        return entries;
      } catch (err) {
        if (gen !== generation) return null;
        get().notify("error", `读取回收站失败：${describeError(err)}`);
        return null;
      }
    },

    async restoreNodeIdentity(nodeId) {
      const result = await run("恢复知识点", (repo) => repo.restoreNodeIdentity(nodeId));
      if (!result.ok) return;
      set({ selectedId: result.value.id });
      get().notify("success", `已恢复「${result.value.title}」的知识身份（文件一直在原位）`);
    },

    async purgeRemovedIdentity(nodeId) {
      const result = await run("永久清理元数据", (repo) => repo.purgeRemovedIdentity(nodeId));
      if (!result.ok) return false;
      get().notify(
        "info",
        "已永久清理回收站里的节点元数据：用户文件夹与其中的文件从未被删除。",
      );
      return true;
    },

    /* ---------------------------- 彻底删除与备份 ---------------------------- */

    async inspectNodeFolder(nodeId) {
      // 只读的体检：不走 `run`（那是写入口，只读知识库也要能先看清单再决定）
      const repo = get().repo;
      if (!repo) return null;
      const gen = generation;
      try {
        const usage = await repo.inspectNodeFolder(nodeId);
        if (gen !== generation) return null;
        return usage;
      } catch (err) {
        if (gen !== generation) return null;
        get().notify("error", `查看文件夹占用失败：${describeError(err)}`);
        return null;
      }
    },

    /**
     * 「备份文件夹中的资源」。
     *
     * 这是删除对话框里唯一的退路，所以提示必须带上**备份到哪儿了**：
     * 只说「已备份」等于让用户猜文件在哪。
     */
    async backupNodeResources(nodeId) {
      const result = await run("备份文件夹", (repo) => repo.backupNodeResources(nodeId));
      if (!result.ok) return null;
      const backup = result.value;
      get().notify(
        "success",
        `已把「${backup.title}」整个文件夹备份到 ${backup.backupPath}` +
          `（${backup.fileCount} 个文件，${formatBytes(backup.byteSize)}）`,
      );
      return backup;
    },

    /**
     * 彻底删除。
     *
     * 与「移除节点身份」的区别就是这一个动作的全部意义：那一个把文件夹留在磁盘上
     * （于是它变成一个谁也看不见、却还占着磁盘的文件夹），这一步连文件夹一起删掉。
     * 因此调用方（删除对话框）必须先说明后果并提供备份入口。
     */
    async eraseNode(nodeId) {
      const node = nodeMap(get().graph).get(nodeId);
      const result = await run("彻底删除节点", (repo) => repo.eraseNode(nodeId));
      if (!result.ok) return null;
      const erased = result.value;
      // 删掉的正是当前节点：选中与对话都要一起清掉，否则界面会停在一个不存在的节点上
      if (get().selectedId === nodeId) {
        set({ selectedId: null });
        void openChatNode(null);
      }
      get().notify(
        "info",
        `已彻底删除「${erased.title || node?.title || ""}」：文件夹与其中的 ` +
          `${erased.deletedFiles} 个文件（${formatBytes(erased.deletedBytes)}）已从磁盘上删除。`,
      );
      return erased;
    },

    async revealBackup(backupRelativePath) {
      const result = await run("打开备份目录", (repo) => repo.revealBackup(backupRelativePath));
      return result.ok;
    },

    /* -------------------------------- 交互 -------------------------------- */

    selectNode(nodeId) {
      set({ selectedId: nodeId });
      // 对话面板跟着切到该节点：只拉线程头，不读消息正文
      void openChatNode(nodeId);
    },

    async enterNode(nodeId) {
      set({ selectedId: nodeId });
      void openChatNode(nodeId);
      scheduleSessionSave();
    },

    async selectNodeAndEnter(nodeId) {
      // 显式「进入」某个节点：切换当前节点，但保持当前布局模式（设计 §7.1）
      await get().enterNode(nodeId);
    },

    notify(kind, text) {
      set({ notice: { id: ++noticeSeq, kind, text } });
    },

    dismissNotice() {
      set({ notice: null });
    },

    /* -------------------------------- 写入口 -------------------------------- */

    canWrite() {
      return get().libraryState === "open" && get().repo !== null && get().busy === null;
    },

    runWrite(label, fn, options) {
      if (!get().canWrite()) {
        const text = refuseText();
        get().notify("warn", text);
        return Promise.resolve({ ok: false as const, error: text });
      }
      return run(label, fn, options);
    },

    /* ----------------------------- 节点与关系 ----------------------------- */

    async createNode(title) {
      const result = await run("新建知识点", (repo) => repo.createNode({ title }));
      if (!result.ok) return null;
      /*
       * 建完就「进入」它：选中、打开它的对话，并**记住当前在看哪个节点**。
       * 只 set selectedId 是不够的——刷新或重启之后没有任何恢复依据，
       * 界面会退回空态，看起来像「刚建的节点丢了」。
       */
      await get().enterNode(result.value.node.id);
      get().notify(
        "success",
        `已新建知识点「${result.value.node.title}」：文件夹在 ${result.value.node.relativePath}`,
      );
      return result.value.node;
    },

    async updateNode(id, patch) {
      await run("保存知识点", (repo) => repo.updateNode(id, patch));
    },

    async setStatus(id, status) {
      const result = await run("更新学习状态", (repo) => repo.updateNode(id, { status }));
      // 保存失败时不要紧跟着宣布「已标记为…」
      if (!result.ok) return;
      const node = nodeMap(get().graph).get(id);
      if (node) get().notify("info", `「${node.title}」标记为${STATUS_LABEL[status]}`);
    },

    /** 返回实际落地的那批实体（新建/复用的节点），失败或形成循环时返回 null */
    async addPrerequisites(parentId, titles) {
      const clean = titles.map((t) => t.trim()).filter(Boolean);
      if (clean.length === 0) return null;

      const result = await run("新增前置知识", (repo) => repo.addPrerequisites(parentId, clean));
      if (!result.ok) return null;

      if (!result.value.ok) {
        // 循环依赖不阻断保存，但要明确告诉使用者循环在哪
        get().notify(
          "warn",
          `没有添加：会形成循环依赖 ${formatCycle(result.value.cycle, get().graph)}。` +
            `循环本身可以记录，但请先确认依赖方向是否写反了。`,
        );
        return null;
      }

      const payload = result.value.value;
      const parts: string[] = [];
      if (payload.created.length > 0) parts.push(`新建 ${payload.created.length} 个`);
      if (payload.reused.length > 0) {
        parts.push(
          `复用已有 ${payload.reused.length} 个（${payload.reused.map((n) => n.title).join("、")}）`,
        );
      }
      if (parts.length > 0) {
        get().notify("success", `已添加前置知识：${parts.join("，")}`);
      } else {
        // 这些知识点本来就已经挂在这个节点下面了。明确说一句，
        // 否则输入回车后界面毫无变化，会让人怀疑操作是不是没生效。
        get().notify("info", "这些前置知识已经在这里了，没有重复添加");
      }
      return payload;
    },

    async addEdge(fromId, toId) {
      const result = await run("建立依赖关系", (repo) => repo.addEdge(fromId, toId));
      if (!result.ok) return false;
      const graph = get().graph;
      if (!result.value.ok) {
        get().notify("warn", `不能连接：会形成循环依赖 ${formatCycle(result.value.cycle, graph)}`);
        return false;
      }
      const m = nodeMap(graph);
      get().notify(
        "success",
        `已连接：${m.get(fromId)?.title ?? ""} → ${m.get(toId)?.title ?? ""}`,
      );
      return true;
    },

    async mergeNodes(sourceId, targetId) {
      const graph = get().graph;
      const source = nodeMap(graph).get(sourceId);
      const target = nodeMap(graph).get(targetId);
      const result = await run("合并知识点", (repo) => repo.mergeNodes(sourceId, targetId));
      if (!result.ok) return;

      if (!result.value.ok) {
        // 合并会改动整张图的形状，和新增关系一样必须拒绝循环
        get().notify(
          "warn",
          `没有合并：会形成循环依赖 ${formatCycle(result.value.cycle, get().graph)}。` +
            `请确认这两个知识点是否真的重复，或先把依赖方向理清。`,
        );
        return;
      }

      const payload = result.value.value;
      set({ selectedId: targetId });
      void openChatNode(targetId);
      get().notify(
        "success",
        `已把「${source?.title}」合并进「${target?.title}」：转移 ${payload.movedEdges.length} 条关系，` +
          `去重 ${payload.droppedEdges.length} 条；对话、书签与来源已一并转移，` +
          `源文件夹与其中的文件原位保留`,
      );
    },

    /**
     * 从知识库移除节点身份（原「删除知识点」）。
     *
     * 文案必须说清「文件不会被删」：这是 v2 与 v1 最大的语义差别——
     * 用户以为自己在删文件夹，实际只是收回了 KnowledgeNet 的元数据。
     */
    async removeNodeIdentity(id) {
      const node = nodeMap(get().graph).get(id);
      if (!node) return;
      const result = await run("移除节点身份", (repo) => repo.removeNodeIdentity(id));
      if (!result.ok) return;
      set({ selectedId: null });
      void openChatNode(null);
      get().notify(
        "info",
        `已从知识库移除「${node.title}」的节点身份：文件夹与其中的文件都原位保留，` +
          `元数据进了回收站，可以随时恢复。`,
      );
    },

    async removeEdge(edgeId) {
      const graph = get().graph;
      const edge: DependencyEdge | undefined = graph.edges.find((e) => e.id === edgeId);
      const result = await run("断开依赖", (repo) => repo.removeEdge(edgeId));
      if (!result.ok) return;
      if (edge) {
        const m = nodeMap(graph);
        get().notify(
          "info",
          `已断开：${m.get(edge.fromId)?.title ?? "?"} → ${m.get(edge.toId)?.title ?? "?"}`,
        );
      }
    },

    async updateEdgeRelation(edgeId, relation) {
      await run("保存关系说明", (repo) => repo.updateEdgeRelation(edgeId, relation));
    },

    /* ---------------------------- 当前所在节点 ---------------------------- */

    async saveSession() {
      const { repo, selectedId } = get();
      if (!repo || !get().canWrite()) return;
      const gen = generation;
      try {
        await repo.saveSession(
          selectedId
            ? {
                id: `${get().libraryInfo?.libraryId ?? "library"}:session`,
                goalId: "",
                currentNodeId: selectedId,
                updatedAt: Date.now(),
              }
            : null,
        );
        if (gen !== generation) return;
        set({ saveState: "saved" });
      } catch (err) {
        const e = toRepositoryError(err);
        if (gen !== generation || e.code === "session_closed") return;
        // 后台写入失败也要如实反映，不能界面上显示「已保存」
        console.error("[KnowledgeNet] 记录当前位置失败", err);
        set({ saveState: "error", saveError: describeError(e) });
      }
    },

    setSaveError(message) {
      set({ saveState: "error", saveError: message });
    },
  };
});

/* --------------------------------- 辅助 --------------------------------- */

/** 把循环路径变成「A → B → C → A」这样的可读文本 */
export function formatCycle(cycle: string[], graph: GraphSnapshot): string {
  const m = nodeMap(graph);
  return cycle.map((id) => m.get(id)?.title ?? id).join(" → ");
}

/* ------------------------------- 派生选择器 ------------------------------- */


export function useSelectedNode(): KnowledgeNode | null {
  return useStore((s) => {
    if (!s.selectedId) return null;
    return s.graph.nodes.find((n) => n.id === s.selectedId) ?? null;
  });
}
