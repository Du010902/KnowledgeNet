/**
 * 分屏分隔条
 *
 * 一个 6px 的可拖拽 / 可聚焦分隔条，键盘也能完整操作：
 * 方向键 2%，Shift + 方向键 10%，Home / End 到 25% / 75%，双击回到默认比例。
 *
 * 三个刻意的选择：
 * 1. 用 Pointer Events + `setPointerCapture`，而不是 mouse + touch 两套。
 *    捕获之后指针移出分隔条、移出窗口都不会丢事件，拖拽不会「粘住」。
 * 2. 拖拽比例按**容器**尺寸算，并夹在 25%~75%：任何一侧都不允许被压成一条缝——
 *    压没了就再也拖不回来，那是不可恢复的状态。
 * 3. `aria-orientation` 说的是分隔条自己的方向，不是分屏的方向：
 *    左右并排时分隔条是竖的（vertical），上下堆叠时是横的（horizontal）。
 */
import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from "react";

import { clampRatio, MAX_RATIO, MIN_RATIO, type SplitOrientation } from "./bridge";

/** 一次方向键的步长；按住 Shift 时走大步 */
const STEP = 0.02;
const STEP_LARGE = 0.1;

export function ResizeHandle({
  orientation,
  ratio,
  graphFirst = true,
  onRatioChange,
  onReset,
  label,
}: {
  orientation: SplitOrientation;
  /** 图谱占的比例（与持久化的字段同名同义，与它在哪一侧无关） */
  ratio: number;
  /** 图谱是不是左（上）侧那一格：决定拖拽与方向键的方向 */
  graphFirst?: boolean;
  onRatioChange: (ratio: number) => void;
  onReset: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  /** 分隔条自身的方向，与「分屏方向」相反 */
  const separatorOrientation = orientation === "horizontal" ? "vertical" : "horizontal";

  /** 按指针位置算出「图谱占多少」：对话在左时位置与占比相反 */
  const ratioFromPointer = useCallback(
    (clientX: number, clientY: number): number | null => {
      const container = ref.current?.parentElement;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const share =
        orientation === "horizontal"
          ? rect.width > 0
            ? (clientX - rect.left) / rect.width
            : null
          : rect.height > 0
            ? (clientY - rect.top) / rect.height
            : null;
      if (share === null) return null;
      return clampRatio(graphFirst ? share : 1 - share);
    },
    [orientation, graphFirst],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const next = ratioFromPointer(e.clientX, e.clientY);
    if (next !== null) onRatioChange(next);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  /**
   * 键盘调整。
   *
   * 两个轴的方向键都接受：左右分屏时有人习惯按上下（「往后挪一点」），
   * 拦下来什么都不做反而像坏了。统一规则：指向「图谱那一侧的增长方向」即变大——
   * 图谱在左时是向右/向下，图谱在右（对话在左）时是向左/向上。
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP_LARGE : STEP;
    // 图谱在左（上）时向右/向下是变大；图谱在右（下）时反过来
    const grow = graphFirst
      ? e.key === "ArrowRight" || e.key === "ArrowDown"
      : e.key === "ArrowLeft" || e.key === "ArrowUp";
    const shrink = graphFirst
      ? e.key === "ArrowLeft" || e.key === "ArrowUp"
      : e.key === "ArrowRight" || e.key === "ArrowDown";

    if (grow || shrink) {
      e.preventDefault();
      onRatioChange(clampRatio(ratio + (grow ? step : -step)));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      onRatioChange(MIN_RATIO);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      onRatioChange(MAX_RATIO);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onReset();
    }
  };

  const percent = Math.round(clampRatio(ratio) * 100);

  return (
    <div
      ref={ref}
      className="resize-handle"
      data-resize-handle={orientation}
      role="separator"
      tabIndex={0}
      aria-orientation={separatorOrientation}
      aria-label={label}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      aria-valuenow={percent}
      aria-valuetext={`图谱 ${percent}%，对话 ${100 - percent}%`}
      title="拖动调整比例 · 方向键微调 · Shift + 方向键大步 · 双击复位"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="resize-grip" aria-hidden="true" />
    </div>
  );
}
