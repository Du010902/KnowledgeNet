/**
 * 资料面板：节点里的普通文件、URL 与引用
 *
 * v2 的一条硬规则改变了这个面板的语义：**节点目录里的普通文件本来就是用户资产**，
 * 不需要登记就已经属于这个知识点（见契约 §1.5 与设计文档 §12.2）。
 * `resources.json` 只保存展示名、说明、排序与最近一次已知哈希这些**可选增强信息**。
 *
 * 所以这里分两块展示，而不是旧的「正式资料 / 未登记文件」：
 * - **节点里的文件**：扫描磁盘得到的真实清单，有没有说明都会列出来；
 * - **链接与引用**：只存在于 resources.json 里的 URL / citation。
 *
 * 删除同样按 v2 语义分两级：
 * - 「移除说明」只删 resources.json 里的条目，文件一个字节都不动（默认动作）；
 * - 「删除文件」才会真的删磁盘文件，需要二次确认，且明确写出后果。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons";
import type { NodeFileEntry, NodeResource, ResourcePatch } from "@/data/types";
import { repoSnapshot, resolveAction, useWorkspace, workspaceApi } from "./workspace/bridge";
import { formatBytes } from "@/format";


function formatTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 资料类型对应的图标：文件 / 链接 / 引用 */
function iconFor(resource: NodeResource) {
  if (resource.resourceType === "url") return "link" as const;
  if (resource.resourceType === "citation") return "note" as const;
  return "file" as const;
}

/**
 * 执行一次写操作并给出失败原因。
 *
 * store 里的 `runWrite` 负责会话校验与错误分流，但它不在契约 §5.5 冻结的动作清单里，
 * 因此这里按「有就用、没有就直接调仓储」处理，失败一律报出来，绝不静默。
 */
