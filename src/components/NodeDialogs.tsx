/**
 * 节点级弹窗：新建 / 重命名 / 合并 / 彻底删除
 *
 * 这些动作有两个入口（画布右键菜单、工作区标题栏的「更多操作」），因此集中在这里。
 * 各写一份的代价不只是重复：「删除会连带删掉什么」这种话一旦有两处说法，
 * 迟早会有一处说得不对，而使用者正是照着这句话决定要不要按下去的。
 *
 * 成功判定一律回到 store 的真实状态（节点还在不在、标题变没变），
 * 不拿「函数没抛异常」当成功——store 内部的写操作失败时并不抛出，只发提示。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { formatBytes } from "@/format";
import { isImeComposing } from "@/keyboard";
import type { NodeBackup, NodeFolderUsage } from "@/data/types";
import { graphSnapshot, noticeSnapshot, useChat, useWorkspace, workspaceApi } from "./workspace/bridge";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";

/* --------------------------------- 重命名 --------------------------------- */

export function RenameNodeDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node = useWorkspace((s) => s.graph.nodes.find((n) => n.id === nodeId) ?? null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(node?.title ?? "");
  const [busy, setBusy] = useState(false);

  /*
   * 焦点放到名称输入框并全选，而不是让浏览器选中弹窗里的第一个可聚焦元素（关闭按钮）。
   * 这里的 focus 晚于 Dialog 的 showModal 执行，因此能覆盖浏览器的默认焦点。
   */
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    if (!node || busy) return;
    const clean = title.trim();
    if (!clean || clean === node.title) {
      onClose();
      return;
    }
    setBusy(true);
    await workspaceApi().updateNode(node.id, { title: clean });
    setBusy(false);
    const saved = graphSnapshot().nodes.find((n) => n.id === node.id)?.title;
    if (saved !== clean) return; // 写失败已由 store 提示，弹窗留着让使用者重试
    onClose();
    workspaceApi().notify("success", `已重命名为「${clean}」`);
  };

  return (
    <Dialog
      title="重命名知识点"
      subtitle="名称改变，已有的依赖关系与对话都保留"
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
            disabled={busy || title.trim().length === 0}
          >
            {busy ? "保存中…" : "保存名称"}
          </button>
        </>
      }
    >
      {node ? (
        <div className="field">
          <label htmlFor={inputId}>知识点名称</label>
          <input
            id={inputId}
            ref={inputRef}
            value={title}
            maxLength={100}
            spellCheck={false}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // 输入法用回车确认候选词，此时提交会把没写完的名字存进去
              if (isImeComposing(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <p>改名不会新建节点：挂在它下面的前置知识、对话与来源都还在。</p>
        </div>
      ) : (
        <p className="empty-text">找不到这个知识点，它可能已经被删除了。</p>
      )}
    </Dialog>
  );
}

/* --------------------------------- 合并 --------------------------------- */

export function MergeNodeDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const graph = useWorkspace((s) => s.graph);
  const inputId = useId();

  const source = graph.nodes.find((n) => n.id === nodeId) ?? null;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 同上：把焦点直接放到搜索框，免得多按一次 Tab
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const candidates = useMemo(() => {
    if (!source) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return graph.nodes
      .filter(
        (n) =>
          n.id !== source.id &&
          (n.title.toLowerCase().includes(q) ||
            n.aliases.some((a) => a.toLowerCase().includes(q))),
      )
      .slice(0, 8);
  }, [graph.nodes, source, query]);

  const merge = async (targetId: string) => {
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    await workspaceApi().mergeNodes(source.id, targetId);
    setBusy(false);
    /*
     * 成功会删掉源节点。源节点还在，就说明这次合并没有落地
     * （会形成循环依赖，或落盘失败）——此时必须留在弹窗里说明原因，
     * 关掉弹窗会让人以为已经合并了。
     */
    if (graphSnapshot().nodes.some((n) => n.id === source.id)) {
      const notice = noticeSnapshot();
      setError(
        notice && notice.kind !== "success"
          ? notice.text
          : "没有合并成功，请重试；如果反复失败，先确认存储是否可写。",
      );
      return;
    }
    onClose();
  };

  return (
    <Dialog
      title="合并重复知识点"
      subtitle="关系、笔记与对话一起转移，重复依赖自动归并"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
      }
    >
      <div className="field">
        <label htmlFor={inputId}>选择要合并进的知识点</label>
        <input
          id={inputId}
          ref={inputRef}
          value={query}
          placeholder="搜索目标知识点的标题或别名"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p>
          {source
            ? `「${source.title}」的依赖关系、笔记、别名、对话与来源会转移到目标知识点，然后「${source.title}」本身被删除。`
            : "找不到这个知识点，它可能已经被删除了。"}
        </p>
      </div>

      {candidates.length > 0 && (
        <div className="chip-row">
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className="chip reuse"
              disabled={busy}
              onClick={() => void merge(c.id)}
              title={`把「${source?.title ?? ""}」合并进「${c.title}」`}
            >
              {c.title}
              <Icon name="arrow-right" />
            </button>
          ))}
        </div>
      )}

      {query.trim().length > 0 && candidates.length === 0 && (
        <p className="empty-text">没有找到匹配的知识点。换一个关键词，或先在画布上把它建出来。</p>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <p className="empty-text">会形成循环依赖的合并会被整体阻止：这种情况通常说明两个知识点的依赖方向需要先理清。</p>
    </Dialog>
  );
}

