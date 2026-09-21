/**
 * 应用外壳
 *
 * 只剩四件事：**窗口栏 + 库状态条 + 工作台 + 提示层**。
 * 布局本身（顶栏、活动栏、三个模式、各种抽屉与面板）全部归 `WorkspaceShell`，
 * 这里不再认识「左栏 / 画布 / 右栏」这三栏——它们已经不存在了。
 *
 * 没有知识库时整页是库选择界面；打开中显示进度；打开失败给原因与重试。
 * 窗口栏在最外层：库选择页也要能拖动窗口（桌面版关掉了原生边框）。
 */
import { useCallback, useEffect } from "react";

import { Icon } from "@/components/icons";
import { LibraryPicker } from "@/components/LibraryPicker";
import { requestLibraryDialog } from "@/components/nodeContextMenu";
import { NOTICE_EVENT, WindowBar, type NoticeDetail } from "@/components/WindowBar";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";
import { useWorkspace, workspaceApi } from "@/components/workspace/bridge";

/**
 * 提示条。
 *
 * 成功与提醒自动消失，保存失败则常驻到下一次写入成功为止：
 * 「我刚改的东西到底存没存」不能一闪而过。
 *
 * 另外监听 `NOTICE_EVENT`：窗口栏这类「外壳之外」的组件不 import bridge
 * （那会把依赖方向反过来），它们要说话就走这条事件。
 */
function ToastLayer() {
  const notice = useWorkspace((s) => s.notice);
  const saveError = useWorkspace((s) => s.saveError);
  /** 稳定的引用：每次渲染新建一个函数会让下面的定时器反复重置，提示永远不消失 */
  const dismissNotice = useCallback(() => workspaceApi().dismissNotice(), []);

  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<NoticeDetail>).detail;
      if (detail?.text) workspaceApi().notify(detail.kind, detail.text);
    };
    window.addEventListener(NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(NOTICE_EVENT, onNotice);
  }, []);

  useEffect(() => {
    if (!notice) return;
    // 警告和错误停留更久：它们需要被读到
    const ms = notice.kind === "warn" || notice.kind === "error" ? 9000 : 4200;
    const timer = window.setTimeout(dismissNotice, ms);
    return () => window.clearTimeout(timer);
  }, [notice, dismissNotice]);

  return (
    <div className="toast-layer">
      {saveError && (
        <div className="toast error" role="alert">
          <Icon name="alert" />
          <span>{saveError}</span>
        </div>
      )}
      {notice && (
        <div
          className={`toast ${notice.kind}`}
          role="status"
          title="点击关闭"
          onClick={dismissNotice}
        >
          <Icon
            name={notice.kind === "success" ? "check" : notice.kind === "warn" ? "alert" : "info"}
          />
          <span>{notice.text}</span>
        </div>
      )}
    </div>
  );
}

/**
 * 知识库状态条。
 *
 * 只读、修复中、演示模式都必须「一眼看见」：它们改变的是「这次操作会落到哪里」，
 * 藏在弹窗里等于没说。
 */
function LibraryBanner() {
  const state = useWorkspace((s) => s.libraryState);
  const busy = useWorkspace((s) => s.busy);
  const isDemo = useWorkspace((s) => s.isDemo);
  const info = useWorkspace((s) => s.libraryInfo);

  const lines: string[] = [];
  if (state === "readonly") {
    lines.push(
      "只读模式：没有取得写锁（或知识库格式版本高于本应用），所有修改入口已禁用，可以查看与导出。",
    );
  }
  if (state === "repairing") {
    lines.push("正在检查/修复知识库：会与修复冲突的写操作已暂时禁用。");
  }
  if (busy) lines.push(busy);
  if (isDemo) {
    lines.push("演示模式，不是便携知识库：数据只存在浏览器里，不会落成可以拷走的文件夹。");
  }

  if (lines.length === 0) return null;

  const kind = state === "readonly" || isDemo ? "warn" : "info";
  return (
    <div className={`library-banner ${kind}`} role="status">
      <Icon name={kind === "warn" ? "alert" : "info"} />
      <div className="library-banner-text">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      {(state === "readonly" || state === "repairing") && (
        <button type="button" className="btn sm" onClick={requestLibraryDialog}>
          <Icon name="folder" />
          知识库详情
        </button>
      )}
      {isDemo && (
        <span className="library-banner-path" title={info?.rootPath}>
          {info?.rootPath}
        </span>
      )}
    </div>
  );
}

export default function App() {
  const libraryState = useWorkspace((s) => s.libraryState);
  const init = useWorkspace((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (libraryState === "none" || libraryState === "error" || libraryState === "opening") {
    return (
      <div className="app">
        <WindowBar />
        <LibraryPicker />
        {libraryState === "opening" && (
          <div className="boot boot-overlay" role="status">
            <div className="boot-inner">
              <div className="spinner" />
              <div>正在打开知识库…</div>
            </div>
          </div>
        )}
        <ToastLayer />
      </div>
    );
  }

  return (
    <div className="app">
      <WindowBar />
      <LibraryBanner />
      <WorkspaceShell />
      <ToastLayer />
    </div>
  );
}
