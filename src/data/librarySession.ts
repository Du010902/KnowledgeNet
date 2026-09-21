/**
 * 会话对象（`LibrarySession` 的实现）
 *
 * 为什么要单独一个模块：控制器（桌面/演示）负责创建它，注册表（`session.ts`）负责管理它，
 * 两个存储适配器要在每次调用前后检查它是否仍然有效。三者互相引用会形成循环导入，
 * 因此把「会话本体」放在这里，其他模块只依赖它。
 *
 * 关键规则：`close()` 的第一件事是**同步**把自己标记为失效。
 * 切换知识库时旧库的异步响应可能晚到，只有同步失效才能保证那些响应在恢复执行的第一步
 * 就抛 `session_closed`，而不是把旧库的数据写进新库的界面。
 */
import { RepositoryError, sessionClosedError, toRepositoryError } from "./errors.ts";
import type { LibrarySession, Repository } from "./repository.ts";
import type { LibraryInfo } from "./types.ts";

/**
 * 存储适配器眼中的会话。
 *
 * 适配器只依赖这个接口：它既能判断「这次调用还该不该返回」，也能把写入后的
 * 修订号回填给会话摘要，而完全不需要知道全局注册表的存在。
 */
export interface RepositorySession {
  readonly sessionId: string;
  readonly libraryId: string;
  readonly valid: boolean;
  readonly readOnly: boolean;
  /** 目前的扫描代次（打开时的值 + 各命令返回值）：图快照的 `revision` 就是它 */
  readonly revision: number;
  /** 会话摘要；`revision` 之外的字段是打开时的快照，可由扫描结果更新 */
  readonly info: LibraryInfo;
  /** 用命令返回的修订号更新会话（运行期以返回值为准） */
  setRevision(revision: number): void;
  /** 用最新扫描结果更新摘要里的计数（节点数、问题数、扫描耗时…） */
  setInfo(patch: Partial<LibraryInfo>): void;
  /** 会话已关闭时抛 `session_closed` */
  assertOpen(): void;
  /** 会话已关闭或只读时抛错：写入口必须先被挡住，而不是等后端报错 */
  assertWritable(): void;
}

export interface ManagedSessionOptions {
  sessionId: string;
  info: LibraryInfo;
  /**
   * 适配器工厂。必须是工厂而不是现成实例：Repository 要绑定会话才能判断有效性，
   * 而会话又要持有 Repository，直接互传会陷入「先有鸡还是先有蛋」。
   */
  createRepository: (session: RepositorySession) => Repository;
  /**
   * 释放后端资源：桌面端走 `close_library`（checkpoint + 解锁），
   * 演示端只需要丢掉引用。抛错不应让会话重新变回有效。
   */
  onClose?: () => Promise<void>;
}

/**
 * 一次打开的知识库会话。
 *
 * 组件不得长期缓存 `repository`：切库后旧会话会被关闭，之后所有调用都应失败。
 */
export class ManagedLibrarySession implements RepositorySession, LibrarySession {
  readonly sessionId: string;
  readonly repository: Repository;

  #info: LibraryInfo;
  #revision: number;
  #valid = true;
  #closePromise: Promise<void> | null = null;
  #onClose: (() => Promise<void>) | undefined;

  constructor(options: ManagedSessionOptions) {
    this.sessionId = options.sessionId;
    this.#info = options.info;
    this.#revision = 0;
    this.repository = options.createRepository(this);
    this.#onClose = options.onClose;
  }

  get libraryId(): string {
    return this.#info.libraryId;
  }

  get info(): LibraryInfo {
    return { ...this.#info };
  }

  get valid(): boolean {
    return this.#valid;
  }

  get readOnly(): boolean {
    return this.#info.readOnly;
  }

  get revision(): number {
    return this.#revision;
  }

  setRevision(revision: number): void {
    if (!Number.isFinite(revision) || revision < 0) return;
    this.#revision = Math.trunc(revision);
  }

  /** 扫描之后刷新摘要里的计数：界面上「多少个节点/多少条问题」必须跟着变 */
  setInfo(patch: Partial<LibraryInfo>): void {
    this.#info = { ...this.#info, ...patch };
  }

  /** 只读打开时拒绝一切写操作，错误码是界面分支要用的 `read_only` */
  assertOpen(): void {
    if (!this.#valid) throw sessionClosedError();
  }

  assertWritable(): void {
    this.assertOpen();
    if (this.#info.readOnly) {
      throw new RepositoryError(
        "read_only",
        "知识库以只读方式打开：请关闭其它实例的写锁或换用可写位置后重新打开",
      );
    }
  }

  /** 同步失效（切库、关库、被新会话替换时调用），不等后端释放资源 */
  invalidate(): void {
    this.#valid = false;
  }

  async close(): Promise<void> {
    // 先失效再释放：释放是异步的，期间旧库的响应必须已经被拒绝
    this.#valid = false;
    if (!this.#closePromise) {
      const onClose = this.#onClose;
      this.#onClose = undefined;
      this.#closePromise = (async () => {
        if (onClose) await onClose();
      })().catch((error: unknown) => {
        throw toRepositoryError(error);
      });
    }
    return this.#closePromise;
  }
}

export function createManagedSession(options: ManagedSessionOptions): ManagedLibrarySession {
  return new ManagedLibrarySession(options);
}
