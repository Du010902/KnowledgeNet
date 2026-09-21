//! 元数据文件的读写原语：**原子替换 + 修订号/哈希守卫**。
//!
//! 两条规则：
//!
//! 1. 任何 JSON 写入都走「同目录临时文件 → flush → fsync → 原子替换」。
//!    临时文件放在目标同目录，保证同一卷，替换才是原子的。
//! 2. 任何重写已有文件的调用都必须同时给出「我手上那份的 revision」与「我手上那份的
//!    SHA-256」。磁盘被外部改过时返回结构化的 `external_change_conflict`，
//!    **绝不静默覆盖**——这正是「文件夹是普通文件夹、用户可以用任何编辑器改」的代价与承诺。

use std::fs;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::models::{code, CmdError, CmdResult};
use crate::paths;

use super::schema::Validate;

/// 一份磁盘文件的指纹。扫描索引只保存派生数据，真相永远是这三个值背后的文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub sha256: String,
    pub bytes: u64,
    pub modified_ms: i64,
}

impl Fingerprint {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sha256": self.sha256,
            "bytes": self.bytes,
            "modifiedMs": self.modified_ms,
        })
    }
}

pub fn ensure_dir(path: &Path) -> CmdResult<()> {
    fs::create_dir_all(path)
        .map_err(|e| CmdError::io(format!("创建目录 {} 失败：{e}", path.display())))
}

pub fn exists(path: &Path) -> bool {
    path.exists()
}

pub fn read_text(path: &Path) -> CmdResult<String> {
    paths::read_text(path)
}

/// 读取文件的 SHA-256 与修改时间；文件不存在时返回 `None`（不是错误）。
pub fn fingerprint_opt(path: &Path) -> CmdResult<Option<Fingerprint>> {
    match fs::metadata(path) {
        Ok(meta) => {
            if !meta.is_file() {
                return Ok(None);
            }
            let (sha256, bytes) = paths::sha256_file(path)?;
            Ok(Some(Fingerprint {
                sha256,
                bytes,
                modified_ms: paths::modified_ms(&meta),
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CmdError::io(format!(
            "读取 {} 的元信息失败：{e}",
            path.display()
        ))),
    }
}

pub fn fingerprint(path: &Path) -> CmdResult<Fingerprint> {
    fingerprint_opt(path)?.ok_or_else(|| {
        CmdError::new(
            code::NOT_FOUND,
            format!("文件不存在：{}", path.display()),
        )
    })
}

pub fn sha256_of(path: &Path) -> CmdResult<String> {
    Ok(paths::sha256_file(path)?.0)
}

/* --------------------------------- 读 JSON -------------------------------- */

/// 读 JSON 但**不**校验格式头：调用方要自己解释 format / formatVersion。
pub fn read_json_value(path: &Path) -> CmdResult<(serde_json::Value, Fingerprint)> {
    let text = read_text(path)?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("{} 不是合法的 JSON：{e}", path.display()),
        )
    })?;
    let fp = fingerprint(path)?;
    Ok((value, fp))
}

/// 读 JSON 并做「格式头 + 字段 + 业务校验」三阶段解析。
pub fn read_typed<T: DeserializeOwned + Validate>(
    path: &Path,
    expected_format: &str,
    expected_version: i64,
    what: &str,
    relative_path: Option<&str>,
) -> CmdResult<(T, Fingerprint)> {
    let text = read_text(path)?;
    let value = super::schema::parse_typed::<T>(
        &text,
        expected_format,
        expected_version,
        what,
        relative_path,
    )?;
    let fp = fingerprint(path)?;
    Ok((value, fp))
}

/// 可选版本：文件不存在返回 `None`。
pub fn read_typed_opt<T: DeserializeOwned + Validate>(
    path: &Path,
    expected_format: &str,
    expected_version: i64,
    what: &str,
    relative_path: Option<&str>,
) -> CmdResult<Option<(T, Fingerprint)>> {
    if !path.is_file() {
        return Ok(None);
    }
    read_typed(path, expected_format, expected_version, what, relative_path).map(Some)
}

/// 不做格式头校验的 JSON 读取：用于**设备侧**的小文件
/// （每库 UI 状态、笔记记账等）——它们不是知识资产，坏了回默认值即可，
/// 不必也不该套用 `knowledgenet-*` 的格式头规则。
pub fn read_json_opt<T: DeserializeOwned>(path: &Path) -> CmdResult<Option<(T, Fingerprint)>> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = read_text(path)?;
    let value: T = serde_json::from_str(&text).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("{} 不是合法的 JSON：{e}", path.display()),
        )
    })?;
    let fp = fingerprint(path)?;
    Ok(Some((value, fp)))
}

