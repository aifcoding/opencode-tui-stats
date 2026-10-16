# opencode-tui-stats

OpenCode v1 TUI 插件：在会话提示区右侧显示 `TPS | AVG | TTFT`，即实时流式输出速度（TPS）、本次会话平均生成速度（AVG）以及平均首字延迟（TTFT）。

## 安装

```bash
opencode plugin opencode-tui-stats --global
```

要求宿主 opencode ≥ 1.3.14。

## 显示项

- `TPS`：最近 5 秒流式窗口内的实时 token/秒，空闲或数据过期时显示 `-`。
- `AVG`：本次会话已完成消息的平均 token/秒。
- `TTFT`：本次会话已完成消息的平均首字延迟（秒）。
