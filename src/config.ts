/**
 * OneBot 配置解析
 */

import type { OneBotAccountConfig } from "./types.js";

export function getOneBotConfig(api: any, accountId?: string): OneBotAccountConfig | null {
  const cfg = api?.config ?? (globalThis as any).__onebotGatewayConfig;
  const id = accountId ?? "default";

  const channel = cfg?.channels?.onebot;
  const account = channel?.accounts?.[id];
  if (account) {
    const { type, host, port, accessToken, path } = account;
    if (host && port) {
      return {
        accountId: id,
        type: type ?? "forward-websocket",
        host,
        port,
        accessToken,
        path: path ?? "/onebot/v11/ws",
        enabled: account.enabled !== false,
      };
    }
  }

  if (channel?.host && channel?.port) {
    return {
      accountId: id,
      type: channel.type ?? "forward-websocket",
      host: channel.host,
      port: channel.port,
      accessToken: channel.accessToken,
      path: channel.path ?? "/onebot/v11/ws",
    };
  }

  const type = process.env.ONEBOT_WS_TYPE as "forward-websocket" | "backward-websocket" | undefined;
  const host = process.env.ONEBOT_WS_HOST;
  const portStr = process.env.ONEBOT_WS_PORT;
  const accessToken = process.env.ONEBOT_WS_ACCESS_TOKEN;
  const path = process.env.ONEBOT_WS_PATH ?? "/onebot/v11/ws";

  if (host && portStr) {
    const port = parseInt(portStr, 10);
    if (Number.isFinite(port)) {
      return {
        accountId: id,
        type: type === "backward-websocket" ? "backward-websocket" : "forward-websocket",
        host,
        port,
        accessToken: accessToken || undefined,
        path,
      };
    }
  }

  return null;
}

/** 是否将机器人回复中的 Markdown 渲染为纯文本再发送，默认 true */
export function getRenderMarkdownToPlain(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.renderMarkdownToPlain;
  return v === undefined ? true : Boolean(v);
}

function getFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 是否将连续多个换行压缩为单个换行，默认 true（AI 常输出 \n\n 导致双空行） */
export function getCollapseDoubleNewlines(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.collapseDoubleNewlines;
  return v === undefined ? true : Boolean(v);
}

/** normal 模式下聚合发送的等待窗口，默认 1200ms */
export function getNormalModeFlushIntervalMs(cfg: any): number {
  const value = getFiniteNumber(cfg?.channels?.onebot?.normalModeFlushIntervalMs, 1200);
  return Math.max(200, Math.min(5000, Math.round(value)));
}

/** normal 模式下聚合发送的字符阈值，达到后提前 flush，默认 160 */
export function getNormalModeFlushChars(cfg: any): number {
  const value = getFiniteNumber(cfg?.channels?.onebot?.normalModeFlushChars, 160);
  return Math.max(20, Math.min(2000, Math.round(value)));
}

/** 白名单 QQ 号列表，为空则所有人可回复；非空则仅白名单内用户可触发 AI */
export function getWhitelistUserIds(cfg: any): number[] {
  const v = cfg?.channels?.onebot?.whitelistUserIds;
  if (!Array.isArray(v)) return [];
  return v.filter((x: unknown) => typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x))).map((x) => Number(x));
}

/** 黑名单 QQ 号列表，在黑名单内的用户无法触发 AI */
export function getBlacklistUserIds(cfg: any): number[] {
  const v = cfg?.channels?.onebot?.blacklistUserIds;
  if (!Array.isArray(v)) return [];
  return v.filter((x: unknown) => typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x))).map((x) => Number(x));
}

/**
 * OG 图片渲染主题：枚举 default（无额外样式）、dust（内置）、custom（使用 ogImageRenderThemePath）
 * 返回用于 getMarkdownStyles 的值：default | dust | 自定义 CSS 绝对路径
 */
export function getOgImageRenderTheme(cfg: any): "default" | "dust" | string {
  const v = cfg?.channels?.onebot?.ogImageRenderTheme;
  const path = (cfg?.channels?.onebot?.ogImageRenderThemePath ?? "").trim();
  if (v === "dust") return "dust";
  if (v === "custom" && path.length > 0) return path;
  return "default";
}

export function listAccountIds(apiOrCfg: any): string[] {
  const cfg = apiOrCfg?.config ?? apiOrCfg ?? (globalThis as any).__onebotGatewayConfig;
  const accounts = cfg?.channels?.onebot?.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }
  if (cfg?.channels?.onebot?.host) return ["default"];
  return [];
}

/** 
 * 触发关键词列表，当 requireMention 为 false 时生效
 * 消息包含这些关键词时触发机器人响应
 */
export function getTriggerKeywords(cfg: any): string[] {
  const v = cfg?.channels?.onebot?.triggerKeywords;
  if (!Array.isArray(v)) return [];
  return v.filter((x: unknown) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

/**
 * 关键词匹配模式
 * - "prefix": 消息以关键词开头（默认）
 * - "contains": 消息包含关键词即可
 */
export function getTriggerMode(cfg: any): "prefix" | "contains" {
  const v = cfg?.channels?.onebot?.triggerMode;
  if (v === "contains") return "contains";
  return "prefix"; // 默认为前缀匹配
}

/** 是否在用户不在白名单时回复“权限不足”，默认 true */
export function getReplyWhenWhitelistDenied(cfg: any): boolean {
  const v = cfg?.channels?.onebot?.replyWhenWhitelistDenied;
  return v === undefined ? true : Boolean(v);
}
