//! 设备级设置（AppData）：最近打开的知识库列表 + AI 配置（不含 API Key）。
//!
//! 这一层的界限必须清楚：**设备文件只描述「这台机器」**。
//! 删掉 `device.json` 只损失「最近打开过哪些库」这种便利信息，
//! 不应该、也不可能影响知识内容——知识内容全部在知识库文件夹里。
//!
//! API Key 不进入这里：它只保存在系统凭据存储（见 `deepseek.rs`）。
//! 老版本或手工编辑写进来的密钥字段会在读取时被抹掉并回写，避免明文长期躺在磁盘上。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::deepseek::AiConfig;
use crate::models::{CmdError, CmdResult, DeviceSettings, RecentLibrary};
#[cfg(test)]
use crate::models::LibraryInfo;
use crate::paths;

/// 设备设置文件标识。与知识库 `library.json` 的 `format` 是两回事：
/// 前者错了只影响本机便利功能，后者错了意味着「这根本不是知识库」。
pub const DEVICE_FORMAT: &str = "knowledgenet-device";
/// 设备设置文件版本。向前兼容：读到更高版本时按损坏处理，不猜测字段含义。
pub const DEVICE_VERSION: i64 = 1;
/// 最近列表上限：足够覆盖常用知识库，又不会让设置文件无限增长
pub const MAX_RECENT: usize = 20;

const FILE_NAME: &str = "device.json";
/// 明文字段名黑名单：任何写进设备文件的密钥字段都会被移除
const FORBIDDEN_KEY_FIELDS: [&str; 3] = ["apiKey", "api_key", "apikey"];

/// `AppData/device.json` 的完整路径，必要时创建 AppData 目录。
pub fn settings_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::io(format!("无法确定设备设置目录（AppData）：{e}")))?;
    fs::create_dir_all(&dir)
        .map_err(|e| CmdError::io(format!("无法创建设备设置目录 {}：{e}", dir.display())))?;
    Ok(dir.join(FILE_NAME))
}

/// 读取设备设置。文件不存在时返回默认值（第一次启动的正常情况）。
///
/// 文件损坏或版本过高时**不阻塞 App 启动**：改名保留现场后回退默认设置。
/// 设备设置是可以丢的便利数据，为了它让用户打不开知识库是不划算的。
pub fn load(path: &Path) -> CmdResult<DeviceSettings> {
    if !path.exists() {
        return Ok(default_settings());
    }
    let text = paths::read_text(path)?;
    let mut settings = match serde_json::from_str::<DeviceSettings>(&text) {
        Ok(settings) => settings,
        Err(e) => {
            return Ok(preserve_and_reset(path, &format!("无法解析（{e}）")));
        }
    };
    if settings.format != DEVICE_FORMAT || settings.version > DEVICE_VERSION {
        return Ok(preserve_and_reset(
            path,
            &format!(
                "format/version 不是本版本认识的（format={}，version={}）",
                settings.format, settings.version
            ),
        ));
    }

    let mut changed = normalize(&mut settings);
    if strip_api_key(&mut settings.ai_config) {
        changed = true;
        eprintln!("设备设置里发现 API Key 字段：已移除（密钥只应保存在系统凭据存储中）");
    }
    if changed {
        // 读命令顺手修正文件：不回写的话，明文密钥会一直留在磁盘上
        let _ = save(path, &settings);
    }
    Ok(settings)
}

/// 把无法使用的设置文件改名保留（不删除现场），并返回默认设置。
fn preserve_and_reset(path: &Path, reason: &str) -> DeviceSettings {
    let backup = path.with_file_name(format!("{FILE_NAME}.corrupt-{}", paths::now_ms()));
    match fs::rename(path, &backup) {
        Ok(()) => eprintln!(
            "设备设置{reason}，已保留为 {} 并回退到默认设置",
            backup.display()
        ),
        Err(e) => eprintln!("设备设置{reason}，且无法保留现场（{e}），将使用默认设置"),
    }
    default_settings()
}

