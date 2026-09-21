//! 打开的知识库上下文 `LibCtx`：所有业务模块共用的最小接口。
//!
//! 它只回答三件事：
//! 1. 知识库根目录在哪（已经 canonicalize，是边界判定的基准）；
//! 2. 一个相对路径对应的绝对路径是什么（**必须先证明它没逃出根目录**）；
//! 3. 现在能不能写（只读会话一律拒绝写操作）。
//!
//! **不**做索引、不做缓存、不持有句柄：这些属于 `state.rs`。
//! 把「路径安全」集中在这里，业务模块就不必各自拼路径，也就不会各自拼错。

use std::path::{Path, PathBuf};

use crate::models::{code, CmdError, CmdResult};
use crate::paths::LibraryPaths;

use super::schema::LibraryManifest;
use super::vpaths;

#[derive(Debug, Clone)]
pub struct LibCtx {
    paths: LibraryPaths,
    manifest: LibraryManifest,
    read_only: bool,
}

impl LibCtx {
    pub fn new(root: &Path, manifest: LibraryManifest, read_only: bool) -> CmdResult<Self> {
        Ok(Self {
            paths: LibraryPaths::for_existing(root)?,
            manifest,
            read_only,
        })
    }

    /// 从已经 canonicalize 过的根目录构造（切换会话 / 复制之后使用）
    pub fn from_paths(paths: LibraryPaths, manifest: LibraryManifest, read_only: bool) -> Self {
        Self {
            paths,
            manifest,
            read_only,
        }
    }

    pub fn paths(&self) -> &LibraryPaths {
        &self.paths
    }

    pub fn root(&self) -> &Path {
        self.paths.root()
    }

