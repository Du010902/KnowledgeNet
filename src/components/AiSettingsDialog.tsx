/**
 * AI 设置
 *
 * API Key 直接保存到系统凭据存储（Windows 凭据管理器），
 * 不写进数据库、配置文件、备份或日志；界面只显示「是否已配置」。
 *
 * 保存与测试是两条独立的路：测试连接会先把当前表单存下来再发一次真实请求，
 * 因此测试失败时必须留在弹窗里说明原因，不能悄悄关掉——
 * 那样使用者会以为设置已经生效。
 */
import { useEffect, useId, useState } from "react";

import { getAiProvider, hasRealAi, type AiConfig } from "@/data/aiProvider";
import { useChatStore } from "@/chatStore";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";

const MODEL_PRESETS = ["deepseek-flash", "deepseek-v4-pro"];

/**
 * 官方上限：max_tokens 取值 1 ~ 393216（384K）。
 * 未设置时由服务端决定：非思考模式 8K，思考模式 64K。
 */
const MAX_OUTPUT_TOKENS = 393_216;

const MAX_TOKEN_PRESETS = [
  { label: "8K", value: 8_192 },
  { label: "16K", value: 16_384 },
  { label: "64K", value: 65_536 },
  { label: "128K", value: 131_072 },
];

export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const configured = useChatStore((s) => s.configured);
  const refresh = useChatStore((s) => s.refreshConfigured);
  const saveConfig = useChatStore((s) => s.saveConfig);
  const saveApiKey = useChatStore((s) => s.saveApiKey);
  const clearApiKey = useChatStore((s) => s.clearApiKey);

  const [config, setConfig] = useState<AiConfig | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [searchFeedback, setSearchFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apiKeyId = useId();
  const modelId = useId();
  const tokensId = useId();
  const baseUrlId = useId();
  const searchBaseUrlId = useId();
  const searchModelId = useId();
  const contextWindowId = useId();

  useEffect(() => {
    void getAiProvider()
      .loadSettings()
      .then((s) => setConfig(s.config))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (!hasRealAi()) {
    return (
      <Dialog
        title="AI 设置"
        subtitle="浏览器开发模式"
        onClose={onClose}
        footer={
          <button type="button" className="btn primary" onClick={onClose}>
            知道了
          </button>
        }
      >
        <p className="empty-text">
          当前运行在浏览器开发模式，用的是内置模拟服务，无法配置真实的 DeepSeek API，也不会保存密钥。
        </p>
        <p className="empty-text">请在桌面版中打开这个窗口录入 API Key。</p>
      </Dialog>
    );
  }

  const onSaveKey = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveApiKey(keyDraft);
      setKeyDraft("");
      setFeedback({ ok: true, text: "API Key 已保存到系统凭据存储。" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onClearKey = async () => {
    setBusy(true);
    try {
      await clearApiKey();
      setFeedback({ ok: true, text: "已清除系统凭据存储里的 API Key。" });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    if (!config) return;
    setBusy(true);
    setFeedback(null);
    setError(null);
    try {
      await saveConfig(config);
      const result = await getAiProvider().testConnection(config);
      setFeedback({
        ok: result.ok,
        text: result.ok ? `连接成功：${result.message}` : `连接失败：${result.message}`,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTestWebSearch = async () => {
    if (!config) return;
    setBusy(true);
    setSearchFeedback(null);
    setError(null);
    try {
      // 先存下来再测：测的是当前表单里填的端点，而不是磁盘上那份旧配置
      await saveConfig(config);
      const result = await getAiProvider().testWebSearch(config);
      setSearchFeedback({
        ok: result.ok,
        text: result.ok ? `联网检索可用：${result.message}` : `联网检索失败：${result.message}`,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      await saveConfig(config);
    } catch (e) {
      // 保存失败留在弹窗里说明原因，不能关掉：界面上的开关看起来已经改了
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    onClose();
  };

  return (
    <Dialog
      title="AI 设置"
      subtitle="选择适合你学习节奏的回答方式"
      wide
      onClose={onClose}
      footer={
        config ? (
          <>
            <button type="button" className="btn" onClick={() => void onTest()} disabled={busy}>
              {busy ? "处理中…" : "测试连接"}
            </button>
            <button type="button" className="btn primary" onClick={() => void onSave()} disabled={busy}>
              保存并关闭
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      <div className="settings-provider">
        <span className="provider-logo">
          <Icon name="sparkles" />
        </span>
        <div>
          <strong>DeepSeek</strong>
          <p>学习助手 · 只围绕当前知识点回答</p>
        </div>
        <span className={`pill ${configured ? "is-done" : ""}`}>
          {configured ? "已配置" : "未配置"}
        </span>
      </div>

      {!config ? (
        <p className="empty-text">{error ?? "正在读取设置…"}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={apiKeyId}>API Key</label>
            <div className="secret-row">
              <input
                id={apiKeyId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={configured ? "已配置（重新输入可覆盖）" : "sk-…"}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                onClick={() => void onSaveKey()}
                disabled={busy || keyDraft.trim().length === 0}
              >
                保存密钥
              </button>
              {configured && (
                <button type="button" className="btn ghost" onClick={() => void onClearKey()} disabled={busy}>
                  清除
                </button>
              )}
            </div>
            <p>
              保存在系统凭据存储中，不写入知识库、配置文件、备份或日志。
              当前状态：{configured ? "已配置" : "未配置"}。
            </p>
          </div>

          <div className="field-row grid-2">
            <div className="field">
              <label htmlFor={modelId}>模型</label>
              <input
                id={modelId}
                list="model-presets"
                value={config.model ?? ""}
                placeholder="deepseek-flash"
                spellCheck={false}
                onChange={(e) => setConfig({ ...config, model: e.target.value || null })}
              />
              <datalist id="model-presets">
                {MODEL_PRESETS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p>留空使用默认模型。模型名没有写死在代码里，随时可以调整。</p>
            </div>

            <div className="field">
              <label htmlFor={tokensId}>回答长度上限（max_tokens）</label>
              <input
                id={tokensId}
                type="number"
                min={1}
                max={MAX_OUTPUT_TOKENS}
                step={1024}
                value={config.maxTokens ?? ""}
                placeholder="留空交给服务端"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === "") {
                    setConfig({ ...config, maxTokens: null });
                    return;
                  }
                  const n = Number(raw);
                  setConfig({
                    ...config,
                    maxTokens: Number.isFinite(n)
                      ? Math.min(Math.max(Math.floor(n), 1), MAX_OUTPUT_TOKENS)
                      : null,
                  });
                }}
              />
              <p>
                上限 384K（393216），输入与输出合计受上下文长度限制。
                留空表示交给服务端：非思考模式默认 8K，思考模式默认 64K。
              </p>
            </div>
          </div>

          <div className="chip-row">
            {MAX_TOKEN_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`chip ${config.maxTokens === p.value ? "active" : ""}`}
                onClick={() => setConfig({ ...config, maxTokens: p.value })}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className={`chip ${config.maxTokens === null ? "active" : ""}`}
              title="交给服务端决定"
              onClick={() => setConfig({ ...config, maxTokens: null })}
            >
              默认
            </button>
          </div>

          <div className="field">
            <label htmlFor={baseUrlId}>服务地址</label>
            <input
              id={baseUrlId}
              type="url"
              value={config.baseUrl ?? ""}
              placeholder="https://api.deepseek.com"
              spellCheck={false}
              onChange={(e) => setConfig({ ...config, baseUrl: e.target.value || null })}
            />
            <p>换成兼容接口的中转地址时改这里；留空使用默认地址。</p>
          </div>

          {/*
            上下文窗口只影响本地预算估算：它决定历史保留多少、什么时候提示「上下文吃紧」。
            换用窗口更小的模型或中转服务时，这里填错会让估算跟着错。
          */}
          <div className="field">
            <label htmlFor={contextWindowId}>上下文窗口</label>
            <input
              id={contextWindowId}
              type="number"
              min={1000}
              step={1024}
              value={config.contextWindow ?? ""}
              placeholder="128000"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (raw === "") {
                  setConfig({ ...config, contextWindow: null });
                  return;
                }
                const n = Number(raw);
                setConfig({
                  ...config,
                  contextWindow: Number.isFinite(n) && n > 0 ? Math.floor(n) : null,
                });
              }}
            />
            <p>
              只用于本地估算，不发给上游：历史逐字保留窗口的 16%，超过 80% 视为上下文吃紧。
              留空按 128K 计算。
            </p>
          </div>

          {/*
            联网检索单独一段：它和对话不是同一条接口，也不是同一个开关。
            写成一段而不是散落在各处，是因为「检索词会离开本机」这件事必须在这里说清楚。
          */}
          <div className="field">
            <label htmlFor={searchBaseUrlId}>联网检索端点</label>
            <input
              id={searchBaseUrlId}
              type="url"
              value={config.searchBaseUrl ?? ""}
              placeholder="https://api.deepseek.com/anthropic/v1"
              spellCheck={false}
              onChange={(e) => setConfig({ ...config, searchBaseUrl: e.target.value || null })}
            />
            <p>
              检索走 Anthropic 兼容的 Messages 端点（<code>/messages</code>），由服务端工具执行搜索，
              与会话端点相互独立；共用同一个 API Key，不需要再配一把密钥。留空使用默认地址。
            </p>
          </div>

          <div className="field-row grid-2">
            <div className="field">
              <label htmlFor={searchModelId}>检索模型</label>
              <input
                id={searchModelId}
                value={config.searchModel ?? ""}
                placeholder="deepseek-v4-flash"
                spellCheck={false}
                onChange={(e) => setConfig({ ...config, searchModel: e.target.value || null })}
              />
              <p>留空使用默认检索模型。检索是一次独立的模型调用，会产生额外的 token 消耗。</p>
            </div>

            <div className="field">
              <label>默认开关</label>
              <label className="tool-button thinking-switch">
                <input
                  type="checkbox"
                  className="switch"
                  role="switch"
                  aria-label="默认开启联网检索"
                  checked={config.webSearch ?? false}
                  onChange={(e) => setConfig({ ...config, webSearch: e.target.checked })}
                />
                <span>提问时默认联网检索</span>
              </label>
              <p>输入框下方随时可以单独切换；这里只决定默认值。</p>
            </div>
          </div>

          <div className="field">
            <button type="button" className="btn" onClick={() => void onTestWebSearch()} disabled={busy}>
              测试联网检索
            </button>
            <p>用一次极小的检索验证端点与密钥。检索失败不影响普通对话，只是那次回答不会带上来源。</p>
          </div>

          {searchFeedback && (
            <p className={searchFeedback.ok ? "inline-feedback" : "field-error"} role="status">
              {searchFeedback.text}
            </p>
          )}

          <p className="hint">
            「深度思考」在输入框下方随时切换——它是提问前那一刻才决定的事，
            这里不再重复放一个开关。开启后更慢、更严谨，这时建议把长度上限留空：
            填得太小会在推理中途被截断，回答只剩半截。
            开启后模型的思考过程会以可折叠的一段显示在回答上方；它随消息保存，
            但不会进入下一轮请求。
          </p>

          <div className="privacy-note">
            <Icon name="shield" />
            <span>
              知识图与全部对话记录都保存在本机。发送问题时，只有当前知识点、它的笔记和本对话历史会传给
              DeepSeek；其它对话、整张知识图和其它节点的笔记不会发送。
              开启「联网」后，模型可以自己决定是否调用检索工具，检索词会发给 DeepSeek 的服务端搜索，
              返回的来源作为**不可信资料**回灌给模型——网页内容可能包含误导性指令，不会被当成你的要求执行。
              思考与检索的过程记录只保存在本机，不会随下一轮请求发出去。
            </span>
          </div>

          {feedback?.ok && (
            <p className="inline-feedback" role="status">
              {feedback.text}
            </p>
          )}
          {feedback && !feedback.ok && (
            <p className="field-error" role="alert">
              {feedback.text}
            </p>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
