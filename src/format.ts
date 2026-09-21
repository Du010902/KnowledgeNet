/**
 * 给人看的格式化。
 *
 * 单独一个模块，是因为「几 MB」这种话出现在三个地方（资料面板、知识库弹窗、
 * 删除对话框），各写一份迟早出现「同一个文件在两处显示成不同大小」。
 */

/** 字节数按人看得懂的方式显示：`0 B`、`812 B`、`1.5 KB`、`12 MB` */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
