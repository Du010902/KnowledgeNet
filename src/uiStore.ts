/**
 * 工作台布局状态（独立 store）
 *
 * 为什么必须是**独立的 store**（契约 §5.3、设计 §7.7）：
 * 聊天流式生成会以每个 token 的频率更新 `chatStore`，图谱与外壳只关心
 * 「当前是对话/分屏/图谱」这类布局事实。两者放在同一个 store 里，
 * 就意味着每来一个 token 都要重新计算一次外壳与画布的渲染，GPU 与 React 都不划算。
 * 因此这里只放布局，且**不 import store / chatStore**（保持依赖单向）。
 *
 * 持久化按 `libraryId` 分区（`knowledgenet.workspace.<libraryId>`）：
 * 同一台机器上不同的库各有各的布局，换库不会互相覆盖。
 */
import { create } from "zustand";

import { readWorkspaceLayout, writeWorkspaceLayout, type WorkspaceLayoutSnapshot } from "@/data/deviceSettings";

export type WorkspaceMode = "chat" | "split" | "graph";
export type SplitOrientation = "horizontal" | "vertical";
export type NavDrawerKind = "search";
export type InspectorTab = "detail" | "notes" | "resources";
export type WorkspacePane = "graph" | "chat";
/** 图谱的两种观察方式：空间（球体，默认）与聚焦（二维一跳） */
export type GraphViewMode = "focus" | "space";
/**
 * 分屏里哪一侧在左（横屏）/ 上（竖屏）。
 *
 * 分屏是「在当前视图右侧再开一个」，因此顺序由**打开时所在的视图**决定：
 * 从对话打开图谱 → 对话在左、图谱在右；从图谱打开对话 → 图谱在左、对话在右。
 * 写进布局状态是为了刷新/切视图后不再跳变（验收清单第 4 条）。
 */
export type SplitOrder = "graph-first" | "chat-first";

export interface WorkspaceLayoutState {
  mode: WorkspaceMode;
  previousSplitMode: boolean;
  /** 分屏时图谱占的比例（横向） */
  horizontalGraphRatio: number;
  /** 分屏时图谱占的比例（纵向，窄窗口/竖屏） */
  verticalGraphRatio: number;
  /** 图谱观察方式：默认空间球体图，用户主动切到聚焦后才记住聚焦 */
  graphViewMode: GraphViewMode;
  /** 分屏左右（上下）顺序 */
  splitOrder: SplitOrder;
  navDrawer: NavDrawerKind | null;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  threadListOpen: boolean;
  maximizedPane: WorkspacePane | null;
  commandPaletteOpen: boolean;
}

/** 分隔条比例范围与默认值（设计 §7.3：两侧最小 25%，默认图谱 42%） */
export const MIN_PANE_RATIO = 0.25;
export const MAX_PANE_RATIO = 0.75;
export const DEFAULT_GRAPH_RATIO = 0.42;

/** 分隔条键盘调整步长：方向键 2%，Shift + 方向键 10% */
export const RATIO_STEP = 0.02;
export const RATIO_STEP_LARGE = 0.1;

const MODES: WorkspaceMode[] = ["chat", "split", "graph"];
const DRAWERS: NavDrawerKind[] = ["search"];
const TABS: InspectorTab[] = ["detail", "notes", "resources"];
const SPLIT_ORDERS: SplitOrder[] = ["graph-first", "chat-first"];

/**
 * 侧边栏上次停在哪一页。
 *
 * 只活在本次会话里：它是「关掉再打开回到刚才那一页」的手感，
 * 不是需要落盘的布局事实（落盘的是当前开着哪一页，见两个布尔字段）。
 */
let lastSidePanelTab: "threads" | "context" = "threads";

export function clampRatio(value: unknown, fallback = DEFAULT_GRAPH_RATIO): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, value));
}

