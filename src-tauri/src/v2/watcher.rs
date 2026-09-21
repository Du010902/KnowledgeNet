//! 文件监听：notify + 防抖 + 重命名归并 + 前端事件。实现者：rust-scan-index。
//!
//! 契约 `docs/v2-contract.md` §3.13、设计文档 §5.2。
//!
//! 这里只做**通知**，不做解释：真正「这次改动意味着什么」由命令层重新扫描后
//! 按 node ID 重定位（§5.2：文件夹改名不能按「删除 + 新建」立刻丢节点）。
//! 所以整条链路的形状是：
//!
//! ```text
//! notify 事件 → 过滤（排除目录 / 临时文件）→ 防抖合并 300~500ms
//!            → ChangeEvent { kind: "changed" | "rescan" } → 前端
//!            → 前端防抖后调 scan_library(false) → 命令层重扫 + 重定位
//! ```
//!
//! 三个刻意的选择：
//!
//! 1. **只发信号，不自己扫库**：watcher 线程碰索引或元数据会制造写-监听回环。
//! 2. **`.meta/**` 一律过滤**（连同 `.git` / `node_modules` / `.knowledgenet`）：
//!    我们自己写元数据、写流式消息检查点都在 `.meta` 下，不过滤就会自己触发自己。
//! 3. **保存不了就退化成「重新扫描」**：`rescan` 永远安全，只是贵一点；
//!    `changed` 只用于能确定是内容改动的场景（文件夹改名的信号常常长得像新建+删除）。
//!
//! 可测试性：过滤规则、事件归类、防抖合并全部是纯函数/纯结构，
//! 单元测试不需要真的去动文件系统。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::models::{CmdError, CmdResult};

use super::scanner::DirFilter;
use super::vpaths;

/// 前端事件名（冻结）
pub const EVENT_NAME: &str = "knowledgenet://library-changed";

/// 防抖窗口。设计文档 §5.2 要求 300~500ms：够长到能吃掉「一次保存产生的七八个事件」，
/// 够短到用户感觉不出延迟。
pub const DEFAULT_DEBOUNCE_MS: u64 = 400;

/// 单批最多带多少条路径；超出就置 `truncated`，让前端直接走整库重扫。
pub const MAX_PENDING_PATHS: usize = 256;

/// 我们自己的临时文件前缀（`atomic::write_text` 与操作日志用）。
/// 临时文件的事件既不该刷新界面，也不该被当成资产。
pub const TEMP_FILE_PREFIXES: [&str; 2] = [".kn-tmp-", ".kn-op-"];

/// 监听线程的轮询间隔：stop 标志最多延迟这么久被看到。
const TICK: Duration = Duration::from_millis(100);

/// `ChangeEvent.kind` 的取值
pub mod kind {
    /// 内容变了（消息、笔记、资源文件…），前端按需刷新即可
    pub const CHANGED: &str = "changed";
    /// 结构可能变了（文件夹新建/删除/改名），必须重新扫描后按 node ID 重定位
    pub const RESCAN: &str = "rescan";
}

/* --------------------------------- 事件 --------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub library_id: String,
    pub generation: u64,
    /// `changed` | `rescan`
    pub kind: String,
    /// 相对知识库根的正斜杠路径，已排序去重
    pub paths: Vec<String>,
    /// 路径太多（超过 [`MAX_PENDING_PATHS`]）时为 true：前端应直接整库重扫
    pub truncated: bool,
}

/// 扇出前的合并结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingChange {
    pub paths: Vec<String>,
    pub kind: &'static str,
    pub truncated: bool,
}

/* ------------------------------ 代次来源 ------------------------------ */

/// 「事件带上哪一代」的来源。
///
/// 契约 §3.13 写的是 `generation: u64`，而 `state.rs` 持有的是
/// `Arc<AtomicU64>`（切库/重扫时递增）。两种都支持：
/// `u64` 是发事件那一刻的快照，`Arc<AtomicU64>` 是发事件时读到的**当前**代次
/// ——后者才能保证「旧库的事件不会进新库」（§9.2）。见 `docs/v2-deviations.md`。
pub trait GenerationSource: Send + 'static {
    fn current(&self) -> u64;
}

impl GenerationSource for u64 {
    fn current(&self) -> u64 {
        *self
    }
}

impl GenerationSource for Arc<AtomicU64> {
    fn current(&self) -> u64 {
        self.load(Ordering::SeqCst)
    }
}

/* ------------------------------ 过滤器 ------------------------------ */

/// 事件路径过滤器：目录排除规则与扫描器**共用一份实现**（`scanner::DirFilter`），
/// 否则「扫的时候不算资产、改的时候却报事件」这种不一致迟早会出现。
pub struct PathFilter {
    dirs: DirFilter,
}

