/**
 * 知识库选择界面（没有打开知识库时的整页界面）
 *
 * 便携知识库的核心承诺是「知识库就是用户自己的文件夹」，所以这一页要回答三件事：
 * 上次用的库在哪、怎么新建一个、怎么打开一个已有的文件夹。
 *
 * 三条不能含糊的地方：
 * 1. 失效路径要如实标出来，并且给「重新定位」而不是静默失败；
 * 2. 浏览器演示模式必须写明「演示模式，不是便携知识库」——数据不会变成可以拷走的文件夹；
 * 3. 新建时要选父目录并给出最终路径预览，避免用户以为「名称」就是完整位置。
 */
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons";
import { useWorkspace, workspaceApi } from "@/components/workspace/bridge";

/** 最后打开时间：同一天显示时刻，更早显示日期，一眼能认出「最近用的那个」 */
function formatOpenedAt(ms: number): string {
  if (!ms) return "从未打开";
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (sameDay) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function LibraryPicker() {
  const recent = useWorkspace((s) => s.recentLibraries);
  const recentError = useWorkspace((s) => s.recentError);
  const isDemo = useWorkspace((s) => s.isDemo);
  const libraryState = useWorkspace((s) => s.libraryState);
  const libraryError = useWorkspace((s) => s.libraryError);
  /*
   * 动作统一走 bridge：契约把「打开一个知识库」叫 `openLibraryAt`，
   * 旧实现叫 `openLibrary`，这里两种都能解析，选择界面不必跟着改名。
   */
  const openLibrary = (path: string, allowReadOnly?: boolean) =>
    workspaceApi().openLibrary(path, allowReadOnly);
  const openDemoLibrary = () => workspaceApi().openDemoLibrary();
  const createLibrary = (parentDir: string, name: string, title?: string) =>
    workspaceApi().createLibrary(parentDir, name, title);
  const removeRecentLibrary = (path: string) => workspaceApi().removeRecentLibrary(path);
  const pickDirectory = (title?: string) => workspaceApi().pickDirectory(title);
  const resetToPicker = () => workspaceApi().resetToPicker();
  const refreshRecent = () => workspaceApi().refreshRecent();

  const [creating, setCreating] = useState(false);
  const [parentDir, setParentDir] = useState("");
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) nameRef.current?.focus();
  }, [creating]);

  const busy = libraryState === "opening";

  const chooseParent = async () => {
    const picked = await pickDirectory("选择知识库要放的位置");
    if (picked) setParentDir(picked);
  };

  const submitCreate = () => {
    const clean = name.trim();
    if (!parentDir || !clean) return;
    void createLibrary(parentDir, clean, clean);
  };

  return (
    <div className="boot library-picker">
      <div className="picker-shell">
        <header className="picker-head">
          <span className="brand-mark">
            <Icon name="network" />
          </span>
          <div>
            <h1>KnowledgeNet</h1>
            <p>知识库就是你自己的文件夹：放在哪里、拷到哪里，由你决定。</p>
          </div>
        </header>

        {isDemo && (
          /*
           * 演示模式的说明放在最上面而不是角落里：整页的功能都建立在
           * 「数据存在用户自己的文件夹里」这个前提上，浏览器里做不到。
           */
          <div className="picker-demo" role="status">
            <Icon name="alert" />
            <div>
              <strong>演示模式，不是便携知识库。</strong>
              <p>
                当前运行在浏览器里，数据只存在浏览器存储中：关掉站点数据就会丢，
                也不能拷到 U 盘或另一台电脑。附件、创建副本、锁与完整性检查都不具备正式能力。
                要真正使用便携知识库，请用桌面版打开同一个文件夹。
              </p>
            </div>
          </div>
        )}

        {libraryState === "error" && libraryError && (
          <div className="picker-error" role="alert">
            <Icon name="alert" />
            <div>
              <strong>打开知识库失败</strong>
              <p>{libraryError}</p>
              <button type="button" className="btn" onClick={resetToPicker}>
                重新选择
              </button>
            </div>
          </div>
        )}

        <section className="picker-block">
          <div className="picker-block-head">
            <h2>最近打开</h2>
            <button type="button" className="btn sm" disabled={busy} onClick={() => void refreshRecent()}>
              <Icon name="refresh" />
              刷新
            </button>
          </div>

          {recentError && <p className="field-error">{recentError}</p>}
          {recent.length === 0 && !recentError && (
            <p className="empty-text">
              这里还没有记录。新建一个知识库，或者打开一个已有的知识库文件夹。
            </p>
          )}

          <ul className="recent-list">
            {recent.map((item) => (
              <li key={item.path} className={item.missing ? "recent is-missing" : "recent"}>
                <button
                  type="button"
                  className="recent-main"
                  disabled={busy}
                  title={item.missing ? `${item.path}（路径已失效）` : item.path}
                  onClick={() => void openLibrary(item.path)}
                >
                  <span className="recent-title">
                    {item.title || "（没有标题）"}
                    {item.missing && <span className="pill is-warn">路径失效</span>}
                  </span>
                  <span className="recent-path">{item.path}</span>
                  <span className="recent-meta">
                    {item.missing
                      ? "找不到这个文件夹了：它可能被移动、改名或所在磁盘没有接入 · "
                      : ""}
                    最后打开：{formatOpenedAt(item.lastOpenedAt)}
                  </span>
                </button>
                <div className="recent-actions">
                  {item.missing && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="重新定位：用文件夹选择器找到它现在的位置"
                      aria-label={`重新定位「${item.title}」`}
                      disabled={busy}
                      onClick={async () => {
                        const picked = await pickDirectory("找到这个知识库现在的位置");
                        if (!picked) return;
                        const ok = await openLibrary(picked);
                        if (ok) void removeRecentLibrary(item.path);
                      }}
                    >
                      <Icon name="search" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    title="从最近列表移除（不会删除知识库本身）"
                    aria-label={`从最近列表移除「${item.title}」`}
                    disabled={busy}
                    onClick={() => void removeRecentLibrary(item.path)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="picker-block">
          <h2>新建知识库</h2>
          {!creating ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => setCreating(true)}>
              <Icon name="plus" />
              新建知识库
            </button>
          ) : (
            <div className="field">
              <div className="field-label">放在哪个文件夹下</div>
              <div className="field-row">
                <input
                  value={parentDir}
                  readOnly
                  placeholder={isDemo ? "演示模式不能选择文件夹" : "还没有选择位置"}
                  aria-label="知识库的父目录"
                />
                <button
                  type="button"
                  className="btn"
                  disabled={isDemo}
                  title={isDemo ? "演示模式没有真实目录选择器：请用桌面版新建知识库" : undefined}
                  onClick={() => void chooseParent()}
                >
                  <Icon name="folder" />
                  选择…
                </button>
              </div>
              <div className="field-label">知识库名称</div>
              <input
                ref={nameRef}
                value={name}
                placeholder="例如：数学与信号处理"
                aria-label="知识库名称"
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              {parentDir && name.trim() && (
                <p className="field-note">
                  会新建文件夹：{parentDir.replace(/[\\/]+$/, "")}\{name.trim()}
                </p>
              )}
              <div className="field-row">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !parentDir || name.trim() === ""}
                  onClick={submitCreate}
                >
                  <Icon name="check" />
                  新建
                </button>
                <button type="button" className="btn" onClick={() => setCreating(false)}>
                  取消
                </button>
              </div>
              <p className="field-note">
                目标文件夹已存在或非空时不会覆盖，会直接报错；新建完成后会自动打开它。
              </p>
              {isDemo && (
                /* 演示模式没有真实目录：说清楚「为什么这个按钮点不动」 */
                <p className="field-note">
                  演示模式不会真的新建文件夹：浏览器里没有可写的知识库目录，这一步需要桌面版。
                </p>
              )}
            </div>
          )}
        </section>

        <section className="picker-block">
          <h2>打开已有的知识库</h2>
          <div className="field-row">
            <button
              type="button"
              className="btn"
              disabled={busy || isDemo}
              title={
                isDemo ? "演示模式没有真实目录选择器：请用桌面版打开知识库文件夹" : undefined
              }
              onClick={async () => {
                const picked = await pickDirectory("选择知识库文件夹（含 library.json）");
                if (picked) void openLibrary(picked);
              }}
            >
              <Icon name="folder" />
              打开文件夹…
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || isDemo}
              title={
                isDemo
                  ? "演示模式没有真实目录选择器：请用桌面版打开知识库文件夹"
                  : "以只读方式打开：另一个实例正在写入时也能查看"
              }
              onClick={async () => {
                const picked = await pickDirectory("选择要只读打开的知识库");
                if (picked) void openLibrary(picked, true);
              }}
            >
              以只读方式打开…
            </button>
          </div>
          <p className="field-note">
            选择包含 <code>library.json</code> 的知识库根目录。放在 U 盘、云盘或另一台电脑上的库
            都可以直接打开：内部只记录相对路径。
          </p>
          {isDemo && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void openDemoLibrary()}
            >
              <Icon name="sparkles" />
              继续使用演示库（不是便携知识库）
            </button>
          )}
        </section>

        {busy && (
          <p className="picker-busy" role="status">
            <span className="spinner" />
            正在打开知识库…
          </p>
        )}
      </div>
    </div>
  );
}
