# opencode-tui-stats

OpenCode 2.x（V2）的 TUI 插件：在右侧栏内容区顶部（slot `sidebar.content`，prepend 方式）展示模型性能面板，标题为 `Model-Performance · observed`，每个模型占一行，鼠标点击可折叠/展开。

## 演示

![Demo](./assets/demo.gif)

## 安装

```bash
opencode plugin add opencode-tui-stats
```

该命令会把插件写入全局 `opencode.json(c)` 的 `plugins`。也可以手动添加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-tui-stats"],
}
```

如果只想在本机终端里启用（连接远程服务端时仍然生效），可以写进 `cli.json`：

```jsonc
{
  "plugins": ["opencode-tui-stats"],
}
```

## 环境要求

- opencode ≥ 2.0.0（V2 插件 API）
- V1 插件实现不会在 V2 中运行，本版本不兼容 OpenCode 1.x

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
- `AVG`：本会话已完成 step 的平均生成速度（token/秒）。
- `TTFT`：平均首字延迟（秒，近似值，包含排队/重试等待）。
- `CACHE`：提示词缓存命中率 = `cache.read / (input + cache.read + cache.write)`，1 位小数。
- `COST`：会话累计成本（按模型/会话聚合）。
- `RETRY`：按 `session.status` 上报的 attempt 统计的重试次数。

数据来源是 V2 的 `session.step.started` / `session.text.delta` / `session.reasoning.delta` / `session.step.ended` 等事件；`session.step.ended` 按事件 id 去重，断线重放不会重复累计。

## 与 V1 版本的差异

- 引用消息（`ctrl+q`）已移除：V2 的 TUI 插件 API 不再提供向输入框追加文本的能力（`client.tui.appendPrompt` 已删除），`tui.prompt.append` 事件只由 TUI 消费、插件无法发出。
- 面板 API 从 `TuiPluginApi` 改为 V2 的 `Plugin.define` + `Context`（`context.ui.slot`、`context.data`、`context.theme`）。

## License

MIT，详见仓库根目录的 [LICENSE](./LICENSE)。
