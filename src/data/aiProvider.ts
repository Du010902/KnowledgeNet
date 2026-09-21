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
  };
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
  | {
      type: "done";
      finishReason?: string | null;
      usage?: unknown;
      /** 上游是否正常结束（收到 [DONE] 或结束原因）；false 表示连接中途断掉 */
      completed: boolean;
    }
  | { type: "error"; message: string };

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (info: {
    /** 停止原因：`length` 表示达到输出上限被截断，`stop` 为正常结束 */
    finishReason?: string | null;
    usage?: unknown;
    /** 是否收到正常的结束标记。为 false 时内容是半截的，不能算完整回答。 */
    completed: boolean;
  }) => void;
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

  async stream(
    messages: ChatTurn[],
    config: AiConfig,
    handlers: StreamHandlers,
  ): Promise<string> {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const channel = new Channel<StreamEvent>();
    channel.onmessage = (event) => {
      if (event.type === "delta") handlers.onDelta(event.text);
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

  async stream(
    messages: ChatTurn[],
    _config: AiConfig,
    handlers: StreamHandlers,
  ): Promise<string> {
    const requestId = `mock-${Date.now()}`;
    const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const reply = buildMockReply(question);

    let index = 0;
    const timer = window.setInterval(() => {
      // 每次推进几个字，模拟流式输出的节奏
      const step = 3 + Math.floor(Math.random() * 5);
      const chunk = reply.slice(index, index + step);
      index += step;
      if (chunk) handlers.onDelta(chunk);
      if (index >= reply.length) {
        window.clearInterval(timer);
        this.timers.delete(requestId);
        handlers.onDone({ finishReason: "stop", usage: { mock: true }, completed: true });
      }
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