/// 保存设备设置：临时文件 + 安全替换，避免写到一半断电留下半个 JSON。
pub fn save(path: &Path, settings: &DeviceSettings) -> CmdResult<()> {
    let mut out = settings.clone();
    out.format = DEVICE_FORMAT.to_string();
    out.version = DEVICE_VERSION;
    normalize(&mut out);
    // 双保险：即使调用方拼出来的 Value 里带了密钥字段，也不让它落盘
    strip_api_key(&mut out.ai_config);
    let mut text = serde_json::to_string_pretty(&out)?;
    text.push('\n');
    paths::write_text_atomic(path, &text)?;
    Ok(())
}

/// 刷新 `missing` 标记后返回最近列表。
///
/// 「路径还在不在」必须在读取时重新判断：知识库可能被用户移到别处或删掉，
/// 显示一个可点但打不开的条目比直接标出「找不到」更糟。
pub fn list_recent(path: &Path) -> CmdResult<Vec<RecentLibrary>> {
    let mut settings = load(path)?;
    let mut changed = false;
    for entry in &mut settings.recent_libraries {
        let present = !entry.path.trim().is_empty()
            && Path::new(&entry.path).join(paths::MANIFEST_NAME).is_file();
        if entry.missing != !present {
            entry.missing = !present;
            changed = true;
        }
    }
    if changed {
        save(path, &settings)?;
    }
    Ok(settings.recent_libraries)
}

/// 记录一次打开：去重 + 按时间倒序 + 上限 20。
///
/// v2 里它不再依赖某个具体的 `LibraryInfo` 结构：知识库身份与显示名就是
/// `library.json` 里的 `libraryId` / `title`，而根路径由调用方给出。
pub fn remember(path: &Path, root_path: &str, title: &str, library_id: &str) -> CmdResult<()> {
    let root = root_path.trim();
    if root.is_empty() {
        return Err(CmdError::invalid("知识库路径为空，无法记录到最近列表"));
    }
    let mut settings = load(path)?;
    let key = path_key(root);
    // 按**路径**去重，而不是按 libraryId：把库复制到新位置后两个位置都值得出现在列表里，
    // 而同一个位置重复打开不应该刷出多条记录。
    settings.recent_libraries.retain(|e| path_key(&e.path) != key);
    settings.recent_libraries.push(RecentLibrary {
        path: root.to_string(),
        title: title.to_string(),
        library_id: library_id.to_string(),
        last_opened_at: paths::now_ms(),
        missing: false,
    });
    save(path, &settings) // save 内部会排序、去重并截断到 MAX_RECENT
}

/// 从最近列表移除一个路径（找不到也算成功：界面目的就是「它别再出现」）。
pub fn forget(path: &Path, library_root: &str) -> CmdResult<()> {
    let mut settings = load(path)?;
    let key = path_key(library_root);
    settings.recent_libraries.retain(|e| path_key(&e.path) != key);
    save(path, &settings)
}

/// 读取 AI 配置。坏配置回退默认值，而不是让 AI 面板打不开。
pub fn load_ai_config(path: &Path) -> CmdResult<AiConfig> {
    let settings = load(path)?;
    if settings.ai_config.is_null() {
        return Ok(AiConfig::default());
    }
    match serde_json::from_value::<AiConfig>(settings.ai_config.clone()) {
        Ok(config) => Ok(config),
        Err(e) => {
            eprintln!("AI 配置无法解析（{e}），已回退默认值");
            Ok(AiConfig::default())
        }
    }
}

/// 保存 AI 配置。`AiConfig` 里没有密钥字段，所以这里不可能把 Key 写进设备文件。
pub fn save_ai_config(path: &Path, config: &AiConfig) -> CmdResult<()> {
    let mut settings = load(path)?;
    settings.ai_config = serde_json::to_value(config)?;
    save(path, &settings)
}

/* -------------------------------- 内部辅助 -------------------------------- */

