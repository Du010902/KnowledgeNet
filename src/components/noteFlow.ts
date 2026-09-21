/**
 * 笔记的读写流程（与 React 无关，可单独测试）
 *
 * 把这些规则集中在这里，而不是散在组件的 effect 里，原因是它们都属于
 * 「一旦写错就会丢内容」的那一类：
 *
 * 1. **冲突时绝不自动覆盖**：`save()` 只有在调用方明确传 `force: true` 时才覆盖，
 *    而 `force` 只可能来自用户在冲突界面里的一次点击；
 * 2. **进入节点时按需读取**：正文不在知识图里，`open()` 才去读 `note.md`；
 * 3. **外部改动**：没有未保存草稿就自动采用磁盘版本；有草稿就进入冲突，两边都不动。
 *
 * 组件只负责渲染 `NoteFlowState` 和把用户的选择转成方法调用。
 */
import type {
  NodeNote,
  NoteConflict,
  NoteDiskState,
  WriteNoteOutcome,
} from "@/data/types";
import { toRepositoryError } from "@/data/errors";

export interface NoteFlowDeps {
  read(nodeId: string): Promise<NodeNote>;
  write(
    nodeId: string,
    content: string,
    expectedDocumentRevision: number,
    force?: boolean,
  ): Promise<WriteNoteOutcome>;
  check(nodeId: string): Promise<NoteDiskState>;
  /** 只读知识库 / 有独占操作时为 false：此时不发出写入 */
  canWrite(): boolean;
}

export interface NoteFlowState {
  nodeId: string;
  status: "loading" | "ready" | "error";
  note: NodeNote | null;
  /** 编辑框里的内容 */
  draft: string;
  /** 已经成功落盘的那份内容：判断「有没有未保存草稿」只认它 */
  saved: string;
  error: string | null;
  conflict: { detail: NoteConflict; copy: string | null } | null;
}

/** 一次保存的结果。`conflict` 是**正常返回**：它不是失败，而是「请你决定」 */
export type SaveOutcome = "saved" | "conflict" | "error" | "readonly" | "skipped";

