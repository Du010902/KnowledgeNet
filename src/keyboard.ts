/**
 * 键盘快捷键辅助
 */

import type { KeyboardEvent } from "react";

/**
 * 输入法是否正在组合（还没确认候选词）。
 *
 * 中文输入法用回车确认候选词，此时浏览器同样会发出 Enter 的 keydown。
 * 只判断 `key === "Enter"` 会把「还没写完的问题 / 还没写完的目标」直接提交并清空输入。
 * `isComposing` 在组合期间为真；keyCode 229 是部分输入法的兜底标记。
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
