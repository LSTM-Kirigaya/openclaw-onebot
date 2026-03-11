# 发送消息（openclaw message send）

通过 OpenClaw 的 `openclaw message send` CLI 主动发送消息，由 Channel outbound 处理，无需 Agent 工具。

## 前置条件

- Gateway 已启动：`openclaw gateway`
- OneBot 渠道已配置并连接

## target 格式

| 格式 | 说明 |
|------|------|
| `user:123456789` | 私聊该 QQ 号 |
| `group:987654321` | 群聊该群号 |
| `123456789` | 纯数字且 > 100000000 时按用户处理，否则按群处理 |
| `onebot:group:xxx` / `qq:user:xxx` | 支持 onebot/qq/lagrange 前缀 |

## 发送文本

```bash
openclaw message send --channel onebot --target user:1193466151 --message "你好"
openclaw message send --channel onebot --target group:123456789 --message "群公告内容"
```

## 发送图片（mediaUrl）

`--media` 支持 `file://` 路径、`http://` URL 或 `base64://`：

```bash
openclaw message send --channel onebot --target user:1193466151 --media "file:///tmp/screenshot.png"
openclaw message send --channel onebot --target group:123456789 --media "https://example.com/pic.jpg" --message "附带说明"
```

## 发送文件

上传文件到群或私聊（区别于发送图片）：

```bash
openclaw onebot upload-file --target group:<群号> --file <本地绝对路径> --name <显示文件名>
openclaw onebot upload-file --target user:<QQ号> --file <本地绝对路径> --name <显示文件名>
```

示例：

```bash
openclaw onebot upload-file --target group:123456789 --file /home/user/document.pdf --name "会议纪要.pdf"
openclaw onebot upload-file --target user:987654321 --file /tmp/report.xlsx --name "月度报表.xlsx"
```

## 说明

- **回复场景**（用户发消息 → Agent 回复）：由 deliver 自动处理，Agent 输出 text/mediaUrl 即会送达
- **主动发送**（CLI 或工作流）：使用上述 `openclaw message send` 命令
- **文件上传**：使用 `openclaw onebot upload-file`，适合发送文档等非图片文件
- 无 Agent 工具挂载，减少 token 消耗，提升扩展性