/* -------------------------------- 新建知识点 -------------------------------- */

/**
 * 新建知识点（画布右键菜单的第一个动作）。
 *
 * 建出来的是一个**普通节点**：一个文件夹加一份 `node.json`，没有任何特殊身份，
 * 和先建的那些节点地位一样。位置由 `library.json` 的 `defaults.newNodeParent` 决定。
 */
export function NewNodeDialog({ onClose }: { onClose: () => void }) {
  const writable = useWorkspace((s) => s.canWrite());
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (busy || !writable) return;
    const clean = title.trim();
    if (!clean) return;
    setBusy(true);
    const created = await workspaceApi().createNode(clean);
    setBusy(false);
    // store 失败时会自己提示并返回 null：弹窗留着，输入不用重打
    if (created) onClose();
  };

  return (
    <Dialog
      title="新建知识点"
      subtitle="它会成为一个普通文件夹，和别的知识点没有区别"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            data-new-node-submit
            onClick={() => void submit()}
            disabled={busy || !writable || title.trim().length === 0}
          >
            {busy ? "正在新建…" : "新建知识点"}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={inputId}>要搞懂什么？</label>
        <input
          id={inputId}
          ref={inputRef}
          data-new-node-title
          value={title}
          maxLength={100}
          placeholder="例如：反向传播"
          spellCheck={false}
          disabled={!writable}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            // 输入法用回车确认候选词，此时提交会建出一个半截名字的节点
            if (isImeComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <p>新知识点会出现在画布上；之后可以拉关系、写笔记、放进资料。</p>
      </div>
    </Dialog>
  );
}

/* -------------------------------- 彻底删除 -------------------------------- */

/**
 * **彻底删除**（原「移除节点身份」）。
 *
 * 为什么文案要写得这么直白：节点是普通文件夹，删除就是删文件夹。以前那一步只搬走
 * `.meta/knowledgenet`，文件夹留在磁盘上——于是它变成一个谁也看不见、却还占着空间的
 * 文件夹。现在按用户的要求把文件夹一起删掉，代价是**不可撤销**，所以：
 *
 * 1. 先把「会删掉什么」用文字列清楚，数字来自一次真实的磁盘体检（`inspectNodeFolder`）；
 * 2. 给一个「备份文件夹中的资源」按钮，把整个文件夹整份复制到
 *    `<知识库>/.knowledgenet/backups/`，并且把备份到哪了写在弹窗里；
 * 3. 只有按下「彻底删除文件夹」才真的删。
 */
