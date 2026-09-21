/**
 * 消息列表
 *
 * 每条回答的状态必须如实显示，因为它们对应的是不同的事实：
 * 已停止（自己按的停止）、被截断（达到输出上限）、连接中断（没收到结束标记）、
 * 失败（请求本身出错）。把这几种混成一句「生成失败」，
 * 使用者就不知道该调长度上限、该重试，还是该担心内容已经被保存。
 *
 * 「生成中」还分两种：真的还在生成（有活动请求）与上次生成没结束就中断了
 * （存储里留下的 streaming）。后者一直转圈会让人一直等，所以按未完成处理并给重试。
 */
import type { RefObject } from "react";

import type { ChatMessage } from "@/data/chatTypes";
import { renderMarkdown } from "@/markdown";
import { Icon } from "./icons";
import { SelectionMenu } from "./SelectionMenu";

interface ChatMessagesProps {
  nodeId: string;
  nodeTitle: string;
  threadId: string | null;
  messages: ChatMessage[];
  /** 当前正在生成的那条回答；为 null 时所有「生成中」都视为中断 */
  activeMessageId: string | null;
  listRef: RefObject<HTMLDivElement | null>;
  onPrompt: (text: string) => void;
  onCopy: (message: ChatMessage) => void;
  /** 代码块右上角的「复制」：内容在 DOM 里，由这里读出来交给上层写剪贴板 */
  onCopyCode?: (code: string) => void;
  onRecordQuestion: (message: ChatMessage) => void;
  onRetry: (message: ChatMessage) => void;
}

/** 只给回答标个时间，让人知道这段内容是什么时候问出来的 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ChatMessages({
  nodeId,
  nodeTitle,
  threadId,
  messages,
  activeMessageId,
  listRef,
  onPrompt,
  onCopy,
  onCopyCode,
  onRecordQuestion,
  onRetry,
}: ChatMessagesProps) {
  /*
   * 代码块的「复制」按钮是 Markdown 渲染出来的 HTML，挂不了 React 事件，
   * 因此用事件委托：点到了 `[data-code-copy]` 就去读同一个代码块里的 `<code>`。
   * 内容不从属性里带（那要再转义一次），而是从 DOM 读原文——所见即所复制。
   */
  const handleBodyClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>("[data-code-copy]");
    if (!button || !onCopyCode) return;
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    if (code) onCopyCode(code);
  };

  return (
    <div className="messages" ref={listRef} aria-label="对话消息">
      {messages.length === 0 && (
        <div className="chat-empty">
          <div className="empty-mark">
            <Icon name="chat" />
          </div>
          <h3>从一个问题开始理解</h3>
          <p>
            围绕「{nodeTitle}」提问。
            <br />
            读到不懂的概念，再把它连进知识图。
          </p>
          <div className="prompt-chips">
            <button type="button" onClick={() => onPrompt(`${nodeTitle}是什么？`)}>
              这个概念是什么？
            </button>
            <button
              type="button"
              onClick={() => onPrompt(`理解${nodeTitle}，需要哪些前置知识？`)}
            >
              我需要先理解什么？
            </button>
            <button type="button" onClick={() => onPrompt(`请用一个直观的例子解释${nodeTitle}`)}>
              给我一个直观的例子
            </button>
          </div>
        </div>
      )}

      {messages.map((m) => {
        /*
         * 消息状态在 v2 里换过一次名字：`cancelled → stopped`、`failed → error`
         * （契约 §1.6 的 status 取值）。这里两种写法都认，界面不会因为
         * 状态层迁移到一半就少掉「已停止 / 生成失败」的说明与重试入口。
         */
        const status = String(m.status);
        const stopped = status === "cancelled" || status === "stopped";
        const failed = status === "failed" || status === "error";
        return m.role === "user" ? (
          <div key={m.id} className="message user" data-message-id={m.id}>
            <div className="user-bubble">{m.content}</div>
          </div>
        ) : (
          <div key={m.id} className="message assistant" data-message-id={m.id}>
            <div className="ai-label">
              <span className="ai-symbol">
                <Icon name="sparkles" />
              </span>
              <span>学习助手</span>
              <span className="ai-meta">{formatTime(m.createdAt)}</span>
            </div>

            <div
              className="ai-body markdown-body"
              onClick={handleBodyClick}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
            />

            {m.status === "streaming" && activeMessageId === m.id && (
              <div className="message-status">
                正在生成回答…
                <i className="typing-caret" />
              </div>
            )}

            {m.status === "streaming" && activeMessageId !== m.id && (
              <div className="message-status warn">
                这条回答没有正常结束（例如生成过程中关掉了窗口），内容可能不完整。
                <button type="button" onClick={() => onRetry(m)}>
                  重试
                </button>
              </div>
            )}

            {stopped && (
              <div className="message-status">已停止生成，以上内容尚未完整。</div>
            )}

            {m.status === "complete" && m.finishReason === "length" && (
              <div className="message-status">
                回答达到长度上限被截断，结尾可能不完整。可在 AI 设置里调大「回答长度上限」，或让它分段继续讲。
              </div>
            )}

            {m.status === "incomplete" && (
              <div className="message-status warn">
                回答没有正常结束（连接可能中断），以上内容可能不完整。
                <button type="button" onClick={() => onRetry(m)}>
                  重试
                </button>
              </div>
            )}

            {failed && (
              <div className="message-status error">
                {m.content.trim()
                  ? "生成失败，以上是已经收到的部分内容。"
                  : "生成失败，这次没有生成任何内容。"}
                <button type="button" onClick={() => onRetry(m)}>
                  重试
                </button>
              </div>
            )}

            <div className="message-actions">
              <button type="button" onClick={() => onCopy(m)}>
                <Icon name="copy" />
                复制
              </button>
              <span className="spacer" />
              <button type="button" onClick={() => onRecordQuestion(m)}>
                <Icon name="bookmark" />
                记录疑问
              </button>
            </div>
          </div>
        );
      })}

      {/* 选中文字后出现：把不懂的概念直接变成前置知识节点 */}
      <SelectionMenu nodeId={nodeId} threadId={threadId} containerRef={listRef} />
    </div>
  );
}
