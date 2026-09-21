/**
 * 存储抽象层（Repository / LibrarySession）
 *
 * 界面和业务逻辑只依赖这里的接口，不直接接触开放文件、SQLite 或浏览器存储。
 *
 * v2 的关键差别：
 * - 知识资产是**开放文件**（`node.json` / `relations.json` / `chats/**`），
 *   SQLite 只是 AppData 里可删除、可重建的设备索引；因此接口里多了
 *   `scanLibrary`（扫描/重建）与 `needsMigration` / `migrateLibrary`；
 * - 对话**按节点/线程懒加载**：`loadChat()`（全库一次读全部正文）已删除，
 *   改为 `listThreads(nodeId)` + `loadThread(threadId)`；
 * - 「删除节点」变成「移除节点身份」：只把 `.meta/knowledgenet` 移进回收站，
 *   用户文件夹与其中的普通文件原位不动；
 * - 元数据写接口携带 `expectedRevision` / `expectedHash`：磁盘被外部改过时
 *   返回 `external_change_conflict`，默认绝不覆盖。
 *
 * 与旧版一样：**没有进程级单例**。一个 Repository 绑定一次「打开知识库」的会话；
 * 切换知识库时旧的 Repository 必须被丢弃。
 */
import type { Bookmark, ChatMessage, ChatThread } from "./chatTypes.ts";
import type {
  AddPrerequisitesPayload,
  AddResult,
  CopyMode,
  CopyResult,
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
  RecentLibrary,
  RemovedIdentity,
  RepairAction,
  RepairReport,
  ResourcePatch,
  ScanReport,
  WriteNoteOutcome,
} from "./types.ts";
import type { V2RelationEdge, V2RelationsFile } from "./v2/schema.ts";

/**
 * `tauri-portable`：桌面端，完整便携知识库能力，是正式产品路径。
 * `browser-demo`：浏览器开发模式，只用于图形与交互演示，数据临时、功能降级。
 */
export type BackendKind = "tauri-portable" | "browser-demo";

/** 一条关系的完整快照（含边 ID 与来源），供关系编辑界面使用 */
export interface EdgeRelationSnapshot {
  fromNodeId: string;
  edge: V2RelationEdge;
}

export interface Repository {
  readonly kind: BackendKind;
  /** 浏览器演示模式为 true：界面必须明确提示「不是便携知识库」 */
  readonly isDemo: boolean;
  /** 打开时的知识库摘要（含扫描计数快照，仅供参考；最新值以各方法返回为准） */
  readonly info: LibraryInfo;

  /* ------------------------------- 扫描与迁移 ------------------------------- */

  /** 递归扫描知识库并重建派生索引；`full` 表示冷扫描 */
  scanLibrary(full: boolean): Promise<ScanReport>;
  /** 需要 v1 -> v2 迁移时返回 1，已经是 v2 返回 2，无法判断返回 null */
  needsMigration(): Promise<number | null>;
  /** 一次性迁移（带恢复点、重扫比对、最后才发布 v2） */
  migrateLibrary(): Promise<MigrationReport>;
  /** 把知识库里已有的普通文件夹认领为节点：只写元数据，不移动任何文件 */
  adoptFolderAsNode(relativePath: string, title?: string): Promise<KnowledgeNode>;
  /** 重复 ID 修复：给副本分配新 ID（同时更新副本自己的线程与出边归属） */
  reassignDuplicateNodeId(relativePath: string): Promise<KnowledgeNode>;
  /** 在系统文件管理器中打开节点文件夹 */
  openNodeFolder(nodeId: string): Promise<void>;

  /* ------------------------------- 知识图 ------------------------------- */

  /** 载入轻量图快照：**不含任何笔记正文与附件，也不含对话正文** */
  loadGraph(): Promise<GraphSnapshot>;

  /** 删除目标本身；其下知识点可能被其它目标共享，因此保留 */

  createNode(input: NewNodeInput): Promise<{ node: KnowledgeNode; revision: number }>;
  /** 只改元数据：标题、别名、状态、主文档。改标题不会重命名节点目录。 */
  updateNode(
    id: string,
    patch: NodePatch,
    expected?: { expectedRevision?: number; expectedHash?: string },
  ): Promise<{ node: KnowledgeNode; revision: number }>;

  /** 读节点的权威元数据与指纹（界面要拿到修订号才能安全地改） */
  readNodeMetadata(
    nodeId: string,
  ): Promise<{ node: KnowledgeNode; revision: number; sha256: string }>;
  updateNodeMetadata(
    nodeId: string,
    patch: NodePatch,
    expectedRevision: number,
    expectedHash: string,
  ): Promise<KnowledgeNode>;