export function EraseNodeDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const graph = useWorkspace((s) => s.graph);
  const threads = useChat((s) => s.threads);
  const writable = useWorkspace((s) => s.canWrite());

  const [usage, setUsage] = useState<NodeFolderUsage | null>(null);
  const [backup, setBackup] = useState<NodeBackup | null>(null);
  const [inspecting, setInspecting] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const node = graph.nodes.find((n) => n.id === nodeId) ?? null;
  const edgeCount = graph.edges.filter((e) => e.fromId === nodeId || e.toId === nodeId).length;
  const threadCount = threads.filter((t) => t.nodeId === nodeId).length;

  // 打开就量一次：那句提醒里的数字必须来自磁盘，而不是估计
  useEffect(() => {
    let alive = true;
    void (async () => {
      const measured = await workspaceApi().inspectNodeFolder(nodeId);
      if (!alive) return;
      setUsage(measured);
      setInspecting(false);
    })();
    return () => {
      alive = false;
    };
  }, [nodeId]);

  const doBackup = async () => {
    if (backingUp) return;
    setBackingUp(true);
    setError(null);
    const result = await workspaceApi().backupNodeResources(nodeId);
    setBackingUp(false);
    if (!result) {
      setError("备份没有成功。请确认知识库可写、磁盘还有空间，然后重试。");
      return;
    }
    setBackup(result);
  };

  const doErase = async () => {
    if (!node || erasing) return;
    setErasing(true);
    setError(null);
    const erased = await workspaceApi().eraseNode(node.id);
    setErasing(false);
    if (!erased) {
      setError("删除没有完成。请确认知识库可写，且文件夹里的文件没有被别的程序占用。");
      return;
    }
    onClose();
  };

  if (!node) {
    return (
      <Dialog
        title="彻底删除知识点"
        onClose={onClose}
        footer={
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        }
      >
        <p className="empty-text">这个知识点已经不存在了，可能刚在别处被删除。</p>
      </Dialog>
    );
  }

  const size = usage ? formatBytes(usage.byteSize) : "";
  const isRootNode = node.relativePath === "";

  return (
    <Dialog
      title={`彻底删除「${node.title}」？`}
      subtitle="文件夹本身会被删掉，这一步不可撤销"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn danger"
            data-erase-node
            onClick={() => void doErase()}
            disabled={erasing || !writable || isRootNode}
            title={
              isRootNode
                ? "知识库根目录本身是节点：删掉它会连整个知识库一起没了"
                : "删除这个文件夹与其中的全部文件，不可撤销"
            }
          >
            {erasing ? "正在删除…" : "彻底删除文件夹"}
          </button>
        </>
      }
    >
      {isRootNode ? (
        <p className="field-error" role="alert">
          知识库根目录本身是一个节点：删除它会连整个知识库一起删掉，因此这里不提供这个动作。
        </p>
      ) : (
        <>
          <p className="secondary-text">
            删除会把 <b>「{node.title}」这个文件夹从磁盘上删掉</b>
            {usage ? (
              <>
                ：里面有 <b>{usage.fileCount}</b> 个文件（{size}
                {usage.resourceCount > 0 ? `，其中 ${usage.resourceCount} 个是你放进来的资料` : ""}）
                ，文件夹、笔记、资料会一起消失，<b>没有回收站可还原</b>。
              </>
            ) : inspecting ? (
              "：正在数文件夹里有多少东西…"
            ) : (
              "，文件夹里的文件会一起消失。"
            )}
          </p>

          <div className="list">
            <div className="list-item plain">
              <div className="row">
                <Icon name="trash" />
                <span>
                  文件夹与其中的 <b>{usage?.fileCount ?? "全部"}</b> 个文件从磁盘上删除
                </span>
              </div>
            </div>
            <div className="list-item plain">
              <div className="row">
                <Icon name="note" />
                <span>
                  <b>{edgeCount}</b> 条依赖、<b>{threadCount}</b> 个对话、以及它们的消息一起消失
                </span>
              </div>
            </div>
            {usage && usage.nestedNodeCount > 0 && (
              <div className="list-item plain">
                <div className="row">
                  <Icon name="alert" />
                  <span>
                    这个文件夹里还套着 <b>{usage.nestedNodeCount}</b> 个下级知识点，它们也会一起被删掉
                  </span>
                </div>
              </div>
            )}
            <div className="list-item plain">
              <div className="row">
                <Icon name="info" />
                <span>其它知识点里指向它的依赖会变成「悬空」，不会自动删除（和移动文件夹时一样）</span>
              </div>
            </div>
          </div>

          <div className="field">
            <label>删之前先留一份？</label>
            <div className="row">
              <button
                type="button"
                className="btn"
                data-backup-node
                onClick={() => void doBackup()}
                disabled={backingUp || !writable}
              >
                {backingUp ? "正在备份…" : backup ? "再备份一次" : "备份文件夹中的资源"}
              </button>
              {backup && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void workspaceApi().revealBackup(backup.backupRelativePath)}
                >
                  打开备份所在文件夹
                </button>
              )}
            </div>
            {backup ? (
              <p className="backup-note" role="status">
                已备份 <b>{backup.fileCount}</b> 个文件（{formatBytes(backup.byteSize)}）到：
                <br />
                <code data-backup-path>{backup.backupPath}</code>
                <br />
                备份是整个文件夹的一份原样副本，放在知识库里、不会被当成节点；
                以后把这份副本拷回原处就又是一个完整的知识点。
              </p>
            ) : (
              <p>
                备份会把整个文件夹（含笔记、资料与对话）原样复制到知识库的{" "}
                <code>.knowledgenet/backups/</code> 下，复制完成后再删也不迟。
              </p>
            )}
          </div>

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

