/**
 * 原生对话框外壳
 *
 * 用 `<dialog>` + `showModal()` 而不是自绘遮罩，换来的是浏览器已经做好的几件事：
 * Esc 关闭、焦点困在弹窗内、关闭后焦点回到原触发元素、背后内容对屏幕阅读器隐藏。
 * 这几条自己实现都容易漏，而它们恰好是「键盘走到一半就丢了」的根源。
 *
 * 组件按「挂载即打开、卸载即关闭」使用（与其他组件的 `x && <Dialog/>` 写法一致）。
 */
import { useEffect, useRef } from "react";

import { Icon } from "./icons";

export function Dialog({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide = false,
  className,
}: {
  title: string;
  /** 标题下的一行说明，用来说明这次操作用来做什么 */
  subtitle?: string;
  children: React.ReactNode;
  /** 底部按钮区；不传则不渲染底栏 */
  footer?: React.ReactNode;
  onClose: () => void;
  /** 更宽的弹窗（设置、合并这类内容较多的） */
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 已经有别的弹窗以模态打开时直接 showModal 会抛错；先收起来再打开。
    if (el.open) el.close();
    el.showModal();
    return () => {
      if (el.open) el.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={className ? `dialog ${className}` : "dialog"}
      data-width={wide ? "wide" : undefined}
      aria-label={title}
      /*
       * 只有「确实关上了」才通知父组件。
       *
       * React 开发模式的 StrictMode 会把新挂载的 effect 跑成 setup → cleanup → setup：
       * cleanup 里的 close() 按规范把 close 事件排成宏任务，等它派发时弹窗已经被
       * 第二次 showModal() 重新打开。不看这个状态就回调，弹窗会在打开的瞬间被卸载
       * （开发模式下点「设置」一闪而过，生产构建反而看不出来）。
       */
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      /* 点遮罩关闭：点在 dialog 元素自身上、且落在内容盒之外 */
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const outside =
          e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (outside) e.currentTarget.close();
      }}
    >
      <div className="dialog-head">
        <div className="dialog-head-text">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭"
          onClick={() => ref.current?.close()}
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="dialog-body">{children}</div>

      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}