    pub fn manifest(&self) -> &LibraryManifest {
        &self.manifest
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// 把一个**已经校验过**的知识库内相对路径解析成绝对路径。
    ///
    /// 三重防护：形状校验（拒绝绝对路径与 `..`）→ 拼接 → canonicalize 边界校验。
    pub fn resolve(&self, relative: &str) -> CmdResult<PathBuf> {
        if relative.trim().is_empty() {
            return Ok(self.paths.root().to_path_buf());
        }
        let cleaned = crate::paths::validate_relative_path(relative)?;
        let joined = self.paths.root().join(cleaned.replace('/', std::path::MAIN_SEPARATOR_STR));
        self.assert_inside(&joined, relative)
    }

    /// 解析一个**可以还不存在**的路径（新建节点、新建线程目录）：只做词法边界校验，
    /// 存在性由调用方自己判断。
    pub fn resolve_new(&self, relative: &str) -> CmdResult<PathBuf> {
        let cleaned = crate::paths::validate_relative_path(relative)?;
        Ok(self
            .paths
            .root()
            .join(cleaned.replace('/', std::path::MAIN_SEPARATOR_STR)))
    }

    /// 节点文件夹的绝对路径。
    pub fn node_dir(&self, node_relative_path: &str) -> CmdResult<PathBuf> {
        if node_relative_path.trim().is_empty() {
            // 知识库根目录本身也可以是一个节点
            return Ok(self.paths.root().to_path_buf());
        }
        let dir = self.resolve(node_relative_path)?;
        if !dir.is_dir() {
            return Err(CmdError::new(
                code::NODE_MISSING,
                format!("节点目录不存在：{node_relative_path}"),
            ));
        }
        Ok(dir)
    }

    /// 节点文件夹的绝对路径，不要求目录存在（认领、恢复时用）
    pub fn node_dir_unchecked(&self, node_relative_path: &str) -> CmdResult<PathBuf> {
        if node_relative_path.trim().is_empty() {
            return Ok(self.paths.root().to_path_buf());
        }
        self.resolve(node_relative_path)
    }

    /// 绝对路径 → 知识库内相对路径（正斜杠）。逃出根目录时返回 `node_outside_library`。
    pub fn relative_of(&self, path: &Path) -> CmdResult<String> {
        vpaths::relative_path_string(self.paths.root(), path).ok_or_else(|| {
            CmdError::new(
                code::NODE_OUTSIDE_LIBRARY,
                format!("路径不在知识库内：{}", path.display()),
            )
        })
    }

    /// 两个相对路径的父子关系判断（父节点不认领子节点的文件）
    pub fn is_ancestor(parent_rel: &str, child_rel: &str) -> bool {
        if parent_rel.is_empty() {
            return !child_rel.is_empty();
        }
        child_rel.len() > parent_rel.len()
            && child_rel.starts_with(parent_rel)
            && child_rel.as_bytes()[parent_rel.len()] == b'/'
    }

    pub fn require_writable(&self) -> CmdResult<()> {
        if self.read_only {
            Err(CmdError::read_only())
        } else {
            Ok(())
        }
    }

    fn assert_inside(&self, candidate: &Path, relative: &str) -> CmdResult<PathBuf> {
        // 路径可能还不存在（新建）：逐级向上找到第一个存在的祖先再 canonicalize
        let mut probe = candidate.to_path_buf();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if probe.exists() {
                break;
            }
            match probe.file_name() {
                Some(name) => {
                    tail.push(name.to_os_string());
                    let parent = probe.parent().map(|p| p.to_path_buf());
                    match parent {
                        Some(p) if p.as_os_str().len() < probe.as_os_str().len() => probe = p,
                        _ => break,
                    }
                }
                None => break,
            }
        }
        let canonical = std::fs::canonicalize(&probe).map_err(|e| {
            CmdError::io(format!(
                "无法解析路径 {}（相对 {relative}）：{e}",
                probe.display()
            ))
        })?;
        if !canonical.starts_with(self.paths.canonical_root()) {
            return Err(CmdError::new(
                code::NODE_OUTSIDE_LIBRARY,
                format!("路径逃出了知识库根目录：{relative}"),
            ));
        }
        let mut resolved = canonical;
        for part in tail.iter().rev() {
            resolved.push(part);
        }
        Ok(crate::paths::strip_verbatim(&resolved))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> LibraryManifest {
        LibraryManifest::new(
            "01990000-0000-7000-8000-000000000001".to_string(),
            "测试库".to_string(),
            "2026-09-20T10:00:00.000Z".to_string(),
        )
    }

    fn ctx_in(dir: &Path) -> LibCtx {
        std::fs::create_dir_all(dir.join("Nodes/A")).unwrap();
        LibCtx::new(dir, manifest(), false).unwrap()
    }

    #[test]
    fn resolves_relative_paths_inside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ctx_in(tmp.path());
        let node = ctx.node_dir("Nodes/A").unwrap();
        assert!(node.ends_with("Nodes/A"));
        assert_eq!(ctx.relative_of(&node).unwrap(), "Nodes/A");
    }

    #[test]
    fn root_directory_can_be_a_node() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ctx_in(tmp.path());
        assert_eq!(ctx.node_dir("").unwrap(), ctx.root());
        assert_eq!(ctx.relative_of(&ctx.node_dir("").unwrap()).unwrap(), "");
    }

    #[test]
    fn escape_attempts_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ctx_in(tmp.path());
        assert!(ctx.resolve("../outside").is_err());
        assert!(ctx.resolve("C:/Windows").is_err());
        assert!(ctx.resolve("Nodes/../..").is_err());
    }

    #[test]
    fn ancestor_relationship() {
        assert!(LibCtx::is_ancestor("Root", "Root/Child"));
        assert!(LibCtx::is_ancestor("", "Root"));
        assert!(!LibCtx::is_ancestor("Root", "Rooted"));
        assert!(!LibCtx::is_ancestor("Root/Child", "Root"));
    }

    #[test]
    fn read_only_ctx_refuses_writes() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path()).unwrap();
        let ctx = LibCtx::new(tmp.path(), manifest(), true).unwrap();
        assert_eq!(ctx.require_writable().unwrap_err().code, code::READ_ONLY);
    }

    #[test]
    fn missing_node_dir_is_node_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ctx_in(tmp.path());
        let err = ctx.node_dir("Nodes/DoesNotExist").unwrap_err();
        assert_eq!(err.code, code::NODE_MISSING);
    }
}
