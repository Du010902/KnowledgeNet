import React from "react";
import ReactDOM from "react-dom/client";

import App from "@/App";

/*
 * 样式按职责拆开（见 src/styles/ 与验收清单 P2-7）。
 *
 * **导入顺序就是层叠顺序**，与原 `styles.css` 的段落顺序一致：
 * 令牌 → 外壳 → 工作区 → 图谱 → 浮层 → 知识库界面 → 面板 → 检查器，
 * 然后是响应式（必须靠后才能盖住前面各档的基础规则），最后是 chat.css
 * （消息、输入区、Markdown、资料与笔记，历史上一直排在最后）。
 */
import "@/styles/tokens.css";
import "@/styles/window-shell.css";
import "@/styles/workspace.css";
import "@/styles/graph.css";
import "@/styles/overlays.css";
import "@/styles/library.css";
import "@/styles/panels.css";
import "@/styles/inspector.css";
import "@/styles/responsive.css";
import "@/styles/chat.css";
// KaTeX 的排版样式与字体：字体由 Vite 打进 dist/assets，走同源加载，
// 因此生产 CSP（font-src 'self' data:）不需要放宽。
import "katex/dist/katex.min.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
