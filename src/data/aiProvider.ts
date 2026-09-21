/**
 * AI 服务接入层
 *
 * 桌面版走 Rust（鉴权、网络、流式解析都在后端，API Key 不进前端）；
 * 浏览器开发模式用内置模拟服务，方便在没有 Key 的情况下验证交互。
 *
 * 界面只依赖 AiProvider 接口，因此两种模式共用同一套对话逻辑。
 */
import { invoke, Channel } from "@tauri-apps/api/core";

import { isTauri } from "./platform";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiConfig {
  /** 留空使用官方默认地址 */
  baseUrl?: string | null;
  /** 留空使用默认模型 */
  model?: string | null;
  /** 思考模式默认关闭：普通问答优先速度，复杂推导再手动开启 */
  thinking: boolean;
  maxTokens?: number | null;
  temperature?: number | null;
  /**
   * 联网检索默认关闭：检索会把问题（检索词）发给 DeepSeek，
   * 与「只发送当前知识点」的隐私承诺相比是额外的一步，必须由使用者主动开启。
   */
  webSearch?: boolean;
  /**
   * 检索端点。与会话端点**相互独立**：检索走的是 Anthropic 兼容的 Messages 接口，
   * 由服务端工具执行搜索，和 /chat/completions 不是同一条路。
   * 留空使用 https://api.deepseek.com/anthropic/v1
   */
  searchBaseUrl?: string | null;
  /** 检索用的模型名（Anthropic 格式）。留空使用 deepseek-v4-flash */
  searchModel?: string | null;
  /** 上下文窗口；留空按 128K 处理。只影响本地预算估算，不发给上游 */
  contextWindow?: number | null;
}

export const DEFAULT_MODEL = "deepseek-flash";

/** 官方上限：max_tokens 取值 1 ~ 393216（384K） */
export const MAX_OUTPUT_TOKENS = 393_216;

/** 未设置时非思考模式的默认值；思考模式则交给服务端（默认 64K） */
export const DEFAULT_MAX_TOKENS = 16_384;

export function defaultAiConfig(): AiConfig {
  return {
    baseUrl: null,
    model: null,
    thinking: false,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: null,
    webSearch: false,
    searchBaseUrl: null,
    searchModel: null,
    contextWindow: null,
  };
}

/**
 * 一条可引用的检索来源。
 *
 * 只有 `url` 是必需的：不是每个后端都返回标题、摘录与日期。为了凑齐字段而编造内容
 * 会让界面撒谎，所以缺什么就留空，展示时退化成主机名。
 */
export interface WebSearchSource {
  url: string;
  title?: string | null;
  snippet?: string | null;
  /** 发布时间/抓取时间，由检索后端给出的原始字符串 */
  publishedAt?: string | null;
}

/** 一次联网检索的结果 */
export interface WebSearchOutcome {
  /** 实际发出的检索词（界面要如实显示，使用者才知道问题被怎么发出去了） */
  query: string;
  sources: WebSearchSource[];
  /** 后端返回的来源被上限截断过 */
  truncated: boolean;
}

export interface AiSettings {
  hasApiKey: boolean;
  config: AiConfig;
}

export interface TestResult {
  ok: boolean;
  message: string;
  model?: string | null;
  latencyMs?: number | null;
}

/**
 * 生成过程中推给界面的事件。
 *
 * 字段名与 Rust 侧 `StreamEvent` 的序列化结果一致（camelCase），
 * 契约由 `src-tauri/tests/stream_contract.rs` 锁住——字段名一旦对不上，
 * 「被长度截断」这类提示会静默失效。
 */
