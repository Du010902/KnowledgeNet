/**
 * 窗口栏（自绘标题栏）
 *
 * `design/workbench-ui-reference.html` 的第 77–88 行：32px 的窄条，
 * 左边是拖拽区（标记 + 标题），右边是三个窗口控制按钮。
 * 桌面版把 `tauri.conf.json` 的原生边框关掉（`decorations: false`），
 * 这一条就是唯一的标题栏；浏览器里它照常显示，但按钮只给一句提示——
 * 参考页也是这么做的（"桌面版将执行：…"），不假装能关掉一个标签页。
 *
 * 两条容易踩的坑：
 * 1. 拖拽必须用 `data-tauri-drag-region` 属性：它由 Tauri 注入的脚本直接处理，
 *    不经过 JS API，因此即使前端某个模块出错，窗口仍然拖得动。
 * 2. 最小化 / 最大化 / 关闭要显式申请 ACL 权限（`core:window:allow-*`）：
 *    `core:default` 里只有只读查询，少了权限这一步就会在运行时被拒绝。
 */
import { Icon } from "@/components/icons";
import { isTauri } from "@/data/platform";

type WindowAction = "minimize" | "maximize" | "close";

const LABELS: Record<WindowAction, string> = {
  minimize: "最小化",
  maximize: "最大化或还原",
  close: "关闭",
};

/** 图标：最小化是一横、最大化是一个方框、关闭是一把叉 */
const ICONS: Record<WindowAction, "minus" | "square" | "close"> = {
  minimize: "minus",
  maximize: "square",
  close: "close",
};

async function run(action: WindowAction): Promise<void> {
  // 浏览器（演示模式）里没有可控制的窗口：给一句诚实的提示，不做静默失败
  if (!isTauri()) {
    notify(`桌面版将执行：${LABELS[action]}`, "info");
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (action === "minimize") await win.minimize();
  else if (action === "maximize") await win.toggleMaximize();
  else await win.close();
}

/**
 * 提示走工作台已有的那条通道（`workspaceApi().notify`），不自己造一层浮层。
 *
 * 用事件而不是直接 import：`WorkspaceShell` 之外调用 bridge 会把「顶栏 → 外壳」
 * 的依赖方向反过来，而这个组件要能在库选择页就渲染。
 */
function notify(text: string, kind: "info" | "warn"): void {
  window.dispatchEvent(
    new CustomEvent(NOTICE_EVENT, { detail: { kind, text } }),
  );
}

/** 与 `App.tsx` 的提示层约定的事件名 */
export const NOTICE_EVENT = "knowledgenet:notice";

export interface NoticeDetail {
  kind: "info" | "warn" | "error" | "success";
  text: string;
}

export function WindowBar() {
  return (
    <div className="window-bar">
      <div className="window-drag" data-tauri-drag-region>
        <Icon name="network" className="window-mark" />
        <span className="window-title">KnowledgeNet · 学习依赖图</span>
      </div>
      <div className="window-controls" aria-label="窗口控制">
        {(Object.keys(LABELS) as WindowAction[]).map((action) => (
          <button
            key={action}
            type="button"
            className={action === "close" ? "window-control close" : "window-control"}
            aria-label={LABELS[action]}
            title={LABELS[action]}
            onClick={() => {
              void run(action).catch(() => notify(`窗口操作失败：${LABELS[action]}`, "warn"));
            }}
          >
            <Icon name={ICONS[action]} />
          </button>
        ))}
      </div>
    </div>
  );
}