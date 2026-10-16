# opencode-tui-stats

A TUI plugin for OpenCode 1.x (v1) that shows a single line — `TPS | AVG | TTFT` — on the right side of the session prompt.

## Demo

![Demo](./assets/demo.gif)

## Installation

```bash
opencode plugin opencode-tui-stats --global
```

This command writes the plugin into opencode's TUI config. You can also install the `opencode-tui-stats` package from npm.

## Requirements

- opencode ≥ 1.3.14

## Metrics

- `TPS`: live generation rate within the most recent ~5-second streaming window (tokens/sec); shows `-` when the session is idle or data is stale.
- `AVG`: average generation rate of completed messages in this session (tokens/sec).
- `TTFT`: average time to first token of completed messages in this session (seconds).

## License

MIT — see [LICENSE](./LICENSE) in the repository root.
