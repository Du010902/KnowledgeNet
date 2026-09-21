import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // 用 @/ 指向 src，与 tsconfig.json 的 paths 保持一致。
  // 必须和 tsconfig 同时配置：编译器按 paths 解析类型，打包器按 alias 解析模块。
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    /*
     * 关键：强制同一文件只保留一个模块实例。
     *
     * 不加这一条时，`@/chatStore`（经别名）与别人用 `/src/chatStore.ts`
     * 这类原始路径导入的结果会各自实例化一份，模块级状态（例如「正在生成」的
     * 占位集合、ID 计数器、单例仓库）就会被复制成两份，防重复的守卫随之失效。
     */
    dedupe: ["react", "react-dom", "zustand"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    /*
     * 监听所有网卡，而不是默认的 localhost。
     *
     * Vite 在 host 未指定时只绑定一个地址族（本机上是 IPv6 的 ::1），
     * 于是 http://127.0.0.1:1420 会被拒绝，只有 localhost 能通；
     * 浏览器若优先解析到 IPv4 就会打不开。
     * 绑到 0.0.0.0 之后 IPv4 与 IPv6 都能访问。
     * TAURI_DEV_HOST 存在时（真机调试）优先用它。
     */
    host: host || "0.0.0.0",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
