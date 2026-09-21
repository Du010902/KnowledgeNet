/**
 * 主题
 *
 * 三档：跟随系统 / 浅色 / 深色。选择存在 localStorage，写入 `html[data-theme]`，
 * CSS 只认这一个属性——组件不判断主题，也不内联颜色。
 *
 * 模块加载时就把属性写上去（在 React 挂载之前），避免深色系统下先闪一帧白底。
 * 首屏那一帧由 index.html 里的内联脚本负责，两者用的是同一个键与同一个默认值。
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "knowledgenet.theme";

function safeRead(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* 隐私模式等场景读不到：退回跟随系统 */
  }
  return "system";
}

function safeWrite(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 写不进去只影响下次启动的默认值，不影响本次 */
  }
}

function media(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

let mode: ThemeMode = typeof window === "undefined" ? "system" : safeRead();

export function systemTheme(): ResolvedTheme {
  return media()?.matches ? "dark" : "light";
}

export function resolvedTheme(): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode;
}

export function themeMode(): ThemeMode {
  return mode;
}

/** 把当前主题写到 <html data-theme> 上；CSS 与 color-scheme 都跟着它走 */
function apply(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolvedTheme();
}

type Listener = (mode: ThemeMode, resolved: ResolvedTheme) => void;
const listeners = new Set<Listener>();

export function subscribeTheme(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  safeWrite(next);
  apply();
  const resolved = resolvedTheme();
  for (const fn of listeners) fn(mode, resolved);
}

/** 在浅色 / 深色之间来回切；跟随系统时按当前实际效果切到相反的一档 */
export function toggleTheme(): void {
  setThemeMode(resolvedTheme() === "dark" ? "light" : "dark");
}

if (typeof window !== "undefined") {
  apply();
  // 跟随系统时才需要监听系统变化；用户明确选了某一档就不该被系统改动打断
  media()?.addEventListener("change", () => {
    if (mode !== "system") return;
    apply();
    const resolved = resolvedTheme();
    for (const fn of listeners) fn(mode, resolved);
  });
}

/** 界面上用于说明当前是哪一档 / 点下去会变成什么 */
export function themeLabel(mode: ThemeMode): string {
  if (mode === "system") return "跟随系统";
  return mode === "dark" ? "深色" : "浅色";
}

/**
 * 订阅主题选择。
 *
 * 用 useSyncExternalStore 而不是订阅本地状态：主题是模块级的一份全局状态，
 * 多个按钮（顶栏、设置）读到的必须是同一个值，也不能各自存一份。
 * `getServerSnapshot` 给的是「跟随系统」这一档，服务端渲染与测试环境都能跑。
 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(
    subscribeTheme,
    () => mode,
    () => "system" as ThemeMode,
  );
}
