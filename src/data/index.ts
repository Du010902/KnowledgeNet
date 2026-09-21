/**
 * 数据层统一出口
 *
 * 这里**只做 re-export**：不再有进程级 Repository 单例。
 * 打开哪个知识库由 `session.ts` 的会话注册表决定，组件必须通过
 * `getRepository()` 获取当前会话的仓库。
 *
 * v2 新增：`./v2` 的开放文件模型（`node.json` / `relations.json` / `chats/**` 的
 * 解析、校验、扫描与读写）以及按 `libraryId` 分区的设备布局读写。
 */
export { isTauri } from "./platform.ts";

export {
  getLibraryController,
  getDeviceSettingsController,
  getCurrentSession,
  getRepository,
  subscribeSession,
  setCurrentSession,
} from "./session.ts";

export { createManagedSession, ManagedLibrarySession } from "./librarySession.ts";
export type { RepositorySession, ManagedSessionOptions } from "./librarySession.ts";

export {
  RepositoryError,
  toRepositoryError,
  sessionClosedError,
  externalChangeConflict,
  isExternalChangeConflict,
} from "./errors.ts";

export {
  WORKSPACE_LAYOUT_PREFIX,
  workspaceLayoutKey,
  readWorkspaceLayout,
  writeWorkspaceLayout,
  clearWorkspaceLayout,
} from "./deviceSettings.ts";
export type {
  DeviceSettings,
  DeviceSettingsController,
  WorkspaceLayoutSnapshot,
} from "./deviceSettings.ts";

export type {
  BackendKind,
  EdgeRelationSnapshot,
  LibraryController,
  LibrarySession,
  Repository,
} from "./repository.ts";

export {
  STATUS_LABEL,
  STATUS_ORDER,
  LIBRARY_FORMAT,
  LIBRARY_FORMAT_VERSION,
  emptySnapshot,
  normalizeTitle,
  searchKey,
  isUuid,
} from "./types.ts";
export type {
  AddPrerequisitesPayload,
  AddResult,
  CopyMode,
  CopyResult,
  DependencyEdge,
  DroppedEdgeRef,
  Evidence,
  EvidenceInput,
  Goal,
  GraphSnapshot,
  IntegrityCounts,
  IntegrityIssue,
  IntegrityReport,
  KnowledgeNode,
  LearnSession,
  LearnStatus,
  LibraryInfo,
  MergePayload,
  MigrationCounts,
  MigrationReport,
  NewNodeInput,
  NodeFileEntry,
  NodeHealth,
  NodeNote,
  NodePatch,
  NodeResource,
  NoteConflict,
  NoteDiskState,
  RecentLibrary,
  RemovedIdentity,
  RepairAction,
  RepairOutcome,
  RepairReport,
  ResourcePatch,
  ResourceType,
  ScanIssue,
  ScanReport,
  WriteNoteOutcome,
} from "./types.ts";

export {
  emptyChatData,
  normalizeLoadedMessages,
  selectionToTitle,
} from "./chatTypes.ts";
export type {
  Bookmark,
  ChatData,
  ChatMessage,
  ChatRole,
  ChatThread,
  Discovery,
  MessageStatus,
} from "./chatTypes.ts";

export { applyMergeToChatData, applyNodeDeleteToChatData } from "./chatRepository.ts";
export type { ChatMergeTransfer } from "./chatRepository.ts";

export {
  buildGraphExchange,
  parseGraphExchange,
  GRAPH_EXCHANGE_FORMAT,
  GRAPH_EXCHANGE_VERSION,
  GRAPH_EXCHANGE_NOTE,
} from "./backup.ts";
export type { GraphExchange } from "./backup.ts";

export {
  edgeBetween,
  edgeMap,
  findAllCycles,
  findCycleIfLinked,
  findExactMatch,
  findSimilar,
  nodeMap,
  nodesByIds,
  planMerge,
  planPrerequisites,
  prerequisitesOf,
  dependentsOf,
  referenceCount,
  searchNodes,
  titleOf,
} from "./engine.ts";
export type {
  GraphView,
  MergePlan,
  PlannedEdge,
  PlannedPrerequisite,
  PrerequisitePlan,
} from "./engine.ts";

export { newUuid, newUniqueUuid } from "./uuid.ts";
export { SerialQueue } from "./serialQueue.ts";

export { BrowserRepository, DEMO_BACKEND_LABEL } from "./browserRepository.ts";
export { DemoLibraryController, DEMO_WARNING } from "./browserLibraryController.ts";
export { TauriRepository } from "./tauriRepository.ts";
export { TauriLibraryController } from "./tauriLibraryController.ts";

export * as v2 from "./v2/index.ts";
