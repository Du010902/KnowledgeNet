/**
 * 「添加前置知识」对话框
 *
 * **一行算一个节点**——单个输入和批量输入本来就是同一件事，
 * 所以只有一个输入框、一个提交按钮，不再有「批量模式」开关：
 * 输入一行就是加一个，输入多行就一次加多个。
 *
 * **回车始终是换行，提交只走按钮。** 不让同一个按键在不同行数下承担两种含义，
 * 否则想接着加第二个知识点时会被提前提交。Esc 关闭由原生 dialog 负责。
 *
 * 输入过程中实时提示已有知识点：点一下就把那一行换成它的正式标题，
 * 提交时按标题命中即复用（只加关系，不建重复节点）——
 * 这正是知识结构从「树」长成「网」的地方。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { findSimilar } from "@/data/engine";
import { noticeSnapshot, useWorkspace, workspaceApi } from "./workspace/bridge";
import { normalizeTitle } from "@/data/types";
import { Dialog } from "./Dialog";

export function AddPrerequisiteDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}) {
  const graph = useWorkspace((s) => s.graph);

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  const target = graph.nodes.find((n) => n.id === nodeId) ?? null;

  /*
   * 焦点放到输入框上，而不是让浏览器选中弹窗里的第一个可聚焦元素（那是关闭按钮）。
   * 这里的手动 focus 会晚于 Dialog 的 showModal 执行，因此能覆盖浏览器的默认焦点。
   */
  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  /** 相似知识点候选：提示「这个是不是已经记过了」。以最后一行为准（正在输入的那行） */
  const suggestions = useMemo(() => {
    const probe = text.split("\n").pop() ?? "";
    const clean = normalizeTitle(probe);
    if (clean.length < 2) return [];
    return findSimilar(graph, clean, 5).filter((n) => n.id !== nodeId);
  }, [text, graph, nodeId]);

  /** 按行拆分：一行一个知识点 */
  const lines = useMemo(
    () =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    [text],
  );

  /** 点候选：把正在输入的那一行换成已有知识点的正式标题，提交时就会命中复用 */
  const applySuggestion = (title: string) => {
    const parts = text.split("\n");
    parts[parts.length - 1] = title;
    setText(parts.join("\n"));
    areaRef.current?.focus();
  };

  const submit = async () => {
    if (!target || busy) return;
    if (lines.length === 0) {
      setError("先输入至少一个知识点，一行一个。");
      areaRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    // 返回的是真正落地的那批节点；失败或形成循环依赖时为 null
    const payload = await workspaceApi().addPrerequisites(target.id, lines);
    setBusy(false);
    if (!payload) {
      /*
       * 失败或形成循环依赖：输入必须留着（重打一遍太贵），原因写在这里。
       * store 在失败时会把自己的提示写进 notice，这里把它取出来当原因，
       * 于是弹窗里和提示条上说的是同一件事。
       */
      const notice = noticeSnapshot();
      setError(
        notice && notice.kind !== "success"
          ? notice.text
          : "没有添加成功。请确认存储可写，或稍后重试。",
      );
      return;
    }
    onClose();
  };

  if (!target) {
    return (
      <Dialog
        title="添加前置知识"
        onClose={onClose}
        footer={
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        }
      >
        <p className="empty-text">找不到这个知识点，可能已经被删除了。</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="添加前置知识"
      subtitle={`为「${target.title}」建立新的依赖`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || lines.length === 0}
          >
            {busy
              ? "添加中…"
              : lines.length > 1
                ? `添加 ${lines.length} 个`
                : "添加前置知识"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={inputId}>需要先理解什么？</label>
        <textarea
          id={inputId}
          ref={areaRef}
          rows={4}
          value={text}
          placeholder={"一行一个知识点，例如：\n查询、键与值\n缩放点积"}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          /*
           * 回车不在这里处理，让它保持浏览器默认行为——换行。
           * 之前一行时回车会提交、多行时又变成换行，同一个按键两种含义，
           * 想接着加第二个知识点时会被提前提交。提交只走按钮。
           */
        />
        <p>
          一行一个知识点，回车用于换行。已有知识点会自动复用（只建立关系，不重复建点），
          新概念会建点并连接。
          {lines.length > 0 && (
            <>
              {" "}
              已识别 <b>{lines.length}</b> 个。
            </>
          )}
        </p>

        {suggestions.length > 0 && (
          <div className="chip-row">
            <span className="empty-text">已有相似知识点，点击填入正式标题：</span>
            {suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className="chip reuse"
                title={`复用「${s.title}」作为前置知识`}
                onClick={() => applySuggestion(s.title)}
              >
                {s.title}
                <span className="chip-tag">复用</span>
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
