/**
 * 笔记与别名
 *
 * 笔记正文**不在知识图里**：一万个节点时那是全部 Markdown。所以进入节点时
 * 用 `readNote` 按需读 `nodes/<id>/note.md`，保存时带上手上的 `documentRevision`。
 *
 * 保存体验保留原来的两条路：停止输入 1.4 秒后自动写一次，失焦（包括点画布切节点）立刻写。
 *
 * 冲突是这个界面最重要的一条规则：修订号过期或磁盘哈希对不上时**绝不自动覆盖**，
 * 而是把三种选择摆出来——重新加载 / 覆盖保存 / 另存冲突副本。
 * 规则本身在 `noteFlow.ts` 里（与 React 无关，可单独测试），这里只负责渲染与转发选择。
 *
 * 外部改动（用别的编辑器改了 note.md）在进入节点与窗口重新获得焦点时检查：
 * 没有草稿就自动重新加载；有草稿就显示冲突，两边都不动。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";

import { isImeComposing } from "@/keyboard";
import { renderMarkdown } from "@/markdown";
import { useStore } from "@/store";
import { resolvedTheme, subscribeTheme, type ResolvedTheme } from "@/theme";
import { Icon } from "./icons";
import { NoteFlow, type NoteFlowState, type SaveOutcome } from "./noteFlow";

/** CodeMirror 主题：值写 CSS 变量，深浅色都由变量决定，组件不判断主题 */
function editorTheme(resolved: ResolvedTheme) {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "transparent",
        color: "var(--text)",
        fontFamily: "var(--font)",
      },
      ".cm-content": { caretColor: "var(--accent)", fontFamily: "var(--font)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--accent-soft)",
      },
      ".cm-activeLine": { backgroundColor: "transparent" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--muted)",
      },
    },
    { dark: resolved === "dark" },
  );
}

/** 保存状态：界面上只显示「这一份到底有没有落盘」 */
type NoteSaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";

