/**
 * 知识库弹窗：位置与统计、迁移、创建副本、图 JSON 导出、已移除的节点身份、完整性检查
 *
 * 这个弹窗里同时存在「安全操作」和「不可撤销操作」，所以每一块的措辞都必须能把语义分清：
 * - 移除节点身份：只把 `.meta/knowledgenet` 移进 `<root>/.knowledgenet/trash`，**普通文件一个都不动**；
 * - 彻底清除：删掉回收站里的那份元数据，不可撤销，动手前先把范围列清楚；
 * - 创建副本（快照）：保留原 libraryId，用来「回到那一刻」；
 * - 另存为独立知识库：生成新 libraryId，从此两份库各自积累；
 * - 图 JSON 导出：交换/调试格式，**不是完整备份**（不含笔记正文、资料、对话与书签）。
 *
 * 关于类型：v2 正在替换 `src/data/types.ts` 里的一批模型（回收站、清除预览、修复动作……），
 * 因此这里只声明自己需要的最小形状，并按运行时的样子读返回值。
 * 弹窗不该因为一个可选字段改名字就整页编译不过。
 */
import { useCallback, useEffect, useState } from "react";

import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/icons";
import { resolveAction, useWorkspace, workspaceApi } from "@/components/workspace/bridge";
import { formatBytes } from "@/format";
/* --------------------------------- 最小模型 --------------------------------- */

type Severity = "error" | "warning" | "info";

interface IssueLike {
  id: string;
  kind: string;
  severity: Severity;
  entityId: string;
  path: string | null;
  detail: string;
}

interface CountsLike {
  filesChecked?: number;
  bytesChecked?: number;
  unregisteredFiles?: number;
  orphanDirectories?: number;
}

interface ReportLike {
  deep: boolean;
  checkedAt: number;
  issues: IssueLike[];
  counts?: CountsLike;
  ok: boolean;
  truncated?: boolean;
  warnings?: string[];
}

interface RepairAppliedLike {
  action?: string;
  ok?: boolean;
}

interface RepairReportLike {
  applied: RepairAppliedLike[];
  report: ReportLike;
}

/** 已移除的节点身份 / 回收站条目：两种实现的字段并集，全部可选 */
interface RemovedLike {
  id?: string;
  kind?: "node" | "resource" | string;
  nodeId?: string;
  title?: string;
  relativePath?: string;
  trashedRelpath?: string;
  trashedRelative?: string;
  deletedAt?: number;
  filesPresent?: boolean;
  resourceCount?: number;
  notePresent?: boolean;
}

interface CopyResultLike {
  libraryId: string;
  rootPath: string;
  mode?: string;
  fileCount?: number;
  byteLength?: number;
}

interface MigrationReportLike {
  fromVersion?: number;
  toVersion?: number;
  verified?: boolean;
  published?: boolean;
  recoveryRelative?: string;
  before?: Record<string, number>;
  after?: Record<string, number>;
  warnings?: string[];
}


function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  error: "错误",
  warning: "警告",
  info: "提示",
};

/**
 * 把一条可修复的问题翻译成修复动作。
 *
 * v2 只保留两类「意图唯一、无数据损失」的自动修复（见 `docs/v2-deviations.md` D7）：
 * 给重复 ID 的副本重新发号、以及重建设备索引。
 * 悬空关系、主文档缺失、元数据坏掉都**只报告不自动修**——它们要么是正常状态
 * （v2 允许悬空边），要么根本无法猜测用户想怎么办。
 * 认不出的问题不猜怎么修：交给人工判断，绝不动手。
 */
function actionFor(issue: IssueLike): { action: string; entityId: string; argument?: string | null } | null {
  switch (issue.kind) {
    case "duplicate_node_id":
    case "duplicate_id":
      return { action: "reassign_duplicate_id", entityId: issue.entityId, argument: issue.path };
    case "index_corrupt":
    case "index_missing":
      return { action: "rebuild_index", entityId: issue.entityId };
    case "missing_note":
    case "primary_document_missing":
      return { action: "create_empty_note", entityId: issue.entityId };
    default:
      return null;
  }
}