fn default_settings() -> DeviceSettings {
    DeviceSettings {
        format: DEVICE_FORMAT.to_string(),
        version: DEVICE_VERSION,
        recent_libraries: Vec::new(),
        ai_config: serde_json::Value::Null,
    }
}

/// 抹掉任何明文密钥字段，返回是否真的删掉了东西。
fn strip_api_key(value: &mut serde_json::Value) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let mut removed = false;
    for field in FORBIDDEN_KEY_FIELDS {
        if obj.remove(field).is_some() {
            removed = true;
        }
    }
    removed
}

/// 归一化最近列表：丢空路径、按路径去重、时间倒序、截断到上限。
/// 返回列表是否发生了变化（没变就不回写，避免每次读取都动文件时间）。
fn normalize(settings: &mut DeviceSettings) -> bool {
    let before: Vec<(String, i64)> = settings
        .recent_libraries
        .iter()
        .map(|e| (path_key(&e.path), e.last_opened_at))
        .collect();

    settings
        .recent_libraries
        .sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    let mut seen: HashSet<String> = HashSet::new();
    let mut kept: Vec<RecentLibrary> = Vec::with_capacity(settings.recent_libraries.len());
    for entry in settings.recent_libraries.drain(..) {
        if entry.path.trim().is_empty() {
            continue;
        }
        if !seen.insert(path_key(&entry.path)) {
            continue;
        }
        kept.push(entry);
        if kept.len() >= MAX_RECENT {
            break;
        }
    }
    settings.recent_libraries = kept;

    let after: Vec<(String, i64)> = settings
        .recent_libraries
        .iter()
        .map(|e| (path_key(&e.path), e.last_opened_at))
        .collect();
    before != after
}

/// 路径比较键。Windows 路径大小写不敏感，同一个文件夹可能以不同大小写被记录下来。
fn path_key(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    #[cfg(windows)]
    {
        trimmed.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        trimmed.to_string()
    }
}

