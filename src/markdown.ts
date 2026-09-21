/**
 * 对话与笔记共用的 Markdown 渲染
 *
 * 覆盖范围：标题、段落、**代码块（带语言与复制按钮）**、行内代码、有序/无序/嵌套列表、
 * 任务列表、**表格**、引用、分隔线、粗体/斜体/删除线、`[文字](链接)`、裸链接自动链接、
 * 以及 `$…$` / `$$…$$` 公式（保留 TeX 源码，视觉上与正文区分；**不做 TeX 排版**）。
 *
 * 三条必须守住的纪律：
 *
 * 1. **先转义、后拼标签**。任何来自 AI、备份或别人笔记的字符，都只能变成文字。
 *    段落/标题/列表/表格单元一律走 `inline()`；代码块整体 `escapeHtml`。
 * 2. **链接协议白名单**：只允许 http/https，`javascript:`、`data:` 一律退化成纯文本。
 *    这一点曾经出过真实缺陷——URL 里的引号可以越出 `href` 变成事件属性，
 *    因此链接在**原始文本**上识别、在**拼进属性前**逐个转义，而不是先转义再匹配。
 * 3. **流式容错**：回答是一个字一个字来的，任何时刻都可能停在半个结构上。
 *    未闭合的代码围栏要自动收尾；没等到分隔行的表格退化成普通段落；
 *    半个 `**` 保持原样显示。**绝不允许**因为「还没写完」而吐出坏 HTML。
 */
import { escapeHtml, isSafeUrl } from "./escape.ts";
import { renderMath } from "./math.ts";

// 这两个是安全边界的一部分，历史上由 `markdown.ts` 导出并被测试直接引用，
// 因此继续从这里转出去，调用方不必知道内部拆成了两个模块。
export { escapeHtml, isSafeUrl };

/* ------------------------------ 占位符机制 ------------------------------ */

/*
 * 行内代码与链接里的内容不能再被后续规则改写（否则 `` `**a**` `` 会被加粗、
 * 链接地址里的下划线会被当成斜体）。做法是先把它们抽成占位符，最后再放回去。
 *
 * 哨兵用 NUL：正常文本里不会出现；万一真的出现，先剥掉，用户就无法伪造占位符。
 */
const SENTINEL = "\u0000";

function protect(store: string[], html: string): string {
  store.push(html);
  return `${SENTINEL}${store.length - 1}${SENTINEL}`;
}

function restore(text: string, store: string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => store[Number(index)] ?? "");
}

/* -------------------------------- 行内 -------------------------------- */

function link(url: string, label?: string): string {
  const href = escapeHtml(url);
  const text = escapeHtml(label ?? url);
  return `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;
}

/** 行内元素：代码、公式、链接、加粗、斜体、删除线。输入是**未转义**的原文。 */
function inline(raw: string): string {
  const store: string[] = [];
  let text = raw.replace(/\u0000/g, "");

  // 1) 行内代码：内容整体转义后放进占位符，不再参与任何后续规则
  text = text.replace(/`([^`]+)`/g, (_, code: string) =>
    protect(store, `<code>${escapeHtml(code)}</code>`),
  );

  // 2) 公式：四种定界符都要认，模型在一段回答里会混用
  //
  //    `\[…\]` / `$$…$$` 是块级，`\(…\)` / `$…$` 是行内。
  //    行内的 `$` 收尾必须满足两个条件，否则「价格是 $100 和 $200」会被当成公式：
  //    内容两端不能是空白，且收尾的 `$` 后面不能紧跟数字。
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) =>
    protect(store, renderMath(tex, true)),
  );
  text = text.replace(/\$\$([^$\n]+?)\$\$/g, (_, tex: string) =>
    protect(store, renderMath(tex, true)),
  );
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) =>
    protect(store, renderMath(tex, false)),
  );
  text = text.replace(/\$(?!\s)([^\s$][^$\n]*?)\$(?!\d)/g, (_, tex: string) =>
    protect(store, renderMath(tex, false)),
  );

  // 3) `[文字](链接)`：在**原文**上识别，协议不合格就整段当普通文字
  text = text.replace(
    /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g,
    (whole, label: string, url: string, title: string | undefined) => {
      if (!isSafeUrl(url)) return whole;
      const anchor = link(url, label);
      return protect(
        store,
        title ? anchor.replace(">", ` title="${escapeHtml(title)}">`) : anchor,
      );
    },
  );

  // 4) 裸链接自动链接：排除引号与尖括号，URL 里的引号不可能越出 href
  text = text.replace(/(https?:\/\/[^\s)"'<>]+)/gi, (url: string) =>
    isSafeUrl(url) ? protect(store, link(url)) : url,
  );

  // 5) 剩下的都是纯文本：转义之后再做强调类规则
  text = escapeHtml(text);
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    // 单星号斜体：两侧不能贴着字母数字，避免把 a*b*c 当成斜体
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    // 下划线斜体：只认词边界，`snake_case` 不会被拆成斜体
    .replace(/(^|[\s(（[【])_([^_\n]+)_(?=$|[\s).,;:!?，。；：！？)）\]】])/g, "$1<em>$2</em>");

  return restore(text, store);
}