const ACTION_LABEL: Record<string, string> = {
  reassign_duplicate_id: "给这份副本重新发一个节点 ID（两份都保留）",
  rebuild_index: "删除设备索引并按磁盘重建（不动任何用户文件）",
  create_empty_note: "补一个空的笔记文件",
};

function issueKey(issue: IssueLike): string {
  return issue.id || `${issue.kind}:${issue.entityId}:${issue.path ?? ""}`;
}

/** 已移除身份的稳定键：v2 用 nodeId + deletedAt，旧实现用 kind + id */
function removedKey(entry: RemovedLike, index: number): string {
  return `${entry.kind ?? "node"}-${entry.nodeId ?? entry.id ?? index}-${entry.deletedAt ?? 0}`;
}

export function LibraryDialog({ onClose }: { onClose: () => void }) {
  const libraryInfo = useWorkspace((s) => s.libraryInfo);
  const isDemo = useWorkspace((s) => s.isDemo);
  const busy = useWorkspace((s) => s.busy);
  const writable = useWorkspace((s) => s.canWrite());
  const readOnly = useWorkspace((s) => s.libraryState === "readonly");
  const notify = workspaceApi().notify;

  const [removed, setRemoved] = useState<RemovedLike[] | null>(null);
  const [removedError, setRemovedError] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<RemovedLike | null>(null);
  const [report, setReport] = useState<ReportLike | null>(null);
  const [selectedIssues, setSelectedIssues] = useState<Set<string>>(new Set());
  const [repairResult, setRepairResult] = useState<string | null>(null);
  const [migration, setMigration] = useState<MigrationReportLike | null>(null);
  const [needsMigration, setNeedsMigration] = useState<number | null>(null);
  const [confirmMigrate, setConfirmMigrate] = useState(false);

  const [copyMode, setCopyMode] = useState<"snapshot" | "independent">("snapshot");
  const [copyParent, setCopyParent] = useState("");
  const [copyName, setCopyName] = useState("");
  const [copyResult, setCopyResult] = useState<CopyResultLike | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canRestore = resolveAction("restoreNodeIdentity", "restoreNode") !== null;
  const canPurge = resolveAction("purgeRemovedIdentity", "purgeNode") !== null;
  const canMigrate = resolveAction("migrateLibrary") !== null;
  /* v2 删掉了图 JSON 导出（契约 §4 的「已废弃」清单）：能力不在时整块不显示，
     而不是留一个必然报错的按钮 */
  const canExport = resolveAction("exportGraphJson") !== null;
  const canScan = workspaceApi().supports("pullScan");

  const loadRemoved = useCallback(async () => {
    const fn = resolveAction("listRemovedIdentities", "listTrash");
    if (!fn) {
      setRemoved([]);
      setRemovedError("当前状态层没有提供「已移除的节点身份」列表。");
      return;
    }
    try {
      const entries = (await fn()) as RemovedLike[] | null;
      setRemoved(Array.isArray(entries) ? entries : []);
      setRemovedError(null);
    } catch (err) {
      setRemoved([]);
      setRemovedError(`读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  /** 打开时刷新一次知识库摘要与已移除列表；迁移状态按需查询 */
  useEffect(() => {
    const refresh = resolveAction("refreshLibraryInfo");
    if (refresh) void refresh();
    void loadRemoved();
  }, [loadRemoved]);

  useEffect(() => {
    const probe = resolveAction("needsMigration");
    if (!probe) return;
    void (async () => {
      try {
        const version = (await probe()) as number | null;
        setNeedsMigration(typeof version === "number" ? version : null);
      } catch {
        // 探测失败就当「不需要迁移」：错误会在真正动手时以更明确的方式出现
        setNeedsMigration(null);
      }
    })();
  }, []);

  const doMigrate = async () => {
    const fn = resolveAction("migrateLibrary");
    if (!fn) return;
    setConfirmMigrate(false);
    setError(null);
    try {
      const result = (await fn()) as MigrationReportLike;
      setMigration(result ?? null);
      setNeedsMigration(null);
      notify(
        "success",
        "迁移完成：旧数据已按 v2 结构写入，并在 .knowledgenet/recovery 下留了恢复点。",
      );
      await loadRemoved();
    } catch (err) {
      setError(`迁移失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const doRescan = async () => {
    setError(null);
    try {
      await workspaceApi().pullScan(true);
      const refresh = resolveAction("refreshLibraryInfo");
      if (refresh) await refresh();
      notify("info", "已按磁盘现状重新扫描：索引重建，没有修改任何用户文件。");
    } catch (err) {
      setError(`扫描失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const doExport = async () => {
    setError(null);
    const fn = resolveAction("exportGraphJson");
    if (!fn) {
      setError("当前状态层没有提供图 JSON 导出。");
      return;
    }
    let json = "";
    try {
      json = (await fn()) as string;
    } catch (err) {
      setError(`导出失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!json) {
      setError("导出失败：没有拿到内容，原因见顶部提示。");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `knowledgenet-graph-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify(
      "success",
      "已导出图 JSON（只有知识点与关系）。它不是完整备份：笔记正文、资料、对话与书签都不在里面。",
    );
  };

  const doCopy = async () => {
    setError(null);
    setCopyResult(null);
    if (!copyParent) {
      setError("先选择副本要放的位置。");
      return;
    }
    if (!copyName.trim()) {
      setError("给副本起个名字。");
      return;
    }
    const fn = resolveAction("createLibraryCopy");
    if (!fn) {
      setError("当前状态层没有提供创建副本。");
      return;
    }
    try {
      const result = (await fn(copyParent, copyName.trim(), copyMode)) as CopyResultLike | null;
      if (!result) {
        setError("创建副本失败，原因见顶部提示。");
        return;
      }
      setCopyResult(result);
      notify(
        "success",
        `已创建副本：${result.fileCount ?? 0} 个文件，${formatBytes(result.byteLength ?? 0)}`,
      );
    } catch (err) {
      setError(`创建副本失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * 彻底清除一份已移除的元数据。
   *
   * v2 里这一步只删回收站中的 `.meta/knowledgenet`：文件夹与普通文件在移除身份时
   * **根本没有被动过**，所以这里不存在「删掉用户文件」这回事。
   */
  const confirmPurge = async () => {
    const entry = purgeTarget;
    if (!entry) return;
    setPurgeTarget(null);
    setError(null);
    const nodeId = entry.nodeId ?? entry.id ?? "";
    const fn = resolveAction("purgeRemovedIdentity", "purgeNode");
    if (!fn) {
      setError("当前状态层没有提供彻底清除。");
      return;
    }
    try {
      // v2 的签名带 deletedAt（同一节点可以被移除多次）；旧实现只吃 nodeId
      if (entry.deletedAt !== undefined) await fn(nodeId, entry.deletedAt);
      else await fn(nodeId);
      notify("info", "已清除回收站里的那份节点元数据。这一步不可撤销。");
      await loadRemoved();
    } catch (err) {
      setError(`清除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const restore = async (entry: RemovedLike) => {
    setError(null);
    const fn = resolveAction("restoreNodeIdentity", "restoreNode");
    const nodeId = entry.nodeId ?? entry.id ?? "";
    if (!fn) {
      setError("当前状态层没有提供恢复节点身份。");
      return;
    }
    try {
      await fn(nodeId);
      notify("success", "已恢复节点身份：它会重新出现在知识图里。");
      await loadRemoved();
    } catch (err) {
      setError(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggleIssue = (key: string) => {
    setSelectedIssues((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const doCheck = async (deep: boolean) => {
    const fn = resolveAction("checkIntegrity");
    if (!fn) {
      setError("当前状态层没有提供完整性检查。");
      return;
    }
    setError(null);
    try {
      const result = (await fn(deep)) as ReportLike | null;
      if (result) setReport(result);
    } catch (err) {
      setError(`检查失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const doRepair = async () => {
    if (!report) return;
    const actions = report.issues
      .filter((issue) => selectedIssues.has(issueKey(issue)))
      .map(actionFor)
      .filter((a): a is NonNullable<ReturnType<typeof actionFor>> => a !== null);
    if (actions.length === 0) {
      setError("没有选中可自动修复的问题。");
      return;
    }
    const fn = resolveAction("repairLibrary");
    if (!fn) {
      setError("当前状态层没有提供修复。");
      return;
    }
    setError(null);
    setRepairResult(null);
    try {
      const result = (await fn(actions)) as RepairReportLike | null;
      if (!result) {
        setError("修复失败，原因见顶部提示。");
        return;
      }
      setReport(result.report);
      setSelectedIssues(new Set());
      setRepairResult(
        `已执行 ${result.applied.length} 项修复（成功 ${result.applied.filter((a) => a.ok).length} 项），` +
          `复查后剩余 ${result.report.issues.length} 个问题。`,
      );
    } catch (err) {
      setError(`修复失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const info = libraryInfo;
  const repairable = report?.issues.filter((issue) => actionFor(issue) !== null) ?? [];
  const removedCount = removed?.length ?? 0;

  return (
    <Dialog
      title="知识库"
      subtitle="它就在你的文件夹里：这里可以看状态、做迁移、做副本、检查一致性"
      onClose={onClose}
      wide
      footer={
        <>
          <button
            type="button"
            className="btn"
            title="关闭当前知识库，回到选择界面（不会删除任何知识内容）"
            onClick={() => void workspaceApi().closeLibrary()}
          >
            <Icon name="folder" />
            关闭知识库 / 换一个
          </button>
          <button type="button" className="btn" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      {isDemo && (
        <div className="privacy-note is-warn">
          <Icon name="alert" />
          <span>
            演示模式，不是便携知识库：数据只存在浏览器存储里，关掉站点数据就会丢，
            也不能拷到 U 盘或另一台电脑。下面的创建副本、完整性检查与回收站都不具备正式能力。
          </span>
        </div>
      )}

      {/* ------------------------------- 当前位置 ------------------------------- */}
      <div className="field">
        <div className="field-label">当前知识库</div>
        {info ? (
          <>
            <div className="kv">
              <span>标题</span>
              <b>{info.title}</b>
            </div>
            <div className="kv">
              <span>根目录</span>
              <b className="mono" title={info.rootPath}>
                {info.rootPath}
              </b>
            </div>
            <div className="kv">
              <span>知识库 ID</span>
              <b className="mono">{info.libraryId}</b>
            </div>
            <div className="kv">
              <span>格式版本</span>
              <b>v{info.formatVersion}</b>
            </div>
            <div className="kv">
              <span>内容</span>
              <b>
                {info.nodeCount ?? 0} 个知识点
                {info.edgeCount !== undefined && ` · ${info.edgeCount} 条关系`}
                {info.threadCount !== undefined && ` · ${info.threadCount} 个对话`}
                {removedCount > 0 && ` · ${removedCount} 份已移除的元数据`}
              </b>
            </div>
            {(info.issueCount ?? 0) > 0 && (
              <div className="kv">
                <span>扫描问题</span>
                <b className="is-warn">{info.issueCount} 个（在下面的完整性检查里查看）</b>
              </div>
            )}
            <div className="kv">
              <span>写入</span>
              <b>
                {readOnly || info.readOnly ? (
                  <span className="pill is-readonly">只读（没有写锁）</span>
                ) : (
                  "可写"
                )}
              </b>
            </div>
          </>
        ) : (
          <p className="empty-text">还没有打开知识库。</p>
        )}
        <p className="field-note">
          节点就是普通文件夹：删节点就是在删文件夹，「彻底删除」会连里面的笔记与资料一起删掉
          （删之前可以先把整个文件夹备份到 <code>.knowledgenet/backups</code>）。
          要完整备份，关闭应用后直接复制整个知识库文件夹即可。
        </p>
      </div>

      {/* ------------------------------ 迁移与重新扫描 ------------------------------ */}
      <div className="field">
        <div className="field-label">迁移与扫描</div>
        <div className="field-row">
          {canScan && (
            <button type="button" className="btn" disabled={!!busy} onClick={() => void doRescan()}>
              <Icon name="refresh" />
              重新扫描知识库
            </button>
          )}
          {canMigrate && needsMigration !== null && !confirmMigrate && (
            <button
              type="button"
              className="btn"
              disabled={!!busy || !writable}
              onClick={() => setConfirmMigrate(true)}
            >
              <Icon name="upload" />
              迁移到 v2（当前 v{needsMigration}）
            </button>
          )}
        </div>

        {canMigrate && needsMigration === null && !migration && (
          <p className="field-note">
            这个知识库已经是 v2 结构：节点、关系与对话都以开放文件形式存在节点文件夹里。
          </p>
        )}

        {confirmMigrate && (
          <div className="field is-danger" role="alertdialog" aria-label="确认迁移">
            <div className="field-label">确认迁移到 v2？</div>
            <p>
              迁移会先把整库复制到 <code>.knowledgenet/recovery/</code> 作为恢复点，
              再写入 v2 的开放文件结构；全部校验一致之后才把 <code>library.json</code> 的
              <code>formatVersion</code> 改成 2。任一步骤失败，旧结构仍然可以打开。
            </p>
            <div className="field-row">
              <button type="button" className="btn danger" onClick={() => void doMigrate()}>
                <Icon name="upload" />
                开始迁移
              </button>
              <button type="button" className="btn" onClick={() => setConfirmMigrate(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {migration && (
          <div className="result-note" role="status">
            <Icon name={migration.verified === false ? "alert" : "check"} />
            <span>
              迁移完成：v{migration.fromVersion ?? "?"} → v{migration.toVersion ?? 2}；
              校验{migration.verified ? "通过" : "未通过"}、
              {migration.published ? "已发布" : "未发布"}
              {migration.recoveryRelative && (
                <>
                  ；恢复点在 <b className="mono">{migration.recoveryRelative}</b>
                </>
              )}
              {migration.before && migration.after && (
                <>
                  ；节点 {migration.before.nodes ?? "?"} → {migration.after.nodes ?? "?"}、对话{" "}
                  {migration.before.threads ?? "?"} → {migration.after.threads ?? "?"}、消息{" "}
                  {migration.before.messages ?? "?"} → {migration.after.messages ?? "?"}
                </>
              )}
            </span>
          </div>
        )}

        <p className="field-note">
          「重新扫描」按磁盘现状重建设备本地索引，不修改任何用户文件；
          索引坏了、被删了都可以随时重建，节点、关系与对话始终以知识库文件夹为准。
        </p>
      </div>

      {/* ------------------------------- 创建副本 ------------------------------- */}
      <div className="field">
        <div className="field-label">创建副本</div>
        <div className="segmented" role="group" aria-label="副本语义">
          <button
            type="button"
            className={copyMode === "snapshot" ? "active" : undefined}
            aria-pressed={copyMode === "snapshot"}
            onClick={() => setCopyMode("snapshot")}
          >
            创建副本（快照）
          </button>
          <button
            type="button"
            className={copyMode === "independent" ? "active" : undefined}
            aria-pressed={copyMode === "independent"}
            onClick={() => setCopyMode("independent")}
          >
            另存为独立知识库
          </button>
        </div>
        <p className="field-note">
          {copyMode === "snapshot"
            ? "创建副本（快照）：保留原 libraryId，是「回到那一刻」的备份。之后两份库虽然内容独立，但身份相同，适合保存一个时间点，不适合两边长期各自积累。"
            : "另存为独立知识库：生成新的 libraryId，等于从这里分出一个新的知识库，两份从此各自积累、互不影响。"}{" "}
          复制走的是运行中的一致性副本流程（不是复制单个数据库文件），会忽略锁与运行时暂存。
        </p>
        <div className="field-row">
          <input value={copyParent} readOnly placeholder="副本放在哪" aria-label="副本的父目录" />
          <button
            type="button"
            className="btn"
            disabled={!!busy}
            onClick={async () => {
              const picked = await workspaceApi().pickDirectory("选择副本要放的位置");
              if (picked) setCopyParent(picked);
            }}
          >
            <Icon name="folder" />
            选择…
          </button>
        </div>
        <div className="field-row">
          <input
            value={copyName}
            placeholder="副本名称，例如：数学与信号处理-2026-01"
            aria-label="副本名称"
            spellCheck={false}
            onChange={(e) => setCopyName(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={!!busy || !copyParent || copyName.trim() === ""}
            onClick={() => void doCopy()}
          >
            <Icon name="copy" />
            {copyMode === "snapshot" ? "创建快照副本" : "另存为独立知识库"}
          </button>
        </div>
        {busy && <p className="inline-feedback">{busy}</p>}
        {copyResult && (
          <div className="result-note" role="status">
            <Icon name="check" />
            <span>
              已创建于 <b className="mono">{copyResult.rootPath}</b>：{copyResult.fileCount ?? 0} 个文件，
              {formatBytes(copyResult.byteLength ?? 0)}，
              {copyResult.mode === "snapshot"
                ? `保留原知识库 ID（${copyResult.libraryId}）`
                : `新知识库 ID：${copyResult.libraryId}`}
            </span>
          </div>
        )}
      </div>

      {/* ------------------------------ 图 JSON 导出 ------------------------------ */}
      {canExport && (
        <div className="field">
          <div className="field-label">图 JSON 导出</div>
          <button type="button" className="btn" onClick={() => void doExport()}>
            <Icon name="download" />
            导出图 JSON
          </button>
          <p className="field-note">
            这是<b>交换/调试格式，不是完整备份</b>：只有知识点、关系与目标，不含笔记正文、资料文件、
            对话与书签。要完整备份，请关闭应用后直接复制整个知识库文件夹，或用上面的「创建副本」。
          </p>
        </div>
      )}

      {/* --------------------------- 已移除的节点身份 --------------------------- */}
      <div className="field">
        <div className="field-label">
          已移除的节点身份{removed ? `（${removed.length} 份）` : ""}
        </div>
        <p className="empty-text">
          这里是**旧版「移除节点身份」留下的元数据归档**：那一步只把{" "}
          <code>.meta/knowledgenet</code> 移进回收站，文件夹留在磁盘上。
          现在的「彻底删除」会把文件夹一起删掉（删之前可以备份），因此不再产生新的归档。
        </p>
        <div className="field-row">
          <button type="button" className="btn" onClick={() => void loadRemoved()}>
            <Icon name="refresh" />
            刷新
          </button>
        </div>
        {removedError && <p className="field-error">{removedError}</p>}
        {removed && removed.length === 0 && (
          <p className="empty-text">
            这里没有东西。这个知识库从来没有移除过节点身份，或者归档已经被清理。
          </p>
        )}
        {removed && removed.length > 0 && (
          <ul className="trash-list">
            {removed.map((entry, index) => {
              const nodeId = entry.nodeId ?? entry.id ?? "";
              return (
                <li key={removedKey(entry, index)}>
                  <div className="trash-main">
                    <span className="trash-title">
                      <Icon name="note" />
                      {entry.title || "（没有标题）"}
                      <span className="pill">节点身份</span>
                      {entry.filesPresent === false && (
                        <span className="pill is-warn">文件夹已不在原位</span>
                      )}
                    </span>
                    <span className="trash-meta">
                      {entry.deletedAt ? `移除于 ${formatTime(entry.deletedAt)}` : "移除时间未知"}
                      {entry.relativePath && ` · 原位置 ${entry.relativePath}`}
                      {!entry.relativePath && nodeId && ` · ${nodeId}`}
                      {entry.trashedRelative && ` · 元数据在 ${entry.trashedRelative}`}
                    </span>
                  </div>
                  <div className="trash-actions">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!!busy || !writable || !canRestore}
                      title={writable ? "把节点身份装回去（关系与对话一并回来）" : "只读知识库：不能恢复"}
                      onClick={() => void restore(entry)}
                    >
                      <Icon name="undo" />
                      恢复节点身份
                    </button>
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={!!busy || !writable || !canPurge}
                      title={
                        writable
                          ? "只清除回收站里的 .meta/knowledgenet，普通文件本来就没有被动过"
                          : "只读知识库：不能清除"
                      }
                      onClick={() => setPurgeTarget(entry)}
                    >
                      <Icon name="trash" />
                      彻底清除…
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="field-note">
          「恢复节点身份」把它装回知识图里；「彻底清除」只删除回收站中的节点元数据，
          <b>不涉及任何普通文件</b>——那些文件在移除身份时就没有被移动过。
        </p>
      </div>

      {/* ------------------------------ 完整性检查 ------------------------------ */}
      <div className="field">
        <div className="field-label">完整性检查</div>
        <div className="field-row">
          <button
            type="button"
            className="btn"
            disabled={!!busy}
            title="检查索引、元数据文件、未登记文件与悬空关系（打开时也会自动做一次）"
            onClick={() => void doCheck(false)}
          >
            <Icon name="shield" />
            快速检查
          </button>
          <button
            type="button"
            className="btn"
            disabled={!!busy}
            title="核对全部文件哈希、未登记文件、孤儿目录、路径逃逸、悬空关系与回收站一致性"
            onClick={() => void doCheck(true)}
          >
            <Icon name="search" />
            深度检查
          </button>
        </div>
        {busy && <p className="inline-feedback">{busy}</p>}

        {report && (
          <>
            <div className="result-note" role="status">
              <Icon name={report.ok ? "check" : "alert"} />
              <span>
                {report.deep ? "深度检查" : "快速检查"}（{formatTime(report.checkedAt)}）：
                {report.ok ? "没有错误级问题" : `${report.issues.length} 个问题`}
                {report.counts && (
                  <>
                    ；核对 {report.counts.filesChecked ?? 0} 个文件、
                    {formatBytes(report.counts.bytesChecked ?? 0)}；未登记文件{" "}
                    {report.counts.unregisteredFiles ?? 0} 个、孤儿目录{" "}
                    {report.counts.orphanDirectories ?? 0} 个
                  </>
                )}
                {report.truncated && "（扫描提前中止，报告不完整）"}
              </span>
            </div>

            {(report.warnings?.length ?? 0) > 0 && (
              <ul className="issue-warnings">
                {report.warnings?.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            {report.issues.length === 0 ? (
              <p className="empty-text">没有发现问题。检查不会修改任何东西。</p>
            ) : (
              <ul className="issue-list">
                {report.issues.map((issue) => {
                  const action = actionFor(issue);
                  const key = issueKey(issue);
                  return (
                    <li key={key} className={`issue is-${issue.severity}`}>
                      <label className="issue-main">
                        <input
                          type="checkbox"
                          disabled={!action}
                          checked={selectedIssues.has(key)}
                          onChange={() => toggleIssue(key)}
                        />
                        <span className="issue-text">
                          <b>
                            [{SEVERITY_LABEL[issue.severity] ?? issue.severity}] {issue.kind}
                          </b>
                          <span>{issue.detail}</span>
                          {issue.path && <span className="mono small">{issue.path}</span>}
                        </span>
                      </label>
                      <span className="issue-action">
                        {action
                          ? (ACTION_LABEL[action.action] ?? action.action)
                          : "需要人工判断，不会自动修"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {repairable.length > 0 && (
              <div className="field-row">
                <button
                  type="button"
                  className="btn"
                  disabled={!!busy || selectedIssues.size === 0}
                  title="只执行「意图唯一、无数据损失」的修复，动手前会先建立恢复点"
                  onClick={() => void doRepair()}
                >
                  <Icon name="shield" />
                  修复选中的 {selectedIssues.size} 项
                </button>
              </div>
            )}
            {repairResult && (
              <div className="result-note" role="status">
                <Icon name="check" />
                <span>{repairResult}</span>
              </div>
            )}
          </>
        )}
        <p className="field-note">
          检查不会自动删除任何东西。修复只做「意图唯一、无数据损失」的动作，动手前会先建立恢复点；
          需要人工判断的问题（哈希不一致、孤儿文件等）不会自动处理。
        </p>
      </div>

      {/* ------------------------------ 彻底清除确认 ------------------------------ */}
      {purgeTarget && (
        <div className="field is-danger" role="alertdialog" aria-label="确认彻底清除">
          <div className="field-label">确认彻底清除这份元数据？</div>
          <p>
            将清除「{purgeTarget.title || "（没有标题）"}」留在回收站里的{" "}
            <code>.meta/knowledgenet</code>，<b>不可撤销</b>。清除的内容是节点元数据本身：
          </p>
          <ul className="purge-stats">
            <li>node.json（标题、别名、学习状态、主文档指向）</li>
            <li>relations.json（这个节点发起的依赖与来源记录）</li>
            <li>resources.json / bookmarks.json（资料登记与疑问）</li>
            <li>chats/（这个节点的全部对话与消息）</li>
          </ul>
          <p className="field-note">
            节点文件夹与其中的普通文件（笔记、资料）<b>不在这次清除范围内</b>：
            它们在移除节点身份时就没有被移动或删除。
          </p>
          <div className="field-row">
            <button type="button" className="btn danger" onClick={() => void confirmPurge()}>
              <Icon name="trash" />
              确认彻底清除
            </button>
            <button type="button" className="btn" onClick={() => setPurgeTarget(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
