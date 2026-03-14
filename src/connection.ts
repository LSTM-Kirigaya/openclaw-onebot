/**
 * OneBot WebSocket 连接与 API 调用
 *
 * 图片消息：
 * - 本机回环连接时：网络 URL 会先下载到本地再发送（兼容部分实现的 retcode 1200）
 * - 跨机器连接时：本地文件会自动转成 base64://，避免把宿主机绝对路径发给远端 OneBot
 * 并定期清理临时文件。
 */

import Fuse from "fuse.js";
import WebSocket from "ws";
import { createServer } from "http";
import https from "https";
import http from "http";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { OneBotAccountConfig } from "./types.js";
import { logSend } from "./send-debug-log.js";
import { shouldBlockSendInForwardMode, getActiveReplyTarget, getActiveReplySessionId } from "./reply-context.js";

const IMAGE_TEMP_DIR = join(tmpdir(), "openclaw-onebot");
const DOWNLOAD_TIMEOUT_MS = 30000;

/** 使用 Node 内置 http(s) 下载 URL，避免 fetch 在某些环境下的兼容性问题 */
function downloadUrl(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith("https") ? https : http;
        const req = lib.get(url, (res) => {
            const redirect = res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
            if (redirect) {
                downloadUrl(redirect.startsWith("http") ? redirect : new URL(redirect, url).href).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
            req.destroy();
            reject(new Error("Download timeout"));
        });
    });
}
const IMAGE_TEMP_MAX_AGE_MS = 60 * 60 * 1000; // 1 小时
const IMAGE_TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时清理一次

let imageTempCleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 清理过期的临时图片文件 */
function cleanupImageTemp(): void {
    try {
        if (!readdirSync) return;
        const files = readdirSync(IMAGE_TEMP_DIR);
        const now = Date.now();
        for (const f of files) {
            const p = join(IMAGE_TEMP_DIR, f);
            try {
                const st = statSync(p);
                if (st.isFile() && now - st.mtimeMs > IMAGE_TEMP_MAX_AGE_MS) {
                    unlinkSync(p);
                }
            } catch {
                /* ignore */
            }
        }
    } catch {
        /* dir not exist or readdir failed */
    }
}

