/**
 * 工作台外壳（default export，无 props）
 *
 * 从「固定三栏」改成「以对话为默认主工作区」，再按《工作台 UI 审查与重构规范》
 * 收成两层：全局栏 + 工作区（活动栏已并入全局栏的搜索入口）。
 *
 * ```text
 * ┌──────────────────────────────────────────────────────────────┐
 * │ 全局栏：品牌/知识库      [对话][图谱][⧉]      搜索 状态 主题 设置 │
 * ├──────────────────────────────────────────────────────────────┤
 * │ 对话独占 / 可拖拽分屏（图谱 | 对话）/ 图谱独占                  │
 * └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * 关键约束（契约 §5.4）：
 * - 对话模式只挂 `ConversationPane`，图谱模式只挂 `GraphPane`：
 *   **图谱隐藏时必须真的卸载**，Three.js 渲染循环、布局 Worker 与 WebGL 上下文
 *   都随卸载释放；重新显示时靠 `graph3d/session.ts` 的会话缓存恢复相机与坐标。
 *   因此这里从不调用 `dropSpaceCache()`，切模式不会丢相机、当前节点与当前线程。
 * - 宽度 < 740px 不显示硬分屏，退化为对话 / 图谱切换。
 * - 布局（模式、两种比例、线程列表开合）按 `libraryId` 记在这台设备上。
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { AiSettingsDialog } from "@/components/AiSettingsDialog";
import { Header } from "@/components/Header";
import { LibraryDialog } from "@/components/LibraryDialog";
import { AI_SETTINGS_EVENT, LIBRARY_DIALOG_EVENT } from "@/components/nodeContextMenu";
import {
  layoutApi,
  useLayout,
  useNarrowLayout,
  useWorkspace,
  type MaximizedPane,
  type WorkspaceLayoutState,
} from "./bridge";
import { CommandPalette } from "./CommandPalette";
import { WorkspaceCommandsProvider, type WorkspaceCommands } from "./commands";
import { ConversationPane } from "./ConversationPane";
import { NavigationDrawer } from "./NavigationDrawer";
import { SidePanel } from "./SidePanel";
import { SplitWorkspace } from "./SplitWorkspace";
import { useEscape } from "./useEscape";

/*
 * 图谱工作区按需加载。
 *
 * 它把 Three.js、布局 Worker 与整套三维渲染都拖进首屏包（生产构建里主 chunk
 * 约 2MB，其中一大半是三维代码），而「只用对话」的人一个字节都用不上
 * （验收清单 P2-8）。`React.lazy` 把它切成独立 chunk：第一次切到图谱时才拉。
 *
 * 布局状态与相机缓存都在 `graph3d/session.ts` 与 uiStore 里，不在这个模块里，
 * 因此「延迟一点加载」不会丢任何观看状态。
 */
const GraphPane = lazy(async () => {
  const mod = await import("./GraphPane");
  return { default: mod.GraphPane };
});

/** 首次拉取三维代码时的占位：说明在做什么，而不是留一块空白 */
function GraphLoading() {
  return (
    <section className="main graph-pane" data-pane="graph" aria-label="图谱工作区">
      <div className="graph-loading" role="status">
        <span className="spinner" />
        <p>正在载入图谱…</p>
      </div>
    </section>
  );
}

