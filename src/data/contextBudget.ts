/**
 * 上下文预算：估算、分段计价与历史选取
 *
 * 上下文管理的第一步不是压缩，而是**先量化**。不量化就只能按「消息条数」截断，
 * 而条数与 token 完全不成比例——一条几千字的笔记能顶几十条短问答。
 * 这套划分照的是 DeepSeek Harness 的 token-meter 与 compaction-basic：
 * system / 动态上下文 / 历史 / 当前问题各自计价，因为它们的处置方式完全不同
 * （system 永远不会被压掉，历史才是可压缩的部分）。
 *
 * 与 DSH 有一处**刻意偏差**：它的启发式是 4 字符 ≈ 1 token，而它自己的文档承认
 * 这会显著低估 CJK。这个应用的使用者几乎都用中文提问，照抄会把预算算小一半以上，
 * 等于没有预算。所以这里把 CJK 字符按 1 token 计（偏保守，宁可早一点触发）。
 * 估算终究是估算：它只用来决定「装得下装不下」，不用于计费。
 */
import type { ChatTurn } from "./aiProvider";

/** 非 CJK 字符的折算比例：约 4 个字符一个 token */
const CHARS_PER_TOKEN = 4;

/** 每条消息的固定开销（角色标记、分隔符），与 DSH 的每消息 4 一致 */
const MESSAGE_OVERHEAD = 4;

/**
 * CJK 及其相关标点、假名、全角符号。
 *
 * 用正则逐字符判断而不是统计字节长度：UTF-8 下一个汉字 3 字节，按字节算会高估。
 */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** 模型上下文窗口的默认值；配置里留空时使用 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 触发「上下文吃紧」的比例。
 *
 * 取 0.8 而不是 1.0：估算本身有误差，贴着窗口上限发请求容易直接被上游拒绝，
 * 留出的余量是给估算误差和模型输出用的。
 */
export const CONTEXT_PRESSURE_RATIO = 0.8;

/**
 * 历史里逐字保留的比例。
 *
 * 只保留尾部一小段（DSH 取 0.16），其余本该由摘要压缩接管；在还没有摘要的版本里，
 * 它的作用是把「最近聊了什么」保住，同时让总输入不至于无限增长。
 */
export const HISTORY_RETAIN_RATIO = 0.16;

/** 单条笔记注入上下文时的字符上限：笔记可以很长，但不能把整轮预算吃光 */
export const MAX_NOTE_CHARS = 6_000;

/** 单条检索结果摘录进上下文的字符上限 */
export const MAX_SNIPPET_CHARS = 240;

/** 估算一段文本的 token 数（CJK 按 1 token/字符，其余按 4 字符/token） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  // for..of 按码点迭代，代理对（emoji 等）不会被拆成两半
  for (const ch of text) {
    total += 1;
    if (CJK_RE.test(ch)) cjk += 1;
  }
  const rest = total - cjk;
  return cjk + Math.ceil(rest / CHARS_PER_TOKEN);
}

/** 估算一条消息的 token 数：正文 + 固定开销 */
export function estimateTurnTokens(turn: ChatTurn): number {
  return MESSAGE_OVERHEAD + estimateTokens(turn.content);
}

/** 每段上下文的估算结果 */
export interface ContextSegments {
  /** 静态系统提示：逐字节稳定，永远不参与裁剪 */
  system: number;
  /** 动态学习上下文（知识点、位置、前置知识、笔记） */
  context: number;
  /** 联网检索结果 */
  search: number;
  /** 保留的对话历史 */
  history: number;
  /** 本次问题 */
  question: number;
}

export interface ContextUsage extends ContextSegments {
  total: number;
  /** 本次生效的窗口大小 */
  window: number;
  /** 是否已经超过压力阈值（超过就该压缩了，当前版本先如实显示） */
  overPressure: boolean;
  /**
   * 因为没有摘要能力而被截断丢掉的历史条数。
   *
   * 有的版本里它就是「丢了多少内容」的唯一痕迹，所以必须能被界面读到——
   * 悄悄丢掉早期对话，使用者会以为模型还记得。
   */
  droppedHistory?: number;
}

/** 把各段估算合成一份可展示的用量 */
export function summarizeUsage(
  segments: ContextSegments,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): ContextUsage {
  const total =
    segments.system + segments.context + segments.search + segments.history + segments.question;
  const window = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  return { ...segments, total, window, overPressure: total > contextPressure(window) };
}

/** 压力阈值：超过它就该考虑压缩历史了 */
export function contextPressure(contextWindow: number = DEFAULT_CONTEXT_WINDOW): number {
  const window = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * CONTEXT_PRESSURE_RATIO);
}

/** 历史逐字保留的 token 预算 */
export function historyRetainBudget(contextWindow: number = DEFAULT_CONTEXT_WINDOW): number {
  const window = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * HISTORY_RETAIN_RATIO);
}

export interface HistorySelection<T> {
  /** 保留下来的尾部历史（顺序不变） */
  kept: T[];
  /** 因为预算被丢掉的条数 */
  droppedCount: number;
  /** 保留下来的估算 token 数 */
  tokens: number;
}

/**
 * 按 token 预算从尾部挑历史，并保证**不把答案与它的提问拆开**。
 *
 * 「成对」这条规则来自 DSH 压缩时的 tool-pairing：切点落在一次回答中间，
 * 模型就会看到一条没有提问的回答（或反过来），上下文立刻变得没法解释。
 * 所以预算用完、边界正好落在 assistant 上时，把它一起丢掉。
 *
 * 注意这只是**截断**，不是压缩：丢掉的内容不会以摘要形式回来。
 * 返回值里带上 `droppedCount`，界面才能如实说明「更早的内容已不在上下文里」。
 */
export function selectHistory<T extends { role: string; content: string }>(
  messages: T[],
  budgetTokens: number,
): HistorySelection<T> {
  let tokens = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = MESSAGE_OVERHEAD + estimateTokens(messages[i]!.content);
    if (tokens + cost > budgetTokens) break;
    tokens += cost;
    start = i;
  }
  // 边界落在回答上：它的提问已经被丢掉了，留着只会让模型看到没头没尾的一段
  while (start < messages.length && messages[start]!.role === "assistant") {
    tokens -= MESSAGE_OVERHEAD + estimateTokens(messages[start]!.content);
    start += 1;
  }
  const kept = messages.slice(start);
  return { kept, droppedCount: start, tokens: Math.max(tokens, 0) };
}

/** 按字符上限截断文本，并如实标注被截断 */
export function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, maxChars), truncated: true };
}

/** 供界面显示的紧凑数字：12345 → 12.3k */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
