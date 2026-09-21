/**
 * 桌面端存储适配器（Tauri + 开放文件知识库 v2）
 *
 * 这里只做桥接：每个方法对应 `src-tauri/src/v2/commands.rs` 里的一条 Tauri 命令，
 * **参数名与形状必须与 Rust 侧一致**（Tauri 只把 camelCase 映射到 Rust 的 snake_case 形参，
 * 名字对不上就是运行时「缺参数」，编译期查不出来）。
 *
 * 四条贯穿全文件的规则：
 * 1. **绑定会话**：Repository 属于「一次打开」，会话关闭后所有调用抛 `session_closed`；
 *    每个方法在调用前后各检查一次，切库后晚到的响应不会把旧库数据交给界面。
 * 2. **错误归一化**：Rust 抛的是 `{code, message, detail}`，统一走 `toRepositoryError`，
 *    调用方只需要按 `code` 分支（尤其是 `external_change_conflict` / `read_only` /
 *    `duplicate_node_id` / `metadata_invalid`）。
 * 3. **前端只传实体 ID 或相对路径**，绝不传绝对路径：节点目录由 Rust 的派生索引解析。
 * 4. **ID → 归属地解析在本适配器内完成**：Rust 的部分命令需要「哪个节点」才能定位文件
 *    （边在源节点的 `relations.json`、资料在节点的 `resources.json`、消息在节点的 `chats/`），
 *    而界面持有的是图、线程、资料列表这些**已经读进来的东西**。这里把这些
 *    「某个 ID 属于哪个节点」的映射缓存下来（`#edgeSource` / `#threadNode` / `#resourceNode`），
 *    缺失时才回退到一次 `load_graph` 兜底解析。
 *    这样界面不必为了删一条边先去查源节点路径——那等于把设备索引的职责推给界面。
 */
import { invoke } from "@tauri-apps/api/core";

