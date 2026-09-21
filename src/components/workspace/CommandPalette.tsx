/**
 * 命令面板（Ctrl/Cmd + Shift + P）
 *
 * 设计文档 §7.4 的分层原则：常驻按钮只留最高频的几个，其余低频命令全部收进这里，
 * 但**必须能被发现**——一个只能靠记快捷键打开的入口等于没有入口，
 * 所以顶栏右侧的「⋯」按钮与活动栏都指向它。
 *
 * 键盘优先：上下键选择、Enter 执行、Esc 关闭、输入即筛选，
 * 需要参数的命令（认领文件夹、新建学习目标）在面板内就地输入，不再弹一层窗。
 * `Ctrl/Cmd + K` 仍然是节点搜索，不归这里管。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "@/components/icons";
import { setThemeMode } from "@/theme";
import { isImeComposing } from "@/keyboard";
import {
  layoutApi,
  nodeHealth,
  useCurrentNode,
  useLayout,
  useWorkspace,
  workspaceApi,
  type WorkspaceMode,
} from "./bridge";
import { useWorkspaceCommands } from "./commands";
import { useEscape } from "./useEscape";

interface CommandPrompt {
  label: string;
  placeholder: string;
  initial?: string;
  submit: (value: string) => void | Promise<void>;
}

interface Command {
  id: string;
  title: string;
  group: string;
  detail?: string;
  /** 额外参与筛选的词：快捷键、别名、英文写法 */
  keywords?: string;
  disabled?: boolean;
  run?: () => void | Promise<void>;
  /** 需要参数时：先就地输入，再执行 */
  prompt?: CommandPrompt;
}

const MODE_LABEL: Record<WorkspaceMode, string> = {
  chat: "对话",
  split: "分屏",
  graph: "图谱",
};

/**
 * 命令分组 → 结果行的图标。
 *
 * 参考图的结果行是「图标 + 标题/说明 + 状态」三列；命令本身没有逐个配图标
 * （三十多条命令各配一个图标只会变成装饰），按分组给一个就够定位了。
 */
const GROUP_ICON: Record<string, IconName> = {
  工作区: "panel",
  节点: "network",
  知识库: "database",
  界面: "sliders",
};