export type StreamEvent =
  | { type: "delta"; text: string }
  /**
   * 思考过程的增量（只在思考模式下出现）。
   *
   * 与 `delta` 分开：正文会进消息正文、会进下一轮上下文，
   * 思考过程只作为可折叠的过程记录展示与留档。
   */
  | { type: "reasoning"; text: string }
  /**
   * 模型发起了一次工具调用。
   *
   * `query` 是从调用参数里解出来的检索词（不是原始 JSON）：界面要显示「查了什么」，
   * 让前端再解析一遍参数只会把「参数怎么解」这件事复制到两个地方。
   */
  | { type: "toolCall"; id: string; name: string; query: string; round: number }
  /** 工具调用有了结果（成功或失败都走这里，失败用 ok=false + error 说明） */
  | {
      type: "toolResult";
      id: string;
      ok: boolean;
      sources: WebSearchSource[];
      truncated: boolean;
      elapsedMs?: number | null;
      error?: string | null;
    }
  | {
      type: "done";
      finishReason?: string | null;
      usage?: unknown;
      /** 上游是否正常结束（收到 [DONE] 或结束原因）；false 表示连接中途断掉 */
      completed: boolean;
    }
  /**
   * 过程状态：上游暂时不可用正在重试、正在联网检索之类。
   * 与 `error` 分开，是因为它不是失败——把「正在重试」报成错误会让使用者以为这次提问已经废了。
   */
  | { type: "status"; text: string }
  | { type: "error"; message: string };

export interface StreamHandlers {
  onDelta: (text: string) => void;
  /** 可选：思考过程增量。没实现时忽略，不影响生成。 */
  onReasoning?: (text: string) => void;
  /** 可选：模型发起工具调用（目前只有联网检索） */
  onToolCall?: (call: { id: string; name: string; query: string; round: number }) => void;
  /** 可选：工具调用结果 */
  onToolResult?: (result: {
    id: string;
    ok: boolean;
    sources: WebSearchSource[];
    truncated: boolean;
    elapsedMs?: number | null;
    error?: string | null;
  }) => void;
  onDone: (info: {
    /** 停止原因：`length` 表示达到输出上限被截断，`stop` 为正常结束 */
    finishReason?: string | null;
    usage?: unknown;
    /** 是否收到正常的结束标记。为 false 时内容是半截的，不能算完整回答。 */
    completed: boolean;
  }) => void;
  /** 可选：过程状态提示。没实现时忽略，不影响生成。 */
  onStatus?: (text: string) => void;
  onError: (message: string) => void;
}

export interface AiProvider {
  readonly kind: "deepseek" | "mock";
  readonly label: string;
  /** 是否已具备调用条件（桌面版且已配置 Key） */
  isConfigured(): Promise<boolean>;
  loadSettings(): Promise<AiSettings>;
  saveConfig(config: AiConfig): Promise<void>;
  saveApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
  testConnection(config: AiConfig): Promise<TestResult>;
  /**
   * 检索一次网页，返回可引用的来源。
   *
   * 只做检索、不生成答案：检索词与来源要能被界面如实展示，而「怎么用这些来源」
   * 交给主对话那条请求，检索结果作为不可信数据注入上下文。
   */
  webSearch(query: string): Promise<WebSearchOutcome>;
  /** 用一次极小检索验证检索端点与密钥是否可用 */
  testWebSearch(config: AiConfig): Promise<TestResult>;
  /**
   * 发起一次流式生成。返回 requestId，调用方用它来停止生成。
   */
  stream(
    messages: ChatTurn[],
    config: AiConfig,
    handlers: StreamHandlers,
  ): Promise<string>;
  cancel(requestId: string): Promise<void>;
}

/* ------------------------------ 桌面版实现 ------------------------------ */

class DeepSeekProvider implements AiProvider {
  readonly kind = "deepseek" as const;
  readonly label = "DeepSeek";

  async isConfigured(): Promise<boolean> {
    const s = await this.loadSettings();
    return s.hasApiKey;
  }

  async loadSettings(): Promise<AiSettings> {
    /*
     * AI 配置属于设备设置（AppData），不存在知识库里：换一台电脑打开同一个知识库时，
     * 不该被上一个库的模型选择绑住。`hasApiKey` 只回传「有没有配置」，
     * 密钥本身始终留在系统凭据存储里。
     */
    const wire = await invoke<{ aiConfig?: AiConfig | null; hasApiKey?: boolean }>(
      "load_device_settings",
    );
    return {
      hasApiKey: wire?.hasApiKey ?? false,
      config: { ...defaultAiConfig(), ...(wire?.aiConfig ?? {}) },
    };
  }