/* -------------------------------- 块级 -------------------------------- */

interface ListFrame {
  indent: number;
  tag: "ul" | "ol";
}

/** ATX 标题：`## 标题`，末尾的 `#` 收尾符去掉 */
function headingOf(line: string): { level: number; text: string } | null {
  const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2].replace(/\s+#+\s*$/, "") };
}

/** 分隔线：`---`、`***`、`___`（至少三个）。列表项不会被误判，因为这里要求整行只有符号 */
function isThematicBreak(line: string): boolean {
  return /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line);
}

function isTableRow(line: string): boolean {
  return line.includes("|") && !/^\s*\|?\s*:?-{2,}/.test(line.replace(/\|/g, "|"));
}

/** GFM 表格的第二行：`| --- | :--: |` */
function isDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  // 不支持 `\|` 转义：AI 回答里极少出现，为此写一个字符级状态机会让这段代码难读得多
  return body.split("|").map((cell) => cell.trim());
}

function alignOf(cell: string): string {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function renderTable(header: string[], aligns: string[], rows: string[][]): string {
  const th = header
    .map((cell, index) => {
      const cls = aligns[index] ? ` class="align-${aligns[index]}"` : "";
      return `<th${cls}>${inline(cell)}</th>`;
    })
    .join("");
  const body = rows
    .map((row) => {
      const tds = header
        .map((_, index) => {
          const cls = aligns[index] ? ` class="align-${aligns[index]}"` : "";
          return `<td${cls}>${inline(row[index] ?? "")}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * 代码块。
 *
 * 复制按钮用 `data-code-copy` 标记、由外层容器做事件委托：
 * 这段 HTML 是 `dangerouslySetInnerHTML` 插进去的，里面挂不了 React 事件；
 * 用 `data-code="…"` 把代码再写一遍属性又会多一层转义风险，索性让按钮去读兄弟节点。
 */
function renderCodeBlock(lang: string, code: string): string {
  const label = lang
    ? `<span class="code-lang">${escapeHtml(lang)}</span>`
    : `<span class="code-lang"></span>`;
  return (
    `<div class="code-block">` +
    `<div class="code-head">${label}` +
    `<button type="button" class="code-copy" data-code-copy>复制</button></div>` +
    `<pre><code>${escapeHtml(code)}</code></pre></div>`
  );
}

/** 引用块内部按段落处理，但不递归整棵块级解析：引用里套表格/代码块极罕见 */
function renderQuote(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) paragraphs.push(current.join("<br/>"));
      current = [];
      continue;
    }
    current.push(inline(line));
  }
  if (current.length) paragraphs.push(current.join("<br/>"));
  if (paragraphs.length === 0) return "<blockquote></blockquote>";
  return `<blockquote>${paragraphs.map((p) => `<p>${p}</p>`).join("")}</blockquote>`;
}

/**
 * 列表：支持缩进嵌套与任务列表。
 *
 * 用缩进栈而不是递归：回答里的列表层次通常只有两层，
 * 但「列表写到一半被截断」是常态，栈式写法在任意位置停下来都能正确收尾。
 */
function renderList(lines: string[], start: number, out: string[]): number {
  const stack: ListFrame[] = [];
  let index = start;

  while (index < lines.length) {
    const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[index]);
    if (!match) {
      // 列表项之间允许一个空行（松散列表），但空行之后必须还是列表项
      if (
        lines[index].trim() === "" &&
        index + 1 < lines.length &&
        /^\s*([-*+]|\d{1,9}[.)])\s+/.test(lines[index + 1])
      ) {
        index += 1;
        continue;
      }
      break;
    }

    const indent = match[1].replace(/\t/g, "  ").length;
    const tag: "ul" | "ol" = /\d/.test(match[2]) ? "ol" : "ul";
    let body = match[3];
    let checked: boolean | null = null;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
    if (task) {
      checked = task[1].toLowerCase() === "x";
      body = task[2];
    }

    // 回到更浅的一层：把更深的列表逐个关掉
    while (stack.length > 0 && indent < stack[stack.length - 1].indent) {
      out.push(`</${stack.pop()!.tag}>`);
    }
    const top = stack[stack.length - 1];
    if (!top || indent > top.indent || tag !== top.tag) {
      if (top && indent === top.indent && tag !== top.tag) {
        out.push(`</${stack.pop()!.tag}>`);
      }
      out.push(`<${tag}>`);
      stack.push({ indent, tag });
    }

    if (checked === null) {
      out.push(`<li>${inline(body)}</li>`);
    } else {
      const state = checked ? "已完成" : "未完成";
      out.push(
        `<li class="task"><span class="task-box${checked ? " done" : ""}" role="img" ` +
          `aria-label="${state}"></span><span class="task-text">${inline(body)}</span></li>`,
      );
    }
    index += 1;
  }

  while (stack.length > 0) out.push(`</${stack.pop()!.tag}>`);
  return index;
}

/**
 * 块级公式：`$$ … $$` 或 `\[ … \]`，同一行或跨行都认。
 *
 * 跨行形式必须支持：模型几乎总是把 `\[` 和 `\]` 各写一行，
 * 中间才是公式本体（见 `\[ \n G = (V, E) \n \]`）。
 */
function blockMathAt(lines: string[], start: number): { html: string; next: number } | null {
  const trimmed = lines[start].trim();
  const pair = trimmed.startsWith("\\[")
    ? { open: "\\[", close: "\\]" }
    : trimmed.startsWith("$$")
      ? { open: "$$", close: "$$" }
      : null;
  if (!pair) return null;

  const rest = trimmed.slice(pair.open.length);
  const sameLine = rest.indexOf(pair.close);
  if (sameLine >= 0) {
    return { html: renderMath(rest.slice(0, sameLine), true), next: start + 1 };
  }

  const body: string[] = [rest];
  let index = start + 1;
  while (index < lines.length) {
    const at = lines[index].indexOf(pair.close);
    if (at >= 0) {
      body.push(lines[index].slice(0, at));
      return { html: renderMath(body.join("\n"), true), next: index + 1 };
    }
    body.push(lines[index]);
    index += 1;
  }
  // 还没等到收尾（流式生成中途）：按纯文本处理，别把剩下的整段吞进公式里
  return null;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.join("<br/>")}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    // 代码围栏（``` 或 ~~~）：直到收尾围栏或文本结束
    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const closer = new RegExp(`^\\s*\\${marker}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        if (closer.test(lines[index])) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      out.push(renderCodeBlock(fence[2], body.join("\n")));
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    const math = blockMathAt(lines, index);
    if (math) {
      flushParagraph();
      out.push(math.html);
      index = math.next;
      continue;
    }

    if (isThematicBreak(line)) {
      flushParagraph();
      out.push("<hr/>");
      index += 1;
      continue;
    }

    const heading = headingOf(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading.level + 2, 6);
      out.push(`<h${level}>${inline(heading.text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      out.push(renderQuote(body));
      continue;
    }

    // 表格：必须有紧跟其后的分隔行；流式过程中先到的半张表会退化成段落
    if (isTableRow(line) && index + 1 < lines.length && isDelimiterRow(lines[index + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[index + 1]).map(alignOf);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      out.push(renderTable(header, aligns, rows));
      continue;
    }

    if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) {
      flushParagraph();
      index = renderList(lines, index, out);
      continue;
    }

    paragraph.push(inline(line));
    index += 1;
  }

  flushParagraph();
  return out.join("\n");
}