/* --------------------------------- 写 JSON -------------------------------- */

/// 把值序列化成「给人看」的 JSON：两空格缩进 + 末尾换行。
///
/// 知识资产是开放文件，用户要能用记事本打开、用 git diff 看变化；
/// 压成一行虽然省字节，却把「可读、可版本控制」这个卖点丢掉了。
pub fn to_pretty_json<T: Serialize>(value: &T) -> CmdResult<String> {
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|e| CmdError::msg(format!("序列化 JSON 失败：{e}")))?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

/// 原子写入 JSON，返回写入后的指纹。
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> CmdResult<Fingerprint> {
    let text = to_pretty_json(value)?;
    write_text(path, &text)
}

/// 原子写入文本（同目录临时文件 → fsync → 替换）。
pub fn write_text(path: &Path, text: &str) -> CmdResult<Fingerprint> {
    let (sha256, bytes, modified_ms) = paths::write_text_atomic(path, text)?;
    Ok(Fingerprint {
        sha256,
        bytes,
        modified_ms,
    })
}

/* ------------------------------ 冲突保护写入 ------------------------------ */

/// 构造 `external_change_conflict`：错误码是给程序看的，`detail` 是给界面看的。
pub fn external_conflict(
    relative_path: &str,
    expected_revision: i64,
    actual_revision: i64,
    expected_hash: Option<&str>,
    actual_hash: &str,
) -> CmdError {
    let detail = serde_json::json!({
        "relativePath": relative_path,
        "expectedRevision": expected_revision,
        "actualRevision": actual_revision,
        "expectedHash": expected_hash,
        "actualHash": actual_hash,
    });
    CmdError::new(
        code::EXTERNAL_CHANGE_CONFLICT,
        format!(
            "{relative_path} 已被外部修改（期望修订号 {expected_revision}，磁盘上 {actual_revision}）；\
             已拒绝覆盖，请选择重新载入或明确覆盖"
        ),
    )
    .with_detail(detail)
}

/// 写入前的守卫：调用方手上的 `revision` 与 `sha256` 必须与磁盘一致。
///
/// `expected_sha256` 为 `None` 表示调用方只持有修订号（首次创建等场景）。
pub fn ensure_unchanged(
    relative_path: &str,
    actual_revision: i64,
    expected_revision: i64,
    actual_hash: &str,
    expected_sha256: Option<&str>,
) -> CmdResult<()> {
    if let Some(expected) = expected_sha256 {
        if !expected.is_empty() && !expected.eq_ignore_ascii_case(actual_hash) {
            return Err(external_conflict(
                relative_path,
                expected_revision,
                actual_revision,
                Some(expected),
                actual_hash,
            ));
        }
    }
    if expected_revision >= 0 && expected_revision != actual_revision {
        return Err(external_conflict(
            relative_path,
            expected_revision,
            actual_revision,
            expected_sha256,
            actual_hash,
        ));
    }
    Ok(())
}

/// 「带守卫的读改写」的公共骨架。
///
/// `load` 从磁盘读出当前值与指纹；`mutate` 在内存里改；返回的修订号会被写回。
/// 目标文件不存在时由 `load` 决定是报错还是给出初始值。
pub fn guarded_update<T, F, M>(
    path: &Path,
    relative_path: &str,
    expected_revision: i64,
    expected_sha256: Option<&str>,
    load: F,
    mutate: M,
) -> CmdResult<(T, Fingerprint)>
where
    T: Serialize,
    F: FnOnce() -> CmdResult<(T, Fingerprint)>,
    M: FnOnce(&mut T),
{
    let (mut value, fp) = load()?;
    let actual_revision = revision_of(&fp, path)?;
    ensure_unchanged(
        relative_path,
        actual_revision,
        expected_revision,
        &fp.sha256,
        expected_sha256,
    )?;
    mutate(&mut value);
    let new_fp = write_json(path, &value)?;
    Ok((value, new_fp))
}

/// 从文件内容里读 `revision` 字段；没有该字段时退回 0。
///
/// 这里**不**按修改时间判断改动：用户在资源管理器里「碰一下」文件不该算外部修改，
/// 只有内容真的变了才是。
pub fn revision_of(fp: &Fingerprint, path: &Path) -> CmdResult<i64> {
    let text = read_text(path)?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        CmdError::new(
            code::METADATA_INVALID,
            format!("{} 不是合法的 JSON：{e}", path.display()),
        )
    })?;
    let _ = fp;
    Ok(value
        .get("revision")
        .and_then(|v| v.as_i64())
        .unwrap_or(0))
}

