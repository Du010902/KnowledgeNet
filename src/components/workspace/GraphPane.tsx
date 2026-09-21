/**
 * 图谱工作区
 *
 * 图谱独占时保留原来的全部能力：聚焦 / 空间两种观察方式、
 * 定位与适应窗口、节点选择与右键菜单、缩放与图例——这些都在 `GraphCanvas` 里，
 * 这里一个字都不重写，只负责外壳、「重新显示时的尺寸校正」与**观察方式**。
 *
 * 观察方式（空间 / 聚焦）由布局状态持有（`graphViewMode`，默认空间球体图），
 * 不再放在 `GraphCanvas` 的本地 state 里：切换视图会真正卸载另一半，
 * 本地 state 随之丢掉，用户每次都要重新点一次「空间」——那正是这次要修的问题。
 * 三维起不来的环境才自动降级到聚焦，并且明确说出原因。
 *
 * **隐藏时必须真的卸载**（见契约 §5.4）：Three.js 的渲染循环、布局 Worker 与
 * WebGL 上下文都在 `GraphCanvas → GraphUniverse/GraphSpace` 的卸载路径里释放。
 * 相机与节点坐标由 `graph3d/session.ts` 的会话缓存保留，重新显示时自动恢复，
 * 因此这里绝不调用 `dropSpaceCache()`——那会把「刚才看到哪」一并抹掉。
 */
import { useEffect, useRef } from "react";

import { GraphCanvas } from "@/components/GraphCanvas";
import { canRenderSpace } from "@/graph3d/engine";
import { layoutApi, useLayout, workspaceApi } from "./bridge";
import { useWorkspaceCommands } from "./commands";

export function GraphPane() {
  const ref = useRef<HTMLElement>(null);
  const commands = useWorkspaceCommands();
  const viewMode = useLayout((s) => s.graphViewMode);

  /*
   * 三维不可用时自动降级到二维聚焦，并说明原因。
   *
   * 只在这一个方向自动切换：能渲染时永远不替用户改回空间——
   * 那会让「我明明选了聚焦」在下次进入时被悄悄改掉。
   */
  useEffect(() => {
    if (viewMode !== "space" || canRenderSpace()) return;
    layoutApi().setGraphViewMode("focus");
    workspaceApi().notify(
      "warn",
      "当前环境不支持 WebGL 2，三维空间视图无法启动：已切回二维聚焦，功能不受影响。",
    );
  }, [viewMode]);

  /*
   * 尺寸校正。
   *
   * 图谱从「隐藏」回到「显示」时是重新挂载：Three.js 引擎在构造函数里量一次宿主尺寸。
   * 如果那一刻宿主还没拿到最终尺寸（切换模式的同一帧里），画布会停在 1×1。
   * 这里在尺寸从 0 变成有值时补一次 resize 广播，让渲染器按真实尺寸重来一遍。
   * 分屏拖拽过程中的连续重排由 GraphSpace / graph3d 各自的 ResizeObserver 处理。
   */
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      const wasEmpty = lastWidth === 0 || lastHeight === 0;
      lastWidth = width;
      lastHeight = height;
      if (wasEmpty && width > 0 && height > 0) {
        window.dispatchEvent(new Event("resize"));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={ref} className="main graph-pane" data-pane="graph" aria-label="图谱工作区">
      <GraphCanvas
        onOpenInspector={() => commands.openInspector()}
        viewMode={viewMode}
        onViewModeChange={(next) => layoutApi().setGraphViewMode(next)}
      />
    </section>
  );
}
