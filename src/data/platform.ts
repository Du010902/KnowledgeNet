/**
 * 运行环境判断
 *
 * 单独一个模块，而不是放在 `data/index.ts` 里：
 * `aiProvider.ts` 需要判断自己是不是跑在 Tauri 里，而 `index.ts` 要 re-export
 * 会话与适配器（它们又依赖 AI 配置类型）。判断函数留在 index.ts 就会形成
 * index → session → 适配器 → aiProvider → index 的循环导入。
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}