import { RepositoryError, toRepositoryError } from "./errors.ts";
import type { RepositorySession } from "./librarySession.ts";
import type { EdgeRelationSnapshot, BackendKind, Repository } from "./repository.ts";
import type { Bookmark, ChatMessage, ChatThread } from "./chatTypes.ts";
import type {
  AddPrerequisitesPayload,
  AddResult,
  DependencyEdge,
  Evidence,
  EvidenceInput,
  GraphSnapshot,
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
import type { V2Evidence } from "./v2/schema.ts";

/** Rust `RelationEdgeView` / `RelationEdgeInput` 的形状（camelCase） */
interface WireRelationEdge {
  [key: string]: unknown;
  id: string;
  toNodeId: string;
  type: string;
  description: string;
  toTitleSnapshot: string;
  createdAt: string;
  updatedAt: string;
  evidence: V2Evidence[];
}

interface WireRelationsSnapshot {
  outgoing: WireRelationEdge[];
  revision: number;
  sha256: string;
}

/** Rust `AddOutcome<T>`：失败分支把 reason/cycle 平铺在对象上 */
type WireAddOutcome<T> =
  | { ok: true; value: T; revision?: number }
  | { ok: false; reason?: string; cycle?: string[]; revision?: number };

/** Rust `ChatThreadView` 比前端领域模型多一个 `revision`（保留给乐观并发用） */
type WireThread = ChatThread & { revision?: number };

export class TauriRepository implements Repository {
  readonly kind: BackendKind = "tauri-portable";
  readonly isDemo = false;

  private readonly session: RepositorySession;

  /* ------------------- ID → 归属节点的解析缓存（见文件头规则 4） ------------------- */
  private readonly edgeSource = new Map<string, string>();
  private readonly threadNode = new Map<string, string>();
  private readonly resourceNode = new Map<string, string>();
  private readonly messageThread = new Map<string, string>();
  private readonly bookmarkNode = new Map<string, string>();
  private readonly removedAt = new Map<string, number>();
  /**
   * 线程 ID → 磁盘上 `thread.json` 的当前修订号。
   *
   * 为什么要有这张表：`save_thread` 的乐观并发守卫要求调用方给出「我手上那份的修订号」，
   * 而界面上那个 `ChatThread` 对象是**快照**——保存成功后它并不会被就地更新。
   * 于是「回答完成刷新 updatedAt」之后再「重命名」就会拿着上一代的修订号去撞最新的一代，
   * 被判成「外部改动」。这里在每次 list / load / create / **save 之后**都记下最新的修订号，
   * 保存时以它为准。
   */
  private readonly threadRevision = new Map<string, number>();

  constructor(session: RepositorySession) {
    this.session = session;
  }

  get info(): LibraryInfo {
    return this.session.info;
  }

  /* ------------------------------- 会话守卫 ------------------------------- */

  /** 读操作：调用前后都确认会话仍然有效，晚到的响应一律丢弃 */
  private async read<T>(work: () => Promise<T>): Promise<T> {
    this.session.assertOpen();
    try {
      const value = await work();
      this.session.assertOpen();
      return value;
    } catch (error) {
      throw toRepositoryError(error);
    }
  }

  /** 写操作：只读会话在发命令之前就被挡住，而不是等后端报错 */
  private async write<T>(work: () => Promise<T>): Promise<T> {
    this.session.assertWritable();
    try {
      const value = await work();
      this.session.assertOpen();
      return value;
    } catch (error) {
      throw toRepositoryError(error);
    }
  }

  private applyRevision(revision: number | undefined | null): void {
    if (typeof revision === "number") this.session.setRevision(revision);
  }

  /** 扫描结果同时刷新会话摘要里的计数：界面上的「多少节点/多少问题」要跟着变 */
  private applyScan(report: ScanReport & { generation?: number }): void {
    this.session.setInfo({
      nodeCount: report.nodes.length,
      edgeCount: report.edges.length,
      goalCount: report.goals.length,
      threadCount: report.threads.length,
      issueCount: report.issues.length,
      scanDurationMs: report.durationMs,
      rootIsNode: report.rootIsNode,
    });
    this.applyRevision(report.generation);
    // 扫描顺手把「边属于谁」记下来：后续 remove_edge / update_edge_relation 要用
    for (const edge of report.edges) this.edgeSource.set(edge.id, edge.fromId);
  }

  private rememberThreads(nodeId: string, threads: WireThread[]): ChatThread[] {
    for (const thread of threads) {
      this.threadNode.set(thread.id, nodeId);
      if (typeof thread.revision === "number") this.threadRevision.set(thread.id, thread.revision);
    }
    return threads;
  }

  /**
   * 取「我手上这份 thread 的修订号」。
   *
   * 顺序：会话内记账 → 对象自带 → 问磁盘要一次。
   * **绝不**在拿不到时退回 0：新建的 `thread.json` 就是 revision 1，
   * 拿 0 去比会把每一次正常保存都判成「已被外部修改」（这条路径真的出过问题）。
   */
  private async threadRevisionFor(thread: ChatThread): Promise<number> {
    const known = this.threadRevision.get(thread.id);
    if (typeof known === "number") return known;
    if (typeof thread.revision === "number") {
      this.threadRevision.set(thread.id, thread.revision);
      return thread.revision;
    }
    // 兜底：这个线程是别人塞进来的（例如从旧状态恢复），问一次磁盘
    const loaded = await invoke<{ thread: WireThread }>("load_thread", { threadId: thread.id });
    const revision = loaded?.thread?.revision;
    if (typeof revision !== "number") {
      throw new RepositoryError(
        "revision_conflict",
        `拿不到对话「${thread.title}」的修订号，已拒绝覆盖`,
      );
    }
    this.threadNode.set(loaded.thread.id, loaded.thread.nodeId);
    this.threadRevision.set(loaded.thread.id, revision);
    return revision;
  }

  /** 解析一条边/一个线程/一条资料属于哪个节点；缓存缺失时兜底做一次全图解析 */
  private async resolveNode(options: {
    edgeId?: string;
    threadId?: string;
    messageId?: string;
    resourceId?: string;
    bookmarkId?: string;
    nodeId?: string;
  }): Promise<string> {
    if (options.nodeId) return options.nodeId;
    if (options.edgeId) {
      const cached = this.edgeSource.get(options.edgeId);
      if (cached) return cached;
    }
    if (options.threadId) {
      const cached = this.threadNode.get(options.threadId);
      if (cached) return cached;
    }
    if (options.messageId) {
      const thread = this.messageThread.get(options.messageId);
      const node = thread ? this.threadNode.get(thread) : undefined;
      if (node) return node;
    }
    if (options.resourceId) {
      const cached = this.resourceNode.get(options.resourceId);
      if (cached) return cached;
    }
    if (options.bookmarkId) {
      const cached = this.bookmarkNode.get(options.bookmarkId);
      if (cached) return cached;
    }

    // 兜底：把图与各节点的列表读一遍（只在缓存缺失时发生，例如刚打开界面就右键删除）
    const snapshot = await invoke<GraphSnapshot>("load_graph");
    this.session.assertOpen();
    this.applyRevision(snapshot.revision);
    for (const edge of snapshot.edges) this.edgeSource.set(edge.id, edge.fromId);
    for (const node of snapshot.nodes) {
      const threads = await invoke<WireThread[]>("list_threads", { nodeId: node.id });
      this.rememberThreads(node.id, threads);
      const resources = await invoke<NodeResource[]>("list_node_resources", { nodeId: node.id });
      for (const resource of resources) this.resourceNode.set(resource.id, node.id);
      const bookmarks = await this.fetchBookmarksRaw(node.id);
      for (const bookmark of bookmarks) this.bookmarkNode.set(bookmark.id, node.id);
    }
    const found =
      (options.edgeId ? this.edgeSource.get(options.edgeId) : undefined) ??
      (options.threadId ? this.threadNode.get(options.threadId) : undefined) ??
      (options.messageId
        ? this.threadNode.get(this.messageThread.get(options.messageId) ?? "")
        : undefined) ??
      (options.resourceId ? this.resourceNode.get(options.resourceId) : undefined) ??
      (options.bookmarkId ? this.bookmarkNode.get(options.bookmarkId) : undefined);
    if (!found) {
      throw new RepositoryError("not_found", "找不到这个实体所属的节点：它可能已经被删除");
    }
    return found;
  }

  /* ------------------------------- 扫描与迁移 ------------------------------- */

  async scanLibrary(full: boolean): Promise<ScanReport> {
    return this.read(async () => {
      const report = await invoke<ScanReport & { generation?: number }>("scan_library", { full });
      this.applyScan(report);
      return report;
    });
  }

  async needsMigration(): Promise<number | null> {
    // `needs_migration` 读的是磁盘上的 library.json：它不依赖已经打开的会话
    this.session.assertOpen();
    try {
      const version = await invoke<number | null>("needs_migration", {
        rootPath: this.info.rootPath,
      });
      return version;
    } catch (error) {
      throw toRepositoryError(error);
    }
  }

  async migrateLibrary(): Promise<MigrationReport> {
    return this.write(() =>
      invoke<MigrationReport>("migrate_library", { rootPath: this.info.rootPath }),
    );
  }

  async adoptFolderAsNode(relativePath: string, title?: string): Promise<KnowledgeNode> {
    return this.write(() =>
      invoke<KnowledgeNode>("adopt_folder_as_node", { relativePath, title: title ?? null }),
    );
  }

  async reassignDuplicateNodeId(relativePath: string): Promise<KnowledgeNode> {
    return this.write(() =>
      invoke<KnowledgeNode>("reassign_duplicate_node_id", { relativePath }),
    );
  }

  async openNodeFolder(nodeId: string): Promise<void> {
    return this.read(() => invoke<void>("open_node_folder", { nodeId }));
  }

  /* ------------------------------- 知识图 ------------------------------- */

  async loadGraph(): Promise<GraphSnapshot> {
    return this.read(async () => {
      const snapshot = await invoke<GraphSnapshot>("load_graph");
      this.applyRevision(snapshot.revision);
      for (const edge of snapshot.edges) this.edgeSource.set(edge.id, edge.fromId);
      return snapshot;
    });
  }

  async createNode(input: NewNodeInput): Promise<{ node: KnowledgeNode; revision: number }> {
    return this.write(async () => {
      const result = await invoke<{ node: KnowledgeNode; revision: number }>("create_node", {
        title: input.title,
        parentRelativePath: input.parentRelativePath ?? null,
      });
      this.applyRevision(result.revision);
      let node = result.node;

      if (input.aliases?.length || input.status) {
        node = await invoke<KnowledgeNode>("update_node_metadata", {
          nodeId: node.id,
          patch: {
            aliases: input.aliases ?? null,
            status: input.status ?? null,
          },
          expectedRevision: node.revision,
          expectedHash: (await this.readMetadata(node.id)).sha256,
        });
      }
      if (input.note !== undefined) {
        await invoke<WriteNoteOutcome>("write_node_note", {
          nodeId: node.id,
          content: input.note,
          expectedDocumentRevision: 0,
          // 刚建出来的节点：这份正文就是我们自己刚决定的初始内容
          force: true,
        });
      }
      return { node, revision: this.session.revision };
    });
  }

  private async readMetadata(
    nodeId: string,
  ): Promise<{ node: KnowledgeNode; revision: number; sha256: string }> {
    return invoke("read_node_metadata", { nodeId });
  }

  /**
   * 只改元数据。
   *
   * 一律走带守卫的 `update_node_metadata`：调用方没带修订号时先读一次权威元数据，
   * 宁可多一次往返，也不能盲写用户文件（设计 §5.3）。
   */
  async updateNode(
    id: string,
    patch: NodePatch,
    expected?: { expectedRevision?: number; expectedHash?: string },
  ): Promise<{ node: KnowledgeNode; revision: number }> {
    return this.write(async () => {
      // Rust 的 NodePatchView 只有 title / aliases / status：主文档字段不在其中
      const wirePatch = {
        title: patch.title ?? null,
        aliases: patch.aliases ?? null,
        status: patch.status ?? null,
      };
      let expectedRevision = expected?.expectedRevision;
      let expectedHash = expected?.expectedHash;
      if (expectedRevision === undefined || expectedHash === undefined) {
        const current = await this.readMetadata(id);
        expectedRevision = current.revision;
        expectedHash = current.sha256;
      }
      const node = await invoke<KnowledgeNode>("update_node_metadata", {
        nodeId: id,
        patch: wirePatch,
        expectedRevision,
        expectedHash,
      });
      return { node, revision: this.session.revision };
    });
  }

  async readNodeMetadata(
    nodeId: string,
  ): Promise<{ node: KnowledgeNode; revision: number; sha256: string }> {
    return this.read(() => this.readMetadata(nodeId));
  }

  async updateNodeMetadata(
    nodeId: string,
    patch: NodePatch,
    expectedRevision: number,
    expectedHash: string,
  ): Promise<KnowledgeNode> {
    return this.write(() =>
      invoke<KnowledgeNode>("update_node_metadata", {
        nodeId,
        patch: {
          title: patch.title ?? null,
          aliases: patch.aliases ?? null,
          status: patch.status ?? null,
        },
        expectedRevision,
        expectedHash,
      }),
    );
  }

  /* ------------------------------- 关系 ------------------------------- */

  async addEdge(fromId: string, toId: string, relation = ""): Promise<AddResult<DependencyEdge>> {
    return this.write(async () => {
      const outcome = await invoke<WireAddOutcome<DependencyEdge>>("add_edge", {
        fromId,
        toId,
        relation,
      });
      if (outcome.ok) {
        this.edgeSource.set(outcome.value.id, outcome.value.fromId);
        return { ok: true, value: outcome.value };
      }
      return { ok: false, reason: "cycle", cycle: outcome.cycle ?? [] };
    });
  }

  async removeEdge(edgeId: string): Promise<number> {
    return this.write(async () => {
      const fromNodeId = await this.resolveNode({ edgeId });
      const revision = await invoke<number>("remove_edge", { fromNodeId, edgeId });
      this.edgeSource.delete(edgeId);
      this.applyRevision(revision);
      return revision;
    });
  }

  async updateEdgeRelation(edgeId: string, relation: string): Promise<number> {
    return this.write(async () => {
      const fromNodeId = await this.resolveNode({ edgeId });
      const revision = await invoke<number>("update_edge_relation", {
        fromNodeId,
        edgeId,
        relation,
      });
      this.applyRevision(revision);
      return revision;
    });
  }

  async readRelations(nodeId: string): Promise<EdgeRelationSnapshot[]> {
    return this.read(async () => {
      const snapshot = await invoke<WireRelationsSnapshot>("read_relations", { nodeId });
      return snapshot.outgoing.map((edge) => ({ fromNodeId: nodeId, edge }));
    });
  }

  async writeRelations(
    nodeId: string,
    file: { nodeId: string; revision: number; outgoing: unknown[] },
    expectedRevision: number,
    expectedHash: string,
  ): Promise<number> {
    return this.write(async () => {
      const revision = await invoke<number>("write_relations", {
        nodeId,
        outgoing: file.outgoing,
        expectedRevision,
        expectedHash,
      });
      this.applyRevision(revision);
      return revision;
    });
  }

  async addEvidence(fromNodeId: string, edgeId: string, input: EvidenceInput): Promise<Evidence> {
    return this.write(() =>
      invoke<Evidence>("add_evidence", {
        fromNodeId,
        edgeId,
        threadId: input.threadId ?? null,
        messageId: input.messageId ?? null,
        snippet: input.snippet,
        question: input.question ?? "",
      }),
    );
  }

  async addPrerequisites(
    parentId: string,
    titles: string[],
  ): Promise<AddResult<AddPrerequisitesPayload>> {
    return this.write(async () => {
      const outcome = await invoke<WireAddOutcome<AddPrerequisitesPayload>>("add_prerequisites", {
        parentId,
        titles,
      });
      if (outcome.ok) {
        this.applyRevision(outcome.revision);
        return { ok: true, value: outcome.value };
      }
      return { ok: false, reason: "cycle", cycle: outcome.cycle ?? [] };
    });
  }

  async mergeNodes(sourceId: string, targetId: string): Promise<AddResult<MergePayload>> {
    return this.write(async () => {
      const outcome = await invoke<WireAddOutcome<MergePayload>>("merge_nodes", {
        sourceId,
        targetId,
      });
      if (outcome.ok) {
        this.applyRevision(outcome.revision);
        return { ok: true, value: outcome.value };
      }
      return { ok: false, reason: "cycle", cycle: outcome.cycle ?? [] };
    });
  }

  /* --------------------------- 位置与节点身份 --------------------------- */

  /** 上次所在节点是**设备侧**状态：单次调用没有修订号语义 */
  async saveSession(session: LearnSession | null): Promise<void> {
    return this.write(() => invoke<void>("save_session", { session }));
  }

  async enterNode(nodeId: string, goalId?: string): Promise<void> {
    return this.write(() => invoke<void>("enter_node", { nodeId, goalId: goalId ?? null }));
  }

  async removeNodeIdentity(nodeId: string): Promise<RemovedIdentity> {
    // `delete_node` 的 v2 语义就是「移除节点身份」：不删除用户文件夹
    return this.write(async () => {
      const entry = await invoke<RemovedIdentity>("delete_node", { nodeId });
      this.removedAt.set(entry.nodeId, entry.deletedAt);
      return entry;
    });
  }

  /* --------------------- 彻底删除（连文件夹一起删） --------------------- */

  async inspectNodeFolder(nodeId: string): Promise<NodeFolderUsage> {
    return this.read(() => invoke<NodeFolderUsage>("inspect_node_folder", { nodeId }));
  }

  async backupNodeResources(nodeId: string): Promise<NodeBackup> {
    return this.write(() => invoke<NodeBackup>("backup_node_resources", { nodeId }));
  }

  async eraseNode(nodeId: string): Promise<NodeErasure> {
    return this.write(async () => {
      const erased = await invoke<NodeErasure>("erase_node", { nodeId });
      // 节点没了，它那份「删除时刻」缓存也该清掉，否则永久清理会去找一个不存在的归档
      this.removedAt.delete(nodeId);
      return erased;
    });
  }

  async revealBackup(backupRelativePath: string): Promise<void> {
    return this.read(() => invoke<void>("reveal_backup", { backupRelativePath }));
  }

  async listRemovedIdentities(): Promise<RemovedIdentity[]> {
    return this.read(async () => {
      const entries = await invoke<RemovedIdentity[]>("list_removed_identities");
      for (const entry of entries) this.removedAt.set(entry.nodeId, entry.deletedAt);
      return entries;
    });
  }

  async restoreNodeIdentity(nodeId: string): Promise<KnowledgeNode> {
    return this.write(() =>
      invoke<KnowledgeNode>("restore_node", { nodeId, targetRelativePath: null }),
    );
  }

  async purgeRemovedIdentity(nodeId: string): Promise<void> {
    return this.write(async () => {
      let deletedAt = this.removedAt.get(nodeId);
      if (deletedAt === undefined) {
        // 界面还没读过回收站列表：先读一次拿到删除时刻（命令需要它来定位那一份归档）
        const entries = await invoke<RemovedIdentity[]>("list_removed_identities");
        for (const entry of entries) this.removedAt.set(entry.nodeId, entry.deletedAt);
        deletedAt = this.removedAt.get(nodeId);
      }
      if (deletedAt === undefined) {
        throw new RepositoryError("not_found", `回收站里没有这个节点的元数据：${nodeId}`);
      }
      await invoke<void>("purge_removed_identity", { nodeId, deletedAt });
      this.removedAt.delete(nodeId);
    });
  }

  /* -------------------------------- 笔记 -------------------------------- */

  async readNote(nodeId: string): Promise<NodeNote> {
    return this.read(() => invoke<NodeNote>("read_node_note", { nodeId }));
  }

  async writeNote(
    nodeId: string,
    content: string,
    expectedDocumentRevision: number,
    force = false,
  ): Promise<WriteNoteOutcome> {
    return this.write(async () => {
      const outcome = await invoke<WriteNoteOutcome>("write_node_note", {
        nodeId,
        content,
        expectedDocumentRevision,
        force,
      });
      // 冲突是正常返回；只有结果形状不对才算异常（否则界面会看到 undefined）
      if (outcome.status !== "saved" && outcome.status !== "conflict") {
        throw toRepositoryError({
          code: "internal",
          message: "保存笔记返回了无法识别的结果",
          detail: outcome,
        });
      }
      return outcome;
    });
  }

  async checkNote(nodeId: string): Promise<NoteDiskState> {
    return this.read(() => invoke<NoteDiskState>("check_node_note", { nodeId }));
  }

  /* -------------------------------- 资料 -------------------------------- */

  async listResources(nodeId: string): Promise<NodeResource[]> {
    return this.read(async () => {
      const resources = await invoke<NodeResource[]>("list_node_resources", { nodeId });
      for (const resource of resources) this.resourceNode.set(resource.id, nodeId);
      return resources;
    });
  }

  async listPlainFiles(nodeId: string): Promise<NodeFileEntry[]> {
    return this.read(() => invoke<NodeFileEntry[]>("list_node_plain_files", { nodeId }));
  }

  async addResourceFile(
    nodeId: string,
    sourcePath: string,
    displayName?: string,
  ): Promise<{ resource: NodeResource; revision: number }> {
    return this.write(async () => {
      const result = await invoke<{ resource: NodeResource; revision: number }>(
        "add_resource_file",
        { nodeId, sourcePath, displayName: displayName ?? null },
      );
      this.resourceNode.set(result.resource.id, nodeId);
      this.applyRevision(result.revision);
      return result;
    });
  }

  async addResourceUrl(
    nodeId: string,
    url: string,
    displayName?: string,
    description?: string,
  ): Promise<{ resource: NodeResource; revision: number }> {
    return this.write(async () => {
      const result = await invoke<{ resource: NodeResource; revision: number }>(
        "add_resource_url",
        { nodeId, url, displayName: displayName ?? null, description: description ?? null },
      );
      this.resourceNode.set(result.resource.id, nodeId);
      this.applyRevision(result.revision);
      return result;
    });
  }

  async updateResource(
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<{ resource: NodeResource; revision: number }> {
    return this.write(async () => {
      const nodeId = await this.resolveNode({ resourceId });
      const result = await invoke<{ resource: NodeResource; revision: number }>("update_resource", {
        nodeId,
        resourceId,
        patch: {
          displayName: patch.displayName ?? null,
          description: patch.description ?? null,
          sortOrder: patch.sortOrder ?? null,
        },
      });
      this.applyRevision(result.revision);
      return result;
    });
  }

  async openResource(resourceId: string): Promise<void> {
    return this.read(async () => {
      const nodeId = await this.resolveNode({ resourceId });
      await invoke<void>("open_resource", { nodeId, resourceId });
    });
  }

  async revealResource(resourceId: string): Promise<void> {
    return this.read(async () => {
      const nodeId = await this.resolveNode({ resourceId });
      await invoke<void>("reveal_resource", { nodeId, resourceId });
    });
  }

  async deleteResource(resourceId: string, deleteFile = false): Promise<number> {
    return this.write(async () => {
      const nodeId = await this.resolveNode({ resourceId });
      const revision = await invoke<number>("delete_resource", {
        nodeId,
        resourceId,
        deleteFile,
      });
      this.resourceNode.delete(resourceId);
      this.applyRevision(revision);
      return revision;
    });
  }

  async annotatePlainFile(nodeId: string, relativePath: string): Promise<NodeResource> {
    return this.write(async () => {
      const resource = await invoke<NodeResource>("annotate_plain_file", {
        nodeId,
        relativePath,
      });
      this.resourceNode.set(resource.id, nodeId);
      return resource;
    });
  }

  /* ---------------------------- 完整性与修复 ---------------------------- */

  async checkIntegrity(deep: boolean): Promise<IntegrityReport> {
    return this.read(() => invoke<IntegrityReport>("check_library_integrity", { deep }));
  }

  async repairLibrary(actions: RepairAction[]): Promise<RepairReport> {
    return this.write(async () => {
      const report = await invoke<RepairReport>("repair_library", { actions });
      this.applyRevision(report.report.revision);
      return report;
    });
  }

  /* -------------------------------- 对话 -------------------------------- */

  async listThreads(nodeId: string): Promise<ChatThread[]> {
    return this.read(async () => {
      const threads = await invoke<WireThread[]>("list_threads", { nodeId });
      return this.rememberThreads(nodeId, threads);
    });
  }

  async loadThread(threadId: string): Promise<{ thread: ChatThread; messages: ChatMessage[] }> {
    return this.read(async () => {
      const loaded = await invoke<{ thread: WireThread; messages: ChatMessage[] }>("load_thread", {
        threadId,
      });
      this.threadNode.set(loaded.thread.id, loaded.thread.nodeId);
      if (typeof loaded.thread.revision === "number") {
        this.threadRevision.set(loaded.thread.id, loaded.thread.revision);
      }
      for (const message of loaded.messages) {
        this.messageThread.set(message.id, message.threadId);
      }
      return { thread: loaded.thread, messages: loaded.messages };
    });
  }

  async createThread(nodeId: string, title?: string): Promise<ChatThread> {
    return this.write(async () => {
      const thread = await invoke<WireThread>("create_thread", {
        nodeId,
        title: title ?? null,
      });
      this.threadNode.set(thread.id, nodeId);
      if (typeof thread.revision === "number") this.threadRevision.set(thread.id, thread.revision);
      return thread;
    });
  }

  async saveThread(thread: ChatThread): Promise<void> {
    return this.write(async () => {
      const expectedRevision = await this.threadRevisionFor(thread);
      const saved = await invoke<WireThread>("save_thread", {
        thread,
        expectedRevision,
      });
      this.threadNode.set(saved.id, saved.nodeId);
      // 保存成功后立刻记下新一代修订号：界面上那个对象仍是旧快照，
      // 下一次保存（改标题 / 刷新更新时间）必须以这里为准。
      if (typeof saved.revision === "number") this.threadRevision.set(saved.id, saved.revision);
    });
  }

  /**
   * 让 AI 用第一轮问答起一个标题。
   *
   * 失败不抛异常而是返回 `null`：起不出标题是锦上添花的事，
   * 不该让它变成一个红色报错。Rust 侧同样把网络失败收敛成 `None`。
   */
  async suggestThreadTitle(threadId: string): Promise<string | null> {
    return this.read(async () => {
      const title = await invoke<string | null>("suggest_thread_title", { threadId });
      const clean = title?.trim();
      return clean ? clean : null;
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    return this.write(async () => {
      const nodeId = await this.resolveNode({ threadId });
      await invoke<void>("delete_thread", { nodeId, threadId });
      this.threadNode.delete(threadId);
    });
  }

  async saveMessage(message: ChatMessage): Promise<void> {
    return this.write(async () => {
      const nodeId = await this.resolveNode({ threadId: message.threadId });
      await invoke<ChatMessage>("save_message", {
        nodeId,
        threadId: message.threadId,
        message,
      });
      this.messageThread.set(message.id, message.threadId);
    });
  }

  async deleteMessage(messageId: string): Promise<void> {
    return this.write(async () => {
      const threadId = this.messageThread.get(messageId);
      if (!threadId) {
        throw new RepositoryError("not_found", `消息不存在：${messageId}`);
      }
      const nodeId = await this.resolveNode({ threadId });
      await invoke<void>("delete_message", { nodeId, threadId, messageId });
      this.messageThread.delete(messageId);
    });
  }

  /**
   * 读某个节点的书签。
   *
   * **注意**：契约 §4 的命令清单里没有 `list_bookmarks`（见
   * `docs/v2-deviations.md` F3）。桌面端暂时只能明确失败，让 `chatStore`
   * 降级成「这个节点没有书签」，而不是让整个节点打不开。
   */
  private async fetchBookmarksRaw(nodeId: string): Promise<Bookmark[]> {
    const result = await invoke<Bookmark[] | null>("list_bookmarks", { nodeId }).catch(() => null);
    return result ?? [];
  }

  async listBookmarks(nodeId: string): Promise<Bookmark[]> {
    return this.read(async () => {
      const bookmarks = await this.fetchBookmarksRaw(nodeId);
      for (const bookmark of bookmarks) this.bookmarkNode.set(bookmark.id, nodeId);
      return bookmarks;
    });
  }

  async saveBookmark(bookmark: Bookmark): Promise<void> {
    return this.write(async () => {
      const saved = await invoke<Bookmark>("save_bookmark", {
        nodeId: bookmark.nodeId,
        bookmark,
      });
      this.bookmarkNode.set(saved.id, saved.nodeId);
    });
  }

  async deleteBookmark(bookmarkId: string): Promise<void> {
    return this.write(async () => {
      const nodeId = await this.resolveNode({ bookmarkId });
      await invoke<void>("delete_bookmark", { nodeId, bookmarkId });
      this.bookmarkNode.delete(bookmarkId);
    });
  }
}
