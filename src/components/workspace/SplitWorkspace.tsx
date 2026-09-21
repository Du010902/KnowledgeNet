/**
 * 分屏工作区
 *
 * 桌面横屏是「左 | 6px 分隔条 | 右」，窄窗口或竖屏改成上下堆叠（见设计文档 §7.3）。
 * 两种方向各存各的比例：横向存 `horizontalGraphRatio`，纵向存 `verticalGraphRatio`——
 * 把屏幕转过来时不该沿用另一条轴的比例。
 *
 * **左右顺序由 `splitOrder` 决定**：分屏是「在当前视图右侧再开一个」，
 * 因此从对话打开图谱时是「对话 | 图谱」，从图谱打开对话时是「图谱 | 对话」。
 * 比例存的仍然是「图谱占多少」，所以对话在左时列宽要反着算，
 * 拖拽方向也随之反转（见 ResizeHandle 的 `graphFirst`）。
 *
 * 比例用 `calc((100% - 6px) * ratio)` 表达，而不是 `ratio%`：
 * 分隔条自身占 6px，直接用百分比会让两侧加起来超过 100%，右侧被挤掉几个像素。
 *
 * 朝向按**容器**的长宽判断，而不是窗口：分屏容器才是真正被压缩的那个盒子，
 * 判据与 `uiStore.orientationFor` 一致（横屏且宽于 740px 才左右并排）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { clampRatio, DEFAULT_GRAPH_RATIO, layoutApi, useLayout, type SplitOrientation } from "./bridge";
import { ResizeHandle } from "./ResizeHandle";
import { SplitSlotContext } from "./splitSlot";

/** 分隔条宽度，与 styles.css 的 .resize-handle 保持一致 */
const HANDLE = "6px";

/** 与 uiStore 的 NARROW_BREAKPOINT 同一个数字：窄于它就没必要左右并排了 */
const NARROW_BREAKPOINT = 740;

export function SplitWorkspace({ graph, chat }: { graph: ReactNode; chat: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [orientation, setOrientation] = useState<SplitOrientation>("horizontal");

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setOrientation(width >= height && width >= NARROW_BREAKPOINT ? "horizontal" : "vertical");
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const horizontalRatio = useLayout((s) => s.horizontalGraphRatio);
  const verticalRatio = useLayout((s) => s.verticalGraphRatio);
  const graphFirst = useLayout((s) => s.splitOrder !== "chat-first");
  const stored = orientation === "horizontal" ? horizontalRatio : verticalRatio;
  const ratio = clampRatio(typeof stored === "number" ? stored : DEFAULT_GRAPH_RATIO);

  const setRatio = useLayout((s) => s.setRatio);
  const resetRatio = useLayout((s) => s.resetRatio);

  const graphTrack = `calc((100% - ${HANDLE}) * ${ratio})`;
  const flexibleTrack = "minmax(0, 1fr)";
  const style =
    orientation === "horizontal"
      ? {
          gridTemplateColumns: graphFirst
            ? `${graphTrack} ${HANDLE} ${flexibleTrack}`
            : `${flexibleTrack} ${HANDLE} ${graphTrack}`,
        }
      : {
          gridTemplateRows: graphFirst
            ? `${graphTrack} ${HANDLE} ${flexibleTrack}`
            : `${flexibleTrack} ${HANDLE} ${graphTrack}`,
        };

  const graphSlot = (
    <div className="split-slot" data-pane-slot="graph" data-slot-order={graphFirst ? 1 : 2}>
      <SplitSlotContext.Provider
        value={{ pane: "graph", maximize: () => layoutApi().maximizePane("graph") }}
      >
        {graph}
      </SplitSlotContext.Provider>
    </div>
  );

  const chatSlot = (
    <div className="split-slot" data-pane-slot="chat" data-slot-order={graphFirst ? 2 : 1}>
      <SplitSlotContext.Provider
        value={{ pane: "chat", maximize: () => layoutApi().maximizePane("chat") }}
      >
        {chat}
      </SplitSlotContext.Provider>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="split"
      data-orientation={orientation}
      data-split-order={graphFirst ? "graph-first" : "chat-first"}
      style={style}
    >
      {graphFirst ? graphSlot : chatSlot}

      <ResizeHandle
        orientation={orientation}
        ratio={ratio}
        /* 对话在左时，图谱在右侧：指针位置与「图谱占比」的换算要反过来 */
        graphFirst={graphFirst}
        onRatioChange={(next) => setRatio(orientation, next)}
        onReset={() => resetRatio(orientation)}
        label={
          orientation === "horizontal" ? "调整图谱与对话的宽度比例" : "调整图谱与对话的高度比例"
        }
      />

      {graphFirst ? chatSlot : graphSlot}
    </div>
  );
}
