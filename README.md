# KnowledgeNet

KnowledgeNet 是一款本地优先的桌面学习工具，用知识依赖图组织学习内容。
它使用普通文件夹和 Markdown 保存知识资产，并提供图谱、笔记和按知识点组织的 AI 对话。

> 当前版本仍处于预览阶段。请在使用前备份重要数据。

## 功能

- 用有向图表达“理解 A 需要先理解 B”的依赖关系
- 使用普通文件夹和开放文件格式保存知识库
- 支持 Markdown 笔记、资源管理和多轮对话
- 本地优先；设备索引可从知识库文件重建
- API Key 保存在系统凭据存储中

## 从源码构建

请先安装 Node.js、pnpm、Rust，以及 Tauri 2 在目标平台所需的系统依赖。

```bash
pnpm install --frozen-lockfile
pnpm tauri:build
```

仅构建 Web 前端：

```bash
pnpm build
```

## 开发

```bash
pnpm install
pnpm tauri:dev
```

## 下载

Windows 预览版安装包可在 GitHub Releases 页面下载。预览版可能尚未进行代码签名，因此 Windows 可能显示安全提示。

## 说明

本仓库只包含构建应用所需的源码与配置，不包含内部设计、审查和验收文档。
