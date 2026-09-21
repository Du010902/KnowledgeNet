/**
 * 公式渲染（KaTeX）
 *
 * 这是一个讲机器学习的学习工具，AI 回答里出现公式是常态。模型用的定界符有好几种，
 * 而且**同一段回答里会混用**：
 *
 * ```text
 * 行内： $x$        \(x\)
 * 块级： $$ … $$    \[ … \]
 * ```
 *
 * 之前只认 `$…$` / `$$…$$`，于是 `\[ G = (V, E) \]` 与 `\(V\)` 会原样显示成反斜杠括号——
 * 而这恰恰是最常见的写法之一。现在四种都认，并且交给 KaTeX 真正排版
 * （矩阵、`aligned`、`\frac`、`\sum` 的上下限都不必自己实现；
 * 自己写子集渲染器的下场就是「认不出来就退回源码」，那仍然是坏的体验）。
 *
 * 安全：`trust` 保持关闭（KaTeX 默认值），因此 `\href` / `\url` / `\htmlClass`
 * 这类需要显式授权的命令不生效——公式只能是公式，不能变成链接或标签。
 * `throwOnError: false` 让写错的 TeX 以 KaTeX 自带的错误样式显示原文，
 * 而不是把整段回答炸掉。
 */
import katex from "katex";

import { escapeHtml } from "./escape.ts";

/** KaTeX 的排版选项：行内与块级只差 `displayMode`，其余必须完全一致 */
const BASE_OPTIONS = {
  throwOnError: false,
  errorColor: "#c0392b",
  strict: false as const,
  trust: false,
  output: "html" as const,
};

/**
 * 渲染一段公式。
 *
 * `block` 为 true 时返回块级元素（`$$…$$` / `\[…\]`），否则是行内元素。
 * 排不出结果（KaTeX 抛错或输出为空）时退回转义后的源码——
 * 宁可让人看到 `\foo{…}` 的原文，也不要一片空白。
 */
export function renderMath(tex: string, block: boolean): string {
  const source = tex.trim();
  let html = "";
  try {
    html = katex.renderToString(source, { ...BASE_OPTIONS, displayMode: block });
  } catch {
    html = "";
  }
  const inner = html || `<span class="math-tex">${escapeHtml(source)}</span>`;
  return block
    ? `<div class="math-block">${inner}</div>`
    : `<span class="math-inline">${inner}</span>`;
}