/**
 * 工作台命令上下文
 *
 * 契约要求这些组件「无 props」。但活动栏要打开抽屉、抽屉要开知识库弹窗、
 * 命令面板要切模式——这些入口如果各自去改 store，就会出现「谁负责渲染弹窗」
 * 的重复判断。用一个上下文把动作从外壳传下去：
 *
 * - 组件只声明「我要开命令面板」，不关心弹窗挂在哪；
 * - 外壳是唯一持有弹窗状态的地方，弹窗也就不会渲染两份；
 * - 组件仍然没有 props，可以直接放进任何位置。
 */
import { createContext, useContext, type ReactNode } from "react";

import type { InspectorTab, WorkspaceMode } from "./bridge";

export interface WorkspaceCommands {
  /** 知识库信息、创建副本、迁移、完整性检查 */
  openLibrary(): void;
  /** AI 设置（密钥、模型、长度上限、思考模式） */
  openAiSettings(): void;
  /** 命令面板：全部低频命令 */
  openPalette(): void;
  /** 把焦点送到活动栏抽屉里的搜索框（Ctrl/Cmd + K） */
  focusSearch(): void;
  /** 打开右侧检查器；`tab` 省略时保持上次的标签 */
  openInspector(tab?: InspectorTab): void;
  setMode(mode: WorkspaceMode): void;
}

/** 兜底实现：组件被单独渲染（测试、故事）时不该因为没有 Provider 而崩掉 */
const FALLBACK: WorkspaceCommands = {
  openLibrary: () => undefined,
  openAiSettings: () => undefined,
  openPalette: () => undefined,
  focusSearch: () => undefined,
  openInspector: () => undefined,
  setMode: () => undefined,
};

const CommandsContext = createContext<WorkspaceCommands>(FALLBACK);

export function WorkspaceCommandsProvider({
  value,
  children,
}: {
  value: WorkspaceCommands;
  children: ReactNode;
}) {
  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>;
}

export function useWorkspaceCommands(): WorkspaceCommands {
  return useContext(CommandsContext);
}
