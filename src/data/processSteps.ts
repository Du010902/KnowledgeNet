/**
 * 过程记录的累积规则
 *
 * 这些函数看着简单，但每一条都对应一个会出错的边界：
 *
 * - **连续的推理增量要并进同一步**，否则每来一个 delta 就多一条「思考」条目，
 *   一屏几十条，时间线反而看不清过程；
 * - **检索之后的推理必须另起一步**，否则「检索前怎么想」与「检索后怎么想」
 *   会被合并成一段，看不出检索到底改变了什么——而那正是过程记录的意义；
 * - **结果按 id 回填**，因为工具调用是异步的：模型可能同时发起两个检索，
 *   先回来的未必是先发出的。
 *
 * 全部做成纯函数：它们决定的是「过程长什么样」，不该只能靠跑起整个界面对照。
 */
import type { ProcessSource, ProcessStep } from "./chatTypes";

/** 追加一段推理：并进末尾的推理步骤，末尾不是推理（或还没有步骤）时新起一步 */
export function appendReasoning(steps: ProcessStep[], text: string): ProcessStep[] {
  if (!text) return steps;
  const last = steps[steps.length - 1];
  if (last && last.kind === "reasoning") {
    const merged: ProcessStep = { kind: "reasoning", text: last.text + text };
    return [...steps.slice(0, -1), merged];
  }
  return [...steps, { kind: "reasoning", text }];
}

export interface SearchCall {
  id: string;
  query: string;
}

/** 模型发起了检索：插入一条「进行中」的步骤 */
export function startSearch(steps: ProcessStep[], call: SearchCall): ProcessStep[] {
  const step: ProcessStep = {
    kind: "search",
    id: call.id,
    query: call.query,
    status: "running",
    sources: [],
    truncated: false,
  };
  return [...steps, step];
}

export interface SearchResult {
  id: string;
  ok: boolean;
  sources: ProcessSource[];
  truncated: boolean;
  elapsedMs?: number | null;
  error?: string | null;
}

/**
 * 检索有了结果：按 id 回填。
 *
 * 找不到对应 id 时**不猜**：宁可不动，也不要把结果挂到另一个查询上——
 * 那会让过程记录撒谎，而这份记录的唯一价值就是可信。
 */
export function finishSearch(steps: ProcessStep[], result: SearchResult): ProcessStep[] {
  let found = false;
  const next = steps.map((step) => {
    if (step.kind !== "search" || step.id !== result.id) return step;
    found = true;
    return {
      ...step,
      status: result.ok ? ("done" as const) : ("failed" as const),
      sources: result.sources,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs ?? null,
      error: result.error ?? null,
    };
  });
  return found ? next : steps;
}

/**
 * 一条消息要显示的过程步骤。
 *
 * `steps` 为空而 `reasoning` 有值，说明这条消息是上一版存下的：把那段文字当成一条推理步骤。
 * 这样旧对话不会突然看不见思考过程。
 */
export function stepsOf(message: {
  steps?: ProcessStep[] | null;
  reasoning?: string | null;
}): ProcessStep[] {
  const steps = message.steps ?? [];
  if (steps.length > 0) return steps;
  const legacy = message.reasoning?.trim();
  return legacy ? [{ kind: "reasoning", text: legacy }] : [];
}

/** 时间线摘要：折叠状态下也要能一眼看出「查了几次、想了多少」 */
export function summarizeSteps(steps: ProcessStep[]): string {
  let searches = 0;
  let reasoningChars = 0;
  for (const step of steps) {
    if (step.kind === "search") searches += 1;
    else reasoningChars += step.text.length;
  }
  const parts: string[] = [];
  if (searches > 0) parts.push(`检索 ${searches} 次`);
  if (reasoningChars > 0) parts.push(`思考 ${reasoningChars} 字`);
  return parts.join(" · ");
}

/** 是否还有没回来的工具调用：决定生成中要不要继续显示「进行中」 */
export function hasRunningStep(steps: ProcessStep[]): boolean {
  return steps.some((step) => step.kind === "search" && step.status === "running");
}

/** 来源没有标题时退化成主机名；URL 不合法就原样显示，格式化不该抛错 */
export function sourceLabel(source: ProcessSource): string {
  const title = source.title?.trim();
  if (title) return title;
  try {
    return new URL(source.url).hostname;
  } catch {
    return source.url;
  }
}
