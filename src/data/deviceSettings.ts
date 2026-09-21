/**
 * 设备级设置
 *
 * 三类数据只属于「这台机器 / 这次安装」，绝对不能写进知识库：
 * - 最近打开的知识库列表；
 * - AI 配置（接口地址、模型、思考模式等）；
 * - 工作台布局（三种模式、分屏比例、抽屉与检查器开合），按 `libraryId` 分区。
 *
 * 关于布局为什么存在 WebView 的 localStorage 而不是 AppData 的 JSON：
 * 它是纯粹的界面状态，Tauri 的 WebView localStorage 本身就落在 AppData 下，
 * 按 `libraryId` 分区即可满足「同一台机器、同一个库回到上次的布局」；这样
 * 也不需要为它新增一条 Rust 命令（契约 §4 的命令清单里没有设备设置写入命令）。
 * 浏览器演示模式走的是同一个键，行为一致。见 `docs/v2-deviations.md`。
 *
 * API Key 不在这里：它始终在系统凭据存储里，前端只看到 `hasApiKey`。
 * 这正是「删掉 AppData 也不丢知识内容」的前提——知识内容全在知识库文件夹里。
 */
import type { AiConfig } from "./aiProvider.ts";
import type { RecentLibrary } from "./types.ts";

export interface DeviceSettings {
  recentLibraries: RecentLibrary[];
  /** 未配置过时为 null，界面据此显示默认值 */
  aiConfig: AiConfig | null;
  hasApiKey: boolean;
}

export interface DeviceSettingsController {
  /** 演示模式为 true：设置只存在浏览器本地，换台机器就没了 */
  readonly isDemo: boolean;
  loadDeviceSettings(): Promise<DeviceSettings>;
  /** 保存 AI 配置（不含 API Key） */
  saveAiConfig(config: AiConfig): Promise<void>;
  /** API Key 走系统凭据存储，不进知识库、不进设置文件 */
  saveApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
}

/* ------------------------------- 工作台布局 ------------------------------- */

/** 布局持久化键前缀：`knowledgenet.workspace.<libraryId>`（契约 §5.3） */
export const WORKSPACE_LAYOUT_PREFIX = "knowledgenet.workspace.";

export function workspaceLayoutKey(libraryId: string): string {
  return `${WORKSPACE_LAYOUT_PREFIX}${libraryId}`;
}

/**
 * 落盘的布局快照。
 *
 * 字段与 `src/uiStore.ts` 的 `WorkspaceLayoutState` 一一对应，但这里刻意不 import
 * uiStore（设备设置不该依赖任何状态库），由 uiStore 负责形状校验与夹取范围。
 */
export interface WorkspaceLayoutSnapshot {
  mode: "chat" | "split" | "graph";
  previousSplitMode: boolean;
  horizontalGraphRatio: number;
  verticalGraphRatio: number;
  /** 图谱观察方式；旧快照里没有这个字段，读回时按 `space` 处理 */
  graphViewMode?: "focus" | "space";
  /** 分屏顺序；旧快照里没有这个字段，读回时按 `graph-first` 处理 */
  splitOrder?: "graph-first" | "chat-first";
  navDrawer: "search" | null;
  inspectorOpen: boolean;
  inspectorTab: "detail" | "notes" | "resources";
  threadListOpen: boolean;
  maximizedPane: "graph" | "chat" | null;
  commandPaletteOpen: boolean;
}

/** localStorage 在测试/SSR 里可能不存在；拿不到就退化成「这次会话有效」 */
function layoutStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    // 隐私模式等场景下访问 localStorage 会抛错：布局不是关键数据，静默降级
    return null;
  }
}

export function readWorkspaceLayout(libraryId: string | null | undefined): WorkspaceLayoutSnapshot | null {
  if (!libraryId) return null;
  const storage = layoutStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(workspaceLayoutKey(libraryId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayoutSnapshot> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as WorkspaceLayoutSnapshot;
  } catch {
    // 坏掉的布局数据不值得中断界面：按默认布局处理
    return null;
  }
}

export function writeWorkspaceLayout(
  libraryId: string | null | undefined,
  layout: WorkspaceLayoutSnapshot,
): void {
  if (!libraryId) return;
  const storage = layoutStorage();
  if (!storage) return;
  try {
    storage.setItem(workspaceLayoutKey(libraryId), JSON.stringify(layout));
  } catch {
    // 配额满或被拒绝：布局丢了就丢了，绝不影响知识内容
  }
}

export function clearWorkspaceLayout(libraryId: string | null | undefined): void {
  if (!libraryId) return;
  const storage = layoutStorage();
  if (!storage) return;
  try {
    storage.removeItem(workspaceLayoutKey(libraryId));
  } catch {
    // 同上：清理失败不影响任何知识数据
  }
}
