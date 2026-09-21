/**
 * 分屏窗格上下文
 *
 * 分屏时每一侧都需要一个「最大化这一侧」的入口（Esc 回到分屏）。
 * 原来它是一颗 `position: absolute` 浮在每个窗格右上角的按钮，
 * 而右上角正是各窗格自己的顶栏按钮所在的位置——图谱工具栏的「视图设置 / ＋」
 * 和对话上下文栏的「节点操作」都被它压住了一半。
 *
 * 现在改成：分屏容器把「我这是哪一侧、最大化做什么」通过 context 交给窗格，
 * 由窗格**在自己的顶栏里**多渲染一颗普通按钮。不再有任何浮层去撞别的控件，
 * 按钮的位置、间距、悬停态也就自动跟顶栏里其余按钮一致。
 */
import { createContext, useContext } from "react";

export interface SplitSlot {
  pane: "graph" | "chat";
  maximize(): void;
}

export const SplitSlotContext = createContext<SplitSlot | null>(null);

/** 不在分屏里时返回 null：调用方据此决定「要不要渲染这颗按钮」 */
export function useSplitSlot(): SplitSlot | null {
  return useContext(SplitSlotContext);
}