async function perform<T>(
  label: string,
  action: (repo: NonNullable<ReturnType<typeof repoSnapshot>>) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const repo = repoSnapshot();
  if (!repo) {
    const error = "还没有打开知识库。";
    workspaceApi().notify("warn", error);
    return { ok: false, error };
  }
  const runWrite = resolveAction("runWrite");
  if (runWrite) {
    const result = (await runWrite(label, action, { reloadGraph: false })) as
      | { ok: true; value: T }
      | { ok: false; error?: string };
    if (!result.ok) return { ok: false, error: result.error ?? `${label}失败` };
    return { ok: true, value: result.value };
  }
  try {
    return { ok: true, value: await action(repo) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    workspaceApi().notify("error", `${label}失败：${error}`);
    return { ok: false, error };
  }
}

export function ResourcesPanel({ nodeId }: { nodeId: string }) {
  const repoRef = useWorkspace((s) => s.repo);
  const writable = useWorkspace((s) => s.canWrite());
  const isDemo = useWorkspace((s) => s.isDemo);

  const [resources, setResources] = useState<NodeResource[] | null>(null);
  const [files, setFiles] = useState<NodeFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [urlOpen, setUrlOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");
  const urlRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const repo = repoSnapshot();
    if (!repo) {
      setResources([]);
      setFiles([]);
      return;
    }
    try {
      const list = await repo.listResources(nodeId);
      setResources(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      setResources([]);
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      // 普通文件清单来自磁盘扫描：读不到不该让整个面板变空
      const plain = await repo.listPlainFiles(nodeId);
      setFiles(Array.isArray(plain) ? plain : []);
    } catch {
      setFiles([]);
    }
  }, [nodeId]);

  useEffect(() => {
    setResources(null);
    setEditing(null);
    setUrlOpen(false);
    void reload();
  }, [reload, repoRef]);

  useEffect(() => {
    if (urlOpen) urlRef.current?.focus();
  }, [urlOpen]);

  /* --------------------------------- 动作 --------------------------------- */

  const addFiles = async () => {
    /*
     * 演示模式没有真实文件选择器：静默什么都不发生最容易被当成「按钮坏了」，
     * 因此明确说一句，并指出桌面版才有这个能力。
     */
    if (isDemo) {
      workspaceApi().notify(
        "warn",
        "演示模式不能选择本地文件：这一步需要桌面版（文件要复制进知识库文件夹）。",
      );
      return;
    }
    const paths = await workspaceApi().pickFiles();
    if (paths.length === 0) return;
    setBusyLabel(`正在复制 ${paths.length} 个文件进节点目录…`);
    let added = 0;
    for (const path of paths) {
      // 逐个提交：一个大文件失败不该把已经复制好的那几个一起丢掉
      const result = await perform("添加资料", (repo) => repo.addResourceFile(nodeId, path));
      if (!result.ok) break;
      added += 1;
    }
    setBusyLabel(null);
    if (added > 0) {
      workspaceApi().notify("success", `已添加 ${added} 个资料（已复制进知识库，可随知识库一起拷走）`);
      await reload();
    }
  };

  const addUrl = async () => {
    const url = urlDraft.trim();
    if (!url) return;
    const result = await perform("添加链接", (repo) => repo.addResourceUrl(nodeId, url));
    if (!result.ok) return;
    setUrlDraft("");
    setUrlOpen(false);
    workspaceApi().notify("success", "已添加链接资料（只登记网址，不下载内容）");
    await reload();
  };

  const openResource = async (resource: NodeResource) => {
    const result = await perform("打开资料", (repo) => repo.openResource(resource.id));
    if (!result.ok) setError(result.error);
  };

  const revealResource = async (resource: NodeResource) => {
    const result = await perform("显示位置", (repo) => repo.revealResource(resource.id));
    if (!result.ok) setError(result.error);
  };

  /** 移除说明：只去掉 resources.json 里的条目，文件留在原地 */
  const removeAnnotation = async (resource: NodeResource) => {
    const result = await perform("移除说明", (repo) => repo.deleteResource(resource.id, false));
    if (!result.ok) return;
    workspaceApi().notify(
      "info",
      resource.resourceType === "file"
        ? `已移除「${resource.displayName || resource.originalName}」的说明，文件仍在节点文件夹里。`
        : `已删除链接「${resource.displayName || resource.sourceUrl}」。`,
    );
    await reload();
  };

  /**
   * 删除文件：真的动磁盘，必须先确认。
   *
   * 桌面版把文件移进 `.knowledgenet/trash/resources/<资源 ID>/`，不是直接抹掉
   * （见 `src-tauri/src/v2/resources.rs`）。因此文案不能说「不可撤销」——
   * 那与磁盘上的行为不符，也会让用户以为没有退路。
   */
  const deleteFile = async (resource: NodeResource) => {
    const name = resource.displayName || resource.originalName || resource.relativePath || "";
    if (
      !window.confirm(
        `删除文件「${name}」？\n\n` +
          `桌面版会把它移进知识库的回收站（.knowledgenet/trash/resources/），` +
          `文件仍在知识库文件夹里，可以人工找回；当前界面还没有恢复入口。\n` +
          `如果只是想让它不出现在资料列表里，请用「移除说明」。`,
      )
    ) {
      return;
    }
    const result = await perform("删除文件", (repo) => repo.deleteResource(resource.id, true));
    if (!result.ok) return;
    workspaceApi().notify("info", `已删除文件「${name}」，桌面版可在知识库回收站里找回。`);
    await reload();
  };

  const startEdit = (resource: NodeResource) => {
    setEditing(resource.id);
    setEditName(resource.displayName);
    setEditNote(resource.description);
  };

  const saveEdit = async (resource: NodeResource) => {
    const patch: ResourcePatch = {
      displayName: editName.trim() || resource.originalName,
      description: editNote,
    };
    const result = await perform("保存资料信息", (repo) =>
      repo.updateResource(resource.id, patch),
    );
    if (!result.ok) return;
    setEditing(null);
    await reload();
  };

  /** 给节点里的一个普通文件加上说明（写进 resources.json，文件不动） */
  const annotate = async (file: NodeFileEntry) => {
    const result = await perform("添加说明", (repo) => repo.annotatePlainFile(nodeId, file.relativePath));
    if (!result.ok) return;
    workspaceApi().notify("success", `已为「${file.name}」建立资料说明，文件没有移动。`);
    await reload();
  };

  const annotatedPaths = new Set(
    (resources ?? [])
      .filter((r) => r.resourceType === "file" && r.relativePath)
      .map((r) => r.relativePath as string),
  );
  const links = (resources ?? []).filter((r) => r.resourceType !== "file");
  const fileAnnotations = (resources ?? []).filter((r) => r.resourceType === "file");

  if (resources === null) {
    return <p className="empty-text">正在读取资料…</p>;
  }

  return (
    <>
      {/* ------------------------------ 节点里的文件 ------------------------------ */}
      <div className="block">
        <div className="block-head">
          <h3>
            节点里的文件 <span className="muted small">{files.length}</span>
          </h3>
          <div className="head-actions">
            <button
              type="button"
              disabled={!writable}
              title={
                !writable
                  ? "只读知识库或有操作进行中，暂时不能添加"
                  : isDemo
                    ? "演示模式不能选择本地文件：这一步需要桌面版"
                    : "选择一个或多个文件，复制进这个节点的文件夹"
              }
              onClick={() => void addFiles()}
            >
              <Icon name="paperclip" />
              添加文件
            </button>
          </div>
        </div>

        <p className="empty-text">
          这些就是节点文件夹里的真实文件：它们不需要登记就已经属于这个知识点，
          知识库拷到别处也一起走。给某个文件写一句说明，只是让它更好找。
        </p>

        {files.length === 0 && <p className="empty-text">这个节点的文件夹里还没有普通文件。</p>}

        {files.map((file) => {
          const annotated = annotatedPaths.has(file.relativePath);
          const annotation = fileAnnotations.find((r) => r.relativePath === file.relativePath);
          const editingThis = annotation && editing === annotation.id;
          return (
            <div key={file.relativePath} className="resource">
              {editingThis && annotation ? (
                <EditForm
                  name={editName}
                  note={editNote}
                  writable={writable}
                  onName={setEditName}
                  onNote={setEditNote}
                  onSave={() => void saveEdit(annotation)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  <div className="resource-main">
                    <Icon name={file.isDir ? "folder" : "file"} />
                    <span className="resource-name" title={file.relativePath}>
                      {annotation?.displayName || file.name}
                    </span>
                    {annotated && <span className="pill">有说明</span>}
                    <span className="resource-meta">
                      {file.isDir ? "文件夹" : formatBytes(file.byteLength)} ·{" "}
                      {formatTime(file.modifiedMs)}
                    </span>
                  </div>
                  {annotation?.description && (
                    <p className="resource-desc">{annotation.description}</p>
                  )}
                  <div className="resource-actions">
                    {annotation ? (
                      <>
                        <button
                          type="button"
                          className="btn sm"
                          title="在文件管理器里显示它的位置"
                          onClick={() => void revealResource(annotation)}
                        >
                          <Icon name="folder" />
                          显示位置
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={!writable}
                          onClick={() => startEdit(annotation)}
                        >
                          <Icon name="edit" />
                          改名 / 说明
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={!writable}
                          title="只移除说明，文件保留在节点文件夹里"
                          onClick={() => void removeAnnotation(annotation)}
                        >
                          <Icon name="close" />
                          移除说明
                        </button>
                        <button
                          type="button"
                          className="btn sm danger"
                          disabled={!writable}
                          title="移进知识库回收站（.knowledgenet/trash/resources/），可以人工找回"
                          onClick={() => void deleteFile(annotation)}
                        >
                          <Icon name="trash" />
                          删除文件
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!writable}
                        title="写一句说明，文件本身不动"
                        onClick={() => void annotate(file)}
                      >
                        <Icon name="plus" />
                        添加说明
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* ------------------------------- 链接与引用 ------------------------------- */}
      <div className="block">
        <div className="block-head">
          <h3>
            链接与引用 <span className="muted small">{links.length}</span>
          </h3>
          <div className="head-actions">
            <button
              type="button"
              disabled={!writable}
              title={writable ? "只登记网址，不下载内容" : "只读知识库或有操作进行中，暂时不能添加"}
              onClick={() => setUrlOpen((open) => !open)}
            >
              <Icon name="link" />
              添加 URL
            </button>
          </div>
        </div>

        {urlOpen && (
          <div className="field">
            <input
              ref={urlRef}
              value={urlDraft}
              placeholder="https://…"
              aria-label="资料网址"
              spellCheck={false}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addUrl();
                if (e.key === "Escape") setUrlOpen(false);
              }}
            />
            <div className="field-row">
              <button type="button" className="btn" disabled={!writable} onClick={() => void addUrl()}>
                添加
              </button>
              <button type="button" className="btn" onClick={() => setUrlOpen(false)}>
                取消
              </button>
            </div>
            <p className="field-note">只允许 http / https 链接。URL 资料只写进 resources.json，不创建文件。</p>
          </div>
        )}

        {busyLabel && <p className="inline-feedback">{busyLabel}</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        {links.length === 0 && <p className="empty-text">还没有链接或引用资料。</p>}

        {links.map((resource) => (
          <div key={resource.id} className="resource">
            {editing === resource.id ? (
              <EditForm
                name={editName}
                note={editNote}
                writable={writable}
                onName={setEditName}
                onNote={setEditNote}
                onSave={() => void saveEdit(resource)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                <div className="resource-main">
                  <Icon name={iconFor(resource)} />
                  <button
                    type="button"
                    className="resource-name"
                    title="用系统浏览器打开"
                    onClick={() => void openResource(resource)}
                  >
                    {resource.displayName || resource.originalName || resource.sourceUrl}
                  </button>
                  {resource.sourceUrl && (
                    <span className="resource-meta mono small" title={resource.sourceUrl}>
                      {resource.sourceUrl}
                    </span>
                  )}
                </div>
                {resource.description && <p className="resource-desc">{resource.description}</p>}
                <div className="resource-actions">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!writable}
                    onClick={() => startEdit(resource)}
                  >
                    <Icon name="edit" />
                    改名 / 说明
                  </button>
                  <button
                    type="button"
                    className="btn sm danger"
                    disabled={!writable}
                    title="只删除这条登记，不涉及任何文件"
                    onClick={() => void removeAnnotation(resource)}
                  >
                    <Icon name="trash" />
                    删除链接
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {isDemo && (
        <p className="field-note">
          演示模式下资料只登记在浏览器存储里：打开与显示位置会失败，这是预期行为。
        </p>
      )}
    </>
  );
}

/** 改名 / 说明的表单：文件块与链接块共用 */
function EditForm({
  name,
  note,
  writable,
  onName,
  onNote,
  onSave,
  onCancel,
}: {
  name: string;
  note: string;
  writable: boolean;
  onName: (value: string) => void;
  onNote: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="field">
      <div className="field-label">显示名</div>
      <input
        value={name}
        spellCheck={false}
        aria-label="资料显示名"
        onChange={(e) => onName(e.target.value)}
      />
      <div className="field-label">说明</div>
      <input
        value={note}
        spellCheck={false}
        placeholder="这份资料是用来做什么的…"
        aria-label="资料说明"
        onChange={(e) => onNote(e.target.value)}
      />
      <div className="field-row">
        <button type="button" className="btn" disabled={!writable} onClick={onSave}>
          保存
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
      <p className="field-note">改名只改显示名，磁盘上的文件名不动。</p>
    </div>
  );
}
