# opencode-tui-stats

OpenCode 1.x（v1）的 TUI 插件，提供两个能力：

1. **模型性能面板**：安装在右侧栏内容区（slot `sidebar_content`），面板标题 `Model-Performance · observed`，每个模型占一行，鼠标点击可折叠/展开；
2. **引用消息**：`ctrl+q` 选中历史消息，把原文以引用形式插入输入框，再补问题发送。

## 演示

![Demo](./assets/demo.gif)

## 安装

```bash
opencode plugin opencode-tui-stats --global
```

该命令会把插件写入 opencode 的 tui 配置。也可以从 npm 安装 `opencode-tui-stats` 包。

## 引用消息

`ctrl+q`（或输入 `/quote`）打开居中的消息选择框，列出当前会话最近 40 条有文本的 user/assistant 消息，支持输入关键字过滤。

选中后会把该条消息以 Markdown 引用插入当前输入框：

```
> 原文第一行
> 原文第二行

```

然后继续写你的问题，回车发送。

- 单条最多引用 2000 字，超出会截断并标注「…（已截断）」
- 只插入文本，不会自动发送
- 备用快捷键：`ctrl+shift+q`
- 引用是纯文本，不会在 TUI 里渲染成引用卡片

## 环境要求

- opencode ≥ 1.3.14

## 折叠与子会话

- 每个模型占一行，鼠标点击可折叠/展开（`▼`/`▶`）；默认折叠，最近使用的模型默认展开。
- 折叠态：`▶ [↳ ]provider/model`（同 provider 前缀省略；provider 暗色、模型名亮色）。
- 展开态：
  - `AVG …t/s · TPS …t/s`（TPS 仅在有值时显示；生成结束后保留最后值并变暗）
  - `TTFT …s · CACHE …%`
  - `$…`（成本单独一行）
- 子会话（子 agent）的模型会并入同一面板，来自子会话的行前缀 `↳`；同一模型（父/子）合并求和。
- 面板底部：`Session CACHE …%`（整个会话 + 子会话树聚合，1 位小数）；`retries` 仅在 >0 时显示。

## 指标说明

- `TPS`：最近约 5 秒流式窗口内的生成速度（token/秒）；停止后冻结最后值并变暗。
- `AVG`：本会话已完成消息的平均生成速度（token/秒）。
- `TTFT`：平均首字延迟（秒，近似值，包含排队/重试等待）。
- `CACHE`：提示词缓存命中率 = `cache.read / (input + cache.read + cache.write)`，1 位小数。
- `COST`：会话累计成本（按模型/会话聚合）。
- `RETRY`：按 provider 上报的 attempt 统计的重试次数。

## License

MIT，详见仓库根目录的 [LICENSE](./LICENSE)。
