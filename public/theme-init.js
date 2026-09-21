/**
 * 首屏主题
 *
 * 必须是一段独立脚本、并在样式表之前加载：
 * 深色系统下若等到 React 挂载（src/theme.ts）才写 data-theme，会先闪一帧亮色背景。
 *
 * 为什么不能写成 index.html 里的内联 <script>：release 构建的 CSP 是 `script-src 'self'`，
 * 内联脚本会被直接拦掉；开发模式的 devCsp 带 'unsafe-inline'，所以这个问题在开发时看不出来。
 * 独立文件同源加载，两种构建都放行，也不需要为了它放宽 CSP。
 *
 * 键与默认值必须和 src/theme.ts 保持一致。
 */
(function () {
  try {
    var saved = localStorage.getItem("knowledgenet.theme");
    var mode = saved === "light" || saved === "dark" ? saved : null;
    var dark = mode
      ? mode === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
