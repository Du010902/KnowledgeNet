//! 知识库格式 v2：节点是普通文件夹 + 自描述元数据，SQLite 降级为可重建的设备索引。
//!
//! 冻结契约见 `docs/v2-contract.md`。模块分工：
//!
//! - [`schema`]   JSON 模型、校验、未知字段保留
//! - [`atomic`]   原子写 + 修订号/哈希守卫（外部改动绝不静默覆盖）
//! - [`vpaths`]   节点内 `.meta/knowledgenet` 路径计算（纯函数）
//! - [`ctx`]      打开会话的最小上下文 `LibCtx`（路径安全集中在这里）
//! - [`scanner`]  递归发现节点、边界、重复 ID、问题报告
//! - [`index`]    AppData 里的派生 SQLite 索引（可删除、可重建）
//! - [`watcher`]  文件事件 → 防抖 → 前端事件
//! - [`nodes`]    节点身份生命周期（新建 / 认领 / 移除 / 恢复 / 重编 ID）
//! - [`relations`] 按源节点存储的出边
//! - [`notes`]    主文档读写与冲突保护
//! - [`resources`] 普通文件枚举 + 可选注释
//! - [`bookmarks`] 书签与知识库级学习目标
//! - [`chats`]    线程 / 消息文件、懒加载与流式检查点
//! - [`migrate`]  v1 -> v2 一次性迁移
//! - [`state`]    打开会话（锁、清单、索引、代次、监听）
//! - [`commands`] Tauri 命令层（唯一数据出入口）

pub mod atomic;
pub mod bookmarks;
pub mod chats;
pub mod commands;
pub mod ctx;
pub mod index;
pub mod migrate;
pub mod nodes;
pub mod notes;
pub mod relations;
pub mod resources;
pub mod scanner;
pub mod schema;
pub mod state;
pub mod vpaths;
pub mod watcher;

pub use atomic::Fingerprint;
pub use ctx::LibCtx;
pub use schema::{
    BookmarksFile, GoalEntry, GoalsFile, LibraryManifest, MessageFile, MessageStatus, NodeMeta,
    RelationEdge, RelationsFile, ResourceEntry, ResourcesFile, ThreadFile, Validate,
    BOOKMARKS_FORMAT, BOOKMARKS_FORMAT_VERSION, GOALS_FORMAT, GOALS_FORMAT_VERSION,
    LIBRARY_FORMAT, LIBRARY_FORMAT_VERSION, MESSAGE_FORMAT, MESSAGE_FORMAT_VERSION, NODE_FORMAT,
    NODE_FORMAT_VERSION, RELATIONS_FORMAT, RELATIONS_FORMAT_VERSION, RESOURCES_FORMAT,
    RESOURCES_FORMAT_VERSION, THREAD_FORMAT, THREAD_FORMAT_VERSION,
};
