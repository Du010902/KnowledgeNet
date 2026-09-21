/**
 * 画布右键菜单（空白处）
 *
 * 「新建知识点」的家在这里，而不是搜索抽屉里：搜索框只负责搜索，
 * 而建立知识点的动作发生在**看得见那张网的地方**——右键落点就是新节点
 * 将要加入的位置。聚焦视图与三维空间视图共用这一个菜单。
 *
 * 菜单本身只负责分发：新建的输入与确认交给 `NewNodeDialog`，
 * 与命令面板里的「新建知识点」是同一套动作。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useLayout, useWorkspace } from "./workspace/bridge";
import { Icon } from "./icons";
import { NewNodeDialog } from "./NodeDialogs";

export interface CanvasMenuState {
  /** 菜单左上角的屏幕坐标 */
  x: number;
  y: number;
}

/** 与 `src/styles/chat.css` 里的 `.menu` 保持一致，用于把菜单约束在窗口内 */
const MENU_WIDTH = 200;
const MENU_HEIGHT = 110;

export function CanvasMenu({
  state,
  onClose,
}: {
  state: CanvasMenuState;
  onClose: () => void;
}) {
  const setNavDrawer = useLayout((s) => s.setNavDrawer);
  /*
   * 只读知识库（没取得写锁 / 版本高于本应用）：新建入口禁用，并说明原因。
   * 菜单项灰着比「点了没反应」好——后者会被当成程序坏了。
   */
  const writable = useWorkspace((s) => s.canWrite());
  const blockedReason = useWorkspace((s) =>
    s.libraryState === "readonly"
      ? "这是只读知识库：没有取得写锁，或知识库版本高于本应用。"
      : "正在检查/修复知识库，修改入口暂时禁用。",
  );
  /**
   * 菜单收起后**组件仍然留在树上**：新建对话框挂在这里，
   * 点菜单项时如果连组件一起卸载，对话框就跟着没了（曾经就是这样）。
   */
  const [menuOpen, setMenuOpen] = useState(true);
  const [dialog, setDialog] = useState(false);

  // Esc 收起菜单；对话框自己处理 Esc
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, onClose]);

  const left = Math.min(Math.max(8, state.x), Math.max(8, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.min(Math.max(8, state.y), Math.max(8, window.innerHeight - MENU_HEIGHT - 8));

  return createPortal(
    <>
      {menuOpen && (
        <>
          <div
            className="menu-backdrop"
            onClick={onClose}
            onContextMenu={(e) => {
              e.preventDefault();
              onClose();
            }}
          />
          <div className="menu" role="menu" aria-label="画布操作" style={{ left, top }}>
            <button
              type="button"
              role="menuitem"
              data-canvas-new-node
              disabled={!writable}
              title={writable ? "在画布上新建一个知识点" : blockedReason}
              onClick={() => {
                setMenuOpen(false);
                setDialog(true);
              }}
            >
              <Icon name="plus" />
              新建知识点
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setNavDrawer("search");
              }}
            >
              <Icon name="search" />
              搜索已有知识点
            </button>
          </div>
        </>
      )}

      {dialog && <NewNodeDialog onClose={() => setDialog(false)} />}
    </>,
    document.body,
  );
}
