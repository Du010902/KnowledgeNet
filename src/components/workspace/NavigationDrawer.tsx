/**
 * 导航抽屉（覆盖式）
 *
 * 原来的 238px 常驻左栏拆成「44px 活动栏 + 覆盖式抽屉」。抽屉盖在内容之上、
 * 不参与布局，所以打开它不会挤压图谱或对话——分屏比例在任何时候都不变。
 *
 * 抽屉只有一节：搜索框 + 全部知识点。**这里不新建知识点**——
 * 搜索框就只负责搜索：要建节点，在画布上右键（聚焦与空间两种视图都可以）。
 * 它共用 `useNavigationData` 的一份数据逻辑。
 *
 * 「知识库」不再是一个抽屉：它只有一个入口（顶栏的知识库按钮），
 * 抽屉里那份内容（路径、计数、重新扫描）与知识库弹窗本来就是一回事。
 *
 * 挂到 body 上而不是原地渲染：顶栏与画布各自有层叠上下文，
 * 抽屉留在里面会被它们盖住，遮罩也拦不住点到那些区域的手势。
 */
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/icons";
import { STATUS_DISPLAY } from "@/store";
import { HEALTH_LABEL, layoutApi, nodeHealth, useLayout, useWorkspace, workspaceApi } from "./bridge";
import { useNavigationData } from "./navigationData";
import { useEscape } from "./useEscape";

const TITLES: Record<string, string> = {
  search: "搜索与知识点",
};

export function NavigationDrawer() {
  const kind = useLayout((s) => s.navDrawer);
  const data = useNavigationData();

  const panelRef = useRef<HTMLElement>(null);

  const close = () => layoutApi().setNavDrawer(null);
  useEscape(kind !== null, close);

  /*
   * 打开时把焦点交给搜索框：键盘用户不该先 Tab 过整个工作区才能开始找东西。
   */
  useEffect(() => {
    if (!kind) return;
    const timer = window.setTimeout(() => data.searchRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [kind, data.searchRef]);

  if (!kind) return null;

  return createPortal(
    <>
      <div className="drawer-scrim" onClick={close} aria-hidden="true" />
      <aside
        id="nav-drawer"
        ref={panelRef}
        className="nav-drawer"
        data-nav-panel={kind}
        role="dialog"
        aria-label={TITLES[kind] ?? "导航"}
        tabIndex={-1}
      >
        <header className="nav-drawer-head">
          <h2>{TITLES[kind] ?? "导航"}</h2>
          <button type="button" className="icon-btn" aria-label="关闭导航" onClick={close}>
            <Icon name="close" />
          </button>
        </header>

        <div className="nav-drawer-body">
          <NodesSection data={data} onPick={close} />
        </div>
      </aside>
    </>,
    document.body,
  );
}

/* ---------------------------- 搜索 / 知识点库 ---------------------------- */

function NodesSection({
  data,
  onPick,
}: {
  data: ReturnType<typeof useNavigationData>;
  onPick: () => void;
}) {
  /*
   * 重复 ID 分组由扫描结果得出。用扫描报告做依赖，而不是每次渲染都重算：
   * 一万个节点时那是每渲染一次就遍历一遍全库。
   */
  const scanReport = useWorkspace((s) => s.scanReport);
  const duplicates = useMemo(
    () => (workspaceApi().supports("duplicateGroups") ? workspaceApi().duplicateGroups() : []),
    [scanReport],
  );

  return (
    <section className="nav-section" data-nav-section="nodes">
      <div className="search">
        <Icon name="search" />
        <input
          ref={data.searchRef}
          value={data.query}
          aria-label="搜索知识点"
          placeholder="搜索知识点、别名…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => data.setQuery(e.target.value)}
        />
        <kbd>⌃ K</kbd>
      </div>

      <div className="section-label">
        <span>知识点</span>
        <span>{data.graph.nodes.length}</span>
      </div>

      {duplicates.length > 0 && (
        <p className="nav-warn" role="status">
          <Icon name="alert" />
          发现 {duplicates.length} 组重复的节点 ID：同一份节点被复制成了两份。
          在对应节点上点「重新分配 ID」，两份都能继续使用。
        </p>
      )}

      <div className="library">
        {data.graph.nodes.length === 0 && (
          <p className="empty">
            知识库还是空的。在画布上点右键就能建第一个知识点——它和其他知识点没有区别。
          </p>
        )}
        {data.graph.nodes.length > 0 && data.query.trim() !== "" && data.nodes.length === 0 && (
          <p className="empty">没有找到这个知识点。</p>
        )}
        {data.nodes.map((n) => {
          const active = n.id === data.selectedId;
          const health = nodeHealth(n);
          return (
            <div key={n.id} className={active ? "library-row active" : "library-row"}>
              <button
                type="button"
                className="library-node"
                aria-pressed={active}
                title={health.relativePath ? `${n.title}\n${health.relativePath}` : n.title}
                onClick={() => {
                  data.openNode(n.id);
                  onPick();
                }}
              >
                <span className={`status-dot ${STATUS_DISPLAY[n.status].cls}`} />
                <span className="library-node-title">{n.title}</span>
                {health.health !== "ok" && (
                  <span className="badge-warn" title={HEALTH_LABEL[health.health]}>
                    <Icon name="alert" />
                  </span>
                )}
                <span className="count">{n.references}</span>
              </button>
              {health.health === "duplicate_id" && health.relativePath && (
                <button
                  type="button"
                  className="row-action"
                  title="给这份节点换一个新的 ID：两份都会保留，不再互相覆盖"
                  onClick={() => void workspaceApi().reassignDuplicate(health.relativePath)}
                >
                  重新分配 ID
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