impl PathFilter {
    pub fn new(exclude: &[String]) -> Self {
        Self {
            dirs: DirFilter::new(exclude),
        }
    }

    /// 这个相对路径要不要理会。
    ///
    /// 忽略：`.meta/**`、`.git`、`node_modules`、`.knowledgenet`、清单里的排除项、
    /// 以及任何一段以 `.kn-tmp-` / `.kn-op-` 开头的临时文件。
    pub fn keep(&self, relative_path: &str) -> bool {
        let unified = relative_path.replace('\\', "/");
        let parts: Vec<&str> = unified.split('/').filter(|p| !p.is_empty()).collect();
        if parts.is_empty() {
            // 根目录本身变了（整库被替换/删除）：必须重扫
            return true;
        }
        let (last, dirs) = parts.split_last().expect("已确认非空");
        for dir in dirs {
            if self.dirs.is_skipped_dir_name(dir) {
                return false;
            }
        }
        if !dirs.is_empty() && self.dirs.matches_pattern(&dirs.join("/")) {
            return false;
        }
        if is_temp_name(last) {
            return false;
        }
        // 事件可能直接落在被排除的目录上（新建/删除 `.meta`、`.git` 本身）
        !self.dirs.is_skipped_dir_name(last)
    }
}

/// 是不是我们自己的临时文件。
pub fn is_temp_name(name: &str) -> bool {
    TEMP_FILE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// 事件的三种去向
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventClass {
    /// 不理会（访问类事件）
    Ignore,
    /// 内容改动
    Changed,
    /// 可能需要重新扫描（新建/删除/改名/未知）
    Rescan,
}

/// notify 的事件类型 → 处理方式。纯函数，可单测。
pub fn classify_event_kind(kind: &EventKind) -> EventClass {
    match kind {
        // 读文件也会报 Access：用它触发重扫会把磁盘读成 CPU 100%
        EventKind::Access(_) => EventClass::Ignore,
        // 新建/删除可能是「文件夹改名」的另一半，不能当成普通文件改动
        EventKind::Create(_) | EventKind::Remove(_) => EventClass::Rescan,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => EventClass::Rescan,
        EventKind::Modify(_) => EventClass::Changed,
        // 说不清的一律按结构变化处理：rescan 永远安全
        EventKind::Any | EventKind::Other => EventClass::Rescan,
    }
}

/* ------------------------------ 防抖合并 ------------------------------ */

/// 防抖缓冲：窗口内按路径合并，窗口结束后一次性交出。
///
/// 时间由调用方注入（`Instant`），所以单元测试不需要真的等 400ms。
pub struct DebounceBuffer {
    window: Duration,
    paths: BTreeSet<String>,
    rescan: bool,
    truncated: bool,
    deadline: Option<Instant>,
}

impl DebounceBuffer {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            paths: BTreeSet::new(),
            rescan: false,
            truncated: false,
            deadline: None,
        }
    }

    pub fn window(&self) -> Duration {
        self.window
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && !self.rescan
    }

    pub fn path_count(&self) -> usize {
        self.paths.len()
    }

    /// 收下一批路径。每来一条新事件，窗口就从**现在**重新开始计时
    /// （「一直在写」不应该每隔 400ms 就打断一次）。
    pub fn push<I: IntoIterator<Item = String>>(&mut self, paths: I, class: EventClass, now: Instant) {
        if class == EventClass::Ignore {
            return;
        }
        for path in paths {
            if self.paths.len() >= MAX_PENDING_PATHS {
                self.truncated = true;
                break;
            }
            self.paths.insert(path);
        }
        if class == EventClass::Rescan {
            self.rescan = true;
        }
        self.deadline = Some(now + self.window);
    }

    pub fn is_ready(&self, now: Instant) -> bool {
        match self.deadline {
            Some(deadline) => now >= deadline,
            None => false,
        }
    }

    /// 交出合并结果并清空缓冲。
    ///
    /// 只要窗口里有任何一条「可能需要重扫」的事件，整批就是 `rescan`：
    /// 文件夹改名常常表现为「删除 + 新建」两个事件，按路径拆分处理会立刻丢节点。
    pub fn take(&mut self) -> Option<PendingChange> {
        let pending = if self.rescan {
            kind::RESCAN
        } else {
            kind::CHANGED
        };
        let paths: Vec<String> = std::mem::take(&mut self.paths).into_iter().collect();
        let truncated = std::mem::replace(&mut self.truncated, false);
        let rescan = std::mem::replace(&mut self.rescan, false);
        self.deadline = None;
        if paths.is_empty() && !truncated && !rescan {
            return None;
        }
        Some(PendingChange {
            paths,
            kind: pending,
            truncated,
        })
    }
}

/* ------------------------------ 监听句柄 ------------------------------ */

