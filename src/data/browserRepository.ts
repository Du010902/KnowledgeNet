/**
 * 浏览器演示后端（v2：内存文件系统上的虚拟知识库）
 *
 * 演示模式的存在意义是「不用装桌面版也能看清界面与交互」，因此它必须**诚实**：
 * - 数据只存在浏览器 localStorage（`MemoryVfs` 的序列化），清掉站点数据就没了；
 * - 文件类资料、系统打开、创建副本等真实文件系统能力明确抛 `unsupported_in_demo`，
 *   绝不假装成功；
 * - 但它跑的是**和桌面端同一套 v2 文件模型**：`library.json`、`node.json`、
 *   `relations.json`、`chats/<threadId>/messages/**` 都在虚拟磁盘上真实存在，
 *   扫描器、冲突保护、懒加载对话的行为与 Rust 端一致——这样演示模式才能当
 *   交互与语义的试验田，而不是一套「看起来像」的假数据。
 *
 * 注意：这里没有进程级 Repository 单例。共享的只有「演示知识库的存储」，
 * 每个打开会话拿到的仍是绑定自己会话的实例（切库后旧实例会抛 `session_closed`）。
 */
import { RepositoryError } from "./errors.ts";
import type { EdgeRelationSnapshot, Repository } from "./repository.ts";
import type { RepositorySession } from "./librarySession.ts";
import type { Bookmark, ChatMessage, ChatThread } from "./chatTypes.ts";
import type {
  AddPrerequisitesPayload,
  AddResult,
  DependencyEdge,
  Evidence,
  EvidenceInput,
  GraphSnapshot,
  IntegrityIssue,
  IntegrityReport,
  KnowledgeNode,
  LearnSession,
  LibraryInfo,
  MergePayload,
  MigrationReport,
  NewNodeInput,
  NodeBackup,
  NodeErasure,
  NodeFileEntry,
  NodeFolderUsage,
  NodeNote,
  NodePatch,
  NodeResource,
  NoteDiskState,
  RemovedIdentity,
  RepairAction,
  RepairReport,
  ResourcePatch,
  ScanReport,
  WriteNoteOutcome,
} from "./types.ts";
import { findCycleIfLinked, planMerge, planPrerequisites } from "./engine.ts";
import { newUuid } from "./uuid.ts";
import { MemoryVfs, copyTree, moveTree, removeTree, type Vfs } from "./v2/fs.ts";
import {
  BACKUPS_DIR,
  BOOKMARKS_FILE,
  GOALS_FILE,
  LIBRARY_FILE,
  META_DIR,
  META_NS_DIR,
  NODE_MARKER,
  ROOT_META_DIR,
  TRASH_NODE_METADATA_DIR,
  baseName,
  chatsDir,
  joinRel,
  nodeMetaFile,
  nsDir,
  parentRel,
} from "./v2/paths.ts";
import {
  emptyBookmarks,
  isoFromMs,
  newLibraryManifest,
  newNodeMeta,
  parseBookmarksFile,
  parseLibraryManifest,
  sanitizeFolderName,
  serializeJson,
  uniqueNameIn,
  type V2BookmarksFile,
  type V2LibraryManifest,
  type V2NodeMeta,
  type V2RelationsFile,
} from "./v2/schema.ts";
import { scanLibrary } from "./v2/scanner.ts";
import { readNodeMeta, writeNodeMeta } from "./v2/nodeMeta.ts";
import * as notes from "./v2/notes.ts";
import * as relations from "./v2/relations.ts";
import * as chats from "./v2/chats.ts";
import * as goalsApi from "./v2/goals.ts";
import { titleFromQuestion } from "./threadTitle.ts";
import * as resourcesApi from "./v2/resources.ts";

/** 演示后端的自我说明：界面必须原样显示「这不是便携知识库」 */
export const DEMO_BACKEND_LABEL = "浏览器演示后端（localStorage）：不是便携知识库";

/** 演示知识库整棵虚拟磁盘的存储键 */
export const DEMO_VFS_KEY = "knowledgenet.demo.library.v2";
/** 演示知识库的设备侧状态（上次所在节点）前缀 */
export const DEMO_SESSION_PREFIX = "knowledgenet.demo.session.";
/** 演示模式的设备设置键（AI 配置；不含 API Key） */
export const DEMO_DEVICE_KEY = "knowledgenet.demo.device.v1";

/* ------------------------------ 存储与生命周期 ------------------------------ */

/** 演示模式只需要这三个方法；拿不到 localStorage 时用内存兜底顶上 */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 内存兜底：拿不到 localStorage（隐私模式、SSR、测试）时至少让演示库能用 */
const memoryStorage = new Map<string, string>();

function storage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) return ls;
  } catch {
    // 访问被拒绝：退化成内存存储
  }
  return {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
  };
}

/**
 * 当前活着的演示虚拟磁盘。
 *
 * 为什么要有这个缓存：演示库只有一个，打开它的会话可能不止一个
 * （例如测试里先用可写会话建内容、再用只读会话读），而「用户在资源管理器里
 * 改了文件」这类外部改动必须被**正在使用的那个实例**看见。
 * 因此 storage 里的那份只是持久化副本，活的实例始终只有这一个。
 */
let liveVfs: MemoryVfs | null = null;

/** 装载演示库的虚拟磁盘 */
export function loadDemoVfs(): MemoryVfs {
  if (!liveVfs) liveVfs = MemoryVfs.fromJSON(storage().getItem(DEMO_VFS_KEY));
  return liveVfs;
}

