/**
 * Markdown 转 OG 图片
 * 依赖可选的 node-html-to-image（需安装：npm install node-html-to-image）
 */

import { unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { markdownToHtml, getMarkdownStyles } from "./markdown-to-html.js";

const OG_TEMP_DIR = join(tmpdir(), "openclaw-onebot-og");

export async function markdownToImage(md: string, opts?: { theme?: string }): Promise<string | null> {
  if (!md?.trim()) return null;
  let nodeHtmlToImage: (opts: { output: string; html: string; type?: string; quality?: number; puppeteerArgs?: object }) => Promise<unknown>;
  try {
    const mod = await import("node-html-to-image");
    nodeHtmlToImage = mod.default;
  } catch {
    return null;
  }
  if (!nodeHtmlToImage) return null;

  const bodyHtml = markdownToHtml(md);
  const styles = getMarkdownStyles(opts?.theme);
  const theme = (opts?.theme || "").trim();
  const wrappedBody = theme === "dust" ? `<div class="markdown">${bodyHtml}</div>` : bodyHtml;
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">${styles}</head><body>${wrappedBody}</body></html>`;

  mkdirSync(OG_TEMP_DIR, { recursive: true });
  const outPath = join(OG_TEMP_DIR, `og-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  try {
    await nodeHtmlToImage({
      output: outPath,
      html: fullHtml,
      type: "png",
      quality: 90,
      puppeteerArgs: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
    });
    return `file://${outPath.replace(/\\/g, "/")}`;
  } catch (e) {
    try {
      unlinkSync(outPath);
    } catch {}
    throw e;
  }
}
