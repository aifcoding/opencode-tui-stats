# opencode-tui-stats

A TUI plugin for OpenCode 2.x (V2), mounted at the top of the right sidebar content (slot `sidebar.content`, prepended), with the panel title `Model-Performance · observed`. Each model occupies one row that can be collapsed/expanded by mouse click.

## Demo

![Demo](./assets/demo.gif)

## Installation

```bash
opencode plugin add opencode-tui-stats
```

This command adds the plugin to `plugins` in the global `opencode.json(c)`. You can also add it manually:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-tui-stats"],
}
```

For a CLI-only install that stays active against remote servers, add it to `cli.json` instead:

```jsonc
{
  "plugins": ["opencode-tui-stats"],
}
```

## Requirements

- opencode ≥ 2.0.0 (V2 plugin API)
- V1 plugin implementations do not run in V2; this version is not compatible with OpenCode 1.x

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
- `AVG`: average generation rate of completed steps in this session (tokens/sec).
- `TTFT`: average time to first token (seconds, approximate, includes queue/retry wait).
- `CACHE`: prompt cache hit rate = `cache.read / (input + cache.read + cache.write)`, 1 decimal place.
- `COST`: cumulative session cost (aggregated per model/session).
- `RETRY`: retry count, derived from the attempt reported by `session.status`.

Data comes from the V2 `session.step.started` / `session.text.delta` / `session.reasoning.delta` / `session.step.ended` events. `session.step.ended` is deduplicated by event id, so a reconnect replay never accumulates twice.

## Differences from the V1 version

- Quoting messages (`ctrl+q`) was removed: the V2 TUI plugin API no longer allows appending text to the prompt (`client.tui.appendPrompt` is gone), and the `tui.prompt.append` event is only consumed by the TUI — plugins cannot emit it.
- The panel API moved from `TuiPluginApi` to V2's `Plugin.define` + `Context` (`context.ui.slot`, `context.data`, `context.theme`).

## License

MIT — see [LICENSE](./LICENSE) in the repository root.
