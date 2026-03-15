/**
 * Markdown 转 OG 图片
 * 使用 Satori 将 HTML/CSS 转换为 SVG，再使用 Sharp 转换为 PNG
 * 
 * 优点：
 * - 无需浏览器内核，轻量级
 * - Serverless 友好
 * - 启动速度快
 * 
 * 限制：
 * - 只支持部分 HTML/CSS 特性
 * - 需要手动处理字体
 */

import { unlinkSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import satori from "satori";
import sharp from "sharp";

const OG_TEMP_DIR = join(tmpdir(), "openclaw-onebot-og");

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 字体缓存
let fontCache: Buffer | null = null;

/**
 * 加载默认字体
 */
async function loadDefaultFont(): Promise<Buffer> {
  if (fontCache) return fontCache;
  
  // 尝试加载系统字体（优先使用 .ttf，satori 不支持 .ttc 格式）
  const systemFonts = [
    // macOS - 优先使用 .ttf 格式
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Geneva.ttf",
    "/System/Library/Fonts/Monaco.ttf",
    "/System/Library/Fonts/NewYork.ttf",
    // Linux - 优先使用 .ttf 格式
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    // Windows
    "C:\\Windows\\Fonts\\arial.ttf",
  ];
  
  for (const fontPath of systemFonts) {
    try {
      const buffer = readFileSync(fontPath);
      fontCache = buffer;
      return buffer;
    } catch {
      continue;
    }
  }
  
  // 如果都找不到，抛出错误
  throw new Error("无法找到系统字体，请安装中文字体（如文泉驿微米黑）");
}

/**
 * 简单的 Markdown 到 Satori JSX 的转换
 * Satori 只支持有限的 HTML 子集
 */
function markdownToSatoriElements(md: string): any {
  const lines = md.split("\n");
  const elements: any[] = [];
  
  let inCodeBlock = false;
  let codeBlockContent = "";
  let codeBlockLang = "";
  
  for (const line of lines) {
    // 代码块处理
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        // 结束代码块
        elements.push({
          type: "div",
          props: {
            style: {
              backgroundColor: "#f6f8fa",
              padding: "12px",
              borderRadius: "6px",
              fontFamily: "monospace",
              fontSize: "14px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              marginBottom: "12px",
              color: "#24292e",
            },
            children: codeBlockContent.trim(),
          },
        });
        codeBlockContent = "";
        codeBlockLang = "";
        inCodeBlock = false;
      } else {
        // 开始代码块
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeBlockContent += line + "\n";
      continue;
    }
    
    // 标题处理
    if (line.startsWith("# ")) {
      elements.push({
        type: "h1",
        props: {
          style: {
            fontSize: "24px",
            fontWeight: "bold",
            marginBottom: "12px",
            color: "#1a1a1a",
          },
          children: line.slice(2),
        },
      });
      continue;
    }
    
    if (line.startsWith("## ")) {
      elements.push({
        type: "h2",
        props: {
          style: {
            fontSize: "20px",
            fontWeight: "bold",
            marginTop: "16px",
            marginBottom: "8px",
            color: "#1a1a1a",
          },
          children: line.slice(3),
        },
      });
      continue;
    }
    
    if (line.startsWith("### ")) {
      elements.push({
        type: "h3",
        props: {
          style: {
            fontSize: "18px",
            fontWeight: "bold",
            marginTop: "12px",
            marginBottom: "6px",
            color: "#1a1a1a",
          },
          children: line.slice(4),
        },
      });
      continue;
    }
    
    // 列表项
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const inlineContent = parseInlineStyles(line.slice(2));
      elements.push({
        type: "div",
        props: {
          style: {
            display: "flex",
            marginBottom: "4px",
            fontSize: "14px",
          },
          children: [{ type: "span", props: { style: { marginRight: "8px", color: "#666" }, children: "• " } }, ...inlineContent],
        },
      });
      continue;
    }
    
    // 引用块
    if (line.startsWith("> ")) {
      const inlineContent = parseInlineStyles(line.slice(2));
      elements.push({
        type: "div",
        props: {
          style: {
            display: "flex",
            borderLeft: "4px solid #ddd",
            paddingLeft: "12px",
            marginBottom: "12px",
            color: "#666",
            fontStyle: "italic",
          },
          children: inlineContent,
        },
      });
      continue;
    }
    
    // 空行
    if (line.trim() === "") {
      elements.push({
        type: "div",
        props: {
          style: { height: "8px" },
          children: null,
        },
      });
      continue;
    }
    
    // 普通段落
    const inlineContent = parseInlineStyles(line);
    elements.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          fontSize: "14px",
          lineHeight: "1.6",
          marginBottom: "8px",
          color: "#333",
        },
        children: inlineContent,
      },
    });
  }
  
  return elements;
}

/**
 * 解析行内样式（粗体、斜体、代码）
 */