  addEdge(fromId: string, toId: string, relation?: string): Promise<AddResult<DependencyEdge>>;
  removeEdge(edgeId: string): Promise<number>;
  updateEdgeRelation(edgeId: string, relation: string): Promise<number>;
  /** 读某个节点的全部出边（关系改接界面用；文件里就是权威版本） */
  readRelations(nodeId: string): Promise<EdgeRelationSnapshot[]>;
  writeRelations(nodeId: string, file: V2RelationsFile, expectedRevision: number, expectedHash: string): Promise<number>;
  /** 选中文字 -> 来源记录，写进该关系所在的 `relations.json` */
  addEvidence(fromNodeId: string, edgeId: string, input: EvidenceInput): Promise<Evidence>;

  /**
   * 批量新增前置知识（对应「要搞懂 B，得先搞懂 C\D\E」）。
   * titles 中每一项若已存在同名/同别名节点则复用，只新增关系；否则新建节点。
   */
  addPrerequisites(parentId: string, titles: string[]): Promise<AddResult<AddPrerequisitesPayload>>;

  /**
   * 合并重复节点：转移全部关系、去重、合并笔记与别名、处理目标引用。
   * 必须同时转移挂在源节点/被丢弃边上的对话、书签与来源。
   * 可能形成循环依赖时整体不落地，返回 ok: false。
   */
  mergeNodes(sourceId: string, targetId: string): Promise<AddResult<MergePayload>>;

  /** 记录「当前在看哪个节点」，用于重启后回到原位（设备侧状态） */
  saveSession(session: LearnSession | null): Promise<void>;
  enterNode(nodeId: string, goalId?: string): Promise<void>;

  /* ------------------------------ 节点身份生命周期 ------------------------------ */

  /** 移除节点身份：`.meta/knowledgenet` 进回收站，用户文件原位保留 */
  removeNodeIdentity(nodeId: string): Promise<RemovedIdentity>;
  listRemovedIdentities(): Promise<RemovedIdentity[]>;
  restoreNodeIdentity(nodeId: string): Promise<KnowledgeNode>;
  /** 永久清理回收站里的元数据副本（仍然不动用户文件） */
  purgeRemovedIdentity(nodeId: string): Promise<void>;

  /* ---------------------------- 彻底删除与备份 ---------------------------- */

  /** 删除前的体检：文件夹里有多少文件、多大、里面还套着几个下级知识点 */
  inspectNodeFolder(nodeId: string): Promise<NodeFolderUsage>;
  /** 把整个节点文件夹整份复制到 `.knowledgenet/backups/`，供「接着就彻底删除」使用 */
  backupNodeResources(nodeId: string): Promise<NodeBackup>;
  /**
   * **彻底删除**：文件夹连同里面的文件一起从磁盘上删掉，不可撤销。
   *
   * 调用方（界面）必须先说明后果并给出备份入口：这是唯一会删用户文件的动作。
   */
  eraseNode(nodeId: string): Promise<NodeErasure>;
  /** 在文件管理器里打开一个备份目录（只接受备份目录内的路径） */
  revealBackup(backupRelativePath: string): Promise<void>;

  /* -------------------------------- 笔记 -------------------------------- */

  /** 按需读取主文档（通常是节点目录里的 `note.md`）的权威版本 */
  readNote(nodeId: string): Promise<NodeNote>;
  /**
   * 保存笔记。必须携带手上那份的文档修订号；
   * 修订号过期或磁盘哈希与登记不一致时**不得静默覆盖**，返回 conflict 让用户决定。
   */
  writeNote(
    nodeId: string,
    content: string,
    expectedDocumentRevision: number,
    force?: boolean,
  ): Promise<WriteNoteOutcome>;
  /** 检查磁盘上的正文是否被外部改动（进入节点、窗口重新获得焦点时调用） */
  checkNote(nodeId: string): Promise<NoteDiskState>;

  /* -------------------------------- 资料 -------------------------------- */

