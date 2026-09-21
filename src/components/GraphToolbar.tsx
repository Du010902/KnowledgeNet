/**
 * 画布工具栏
 *
 * 两种观察方式共用同一条工具栏，但控件不同：
 * - 聚焦：只有观察方式与当前卡片；
 * - 空间：多出「定位当前」「适应窗口」，以及一个「视图设置」菜单
 *   （名称密度 + 重新整理布局）。
 *
 * 收纳的理由（验收清单 P2-6）：右侧原来并排五颗权重相近的控件，
 * 分屏或 1024px 宽时像一条「按钮带」。低频、且属于「怎么显示」的两项
 * 放进语义明确的菜单里，常驻只留两个真正的动作。
 *
 * 按《工作台 UI 审查与重构规范》§3，这一条也是**上下文栏**：
 * 左边是「现在在看哪个知识点」（图谱视图里它就是当前节点的那一份），
 * 右边是这一屏能做的事。观察方式是分段控件（`data-mode` 保持不变），
 * 低频动作是文字按钮而不是一排同样粗细的胶囊。
 *
 * 单独成组件是为了让它能被静态渲染测试覆盖：模式切换后的控件差异
 * 不应该只能靠点开界面才知道。
 */
import { useEffect, useRef, useState } from "react";

import type { LabelDensity } from "@/graph3d/types";
import { SPACE_MODE_LABEL, type SpaceMode } from "./graphMode";
import { Icon, type IconName } from "./icons";
import { useSplitSlot } from "./workspace/splitSlot";

const SPACE_MODES: Array<{ value: SpaceMode; icon: IconName; title: string }> = [
  {
    value: "focus",
    icon: "focus",
    title: "只看当前知识点的一跳关系：上行是依赖它的地方，下行是它的前置知识",
  },
  {
    value: "space",
    icon: "orbit",
    title: "三维空间图谱：拖动绕整张图旋转、滚轮靠近远离，围着自己关心的部分看",
  },
];

const LABEL_DENSITIES: Array<{ value: LabelDensity; label: string }> = [
  { value: "smart", label: "智能" },
  { value: "all", label: "全部" },
  { value: "related", label: "仅相关" },
];

export interface GraphToolbarProps {
  mode: SpaceMode;
  onModeChange(mode: SpaceMode): void;
  labelDensity: LabelDensity;
  onLabelDensityChange(density: LabelDensity): void;
  hasNodes: boolean;
  /** 当前知识点：定位按钮与「回到目标」的可用性都由它决定 */
  focusId: string | null;
  focusTitle: string | null;
  onLocate(): void;
  onFit(): void;
  onRelayout(): void;
  /** 打开右侧「学习脉络」。可选：单独渲染工具栏（静态测试）时不需要它 */
  onOpenInspector?(): void;
  /** 图规模：标题右侧那行元数据 */
  nodeCount?: number;
  edgeCount?: number;
}

