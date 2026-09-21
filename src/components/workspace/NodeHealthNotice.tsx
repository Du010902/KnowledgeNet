/**
 * 节点健康 / 外部改动提示条
 *
 * 设计文档 §7.4 的最后一条：**不要隐藏保存失败、只读、外部冲突**。
 * 这些是状态反馈，不是工具按钮，所以这里常驻在节点上下文条里，
 * 并提供三个出口：重新载入（从磁盘重扫）、查看差异（看清楚哪里不一样）、
 * 覆盖（以界面上的这份为准写回）。
 *
 * 触发条件有两个，缺一不可：
 * - 扫描结果说这个节点的元数据有问题（`health !== "ok"`）；
 * - 或者刚刚收到 `external_change_conflict`（保存时发现磁盘被外部改过）。
 */
import { useState } from "react";

import { Icon } from "@/components/icons";
import type { KnowledgeNode } from "@/data/types";
import {
  HEALTH_LABEL,
  nodeHealth,
  useWorkspace,
  workspaceApi,
  type ScanIssueLike,
} from "./bridge";

/** 保存失败里出现这些词，就是「磁盘被别人改过」而不是普通的写失败 */
const CONFLICT_HINT = /external_change_conflict|外部修改|外部改动|已被其它程序|修订号不符|哈希不符/;

function looksLikeConflict(text: string | null | undefined): boolean {
  return typeof text === "string" && CONFLICT_HINT.test(text);
}

export function NodeHealthNotice({
  node,
  /** 顶栏里的那份只显示一行，细节仍然可展开 */
  compact = false,
}: {
  node: KnowledgeNode | null;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const saveError = useWorkspace((s) => s.saveError);
  const notice = useWorkspace((s) => s.notice);
  const scanReport = useWorkspace((s) => s.scanReport);
  const busy = useWorkspace((s) => s.busy);
  const writable = useWorkspace((s) => s.canWrite());

  const health = nodeHealth(node);
  const conflict = looksLikeConflict(saveError) || looksLikeConflict(notice?.text);
  if (!node || (health.health === "ok" && !conflict)) return null;

  const issues: ScanIssueLike[] = (scanReport?.issues ?? []).filter(
    (issue) =>
      (issue.nodeId && issue.nodeId === node.id) ||
      (health.relativePath !== "" && issue.relativePath === health.relativePath),
  );

  const reload = () => {
    if (!workspaceApi().supports("pullScan")) {
      workspaceApi().notify("warn", "当前状态层还没有提供重新扫描：请重启应用或运行一次深度检查。");
      return;
    }
    void workspaceApi().pullScan(false);
    workspaceApi().notify("info", `正在重新读取「${node.title}」在磁盘上的样子…`);
  };

  const overwrite = () => {
    if (
      !window.confirm(
        `以界面上的这份覆盖磁盘上的元数据？\n\n` +
          `「${node.title}」的标题与学习状态会重新写回 node.json，磁盘上被外部改动的那一份会被覆盖。\n` +
          `普通文件（笔记、资料）不受影响。`,
      )
    ) {
      return;
    }
    void workspaceApi().updateNode(node.id, { title: node.title, status: node.status });
  };

  const title = health.health === "ok" ? "磁盘上的节点文件被外部改过" : HEALTH_LABEL[health.health];

  return (
    <div
      className={compact ? "health-notice compact" : "health-notice"}
      data-node-health={health.health}
      data-node-conflict={conflict ? "true" : "false"}
      role="status"
    >
      <Icon name="alert" />
      <div className="health-notice-text">
        <b>{title}</b>
        {health.relativePath && <span className="health-path">{health.relativePath}</span>}
        {conflict && saveError && <span className="health-detail">{saveError}</span>}
        {expanded && (
          <ul className="health-issues">
            {issues.length === 0 && <li>扫描报告里没有这个节点的细节，可以重新载入看看现状。</li>}
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <code>{issue.code}</code>
                {issue.relativePath ? ` · ${issue.relativePath}` : ""}
                {issue.parsePosition ? ` · ${issue.parsePosition}` : ""}
                <br />
                {issue.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="health-notice-actions">
        <button type="button" className="btn sm" onClick={reload} disabled={busy !== null}>
          <Icon name="refresh" />
          重新载入
        </button>
        <button
          type="button"
          className="btn sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <Icon name="eye" />
          查看差异
        </button>
        <button
          type="button"
          className="btn sm danger"
          onClick={overwrite}
          disabled={!writable}
          title={writable ? "以界面上的这份为准写回" : "只读知识库：不能覆盖"}
        >
          <Icon name="upload" />
          覆盖
        </button>
      </div>
    </div>
  );
}

/** 顶栏用的紧凑图标：只在有问题时出现 */
export function HealthIcon() {
  const selectedId = useWorkspace((s) => s.selectedId);
  const health = useWorkspace((s) => {
    const node = s.graph.nodes.find((n) => n.id === s.selectedId);
    return nodeHealth(node ?? null).health;
  });
  if (!selectedId || health === "ok") return null;
  return (
    <span className="pill is-danger" title={HEALTH_LABEL[health]}>
      {HEALTH_LABEL[health]}
    </span>
  );
}
