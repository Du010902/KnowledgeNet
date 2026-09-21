/**
 * 导航抽屉的数据逻辑
 *
 * 抽屉只有一节：**搜索框 + 全部知识点**。
 *
 * 这里**不提供新建节点**：搜索框就只负责搜索。「要建节点」这件事属于图谱——
 * 在画布上右键（聚焦与空间两种视图都可以）才是建立知识点的地方，因为那里
 * 看得见新节点将要落进的那张网。
 *
 * 「学习目标」也已经整个去掉：那会把某个节点变成特殊节点，而实际上所有节点是平等的——
 * 谁先建、谁后建只是时间顺序，先建的节点同样可能是别人的前置知识。
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";

import { referenceCount, searchNodes } from "@/data/engine";
import type { LearnStatus } from "@/data/types";
import type { GraphSnapshot, KnowledgeNode } from "@/data/types";
import { useWorkspace, workspaceApi, type WorkspaceSurface } from "./bridge";

export interface NavigationNode extends KnowledgeNode {
  /** 被依赖的次数（知识点库里右侧那个数字） */
  references: number;
}

export interface NavigationData {
  graph: GraphSnapshot;
  selectedId: string | null;
  libraryInfo: WorkspaceSurface["libraryInfo"];
  readOnly: boolean;
  isDemo: boolean;
  busy: string | null;
  writable: boolean;
  /** 写入口被禁用时的一句话原因，可直接放进 title */
  writeBlockedReason: string | null;

  query: string;
  setQuery: (value: string) => void;
  nodes: NavigationNode[];

  openNode: (nodeId: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  focusSearch: () => void;

  setStatus: (nodeId: string, status: LearnStatus) => void;
  canWrite: boolean;
}

export function useNavigationData(): NavigationData {
  const graph = useWorkspace((s) => s.graph);
  const selectedId = useWorkspace((s) => s.selectedId);
  const libraryInfo = useWorkspace((s) => s.libraryInfo);
  const isDemo = useWorkspace((s) => s.isDemo);
  const readOnly = useWorkspace((s) => s.libraryState === "readonly");
  const busy = useWorkspace((s) => s.busy);
  const writable = useWorkspace((s) => s.canWrite());

  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  /*
   * 搜索命中上限取全库大小：这一栏展示的就是知识点库本身，
   * 不是「取前 N 条」的候选列表——截断会让人以为某些知识点不见了。
   */
  const nodes = useMemo<NavigationNode[]>(() => {
    const q = query.trim();
    const hit = q ? searchNodes(graph, q, Math.max(1, graph.nodes.length)) : graph.nodes;
    return hit.map((n) => ({ ...n, references: referenceCount(graph, n.id) }));
  }, [graph, query]);

  /** 进入一个知识点：选中 + 记为「当前所在节点」 + 打开它的对话 */
  const openNode = useCallback((nodeId: string) => {
    workspaceApi().selectNode(nodeId);
    void workspaceApi().enterNode(nodeId);
  }, []);

  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
  }, []);

  const setStatus = useCallback((nodeId: string, status: LearnStatus) => {
    void workspaceApi().setStatus(nodeId, status);
  }, []);

  /** 只读或有独占操作进行中：写入口一律禁用，并用 title 说清原因 */
  const writeBlockedReason = readOnly
    ? "这是只读知识库：没有取得写锁，或知识库版本高于本应用。"
    : busy
      ? `${busy}请等它结束。`
      : null;

  return {
    graph,
    selectedId,
    libraryInfo,
    readOnly,
    isDemo,
    busy,
    writable,
    writeBlockedReason,
    query,
    setQuery,
    nodes,
    openNode,
    searchRef,
    focusSearch,
    setStatus,
    canWrite: writable,
  };
}
