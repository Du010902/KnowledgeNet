/**
 * 侧边栏（对话 / 脉络 两个页签）
 *
 * 原来这里是两个各自独立的「边栏」：左边一个「对话」线程列表，
 * 右边一个「学习脉络」抽屉。两处都在回答同一个问题——「这个知识点现在
 * 有哪些上下文」，分成两个入口只是让人多记一次「东西在哪一边」。
 *
 * 现在合成一条，顶部两个页签：**对话**（线程列表）与**脉络**（详情 / 笔记 / 资料）。
 * 页签状态复用布局里已有的两个字段（`threadListOpen` / `inspectorOpen`，
 * 在 uiStore 里互斥），因此设备状态、快捷键与既有自检都还对得上。
 *
 * 两种摆放（同一份内容）：
 * - `inline`：对话工作区里的一列，和原来的线程列表同一个位置；
 * - `overlay`：图谱视图里没有「对话列」可依附，就浮在左侧（带遮罩，点外面关闭）。
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "@/components/icons";
import { NodeDetail } from "@/components/NodeDetail";
import { NodeNotes } from "@/components/NodeNotes";
import { ResourcesPanel } from "@/components/ResourcesPanel";
import { NodeHealthNotice } from "./NodeHealthNotice";
import {
  HEALTH_LABEL,
  nodeHealth,
  useCurrentNode,
  useLayout,
  type InspectorTab,
} from "./bridge";
import { ThreadListBody } from "./ThreadSwitcher";
import { useEscape } from "./useEscape";

const DOCK_TABS: { id: InspectorTab; label: string; icon: IconName }[] = [
  { id: "detail", label: "详情", icon: "sliders" },
  { id: "notes", label: "笔记", icon: "note" },
  { id: "resources", label: "资料", icon: "paperclip" },
];

export function SidePanel({ variant = "inline" }: { variant?: "inline" | "overlay" }) {
  const threadsOpen = useLayout((s) => s.threadListOpen);
  const contextOpen = useLayout((s) => s.inspectorOpen);
  const open = threadsOpen || contextOpen;
  /** 脉络优先：两个字段理论上互斥，真出现「都是 true」时以脉络为准 */
  const tab: "threads" | "context" = contextOpen ? "context" : "threads";

  const dockTab = useLayout((s) => s.inspectorTab);
  const setDockTab = useLayout((s) => s.setInspectorTab);
  const setThreadListOpen = useLayout((s) => s.setThreadListOpen);
  const setInspectorOpen = useLayout((s) => s.setInspectorOpen);
  const node = useCurrentNode();
  const health = nodeHealth(node);

  const panelRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});
  /** 打开之前焦点在哪：关掉之后要还回去，否则键盘用户会被丢回页面开头 */
  const previousFocus = useRef<HTMLElement | null>(null);

  const close = () => {
    setThreadListOpen(false);
    setInspectorOpen(false);
  };
  useEscape(open, close);

  useEffect(() => {
    if (!open || variant !== "overlay") return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panelRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(timer);
      previousFocus.current?.focus?.();
    };
  }, [open, variant]);

  /** 脉络里的三个小标签：方向键移动，Home / End 跳到首尾 */
  const onDockKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = DOCK_TABS.findIndex((t) => t.id === dockTab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % DOCK_TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + DOCK_TABS.length) % DOCK_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = DOCK_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = DOCK_TABS[next]!;
    setDockTab(target.id);
    tabRefs.current[target.id]?.focus();
  };

  if (!open) return null;

  const panel = (
    <aside
      ref={panelRef}
      className={`side-panel ${variant === "overlay" ? "is-overlay" : ""}`}
      data-side-panel
      data-side-tab={tab}
      role="dialog"
      aria-label="节点边栏"
      tabIndex={variant === "overlay" ? -1 : undefined}
    >
      <header className="side-panel-head">
        <div className="side-panel-tabs" role="tablist" aria-label="边栏内容">
          <button
            type="button"
            role="tab"
            data-side-tab-button="threads"
            className={tab === "threads" ? "active" : undefined}
            aria-selected={tab === "threads"}
            onClick={() => setThreadListOpen(true)}
          >
            <Icon name="chat" />
            对话
          </button>
          <button
            type="button"
            role="tab"
            data-side-tab-button="context"
            className={tab === "context" ? "active" : undefined}
            aria-selected={tab === "context"}
            onClick={() => setInspectorOpen(true)}
          >
            {/* 用「主干 + 支脉」而不是 panel：后者正是分屏按钮的形状 */}
            <Icon name="context" />
            脉络
          </button>
        </div>
        <button
          type="button"
          className="icon-btn sm"
          data-close-side-panel
          aria-label="关闭边栏"
          title="关闭（Esc）"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>

      {tab === "threads" ? (
        <ThreadListBody nodeId={node?.id ?? null} />
      ) : (
        <>
          <div className="side-panel-node">
            <p className="side-panel-overline">当前知识点</p>
            <h2 title={node?.title}>{node ? node.title : "未选中知识点"}</h2>
          </div>

          {health.health !== "ok" && (
            <p className="sheet-health" role="status">
              <Icon name="alert" />
              {HEALTH_LABEL[health.health]}
              {health.relativePath ? ` · ${health.relativePath}` : ""}
            </p>
          )}

          <div
            className="dock-tabs"
            role="tablist"
            aria-label="节点内容"
            onKeyDown={onDockKeyDown}
          >
            {DOCK_TABS.map((t) => {
              const active = dockTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`inspector-tab-${t.id}`}
                  data-inspector-tab={t.id}
                  className={`dock-tab ${active ? "active" : ""}`}
                  aria-selected={active}
                  aria-controls={`inspector-pane-${t.id}`}
                  tabIndex={active ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  onClick={() => setDockTab(t.id)}
                >
                  <Icon name={t.icon} />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="dock-body">
            {!node ? (
              <div className="chat-empty">
                <div className="empty-mark">
                  <Icon name="panel" />
                </div>
                <h3>还没有选中知识点</h3>
                <p>
                  在知识图里点一个节点，这里会显示它的详情、笔记与资料。
                  <br />
                  读到不明白的概念时，<b>选中那段文字</b>就能直接建立前置知识。
                </p>
              </div>
            ) : (
              <>
                {dockTab === "detail" && (
                  <section
                    className="detail-pane"
                    role="tabpanel"
                    id="inspector-pane-detail"
                    aria-labelledby="inspector-tab-detail"
                  >
                    <NodeHealthNotice node={node} compact />
                    <NodeDetail nodeId={node.id} />
                  </section>
                )}
                {dockTab === "notes" && (
                  <section
                    className="notes-pane"
                    role="tabpanel"
                    id="inspector-pane-notes"
                    aria-labelledby="inspector-tab-notes"
                  >
                    <NodeNotes nodeId={node.id} />
                  </section>
                )}
                {dockTab === "resources" && (
                  <section
                    className="detail-pane resources-pane"
                    role="tabpanel"
                    id="inspector-pane-resources"
                    aria-labelledby="inspector-tab-resources"
                  >
                    <ResourcesPanel nodeId={node.id} />
                  </section>
                )}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );

  /*
   * 图谱视图里没有「对话列」可以依附：浮在左侧，带一层遮罩（点外面即关闭）。
   * 对话/分屏里则是一列，和原来的线程列表同一个位置，不遮内容。
   */
  if (variant === "overlay") {
    return createPortal(
      <>
        <div className="side-scrim" onClick={close} aria-hidden="true" />
        {panel}
      </>,
      document.body,
    );
  }
  return panel;
}
