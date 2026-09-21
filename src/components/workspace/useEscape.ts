/**
 * Esc 的层叠处理
 *
 * 一层套一层的浮层（抽屉 → 检查器 → 命令面板，外加「最大化 pane 后 Esc 回到分屏」）
 * 如果各自往 window 上挂 keydown，一次 Esc 会同时命中多个处理器：
 * 命令面板关掉的同时检查器也关了，用户按一次撤了两步。
 *
 * 这里用一个栈来定序：只有最后打开的那一层响应 Esc。
 */
import { useEffect, useRef } from "react";

const stack: Array<() => void> = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (top) top();
}

function listen(active: boolean) {
  if (active && !listening) {
    window.addEventListener("keydown", onKeyDown);
    listening = true;
  } else if (!active && listening) {
    window.removeEventListener("keydown", onKeyDown);
    listening = false;
  }
}

/** `active` 为真时把 `handler` 压到栈顶；关闭后自动出栈 */
export function useEscape(active: boolean, handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!active) return;
    const entry = () => ref.current();
    stack.push(entry);
    listen(true);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      listen(stack.length > 0);
    };
  }, [active]);
}
