/**
 * 全局栏：品牌、知识库、主视图、搜索、状态与设置
 *
 * 《工作台 UI 审查与重构规范》§3：**全局栏只放跨知识点仍然成立的内容**——
 * 品牌、知识库、主视图标签、搜索、保存状态、主题与设置。
 * 当前知识点属于页面，已经交给上下文栏（`NodeContextBar`）与图谱工具栏，
 * 这里不再放第二份「当前节点」胶囊。
 *
 * 三条与此前不同的取舍：
 *
 * 1. **搜索在这里**，不在左侧活动栏。活动栏是一整条纵栏只放一个入口，
 *    空间成本与使用频率不匹配；抽屉本身（`NavigationDrawer`）与
 *    Ctrl/Cmd + K 一个字都没改，只是触发点搬到了全局栏。
 * 2. **没有「全部命令」三点按钮**。含义模糊的兜底入口不承担信息架构，
 *    命令面板仍在 Ctrl/Cmd + Shift + P 上（`CommandPalette` 原样保留）。
 * 3. **主视图是标签**（对话 / 图谱），「分屏」是呈现方式，作为标签右侧的
 *    「在侧边打开」出现——能力完全保留，只是不再伪装成第三个主任务。
 *
 * 组件不判断窗口宽度：窄屏收起哪些文字全部由 CSS 断点决定，
 * 断点判断只该有一份，写在样式里。
 */
import { useSyncExternalStore } from "react";

import { Icon } from "@/components/icons";
import { requestAiSettings } from "@/components/nodeContextMenu";
import { WorkspaceModeSwitcher } from "@/components/workspace/WorkspaceModeSwitcher";
import { useWorkspaceCommands } from "@/components/workspace/commands";
import { layoutApi, useWorkspace } from "@/components/workspace/bridge";
import { HealthIcon } from "@/components/workspace/NodeHealthNotice";
import type { SaveState } from "@/store";
import { resolvedTheme, subscribeTheme, themeLabel, toggleTheme } from "@/theme";
import type { ResolvedTheme } from "@/theme";

/** 进行中的状态才有文案；空闲时这一格显示「已就绪」 */
const SAVE_LABEL: Record<SaveState, string | null> = {
  idle: null,
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

/**
 * 订阅「当前实际生效」的主题。
 *
 * 图标要表达「点一下会变成哪一档」，跟随系统时系统主题一换，图标就该跟着换。
 */
function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, resolvedTheme, resolvedTheme);
}

export function Header() {
  const commands = useWorkspaceCommands();
  const info = useWorkspace((s) => s.libraryInfo);
  const saveState = useWorkspace((s) => s.saveState);
  const saveError = useWorkspace((s) => s.saveError);
  const readOnly = useWorkspace((s) => s.libraryState === "readonly");
  const isDemo = useWorkspace((s) => s.isDemo);
  const theme = useResolvedTheme();

  const nextTheme = theme === "dark" ? "light" : "dark";
  const saveLabel = SAVE_LABEL[saveState];
  /*
   * 演示模式下这一格写「浏览器演示库」而不是再来一个「演示模式」标签：
   * 整行警告条已经把「不是便携知识库」说清楚了，右上角再挂一颗黄色胶囊
   * 只是把同一句话说了三遍（验收清单 P2-5）。这里剩下的信息是
   * 「当前打开的是什么」——那是这一格该回答的问题。
   */
  const placeLabel = isDemo ? "浏览器演示库" : (info?.title ?? "知识库");

  return (
    <header className="topbar">
      {/*
        左边只有一颗「知识库」按钮。
        品牌名原来在这里又写了一遍（窗口栏上已经有一份），同一个名字出现两次
        只会把顶栏挤窄；数据库图标随之前移到首位，成为这一段的起点。
      */}
      <div className="brand-cluster">
        <button
          type="button"
          className="library-button"
          data-open-library
          title="知识库信息、创建副本、迁移、备份与完整性检查"
          onClick={commands.openLibrary}
        >
          <Icon name="database" />
          <span>{placeLabel}</span>
          <Icon name="chevron" className="chevron" />
        </button>
      </div>

      <WorkspaceModeSwitcher />

      <div className="top-actions">
        <button
          type="button"
          className="search-trigger"
          data-nav-kind="search"
          aria-haspopup="dialog"
          aria-controls="nav-drawer"
          title="搜索知识点（Ctrl / Cmd + K）"
          onClick={() => layoutApi().setNavDrawer("search")}
        >
          <Icon name="search" />
          <span className="search-label">搜索知识点</span>
          <kbd>Ctrl K</kbd>
        </button>

        <span
          className="top-save"
          data-state={saveState}
          title={
            saveState === "error"
              ? (saveError ?? "保存失败")
              : (info?.rootPath ?? undefined)
          }
        >
          <i className="status-dot" />
          <span>{saveLabel ?? "已就绪"}</span>
        </span>

        {readOnly && (
          <span className="pill is-readonly" title="没有取得写锁：所有修改入口已禁用">
            <Icon name="lock" />
            只读
          </span>
        )}
        {/* 演示模式不再在这里重复一颗胶囊：整行警告条 + 知识库名已经说清了 */}
        <HealthIcon />

        <button
          type="button"
          className="icon-btn"
          aria-label={`切换为${themeLabel(nextTheme)}模式`}
          title={`切换为${themeLabel(nextTheme)}模式（命令面板里可以跟随系统）`}
          onClick={toggleTheme}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>

        <button
          type="button"
          className="icon-btn"
          aria-label="AI 设置"
          title="AI 设置"
          onClick={() => requestAiSettings()}
        >
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