  async saveConfig(config: AiConfig): Promise<void> {
    await invoke("save_ai_config", { config });
  }

  async saveApiKey(key: string): Promise<void> {
    await invoke("save_api_key", { key });
  }

  async clearApiKey(): Promise<void> {
    await invoke("clear_api_key");
  }

  async testConnection(config: AiConfig): Promise<TestResult> {
    return await invoke<TestResult>("test_ai_connection", { config });
  }

  /**
   * 联网检索。命令只带检索词：密钥与端点配置留在 Rust 侧读，
   * 前端拿不到 Key，也不需要知道端点是怎么解析出来的。
   */
  async webSearch(query: string): Promise<WebSearchOutcome> {
    return await invoke<WebSearchOutcome>("web_search", { query });
  }

  async testWebSearch(config: AiConfig): Promise<TestResult> {
    return await invoke<TestResult>("test_web_search", { config });
  }

  async stream(
    messages: ChatTurn[],
    config: AiConfig,
    handlers: StreamHandlers,
  ): Promise<string> {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const channel = new Channel<StreamEvent>();
    channel.onmessage = (event) => {
      if (event.type === "delta") handlers.onDelta(event.text);
      else if (event.type === "reasoning") handlers.onReasoning?.(event.text);
      else if (event.type === "toolCall") handlers.onToolCall?.(event);
      else if (event.type === "toolResult") handlers.onToolResult?.(event);
      else if (event.type === "status") handlers.onStatus?.(event.text);
      else if (event.type === "done") handlers.onDone(event);
      else if (event.type === "error") handlers.onError(event.message);
    };

    await invoke("start_chat", { request: { requestId, messages, config }, channel });
    return requestId;
  }

  async cancel(requestId: string): Promise<void> {
    await invoke("cancel_chat", { requestId });
  }
}

/* --------------------------- 浏览器模拟实现 --------------------------- */

/**
 * 开发模式下的模拟服务。
 *
 * 存在的意义：不需要真实 API Key 就能验证「对话 → 选中文字 → 建前置节点 → 返回」
 * 这条核心流程，也让浏览器端和桌面端跑同一套界面代码。
 * 回答内容是固定的模板拼接，只为产生可选中、可拆分的真实文本。
 */
class MockProvider implements AiProvider {
  readonly kind = "mock" as const;
  readonly label = "模拟 AI（浏览器开发模式）";
  private timers = new Map<string, number>();

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async loadSettings(): Promise<AiSettings> {
    return { hasApiKey: false, config: defaultAiConfig() };
  }

  async saveConfig(): Promise<void> {
    /* 模拟模式无需保存 */
  }

  async saveApiKey(): Promise<void> {
    throw new Error("浏览器开发模式不保存 API Key，请使用桌面版");
  }

  async clearApiKey(): Promise<void> {
    /* 无需处理 */
  }

  async testConnection(): Promise<TestResult> {
    return { ok: true, message: "模拟服务始终可用", model: "mock", latencyMs: 0 };
  }

  /**
   * 浏览器开发模式下的模拟检索。
   *
   * 返回两条一眼就能看出是假来源的条目：这里的目的不是给出真结果，
   * 而是让「检索结果如何进入回答、来源如何展示」这条链路在浏览器里也能走通。
   */
  async webSearch(query: string): Promise<WebSearchOutcome> {
    return {
      query,
      truncated: false,
      sources: [
        {
          url: "https://example.invalid/mock-source-1",
          title: "模拟来源一（浏览器开发模式）",
          snippet: "这条来源是内置模拟服务编造的，用于验证来源展示与引用格式。",
          publishedAt: null,
        },
        {
          url: "https://example.invalid/mock-source-2",
          title: "模拟来源二（浏览器开发模式）",
          snippet: "桌面版里这里会换成真实检索返回的标题、摘录与日期。",
          publishedAt: null,
        },
      ],
    };
  }