/* --------------------------------- 测试 --------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn 库信息(root: &Path, title: &str) -> LibraryInfo {
        LibraryInfo {
            library_id: paths::new_id(),
            title: title.to_string(),
            root_path: root.to_string_lossy().to_string(),
            read_only: false,
            revision: 1,
            format_version: 1,
            schema_version: 1,
            node_count: 0,
            edge_count: 0,
            goal_count: 0,
            resource_count: 0,
            trashed_node_count: 0,
            created_at: paths::iso_now(),
            recovered_operations: 0,
            quick_check_issues: 0,
        }
    }

    /// 造一个「看起来像知识库」的目录：最近列表的 missing 判断看的就是 library.json
    fn 假库(root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join(paths::MANIFEST_NAME), "{}").unwrap();
    }

    #[test]
    fn 保存后可读回设备设置() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        let mut settings = load(&path).unwrap();
        assert_eq!(settings.format, DEVICE_FORMAT);
        assert!(settings.recent_libraries.is_empty());

        settings.ai_config = serde_json::json!({"model": "deepseek-flash"});
        save(&path, &settings).unwrap();
        let again = load(&path).unwrap();
        assert_eq!(again.version, DEVICE_VERSION);
        assert_eq!(again.ai_config["model"], "deepseek-flash");
    }

    #[test]
    fn 最近列表去重倒序并截断到上限() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        let mut settings = default_settings();
        for i in 0..(MAX_RECENT as i64 + 5) {
            settings.recent_libraries.push(RecentLibrary {
                path: format!("D:/libs/{i}"),
                title: format!("库 {i}"),
                library_id: paths::new_id(),
                last_opened_at: i,
                missing: false,
            });
        }
        // 同一路径重复两条：只应保留最新的那条
        settings.recent_libraries.push(RecentLibrary {
            path: "D:/libs/0".to_string(),
            title: "库 0（重新打开）".to_string(),
            library_id: paths::new_id(),
            last_opened_at: 999,
            missing: false,
        });
        save(&path, &settings).unwrap();

        let list = list_recent(&path).unwrap();
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0].path, "D:/libs/0");
        assert_eq!(list[0].title, "库 0（重新打开）");
        // 严格按打开时间倒序
        for pair in list.windows(2) {
            assert!(pair[0].last_opened_at >= pair[1].last_opened_at);
        }
        let unique: HashSet<&str> = list.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(unique.len(), list.len());
    }

    #[test]
    fn remember刷新缺失标记() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        let root = dir.path().join("我的库");
        假库(&root);

        let info = 库信息(&root, "我的库");
        remember(&path, &info.root_path, &info.title, &info.library_id).unwrap();
        let list = list_recent(&path).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "我的库");
        assert_eq!(list[0].library_id, info.library_id);
        assert!(!list[0].missing);

        // 重复打开同一位置：仍然只有一条，且被置顶
        remember(&path, &info.root_path, &info.title, &info.library_id).unwrap();
        let list = list_recent(&path).unwrap();
        assert_eq!(list.len(), 1);

        // 路径失效后必须如实标记，界面才能提示「找不到」
        fs::remove_dir_all(&root).unwrap();
        let list = list_recent(&path).unwrap();
        assert!(list[0].missing);

        // 恢复目录后又应当变回可用状态
        假库(&root);
        let list = list_recent(&path).unwrap();
        assert!(!list[0].missing);
    }

    #[test]
    fn forget移除指定路径且容忍不存在() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        假库(&a);
        假库(&b);
        let a_info = 库信息(&a, "A");
        remember(&path, &a_info.root_path, &a_info.title, &a_info.library_id).unwrap();
        let b_info = 库信息(&b, "B");
        remember(&path, &b_info.root_path, &b_info.title, &b_info.library_id).unwrap();

        forget(&path, &a.to_string_lossy()).unwrap();
        let list = list_recent(&path).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "B");

        // 再删一次不报错
        forget(&path, &a.to_string_lossy()).unwrap();
    }

    #[test]
    fn 设备文件里绝不留apiKey() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        // 模拟老版本 / 手工编辑写进来的明文密钥
        fs::write(
            &path,
            r#"{
              "format": "knowledgenet-device",
              "version": 1,
              "recentLibraries": [],
              "aiConfig": { "model": "deepseek-flash", "apiKey": "sk-secret", "api_key": "sk-secret2" }
            }"#,
        )
        .unwrap();

        let config = load_ai_config(&path).unwrap();
        assert_eq!(config.model.as_deref(), Some("deepseek-flash"));
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-secret"), "明文密钥被留在了设备文件里：{text}");
        assert!(!text.contains("apiKey"));

        // 正常保存路径也不可能写出密钥字段
        let mut config = AiConfig::default();
        config.model = Some("deepseek-chat".to_string());
        save_ai_config(&path, &config).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("deepseek-chat"));
        assert!(!text.contains("apiKey") && !text.contains("api_key"));
    }

    #[test]
    fn 坏文件不阻塞且保留现场() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        fs::write(&path, "{ 这不是 JSON").unwrap();
        let settings = load(&path).unwrap();
        assert!(settings.recent_libraries.is_empty());
        // 现场保留：目录里应当有一个 .corrupt- 备份
        let kept: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1, "坏文件必须被保留下来而不是悄悄丢掉");
        // 路径已经腾空，再存一次就能正常工作
        save(&path, &settings).unwrap();
        assert!(load(&path).unwrap().recent_libraries.is_empty());
    }

    #[test]
    fn ai配置坏值回退默认() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device.json");
        fs::write(
            &path,
            r#"{"format":"knowledgenet-device","version":1,"recentLibraries":[],"aiConfig":{"maxTokens":"不是数字"}}"#,
        )
        .unwrap();
        // 坏配置不能让 AI 面板打不开
        let config = load_ai_config(&path).unwrap();
        assert!(config.max_tokens.is_some());
    }
}
