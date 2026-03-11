/**
 * OneBot CLI 子命令：与 Agent 工具等价，供人工/工作流/AI 调用
 */

import { getOneBotConfig } from "./config.js";
import {
  ensureConnection,
  getGroupMsgHistory,
  getGroupMsgHistoryInRange,
  searchGroupMemberByName,
  uploadGroupFile,
  uploadPrivateFile,
} from "./connection.js";

function getApi(): any {
  return (globalThis as any).__onebotApi;
}

async function ensureOneBotConnection(): Promise<void> {
  const api = getApi();
  const config = getOneBotConfig(api);
  if (!config) {
    console.error("OneBot 未配置，请先运行 openclaw onebot setup 或配置 openclaw.json channels.onebot");
    process.exit(1);
  }
  await ensureConnection(() => getOneBotConfig(getApi()), 15000);
}

function parseGroupId(v: string): number {
  const n = parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) {
    console.error("--group-id 必须为数字");
    process.exit(1);
  }
  return n;
}

export function registerOneBotCli(onebot: any, api: any): void {
  if (!onebot || typeof onebot.command !== "function") return;

  onebot
    .command("get-group-msg-history")
    .description("获取群历史消息（单页或最近 N 小时内，始终从旧到新），需 Lagrange.Core")
    .requiredOption("--group-id <id>", "群号")
    .option("--hours <n>", "获取最近 N 小时内的消息（指定后按时间范围分页拉取）")
    .option("--count <n>", "条数（未指定 --hours 时生效）", "50")
    .option("--limit <n>", "指定 --hours 时最多条数", "3000")
    .option("--chunk-size <n>", "指定 --hours 时每页条数", "100")
    .option("--message-seq <seq>", "起始消息序号（分页用，未指定 --hours 时生效）")
    .action(async (opts: any) => {
      await ensureOneBotConnection();
      const groupId = parseGroupId(opts.groupId);
      const hoursOpt = opts.hours != null && opts.hours !== "" ? parseInt(String(opts.hours), 10) : undefined;
      if (Number.isFinite(hoursOpt) && hoursOpt! > 0) {
        const hours = hoursOpt!;
        const limit = parseInt(String(opts.limit || 3000), 10) || 3000;
        const chunkSize = parseInt(String(opts.chunkSize || 100), 10) || 100;
        const startTime = Math.floor(Date.now() / 1000) - hours * 3600;
        const msgs = await getGroupMsgHistoryInRange(groupId, { startTime, limit, chunkSize });
        const lines = msgs.map((m) => {
          const text = typeof m.message === "string" ? m.message : JSON.stringify(m.message);
          const nick = m.sender?.nickname ?? m.sender?.user_id ?? "?";
          return `[${new Date(m.time * 1000).toISOString()}] ${nick}: ${text.slice(0, 200)}`;
        });
        console.log(lines.join("\n") || "无历史消息");
        return;
      }
      const count = parseInt(String(opts.count || 50), 10) || 50;
      const messageSeq = opts.messageSeq != null ? parseInt(String(opts.messageSeq), 10) : undefined;
      const msgs = await getGroupMsgHistory(groupId, {
        count,
        reverse_order: true,
        message_seq: Number.isFinite(messageSeq) ? messageSeq : undefined,
      });
      const lines = msgs.map((m) => {
        const text = typeof m.message === "string" ? m.message : JSON.stringify(m.message);
        const nick = m.sender?.nickname ?? m.sender?.user_id ?? "?";
        return `[${new Date(m.time * 1000).toISOString()}] ${nick}: ${text.slice(0, 200)}`;
      });
      console.log(lines.join("\n") || "无历史消息");
    });

  onebot
    .command("search-group-member")
    .description("按名字模糊搜索群成员，返回 QQ 与展示名")
    .requiredOption("--group-id <id>", "群号")
    .requiredOption("--name <name>", "要搜索的名字（群名片或昵称）")
    .action(async (opts: any) => {
      await ensureOneBotConnection();
      const groupId = parseGroupId(opts.groupId);
      const name = String(opts.name || "").trim();
      if (!name) {
        console.error("--name 不能为空");
        process.exit(1);
      }
      const list = await searchGroupMemberByName(groupId, name);
      if (list.length === 0) {
        console.log(`未找到匹配「${name}」的群成员`);
        return;
      }
      list.forEach((m) => console.log(`QQ: ${m.user_id}  展示名: ${m.displayName}`));
    });

  onebot
    .command("upload-file")
    .description("上传文件到群或私聊")
    .requiredOption("--target <t>", "group:<群号> 或 user:<QQ号>")
    .requiredOption("--file <path>", "本地文件绝对路径")
    .requiredOption("--name <name>", "显示文件名")
    .action(async (opts: any) => {
      await ensureOneBotConnection();
      const t = String(opts.target || "").replace(/^onebot:/i, "").trim();
      const file = String(opts.file || "").trim();
      const name = String(opts.name || "").trim();
      if (!file || !name) {
        console.error("--file 与 --name 必填");
        process.exit(1);
      }
      const getConfig = () => getOneBotConfig(getApi());
      if (t.startsWith("group:")) {
        await uploadGroupFile(parseInt(t.slice(6), 10), file, name, getConfig);
        console.log("群文件上传成功");
      } else if (t.startsWith("user:")) {
        await uploadPrivateFile(parseInt(t.replace(/^user:/, ""), 10), file, name, getConfig);
        console.log("私聊文件上传成功");
      } else {
        console.error("--target 格式须为 group:<群号> 或 user:<QQ号>");
        process.exit(1);
      }
    });
}