/// 监听器句柄。`Drop` 会停掉监听线程（不泄漏线程，也不留一个还在读盘的句柄）。
pub struct WatcherHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    root: PathBuf,
    library_id: String,
}

impl std::fmt::Debug for WatcherHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatcherHandle")
            .field("root", &self.root)
            .field("library_id", &self.library_id)
            .field("running", &self.is_running())
            .finish()
    }
}

impl WatcherHandle {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn library_id(&self) -> &str {
        &self.library_id
    }

    pub fn is_running(&self) -> bool {
        !self.stop.load(Ordering::SeqCst)
    }

    /// 停止监听并等线程退出。可以重复调用。
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/* --------------------------------- 启动 --------------------------------- */

/// 开始递归监听知识库根目录。
///
/// 失败只是「没有实时刷新」，不应该让打开知识库失败——调用方（`state.rs`）
/// 会记一条日志并继续，重新扫描永远是可靠兜底。
pub fn start<G: GenerationSource>(
    app: AppHandle,
    root: &Path,
    library_id: &str,
    generation: G,
    exclude: Vec<String>,
) -> CmdResult<WatcherHandle> {
    start_with_window(
        app,
        root,
        library_id,
        generation,
        exclude,
        DEFAULT_DEBOUNCE_MS,
    )
}

/// 与 [`start`] 相同，但可以指定防抖窗口（测试与调参用）。
pub fn start_with_window<G: GenerationSource>(
    app: AppHandle,
    root: &Path,
    library_id: &str,
    generation: G,
    exclude: Vec<String>,
    window_ms: u64,
) -> CmdResult<WatcherHandle> {
    let root = std::fs::canonicalize(root).map_err(|e| {
        CmdError::io(format!(
            "无法解析要监听的知识库根目录 {}：{e}",
            root.display()
        ))
    })?;
    let root = crate::paths::strip_verbatim(&root);
    let library_id = library_id.to_string();
    let filter = PathFilter::new(&exclude);
    let window = Duration::from_millis(window_ms.clamp(50, 5_000));

    let (tx, rx) = mpsc::channel::<Event>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        if let Ok(event) = result {
            // 通道满了说明前端根本追不上：丢掉旧事件比阻塞监听线程安全
            let _ = tx.send(event);
        }
    })
    .map_err(|e| CmdError::io(format!("创建文件监听器失败：{e}")))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| CmdError::io(format!("监听 {} 失败：{e}", root.display())))?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread_root = root.clone();
    let thread_library = library_id.clone();

    let join = thread::Builder::new()
        .name("knowledgenet-watcher".to_string())
        .spawn(move || {
            // watcher 活在这个线程里：线程一退，监听就停
            let _watcher = watcher;
            let mut buffer = DebounceBuffer::new(window);
            while !thread_stop.load(Ordering::SeqCst) {
                match rx.recv_timeout(TICK) {
                    Ok(event) => {
                        let class = classify_event_kind(&event.kind);
                        if class == EventClass::Ignore {
                            continue;
                        }
                        let now = Instant::now();
                        let mut kept: Vec<String> = event
                            .paths
                            .iter()
                            .filter_map(|path| vpaths::relative_path_string(&thread_root, path))
                            .filter(|rel| filter.keep(rel))
                            .collect();
                        if kept.is_empty() {
                            if class == EventClass::Rescan && event.paths.is_empty() {
                                // 监听器说不出是哪条路径，但确定发生了结构变化：
                                // 空路径 = 「整库重扫」，这是最安全的解释
                                kept.push(String::new());
                            } else {
                                // 全是被排除的路径（例如我们自己写 .meta）：不理会，
                                // 否则写元数据会把自己的监听器点着，形成回环
                                continue;
                            }
                        }
                        buffer.push(kept, class, now);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if buffer.is_ready(Instant::now()) {
                    if let Some(pending) = buffer.take() {
                        let event = ChangeEvent {
                            library_id: thread_library.clone(),
                            generation: generation.current(),
                            kind: pending.kind.to_string(),
                            paths: pending.paths,
                            truncated: pending.truncated,
                        };
                        // 前端不在（窗口关掉）时会返回错误：那只是一次没人听的广播
                        let _ = app.emit(EVENT_NAME, &event);
                    }
                }
            }
        })
        .map_err(|e| CmdError::io(format!("启动监听线程失败：{e}")))?;

    Ok(WatcherHandle {
        stop,
        join: Some(join),
        root,
        library_id,
    })
}

/* ---------------------------------- 测试 ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind};

    fn excludes() -> Vec<String> {
        vec![
            ".git".to_string(),
            "node_modules".to_string(),
            ".knowledgenet".to_string(),
            "**/.meta/knowledgenet".to_string(),
        ]
    }

    #[test]
    fn temp_files_are_recognised() {
        assert!(is_temp_name(".kn-tmp-0199aaaa.json"));
        assert!(is_temp_name(".kn-op-42.json"));
        assert!(!is_temp_name("note.md"));
        assert!(!is_temp_name("000001_0199.json"));
    }

    #[test]
    fn filter_drops_metadata_and_excluded_directories() {
        let filter = PathFilter::new(&excludes());
        assert!(filter.keep("Root/note.md"));
        assert!(filter.keep("Root/Child/child-note.md"));
        assert!(filter.keep("library.json"));

        assert!(!filter.keep(".meta/knowledgenet/node.json"));
        assert!(!filter.keep("Root/.meta/knowledgenet/chats/x/thread.json"));
        assert!(!filter.keep(".meta"));
        assert!(!filter.keep(".git/HEAD"));
        assert!(!filter.keep("node_modules/left-pad/index.js"));
        assert!(!filter.keep(".knowledgenet/goals.json"));
        assert!(!filter.keep("Root/.kn-tmp-0199aaaa.json"));
    }

    #[test]
    fn only_structural_or_unknown_events_ask_for_a_rescan() {
        assert_eq!(
            classify_event_kind(&EventKind::Access(AccessKind::Read)),
            EventClass::Ignore
        );
        assert_eq!(
            classify_event_kind(&EventKind::Modify(ModifyKind::Data(DataChange::Content))),
            EventClass::Changed
        );
        assert_eq!(
            classify_event_kind(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime))),
            EventClass::Changed
        );
        assert_eq!(
            classify_event_kind(&EventKind::Create(CreateKind::Folder)),
            EventClass::Rescan
        );
        assert_eq!(
            classify_event_kind(&EventKind::Remove(RemoveKind::Folder)),
            EventClass::Rescan
        );
        assert_eq!(
            classify_event_kind(&EventKind::Modify(ModifyKind::Name(
                notify::event::RenameMode::Both
            ))),
            EventClass::Rescan
        );
        assert_eq!(classify_event_kind(&EventKind::Any), EventClass::Rescan);
    }

    #[test]
    fn debounce_merges_paths_and_waits_for_the_window() {
        let start = Instant::now();
        let mut buffer = DebounceBuffer::new(Duration::from_millis(400));
        assert!(!buffer.is_ready(start), "空缓冲不该自己触发");

        buffer.push(
            vec!["a.md".to_string(), "b.md".to_string()],
            EventClass::Changed,
            start,
        );
        assert!(!buffer.is_ready(start + Duration::from_millis(399)));
        assert!(buffer.is_ready(start + Duration::from_millis(400)));

        // 窗口内的新事件把截止时间往后推，并去重
        buffer.push(vec!["b.md".to_string(), "c.md".to_string()], EventClass::Changed, start + Duration::from_millis(300));
        assert_eq!(buffer.path_count(), 3);
        assert!(!buffer.is_ready(start + Duration::from_millis(500)));
        assert!(buffer.is_ready(start + Duration::from_millis(700)));

        let pending = buffer.take().expect("窗口结束后必须交出一批事件");
        assert_eq!(pending.kind, kind::CHANGED);
        assert_eq!(
            pending.paths,
            vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()]
        );
        assert!(!pending.truncated);
        assert!(buffer.take().is_none(), "交出去之后缓冲必须清空");
    }

    #[test]
    fn one_structural_event_makes_the_whole_batch_a_rescan() {
        let start = Instant::now();
        let mut buffer = DebounceBuffer::new(Duration::from_millis(400));
        buffer.push(vec!["Root/note.md".to_string()], EventClass::Changed, start);
        buffer.push(
            vec!["Root".to_string()],
            EventClass::Rescan,
            start + Duration::from_millis(10),
        );
        let pending = buffer.take().unwrap();
        assert_eq!(
            pending.kind,
            kind::RESCAN,
            "改名会表现成删除 + 新建，整批必须按 rescan 处理"
        );
    }

    #[test]
    fn ignored_events_never_open_a_window() {
        let start = Instant::now();
        let mut buffer = DebounceBuffer::new(Duration::from_millis(400));
        buffer.push(vec!["Root/note.md".to_string()], EventClass::Ignore, start);
        assert!(buffer.is_empty());
        assert!(!buffer.is_ready(start + Duration::from_secs(10)));
        assert!(buffer.take().is_none());
    }

    #[test]
    fn too_many_paths_are_truncated() {
        let start = Instant::now();
        let mut buffer = DebounceBuffer::new(Duration::from_millis(400));
        let many: Vec<String> = (0..MAX_PENDING_PATHS + 10)
            .map(|i| format!("f{i}.md"))
            .collect();
        buffer.push(many, EventClass::Changed, start);
        assert_eq!(buffer.path_count(), MAX_PENDING_PATHS);
        let pending = buffer.take().unwrap();
        assert!(pending.truncated);
    }
}
