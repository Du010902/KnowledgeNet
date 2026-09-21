/**
 * 节点菜单（画布右键菜单 / 工作区标题栏的「更多操作」共用）
 *
 * 四个动作都指向「当前这个节点」：重命名、添加前置知识、合并、**彻底删除**。
 * 菜单本身只负责定位与分发，确认类动作交给 NodeDialogs 里的弹窗，
 * 这样画布与工作区两处入口的文案、后果说明完全一致。
 *
 * 删除不在这里直接问：它会连文件夹一起删掉，需要先用文字说清会消失什么、
 * 并给出备份入口，一句话的 confirm 装不下这些信息。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useWorkspace } from "./workspace/bridge";
import { Icon } from "./icons";
import { EraseNodeDialog, MergeNodeDialog, RenameNodeDialog } from "./NodeDialogs";

export interface ContextMenuState {
  nodeId: string;
  /** 菜单左上角的屏幕坐标 */
  x: number;
  y: number;
}

/** 与 `src/styles/chat.css` 里的 `.menu` 保持一致，用于把菜单约束在窗口内 */
const MENU_WIDTH = 190;
const MENU_HEIGHT = 230;

type DialogKind = "rename" | "merge" | "delete" | null;

export function ContextMenu({
  state,
  onClose,
  onAdd,
}: {
  state: ContextMenuState;
  onClose: () => void;
  /** 打开「添加前置知识」弹窗；由渲染菜单的一方决定弹窗挂在哪里 */
  onAdd: (nodeId: string) => void;
}) {
  const node = useWorkspace((s) => s.graph.nodes.find((n) => n.id === state.nodeId) ?? null);
  const writable = useWorkspace((s) => s.canWrite());
  const readOnly = useWorkspace((s) => s.libraryState === "readonly");
  /** 菜单收起后仍然保留在树上，弹窗才有地方挂载 */
  const [menuOpen, setMenuOpen] = useState(true);
  const [dialog, setDialog] = useState<DialogKind>(null);

  // Esc 收起菜单；弹窗打开时由原生 dialog 自己处理 Esc
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, onClose]);

  if (!node) return null;

  const left = Math.min(Math.max(8, state.x), Math.max(8, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.min(Math.max(8, state.y), Math.max(8, window.innerHeight - MENU_HEIGHT - 8));

  const pick = (kind: Exclude<DialogKind, null>) => {
    setMenuOpen(false);
    setDialog(kind);
  };

  /** 只读或有操作进行中：菜单项可见但不可点，并说明原因 */
  const blockedReason = readOnly
    ? "这是只读知识库：没有取得写锁，或知识库版本高于本应用。"
    : "正在检查/修复知识库，修改入口暂时禁用。";

  /*
   * 挂到 body 上而不是原地渲染：节点工作区（.inspector）有自己的 z-index 与
   * 层叠上下文，菜单留在里面就会被顶栏这类更高层的区域盖住，
   * 遮罩也拦不住点到那些区域的手势。position: fixed 的坐标仍然是视口坐标。
   */
  return createPortal(
    <>
      {menuOpen && (
        <>
          {/* 透明遮罩：承接「点别处关闭」，同时挡掉画布上的拖拽与平移 */}
          <div
            className="menu-backdrop"
            onClick={onClose}
            onContextMenu={(e) => {
              e.preventDefault();
              onClose();
            }}
          />
          <div className="menu" role="menu" aria-label={`「${node.title}」的节点操作`} style={{ left, top }}>
            {/* 分组：编辑 → 关系 → 危险操作（验收清单 P2-1：危险项固定在最底部） */}
            <p className="menu-group">编辑</p>
            <button
              type="button"
              role="menuitem"
              disabled={!writable}
              title={writable ? undefined : blockedReason}
              onClick={() => pick("rename")}
            >
              <Icon name="edit" />
              重命名知识点
            </button>

            <p className="menu-group">关系</p>
            <button
              type="button"
              role="menuitem"
              disabled={!writable}
              title={writable ? undefined : blockedReason}
              onClick={() => {
                setMenuOpen(false);
                onAdd(node.id);
              }}
            >
              <Icon name="plus" />
              添加前置知识
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!writable}
              title={writable ? undefined : blockedReason}
              onClick={() => pick("merge")}
            >
              <Icon name="merge" />
              合并重复知识点
            </button>
            <hr />
            <button
              type="button"
              role="menuitem"
              className="danger"
              data-erase-node-menu
              disabled={!writable}
              title={
                writable
                  ? "删除这个文件夹与其中的文件（连文件夹一起删，不可撤销；删之前可以备份）"
                  : blockedReason
              }
              onClick={() => pick("delete")}
            >
              <Icon name="trash" />
              彻底删除知识点…
            </button>
          </div>
        </>
      )}

      {dialog === "rename" && <RenameNodeDialog nodeId={node.id} onClose={onClose} />}
      {dialog === "merge" && <MergeNodeDialog nodeId={node.id} onClose={onClose} />}
      {dialog === "delete" && <EraseNodeDialog nodeId={node.id} onClose={onClose} />}
    </>,
    document.body,
  );
}
