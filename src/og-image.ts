/**
 * Markdown 转 OG 图片
 * 依赖可选的 puppeteer-core（需安装：npm install puppeteer-core）
 * 
 * 兼容性说明：
 * - 支持 Ubuntu 24+、macOS、Windows
 * - 自动检测系统 Chromium/Chrome 路径
 * - 无需下载 Chromium，使用系统已安装的浏览器
 * 
 * 安装系统 Chromium（Ubuntu/Debian）：
 *   sudo apt update
 *   sudo apt install -y chromium-browser
 * 
 * 安装系统 Chromium（macOS）：
 *   brew install --cask chromium
 *   # 或直接使用系统 Chrome
 */

import { unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { markdownToHtml, getMarkdownStyles } from "./markdown-to-html.js";
import type { Browser, Page } from "puppeteer-core";

const OG_TEMP_DIR = join(tmpdir(), "openclaw-onebot-og");

/**
 * 自动检测系统 Chromium/Chrome 可执行文件路径
 */
function detectChromiumPath(): string | undefined {
  const platform = process.platform;
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  
  if (envPath) {
    return envPath;
  }

  // 各平台常见路径
  const paths: Record<string, string[]> = {
    linux: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/snap/bin/chromium",
      "/usr/lib/chromium/chromium",
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome",
      "/opt/homebrew/bin/chromium",
      "/usr/local/bin/chromium",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Chromium\\Application\\chromium.exe",
    ],
  };

  const candidates = paths[platform] || [];
  
  // 简单检查文件是否存在（同步检查）
  for (const p of candidates) {
    try {
      // 使用 fs.accessSync 检查文件是否可读
      const { accessSync, constants } = require("fs");
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * 动态导入 puppeteer-core
 */
async function loadPuppeteer() {
  try {
    const mod = await import("puppeteer-core");
    return mod;
  } catch {
    return null;
  }
}

export interface MarkdownToImageOptions {
  theme?: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
}

export async function markdownToImage(
  md: string,
  opts?: MarkdownToImageOptions
): Promise<string | null> {
  if (!md?.trim()) return null;

  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    return null;
  }

  const chromiumPath = detectChromiumPath();
  if (!chromiumPath) {
    console.warn("[onebot] 未找到系统 Chromium/Chrome，请安装或设置 PUPPETEER_EXECUTABLE_PATH 环境变量");
    console.warn("[onebot] Ubuntu/Debian: sudo apt install chromium-browser");
    console.warn("[onebot] macOS: brew install --cask chromium");
    return null;
  }

  const bodyHtml = markdownToHtml(md);
  const styles = getMarkdownStyles(opts?.theme);
  const theme = (opts?.theme || "").trim();
  const wrappedBody = theme === "dust" ? `<div class="markdown">${bodyHtml}</div>` : bodyHtml;
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">${styles}</head><body>${wrappedBody}</body></html>`;

  mkdirSync(OG_TEMP_DIR, { recursive: true });
  const outPath = join(OG_TEMP_DIR, `og-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  let browser: Browser | undefined;

  try {
    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    });

    const page: Page = await browser.newPage();
    
    // 设置视口
    await page.setViewport({
      width: opts?.width || 800,
      height: opts?.height || 600,
      deviceScaleFactor: 2, // 高清截图
    });

    // 设置内容并等待渲染完成
    await page.setContent(fullHtml, {
      waitUntil: ["networkidle0", "domcontentloaded"],
    });

    // 等待字体和样式加载
    await page.evaluate(() => document.fonts.ready);

    // 截图
    await page.screenshot({
      path: outPath,
      type: "png",
      fullPage: opts?.fullPage !== false, // 默认全页截图
    });

    await browser.close();
    browser = undefined;

    return `file://${outPath.replace(/\\/g, "/")}`;
  } catch (e) {
    // 清理浏览器资源
    if (browser) {
      try {
        await browser.close();
      } catch {
        // 忽略关闭错误
      }
    }
    // 清理临时文件
    try {
      unlinkSync(outPath);
    } catch {}
    throw e;
  }
}