/* -------------------------------- 目录工具 -------------------------------- */

/// 目录为空时删掉它；非空或不存在都返回 `false`（「不是空的」不是错误）。
///
/// 移除节点身份时用它收拾 `.meta`：如果 `.meta` 里还有别的软件的内容，就留着。
pub fn remove_dir_if_empty(path: &Path) -> CmdResult<bool> {
    if !path.is_dir() {
        return Ok(false);
    }
    let mut entries = fs::read_dir(path)
        .map_err(|e| CmdError::io(format!("读取目录 {} 失败：{e}", path.display())))?;
    if entries.next().is_some() {
        return Ok(false);
    }
    fs::remove_dir(path)
        .map_err(|e| CmdError::io(format!("删除空目录 {} 失败：{e}", path.display())))?;
    Ok(true)
}

/// 递归删除目录；不存在时是空操作。
pub fn remove_dir_all_if_exists(path: &Path) -> CmdResult<()> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(path)
        .map_err(|e| CmdError::io(format!("删除目录 {} 失败：{e}", path.display())))
}

/// 尽力而为地 fsync 父目录：Windows 上目录句柄不可直接 fsync，
/// 失败不算错误——它只是让「替换已经落盘」这件事更可信，不是正确性前提。
pub fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent() {
            if let Ok(dir) = fs::File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::schema::{NodeMeta, NODE_FORMAT, NODE_FORMAT_VERSION};

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("临时目录")
    }

    #[test]
    fn write_then_read_round_trip() {
        let dir = temp_dir();
        let file = dir.path().join("node.json");
        let meta = NodeMeta::new(
            "0199aaaa-0000-7000-8000-000000000001".to_string(),
            "注意力机制".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        );
        let fp = write_json(&file, &meta).unwrap();
        assert!(fp.bytes > 0);
        let (back, fp2): (NodeMeta, Fingerprint) = read_typed(
            &file,
            NODE_FORMAT,
            NODE_FORMAT_VERSION,
            "node.json",
            None,
        )
        .unwrap();
        assert_eq!(back, meta);
        assert_eq!(fp.sha256, fp2.sha256);
        // 文件是给人看的：有换行、有缩进
        let text = read_text(&file).unwrap();
        assert!(text.ends_with('\n'));
        assert!(text.contains("\n  "));
    }

    #[test]
    fn external_change_is_reported_not_overwritten() {
        let dir = temp_dir();
        let file = dir.path().join("node.json");
        let mut meta = NodeMeta::new(
            "0199aaaa-0000-7000-8000-000000000001".to_string(),
            "原标题".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        );
        let fp = write_json(&file, &meta).unwrap();

        // 模拟外部编辑器改了标题
        meta.title = "外部改过的标题".to_string();
        meta.revision = 9;
        write_json(&file, &meta).unwrap();

        let err = ensure_unchanged(
            "Nodes/A/.meta/knowledgenet/node.json",
            9,
            1,
            &fingerprint(&file).unwrap().sha256,
            Some(&fp.sha256),
        )
        .expect_err("哈希不符必须拒绝");
        assert_eq!(err.code, code::EXTERNAL_CHANGE_CONFLICT);
        let detail = err.detail.unwrap();
        assert_eq!(detail["expectedRevision"], 1);
        assert_eq!(detail["actualRevision"], 9);

        // 磁盘上仍然是外部那把改过的内容，没被覆盖
        let text = read_text(&file).unwrap();
        assert!(text.contains("外部改过的标题"));
    }

    #[test]
    fn matching_revision_and_hash_pass() {
        let dir = temp_dir();
        let file = dir.path().join("node.json");
        let meta = NodeMeta::new(
            "0199aaaa-0000-7000-8000-000000000001".to_string(),
            "标题".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        );
        let fp = write_json(&file, &meta).unwrap();
        assert!(ensure_unchanged(
            "node.json",
            meta.revision,
            meta.revision,
            &fp.sha256,
            Some(&fp.sha256)
        )
        .is_ok());
    }

    #[test]
    fn remove_dir_if_empty_keeps_foreign_content() {
        let dir = temp_dir();
        let meta_dir = dir.path().join(".meta");
        ensure_dir(&meta_dir.join("other-tool")).unwrap();
        assert!(!remove_dir_if_empty(&meta_dir).unwrap(), "还有别的内容就不能删");

        fs::remove_dir(meta_dir.join("other-tool")).unwrap();
        assert!(remove_dir_if_empty(&meta_dir).unwrap(), "空了才删");
        assert!(!meta_dir.exists());
    }
}