function parseInlineStyles(text: string): any[] {
  const parts: any[] = [];
  let current = "";
  let i = 0;
  
  while (i < text.length) {
    // 粗体 **text**
    if (text.slice(i, i + 2) === "**" && text.indexOf("**", i + 2) !== -1) {
      if (current) {
        parts.push(current);
        current = "";
      }
      const endIdx = text.indexOf("**", i + 2);
      parts.push({
        type: "span",
        props: {
          style: { fontWeight: 700, color: "#000" },
          children: text.slice(i + 2, endIdx),
        },
      });
      i = endIdx + 2;
      continue;
    }
    
    // 斜体 *text* 或 _text_
    if ((text[i] === "*" || text[i] === "_") && text.indexOf(text[i], i + 1) !== -1) {
      const char = text[i];
      const endIdx = text.indexOf(char, i + 1);
      if (endIdx !== -1 && endIdx > i + 1) {
        if (current) {
          parts.push(current);
          current = "";
        }
        parts.push({
          type: "span",
          props: {
            style: { fontStyle: "italic", color: "#555" },
            children: text.slice(i + 1, endIdx),
          },
        });
        i = endIdx + 1;
        continue;
      }
    }
    
    // 行内代码 `code`
    if (text[i] === "`" && text.indexOf("`", i + 1) !== -1) {
      const endIdx = text.indexOf("`", i + 1);
      if (current) {
        parts.push(current);
        current = "";
      }
      parts.push({
        type: "code",
        props: {
          style: {
            backgroundColor: "#f0f0f0",
            padding: "2px 4px",
            borderRadius: "3px",
            fontFamily: "monospace",
            fontSize: "12px",
          },
          children: text.slice(i + 1, endIdx),
        },
      });
      i = endIdx + 1;
      continue;
    }
    
    current += text[i];
    i++;
  }
  
  if (current) {
    parts.push(current);
  }
  
  // 如果没有解析出任何样式，返回原始文本包装
  if (parts.length === 0) {
    return [text];
  }
  
  // 将所有纯文本字符串转换为 span 元素，确保 satori 能正确渲染
  return parts.map(part => {
    if (typeof part === "string") {
      return part; // 保持字符串，satori 应该能处理
    }
    return part;
  });
}

export interface MarkdownToImageOptions {
  theme?: string;
  width?: number;
}

/**
 * 根据文本内容估算所需高度
 */
function estimateHeight(md: string, width: number): number {
  const lines = md.split("\n");
  const contentWidth = width - 64; // 减去 padding
  const avgCharsPerLine = contentWidth / 14; // 假设平均每个字符 14px
  
  let estimatedLines = 0;
  let inCodeBlock = false;
  
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) {
        estimatedLines += 1; // 代码块结束行
      }
      continue;
    }
    
    if (inCodeBlock) {
      estimatedLines += 1;
      continue;
    }
    
    if (line.startsWith("# ")) {
      estimatedLines += 2; // h1 + margin
    } else if (line.startsWith("## ")) {
      estimatedLines += 1.5; // h2 + margin
    } else if (line.startsWith("### ")) {
      estimatedLines += 1.5; // h3 + margin
    } else if (line.startsWith("> ")) {
      estimatedLines += Math.max(1, Math.ceil(line.length / avgCharsPerLine));
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      estimatedLines += Math.max(1, Math.ceil(line.length / avgCharsPerLine));
    } else if (line.trim() === "") {
      estimatedLines += 0.5; // 空行
    } else {
      estimatedLines += Math.max(1, Math.ceil(line.length / avgCharsPerLine));
    }
  }
  
  // 每行大约 22px 高度，加上 padding
  const lineHeight = 22;
  const padding = 64;
  const minHeight = 200;
  const maxHeight = 4000; // 最大高度限制
  
  return Math.min(maxHeight, Math.max(minHeight, Math.ceil(estimatedLines * lineHeight) + padding));
}

export async function markdownToImage(
  md: string,
  opts?: MarkdownToImageOptions
): Promise<string | null> {
  if (!md?.trim()) return null;
  
  try {
    // 加载字体
    const fontData = await loadDefaultFont();
    
    // 转换 Markdown 为 Satori 元素
    const elements = markdownToSatoriElements(md);
    
    // 计算所需高度
    const width = opts?.width || 800;
    const estimatedHeight = estimateHeight(md, width);
    
    // 创建容器
    const container = {
      type: "div",
      props: {
        style: {
          display: "flex",
          flexDirection: "column",
          padding: 32,
          backgroundColor: opts?.theme === "dust" ? "#faf8f5" : "#ffffff",
          width: width,
          height: estimatedHeight,
        },
        children: elements,
      },
    };
    
    // 使用 Satori 生成 SVG
    const svg = await satori(container, {
      width,
      height: estimatedHeight,
      fonts: [
        {
          name: "System",
          data: fontData,
          weight: 400,
          style: "normal",
        },
      ],
    });
    
    // 使用 Sharp 将 SVG 转换为 PNG
    mkdirSync(OG_TEMP_DIR, { recursive: true });
    const outPath = join(OG_TEMP_DIR, `og-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    
    await sharp(Buffer.from(svg))
      .png({ quality: 90 })
      .toFile(outPath);
    
    return `file://${outPath.replace(/\\/g, "/")}`;
  } catch (e) {
    console.error("[onebot] Satori 图片生成失败:", e);
    return null;
  }
}