export class NoteFlow {
  #state: NoteFlowState = {
    nodeId: "",
    status: "loading",
    note: null,
    draft: "",
    saved: "",
    error: null,
    conflict: null,
  };

  /** 状态变化回调：组件用它把界面同步过来 */
  onChange: ((state: NoteFlowState) => void) | null = null;

  constructor(private readonly deps: NoteFlowDeps) {}

  get state(): NoteFlowState {
    return this.#state;
  }

  /** 有未保存草稿 */
  get dirty(): boolean {
    return this.#state.note !== null && this.#state.draft !== this.#state.saved;
  }

  /** 处于冲突中：自动保存必须停下，等用户决定 */
  get blocked(): boolean {
    return this.#state.conflict !== null;
  }

  #set(patch: Partial<NoteFlowState>): void {
    this.#state = { ...this.#state, ...patch };
    this.onChange?.(this.#state);
  }

  /** 进入一个节点：按需读取它的正文，旧草稿一并作废 */
  async open(nodeId: string): Promise<void> {
    this.#set({
      nodeId,
      status: "loading",
      note: null,
      draft: "",
      saved: "",
      error: null,
      conflict: null,
    });
    try {
      const note = await this.deps.read(nodeId);
      // 读取期间可能又切了节点：晚到的内容不能写进新节点的编辑器
      if (this.#state.nodeId !== nodeId) return;
      this.#set({
        status: "ready",
        note,
        draft: note.content,
        saved: note.content,
        error: null,
        conflict: null,
      });
    } catch (err) {
      if (this.#state.nodeId !== nodeId) return;
      this.#set({ status: "error", error: toRepositoryError(err).message });
    }
  }

  setDraft(text: string): void {
    this.#set({ draft: text });
  }

  /**
   * 保存当前草稿。
   *
   * `force` 只应当由「覆盖保存 / 另存冲突副本」这两个用户选择传入；
   * 其余路径（防抖自动保存、失焦保存）都必须走默认的 false，
   * 让数据层用修订号与哈希拦住过期写入。
   */
  async save(options: { force?: boolean } = {}): Promise<SaveOutcome> {
    const { note, draft, nodeId } = this.#state;
    if (!note || !nodeId) return "skipped";
    if (!this.deps.canWrite()) {
      this.#set({ error: "只读知识库不能保存笔记。" });
      return "readonly";
    }
    /*
     * 冲突没解决之前，自动保存（force 为假）一律停下。
     * 否则用户每敲一个字都会再撞一次同样的冲突，而磁盘上的版本始终不动。
     */
    if (!options.force && this.blocked) return "conflict";
    if (!options.force && draft === this.#state.saved) return "skipped";

    try {
      const outcome = await this.deps.write(nodeId, draft, note.documentRevision, options.force ?? false);
      if (this.#state.nodeId !== nodeId) return "skipped";
      if (outcome.status === "conflict") {
        // 冲突：停下来让用户决定，绝不覆盖
        this.#set({ conflict: { detail: outcome.conflict, copy: outcome.conflictCopy }, error: null });
        return "conflict";
      }
      this.#set({
        note: outcome.note,
        saved: draft,
        conflict: null,
        error: null,
      });
      return "saved";
    } catch (err) {
      const e = toRepositoryError(err);
      if (e.code === "note_conflict") {
        // 数据层也可能把冲突当错误抛出来：同样必须让用户决定，
        // 而不是把它当成「保存失败」把草稿丢掉
        await this.refreshConflictDetail();
        this.#set({ error: "磁盘上的笔记已经被改动：请选择如何处理。" });
        return "conflict";
      }
      this.#set({ error: e.message });
      return "error";
    }
  }

  /**
   * 检查磁盘上的 `note.md` 是否被外部改动。
   *
   * 没有草稿：自动采用磁盘上的版本（用户不需要知道发生了什么）；
   * 有草稿：进入冲突，两边都不动。
   */
  async checkExternal(): Promise<"unchanged" | "reloaded" | "conflict"> {
    const { note, nodeId } = this.#state;
    if (!note || !nodeId || this.blocked) return "unchanged";
    let disk: NoteDiskState;
    try {
      disk = await this.deps.check(nodeId);
    } catch {
      // 检查只是提示性的：失败不打扰用户，真正的判定在保存时
      return "unchanged";
    }
    if (this.#state.nodeId !== nodeId) return "unchanged";
    const changed =
      disk.changedOnDisk ||
      disk.documentRevision !== note.documentRevision ||
      disk.sha256 !== note.sha256;
    if (!changed) return "unchanged";

    if (!this.dirty) {
      const reloaded = await this.deps.read(nodeId);
      if (this.#state.nodeId !== nodeId) return "unchanged";
      this.#set({
        status: "ready",
        note: reloaded,
        draft: reloaded.content,
        saved: reloaded.content,
        conflict: null,
        error: null,
      });
      return "reloaded";
    }

    this.#set({ conflict: { detail: conflictFromDisk(nodeId, note, disk), copy: null } });
    return "conflict";
  }

  /** 从数据层再读一次冲突详情（note_conflict 走异常路径时用） */
  async refreshConflictDetail(): Promise<void> {
    const { note, nodeId } = this.#state;
    if (!note || !nodeId) return;
    try {
      const disk = await this.deps.check(nodeId);
      if (this.#state.nodeId !== nodeId) return;
      this.#set({ conflict: { detail: conflictFromDisk(nodeId, note, disk), copy: null } });
    } catch {
      this.#set({
        conflict: {
          detail: {
            disk: note,
            expectedRevision: note.documentRevision,
            reason: "revision_mismatch",
            detail: "磁盘上的笔记已经被改动。",
          },
          copy: null,
        },
      });
    }
  }

  /** 用户选择：重新加载（丢弃草稿，采用磁盘版本） */
  async reloadFromDisk(): Promise<void> {
    const nodeId = this.#state.nodeId;
    if (!nodeId) return;
    this.#set({ conflict: null });
    await this.open(nodeId);
  }

  /** 用户选择：覆盖保存（磁盘上原来那一份由数据层另存为冲突副本） */
  async overwrite(): Promise<SaveOutcome> {
    this.#set({ conflict: null });
    return this.save({ force: true });
  }

  /** 用户选择：把你的版本写进去，同时保留磁盘上原来的那一份 */
  async saveAsConflictCopy(): Promise<SaveOutcome> {
    this.#set({ conflict: null });
    return this.save({ force: true });
  }
}

/** 用磁盘状态拼一条冲突说明：修订号、哈希都对得上才叫「没变」 */
function conflictFromDisk(nodeId: string, note: NodeNote, disk: NoteDiskState): NoteConflict {
  return {
    disk: {
      nodeId,
      // v2 的笔记带自己的相对路径；磁盘状态里没有就沿用当前这份笔记的
      relativePath: note.relativePath,
      content: "",
      documentRevision: disk.documentRevision,
      sha256: disk.sha256,
      byteLength: disk.byteLength,
      modifiedAt: disk.modifiedAt,
    },
    expectedRevision: note.documentRevision,
    reason: disk.exists ? "hash_mismatch" : "disk_missing",
    detail: disk.exists
      ? "磁盘上的笔记与登记不一致（可能被外部编辑器改过）。"
      : "磁盘上的笔记文件不存在了（可能被移走或删除）。",
  };
}