/** 落盘演示库的虚拟磁盘 */
export function storeDemoVfs(vfs: MemoryVfs): void {
  liveVfs = vfs;
  try {
    storage().setItem(DEMO_VFS_KEY, vfs.toJSON());
  } catch (error) {
    // 配额满：演示数据丢了也不能让界面崩掉，但要说清楚
    throw new RepositoryError(
      "io",
      `演示数据写入浏览器存储失败（可能是配额已满）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 用一份新实例替换当前活动的演示虚拟磁盘（写盘失败时回滚用） */
export function adoptDemoVfs(vfs: MemoryVfs): void {
  liveVfs = vfs;
}

/** 清空演示库（「新建演示库」= 重新开始，不是真的在磁盘上建了文件夹） */
export function resetDemoStorage(): void {
  liveVfs = null;
  const store = storage();
  store.removeItem(DEMO_VFS_KEY);
  for (const key of demoSessionKeys()) store.removeItem(key);
}

function demoSessionKeys(): string[] {
  const out: string[] = [];
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) {
      for (let i = 0; i < ls.length; i += 1) {
        const key = ls.key(i);
        if (key && key.startsWith(DEMO_SESSION_PREFIX)) out.push(key);
      }
    }
  } catch {
    // 拿不到列表就只处理内存兜底里的键
  }
  for (const key of memoryStorage.keys()) {
    if (key.startsWith(DEMO_SESSION_PREFIX)) out.push(key);
  }
  return out;
}

/** 演示库是否已经初始化过（存在 library.json） */
export function demoLibraryReady(): boolean {
  return storage().getItem(DEMO_VFS_KEY) !== null;
}

function readManifestSync(vfs: MemoryVfs, fallbackLibraryId: string, title: string): V2LibraryManifest {
  try {
    return parseLibraryManifest(vfs.readSync(LIBRARY_FILE), LIBRARY_FILE);
  } catch {
    return newLibraryManifest({
      libraryId: fallbackLibraryId,
      title,
      now: isoFromMs(Date.now()),
    });
  }
}

/**
 * 演示库的初始内容：一个空库 + 少量示例节点。
 *
 * 「少量示例」而不是「一堆假数据」：用户一进来就能看到图谱里有点东西，
 * 又不至于分不清哪些是自己建的知识点。已经有点的库不会再被播种。
 */
export async function seedDemoLibrary(vfs: MemoryVfs, manifest: V2LibraryManifest): Promise<boolean> {
  const report = await scanLibrary(vfs, manifest, { full: true });
  if (report.nodes.length > 0) return false;
  const now = isoFromMs(Date.now());
  const seed: Array<{
    title: string;
    status: "todo" | "learning" | "done";
    note: string;
  }> = [
    {
      title: "反向传播",
      status: "learning",
      note: "# 反向传播\n\n从输出误差往回推每一层的梯度。链式法则是它的数学基础。\n",
    },
    {
      title: "链式法则",
      status: "todo",
      note: "# 链式法则\n\n复合函数的导数 = 外层导数 × 内层导数。\n",
    },
  ];
  const parent = manifest.defaults.newNodeParent || "Nodes";
  const created: KnowledgeNode[] = [];
  for (const item of seed) {
    created.push(
      await createNodeAt(vfs, parent, item.title, {
        status: item.status,
        note: item.note,
        now,
      }),
    );
  }
  const first = created[0];
  const second = created[1];
  if (first && second) {
    await relations.addEdge(vfs, first.relativePath, first.id, {
      toNodeId: second.id,
      toTitle: second.title,
      relationType: "prerequisite",
      description: "理解反向传播前需要先理解链式法则",
    });
  }
  return true;
}

/** 新建一个演示知识库：写 `library.json`（可选播种示例节点） */
export async function createDemoLibrary(input: {
  libraryId: string;
  title: string;
  seed?: boolean;
}): Promise<void> {
  const vfs = new MemoryVfs();
  const manifest = newLibraryManifest({
    libraryId: input.libraryId,
    title: input.title,
    now: isoFromMs(Date.now()),
  });
  vfs.writeSync(LIBRARY_FILE, serializeJson(manifest));
  if (input.seed) await seedDemoLibrary(vfs, manifest);
  storeDemoVfs(vfs);
}

/** 打开演示库时的摘要（含一次真实扫描的计数） */
export async function readDemoLibraryInfo(input: {
  libraryId: string;
  title: string;
  readOnly: boolean;
  rootPath?: string;
}): Promise<LibraryInfo> {
  const vfs = loadDemoVfs();
  const manifest = readManifestSync(vfs, input.libraryId, input.title);
  const report = await scanLibrary(vfs, manifest, { full: true });
  return {
    libraryId: manifest.libraryId,
    title: manifest.title || input.title,
    rootPath: input.rootPath ?? `demo://${manifest.title || input.title}`,
    readOnly: input.readOnly,
    formatVersion: manifest.formatVersion,
    nodeCount: report.nodes.length,
    edgeCount: report.edges.length,
    goalCount: report.goals.length,
    threadCount: report.threads.length,
    issueCount: report.issues.length,
    createdAt: manifest.createdAt,
    scanDurationMs: report.durationMs,
    rootIsNode: report.rootIsNode,
  };
}

/* ------------------------------ 建节点的公共实现 ------------------------------ */

/** 在 `parentRel` 下按标题建一个节点目录并写元数据（+ 初始主文档） */
async function createNodeAt(
  vfs: Vfs,
  parentRelPath: string,
  title: string,
  options: {
    aliases?: string[];
    status?: "todo" | "learning" | "done";
    note?: string;
    now?: string;
    id?: string;
  } = {},
): Promise<KnowledgeNode> {
  const now = options.now ?? isoFromMs(Date.now());
  const folder = uniqueNameIn(sanitizeFolderName(title), await children(vfs, parentRelPath));
  const nodeRel = joinRel(parentRelPath, folder);
  const id = options.id ?? newUuid();
  const content = options.note ?? "";
  const meta: V2NodeMeta = newNodeMeta({
    id,
    title,
    now,
    aliases: options.aliases ?? [],
    status: options.status ?? "todo",
    primaryDocument: notes.DEFAULT_DOCUMENT,
  });
  await vfs.mkdir(nsDir(nodeRel));
  await writeNodeMeta(vfs, nodeRel, meta, { expectedRevision: null, expectedHash: null });
  // 新建节点一定带一份主文档：用户点开就能写（文档修订号记在 notes-index.json）
  await notes.createPrimaryDocument(vfs, nodeRel, id, content);
  return {
    id,
    title,
    aliases: meta.aliases,
    status: meta.status,
    createdAt: Date.parse(now),
    updatedAt: Date.parse(now),
    relativePath: nodeRel,
    folderName: folder,
    health: "ok",
    revision: meta.revision,
    localMutation: true,
  };
}

async function children(vfs: Vfs, rel: string): Promise<string[]> {
  try {
    return (await vfs.list(rel)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/* --------------------------------- 仓库本体 --------------------------------- */

export class BrowserRepository implements Repository {
  readonly kind = "browser-demo" as const;
  readonly isDemo = true;

  #session: RepositorySession;
  #vfs: MemoryVfs;
  #manifest: V2LibraryManifest;
  #generation = 1;
  /** 最近一次成功落盘的快照：写盘失败时用它把内存树回滚回去 */
  #lastPersisted: string;

  constructor(session: RepositorySession) {
    this.#session = session;
    this.#vfs = loadDemoVfs();
    this.#manifest = readManifestSync(this.#vfs, session.libraryId, session.info.title);
    this.#lastPersisted = this.#vfs.toJSON();
    this.#session.setRevision(this.#generation);
  }

  get info(): LibraryInfo {
    return this.#session.info;
  }

  /* -------------------------------- 内部工具 -------------------------------- */

  /**
   * 落盘。
   *
   * 写盘失败（配额满、隐私模式）时把内存树回滚到上一次成功落盘的状态：
   * 否则界面会显示一笔「其实没保存」的改动，用户重启后才发现内容不见了。
   * 回滚之后这次操作整体失败，用户重试即可。
   */
  #persist(): void {
    const snapshot = this.#vfs.toJSON();
    try {
      storeDemoVfs(this.#vfs);
      this.#lastPersisted = snapshot;
    } catch (error) {
      const rollback = MemoryVfs.fromJSON(this.#lastPersisted);
      adoptDemoVfs(rollback);
      this.#vfs = rollback;
      throw error;
    }
  }

  /** 每次真实改动递增扫描代次：图快照的 `revision` 就是它 */
  #bump(): number {
    this.#generation += 1;
    this.#session.setRevision(this.#generation);
    this.#persist();
    return this.#generation;
  }

  async #scan(full: boolean): Promise<ScanReport> {
    this.#session.assertOpen();
    const report = await scanLibrary(this.#vfs, this.#manifest, { full });
    this.#session.assertOpen();
    this.#session.setInfo({
      nodeCount: report.nodes.length,
      edgeCount: report.edges.length,
      goalCount: report.goals.length,
      threadCount: report.threads.length,
      issueCount: report.issues.length,
      scanDurationMs: report.durationMs,
      rootIsNode: report.rootIsNode,
    });
    return report;
  }

  async #requireNode(
    nodeId: string,
    options: { writable?: boolean } = {},
  ): Promise<{ node: KnowledgeNode; nodeRel: string }> {
    // 只读会话必须在**发出写入之前**就被挡住，而不是写完再报错
    if (options.writable) this.#session.assertWritable();
    const report = await this.#scan(false);
    const node = report.nodes.find((item) => item.id === nodeId);
    if (!node) {
      throw new RepositoryError("node_missing", `节点不存在或已经被移出知识库：${nodeId}`, {
        nodeId,
      });
    }
    if (options.writable) {
      if (node.health === "duplicate_id") {
        throw new RepositoryError(
          "duplicate_node_id",
          `「${node.title}」的 ID 与另一个节点重复：请先决定保留哪一个，或给副本分配新 ID`,
          { nodeId, relativePath: node.relativePath },
        );
      }
      if (node.health !== "ok") {
        throw new RepositoryError(
          node.health === "metadata_unsupported" ? "metadata_unsupported" : "metadata_invalid",
          `「${node.title}」的 node.json 有问题，改不了：${node.relativePath}/.meta/knowledgenet/node.json`,
          { nodeId, relativePath: node.relativePath },
        );
      }
    }
    return { node, nodeRel: node.relativePath };
  }

  /** 线程 -> 所属节点（对话接口只拿得到 threadId / messageId） */
  async #threadIndex(): Promise<Map<string, { nodeId: string; nodeRel: string }>> {
    const report = await this.#scan(false);
    const map = new Map<string, { nodeId: string; nodeRel: string }>();
    for (const thread of report.threads) {
      map.set(thread.id, { nodeId: thread.nodeId, nodeRel: thread.nodeRelativePath ?? "" });
    }
    return map;
  }

  /**
   * 线程 ID → 磁盘上 `thread.json` 的当前修订号。
   *
   * 为什么要单独记账：界面上的 `ChatThread` 是快照，保存成功后不会就地更新；
   * 下一次保存（改标题、刷新 updatedAt、自动命名）必须拿到最新一代修订号，
   * 否则会被自己的乐观并发守卫拦下（真机上出现过这个问题）。
   */
  readonly #threadRevisions = new Map<string, number>();
  async #threadNode(threadId: string): Promise<{ nodeId: string; nodeRel: string }> {
    const index = await this.#threadIndex();
    const found = index.get(threadId);
    if (!found) throw new RepositoryError("not_found", `对话不存在：${threadId}`);
    return found;
  }

  async #nodeOf(nodeRel: string, meta: V2NodeMeta): Promise<KnowledgeNode> {
    return {
      id: meta.id,
      title: meta.title,
      aliases: meta.aliases,
      status: meta.status,
      createdAt: Date.parse(meta.createdAt),
      updatedAt: Date.parse(meta.updatedAt),
      relativePath: nodeRel,
      folderName: baseName(nodeRel),
      health: "ok",
      revision: meta.revision,
      localMutation: false,
    };
  }

  async #readBookmarks(nodeRel: string, nodeId: string): Promise<V2BookmarksFile> {
    const rel = joinRel(nodeRel, META_NS_DIR, BOOKMARKS_FILE);
    try {
      return parseBookmarksFile(await this.#vfs.read(rel), rel);
    } catch {
      return emptyBookmarks(nodeId);
    }
  }

  /* ------------------------------- 扫描与迁移 ------------------------------- */

  async scanLibrary(full: boolean): Promise<ScanReport> {
    // 全量扫描 = 打开/重新打开知识库：这时把上次崩溃留下的 streaming 收敛掉
    // （与 Rust 端 `chats::recover_incomplete` 同一时机；扫描本身绝不改盘）
    if (full) await this.#recoverIncomplete();
    const report = await this.#scan(full);
    this.#bump();
    return report;
  }

  /** streaming -> incomplete：保留已生成正文，但状态必须收敛 */
  async #recoverIncomplete(): Promise<void> {
    let recovered = 0;
    const report = await this.#scan(false);
    for (const node of report.nodes) {
      recovered += await chats.recoverIncomplete(this.#vfs, node.relativePath);
    }
    if (recovered > 0) this.#persist();
  }

  async needsMigration(): Promise<number | null> {
    this.#session.assertOpen();
    try {
      const manifest = parseLibraryManifest(this.#vfs.readSync(LIBRARY_FILE), LIBRARY_FILE);
      return manifest.formatVersion;
    } catch {
      return null;
    }
  }

  async migrateLibrary(): Promise<MigrationReport> {
    throw new RepositoryError(
      "unsupported_in_demo",
      "浏览器演示模式没有 v1 知识库可迁移：迁移是桌面版对真实文件夹的一次性操作",
    );
  }

  async adoptFolderAsNode(relativePath: string, title?: string): Promise<KnowledgeNode> {
    this.#session.assertWritable();
    const nodeRel = joinRel(relativePath);
    if (nodeRel === "") {
      throw new RepositoryError("invalid_input", "不能把知识库根目录整个认领为节点");
    }
    if (!(await this.#vfs.exists(nodeRel))) {
      throw new RepositoryError("not_found", `文件夹不存在：${nodeRel}`, { relativePath: nodeRel });
    }
    if (await this.#vfs.exists(nodeMetaFile(nodeRel))) {
      throw new RepositoryError("conflict", `这个文件夹已经是节点了：${nodeRel}`, {
        relativePath: nodeRel,
      });
    }
    const now = isoFromMs(Date.now());
    const folder = baseName(nodeRel);
    const meta = newNodeMeta({
      id: newUuid(),
      title: title?.trim() || folder,
      now,
      primaryDocument: null,
    });
    await writeNodeMeta(this.#vfs, nodeRel, meta, { expectedRevision: null, expectedHash: null });
    const revision = this.#bump();
    return {
      id: meta.id,
      title: meta.title,
      aliases: [],
      status: "todo",
      createdAt: Date.parse(now),
      updatedAt: Date.parse(now),
      relativePath: nodeRel,
      folderName: folder,
      health: "ok",
      revision,
      localMutation: true,
    };
  }

  async reassignDuplicateNodeId(relativePath: string): Promise<KnowledgeNode> {
    this.#session.assertWritable();
    const nodeRel = joinRel(relativePath);
    const snapshot = await readNodeMeta(this.#vfs, nodeRel);
    const fresh = newUuid();
    const next: V2NodeMeta = { ...snapshot.meta, id: fresh, revision: snapshot.meta.revision + 1 };
    await writeNodeMeta(this.#vfs, nodeRel, next, {
      expectedRevision: snapshot.meta.revision,
      expectedHash: snapshot.sha256,
    });
    // 副本自己的线程与出边归属要跟着改；别人对旧 ID 的引用一律不动
    for (const thread of await chats.listThreads(this.#vfs, nodeRel, snapshot.meta.id)) {
      await chats.saveThread(this.#vfs, nodeRel, { ...thread, nodeId: fresh });
    }
    const relSnapshot = await relations.readRelations(this.#vfs, nodeRel, snapshot.meta.id);
    if (relSnapshot.sha256 !== "") {
      await relations.writeRelations(
        this.#vfs,
        nodeRel,
        { ...relSnapshot.file, nodeId: fresh, revision: relSnapshot.file.revision + 1 },
        { expectedRevision: relSnapshot.file.revision, expectedHash: relSnapshot.sha256 },
      );
    }
    const revision = this.#bump();
    return { ...(await this.#nodeOf(nodeRel, next)), revision, localMutation: true };
  }

  async openNodeFolder(): Promise<void> {
    throw new RepositoryError(
      "unsupported_in_demo",
      "浏览器演示模式没有真实文件夹可以打开：节点只存在于演示存储里",
    );
  }

  /* ------------------------------- 知识图 ------------------------------- */

  async loadGraph(): Promise<GraphSnapshot> {
    const report = await this.#scan(false);
    const ids = new Set(report.nodes.map((node) => node.id));
    const stored = readDemoSession(this.#manifest.libraryId);
    // 设备侧的「上次所在节点」可能指向已经被移除身份的节点：如实返回 null，
    // 而不是把一个不存在的 ID 交给界面（界面会去找一个不存在的节点）
    const session =
      stored && stored.currentNodeId && !ids.has(stored.currentNodeId)
        ? { ...stored, currentNodeId: null }
        : stored;
    return {
      revision: this.#generation,
      nodes: report.nodes,
      edges: report.edges,
      goals: report.goals,
      session,
    };
  }

  async createNode(input: NewNodeInput): Promise<{ node: KnowledgeNode; revision: number }> {
    this.#session.assertWritable();
    const parent = input.parentRelativePath
      ? joinRel(input.parentRelativePath)
      : this.#manifest.defaults.newNodeParent || "Nodes";
    await this.#vfs.mkdir(parent);
    const node = await createNodeAt(this.#vfs, parent, input.title, {
      aliases: input.aliases,
      status: input.status,
      note: input.note,
    });
    const revision = this.#bump();
    return { node, revision };
  }

  async updateNode(
    id: string,
    patch: NodePatch,
    expected?: { expectedRevision?: number; expectedHash?: string },
  ): Promise<{ node: KnowledgeNode; revision: number }> {
    const { nodeRel } = await this.#requireNode(id, { writable: true });
    const snapshot = await readNodeMeta(this.#vfs, nodeRel);
    const next: V2NodeMeta = { ...snapshot.meta };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.aliases !== undefined) next.aliases = patch.aliases;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.primaryDocument !== undefined) next.primaryDocument = patch.primaryDocument;
    const written = await writeNodeMeta(this.#vfs, nodeRel, next, {
      expectedRevision: expected?.expectedRevision ?? snapshot.meta.revision,
      expectedHash: expected?.expectedHash ?? snapshot.sha256,
    });
    const revision = this.#bump();
    return { node: { ...(await this.#nodeOf(nodeRel, written.meta)), localMutation: true }, revision };
  }

  async readNodeMetadata(
    nodeId: string,
  ): Promise<{ node: KnowledgeNode; revision: number; sha256: string }> {
    const { node, nodeRel } = await this.#requireNode(nodeId);
    const snapshot = await readNodeMeta(this.#vfs, nodeRel);
    return { node, revision: snapshot.meta.revision, sha256: snapshot.sha256 };
  }

  async updateNodeMetadata(
    nodeId: string,
    patch: NodePatch,
    expectedRevision: number,
    expectedHash: string,
  ): Promise<KnowledgeNode> {
    const result = await this.updateNode(nodeId, patch, { expectedRevision, expectedHash });
    return result.node;
  }

  /* ------------------------------- 关系 ------------------------------- */

  async addEdge(fromId: string, toId: string, relation = ""): Promise<AddResult<DependencyEdge>> {
    const graph = await this.loadGraph();
    const cycle = findCycleIfLinked(graph, fromId, toId);
    if (cycle) return { ok: false, reason: "cycle", cycle: [fromId, ...cycle] };
    const from = await this.#requireNode(fromId, { writable: true });
    const to = await this.#requireNode(toId, { writable: true });
    const edge = await relations.addEdge(this.#vfs, from.nodeRel, fromId, {
      toNodeId: toId,
      toTitle: to.node.title,
      relationType: "prerequisite",
      description: relation,
    });
    this.#bump();
    return {
      ok: true,
      value: {
        id: edge.id,
        fromId,
        toId,
        relation: edge.description,
        relationType: edge.type,
        createdAt: Date.parse(edge.createdAt),
        updatedAt: Date.parse(edge.updatedAt),
        dangling: false,
      },
    };
  }

  async removeEdge(edgeId: string): Promise<number> {
    this.#session.assertWritable();
    const report = await this.#scan(false);
    for (const node of report.nodes) {
      const { file } = await relations.readRelations(this.#vfs, node.relativePath, node.id);
      if (!file.outgoing.some((edge) => edge.id === edgeId)) continue;
      await relations.removeEdge(this.#vfs, node.relativePath, node.id, edgeId);
      return this.#bump();
    }
    throw new RepositoryError("not_found", `关系不存在：${edgeId}`);
  }

  async updateEdgeRelation(edgeId: string, relation: string): Promise<number> {
    this.#session.assertWritable();
    const report = await this.#scan(false);
    for (const node of report.nodes) {
      const { file } = await relations.readRelations(this.#vfs, node.relativePath, node.id);
      if (!file.outgoing.some((edge) => edge.id === edgeId)) continue;
      await relations.updateEdgeDescription(this.#vfs, node.relativePath, node.id, edgeId, relation);
      return this.#bump();
    }
    throw new RepositoryError("not_found", `关系不存在：${edgeId}`);
  }

  async readRelations(nodeId: string): Promise<EdgeRelationSnapshot[]> {
    const { nodeRel } = await this.#requireNode(nodeId);
    const { file } = await relations.readRelations(this.#vfs, nodeRel, nodeId);
    return file.outgoing.map((edge) => ({ fromNodeId: nodeId, edge }));
  }

  async writeRelations(
    nodeId: string,
    file: V2RelationsFile,
    expectedRevision: number,
    expectedHash: string,
  ): Promise<number> {
    const { nodeRel } = await this.#requireNode(nodeId, { writable: true });
    await relations.writeRelations(this.#vfs, nodeRel, file, { expectedRevision, expectedHash });
    return this.#bump();
  }

  async addEvidence(fromNodeId: string, edgeId: string, input: EvidenceInput): Promise<Evidence> {
    const { nodeRel } = await this.#requireNode(fromNodeId, { writable: true });
    const evidence = await relations.addEvidence(this.#vfs, nodeRel, fromNodeId, edgeId, input);
    this.#bump();
    return evidence;
  }

  async addPrerequisites(
    parentId: string,
    titles: string[],
  ): Promise<AddResult<AddPrerequisitesPayload>> {
    this.#session.assertWritable();
    const clean = titles.map((title) => title.trim()).filter(Boolean);
    const graph = await this.loadGraph();
    const plan = planPrerequisites(graph, parentId, clean);
    if (!plan.ok) return plan;

    const parent = await this.#requireNode(parentId, { writable: true });
    const created: KnowledgeNode[] = [];
    const byTitle = new Map<string, KnowledgeNode>();
    const parentDir = this.#manifest.defaults.newNodeParent || "Nodes";
    await this.#vfs.mkdir(parentDir);
    for (const title of plan.value.createdTitles) {
      const node = await createNodeAt(this.#vfs, parentDir, title);
      created.push(node);
      byTitle.set(title, node);
    }

    const edges: DependencyEdge[] = [];
    for (const planned of plan.value.newEdges) {
      const target = planned.toId
        ? (await this.#requireNode(planned.toId)).node
        : byTitle.get(planned.title);
      if (!target) continue;
      const edge = await relations.addEdge(this.#vfs, parent.nodeRel, parentId, {
        toNodeId: target.id,
        toTitle: target.title,
        relationType: "prerequisite",
        description: "",
      });
      edges.push({
        id: edge.id,
        fromId: parentId,
        toId: target.id,
        relation: edge.description,
        relationType: edge.type,
        createdAt: Date.parse(edge.createdAt),
        updatedAt: Date.parse(edge.updatedAt),
        dangling: false,
      });
    }

    this.#bump();
    return { ok: true, value: { parentId, created, reused: plan.value.reused, edges } };
  }

  async mergeNodes(sourceId: string, targetId: string): Promise<AddResult<MergePayload>> {
    this.#session.assertWritable();
    const graph = await this.loadGraph();
    const planned = planMerge(graph, sourceId, targetId);
    if (!planned.ok) return planned;

    const source = await this.#requireNode(sourceId, { writable: true });
    const target = await this.#requireNode(targetId, { writable: true });
    const report = await this.#scan(false);

    // 1) 源节点的出边迁移到目标节点
    await relations.moveEdges(
      this.#vfs,
      { relativePath: source.nodeRel, nodeId: sourceId },
      { relativePath: target.nodeRel, nodeId: targetId },
    );
    // 2) 其它节点指向源节点的关系改接到目标（去重、去自环）
    await relations.repointTarget(
      this.#vfs,
      report.nodes
        .filter((node) => node.id !== sourceId)
        .map((node) => ({ relativePath: node.relativePath, nodeId: node.id })),
      sourceId,
      targetId,
      target.node.title,
    );
    // 3) 目标入口改指
    await goalsApi.repointGoals(this.#vfs, this.#manifest.libraryId, sourceId, targetId);
    // 4) 线程整体搬到目标节点目录，并把 thread.json 的 nodeId 改过来
    let movedThreads = 0;
    const sourceThreads = await chats.listThreads(this.#vfs, source.nodeRel, sourceId);
    if (sourceThreads.length > 0) {
      await this.#vfs.mkdir(chatsDir(target.nodeRel));
      for (const thread of sourceThreads) {
        const from = joinRel(chatsDir(source.nodeRel), thread.id);
        const to = joinRel(chatsDir(target.nodeRel), thread.id);
        if (await this.#vfs.exists(to)) continue;
        await moveTree(this.#vfs, from, to);
        const saved = await chats.readThreadFile(this.#vfs, target.nodeRel, thread.id);
        if (saved) {
          await this.#vfs.write(
            joinRel(chatsDir(target.nodeRel), thread.id, "thread.json"),
            serializeJson({ ...saved, nodeId: targetId, revision: saved.revision + 1 }),
          );
        }
        movedThreads += 1;
      }
    }
    // 5) 书签：目标至多一条，源书签的非空字段并进来
    await this.#mergeBookmarks(source.nodeRel, target.nodeRel, sourceId, targetId);
    // 6) 源节点的知识身份进回收站（用户文件夹原位保留）
    await this.#removeIdentity(sourceId, source.nodeRel, source.node.title, false);

    this.#bump();
    return {
      ok: true,
      value: {
        target: target.node,
        removedNodeId: sourceId,
        movedEdges: planned.value.movedEdges,
        droppedEdges: planned.value.droppedEdges,
        goalsRepointed: planned.value.goalsRepointed,
        movedResources: 0,
        movedThreads,
      },
    };
  }

  async #mergeBookmarks(
    sourceRel: string,
    targetRel: string,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const sourceFile = await this.#readBookmarks(sourceRel, sourceId);
    if (sourceFile.bookmarks.length === 0) return;
    const targetFile = await this.#readBookmarks(targetRel, targetId);
    const newest = (list: typeof sourceFile.bookmarks) =>
      [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const source = newest(sourceFile.bookmarks);
    const existing = newest(targetFile.bookmarks);
    const now = isoFromMs(Date.now());
    let next: (typeof sourceFile.bookmarks)[number];
    if (source && existing) {
      next = {
        ...existing,
        threadId: existing.threadId ?? source.threadId,
        messageId: existing.messageId ?? source.messageId,
        scrollOffset: existing.scrollOffset || source.scrollOffset,
        question: existing.question || source.question,
        returnNodeId: existing.returnNodeId ?? source.returnNodeId,
        updatedAt: now,
      };
    } else if (source) {
      next = { ...source, id: newUuid(), updatedAt: now };
    } else {
      return;
    }
    await this.#vfs.write(
      joinRel(targetRel, META_NS_DIR, BOOKMARKS_FILE),
      serializeJson({ ...targetFile, bookmarks: [next], revision: targetFile.revision + 1 }),
    );
  }

  /* --------------------------- 节点身份生命周期 --------------------------- */

  async #removeIdentity(
    nodeId: string,
    nodeRel: string,
    title: string,
    bump = true,
  ): Promise<RemovedIdentity> {
    const deletedAt = Date.now();
    const trashRel = joinRel(TRASH_NODE_METADATA_DIR, nodeId, String(deletedAt));
    const identity: RemovedIdentity = {
      nodeId,
      title,
      relativePath: nodeRel,
      trashedRelative: trashRel,
      deletedAt,
    };
    await moveTree(this.#vfs, nsDir(nodeRel), joinRel(trashRel, "knowledgenet"));
    await this.#vfs.write(joinRel(trashRel, "removed.json"), serializeJson(identity));
    // `.meta` 里如果还有别的软件的内容就保留它；空了才顺手清掉
    const metaDir = joinRel(nodeRel, ".meta");
    try {
      const left = await this.#vfs.list(metaDir);
      if (left.length === 0) await this.#vfs.remove(metaDir);
    } catch {
      // 没有 .meta 目录：什么都不用做
    }
    if (bump) this.#bump();
    return identity;
  }

  async removeNodeIdentity(nodeId: string): Promise<RemovedIdentity> {
    this.#session.assertWritable();
    const { node, nodeRel } = await this.#requireNode(nodeId, { writable: true });
    return this.#removeIdentity(nodeId, nodeRel, node.title);
  }

  async listRemovedIdentities(): Promise<RemovedIdentity[]> {
    this.#session.assertOpen();
    const out: RemovedIdentity[] = [];
    let ids;
    try {
      ids = await this.#vfs.list(TRASH_NODE_METADATA_DIR);
    } catch {
      return [];
    }
    for (const id of ids) {
      if (id.kind !== "dir") continue;
      let stamps;
      try {
        stamps = await this.#vfs.list(joinRel(TRASH_NODE_METADATA_DIR, id.name));
      } catch {
        continue;
      }
      for (const stamp of stamps) {
        if (stamp.kind !== "dir") continue;
        try {
          const raw = await this.#vfs.read(
            joinRel(TRASH_NODE_METADATA_DIR, id.name, stamp.name, "removed.json"),
          );
          out.push(JSON.parse(raw) as RemovedIdentity);
        } catch {
          continue;
        }
      }
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async restoreNodeIdentity(nodeId: string): Promise<KnowledgeNode> {
    this.#session.assertWritable();
    const entry = (await this.listRemovedIdentities()).find((item) => item.nodeId === nodeId);
    if (!entry) {
      throw new RepositoryError("not_found", `回收站里没有这个节点的元数据：${nodeId}`);
    }
    const target = entry.relativePath;
    if (await this.#vfs.exists(nodeMetaFile(target))) {
      throw new RepositoryError(
        "conflict",
        `原路径上已经有另一份节点元数据：${target}。请先处理那一份再恢复`,
        { relativePath: target },
      );
    }
    if (!(await this.#vfs.exists(target))) {
      throw new RepositoryError(
        "node_missing",
        `原来的文件夹已经不在了：${target}。恢复只把元数据放回原位，不会重建文件夹`,
        { relativePath: target },
      );
    }
    await copyTree(this.#vfs, joinRel(entry.trashedRelative, "knowledgenet"), nsDir(target));
    await this.#vfs.remove(entry.trashedRelative);
    this.#bump();
    return (await this.#requireNode(nodeId)).node;
  }

  async purgeRemovedIdentity(nodeId: string): Promise<void> {
    this.#session.assertWritable();
    const mine = (await this.listRemovedIdentities()).filter((item) => item.nodeId === nodeId);
    if (mine.length === 0) {
      throw new RepositoryError("not_found", `回收站里没有这个节点的元数据：${nodeId}`);
    }
    for (const entry of mine) await this.#vfs.remove(entry.trashedRelative);
    this.#bump();
  }

  /* --------------------- 彻底删除（连文件夹一起删） --------------------- */

  /**
   * 量一个文件夹：文件数（含 `.meta`）、字节数、子目录数、里面套着几个下级知识点。
   *
   * 演示后端也必须真的数：删除对话框里那句「会删掉 N 个文件」如果只是编的数字，
   * 演示模式就成了「看起来对」的假界面。
   */
  async #usageOf(nodeRel: string): Promise<NodeFolderUsage> {
    let fileCount = 0;
    let byteSize = 0;
    let directoryCount = 0;
    let nestedNodeCount = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await this.#vfs.list(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = joinRel(dir, entry.name);
        if (entry.kind === "dir") {
          directoryCount += 1;
          if (await this.#vfs.exists(joinRel(child, NODE_MARKER))) nestedNodeCount += 1;
          await walk(child);
          continue;
        }
        fileCount += 1;
        byteSize += entry.byteLength;
      }
    };
    await walk(nodeRel);
    // 用户文件另算一份：`.meta` 不算「资料」，嵌套节点子树也不算（它属于子节点）
    const top = await this.#vfs.list(nodeRel);
    let resourceCount = 0;
    let resourceBytes = 0;
    const collectResources = async (dir: string): Promise<void> => {
      for (const entry of await this.#vfs.list(dir)) {
        const child = joinRel(dir, entry.name);
        if (entry.kind === "file") {
          resourceCount += 1;
          resourceBytes += entry.byteLength;
          continue;
        }
        if (entry.name === META_DIR) continue;
        if (await this.#vfs.exists(joinRel(child, NODE_MARKER))) continue;
        await collectResources(child);
      }
    };
    for (const entry of top) {
      if (entry.kind === "file") {
        resourceCount += 1;
        resourceBytes += entry.byteLength;
        continue;
      }
      if (entry.name === META_DIR) continue;
      const child = joinRel(nodeRel, entry.name);
      if (await this.#vfs.exists(joinRel(child, NODE_MARKER))) continue;
      await collectResources(child);
    }
    return {
      relativePath: nodeRel,
      fileCount,
      byteSize,
      resourceCount,
      resourceBytes,
      directoryCount,
      nestedNodeCount,
    };
  }

  async inspectNodeFolder(nodeId: string): Promise<NodeFolderUsage> {
    const { nodeRel } = await this.#requireNode(nodeId);
    if (nodeRel === "") {
      throw new RepositoryError(
        "conflict",
        "知识库根目录本身是一个节点：删掉它会连整个知识库一起没了，这一步已拒绝",
      );
    }
    return this.#usageOf(nodeRel);
  }

  async backupNodeResources(nodeId: string): Promise<NodeBackup> {
    const { node, nodeRel } = await this.#requireNode(nodeId, { writable: true });
    if (nodeRel === "") {
      throw new RepositoryError(
        "conflict",
        "知识库根目录本身是一个节点：备份整个知识库不该由这个按钮触发",
      );
    }
    const stamp = (() => {
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      return (
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      );
    })();
    // 同一秒里备份两次是正常操作（先备份、再改主意、再备份一次），不能覆盖前一份
    let taken: string[] = [];
    try {
      taken = (await this.#vfs.list(BACKUPS_DIR))
        .filter((entry) => entry.kind === "dir")
        .map((entry) => entry.name);
    } catch {
      taken = [];
    }
    const target = joinRel(
      BACKUPS_DIR,
      uniqueNameIn(`${stamp}-${sanitizeFolderName(baseName(nodeRel) || node.title)}`, taken),
    );
    await copyTree(this.#vfs, nodeRel, target);
    const usage = await this.#usageOf(target);
    this.#bump();
    return {
      nodeId: node.id,
      title: node.title,
      relativePath: nodeRel,
      backupRelativePath: target,
      // 演示模式没有真实磁盘：把虚拟路径原样给出，界面能显示「备份在哪」
      backupPath: target,
      fileCount: usage.fileCount,
      byteSize: usage.byteSize,
      createdAt: Date.now(),
    };
  }

  async eraseNode(nodeId: string): Promise<NodeErasure> {
    const { node, nodeRel } = await this.#requireNode(nodeId, { writable: true });
    if (nodeRel === "") {
      throw new RepositoryError(
        "conflict",
        "知识库根目录本身是一个节点：删掉它会连整个知识库一起没了，这一步已拒绝",
      );
    }
    const usage = await this.#usageOf(nodeRel);
    const archives = (await this.listRemovedIdentities()).filter(
      (entry) => entry.nodeId === nodeId,
    );
    await removeTree(this.#vfs, nodeRel);
    for (const entry of archives) await this.#vfs.remove(entry.trashedRelative);
    this.#bump();
    return {
      nodeId,
      title: node.title,
      relativePath: nodeRel,
      deletedFiles: usage.fileCount,
      deletedBytes: usage.byteSize,
      purgedArchives: archives.length,
    };
  }

  async revealBackup(): Promise<void> {
    throw new RepositoryError("unsupported_in_demo", "浏览器演示模式没有资源管理器可以打开备份目录");
  }

  /* -------------------------------- 笔记 -------------------------------- */

  async readNote(nodeId: string): Promise<NodeNote> {
    const { nodeRel } = await this.#requireNode(nodeId);
    return notes.toNodeNote(await notes.readDocument(this.#vfs, nodeRel, nodeId));
  }
  async writeNote(
    nodeId: string,
    content: string,
    expectedDocumentRevision: number,
    force = false,
  ): Promise<WriteNoteOutcome> {
    const { nodeRel } = await this.#requireNode(nodeId, { writable: true });
    const outcome = await notes.writeDocument(
      this.#vfs,
      nodeRel,
      nodeId,
      content,
      expectedDocumentRevision,
      force,
    );
    if (outcome.status === "conflict") {
      return { status: "conflict", conflict: outcome.conflict, conflictCopy: outcome.conflictCopy };
    }
    const revision = this.#bump();
    return {
      status: "saved",
      note: notes.toNodeNote(outcome.note),
      revision,
      conflictCopy: outcome.conflictCopy,
    };
  }

  async checkNote(nodeId: string): Promise<NoteDiskState> {
    const { nodeRel } = await this.#requireNode(nodeId);
    return notes.checkDocument(this.#vfs, nodeRel, nodeId);
  }

  /** 演示模式专用：列出被「覆盖保存」换下来的旧正文（测试与排查用） */
  async listNoteConflicts(
    nodeId?: string,
  ): Promise<Array<{ relativePath: string; name: string; content: string }>> {
    const report = await this.#scan(false);
    const nodes = nodeId ? report.nodes.filter((node) => node.id === nodeId) : report.nodes;
    const out: Array<{ relativePath: string; name: string; content: string }> = [];
    for (const node of nodes) {
      out.push(...(await notes.listConflictCopies(this.#vfs, node.relativePath)));
    }
    return out;
  }

  /* -------------------------------- 资料 -------------------------------- */

  async listResources(nodeId: string): Promise<NodeResource[]> {
    const { nodeRel } = await this.#requireNode(nodeId);
    return resourcesApi.listResources(this.#vfs, nodeRel, nodeId);
  }

  async listPlainFiles(nodeId: string): Promise<NodeFileEntry[]> {
    const { nodeRel } = await this.#requireNode(nodeId);
    return resourcesApi.listPlainFiles(this.#vfs, nodeRel);
  }

  async addResourceFile(): Promise<{ resource: NodeResource; revision: number }> {
    throw new RepositoryError(
      "unsupported_in_demo",
      "浏览器演示模式不能把磁盘上的文件复制进知识库：请用桌面版（也可以直接把文件放进节点文件夹）",
    );
  }

  async addResourceUrl(
    nodeId: string,
    url: string,
    displayName?: string,
    description?: string,
  ): Promise<{ resource: NodeResource; revision: number }> {
    const { nodeRel } = await this.#requireNode(nodeId, { writable: true });
    const resource = await resourcesApi.addUrlResource(
      this.#vfs,
      nodeRel,
      nodeId,
      url,
      displayName,
      description,
    );
    const revision = this.#bump();
    return { resource, revision };
  }

  async updateResource(
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<{ resource: NodeResource; revision: number }> {
    const report = await this.#scan(false);
    for (const node of report.nodes) {
      const list = await resourcesApi.listResources(this.#vfs, node.relativePath, node.id);
      if (!list.some((item) => item.id === resourceId)) continue;
      const resource = await resourcesApi.updateResource(
        this.#vfs,
        node.relativePath,
        node.id,
        resourceId,
        patch,
      );
      const revision = this.#bump();
      return { resource, revision };
    }
    throw new RepositoryError("not_found", `资料不存在：${resourceId}`);
  }

  async openResource(): Promise<void> {
    throw new RepositoryError("unsupported_in_demo", "浏览器演示模式不能调用系统程序打开资料");
  }

  async revealResource(): Promise<void> {
    throw new RepositoryError("unsupported_in_demo", "浏览器演示模式没有资源管理器可以定位文件");
  }

  async deleteResource(resourceId: string, deleteFile = false): Promise<number> {
    this.#session.assertWritable();
    const report = await this.#scan(false);
    for (const node of report.nodes) {
      const list = await resourcesApi.listResources(this.#vfs, node.relativePath, node.id);
      if (!list.some((item) => item.id === resourceId)) continue;
      await resourcesApi.removeResource(
        this.#vfs,
        node.relativePath,
        node.id,
        resourceId,
        deleteFile,
      );
      return this.#bump();
    }
    throw new RepositoryError("not_found", `资料不存在：${resourceId}`);
  }

  async annotatePlainFile(nodeId: string, relativePath: string): Promise<NodeResource> {
    const { nodeRel } = await this.#requireNode(nodeId, { writable: true });
    const resource = await resourcesApi.annotateFile(this.#vfs, nodeRel, nodeId, relativePath);
    this.#bump();
    return resource;
  }

  /* ---------------------------- 完整性与修复 ---------------------------- */

  async checkIntegrity(deep: boolean): Promise<IntegrityReport> {
    const report = await this.#scan(deep);
    const issues: IntegrityIssue[] = report.issues.map((issue, index) => ({
      id: `issue-${index}`,
      kind: issue.code,
      severity: issue.severity,
      entityType:
        issue.code === "dangling_relation"
          ? "edge"
          : issue.code === "nested_library_boundary"
            ? "library"
            : "node",
      entityId: issue.nodeId ?? issue.relativePath ?? "",
      path: issue.relativePath,
      detail: issue.detail,
      repairable: issue.code === "duplicate_node_id",
    }));
    return {
      deep,
      checkedAt: Date.now(),
      revision: this.#generation,
      issues,
      counts: {
        nodes: report.nodes.length,
        edges: report.edges.length,
        goals: report.goals.length,
        resources: 0,
        threads: report.threads.length,
        messages: report.threads.reduce((sum, thread) => sum + (thread.messageCount ?? 0), 0),
        filesChecked: 0,
        bytesChecked: 0,
        plainFiles: 0,
        issues: issues.length,
      },
      ok: !issues.some((issue) => issue.severity === "error"),
      truncated: report.truncated,
      warnings: [
        "演示模式：这里检查的是演示虚拟磁盘上的开放文件，不做真实磁盘、符号链接与权限检查。",
      ],
    };
  }

  async repairLibrary(actions: RepairAction[]): Promise<RepairReport> {
    this.#session.assertWritable();
    return {
      applied: actions.map((action) => ({
        action: action.action,
        entityId: action.entityId,
        ok: false,
        detail: "浏览器演示模式不执行真实修复：请在桌面版里处理",
      })),
      report: await this.checkIntegrity(false),
    };
  }

  /* -------------------------------- 对话 -------------------------------- */

  async listThreads(nodeId: string): Promise<ChatThread[]> {
    const { nodeRel } = await this.#requireNode(nodeId);
    const threads = await chats.listThreads(this.#vfs, nodeRel, nodeId);
    for (const thread of threads) this.#rememberRevision(thread);
    return threads;
  }

  async loadThread(threadId: string): Promise<{ thread: ChatThread; messages: ChatMessage[] }> {
    const { nodeRel } = await this.#threadNode(threadId);
    const loaded = await chats.loadThread(this.#vfs, nodeRel, threadId);
    this.#rememberRevision(loaded.thread);
    return loaded;
  }

  async createThread(nodeId: string, title?: string): Promise<ChatThread> {
    const { nodeRel } = await this.#requireNode(nodeId, { writable: true });
    const thread = await chats.createThread(this.#vfs, nodeRel, nodeId, title ?? "新对话");
    this.#rememberRevision(thread);
    this.#bump();
    return thread;
  }

  async saveThread(thread: ChatThread): Promise<void> {
    this.#session.assertWritable();
    let nodeRel: string;
    try {
      nodeRel = (await this.#threadNode(thread.id)).nodeRel;
    } catch {
      nodeRel = (await this.#requireNode(thread.nodeId, { writable: true })).nodeRel;
    }
    /*
     * 与桌面端同一条纪律：手上那份修订号必须带去比对，外部改过就报冲突。
     *
     * 但「手上那份」不能只信对象本身：界面上的 `ChatThread` 是**快照**，
     * 保存成功后不会就地更新。于是「回答完成刷新 updatedAt」之后再「改标题 / 自动命名」
     * 就会拿着上一代修订号去撞最新的一代，被自己的守卫拦下——
     * 这正是真机上出现过的问题，所以这里维护一张表，保存时以它为准。
     */
    const expectedRevision = await this.#currentRevision(nodeRel, thread);
    const saved = await chats.saveThread(this.#vfs, nodeRel, thread, expectedRevision);
    this.#rememberRevision(saved);
    this.#bump();
  }

  #rememberRevision(thread: ChatThread): void {
    if (typeof thread.revision === "number") this.#threadRevisions.set(thread.id, thread.revision);
  }

  /** 取「我手上这份 thread 的修订号」：会话内记账 → 对象自带 → 问磁盘要一次 */
  async #currentRevision(nodeRel: string, thread: ChatThread): Promise<number | null> {
    const known = this.#threadRevisions.get(thread.id);
    if (typeof known === "number") return known;
    if (typeof thread.revision === "number") {
      this.#threadRevisions.set(thread.id, thread.revision);
      return thread.revision;
    }
    try {
      const loaded = await chats.loadThread(this.#vfs, nodeRel, thread.id);
      this.#rememberRevision(loaded.thread);
      return loaded.thread.revision ?? null;
    } catch {
      // 线程还不存在：交给底层「新建」语义处理，不做守卫
      return null;
    }
  }

  /**
   * 演示后端没有真实模型：用第一条提问收敛成一个标题。
   *
   * 语义与桌面端**保持一致**（只读、拿不到就返回 `null`、是否采纳由界面决定），
   * 这样「第一轮问答结束后自动命名」这条流程在浏览器自检里也能被覆盖，
   * 而不是只有装了桌面版才看得到。
   */
  async suggestThreadTitle(threadId: string): Promise<string | null> {
    let nodeRel: string;
    try {
      nodeRel = (await this.#threadNode(threadId)).nodeRel;
    } catch {
      return null;
    }
    const loaded = await chats.loadThread(this.#vfs, nodeRel, threadId);
    const question = loaded.messages.find((m) => m.role === "user" && m.content.trim());
    const answer = loaded.messages.find((m) => m.role === "assistant" && m.content.trim());
    // 只有第一轮（一问一答）齐了才起名，和桌面端同一条判据
    if (!question || !answer) return null;
    return titleFromQuestion(question.content);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.#session.assertWritable();
    const { nodeRel } = await this.#threadNode(threadId);
    await chats.deleteThread(this.#vfs, nodeRel, threadId);
    this.#bump();
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    this.#session.assertWritable();
    const { nodeRel } = await this.#threadNode(message.threadId);
    await chats.saveMessage(this.#vfs, nodeRel, message.threadId, message);
    this.#persist();
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.#session.assertWritable();
    const report = await this.#scan(false);
    for (const thread of report.threads) {
      const nodeRel = thread.nodeRelativePath ?? "";
      const loaded = await chats.loadThread(this.#vfs, nodeRel, thread.id);
      if (!loaded.messages.some((item) => item.id === messageId)) continue;
      await chats.deleteMessage(this.#vfs, nodeRel, thread.id, messageId);
      this.#persist();
      return;
    }
    throw new RepositoryError("not_found", `消息不存在：${messageId}`);
  }

  async listBookmarks(nodeId: string): Promise<Bookmark[]> {
    const { nodeRel } = await this.#requireNode(nodeId);
    const file = await this.#readBookmarks(nodeRel, nodeId);
    return file.bookmarks.map((entry) => ({
      id: entry.id,
      nodeId,
      threadId: entry.threadId,
      messageId: entry.messageId,
      scrollOffset: entry.scrollOffset,
      question: entry.question,
      returnNodeId: entry.returnNodeId,
      createdAt: Date.parse(entry.createdAt),
      updatedAt: Date.parse(entry.updatedAt),
    }));
  }

  async saveBookmark(bookmark: Bookmark): Promise<void> {
    const { nodeRel } = await this.#requireNode(bookmark.nodeId, { writable: true });
    const file = await this.#readBookmarks(nodeRel, bookmark.nodeId);
    const entry = {
      id: bookmark.id,
      threadId: bookmark.threadId ?? null,
      messageId: bookmark.messageId ?? null,
      scrollOffset: bookmark.scrollOffset,
      question: bookmark.question,
      returnNodeId: bookmark.returnNodeId ?? null,
      createdAt: isoFromMs(bookmark.createdAt),
      updatedAt: isoFromMs(bookmark.updatedAt),
    };
    await this.#vfs.write(
      joinRel(nodeRel, META_NS_DIR, BOOKMARKS_FILE),
      serializeJson({
        ...file,
        nodeId: bookmark.nodeId,
        bookmarks: [...file.bookmarks.filter((item) => item.id !== bookmark.id), entry],
        revision: file.revision + 1,
      }),
    );
    this.#bump();
  }

  async deleteBookmark(bookmarkId: string): Promise<void> {
    this.#session.assertWritable();
    const report = await this.#scan(false);
    for (const node of report.nodes) {
      const file = await this.#readBookmarks(node.relativePath, node.id);
      if (!file.bookmarks.some((item) => item.id === bookmarkId)) continue;
      await this.#vfs.write(
        joinRel(node.relativePath, META_NS_DIR, BOOKMARKS_FILE),
        serializeJson({
          ...file,
          bookmarks: file.bookmarks.filter((item) => item.id !== bookmarkId),
          revision: file.revision + 1,
        }),
      );
      this.#bump();
      return;
    }
    throw new RepositoryError("not_found", `书签不存在：${bookmarkId}`);
  }

  /* ---------------------------- 位置与目标状态 ---------------------------- */

  async saveSession(session: LearnSession | null): Promise<void> {
    this.#session.assertWritable();
    const key = `${DEMO_SESSION_PREFIX}${this.#manifest.libraryId}`;
    if (!session) {
      storage().removeItem(key);
      return;
    }
    storage().setItem(key, JSON.stringify(session));
  }

  async enterNode(nodeId: string, goalId?: string): Promise<void> {
    await this.saveSession({
      id: `${this.#manifest.libraryId}:session`,
      goalId: goalId ?? "",
      currentNodeId: nodeId,
      updatedAt: Date.now(),
    });
  }
}

/** 读设备侧的「上次所在节点」 */
export function readDemoSession(libraryId: string): LearnSession | null {
  try {
    const raw = storage().getItem(`${DEMO_SESSION_PREFIX}${libraryId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LearnSession;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/* --------------------------- 测试与排查用的直通接口 --------------------------- */

/** 演示库当前有哪些文件（只读快照） */
export function demoFilePaths(): string[] {
  return loadDemoVfs().filePaths();
}

/** 演示库某个文件的正文 */
export function demoReadFile(rel: string): string {
  return loadDemoVfs().readSync(rel);
}

/** 直接改演示库里的文件（模拟「用户在资源管理器里编辑」） */
export function demoWriteFile(rel: string, text: string): void {
  const vfs = loadDemoVfs();
  vfs.writeSync(rel, text);
  storeDemoVfs(vfs);
}

/** 删掉演示库里的某个文件（模拟外部删除） */
export function demoRemoveFile(rel: string): void {
  const vfs = loadDemoVfs();
  void vfs.remove(rel);
  storeDemoVfs(vfs);
}

export { GOALS_FILE, LIBRARY_FILE, NODE_MARKER, ROOT_META_DIR, parentRel };
