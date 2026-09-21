/**
 * 上下文栏（当前知识点那一行）
 *
 * 只放当前知识点相关的内容：**对话列表入口 + 学习状态 + 标题 + 学习脉络**。
 *
 * 排布：最左是「对话列表」图标（打开侧边栏的对话页签），随后是状态与标题，
 * 右侧只留「学习脉络」（打开侧边栏的脉络页签）与分屏时的「最大化」。
 * 「新对话 1 ⌄」那颗下拉与旁边重复的「＋」、以及「节点操作」都已去掉：
 * 列表与新建归边栏管，节点操作归画布右键管，聊天窗口里不再摆第二份。
 * 状态不再是彩色胶囊：胶囊留给真正的筛选与短标签，状态只表达状态。
 */
import { useRef, useState } from "react";

import { Icon } from "@/components/icons";
import { STATUS_ORDER } from "@/data/types";
import { STATUS_DISPLAY } from "@/store";
import {
  layoutApi,
  useChat,
  useCurrentNode,
  useLayout,
  useNodeThreads,
  useWorkspace,
  workspaceApi,
} from "./bridge";
import { NodeHealthNotice } from "./NodeHealthNotice";
import { useSplitSlot } from "./splitSlot";
import { useEscape } from "./useEscape";

export function NodeContextBar() {
  const node = useCurrentNode();
  const threads = useNodeThreads(node?.id ?? null);
  const activeThreadId = useChat((s) => s.activeThreadId);
  const writable = useWorkspace((s) => s.canWrite());
  const readOnly = useWorkspace((s) => s.libraryState === "readonly");
  /** 边栏的两个页签：对话列表 / 学习脉络 */
  const panelOpen = useLayout((s) => s.threadListOpen || s.inspectorOpen);
  /** 分屏时这个窗格可以最大化；不在分屏里时为 null */
  const slot = useSplitSlot();

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;

  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  useEscape(statusOpen, () => setStatusOpen(false));

  const blockedReason = readOnly
    ? "这是只读知识库：没有取得写锁，或知识库版本高于本应用。"
    : "正在检查/修复知识库，修改入口暂时禁用。";

  return (
    <div className="node-context-bar">
      <div className="node-context-row">
        {/*
          最左：边栏开关。开/关同一条边栏，栏顶两个页签（对话 / 脉络）决定看哪个。
          它原来是一颗写着「新对话 1 ⌄」的下拉按钮，右边还跟着一颗重复的「＋」——
          文字与加号都去掉：列表、新建与脉络都归边栏管。
        */}
        <button
          type="button"
          className="icon-btn thread-list-toggle"
          data-side-panel-toggle
          data-thread-count={threads.length}
          aria-pressed={panelOpen}
          aria-label={`边栏（对话与脉络，${threads.length} 个对话）`}
          title="边栏：对话列表与学习脉络"
          onClick={() => layoutApi().toggleSidePanel()}
        >
          <Icon name="panel" />
          {/* 屏幕阅读器与自检脚本读这一行；视觉上不占位置 */}
          <span className="sr-only thread-trigger-label">{activeThread?.title ?? "新对话"}</span>
        </button>

        {node ? (
          <>
            {/* 左侧成组：状态 + 标题（参考图 .context-left） */}
            <div className="context-left">
              <div className="status-menu-wrap" ref={statusRef}>
                <button
                  type="button"
                  className={`learning-status ${STATUS_DISPLAY[node.status].cls}`}
                  data-node-status
                  aria-haspopup="true"
                  aria-expanded={statusOpen}
                  disabled={!writable}
                  title={writable ? "修改学习状态" : blockedReason}
                  onClick={() => setStatusOpen((open) => !open)}
                >
                  <i className="status-dot" />
                  <span>{STATUS_DISPLAY[node.status].label}</span>
                  <Icon name="chevron" className="chevron" />
                </button>
                {statusOpen && (
                  <div className="status-menu" role="menu" aria-label="修改学习状态">
                    {STATUS_ORDER.map((status) => (
                      <button
                        key={status}
                        type="button"
                        role="menuitemradio"
                        aria-checked={node.status === status}
                        onClick={() => {
                          setStatusOpen(false);
                          void workspaceApi().setStatus(node.id, status);
                        }}
                      >
                        <i className={`status-dot ${STATUS_DISPLAY[status].cls}`} />
                        {STATUS_DISPLAY[status].label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <h1 className="node-title" title={node.title}>
                <span className="node-title-text">{node.title}</span>
              </h1>
            </div>
          </>
        ) : (
          <h2 className="node-title muted">还没有选中知识点</h2>
        )}

        {/*
          右侧只剩分屏时的「最大化」。
          「学习脉络」按钮已删除：边栏顶部本来就有「脉络」页签，同一个面板
          挂两个入口只会让人多犹豫一次。节点操作（重命名 / 添加前置 / 合并 /
          彻底删除）也不在聊天窗口里——那是画布上的事，右键节点即可。
        */}
        <div className="context-actions">
          {slot && (
            <button
              type="button"
              className="icon-btn"
              data-maximize-pane={slot.pane}
              aria-label="最大化对话"
              title="最大化对话（Esc 回到分屏）"
              onClick={slot.maximize}
            >
              <Icon name="expand" />
            </button>
          )}
        </div>
      </div>

      <NodeHealthNotice node={node} />
    </div>
  );
}
