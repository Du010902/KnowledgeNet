/**
 * 对话输入区
 *
 * Enter 发送、Shift + Enter 换行。输入法组词期间两个都不做：
 * 中文输入法用回车确认候选词，此时提交会把还没写完的问题发出去。
 *
 * 生成中发送键变成停止键，而不是禁用：正在等的回答随时可能跑偏，
 * 停下来的入口必须在原地，不能让使用者去别处找。
 *
 * 「深度思考」开关放在这一排而不是设置弹窗里：它是提问前那一刻才决定的事
 * （这段内容要不要慢一点、严谨一点），跑到设置里切完再回来问答是多余的一趟。
 * 开关值直接读写 AI 配置，不在这里另存一份。
 *
 * 高度按《工作台 UI 审查与重构规范》§3：**默认一行，内容变高时自动长高**，
 * 到 132px 之后内部滚动。提示行也不再常驻占地方——只有真正需要「现在就知道」
 * 的那一条才显示（见下方 `hint`）。
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

import { getAiProvider, hasRealAi } from "@/data/aiProvider";
import { chatApi } from "./workspace/bridge";
import { isImeComposing } from "@/keyboard";
import { Icon } from "./icons";

/** 输入框自增长上限，与 `src/styles/tokens.css` 的 `--composer-max` 保持一致 */
const MAX_COMPOSER_HEIGHT = 132;

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  disabled,
  modelLabel,
  placeholder,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** 当前对话正在生成回答 */
  running: boolean;
  /** 没有可发送的对象（例如知识点已被删除） */
  disabled: boolean;
  modelLabel: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  /** 只改「深度思考」一项的动作；走 bridge 是为了不依赖状态层的具体实现 */
  const saveThinking = chatApi().setThinking;
  /** null = 这项设置读不出来（模拟服务返回默认配置时不会为 null，读失败才会），此时不渲染开关 */
  const [thinking, setThinkingValue] = useState<boolean | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  /*
   * 初值从配置里读。`modelLabel` 作为依赖：它变化意味着模型 / 服务地址被改过，
   * 那条路径上「思考模式」也可能一起被改（例如在设置弹窗里改过），这里要重新对齐。
   */
  useEffect(() => {
    let alive = true;
    void getAiProvider()
      .loadSettings()
      .then((s) => {
        if (alive) setThinkingValue(s.config.thinking);
      })
      .catch(() => {
        if (alive) setThinkingValue(null);
      });
    return () => {
      alive = false;
    };
  }, [modelLabel]);

  /*
   * 浏览器开发模式用的是内置模拟服务，它不保存配置（saveConfig 是空实现）——
   * 在那里让开关"看起来能点"就是在骗人。显示但禁用，并说明去哪儿才能真的切。
   */
  const switchDisabled = !hasRealAi() || thinking === null;

  /*
   * 自增长：先清掉上一次的行内高度，再按 scrollHeight 收缩到上限。
   * 用 `useLayoutEffect` 是因为它要在浏览器绘制前完成——晚一帧会看到输入框先跳一下。
   * 清空 value 之后（发送完）也要跑一遍，输入框才会缩回一行。
   */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [value, textareaRef]);

  const toggleThinking = async () => {
    if (thinking === null || switchDisabled) return;
    const next = !thinking;
    setSwitchError(null);
    // 先动界面：开关要立刻跟手；失败了再翻回去，并说明原因
    setThinkingValue(next);
    try {
      await saveThinking(next);
    } catch (err) {
      setThinkingValue(!next);
      setSwitchError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        {/* 文本与发送键同一行（参考图 .composer-row）：视线不用在输入框与按钮之间跳 */}
        <div className="composer-row">
          <textarea
            ref={textareaRef}
            rows={1}
            aria-label="向 AI 提问"
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // 输入法用回车确认候选词时不能发送，否则半截问题就被发出去了
              if (isImeComposing(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          <button
            type="button"
            className="send-btn"
            aria-label={running ? "停止生成" : "发送问题"}
            title={running ? "停止生成（已经生成的内容会保留）" : "发送（Enter）"}
            onClick={running ? onStop : onSend}
            disabled={!running && (disabled || value.trim().length === 0)}
          >
            <Icon name={running ? "square" : "arrow-up"} />
          </button>
        </div>

        {/*
          工具行（参考图 .composer-tools）：模型、深度思考、快捷键都在这一行。
          快捷键不再单独占一行——输入区因此薄了一层，正文多出一行的呼吸空间。
        */}
        <div className="composer-tools">
          <span className="tool-button model-label" title="当前回答由哪个模型产生">
            <Icon name="sparkles" />
            {modelLabel}
          </span>

          {thinking !== null && (
            <label
              className="tool-button thinking-switch"
              title={
                switchDisabled
                  ? "浏览器开发模式用的是内置模拟服务，不保存这项设置；桌面版里可以切换"
                  : "开启后回答更严谨但更慢；适合推导与复杂问题"
              }
            >
              <input
                type="checkbox"
                className="switch"
                role="switch"
                aria-label="深度思考"
                checked={thinking}
                disabled={switchDisabled}
                onChange={() => void toggleThinking()}
              />
              <span>深度思考</span>
            </label>
          )}

          {/*
           * 提示只在真的需要时出现：正在生成时说明「可以随时停」，
           * 其余时候只说一条最容易被忘掉的快捷键。
           *
           * 两段文案是两个元素：窄屏要隐藏常驻的快捷键提示（验收清单 P2-2），
           * 但「生成中，可停止」必须留着——那是唯一说明发送键此刻是停止键的地方。
           */}
          {running ? (
            <span className="composer-status">生成中，可停止</span>
          ) : (
            <span className="composer-shortcut">Enter 发送 · Shift + Enter 换行</span>
          )}
        </div>
      </div>
      {switchError && (
        <p className="field-error" role="alert">
          切换深度思考失败：{switchError}
        </p>
      )}
    </div>
  );
}