  listResources(nodeId: string): Promise<NodeResource[]>;
  /** 列出节点目录里的普通文件（排除 `.meta/**` 与嵌套节点子树） */
  listPlainFiles(nodeId: string): Promise<NodeFileEntry[]>;
  /** 把用户选中的文件复制进节点目录（源路径来自系统文件选择器） */
  addResourceFile(
    nodeId: string,
    sourcePath: string,
    displayName?: string,
  ): Promise<{ resource: NodeResource; revision: number }>;
  addResourceUrl(
    nodeId: string,
    url: string,
    displayName?: string,
    description?: string,
  ): Promise<{ resource: NodeResource; revision: number }>;
  updateResource(
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<{ resource: NodeResource; revision: number }>;
  /** 用系统默认程序打开（前端只传 resourceId，不传路径） */
  openResource(resourceId: string): Promise<void>;
  /** 在资源管理器中显示 */
  revealResource(resourceId: string): Promise<void>;
  /** 解除资料登记；`deleteFile` 为真时才删除实际文件 */
  deleteResource(resourceId: string, deleteFile?: boolean): Promise<number>;
  /** 把节点目录里已有的普通文件登记成资料（补充展示名与说明） */
  annotatePlainFile(nodeId: string, relativePath: string): Promise<NodeResource>;

  /* ---------------------------- 完整性与修复 ---------------------------- */

  checkIntegrity(deep: boolean): Promise<IntegrityReport>;
  /** 只接受「意图唯一、无数据损失」的修复动作 */
  repairLibrary(actions: RepairAction[]): Promise<RepairReport>;

  /* -------------------------------- 对话 -------------------------------- */

  /** 只读线程头（不读消息正文），进入节点时调用 */
  listThreads(nodeId: string): Promise<ChatThread[]>;
  /** 懒加载一个线程的消息正文 */
  loadThread(threadId: string): Promise<{ thread: ChatThread; messages: ChatMessage[] }>;
  createThread(nodeId: string, title?: string): Promise<ChatThread>;
  saveThread(thread: ChatThread): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  /**
   * 用第一轮问答让 AI 给这个对话起一个短标题。
   *
   * **只读**：调用方拿到标题后自己决定是否 `renameThread`——只有界面知道
   * 用户是不是已经手动改过名字。起不出来（没配 Key、网络失败、模型没给出可用的
   * 一行字）返回 `null`，**不是错误**。
   */
  suggestThreadTitle(threadId: string): Promise<string | null>;
  saveMessage(message: ChatMessage): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;

  /** 某节点的书签（写在节点自己的 `bookmarks.json` 里） */
  listBookmarks(nodeId: string): Promise<Bookmark[]>;
  saveBookmark(bookmark: Bookmark): Promise<void>;
  deleteBookmark(bookmarkId: string): Promise<void>;
}

/**
 * 一次打开的知识库会话。
 *
 * 组件不得长期持有 `repository`：切库后旧 session 会被 `close()`，
 * 之后所有调用都应抛出「会话已关闭」而不是把数据写进新库。
 */
export interface LibrarySession {
  readonly sessionId: string;
  readonly libraryId: string;
  readonly info: LibraryInfo;
  readonly repository: Repository;
  /** 会话是否仍然有效（切库/关库后为 false） */
  readonly valid: boolean;
  close(): Promise<void>;
}

/**
 * 知识库生命周期（设备级能力）。
 *
 * 桌面端走真实文件夹与设备索引；浏览器演示端只提供假的“演示知识库”，
 * 且必须在界面上说明数据不会保存成便携知识库。
 */
export interface LibraryController {
  readonly isDemo: boolean;
  /** 最近打开列表（设备级记录，删掉 AppData 只丢这份列表，不丢知识内容） */
  listRecentLibraries(): Promise<RecentLibrary[]>;
  removeRecentLibrary(path: string): Promise<void>;
  /** 在 `parentDir` 下新建子目录作为知识库 */
  createLibrary(parentDir: string, name: string, title?: string): Promise<LibrarySession>;
  openLibrary(rootPath: string, allowReadOnly?: boolean): Promise<LibrarySession>;
  closeLibrary(): Promise<void>;
  currentLibraryInfo(): Promise<LibraryInfo | null>;
  /** 运行中创建一致性副本；`snapshot` 保留原 libraryId，`independent` 生成新 ID */
  createLibraryCopy(targetParentDir: string, name: string, mode: CopyMode): Promise<CopyResult>;
  /** 系统文件夹选择器；浏览器演示模式返回 null */
  pickDirectory(title?: string): Promise<string | null>;
  /** 系统文件选择器（可多选） */
  pickFiles(): Promise<string[]>;
}

export type { Bookmark, ChatMessage, ChatThread };
export type {
  AddPrerequisitesPayload,
  MergePayload,
  MigrationReport,
  NodeFileEntry,
  NodeNote,
  NodeResource,
  IntegrityReport,
  LibraryInfo,
  RecentLibrary,
  RemovedIdentity,
};