export default function WorkspaceShell() {
  const narrow = useNarrowLayout();
  const mode = useLayout((s) => s.mode);
  const maximized = useLayout((s) => s.maximizedPane);
  const shellRef = useRef<HTMLDivElement>(null);

  const libraryId = useWorkspace((s) => s.libraryInfo?.libraryId ?? null);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  /*
   * 把「顶栏底边」的位置写进 `--shell-top`。
   *
   * 抽屉、检查器与它们的遮罩都是浮在整页之上的（portal 到 body），
   * 因此不能靠父元素的布局定位。库状态条出现时顶栏会整体下移，
   * 写死 62px 就会让浮层压住顶栏的一半——量一次比猜一个数字可靠。
   */
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const sync = () => {
      const topbar = el.querySelector(".topbar");
      const bottom = topbar ? Math.round(topbar.getBoundingClientRect().bottom) : 62;
      document.documentElement.style.setProperty("--shell-top", `${bottom}px`);
    };
    sync();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", sync);
      return () => {
        window.removeEventListener("resize", sync);
        document.documentElement.style.removeProperty("--shell-top");
      };
    }
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--shell-top");
    };
  }, []);

  /* ------------------------------- 命令入口 ------------------------------- */

  const commands = useMemo<WorkspaceCommands>(
    () => ({
      openLibrary: () => setLibraryOpen(true),
      openAiSettings: () => setAiOpen(true),
      openPalette: () => layoutApi().setCommandPaletteOpen(true),
      focusSearch: () => layoutApi().setNavDrawer("search"),
      openInspector: (tab) => {
        if (tab) layoutApi().setInspectorTab(tab);
        layoutApi().setInspectorOpen(true);
      },
      setMode: (next) => layoutApi().setMode(next),
    }),
    [],
  );

  /*
   * AI 设置弹窗由外壳渲染：顶栏按钮与对话里的「去设置」都只发一个事件，
   * 谁触发都不用把弹窗提到 App，App 也就不必认识 AI 设置的状态。
   * 知识库弹窗同理——库状态条在外壳之外，但它也要能打开同一个弹窗。
   */
  useEffect(() => {
    const openAi = () => setAiOpen(true);
    const openLibrary = () => setLibraryOpen(true);
    window.addEventListener(AI_SETTINGS_EVENT, openAi);
    window.addEventListener(LIBRARY_DIALOG_EVENT, openLibrary);
    return () => {
      window.removeEventListener(AI_SETTINGS_EVENT, openAi);
      window.removeEventListener(LIBRARY_DIALOG_EVENT, openLibrary);
    };
  }, []);

  /* ------------------------------- 快捷键 ------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      // Ctrl/Cmd + Shift + P：全部命令
      if (e.shiftKey && key === "p") {
        e.preventDefault();
        layoutApi().setCommandPaletteOpen(true);
        return;
      }
      // Ctrl/Cmd + K：节点搜索（契约要求保留）
      if (!e.shiftKey && key === "k") {
        e.preventDefault();
        layoutApi().setNavDrawer("search");
        return;
      }
      // Ctrl/Cmd + 1/2/3：三种模式
      if (!e.shiftKey && (key === "1" || key === "2" || key === "3")) {
        e.preventDefault();
        const target = key === "1" ? "chat" : key === "2" ? "split" : "graph";
        if (!(target === "split" && narrow)) layoutApi().setMode(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow]);

  // 最大化之后 Esc 回到此前的分屏；浮层开着时由浮层自己先响应（见 useEscape 的层叠规则）
  useEscape(maximized !== null, () => layoutApi().restoreSplit());

  /* ------------------------------ 布局持久化 ------------------------------ */

  /*
   * 布局按 `libraryId` 分区记住「上次用的模式与比例」。
   *
   * 读写都由 uiStore 负责（它绑定 `knowledgenet.workspace.<libraryId>`）：
   * 工作台只在切库时通知它一声，不自己碰存储，避免两处各写一份、
   * 互相覆盖成「上一次的比例」。
   */
  useEffect(() => {
    layoutApi().attachLibrary?.(libraryId);
  }, [libraryId]);

  /* -------------------------------- 渲染 -------------------------------- */

  const pane = paneOf({ mode, maximizedPane: maximized }, narrow);
  /** 懒加载的图谱：占位与真正的内容都从这里进，Suspense 只包一次 */
  const graph = (
    <Suspense fallback={<GraphLoading />}>
      <GraphPane />
    </Suspense>
  );

  return (
    <WorkspaceCommandsProvider value={commands}>
      <div className="shell" ref={shellRef}>
        <Header />
        <div className="workspace" data-workspace-mode={mode} data-pane={pane}>
          <div className="workspace-area" data-pane={pane}>
            {pane === "split" ? (
              <SplitWorkspace graph={graph} chat={<ConversationPane />} />
            ) : pane === "graph" ? (
              graph
            ) : (
              <ConversationPane />
            )}
            {narrow && mode === "split" && (
              <p className="narrow-hint" role="status">
                窗口过窄，已退化为单窗格：用顶栏的「对话 / 图谱」切换。
              </p>
            )}
          </div>
        </div>
      </div>

      <NavigationDrawer />
      {/*
        侧边栏：对话 / 分屏时它挂在对话工作区里（一列，不遮正文，见 ConversationPane）；
        图谱独占时没有「对话列」可依附，就在这里浮在左侧。
      */}
      {pane === "graph" && <SidePanel variant="overlay" />}
      <CommandPalette />

      {libraryOpen && <LibraryDialog onClose={() => setLibraryOpen(false)} />}
      {aiOpen && <AiSettingsDialog onClose={() => setAiOpen(false)} />}
    </WorkspaceCommandsProvider>
  );
}

/** 供测试与脚本读取「现在应该在哪个 pane」的纯函数版本 */
export function paneOf(
  layout: Pick<WorkspaceLayoutState, "mode" | "maximizedPane">,
  narrow: boolean,
): MaximizedPane | "split" {
  if (layout.maximizedPane) return layout.maximizedPane;
  if (layout.mode === "split") return narrow ? "chat" : "split";
  return layout.mode === "graph" ? "graph" : "chat";
}
