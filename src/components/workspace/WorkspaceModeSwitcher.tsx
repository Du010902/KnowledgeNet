/**
 * 主视图标签：对话 / 图谱 + 标签附属的「视图打开方式」菜单
 *
 * 《工作台 UI 审查与重构规范》§2.3：分屏是**呈现方式**，不是用户任务。
 * 一级导航因此只有两个标签，而分屏动作收进标签右侧那颗小箭头里
 * （`design/workbench-ui-reference.html` 的 `.tab-menu-button` + `.tab-menu`）——
 * 不再是「第三个只有图标、必须悬停才看得懂」的常驻按钮。
 *
 * 三条无障碍约束（验收清单 P1-4）：
 * 1. `role="tablist"` 里**只有两个** `role="tab"`，任何时刻只有一个
 *    `aria-selected="true"`（它表示「当前这个视图在原位/是主窗格」）；
 * 2. 分屏动作在 tablist **之外**的 DOM 层级里，用菜单的 `aria-expanded` 表达；
 * 3. 方向键在标签之间移动焦点（roving tabindex），Enter / Space 激活。
 *
 * 能力一条不少：`SplitWorkspace`、可拖拽比例、窗格最大化、Esc 恢复、
 * 窄屏降级、按知识库持久化全部原样保留，`mode: "split"` 仍是有效布局状态，
 * 旧设备状态（`mode: "split"`）照样能读。
 */
import { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/icons";
import {
  layoutApi,
  useLayout,
  useNarrowLayout,
  type MaximizedPane,
  type WorkspaceMode,
} from "./bridge";
import { useEscape } from "./useEscape";

const VIEWS: { id: WorkspaceMode; label: string; icon: IconName; hint: string }[] = [
  { id: "chat", label: "对话", icon: "chat", hint: "对话占满工作区：专注提问与阅读" },
  { id: "graph", label: "图谱", icon: "network", hint: "图谱占满工作区：整理与观察结构" },
];

const LABEL: Record<MaximizedPane, string> = { chat: "对话", graph: "图谱" };

export function WorkspaceModeSwitcher() {
  const mode = useLayout((s) => s.mode);
  const splitOrder = useLayout((s) => s.splitOrder);
  const narrow = useNarrowLayout();
  const split = mode === "split";
  /*
   * 「当前」的那一档：单视图就是它自己，分屏时是主窗格（左/上那一个）。
   * 只有它 `aria-selected=true`——两个都选中会让屏幕阅读器读不出当前视图。
   */
  const current: MaximizedPane =
    mode === "chat" ? "chat" : mode === "graph" ? "graph" : splitOrder === "chat-first" ? "chat" : "graph";
  const other: MaximizedPane = current === "graph" ? "chat" : "graph";

  const [menuOpen, setMenuOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEscape(menuOpen, () => setMenuOpen(false));

  // 点别处收起：菜单是浮层，不该一直挂着
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!groupRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  /** 方向键移动焦点（不激活）：Enter / Space 由按钮自己处理 */
  const onTablistKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const keys = VIEWS.map((item) => item.id);
    const index = keys.indexOf(
      (document.activeElement as HTMLElement | null)?.dataset?.modeButton as WorkspaceMode,
    );
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % keys.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + keys.length) % keys.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = keys.length - 1;
    if (next < 0) return;
    e.preventDefault();
    tabRefs.current[keys[next]!]?.focus();
  };

  return (
    <div className="view-tabs">
      <nav
        className="mode-switcher"
        role="tablist"
        aria-label="主视图"
        onKeyDown={onTablistKeyDown}
      >
        {VIEWS.map((item) => {
          const selected = current === item.id;
          return (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[item.id] = el;
              }}
              type="button"
              role="tab"
              data-mode-button={item.id}
              className={selected ? "active" : undefined}
              aria-selected={selected}
              /* roving tabindex：tablist 里只有当前那一档在 Tab 序列里 */
              tabIndex={selected ? 0 : -1}
              title={item.hint}
              onClick={() => layoutApi().setMode(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/*
        标签附属菜单：打开方式（在右侧打开另一半 / 最大化 / 关闭侧边视图）。
        它在 tablist 之外，因此不会被算成第三个主视图。
      */}
      <div className="view-tab-group" ref={groupRef}>
        <button
          type="button"
          className="tab-menu-button"
          data-tab-menu
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="视图打开方式"
          title="视图打开方式：并排、最大化、关闭侧边视图"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="chevron" />
        </button>

        {menuOpen && (
          <div className="tab-menu" role="menu" data-tab-menu-list aria-label="视图打开方式">
            {!split ? (
              <button
                type="button"
                role="menuitem"
                data-split-action="open"
                disabled={narrow}
                title={
                  narrow
                    ? "窗口太窄：分屏会变成两个都不能用的窗格，请直接用「对话」与「图谱」切换"
                    : `当前视图留在原位，在右侧打开${LABEL[other]}（可拖拽比例）`
                }
                onClick={() => {
                  setMenuOpen(false);
                  layoutApi().openSidePane();
                }}
              >
                <Icon name="panel" />
                在右侧打开{LABEL[other]}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  data-split-action="maximize"
                  onClick={() => {
                    setMenuOpen(false);
                    layoutApi().maximizePane(current);
                  }}
                >
                  <Icon name="expand" />
                  最大化当前视图
                </button>
                <hr />
                <button
                  type="button"
                  role="menuitem"
                  data-split-action="close"
                  onClick={() => {
                    setMenuOpen(false);
                    layoutApi().closeSidePane();
                  }}
                >
                  <Icon name="close" />
                  关闭侧边视图
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
