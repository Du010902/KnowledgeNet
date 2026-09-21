/**
 * 知识图画布
 *
 * 两种观察方式共用同一批数据，但由两个不同的视图渲染：
 * - 聚焦（默认）：二维卡片图，只看当前知识点的一跳——上行「依赖它的地方」、下行「它的前置知识」；
 * - 空间：三维空间图谱，环绕观察；节点、连线、标签与相机都在那一边自己管理。
 *
 * 三维视图取代了早先的「环视」（每层一个同心环 + 纵轴旋转投影）：
 * 投影布局没有真正的三维相机，深度遮挡、拾取与近裁剪都要自行实现，
 * 因此按《空间图谱技术方案》换成「Three.js 渲染 + Worker 布局 + 独立相机状态」。
 *
 * 位置全部由布局算出来，不写回工作区；布局坐标与相机只活在视图缓存里。
 * 切换观察方式不会重置另一边的观看状态：二维缩放留在聚焦，三维相机留在空间。
 *
 * 组件结构：`.graph-toolbar` + `.graph` + `.main-footer` 是 `.main` 的直接子元素
 * （`.graph` 的 flex:1 依赖这一点），所以这里返回 Fragment，不再包一层 div。
 */
import { useEffect, useState } from "react";

import { STATUS_ORDER } from "@/data/types";
import type { CameraCommand, LabelDensity } from "@/graph3d/types";
import { cachedLabelDensity, storeLabelDensity } from "@/graph3d/session";
import { STATUS_DISPLAY, useStore } from "@/store";
import { AddPrerequisiteDialog } from "./AddPrerequisiteDialog";
import { CanvasMenu, type CanvasMenuState } from "./CanvasMenu";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { GraphSpace } from "./GraphSpace";
import { GraphToolbar } from "./GraphToolbar";
import { GraphUniverse } from "./GraphUniverse";
import { MAX_ZOOM, MIN_ZOOM, type SpaceMode } from "./graphMode";
import { Icon } from "./icons";
import {
  CANVAS_CONTEXT_MENU_EVENT,
  NODE_CONTEXT_MENU_EVENT,
  type CanvasContextMenuRequest,
  type NodeContextMenuRequest,
} from "./nodeContextMenu";

/** 一次缩放一档 */
const ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

