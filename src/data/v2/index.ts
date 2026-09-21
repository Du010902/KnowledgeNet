/**
 * v2 开放文件模型（barrel）
 *
 * 这一层刻意不依赖浏览器 API、不依赖 zustand，也不依赖任何界面代码：
 * 只有 `Vfs` 抽象上的纯函数与数据模型。因此同一份代码可以在
 * 浏览器演示模式、Node 测试与（对照实现）Rust 端之间对齐。
 */
export * from "./paths.ts";
export * from "./hash.ts";
export * from "./fs.ts";
export * from "./schema.ts";
export * from "./nodeMeta.ts";
export * from "./scanner.ts";
export * from "./resources.ts";
export * from "./notes.ts";
export * from "./relations.ts";
export * from "./chats.ts";
export * from "./goals.ts";
