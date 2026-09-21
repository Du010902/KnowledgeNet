/**
 * HTML 转义与链接协议白名单
 *
 * 单独成一个模块，是因为 `markdown.ts` 与 `math.ts` 都要用它，
 * 而 `markdown.ts` 又依赖 `math.ts`——放在任一方都会形成循环导入。
 *
 * 这里的规则是**安全边界**，改动前先想清楚：
 * 渲染结果会被 `dangerouslySetInnerHTML` 直接插进页面，来源包括 AI 回答、
 * 导入的备份和别人分享的笔记。
 */

/** HTML 文本与属性转义。引号必须一起转，否则可以越出属性值。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只允许 http/https 的链接，其它协议（javascript:、data: 等）一律不生成链接 */
export function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