export function GraphCanvas({
  onOpenInspector,
  viewMode = "focus",
  onViewModeChange,
}: {
  onOpenInspector?: () => void;
  /**
   * 观察方式由布局状态给出（默认空间，用户的选择按知识库持久化）——
   * 不再存在组件本地状态里：那样每次切走再回来都会被重置成二维聚焦。
   */
  viewMode?: SpaceMode;
  onViewModeChange?(mode: SpaceMode): void;
} = {}) {
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const enterNode = useStore((s) => s.enterNode);

  const mode = viewMode;
  const setMode = (next: SpaceMode) => onViewModeChange?.(next);
  const [zoom, setZoom] = useState(1);
  /** 名称密度与三维相机一样属于「观看状态」：切走再回来沿用上次选择 */
  const [labelDensity, setLabelDensity] = useState<LabelDensity>(() => cachedLabelDensity());
  /** 「适应窗口」对二维聚焦是一次性指令：数值变一次，GraphSpace 算一次 */
  const [fitToken, setFitToken] = useState(0);
  /** 「重新整理布局」同样是一次性指令：数值变一次，三维视图重算一轮 */
  const [relayoutToken, setRelayoutToken] = useState(0);
  /**
   * 三维相机命令。
   *
   * 带自增 seq：单击只选择、不发命令；「定位」「适应窗口」以及画布里的双击 / F 才发。
   * 对同一个节点再定位一次也必须生效，所以不能只靠 selectedId 表达。
   */
  const [command, setCommand] = useState<CameraCommand | null>(null);

  /**
   * 节点右键菜单、空白画布菜单与「添加前置知识」对话框都在这一层统一渲染：
   * 菜单需要屏幕坐标，对话框需要目标节点；画布通过事件请求打开它们。
   */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenuState | null>(null);
  const [addTarget, setAddTarget] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NodeContextMenuRequest>).detail;
      setCanvasMenu(null);
      setContextMenu({ nodeId: detail.nodeId, x: detail.x, y: detail.y });
    };
    const canvasHandler = (e: Event) => {
      const detail = (e as CustomEvent<CanvasContextMenuRequest>).detail;
      setContextMenu(null);
      setCanvasMenu({ x: detail.x, y: detail.y });
    };
    window.addEventListener(NODE_CONTEXT_MENU_EVENT, handler);
    window.addEventListener(CANVAS_CONTEXT_MENU_EVENT, canvasHandler);
    return () => {
      window.removeEventListener(NODE_CONTEXT_MENU_EVENT, handler);
      window.removeEventListener(CANVAS_CONTEXT_MENU_EVENT, canvasHandler);
    };
  }, []);

  // 没有「学习目标」这种特殊节点：画布围绕**当前选中的节点**展开，没选就平铺
  const focusId = selectedId;
  const focusNode = graph.nodes.find((n) => n.id === focusId) ?? null;

  /**
   * 发一条相机命令。
   *
   * 只有明确的操作（按钮、双击、F）走这里；选中节点本身从不触发镜头飞行，
   * 否则「点一下看看」会变成「画面突然飞走」。
   */
  const issueCommand = (type: CameraCommand["type"], nodeId?: string | null) => {
    setCommand((previous) => ({
      seq: (previous?.seq ?? 0) + 1,
      type,
      nodeId: nodeId ?? undefined,
      source: "toolbar",
    }));
  };

  /** 说明当前视图在展示什么：这是唯一一处告诉使用者「图被过滤了」的地方 */
  const caption =
    graph.nodes.length === 0
      ? "还没有知识点"
      : mode === "focus"
        ? focusNode
          ? `聚焦：${focusNode.title} · 只显示一跳关系`
          : "平铺显示 · 点一个节点就会围绕它展开"
        : `空间 · 环绕观察${focusNode ? ` · 当前：${focusNode.title}` : ""}`;

  const noNodes = graph.nodes.length === 0;

  return (
    <>
      <GraphToolbar
        mode={mode}
        onModeChange={setMode}
        labelDensity={labelDensity}
        onLabelDensityChange={(next) => {
          setLabelDensity(next);
          storeLabelDensity(next);
        }}
        hasNodes={!noNodes}
        focusId={focusId}
        focusTitle={focusNode?.title ?? null}
        onLocate={() => issueCommand("focusNode", focusId)}
        onFit={() => issueCommand("fitAll")}
        onRelayout={() => setRelayoutToken((token) => token + 1)}
        onOpenInspector={onOpenInspector}
        nodeCount={graph.nodes.length}
        edgeCount={graph.edges.length}
      />

      <div className="graph" data-mode={mode} aria-label="知识依赖图">
        {mode === "focus" ? (
          <GraphSpace
            graph={graph}
            rootId={focusId}
            focusId={focusId}
            onEnter={(id) => void enterNode(id)}
            view={{
              zoom,
              onZoomChange: setZoom,
              fitToken,
            }}
          />
        ) : noNodes ? (
          /*
           * 空知识库不进三维：没有节点可摆时挂一个「正在形成」的状态条
           * 只会让人以为它一直在算。这里直接给下一步该做什么。
           */
          <div className="graph-empty">
            <span className="empty-mark">
              <Icon name="network" />
            </span>
            <h3>知识库还是空的</h3>
            <p>
              在画布上点右键就能建第一个知识点；空间图谱会把它们摆成三维关系网。
            </p>
          </div>
        ) : (
          <GraphUniverse
            graph={graph}
            rootId={focusId}
            focusId={focusId}
            labelDensity={labelDensity}
            command={command}
            relayoutToken={relayoutToken}
            onEnter={(id) => void enterNode(id)}
            // WebGL 2 起不来或上下文丢失：切回二维聚焦并说明原因（不留一块黑画布）
            onFallback={() => setMode("focus")}
          />
        )}

        <div className="selection-label">
          <span className="status-dot" aria-hidden="true" />
          <span>{caption}</span>
        </div>

        {/* 缩放只属于二维聚焦：三维相机没有「百分比」这种含义不明的读数 */}
        {mode === "focus" && (
          <div className="canvas-controls">
            <button
              type="button"
              className="icon-btn"
              aria-label="缩小视图"
              title="缩小"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => setZoom(clampZoom(zoom - ZOOM_STEP))}
            >
              <Icon name="minus" />
            </button>
            <output aria-label={`当前缩放 ${Math.round(zoom * 100)}%`}>
              {Math.round(zoom * 100)}%
            </output>
            <button
              type="button"
              className="icon-btn"
              aria-label="放大视图"
              title="放大"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom(clampZoom(zoom + ZOOM_STEP))}
            >
              <Icon name="plus" />
            </button>
            <span className="sep" />
            <button
              type="button"
              className="icon-btn"
              aria-label="适应窗口"
              title="适应窗口：把内容缩放到放得下（缩放下限 60%）"
              onClick={() => setFitToken((t) => t + 1)}
            >
              <Icon name="expand" />
            </button>
          </div>
        )}

        <div className="graph-legend">
          {STATUS_ORDER.map((status) => (
            <span key={status}>
              <span className={`status-dot ${STATUS_DISPLAY[status].cls}`} aria-hidden="true" />
              {STATUS_DISPLAY[status].label}
            </span>
          ))}
        </div>

        {/*
          没有选中节点时**不再盖一层空态**。
          原来这里摆一个居中的大卡片，正好压在平铺出来的节点上：卡片、状态胶囊与
          说明文字互相叠着（截图里「链式法则」被压在「还没有选中知识点」下面），
          两边都读不清。画布现在已经在平铺显示全部节点了，
          该说的那句话交给页脚与左上角的说明条——它们本来就在说这件事。
        */}

        {/* 节点右键菜单：添加前置知识 / 彻底删除 */}
        {contextMenu && (
          <ContextMenu
            state={contextMenu}
            onClose={() => setContextMenu(null)}
            onAdd={(nodeId) => {
              setContextMenu(null);
              setAddTarget(nodeId);
            }}
          />
        )}

        {/* 空白处右键：建立知识点的地方（搜索框只负责搜索） */}
        {canvasMenu && (
          <CanvasMenu state={canvasMenu} onClose={() => setCanvasMenu(null)} />
        )}

        {addTarget && (
          <AddPrerequisiteDialog nodeId={addTarget} onClose={() => setAddTarget(null)} />
        )}

      </div>

      <footer className="main-footer">
        <span className="row">
          <Icon name="arrow-right" />
          目标 → 前置知识
        </span>
        <span className="footer-right">
          {graph.nodes.length === 0
            ? "还没有知识点"
            : mode === "focus" && focusId
              ? "只显示当前知识点的一跳关系 · 点击节点继续深入"
              : mode === "focus"
                ? `还没有选中知识点 · 画布先平铺全部 ${graph.nodes.length} 个知识点；` +
                  "点任意一个节点，就会围绕它展开它的一跳关系"
                : `共 ${graph.nodes.length} 个知识点 · ${graph.edges.length} 条依赖 · ` +
                  "拖动旋转 · 滚轮靠近 · F 定位"}
        </span>
      </footer>
    </>
  );
}