/**
 * 把磁盘上那份（可能是旧版本、可能被手工改坏的）布局夹取成合法状态。
 *
 * 这里刻意逐字段校验而不是 `{...defaults, ...persisted}`：一个 `mode: "???"`
 * 会让整个工作区渲染不出来，宁可回落到默认布局。
 *
 * 两个新增字段对旧数据必须**向后兼容**：
 * - `graphViewMode` 缺省是 `space`（产品要求图谱默认就是球体空间图），
 *   只有当用户明确选过 `focus` 时才保持聚焦；
 * - `splitOrder` 缺省是 `graph-first`，那正是旧版本分屏的样子。
 */
export function normalizeLayout(
  persisted: Partial<WorkspaceLayoutState> | null | undefined,
): WorkspaceLayoutState {
  const raw = persisted ?? {};
  return {
    mode: MODES.includes(raw.mode as WorkspaceMode) ? (raw.mode as WorkspaceMode) : "chat",
    previousSplitMode: raw.previousSplitMode === true,
    horizontalGraphRatio: clampRatio(raw.horizontalGraphRatio),
    verticalGraphRatio: clampRatio(raw.verticalGraphRatio),
    graphViewMode: raw.graphViewMode === "focus" ? "focus" : "space",
    splitOrder: SPLIT_ORDERS.includes(raw.splitOrder as SplitOrder)
      ? (raw.splitOrder as SplitOrder)
      : "graph-first",
    navDrawer: DRAWERS.includes(raw.navDrawer as NavDrawerKind)
      ? (raw.navDrawer as NavDrawerKind)
      : null,
    inspectorOpen: raw.inspectorOpen === true,
    inspectorTab: TABS.includes(raw.inspectorTab as InspectorTab)
      ? (raw.inspectorTab as InspectorTab)
      : "detail",
    threadListOpen: raw.threadListOpen === true,
    maximizedPane:
      raw.maximizedPane === "graph" || raw.maximizedPane === "chat" ? raw.maximizedPane : null,
    commandPaletteOpen: raw.commandPaletteOpen === true,
  };
}

export interface UiState extends WorkspaceLayoutState {
  /** 当前绑定的知识库 ID：布局按它分区持久化；null 表示还没有打开知识库 */
  layoutLibraryId: string | null;

  setMode(mode: WorkspaceMode): void;
  setRatio(orientation: SplitOrientation, ratio: number): void;
  /** 按步长微调（键盘操作）；`large` 为 true 时用 Shift 的大步长 */
  nudgeRatio(orientation: SplitOrientation, direction: -1 | 1, large?: boolean): void;
  resetRatio(orientation: SplitOrientation): void;
  maximizePane(pane: WorkspacePane): void;
  restoreSplit(): void;
  /** 图谱观察方式：空间（默认）/ 聚焦 */
  setGraphViewMode(mode: GraphViewMode): void;
  /**
   * 在**当前视图右侧**打开另一个视图（分屏）。
   *
   * 当前所在的视图保持在原位，另一半出现在右侧；顺序写进 `splitOrder`，
   * 因此从对话打开图谱时图谱在右、从图谱打开对话时对话在右。
   */
  openSidePane(): void;
  /** 收起侧边窗格：回到 `splitOrder` 里那个主窗格 */
  closeSidePane(): void;
  /** 分屏的主窗格（左侧/上方那一个） */
  primaryPane(): WorkspacePane;
  /**
   * 侧边栏（对话 / 脉络 两个页签）的总开关。
   *
   * 开着就关；关着就打开**上次用的那一页**（第一次用是「对话」）。
   * 边栏只有一个入口，页签之间的切换交给栏顶那两个按钮。
   */
  toggleSidePanel(): void;
  setNavDrawer(kind: NavDrawerKind | null): void;
  setInspectorOpen(open: boolean): void;
  setInspectorTab(tab: InspectorTab): void;
  setThreadListOpen(open: boolean): void;
  setCommandPaletteOpen(open: boolean): void;
  /** 切库/关库：绑定到新的 libraryId，并立刻读回它的布局 */
  attachLibrary(libraryId: string | null): void;
  /** 用持久化的那份覆盖当前布局（组件在会话就绪后调用） */
  hydrateLayout(persisted: Partial<WorkspaceLayoutState> | null | undefined, libraryId?: string | null): void;
  /** 当前布局的可序列化快照（写回设备设置用） */
  snapshotLayout(): WorkspaceLayoutState;
}