/** 将 mediaUrl 解析为可发送的 file 路径。网络 URL 下载到本地，base64 解码到本地，定期清理过期文件 */
async function resolveImageToLocalPath(image: string): Promise<string> {
    const trimmed = image?.trim();
    if (!trimmed) throw new Error("Empty image");

    if (/^https?:\/\//i.test(trimmed)) {
        cleanupImageTemp();
        const buf = await downloadUrl(trimmed);
        const ext = (trimmed.match(/\.(png|jpg|jpeg|gif|webp|bmp)(?:\?|$)/i)?.[1] ?? "png").toLowerCase();
        mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
        const tmpPath = join(IMAGE_TEMP_DIR, `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        writeFileSync(tmpPath, buf);
        return tmpPath.replace(/\\/g, "/");
    }
    if (trimmed.startsWith("base64://")) {
        cleanupImageTemp();
        const b64 = trimmed.slice(9);
        const buf = Buffer.from(b64, "base64");
        mkdirSync(IMAGE_TEMP_DIR, { recursive: true });
        const tmpPath = join(IMAGE_TEMP_DIR, `img-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
        writeFileSync(tmpPath, buf);
        return tmpPath.replace(/\\/g, "/");
    }
    if (trimmed.startsWith("file://")) {
        return trimmed.slice(7).replace(/\\/g, "/");
    }
    return trimmed.replace(/\\/g, "/");
}

async function resolveImageToBuffer(image: string): Promise<Buffer> {
    const trimmed = image?.trim();
    if (!trimmed) throw new Error("Empty image");

    if (/^https?:\/\//i.test(trimmed)) {
        return downloadUrl(trimmed);
    }
    if (trimmed.startsWith("base64://")) {
        return Buffer.from(trimmed.slice(9), "base64");
    }
    if (trimmed.startsWith("file://")) {
        return readFileSync(trimmed.slice(7));
    }
    return readFileSync(trimmed);
}

function normalizePeerHost(host: string | undefined | null): string {
    const trimmed = String(host ?? "").trim().toLowerCase();
    if (!trimmed) return "";
    const unwrapped = trimmed.replace(/^\[/, "").replace(/\]$/, "");
    return unwrapped.startsWith("::ffff:") ? unwrapped.slice(7) : unwrapped;
}

function isLoopbackHost(host: string | undefined | null): boolean {
    const normalized = normalizePeerHost(host);
    return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function getSocketPeerHost(socket: WebSocket, getConfig?: () => OneBotAccountConfig | null): string {
    const peerHost = (socket as OneBotSocketWithPeer).__onebotPeerHost;
    if (peerHost) return peerHost;
    return getConfig?.()?.host ?? "";
}

function shouldEncodeImageAsBase64(socket: WebSocket, getConfig?: () => OneBotAccountConfig | null): boolean {
    const peerHost = getSocketPeerHost(socket, getConfig);
    return !!peerHost && !isLoopbackHost(peerHost);
}

async function resolveImageFileForSend(
    image: string,
    socket: WebSocket,
    getConfig?: () => OneBotAccountConfig | null
): Promise<string> {
    if (shouldEncodeImageAsBase64(socket, getConfig)) {
        return `base64://${(await resolveImageToBuffer(image)).toString("base64")}`;
    }
    return resolveImageToLocalPath(image);
}

/** 启动临时图片定期清理（每小时执行一次） */
export function startImageTempCleanup(): void {
    stopImageTempCleanup();
    imageTempCleanupTimer = setInterval(cleanupImageTemp, IMAGE_TEMP_CLEANUP_INTERVAL_MS);
}

/** 停止临时图片定期清理 */
export function stopImageTempCleanup(): void {
    if (imageTempCleanupTimer) {
        clearInterval(imageTempCleanupTimer);
        imageTempCleanupTimer = null;
    }
}


let ws: WebSocket | null = null;
let wsServer: import("ws").WebSocketServer | null = null;
let httpServer: import("http").Server | null = null;
const pendingEcho = new Map<string, { resolve: (v: any) => void }>();
let echoCounter = 0;

let connectionReadyResolve: (() => void) | null = null;
const connectionReadyPromise = new Promise<void>((r) => { connectionReadyResolve = r; });

type OneBotSocketWithPeer = WebSocket & { __onebotPeerHost?: string };

function nextEcho(): string {
    return `onebot-${Date.now()}-${++echoCounter}`;
}

export function handleEchoResponse(payload: any): boolean {
    if (payload?.echo && pendingEcho.has(payload.echo)) {
        const h = pendingEcho.get(payload.echo);
        h?.resolve(payload);
        return true;
    }
    return false;
}

function getLogger(): { info?: (s: string) => void; warn?: (s: string) => void } {
    return (globalThis as any).__onebotApi?.logger ?? {};
}

function sendOneBotAction(wsocket: WebSocket, action: string, params: Record<string, unknown>, log = getLogger()): Promise<any> {
    const echo = nextEcho();
    const payload = { action, params, echo };

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingEcho.delete(echo);
            log.warn?.(`[onebot] sendOneBotAction ${action} timeout`);
            reject(new Error(`OneBot action ${action} timeout`));
        }, 15000);

        pendingEcho.set(echo, {
            resolve: (v) => {
                clearTimeout(timeout);
                pendingEcho.delete(echo);
                if (v?.retcode !== 0) log.warn?.(`[onebot] sendOneBotAction ${action} retcode=${v?.retcode} msg=${v?.msg ?? ""}`);
                resolve(v);
            },
        });

        wsocket.send(JSON.stringify(payload), (err: Error | undefined) => {
            if (err) {
                pendingEcho.delete(echo);
                clearTimeout(timeout);
                reject(err);
            }
        });
    });
}

export function getWs(): WebSocket | null {
    return ws;
}

/** 为 WebSocket 设置 echo 响应处理（按需连接时需调用，以便 sendOneBotAction 能收到响应） */
function setupEchoHandler(socket: WebSocket): void {
    socket.on("message", (data: Buffer) => {
        try {
            const payload = JSON.parse(data.toString());
            handleEchoResponse(payload);
        } catch {
            /* ignore */
        }
    });
}

/** 等待 WebSocket 连接就绪（service 启动后异步建立连接，发送前需先等待） */
export async function waitForConnection(timeoutMs = 30000): Promise<WebSocket> {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    const log = getLogger();
    log.info?.("[onebot] waitForConnection: waiting for WebSocket...");
    return Promise.race([
        connectionReadyPromise.then(() => {
            if (ws && ws.readyState === WebSocket.OPEN) return ws;
            throw new Error("OneBot WebSocket not connected");
        }),
        new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`OneBot WebSocket not connected after ${timeoutMs}ms. Ensure "openclaw gateway run" is running and OneBot (Lagrange.Core) is connected.`)),
                timeoutMs
            )
        ),
    ]);
}

