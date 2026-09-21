//! KnowledgeNet —— 本地优先的学习依赖图工具
//!
//! `A → B` 表示「为了理解 A，需要先理解 B」。底层始终保存节点与关系，
//! 树形只是其中一种显示方式；节点可以在多处被复用，从而构成网状结构。
//!
//! ## 知识库格式 v2（见 `docs/v2-contract.md`）
//!
//! ```text
//! 节点   = 普通文件夹 + .meta/knowledgenet/node.json
//! 对话   = 节点文件夹内 .meta/knowledgenet/chats/<threadId>/…
//! 关系   = 发起依赖的节点目录内 .meta/knowledgenet/relations.json（只存出边）
//! 设备索引 = AppData/…/indexes/<libraryId>/index.sqlite（可删除、可重建）
//! ```
//!
//! 三条硬保证：
//! - 启动时**可以没有知识库**：`AppState.library` 是 `Option`，打开之后才有；
//! - 知识资产全部是知识库文件夹里的开放文件，删掉 AppData 与旧 `knowledge.sqlite`
//!   之后仍然能完整重建节点、关系、对话与它们的引用；
//! - 「从知识库移除节点身份」只移走 `.meta/knowledgenet`，**不删除任何用户文件**。

pub mod deepseek;
pub mod device;
pub mod library;
pub mod models;
pub mod paths;
pub mod v2;

use tauri::{Manager, WindowEvent};

use deepseek::AiState;
use v2::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 文件夹/文件选择器走 Rust 侧调用：前端不需要任何文件系统权限
        .plugin(tauri_plugin_dialog::init())
        .manage(AiState::default())
        // 启动时没有打开的知识库是正常状态，而不是错误
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            /* 设备级 */
            v2::commands::load_device_settings,
            v2::commands::remove_recent_library,
            v2::commands::pick_directory,
            v2::commands::pick_files,
            v2::commands::load_library_ui_state,
            v2::commands::save_library_ui_state,
            /* 知识库生命周期 */
            v2::commands::create_library,
            v2::commands::open_library,
            v2::commands::close_library,
            v2::commands::current_library_info,
            v2::commands::create_library_copy,
            v2::commands::check_library_integrity,
            v2::commands::repair_library,
            v2::commands::scan_library,
            v2::commands::rebuild_device_index,
            v2::commands::needs_migration,
            v2::commands::migrate_library,
            /* 图谱 */
            v2::commands::load_graph,
            v2::commands::create_node,
            v2::commands::update_node,
            v2::commands::delete_node,
            v2::commands::restore_node,
            v2::commands::list_removed_identities,
            v2::commands::purge_removed_identity,
            v2::commands::adopt_folder_as_node,
            v2::commands::reassign_duplicate_node_id,
            v2::commands::open_node_folder,
            v2::commands::inspect_node_folder,
            v2::commands::backup_node_resources,
            v2::commands::erase_node,
            v2::commands::reveal_backup,
            v2::commands::read_node_metadata,
            v2::commands::update_node_metadata,
            /* 关系 */
            v2::commands::add_edge,
            v2::commands::remove_edge,
            v2::commands::update_edge_relation,
            v2::commands::add_prerequisites,
            v2::commands::merge_nodes,
            v2::commands::read_relations,
            v2::commands::write_relations,
            v2::commands::add_evidence,
            /* 笔记 */
            v2::commands::read_node_note,
            v2::commands::write_node_note,
            v2::commands::check_node_note,
            /* 资料 */
            v2::commands::list_node_resources,
            v2::commands::list_node_plain_files,
            v2::commands::add_resource_file,
            v2::commands::add_resource_url,
            v2::commands::update_resource,
            v2::commands::open_resource,
            v2::commands::reveal_resource,
            v2::commands::delete_resource,
            v2::commands::annotate_plain_file,
            /* 位置与对话 */
            v2::commands::save_session,
            v2::commands::enter_node,
            v2::commands::list_threads,
            v2::commands::load_thread,
            v2::commands::create_thread,
            v2::commands::save_thread,
            v2::commands::delete_thread,
            v2::commands::save_message,
            v2::commands::delete_message,
            v2::commands::list_bookmarks,
            v2::commands::save_bookmark,
            v2::commands::delete_bookmark,
            /* 对话标题 */
            v2::commands::suggest_thread_title,
            /* AI */
            v2::commands::save_ai_config,
            v2::commands::save_api_key,
            v2::commands::clear_api_key,
            v2::commands::test_ai_connection,
            v2::commands::start_chat,
            v2::commands::cancel_chat,
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                // 关窗时中止仍在进行的生成，避免留下悬挂的网络任务
                v2::commands::cancel_all_chats(window.app_handle());
                // 把知识库收尾：停掉文件监听、释放写锁。
                // v2 的每次写入都是原子的，所以不需要 checkpoint/WAL。
                v2::commands::shutdown_library(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("启动 KnowledgeNet 失败");
}
