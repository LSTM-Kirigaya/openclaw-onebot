/**
 * Markdown 转 HTML（保留格式，含代码高亮）
 * 用于 OG 图片模式下的 Markdown 渲染
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { marked } from "marked";
import hljs from "highlight.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 内置 dust 主题 CSS 文件路径（相对当前模块，包根目录下的 themes/dust.css） */
function getDustThemePath(): string {
  return join(__dirname, "..", "themes", "dust.css");
}

const HIGHLIGHT_CSS = `
.hljs{display:block;overflow-x:auto;padding:1em;background:#1e1e1e;color:#d4d4d4;border-radius:6px;font-family:Consolas,Monaco,monospace;font-size:15px;line-height:1.5}
.hljs-keyword{color:#569cd6}
.hljs-string{color:#ce9178}
.hljs-number{color:#b5cea8}
.hljs-comment{color:#6a9955}
.hljs-function{color:#dcdcaa}
.hljs-title{color:#4ec9b0}
.hljs-params{color:#9cdcfe}
.hljs-built_in{color:#4ec9b0}
.hljs-class{color:#4ec9b0}
.hljs-variable{color:#9cdcfe}
.hljs-attr{color:#9cdcfe}
.hljs-tag{color:#569cd6}
.hljs-name{color:#569cd6}
.hljs-meta{color:#808080}
`;

function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      return hljs.highlightAuto(code).value;
    }
  }
  return hljs.highlightAuto(code).value;
}

marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const escaped = highlightCode(text, lang);
      return `<pre><code class="hljs language-${lang || ""}">${escaped}</code></pre>`;
    },
  },
});

const WRAPPER_STYLE = `
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:18px;line-height:1.6;color:#24292e;background:#fff;padding:24px;max-width:450px}
h1,h2,h3,h4,h5,h6{margin:16px 0 8px;font-weight:600;line-height:1.25}
h1{font-size:1.5em}
h2{font-size:1.3em}
h3{font-size:1.15em}
p{margin:8px 0}
ul,ol{margin:8px 0;padding-left:24px}
li{margin:4px 0}
code{background:#f6f8fa;padding:2px 6px;border-radius:4px;font-size:0.9em;font-family:Consolas,Monaco,monospace}
pre{margin:12px 0;overflow-x:auto}
pre code{background:transparent;padding:0}
blockquote{border-left:4px solid #dfe2e5;padding-left:16px;margin:8px 0;color:#6a737d}
a{color:#0366d6;text-decoration:none}
a:hover{text-decoration:underline}
table{border-collapse:collapse;margin:12px 0}
th,td{border:1px solid #dfe2e5;padding:8px 12px;text-align:left}
th{background:#f6f8fa;font-weight:600}
${HIGHLIGHT_CSS}
</style>
`;

export function markdownToHtml(md: string): string {
  if (!md || typeof md !== "string") return "";
  return marked.parse(md, { async: false }) as string;
}

/**
 * 获取用于 OG 图片的完整样式（基础 + 主题）
 * @param theme "default" 无额外样式；"dust" 内置 dust 主题；或 custom 时的 CSS 文件绝对路径
 */
export function getMarkdownStyles(theme?: string): string {
  let extra = "";
  const t = (theme || "default").trim();
  if (t === "dust") {
    const dustPath = getDustThemePath();
    try {
      if (existsSync(dustPath)) {
        const dustCss = readFileSync(dustPath, "utf-8");
        extra = `<style>body{background:var(--background) !important;padding:24px;max-width:450px;}${dustCss}</style>`;
      }
    } catch {
      /* ignore */
    }
  } else if (t !== "default" && t !== "none" && (t.includes("/") || t.includes("\\"))) {
    try {
      if (existsSync(t)) {
        extra = `<style>${readFileSync(t, "utf-8")}</style>`;
      }
    } catch {
      /* ignore */
    }
  }
  return WRAPPER_STYLE + extra;
}