export function CommandPalette() {
  const open = useLayout((s) => s.commandPaletteOpen);
  const mode = useLayout((s) => s.mode);
  const commands = useWorkspaceCommands();
  const node = useCurrentNode();
  const libraryState = useWorkspace((s) => s.libraryState);
  const readOnly = libraryState === "readonly";
  const writable = useWorkspace((s) => s.canWrite());
  const isDemo = useWorkspace((s) => s.isDemo);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<{ command: Command; value: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => {
    layoutApi().setCommandPaletteOpen(false);
    setQuery("");
    setPending(null);
    setActive(0);
  };
  useEscape(open, close);

  const health = nodeHealth(node);

  const items = useMemo<Command[]>(() => {
    const list: Command[] = [
      /* -------------------------------- 工作区 -------------------------------- */
      ...(["chat", "split", "graph"] as WorkspaceMode[]).map(
        (target): Command => ({
          id: `mode-${target}`,
          title: `切换到${MODE_LABEL[target]}模式`,
          group: "工作区",
          keywords: `mode ${target} workspace 布局`,
          disabled: mode === target,
          run: () => commands.setMode(target),
        }),
      ),
      {
        id: "split-reset",
        title: "恢复默认分屏比例",
        group: "工作区",
        detail: "图谱 42% · 对话 58%",
        keywords: "reset ratio 分隔条 双击",
        run: () => {
          layoutApi().resetRatio("horizontal");
          layoutApi().resetRatio("vertical");
        },
      },
      {
        id: "toggle-thread-list",
        title: "显示 / 收起对话列表",
        group: "工作区",
        keywords: "thread list 线程",
        run: () => layoutApi().setThreadListOpen(!layoutApi().threadListOpen),
      },
      {
        id: "toggle-nav-drawer",
        title: "显示 / 收起导航抽屉",
        group: "工作区",
        keywords: "drawer navigation 搜索 知识点",
        run: () => layoutApi().setNavDrawer(layoutApi().navDrawer ? null : "search"),
      },

      /* --------------------------------- 节点 --------------------------------- */
      {
        id: "inspector-detail",
        title: "打开节点检查器 · 详情",
        group: "节点",
        keywords: "inspector detail 元数据",
        disabled: !node,
        run: () => commands.openInspector("detail"),
      },
      {
        id: "inspector-notes",
        title: "打开节点检查器 · 笔记",
        group: "节点",
        keywords: "notes 主笔记 markdown",
        disabled: !node,
        run: () => commands.openInspector("notes"),
      },
      {
        id: "inspector-resources",
        title: "打开节点检查器 · 资料",
        group: "节点",
        keywords: "resources files url 附件",
        disabled: !node,
        run: () => commands.openInspector("resources"),
      },
      {
        id: "reload-node",
        title: "重新载入当前节点的元数据",
        group: "节点",
        detail: health.health === "ok" ? undefined : `当前：${health.relativePath || "元数据有问题"}`,
        keywords: "reload rescan node.json 外部改动",
        disabled: !node || !workspaceApi().supports("pullScan"),
        run: () => workspaceApi().pullScan(false),
      },
      {
        id: "open-node-folder",
        title: "在文件管理器里打开节点文件夹",
        group: "节点",
        keywords: "folder explorer reveal 文件夹",
        disabled: !node || !workspaceApi().supports("openNodeFolder"),
        run: () => (node ? workspaceApi().openNodeFolder(node.id) : undefined),
      },
      {
        id: "adopt-folder",
        title: "认领文件夹为知识点",
        group: "节点",
        detail: "给一个已有的普通文件夹加上节点身份（.meta/knowledgenet）",
        keywords: "adopt claim folder node 认领",
        disabled: !writable || !workspaceApi().supports("adoptFolder"),
        prompt: {
          label: "相对知识库根的路径",
          placeholder: "例如 Notes/线性代数（支持中文）",
          submit: async (value) => {
            await workspaceApi().adoptFolder(value.trim());
          },
        },
      },
      {
        id: "new-node",
        title: "新建知识点",
        group: "节点",
        detail: "建出来的是一个普通节点，和其他节点没有地位差别",
        keywords: "new node 新建 知识点 概念",
        disabled: !writable,
        prompt: {
          label: "要搞懂的问题",
          placeholder: "例如：反向传播",
          submit: async (value) => {
            await workspaceApi().createNode(value.trim());
          },
        },
      },

      /* -------------------------------- 知识库 -------------------------------- */
      {
        id: "library-dialog",
        title: "知识库信息 · 备份 · 完整性检查",
        group: "知识库",
        keywords: "library backup integrity 副本 回收站 迁移",
        run: () => commands.openLibrary(),
      },
      {
        id: "rescan",
        title: "重新扫描知识库",
        group: "知识库",
        detail: "按磁盘现状重建索引（不会改动任何用户文件）",
        keywords: "rescan scan refresh 扫描",
        disabled: !workspaceApi().supports("pullScan"),
        run: () => workspaceApi().pullScan(true),
      },
      {
        id: "close-library",
        title: "关闭当前知识库",
        group: "知识库",
        keywords: "close library 换库",
        run: () => workspaceApi().closeLibrary(),
      },

      /* --------------------------------- 界面 --------------------------------- */
      {
        id: "theme-light",
        title: "切换主题 · 浅色",
        group: "界面",
        keywords: "theme light 浅色",
        run: () => setThemeMode("light"),
      },
      {
        id: "theme-dark",
        title: "切换主题 · 深色",
        group: "界面",
        keywords: "theme dark 深色",
        run: () => setThemeMode("dark"),
      },
      {
        id: "theme-system",
        title: "切换主题 · 跟随系统",
        group: "界面",
        keywords: "theme system 跟随系统",
        run: () => setThemeMode("system"),
      },
      {
        id: "ai-settings",
        title: "AI 设置",
        group: "界面",
        detail: "API Key、模型、回答长度上限、思考模式",
        keywords: "ai deepseek api key model 设置",
        run: () => commands.openAiSettings(),
      },
      {
        id: "search-nodes",
        title: "搜索知识点",
        group: "界面",
        detail: "Ctrl / Cmd + K",
        keywords: "search find node 搜索 k",
        run: () => commands.focusSearch(),
      },
    ];
    return list;
  }, [commands, mode, node, health.health, health.relativePath, writable]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) =>
      `${c.title} ${c.group} ${c.detail ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [items, query]);

  // 筛选之后高亮项可能已经不在列表里：夹回有效范围
  useEffect(() => {
    setActive((index) => Math.min(Math.max(0, index), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    setPending(null);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 高亮项滚进可视区：键盘选到第 20 条时，它必须在屏幕上
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-command-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [active, filtered]);

  if (!open) return null;

  const runCommand = (command: Command) => {
    if (command.disabled) return;
    if (command.prompt) {
      setPending({ command, value: command.prompt.initial ?? "" });
      return;
    }
    if (command.run) void command.run();
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (pending) {
      if (e.key === "Enter") {
        e.preventDefault();
        const { command, value } = pending;
        const clean = value.trim();
        if (!clean) return;
        void command.prompt?.submit(clean);
        close();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPending(null);
        setQuery("");
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((index) =>
        filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
      );
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const command = filtered[active];
      if (command) runCommand(command);
    }
  };

  let lastGroup = "";

  return createPortal(
    <>
      <div className="palette-scrim" onClick={close} aria-hidden="true" />
      <div className="command-palette" data-command-palette role="dialog" aria-label="命令面板">
        <div className="command-input-row">
          <Icon name={pending ? "edit" : "search"} />
          <input
            ref={inputRef}
            className="command-input"
            value={pending ? pending.value : query}
            aria-label={pending ? pending.command.prompt?.label : "搜索命令"}
            placeholder={
              pending
                ? (pending.command.prompt?.placeholder ?? "输入内容后回车")
                : "输入命令名，或用上下键浏览…"
            }
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              if (pending) setPending({ ...pending, value: e.target.value });
              else {
                setQuery(e.target.value);
                setActive(0);
              }
            }}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>

        {pending && (
          <p className="command-prompt-hint">
            {pending.command.title} · {pending.command.prompt?.label} · 回车执行
          </p>
        )}

        {!pending && (
          <div className="command-list" ref={listRef} role="listbox" aria-label="可用命令">
            {filtered.length === 0 && (
              <p className="empty">没有匹配的命令。试试「主题」「扫描」或「设置」。</p>
            )}
            {filtered.map((command, index) => {
              const header = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              return (
                <div key={command.id}>
                  {header && <p className="command-group">{header}</p>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    aria-disabled={command.disabled}
                    data-command-id={command.id}
                    data-command-active={index === active ? "true" : undefined}
                    className={`command-item ${index === active ? "active" : ""} ${
                      command.disabled ? "disabled" : ""
                    }`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runCommand(command)}
                  >
                    {/* 三列：图标 / 标题+说明 / 状态（参考图 .search-result 的结构） */}
                    <span className="result-icon" aria-hidden="true">
                      <Icon name={GROUP_ICON[command.group] ?? "sparkles"} />
                    </span>
                    <span className="command-copy">
                      <span className="command-title">{command.title}</span>
                      {command.detail && <span className="command-detail">{command.detail}</span>}
                    </span>
                    <span className="command-status">{command.disabled ? "当前" : ""}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <footer className="command-foot">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
          {readOnly && <span className="is-warn">只读知识库：写入类命令已禁用</span>}
          {isDemo && <span className="is-warn">演示模式</span>}
        </footer>
      </div>
    </>,
    document.body,
  );
}
