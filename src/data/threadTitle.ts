/**
 * 从一句话里收敛出对话标题
 *
 * 用途有两个，两者必须**同一套规则**，否则「刚发问时看到的名字」和「AI 优化后的名字」
 * 风格会打架：
 *
 * 1. **发第一条消息时立刻起名**：不让对话一直叫「新对话」。
 *    这一步不依赖 AI——没配 Key、断网、模型抽风都不该让对话没有名字。
 * 2. 演示后端（浏览器开发模式）没有真实模型，用它代替 AI 起名。
 *
 * 桌面端在第一条回答结束后还会让模型再起一次更好的名字（`chatStore`），
 * 但如果用户自己改过名字，那次优化会主动让路。
 */

/** 提问里常见的套话：去掉之后剩下的才是「这条对话在聊什么」 */
const LEADING_PHRASES = [
  "请问",
  "请帮我",
  "帮我",
  "请解释一下",
  "请解释",
  "解释一下",
  "解释",
  "什么是",
  "什么是：",
  "介绍一下",
  "说说",
  "我想知道",
  "想了解",
];

/** 标题最长多少个字：再长就塞不进下拉与列表的一行 */
const MAX_TITLE_CHARS = 16;

export function titleFromQuestion(raw: string): string | null {
  const firstLine = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  let text = firstLine
    .replace(/^[#>*\-\s]+/, "")
    .replace(/[*`_~]/g, "")
    .trim();

  for (const prefix of LEADING_PHRASES) {
    if (!text.startsWith(prefix)) continue;
    const rest = text.slice(prefix.length).trim();
    // 去掉套话后过于短（例如整句就是「什么是」）就别去，免得起出一个没意义的名字
    if (rest.length >= 2) {
      text = rest;
      break;
    }
  }

  text = text.replace(/[?？。.！!，,；;：:\s]+$/, "").trim();
  if (!text) return null;
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text;
}

/** 系统给的默认名：只有还是这个名字时才允许自动命名 */
export function isDefaultThreadTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed === "" || trimmed === "新对话";
}