  async testWebSearch(): Promise<TestResult> {
    return { ok: true, message: "模拟检索始终可用（返回 2 条假来源）", model: "mock", latencyMs: 0 };
  }

  async stream(
    messages: ChatTurn[],
    _config: AiConfig,
    handlers: StreamHandlers,
  ): Promise<string> {
    const requestId = `mock-${Date.now()}`;
    const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const callId = "mock-search-1";

    /*
     * 模拟服务按**脚本**走一遍真实顺序：先想一轮 → 调用检索 → 拿到来源 → 再想一轮 → 回答。
     *
     * 顺序本身就是这条时间线要展示的东西，所以不能在模拟里省掉中间两步：
     * 浏览器自检（ui-check）就靠它验证「检索条目出现、状态从进行中变成 N 条来源、
     * 答案里不混推理」。标题与来源都是假的，但结构是真的。
     */
    const script: Array<{
      event:
        | { kind: "reasoning"; text: string }
        | { kind: "delta"; text: string }
        | { kind: "toolCall"; id: string; name: string; query: string; round: number }
        | {
            kind: "toolResult";
            id: string;
            ok: boolean;
            sources: WebSearchSource[];
            truncated: boolean;
            elapsedMs: number;
            error: string | null;
          };
      /** 这一步之后空转多少个 tick（用来让「检索中…」真的看得见） */
      hold?: number;
    }> = [
      { event: { kind: "reasoning", text: buildMockReasoning(question) } },
      {
        event: {
          kind: "toolCall",
          id: callId,
          name: "web_search",
          query: question.trim() || "这个概念",
          round: 1,
        },
        hold: 8,
      },
      {
        event: {
          kind: "toolResult",
          id: callId,
          ok: true,
          /*
           * 刻意给 12 条（多于旧版写死的 8 条上限）：来源条数现在由上游决定，
           * 界面不再截断，只把清单收进各自可折叠的检索条目里。
           * 浏览器自检就靠这份数据验证「超过 8 条也照样全列出来」。
           */
          sources: Array.from({ length: 12 }, (_, i) => ({
            url: `https://example.invalid/mock-source-${i + 1}`,
            title: `模拟来源${i + 1}（浏览器开发模式）`,
            snippet:
              i === 0
                ? "这条来源是内置模拟服务编造的，用于验证来源展示与引用格式。"
                : `第 ${i + 1} 条假来源；桌面版里会换成真实检索返回的标题、摘录与日期。`,
            publishedAt: null,
          })),
          truncated: false,
          elapsedMs: 640,
          error: null,
        },
      },
      { event: { kind: "reasoning", text: buildMockReasoningAfterSearch() } },
      { event: { kind: "delta", text: buildMockReply(question) } },
    ];

    let index = 0;
    let cursor = 0;
    let hold = 0;

    const finish = () => {
      window.clearInterval(timer);
      this.timers.delete(requestId);
      handlers.onDone({ finishReason: "stop", usage: { mock: true }, completed: true });
    };

    const timer = window.setInterval(() => {
      if (hold > 0) {
        hold -= 1;
        return;
      }
      const item = script[index];
      if (!item) {
        finish();
        return;
      }
      const event = item.event;

      if (event.kind === "reasoning" || event.kind === "delta") {
        const chunk = event.text.slice(cursor, cursor + 6);
        cursor += 6;
        if (chunk) (event.kind === "reasoning" ? handlers.onReasoning : handlers.onDelta)?.(chunk);
        if (cursor >= event.text.length) {
          index += 1;
          cursor = 0;
          hold = item.hold ?? 0;
        }
        return;
      }

      if (event.kind === "toolCall") {
        handlers.onToolCall?.({
          id: event.id,
          name: event.name,
          query: event.query,
          round: event.round,
        });
      } else {
        handlers.onToolResult?.({
          id: event.id,
          ok: event.ok,
          sources: event.sources,
          truncated: event.truncated,
          elapsedMs: event.elapsedMs,
          error: event.error,
        });
      }
      index += 1;
      cursor = 0;
      hold = item.hold ?? 0;
    }, 45);

    this.timers.set(requestId, timer);
    return requestId;
  }

