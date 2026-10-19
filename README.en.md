# opencode-tui-stats

A TUI plugin for OpenCode 1.x (v1), mounted in the right sidebar content (slot `sidebar_content`), with the panel title `Model-Performance · observed`. Each model occupies one row that can be collapsed/expanded by mouse click.

## Demo

![Demo](./assets/demo.gif)

## Installation

```bash
opencode plugin opencode-tui-stats --global
```

This command writes the plugin into opencode's TUI config. You can also install the `opencode-tui-stats` package from npm.

## Requirements

- opencode ≥ 1.3.14

## Collapsing & subagents

- Each model occupies one row that can be collapsed/expanded by mouse click (`▼`/`▶`); rows are collapsed by default, and the most recently used model starts expanded.
- Collapsed: `▶ [↳ ]provider/model` (redundant same-provider prefix omitted; provider dimmed, model name bright).
- Expanded:
  - `AVG …t/s · TPS …t/s` (TPS shown only when a value exists; the final value is kept and dimmed after generation ends)
  - `TTFT …s · CACHE …%`
  - `$…` (cost on its own line)
- Models from subagents (sub-sessions) are merged into the same panel; rows originating from a subagent are prefixed with `↳`, and the same model (parent/child) is merged and summed.
- Panel footer: `Session CACHE …%` (aggregated across the whole session + subagent tree, 1 decimal place); `retries` is shown only when >0.

## Metrics

- `TPS`: generation rate within the most recent ~5-second streaming window (tokens/sec); the final value is frozen and dimmed after the stream stops.
- `AVG`: average generation rate of completed messages in this session (tokens/sec).
- `TTFT`: average time to first token (seconds, approximate, includes queue/retry wait).
- `CACHE`: prompt cache hit rate = `cache.read / (input + cache.read + cache.write)`, 1 decimal place.
- `COST`: cumulative session cost (aggregated per model/session).
- `RETRY`: retry count, derived from the attempt reported by the provider.

## License

MIT — see [LICENSE](./LICENSE) in the repository root.