const initialState: WorkspaceLayoutState & { layoutLibraryId: string | null } = {
  ...normalizeLayout(null),
  layoutLibraryId: null,
};

export const useUiStore = create<UiState>((set, get) => {
  /** 把布局写回设备设置（按 libraryId 分区）；失败不影响界面 */
  function persist(): void {
    const state = get();
    writeWorkspaceLayout(state.layoutLibraryId, {
      mode: state.mode,
      previousSplitMode: state.previousSplitMode,
      horizontalGraphRatio: state.horizontalGraphRatio,
      verticalGraphRatio: state.verticalGraphRatio,
      graphViewMode: state.graphViewMode,
      splitOrder: state.splitOrder,
      navDrawer: state.navDrawer,
      inspectorOpen: state.inspectorOpen,
      inspectorTab: state.inspectorTab,
      threadListOpen: state.threadListOpen,
      maximizedPane: state.maximizedPane,
      commandPaletteOpen: state.commandPaletteOpen,
    } satisfies WorkspaceLayoutSnapshot);
  }

  /** 只改布局的快捷写法：改完顺手持久化 */
  function apply(patch: Partial<WorkspaceLayoutState>): void {
    set(patch);
    persist();
  }

  /** 当前所在的单个视图：分屏时按主窗格算，其它情况就是 mode 本身 */
  function currentPane(): WorkspacePane {
    const state = get();
    if (state.mode === "graph") return "graph";
    if (state.mode === "chat") return "chat";
    return state.splitOrder === "chat-first" ? "chat" : "graph";
  }

  return {
    ...initialState,

    setMode(mode) {
      const previous = get().mode;
      /*
       * 直接切到分屏（旧设备状态、快捷键、命令面板都可能这么调）时，
       * 顺序按「当前所在的视图留在原位」推导，与菜单入口一致。
       */
      const splitOrder =
        mode === "split" && previous !== "split"
          ? previous === "graph"
            ? "graph-first"
            : "chat-first"
          : get().splitOrder;
      apply({
        mode,
        splitOrder,
        // 离开分屏时记住「刚才在分屏」：最大化某个 pane 之后按 Esc 才能回到分屏
        previousSplitMode: previous === "split" ? true : get().previousSplitMode,
        maximizedPane: null,
      });
    },

    setRatio(orientation, ratio) {
      apply(
        orientation === "vertical"
          ? { verticalGraphRatio: clampRatio(ratio) }
          : { horizontalGraphRatio: clampRatio(ratio) },
      );
    },

    nudgeRatio(orientation, direction, large = false) {
      const step = large ? RATIO_STEP_LARGE : RATIO_STEP;
      const current =
        orientation === "vertical" ? get().verticalGraphRatio : get().horizontalGraphRatio;
      get().setRatio(orientation, current + direction * step);
    },

    resetRatio(orientation) {
      get().setRatio(orientation, DEFAULT_GRAPH_RATIO);
    },

    maximizePane(pane) {
      apply({
        maximizedPane: pane,
        previousSplitMode: get().mode === "split" ? true : get().previousSplitMode,
        mode: pane === "graph" ? "graph" : "chat",
      });
    },

    restoreSplit() {
      apply({ maximizedPane: null, mode: "split" });
    },

    setGraphViewMode(mode) {
      apply({ graphViewMode: mode });
    },

    openSidePane() {
      /*
       * 当前视图留在原位：它在左（上），另一半出现在右（下）。
       * 顺序完全由「现在在哪一侧」决定，因此不需要调用方再传一个「打开谁」——
       * 传错了就会出现「说在右边、实际跑到左边」那类自相矛盾的状态。
       */
      const primary = currentPane();
      apply({
        mode: "split",
        splitOrder: primary === "graph" ? "graph-first" : "chat-first",
        maximizedPane: null,
        previousSplitMode: true,
      });
    },

    closeSidePane() {
      apply({
        mode: get().splitOrder === "chat-first" ? "chat" : "graph",
        maximizedPane: null,
      });
    },

    primaryPane() {
      return get().splitOrder === "chat-first" ? "chat" : "graph";
    },

    setNavDrawer(kind) {
      apply({ navDrawer: kind });
    },

    /*
     * 侧边栏只有一条，里面有两个页签：对话（线程列表）与脉络（详情/笔记/资料）。
     *
     * 两个布尔字段因此是**互斥**的：打开其中一个就把另一个关掉，侧边栏据此
     * 决定顶部哪个页签处于选中态。持久化字段保持不变（旧设备状态照样能读）。
     */
    setInspectorOpen(open) {
      if (open) lastSidePanelTab = "context";
      apply(open ? { inspectorOpen: true, threadListOpen: false } : { inspectorOpen: false });
    },

    setInspectorTab(tab) {
      lastSidePanelTab = "context";
      apply({ inspectorTab: tab, inspectorOpen: true, threadListOpen: false });
    },

    setThreadListOpen(open) {
      if (open) lastSidePanelTab = "threads";
      apply(open ? { threadListOpen: true, inspectorOpen: false } : { threadListOpen: false });
    },

    toggleSidePanel() {
      const state = get();
      if (state.threadListOpen || state.inspectorOpen) {
        apply({ threadListOpen: false, inspectorOpen: false });
        return;
      }
      if (lastSidePanelTab === "context") {
        apply({ inspectorOpen: true, threadListOpen: false });
        return;
      }
      apply({ threadListOpen: true, inspectorOpen: false });
    },

    setCommandPaletteOpen(open) {
      apply({ commandPaletteOpen: open });
    },

    attachLibrary(libraryId) {
      if (get().layoutLibraryId === libraryId) return;
      const persisted = readWorkspaceLayout(libraryId);
      set({ layoutLibraryId: libraryId ?? null, ...normalizeLayout(persisted) });
    },

    hydrateLayout(persisted, libraryId) {
      if (libraryId !== undefined) {
        set({ layoutLibraryId: libraryId ?? null, ...normalizeLayout(persisted) });
        return;
      }
      set(normalizeLayout(persisted));
    },

    snapshotLayout() {
      const state = get();
      return {
        mode: state.mode,
        previousSplitMode: state.previousSplitMode,
        horizontalGraphRatio: state.horizontalGraphRatio,
        verticalGraphRatio: state.verticalGraphRatio,
        graphViewMode: state.graphViewMode,
        splitOrder: state.splitOrder,
        navDrawer: state.navDrawer,
        inspectorOpen: state.inspectorOpen,
        inspectorTab: state.inspectorTab,
        threadListOpen: state.threadListOpen,
        maximizedPane: state.maximizedPane,
        commandPaletteOpen: state.commandPaletteOpen,
      };
    },
  };
});

/** 窄窗口不显示硬分屏（设计 §7.3）：退化为对话/图谱切换 */
export const NARROW_BREAKPOINT = 740;

export function isNarrowViewport(width: number): boolean {
  return width < NARROW_BREAKPOINT;
}

/** 组件里常用的派生值：实际生效的分屏朝向 */
export function orientationFor(width: number, height: number): SplitOrientation {
  return width >= height && width >= NARROW_BREAKPOINT ? "horizontal" : "vertical";
}
