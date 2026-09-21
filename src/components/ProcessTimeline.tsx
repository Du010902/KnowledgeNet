/**
 * 过程时间线
 *
 * 一次回答不只是「一段思考 + 一段正文」：模型可能先想一轮、调用检索、拿到结果再想一轮，
 * 最后才回答。这个组件把那些步骤按发生顺序摆出来——**顺序本身就是信息**，
 * 压成一段文字之后，就看不出检索到底改变了什么。
 *
 * 折叠分两层，各自解决一个具体问题：
 * - **整条时间线**按「是否还在增长」开合：生成中展开（那正是「看着它做」的时刻），
 *   结束收起，免得把答案越推越远；
 * - **每一条步骤**各自可折叠：思考可能几千字，检索可能返回几十条来源，
 *   一次全铺开会把整条对话淹掉。检索步骤在跑完之后默认收起（摘要已经写着
 *   「N 条来源 · 耗时」），想看哪一条点开哪一条。
 *
 * 三条与旧版「思考过程」相同的规则，每条都对应一个具体的错误：
 * - **推理是纯文本，不走 Markdown**：推理里常出现半截的 `**`、`[`、公式定界符，
 *   按 Markdown 渲染只会变成排版噪音，而这段文字的用途是「看思路」；
 * - **用 textContent 而不是 innerHTML**：内容来自模型，不是我们生成的 HTML；
 * - **来源是外部不可信内容**：只显示标题/主机名与摘录，可点开原文核对，
 *   不做 Markdown、不注入 DOM。
 *
 * 整个过程记录不参与「复制回答」（复制走 `content`），也不回传给模型。
 */
import { useEffect, useState } from "react";

import type { ProcessStep } from "@/data/chatTypes";
import { hasRunningStep, sourceLabel, summarizeSteps } from "@/data/processSteps";
import { Icon } from "./icons";

export function ProcessTimeline({ steps, streaming }: { steps: ProcessStep[]; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    // 流结束的那一刻收起；生成中不打扰使用者手动折叠的选择（streaming 没变就不会重跑）
    setOpen(streaming);
  }, [streaming]);

  if (steps.length === 0) return null;

  const running = hasRunningStep(steps);

  return (
    <details
      className={`process${streaming ? " is-live" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="process-title">
          {/*
            两个分支各写一个字面量，而不是 `name={running ? "a" : "b"}`：
            图标清单核对脚本只认字面量，三元里的名字会被当成「声明了但没人用」。
          */}
          {running ? <Icon name="refresh" /> : <Icon name="steps" />}
          {running ? "正在检索…" : "过程"}
        </span>
        <span className="process-meta">{summarizeSteps(steps)}</span>
      </summary>

      <ol className="process-steps">
        {steps.map((step, index) => (
          <StepItem key={step.kind === "search" ? step.id : `reasoning-${index}`} step={step} streaming={streaming} />
        ))}
      </ol>
    </details>
  );
}

/**
 * 一条步骤。
 *
 * 默认展开状态是有讲究的：推理展开（它就是被看的东西），检索在跑完之后收起
 * （摘要已经给出「几条来源」，展开是为了逐条核对，不是为了先看一屏链接）。
 */
function StepItem({ step, streaming }: { step: ProcessStep; streaming: boolean }) {
  const [open, setOpen] = useState(defaultOpen(step, streaming));

  useEffect(() => {
    setOpen(defaultOpen(step, streaming));
  }, [step.kind, streaming]);

  if (step.kind === "reasoning") {
    return (
      <li className="process-step is-reasoning">
        <details className="step" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>
            {/*
              思考这一步不放图标，只用时间线上的一个节点：它的「类型」就是它在列表里的位置，
              再配一个图形只会和助手头像、检索图标抢注意力。
            */}
            <span className="step-node" aria-hidden="true" />
            <span className="step-label">思考</span>
            {/* 收起时给一行预览：不用点开也能看出这段在想什么 */}
            <span className="step-preview">{previewOf(step.text)}</span>
            <span className="step-meta">{step.text.length} 字</span>
          </summary>
          <div className="step-body">{step.text}</div>
        </details>
      </li>
    );
  }

  return (
    <li className={`process-step is-search is-${step.status}`}>
      <details className="step" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="step-mark">
            <Icon name="search" />
          </span>
          <span className="step-label">检索</span>
          <span className="step-query">{step.query}</span>
          <span className="step-state">{describeSearchState(step)}</span>
        </summary>
        <div className="step-main">
          {step.error && <p className="step-error">{step.error}</p>}
          {step.sources.length > 0 && (
            <ul className="step-sources">
              {step.sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer noopener">
                    {sourceLabel(source)}
                  </a>
                  {source.snippet ? <span className="step-snippet">{source.snippet}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {step.truncated && (
            <p className="step-note">（上游返回的来源过多，只保留前 {step.sources.length} 条）</p>
          )}
        </div>
      </details>
    </li>
  );
}

function defaultOpen(step: ProcessStep, streaming: boolean): boolean {
  if (step.kind === "reasoning") return true;
  // 检索：跑的时候展开（能看着它查），跑完收起（摘要已说明结果多少）
  return streaming;
}

/** 一行预览：压掉换行、按字数截断。只是摘要，正文总是完整的 */
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 64 ? `${flat.slice(0, 64)}…` : flat;
}

/** 检索这一步此刻处于什么状态：进行中 / 失败 / 返回了几条 */
function describeSearchState(step: Extract<ProcessStep, { kind: "search" }>): string {
  if (step.status === "running") return "检索中…";
  if (step.status === "failed") return "检索失败";
  const parts = [`${step.sources.length} 条来源`];
  if (step.elapsedMs != null) parts.push(`${(step.elapsedMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}