export function GraphToolbar({
  mode,
  onModeChange,
  labelDensity,
  onLabelDensityChange,
  hasNodes,
  focusId,
  focusTitle,
  onLocate,
  onFit,
  onRelayout,
  onOpenInspector,
  nodeCount = 0,
  edgeCount = 0,
}: GraphToolbarProps) {
  const title = focusTitle ?? (hasNodes ? "全部知识点" : "还没有知识点");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  /** 分屏时这个窗格可以最大化；不在分屏里时为 null */
  const slot = useSplitSlot();

  // Esc 与「点别处」收起菜单：它是浮层，不该一直挂着
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [settingsOpen]);

  return (
    <div className="graph-toolbar">
      {/*
        图谱视图里的「当前节点」：点它打开学习脉络。
        顶栏不再有第二份当前节点，这个名字在任一视图里只出现一次。
      */}
      {onOpenInspector ? (
        <button
          type="button"
          className="node-title"
          data-current-node
          disabled={!focusId}
          title={
            focusId
              ? `当前知识点：${title}（打开学习脉络：详情、笔记与资料）`
              : "还没有选中知识点：在画布上点一个节点"
          }
          onClick={onOpenInspector}
        >
          <span className="node-title-text">{title}</span>
          <Icon name="panel" className="node-title-icon" />
        </button>
      ) : (
        <h1 className="node-title">{title}</h1>
      )}

      <span className="graph-meta">
        {nodeCount} 个知识点 · {edgeCount} 条依赖
        {mode === "focus" && focusId ? " · 只显示一跳关系" : ""}
      </span>

      <div className="graph-mode-switch" role="group" aria-label="观察方式">
        {SPACE_MODES.map((opt) => (
          <button
            key={opt.value}
            type="button"
            data-mode={opt.value}
            className={mode === opt.value ? "active" : undefined}
            aria-pressed={mode === opt.value}
            title={opt.title}
            onClick={() => onModeChange(opt.value)}
          >
            <Icon name={opt.icon} />
            <span>{SPACE_MODE_LABEL[opt.value]}</span>
          </button>
        ))}
      </div>

      <span className="graph-spacer" />

      <div className="row graph-actions">
        {mode === "space" && (
          <>
            <button
              type="button"
              className="text-button"
              data-toolbar="locate"
              title={focusTitle ? `定位到「${focusTitle}」（快捷键 F）` : "还没有当前知识点"}
              disabled={!focusId}
              onClick={onLocate}
            >
              <Icon name="focus" />
              <span>定位当前</span>
            </button>
            <button
              type="button"
              className="text-button"
              data-toolbar="fit"
              title="适应窗口：按当前画布比例把整张图收进视野"
              disabled={!hasNodes}
              onClick={onFit}
            >
              <Icon name="expand" />
              <span>适应窗口</span>
            </button>

            {/* 视图设置：名称密度 + 重新整理布局（低频，收进菜单） */}
            <div className="toolbar-menu-wrap" ref={settingsRef}>
              <button
                type="button"
                className="icon-btn"
                data-view-settings
                aria-haspopup="menu"
                aria-expanded={settingsOpen}
                aria-label="视图设置"
                title="视图设置：名称密度与重新整理布局"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <Icon name="sliders" />
              </button>

              {settingsOpen && (
                <div
                  className="tab-menu align-right"
                  role="menu"
                  data-view-settings-list
                  aria-label="视图设置"
                >
                  <p className="menu-label">名称密度</p>
                  {LABEL_DENSITIES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      data-label-density={option.value}
                      aria-checked={labelDensity === option.value}
                      onClick={() => {
                        onLabelDensityChange(option.value);
                        setSettingsOpen(false);
                      }}
                    >
                      <Icon
                        name={labelDensity === option.value ? "check" : "minus"}
                        className="menu-mark"
                      />
                      {option.label}
                    </button>
                  ))}
                  <hr />
                  <button
                    type="button"
                    role="menuitem"
                    data-toolbar="relayout"
                    disabled={!hasNodes}
                    title="丢掉当前的坐标，从初始分布重新算一轮（相机保持不动）"
                    onClick={() => {
                      setSettingsOpen(false);
                      onRelayout();
                    }}
                  >
                    <Icon name="sparkles" />
                    重新整理布局
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/*
          分屏时多一颗「最大化图谱」（Esc 回到分屏）。
          它属于这一侧窗格的顶栏，不是浮在右上角的浮层——
          浮层会正好压住上面这些按钮（验收反馈里的重叠就是这样来的）。
        */}
        {slot && (
          <button
            type="button"
            className="icon-btn graph-maximize"
            data-maximize-pane={slot.pane}
            aria-label="最大化图谱"
            title="最大化图谱（Esc 回到分屏）"
            onClick={slot.maximize}
          >
            <Icon name="expand" />
          </button>
        )}
      </div>
    </div>
  );
}