/**
 * 确保有可用的 WebSocket 连接。当 service 未启动时，
 * forward-websocket 模式直接建立连接（message send 可独立运行）；
 * backward-websocket 模式需等待 gateway 的 service 建立连接。
 */
export async function ensureConnection(
    getConfig: () => OneBotAccountConfig | null,
    timeoutMs = 30000
): Promise<WebSocket> {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    const config = getConfig();
    if (!config) throw new Error("OneBot not configured");
    const log = getLogger();
    if (config.type === "forward-websocket") {
        log.info?.("[onebot] 连接 OneBot (forward-websocket)...");
        const socket = await connectForward(config);
        setupEchoHandler(socket);
        setWs(socket);
        return socket;
    }
    return waitForConnection(timeoutMs);
}

export async function sendPrivateMsg(
    userId: number,
    text: string,
    getConfig?: () => OneBotAccountConfig | null
): Promise<number | undefined> {
    if (shouldBlockSendInForwardMode("private", userId)) {
        logSend("connection", "sendPrivateMsg", { targetId: userId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendPrivateMsg", {
        targetType: "user",
        targetId: userId,
        textPreview: text?.slice(0, 80),
        textLen: text?.length,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig
        ? await ensureConnection(getConfig)
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: text });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_private_msg failed (retcode=${res?.retcode})`);
    }
    const mid = res?.data?.message_id as number | undefined;
    logSend("connection", "sendPrivateMsg", { targetId: userId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
    return mid;
}

export async function sendGroupMsg(
    groupId: number,
    text: string,
    getConfig?: () => OneBotAccountConfig | null
): Promise<number | undefined> {
    if (shouldBlockSendInForwardMode("group", groupId)) {
        logSend("connection", "sendGroupMsg", { targetId: groupId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendGroupMsg", {
        targetType: "group",
        targetId: groupId,
        textPreview: text?.slice(0, 80),
        textLen: text?.length,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig
        ? await ensureConnection(getConfig)
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: text });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_group_msg failed (retcode=${res?.retcode})`);
    }
    const mid = res?.data?.message_id as number | undefined;
    logSend("connection", "sendGroupMsg", { targetId: groupId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
    return mid;
}

export async function sendGroupImage(
    groupId: number,
    image: string,
    log: { info?: (s: string) => void; warn?: (s: string) => void } = getLogger(),
    getConfig?: () => OneBotAccountConfig | null
): Promise<number | undefined> {
    if (shouldBlockSendInForwardMode("group", groupId)) {
        logSend("connection", "sendGroupImage", { targetId: groupId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendGroupImage", {
        targetType: "group",
        targetId: groupId,
        imagePreview: image?.slice?.(0, 60),
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    log.info?.(`[onebot] sendGroupImage entry: groupId=${groupId} image=${image?.slice?.(0, 80) ?? ""}`);
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    log.info?.(`222[onebot] sendGroupImage entry: groupId=${groupId} image=${image?.slice?.(0, 80) ?? ""}`);

    try {
        const filePath = image.startsWith("[") ? null : await resolveImageFileForSend(image, socket, getConfig);
        const seg = image.startsWith("[")
            ? JSON.parse(image)
            : [{ type: "image", data: { file: filePath! } }];

        log.info?.(`333[onebot] sendGroupImage entry: groupId=${groupId} image=${image?.slice?.(0, 80) ?? ""}`);

        const res = await sendOneBotAction(socket, "send_group_msg", { group_id: groupId, message: seg }, log);
        if (res?.retcode !== 0) {
            throw new Error(res?.msg ?? `OneBot send_group_msg (image) failed (retcode=${res?.retcode})`);
        }
        log.info?.(`[onebot] sendGroupImage done: retcode=${res?.retcode ?? "?"}`);
        const mid = res?.data?.message_id as number | undefined;
        logSend("connection", "sendGroupImage", { targetId: groupId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return mid;
    } catch (error) {
        log.warn?.(`[onebot] sendGroupImage error: ${error}`);
    }
}

/** 发送群合并转发消息。messages 为节点数组，每节点 { type: "node", data: { id } } 或 { type: "node", data: { user_id, nickname, content } } */
export async function sendGroupForwardMsg(
    groupId: number,
    messages: Array<{ type: string; data: Record<string, unknown> }>,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    logSend("connection", "sendGroupForwardMsg", {
        targetType: "group",
        targetId: groupId,
        nodeCount: messages.length,
        isForward: true,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_group_forward_msg", { group_id: groupId, messages });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_group_forward_msg failed (retcode=${res?.retcode})`);
    }
}

/** 发送私聊合并转发消息 */
export async function sendPrivateForwardMsg(
    userId: number,
    messages: Array<{ type: string; data: Record<string, unknown> }>,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    logSend("connection", "sendPrivateForwardMsg", {
        targetType: "user",
        targetId: userId,
        nodeCount: messages.length,
        isForward: true,
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const res = await sendOneBotAction(socket, "send_private_forward_msg", { user_id: userId, messages });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_private_forward_msg failed (retcode=${res?.retcode})`);
    }
}

export async function sendPrivateImage(
    userId: number,
    image: string,
    log: { info?: (s: string) => void; warn?: (s: string) => void } = getLogger(),
    getConfig?: () => OneBotAccountConfig | null
): Promise<number | undefined> {
    if (shouldBlockSendInForwardMode("private", userId)) {
        logSend("connection", "sendPrivateImage", { targetId: userId, blocked: true, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
        return undefined;
    }
    logSend("connection", "sendPrivateImage", {
        targetType: "user",
        targetId: userId,
        imagePreview: image?.slice?.(0, 60),
        sessionId: getActiveReplyTarget(),
        replySessionId: getActiveReplySessionId(),
    });
    log.info?.(`[onebot] sendPrivateImage entry: userId=${userId} image=${image?.slice?.(0, 80) ?? ""}`);
    const socket = getConfig ? await ensureConnection(getConfig) : await waitForConnection();
    const filePath = image.startsWith("[") ? null : await resolveImageFileForSend(image, socket, getConfig);
    const seg = image.startsWith("[")
        ? JSON.parse(image)
        : [{ type: "image", data: { file: filePath! } }];
    const res = await sendOneBotAction(socket, "send_private_msg", { user_id: userId, message: seg }, log);
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot send_private_msg (image) failed (retcode=${res?.retcode})`);
    }
    log.info?.(`[onebot] sendPrivateImage done: retcode=${res?.retcode ?? "?"}`);
    const mid = res?.data?.message_id as number | undefined;
    logSend("connection", "sendPrivateImage", { targetId: userId, messageId: mid, sessionId: getActiveReplyTarget(), replySessionId: getActiveReplySessionId() });
    return mid;
}

export async function uploadGroupFile(
    groupId: number, 
    file: string, 
    name: string,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    const socket = getConfig 
        ? await ensureConnection(getConfig) 
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "upload_group_file", { group_id: groupId, file, name });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot upload_group_file failed (retcode=${res?.retcode})`);
    }
}

export async function uploadPrivateFile(
    userId: number, 
    file: string, 
    name: string,
    getConfig?: () => OneBotAccountConfig | null
): Promise<void> {
    const socket = getConfig 
        ? await ensureConnection(getConfig) 
        : await waitForConnection();
    const res = await sendOneBotAction(socket, "upload_private_file", { user_id: userId, file, name });
    if (res?.retcode !== 0) {
        throw new Error(res?.msg ?? `OneBot upload_private_file failed (retcode=${res?.retcode})`);
    }
}

/** 撤回消息 */
export async function deleteMsg(messageId: number): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
    await sendOneBotAction(ws, "delete_msg", { message_id: messageId });
}

/**
 * 对消息进行表情回应（Lagrange/QQ NT 扩展 API）
 * @param message_id 需要回应的消息 ID（用户发送的消息）
 * @param emoji_id 表情 ID，1 通常为点赞
 * @param is_set true 添加，false 取消
 */
export async function setMsgEmojiLike(message_id: number, emoji_id: number, is_set: boolean = true): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("OneBot WebSocket not connected");
    await sendOneBotAction(ws, "set_msg_emoji_like", { message_id, emoji_id, is_set });
}

/** 获取陌生人信息（含 nickname） */
export async function getStrangerInfo(userId: number): Promise<{ nickname: string } | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_stranger_info", { user_id: userId, no_cache: false });
        if (res?.retcode === 0 && res?.data) return { nickname: String(res.data.nickname ?? "") };
        return null;
    } catch {
        return null;
    }
}

/** 获取群成员信息（含 nickname、card） */
export async function getGroupMemberInfo(groupId: number, userId: number): Promise<{ nickname: string; card: string } | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_group_member_info", { group_id: groupId, user_id: userId, no_cache: false });
        if (res?.retcode === 0 && res?.data) {
            return { nickname: String(res.data.nickname ?? ""), card: String(res.data.card ?? "") };
        }
        return null;
    } catch {
        return null;
    }
}

/** 群成员简要信息（用于列表与搜索） */
export interface GroupMemberItem {
    user_id: number;
    nickname: string;
    card: string;
}

/**
 * 获取群成员列表（OneBot get_group_member_list）
 */
export async function getGroupMemberList(groupId: number): Promise<GroupMemberItem[]> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return [];
    try {
        const res = await sendOneBotAction(ws, "get_group_member_list", { group_id: groupId });
        if (res?.retcode !== 0 || !Array.isArray(res?.data)) return [];
        return res.data.map((m: any) => ({
            user_id: Number(m.user_id),
            nickname: String(m.nickname ?? ""),
            card: String(m.card ?? ""),
        }));
    } catch {
        return [];
    }
}

/**
 * 按名字模糊匹配群成员（匹配群名片 card 与昵称 nickname），返回匹配到的 QQ 与展示名。
 * 使用 Fuse.js 模糊匹配，结果按相关度排序。
 */
export async function searchGroupMemberByName(
    groupId: number,
    name: string
): Promise<Array<{ user_id: number; nickname: string; card: string; displayName: string }>> {
    const list = await getGroupMemberList(groupId);
    const keyword = (name || "").trim();
    if (!keyword) return [];
    const fuse = new Fuse(list, {
        keys: ["card", "nickname"],
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true,
    });
    const results = fuse.search(keyword);
    return results.map(({ item: m }) => ({
        user_id: m.user_id,
        nickname: m.nickname,
        card: m.card,
        displayName: m.card || m.nickname || String(m.user_id),
    }));
}

/** 获取群信息（含 group_name） */
export async function getGroupInfo(groupId: number): Promise<{ group_name: string } | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_group_info", { group_id: groupId, no_cache: false });
        if (res?.retcode === 0 && res?.data) return { group_name: String(res.data.group_name ?? "") };
        return null;
    } catch {
        return null;
    }
}

/** QQ 头像 URL，s=640 为常用尺寸 */
export function getAvatarUrl(userId: number, size: number = 640): string {
    return `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=${size}`;
}

/** 获取单条消息（需 OneBot 实现支持） */
export async function getMsg(messageId: number): Promise<{
    time: number;
    message_type: string;
    message_id: number;
    real_id: number;
    sender: { user_id?: number; nickname?: string };
    message: string | unknown[];
} | null> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    try {
        const res = await sendOneBotAction(ws, "get_msg", { message_id: messageId });
        if (res?.retcode === 0 && res?.data) return res.data;
        return null;
    } catch {
        return null;
    }
}

/**
 * 获取群聊历史消息（Lagrange.Core 扩展 API，与 Lagrange.onebot context 一致）
 * 仅使用 message_seq 分页（不传 message_id），与 Tiphareth getLast24HGroupMessages 调用方式一致。
 * @param groupId 群号
 * @param opts message_seq 起始序号（不传表示从最新一页）；count 本页条数；reverse_order true 表示从旧到新，便于用 batch[0].message_seq 向前翻页
 */
export async function getGroupMsgHistory(
    groupId: number,
    opts: { message_seq?: number; message_id?: number; count: number; reverse_order?: boolean } = { count: 20 }
): Promise<Array<{
    time: number;
    message_type: string;
    message_id: number;
    real_id?: number;
    message_seq?: number;
    sender: { user_id?: number; nickname?: string };
    message: string | unknown[];
}>> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return [];
    try {
        const params: Record<string, unknown> = {
            group_id: groupId,
            count: opts.count ?? 20,
            reverse_order: opts.reverse_order !== false,
        };
        if (opts.message_seq != null && Number.isFinite(opts.message_seq)) {
            params.message_seq = opts.message_seq;
        }
        const res = await sendOneBotAction(ws, "get_group_msg_history", params);
        if (res?.retcode === 0 && res?.data?.messages) return res.data.messages;
        return [];
    } catch {
        return [];
    }
}

/** 单页请求之间的延迟（毫秒），与 Tiphareth historyMessages 一致 */
const HISTORY_PAGE_DELAY_MS = 500;

/**
 * 按时间范围分页获取群历史消息，严格对齐 Tiphareth getLast24HGroupMessages 算法：
 * getGroupMsgHistory(groupId, messageSeq, chunkSize, true)，用 batch[0] 的 message_seq 向前翻页，去重与时间截断。
 * @param groupId 群号
 * @param opts startTime 仅保留 >= startTime 的消息（Unix 秒）；limit 最多条数；chunkSize 每页条数
 */
export async function getGroupMsgHistoryInRange(
    groupId: number,
    opts: { startTime?: number; limit?: number; chunkSize?: number } = {}
): Promise<Array<{
    time: number;
    message_type: string;
    message_id: number;
    real_id?: number;
    message_seq?: number;
    sender: { user_id?: number; nickname?: string };
    message: string | unknown[];
}>> {
    const { startTime = 0, limit = 3000, chunkSize = 100 } = opts;
    let messageSeq: number | undefined = undefined;
    const allMessages: Array<{
        time: number;
        message_type: string;
        message_id: number;
        real_id?: number;
        message_seq?: number;
        sender: { user_id?: number; nickname?: string };
        message: string | unknown[];
    }> = [];
    const seenMessageIds = new Set<number>();
    let stopLoop = false;
    let pageCount = 0;

    while (!stopLoop) {
        pageCount++;

        const batch = await getGroupMsgHistory(groupId, {
            message_seq: messageSeq,
            count: chunkSize,
            reverse_order: true,
        });

        if (!batch.length) {
            break;
        }

        await new Promise((r) => setTimeout(r, HISTORY_PAGE_DELAY_MS));

        for (const msg of batch) {
            if (seenMessageIds.has(msg.message_id)) continue;
            seenMessageIds.add(msg.message_id);
            if (msg.time < startTime) {
                stopLoop = true;
            } else {
                allMessages.push(msg);
            }
        }

        const oldest = batch[0];
        const nextSeq = (oldest as { message_seq?: number }).message_seq ?? oldest.message_id;
        if (nextSeq == null || nextSeq === messageSeq) {
            break;
        }
        messageSeq = nextSeq;

        if (allMessages.length >= limit) {
            break;
        }
    }

    allMessages.sort((a, b) => a.time - b.time);
    return allMessages;
}

export async function connectForward(config: OneBotAccountConfig): Promise<WebSocket> {
    const path = config.path ?? "/onebot/v11/ws";
    const pathNorm = path.startsWith("/") ? path : `/${path}`;

    // 端口为 443 时使用 wss，其余端口使用 ws
    const scheme = config.port === 443 ? "wss" : "ws";
    const addr = `${scheme}://${config.host}:${config.port}${pathNorm}`;

    const headers: Record<string, string> = {};
    if (config.accessToken) {
        headers["Authorization"] = `Bearer ${config.accessToken}`;
    }

    const w = new WebSocket(addr, { headers });
    await new Promise<void>((resolve, reject) => {
        w.on("open", () => resolve());
        w.on("error", reject);
    });
    (w as OneBotSocketWithPeer).__onebotPeerHost = config.host;
    return w;
}

export async function createServerAndWait(config: OneBotAccountConfig): Promise<WebSocket> {
    const { WebSocketServer } = await import("ws");
    const server = createServer();
    httpServer = server;
    const wss = new WebSocketServer({
        server,
        path: config.path ?? "/onebot/v11/ws",
    });
    const host = config.host || "0.0.0.0";
    server.listen(config.port, host);

    wsServer = wss as any;

    return new Promise((resolve) => {
        wss.on("connection", (socket: WebSocket, req) => {
            (socket as OneBotSocketWithPeer).__onebotPeerHost = req.socket.remoteAddress ?? undefined;
            resolve(socket as WebSocket);
        });
    });
}

export function setWs(socket: WebSocket | null): void {
    ws = socket;
    if (socket && socket.readyState === WebSocket.OPEN && connectionReadyResolve) {
        connectionReadyResolve();
        connectionReadyResolve = null;
    }
}

export function stopConnection(): void {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (wsServer) {
        wsServer.close();
        wsServer = null;
    }
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}