  async cancel(requestId: string): Promise<void> {
    const timer = this.timers.get(requestId);
    if (timer !== undefined) {
      window.clearInterval(timer);
      this.timers.delete(requestId);
    }
  }
}

/**
 * 模拟的思考过程。
 *
 * 刻意写成「看得出是过程而不是答案」的样子：真实推理内容也是这样——
 * 有反复、有自我纠正、句子不完整。用它来验证「过程」与「正文」在界面上分得开。
 */
function buildMockReasoning(question: string): string {
  const topic = question.trim() || "这个概念";
  return [
    `先想清楚「${topic}」到底在问什么。`,
    `它有两种可能的意思，需要分开处理。`,
    `第一种是字面定义，第二种是它在实际场景里的作用。`,
    `如果只答第一种，使用者大概会觉得没解决他的问题。`,
    `那就先给定义，再补一个具体场景。`,
    `等一下，还要确认：这里涉及的前置概念我是不是应该先点出来？`,
    `对，前置概念不点出来，后面的推导会断层。`,
    `好，按「定义 → 为什么需要 → 一个例子」来组织。`,
  ].join("");
}

/** 检索之后的第二轮思考：时间线上要紧跟检索条目，看得出「材料改变了什么」 */
function buildMockReasoningAfterSearch(): string {
  return [
    `检索回来的材料里有两处说法不完全一致，得先判断哪一处更可信。`,
    `一处来自官方文档，另一处是二手转述，以后者为准会出错。`,
    `那就以官方那份为主，并在回答里把来源标出来。`,
  ].join("");
}

function buildMockReply(question: string): string {
  const topic = question.trim() || "这个概念";
  /*
   * 回答里刻意包含**公式、表格、任务列表、代码块**。
   *
   * 这段文字不只是「有内容可选」——它是浏览器自检里唯一能验证
   * Markdown 与 KaTeX 渲染真的跑通的样本（`ui-check` 会断言 `.katex` 与 `<table>` 出现）。
   * 公式用的是模型最常写的 `\[ … \]` 与 `\( … \)` 定界符，不是 `$…$`。
   */
  return [
    `先把「${topic}」拆成几个部分来看。\n\n`,
    `**它解决什么问题**\n\n`,
    `它要处理的核心困难是：输入之间需要互相参考，而简单的逐项处理做不到这一点。`,
    `理解这里需要先掌握「注意力机制」——它决定了每个位置应该关注哪些位置。\n\n`,
    `**关键步骤**\n\n`,
    `1. 把输入映射成向量表示，这一步依赖「词嵌入」。\n`,
    `2. 通过「注意力机制」计算各位置之间的权重。\n`,
    `3. 按权重加权求和，得到新的表示。\n\n`,
    `**用数学写出来**\n\n`,
    `缩放点积注意力可以写成：\n\n`,
    `\\[\n\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V\n\\]\n\n`,
    `其中 \\(d_k\\) 是键向量的维度，除以 \\(\\sqrt{d_k}\\) 是为了让点积不要随维度增长得太大。\n\n`,
    `| 方案 | 复杂度 | 特点 |\n`,
    `| :--- | ---: | :--- |\n`,
    `| 逐项处理 | O(n) | 无法互相参考 |\n`,
    `| 注意力 | O(n²) | 全序列互相参考 |\n\n`,
    `**接下来可以做的**\n\n`,
    `- [x] 记下「词嵌入」\n`,
    `- [ ] 弄懂「注意力机制」的权重是怎么来的\n`,
    `- [ ] 看完缩放点积的推导\n\n`,
    `如果你对其中某一步还不清楚，可以先把那个概念单独记下来，深入理解之后再回到这里。`,
  ].join("");
}

/* -------------------------------- 选择 -------------------------------- */

let singleton: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (!singleton) {
    singleton = isTauri() ? new DeepSeekProvider() : new MockProvider();
  }
  return singleton;
}

/** 是否具备真实 AI 能力（用于界面上给出说明） */
export function hasRealAi(): boolean {
  return isTauri();
}