export function NodeNotes({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.graph.nodes.find((n) => n.id === nodeId) ?? null);
  const repo = useStore((s) => s.repo);
  const writable = useStore((s) => s.canWrite());
  const updateNode = useStore((s) => s.updateNode);
  const notify = useStore((s) => s.notify);
  const aliasId = useId();

  const [flowState, setFlowState] = useState<NoteFlowState | null>(null);
  const [saveState, setSaveState] = useState<NoteSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [aliases, setAliases] = useState(node?.aliases.join("，") ?? "");
  const [preview, setPreview] = useState(false);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolvedTheme());

  /** 最近一次保存的结果：用来显示「已保存 / 有冲突 / 保存失败」 */
  const lastOutcome = useRef<SaveOutcome | null>(null);

  // 每次渲染都取最新的 repo / writable，避免把旧闭包里的句柄留给流程
  const depsRef = useRef({ repo, writable, nodeId });
  depsRef.current = { repo, writable, nodeId };

  const flowRef = useRef<NoteFlow | null>(null);
  if (flowRef.current === null) {
    flowRef.current = new NoteFlow({
      read: (id) => {
        const repository = depsRef.current.repo;
        if (!repository) throw new Error("还没有打开知识库，笔记不可用");
        return repository.readNote(id);
      },
      write: (id, content, revision, force) => {
        const repository = depsRef.current.repo;
        if (!repository) throw new Error("还没有打开知识库，笔记不可用");
        return repository.writeNote(id, content, revision, force);
      },
      check: (id) => {
        const repository = depsRef.current.repo;
        if (!repository) throw new Error("还没有打开知识库，笔记不可用");
        return repository.checkNote(id);
      },
      canWrite: () => depsRef.current.writable,
    });
  }
  const flow = flowRef.current;

  useEffect(() => {
    flow.onChange = (next) => {
      setFlowState(next);
      setSaveError(next.error);
      if (next.conflict) setSaveState("conflict");
    };
  }, [flow]);

  const note = flowState?.note ?? null;
  const draft = flowState?.draft ?? "";
  const loading = flowState === null || flowState.status === "loading";
  const loadError = flowState?.status === "error" ? flowState.error : null;
  const conflict = flowState?.conflict ?? null;
  const dirty = flowState !== null && flow.dirty;

  useEffect(() => subscribeTheme((_mode, next) => setResolved(next)), []);

  useEffect(() => {
    setAliases(node?.aliases.join("，") ?? "");
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换节点：重新按需读取这一份正文，绝不把上一个节点的内容写进这个节点
  useEffect(() => {
    lastOutcome.current = null;
    setSaveState("idle");
    void flow.open(nodeId);
  }, [flow, nodeId]);

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage }), EditorView.lineWrapping, editorTheme(resolved)],
    [resolved],
  );

  /** 写一次笔记：`force` 只由用户在冲突界面里的选择传进来 */
  const write = async (force = false) => {
    setSaveState(force ? "saving" : "saving");
    const outcome = await flow.save({ force });
    lastOutcome.current = outcome;
    if (outcome === "conflict") {
      setSaveState("conflict");
      return outcome;
    }
    if (outcome === "error" || outcome === "readonly") {
      setSaveState("error");
      return outcome;
    }
    if (outcome === "saved") setSaveState("saved");
    else setSaveState("idle");
    return outcome;
  };

  /**
   * 检查磁盘上的 note.md 是否被外部改动。
   *
   * 没有草稿就自动重新加载；有草稿就显示冲突，两边都不动。
   */
  const checkExternal = async () => {
    const result = await flow.checkExternal();
    if (result === "reloaded") {
      setSaveState("idle");
      notify("info", "这份笔记被外部修改过，已重新载入磁盘上的版本。");
    } else if (result === "conflict") {
      setSaveState("conflict");
    }
  };

  // 进入节点时检查一次外部改动（载入完成后）
  useEffect(() => {
    if (flowState?.status === "ready" && !flow.blocked) void checkExternal();
    // 只在「刚载入完某个节点」时检查一次：之后由窗口焦点触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowState?.status, flowState?.note?.documentRevision, nodeId]);

  // 窗口重新获得焦点时检查：用户很可能刚在别的编辑器里改过。
  // 监听只装一次，处理函数从 ref 里取最新的那一份（否则每次渲染都要重装监听）。
  const checkRef = useRef(checkExternal);
  checkRef.current = checkExternal;
  useEffect(() => {
    const onFocus = () => void checkRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // 自动保存：最后一次输入后 1.4 秒写一次
  useEffect(() => {
    if (!dirty || flow.blocked) return;
    const timer = window.setTimeout(() => void write(), 1400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, flowState?.note?.documentRevision]);

  /** 失焦（包括点画布切节点）时立刻写一次，不等防抖 */
  const commitNow = () => {
    if (!flow.blocked && flow.dirty) void write();
    void commitAliases();
  };

  const commitAliases = async () => {
    if (!node) return;
    const clean = aliases
      .split(/[，,;；\n]/)
      .map((a) => a.trim())
      .filter(Boolean);
    if (clean.join("|") === node.aliases.join("|")) return;
    await updateNode(node.id, { aliases: clean });
  };

  /* -------------------------------- 冲突处理 -------------------------------- */

  /** 重新加载：丢掉草稿，采用磁盘版本 */
  const reloadFromDisk = async () => {
    await flow.reloadFromDisk();
    lastOutcome.current = null;
    setSaveState("idle");
    notify("info", "已重新载入磁盘上的版本，你刚才的修改已丢弃。");
  };

  /** 覆盖保存：用户的草稿为准，磁盘旧版本会被另存成冲突副本 */
  const overwrite = async () => {
    await write(true);
  };

  /**
   * 另存冲突副本。
   *
   * 先把当前草稿作为当前版本写进磁盘（force，旧版本由数据层另存），
   * 两边的内容都不会丢，磁盘上原来那一份在操作目录的 conflicts 下留档。
   */
  const saveAsConflictCopy = async () => {
    const outcome = await write(true);
    if (outcome === "saved") {
      notify(
        "info",
        "已把你的版本保存为当前版本，磁盘上原来的那一份已由数据层另存为冲突副本（在操作目录的 conflicts 下）。",
      );
    }
  };

  if (!node) {
    return <p className="empty-text">这个知识点已经被删除了，笔记不再可用。</p>;
  }

  /**
   * 显示用的保存状态。
   *
   * 「有未保存的修改」直接由流程的 dirty 决定，而不是让组件自己记一份：
   * 这两处一旦不同步，界面就会显示「已保存」而磁盘上还是没有。
   */
  const displayState: NoteSaveState =
    saveState === "saving"
      ? "saving"
      : conflict
        ? "conflict"
        : saveState === "error"
          ? "error"
          : dirty
            ? "dirty"
            : saveState === "saved"
              ? "saved"
              : "idle";

  const saveText =
    displayState === "conflict"
      ? "有冲突，等待处理"
      : displayState === "saving"
        ? "保存中…"
        : displayState === "error"
          ? `保存失败：${saveError ?? "原因未知"}`
          : displayState === "dirty"
            ? "有未保存的修改"
            : displayState === "saved"
              ? "已保存"
              : "自动保存草稿";

  return (
    <>
      <div className="note-toolbar">
        <h3>笔记</h3>
        <button type="button" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
          <Icon name={preview ? "edit" : "eye"} />
          {preview ? "编辑" : "预览"}
        </button>
      </div>

      {loading && <p className="empty-text">正在读取 note.md…</p>}
      {loadError && !loading && (
        <p className="field-error" role="alert">
          {loadError}
        </p>
      )}

      {conflict && !loading && (
        <div className="chat-banner warn note-conflict" role="alert">
          <Icon name="alert" />
          <div>
            <strong>磁盘上的笔记已经被改动，你的草稿没有保存。</strong>
            <p>
              {conflict.detail.detail}
              （你手上的修订号 {conflict.detail.expectedRevision}，磁盘上是{" "}
              {conflict.detail.disk.documentRevision}
              {conflict.copy ? `；旧版本已另存到 ${conflict.copy}` : ""}）
            </p>
            <div className="field-row">
              <button type="button" className="btn" onClick={() => void reloadFromDisk()}>
                <Icon name="refresh" />
                重新加载（丢弃我的草稿）
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={!writable}
                title="以你的草稿为准写入；磁盘上原来的版本会由数据层另存为冲突副本"
                onClick={() => void overwrite()}
              >
                <Icon name="upload" />
                覆盖保存
              </button>
              <button
                type="button"
                className="btn"
                disabled={!writable}
                title="把你的版本写进去，并保留磁盘上原来的那一份"
                onClick={() => void saveAsConflictCopy()}
              >
                <Icon name="copy" />
                另存冲突副本
              </button>
            </div>
          </div>
        </div>
      )}

      {!loading && !loadError && (
        <>
          {preview ? (
            <div
              className="note-preview markdown-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(draft || "（还没有笔记）") }}
            />
          ) : (
            <div className="note-editor" onBlur={commitNow}>
              <CodeMirror
                value={draft}
                height="270px"
                /*
                 * theme="none" 关掉 @uiw/react-codemirror 自带的浅色主题（它会把编辑器背景
                 * 写死成白色）。颜色全部交给上面那个取 CSS 变量的主题扩展，
                 * 这样深色模式下编辑器才真的是深色。
                 */
                theme="none"
                editable={writable}
                extensions={extensions}
                onChange={(next) => {
                  flow.setDraft(next);
                }}
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: false,
                  autocompletion: false,
                }}
              />
            </div>
          )}

          <div className="note-meta">
            <span>
              Markdown · 修订号 {note?.documentRevision ?? "—"}
              {note ? ` · ${note.byteLength} 字节` : ""}
            </span>
            <span className={displayState === "error" ? "note-save-error" : undefined}>
              {saveText}
            </span>
          </div>

          {!writable && (
            <p className="field-note">
              这是只读知识库：笔记可以查看，但不能保存。要修改请先关闭其它正在使用它的实例。
            </p>
          )}

          <div className="alias-block">
            <label htmlFor={aliasId}>别名 / 同义写法</label>
            <input
              id={aliasId}
              value={aliases}
              placeholder="用逗号分隔，例如：Attention，注意力"
              spellCheck={false}
              disabled={!writable}
              onChange={(e) => setAliases(e.target.value)}
              onBlur={() => void commitAliases()}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <p>录入前置知识与搜索时也会匹配这些名称，命中即复用，不会重复建点。</p>
          </div>
        </>
      )}
    </>
  );
}
