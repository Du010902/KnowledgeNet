/**
 * 选中文字 → 建立前置知识节点
 *
 * 这是整个应用最关键的交互：读到不明白的概念时，选中它、点一下，就完成了记录。
 * 不需要切到输入框再手打一遍，也不需要先想清楚它在知识图里的位置。
 *
 * 三个必须守住的细节：
 * 1. 选区在按下菜单按钮前就可能被浏览器清掉，因此必须在 mouseup 的瞬间就保存
 *    选中的文字与位置。
 * 2. 建立关系时用的是「当前对话所属节点」的 id，而不是点菜单时的全局 selectedId，
 *    否则用户中途切换节点会连错边。
 * 3. 失败必须报出来：这是「建依赖 + 记来源 + 存书签」的复合动作，
 *    静默吞掉异常会让人以为已经记下了。
 */
import { useCallback, useEffect, useState } from "react";

import { selectionToTitle } from "@/data/chatTypes";
import { chatApi, graphSnapshot, useWorkspace, workspaceApi } from "./workspace/bridge";
import { Icon } from "./icons";

interface PendingSelection {
  /** 原始选中文字 */
  raw: string;
  /** 整理后的节点标题 */
  title: string;
  /** 选区中心的屏幕坐标，用于摆放浮动菜单 */
  x: number;
  y: number;
  /** 选区在滚动容器内的位置，用于返回时恢复阅读位置 */
  containerY: number;
  /** 选区所在的消息 ID：有了它才能精确回到「这段回答」 */
  messageId: string | null;
  /** 选区内侧空间不够时把菜单放到选区下方，避免被窗口顶边裁掉 */
  place: "above" | "below";
}

/** 超过这个长度就不适合直接当标题，只截取前面的短句 */
const MAX_DIRECT_TITLE = 30;
/** 菜单贴边的安全距离：半个菜单宽度，避免在窗口左右边缘被裁掉 */
const EDGE = 158;

/**
 * 找出选区所在的那条消息。
 *
 * 只靠滚动偏移返回原处是不够的：消息增减、窗口大小变化都会让偏移失准，
 * 记下真正的消息 ID 才能稳定定位。
 */
function messageIdOf(node: Node | null): string | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null;
}

