# opencode-tui-stats

OpenCode 1.x（v1）的 TUI 插件，安装在右侧栏底部（slot `sidebar_footer`），面板标题为 `Performance · observed`。每个模型占一行，鼠标点击可折叠/展开。

## 演示

![Demo](./assets/demo.gif)

## 安装

```bash
opencode plugin opencode-tui-stats --global
```

该命令会把插件写入 opencode 的 tui 配置。也可以从 npm 安装 `opencode-tui-stats` 包。

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