export function SelectionMenu({
  nodeId,
  threadId,
  containerRef,
}: {
  nodeId: string;
  threadId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  /*
   * 只读知识库：三个动作全都是写入（建依赖 / 存书签 / 建节点），
   * 因此整张菜单禁用并说明原因——比让人点完才发现没存下来好。
   */
  const writable = useWorkspace((s) => s.canWrite());
  const blockedReason = useWorkspace((s) =>
    s.libraryState === "readonly"
      ? "这是只读知识库：没有取得写锁，或知识库版本高于本应用。"
      : "正在检查/修复知识库，记录入口暂时禁用。",
  );

  /* --------------------------- 捕获选区 --------------------------- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const capture = () => {
      // 延后一拍，等浏览器结算完选区
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          setPending(null);
          return;
        }
        const raw = sel.toString().trim();
        if (raw.length < 2) {
          setPending(null);
          return;
        }
        const range = sel.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) {
          setPending(null);
          return;
        }

        const rect = range.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const above = rect.top > 160;
        setPending({
          raw,
          title: selectionToTitle(raw),
          x: Math.min(Math.max(rect.left + rect.width / 2, EDGE), window.innerWidth - EDGE),
          y: above ? rect.top - 10 : rect.bottom + 12,
          containerY: rect.top - containerRect.top + container.scrollTop,
          messageId: messageIdOf(range.commonAncestorContainer),
          place: above ? "above" : "below",
        });
      }, 0);
    };

    // 只在消息区域内监听，不干扰其它地方的文本选择
    container.addEventListener("mouseup", capture);
    return () => container.removeEventListener("mouseup", capture);
  }, [containerRef]);

  // 滚动或按 Esc 收起菜单
  useEffect(() => {
    if (!pending) return;
    const container = containerRef.current;
    const dismiss = () => setPending(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    container?.addEventListener("scroll", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      container?.removeEventListener("scroll", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [pending, containerRef]);

  /* --------------------------- 执行创建 --------------------------- */

  const addAsPrerequisite = useCallback(
    async (selection: PendingSelection): Promise<string | null> => {
      const title = selection.title || selection.raw.slice(0, MAX_DIRECT_TITLE);

      /*
       * 交给引擎决定「复用还是新建」，并使用它返回的真实目标节点。
       * 早先这里按标题在组件里再查一遍：引擎是按标题**和别名**复用的，
       * 别名命中的节点按标题查不到，于是返回 null —— 依赖边其实已经建好了，
       * 但来源没记录、书签没保存、「设为前置并进入」也进不去。
       */
      const payload = await workspaceApi().addPrerequisites(nodeId, [title]);
      // 失败或形成循环依赖时整体没有落地：不再记录来源，也不跳转
      if (!payload) return null;

      const target = payload.reused[0] ?? payload.created[0];
      if (!target) return null;

      const edge = graphSnapshot().edges.find((e) => e.fromId === nodeId && e.toId === target.id);
      if (!edge) {
        // 没有真实的依赖边就谈不上「来源」：宁可不记，也不留一条指向空处的记录
        workspaceApi().notify("warn", `没能为「${target.title}」建立依赖关系，来源未记录`);
        return null;
      }

      // 来源与书签都要写库：写失败不能当成功，否则使用者以为记下了、其实没有
      try {
        /*
         * 来源挂在依赖边上（v2 写进发起方的 relations.json）：
         * 同一个前置知识被不同节点依赖时，两处卡住的原因可能不同。
         */
        await chatApi().addEvidence({
          fromNodeId: nodeId,
          edgeId: edge.id,
          snippet: selection.raw,
          question: "",
          threadId,
          messageId: selection.messageId,
        });

        // 记下「从对话的哪个位置跳走的」，返回时能回到原处
        await chatApi().saveBookmark({
          nodeId,
          threadId: threadId ?? "",
          messageId: selection.messageId ?? "",
          scrollOffset: selection.containerY,
          question: `读到「${title}」时卡住`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[KnowledgeNet] 记录来源失败", err);
        workspaceApi().notify("error", `依赖已建立，但来源/书签没有保存成功：${message}`);
        // 依赖边确实建好了：仍然把目标交出去，「设为前置并进入」还能用
        return target.id;
      }

      workspaceApi().notify(
        "success",
        payload.reused.length > 0
          ? `已复用「${target.title}」并建立依赖，来源已记录`
          : `已建立前置知识「${target.title}」，来源已记录`,
      );
      return target.id;
    },
    [nodeId, threadId],
  );

  if (!pending) return null;

  const truncated = (pending.title || pending.raw).length > MAX_DIRECT_TITLE;

  return (
    <div
      className={`selection-menu ${pending.place === "below" ? "below" : ""}`}
      style={{ left: pending.x, top: pending.y }}
      role="menu"
      aria-label="选中的文字"
      // 防止按下按钮时选区消失，也避免触发消息区的 mouseup
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="selection-action primary"
        onClick={() => {
          const selection = pending;
          setPending(null);
          // 失败必须报出来：建依赖、记来源、存书签是一个复合动作，静默失败最误导人
          void addAsPrerequisite(selection).catch((err) => {
            workspaceApi().notify("error", `记录失败：${err instanceof Error ? err.message : String(err)}`);
          });
        }}
        disabled={!writable}
        title={writable ? "建立 A → B 依赖关系，并把这段话记为来源" : blockedReason}
      >
        <span className="selection-action-main">
          <Icon name="plus" />
          设为前置知识{truncated ? "（取短句）" : ""}
        </span>
        <span className="selection-action-sub" title={pending.raw}>
          {pending.raw}
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        className="selection-action"
        onClick={() => {
          // 只记下疑问、不建节点：先弄清楚，再决定要不要深入。
          // 保存成功才提示成功——写失败仍说「已记为疑问」正是要避免的那类谎报。
          const selection = pending;
          setPending(null);
          void chatApi().saveBookmark({
            nodeId,
            threadId: threadId ?? "",
            messageId: selection.messageId ?? "",
            scrollOffset: selection.containerY,
            question: selection.raw.slice(0, 200),
          })
            .then(() => workspaceApi().notify("info", "已记为待解决疑问，之后可从节点详情的「疑问与来源」回到这里"))
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error("[KnowledgeNet] 记录疑问失败", err);
              workspaceApi().notify("error", `记录疑问失败：${message}`);
            });
        }}
        disabled={!writable}
        title={writable ? "先不建立依赖，只记下这里有个疑问" : blockedReason}
      >
        <span className="selection-action-main">
          <Icon name="bookmark" />
          仅记为疑问
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        className="selection-action"
        onClick={() => {
          const selection = pending;
          setPending(null);
          void addAsPrerequisite(selection)
            .then((id) => {
              if (id) void workspaceApi().enterNode(id);
            })
            .catch((err) => {
              workspaceApi().notify("error", `记录失败：${err instanceof Error ? err.message : String(err)}`);
            });
        }}
        disabled={!writable}
        title={writable ? "建立依赖后立即深入这个知识点" : blockedReason}
      >
        <span className="selection-action-main">
          <Icon name="arrow-right" />
          设为前置并进入
        </span>
      </button>
    </div>
  );
}
