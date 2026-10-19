/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import {
  clearLastPanelController,
  createTracker,
  setLastPanelController,
  type ModelRow,
  type TrackerHandle,
} from "./tracker"

/** Detail lines sit three cells in from the fold marker, visually owned by the row above. */
const DETAIL_INDENT = "   "
/** Fixed cells keep every label on the same column across rows without measuring the panel. */
const RATE_CELL = 4
const TTFT_CELL = 6
const CACHE_CELL = 6

/** Split `provider/model` so the provider can be de-emphasised. Model ids may contain slashes, so
 * only the first slash separates the provider. When the model already starts with the provider name
 * (`deepseek/deepseek-flash`) the redundant prefix is dropped. */
function splitLabel(label: string) {
  const slash = label.indexOf("/")
  if (slash <= 0) return { provider: "", model: label }
  const provider = label.slice(0, slash)
  const model = label.slice(slash + 1)
  if (model.toLowerCase().startsWith(provider.toLowerCase())) return { provider: "", model }
  return { provider: `${provider}/`, model }
}

function rateCell(value: string | undefined) {
  return value === undefined ? "—" : `${value.padStart(RATE_CELL)}t/s`
}

function ttftCell(value: string | undefined) {
  return (value ?? "—").padEnd(TTFT_CELL)
}

function cacheCell(value: string | undefined) {
  if (value === undefined) return "—".padStart(CACHE_CELL)
  const percent = value.endsWith("%") ? value.slice(0, -1) : value
  return `${percent.padStart(5)}%`
}

/** A single model row: fold marker + summary line, plus its detail lines when expanded. */
function ModelRowView(props: { api: TuiPluginApi; row: ModelRow; expanded: boolean; onToggle: () => void }) {
  // Guard against a drag-select being read as a click: only toggle when the press and the
  // release land on the same cell.
  let pressed: { x: number; y: number } | undefined

  const handleMouseDown = (event: { x: number; y: number }) => {
    pressed = { x: event.x, y: event.y }
  }

  const handleMouseUp = (event: { x: number; y: number }) => {
    const start = pressed
    pressed = undefined
    if (start && (start.x !== event.x || start.y !== event.y)) return
    props.onToggle()
  }

  const theme = () => props.api.theme.current
  const parts = () => splitLabel(props.row.label)

  return (
    <box flexDirection="column" onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
      <text wrapMode="none" truncate>
        {/* The most recently used model gets a green dot; other rows keep a blank slot so
         * names stay aligned without spending extra width on a second marker. */}
        <span style={{ fg: theme().success } as Record<string, unknown>}>{props.row.active ? "● " : "  "}</span>
        <span style={{ fg: theme().textMuted } as Record<string, unknown>}>{`${props.expanded ? "▼" : "▶"} `}</span>
        <Show when={props.row.subagent}>
          <span style={{ fg: theme().textMuted } as Record<string, unknown>}>{"↳ "}</span>
        </Show>
        <Show when={parts().provider}>
          {/* Dimmed foreground sits between the model name and muted metadata without borrowing
           * a status colour, so the provider reads as its own tier even as themes change. */}
          <span style={{ fg: theme().text, dim: true } as Record<string, unknown>}>{parts().provider}</span>
        </Show>
        <span style={{ fg: theme().text } as Record<string, unknown>}>{parts().model}</span>
      </text>
      <Show when={props.expanded}>
        <text fg={theme().textMuted} wrapMode="none" truncate>
          <span style={{ fg: theme().textMuted } as Record<string, unknown>}>
            {`${DETAIL_INDENT}AVG ${rateCell(props.row.avg)}`}
          </span>
          <Show when={props.row.tps !== undefined}>
            <span style={{ fg: theme().textMuted } as Record<string, unknown>}>{" · TPS "}</span>
            {/* A frozen final reading stays visible but is dimmed to distinguish it from a
             * value backed by an active stream. */}
            <span style={{ fg: theme().textMuted, dim: !props.row.tpsLive } as Record<string, unknown>}>
              {rateCell(props.row.tps)}
            </span>
          </Show>
        </text>
        <text fg={theme().textMuted} wrapMode="none" truncate>
          {`${DETAIL_INDENT}TTFT ${ttftCell(props.row.ttft)} · CACHE ${cacheCell(props.row.cache)}`}
        </text>
        <text fg={theme().textMuted} wrapMode="none" truncate>
          {`${DETAIL_INDENT}${props.row.cost ?? "—"}`}
        </text>
      </Show>
    </box>
  )
}

/** Per-session model panel, mounted into the sidebar content (after the built-in sections). */
function ModelPanelView(props: {
  api: TuiPluginApi
  sessionID: string
  tracker: TrackerHandle
  revision: Accessor<number>
}) {
  let mounted: string | undefined
  const initialActive = props.tracker.internals.activeModel(props.sessionID)
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(initialActive ? [initialActive] : []))
  let seededActive: string | undefined = initialActive
  let lastSession: string | undefined = props.sessionID

  const panel = createMemo(() => {
    props.revision()
    const sessionID = props.sessionID
    if (mounted !== sessionID) {
      if (mounted !== undefined) props.tracker.unmountSession(mounted)
      props.tracker.mountSession(sessionID)
      mounted = sessionID
    }
    return props.tracker.modelRows(sessionID)
  })

  // Fold state is in-memory only and resets per session. The active model starts expanded and
  // every other row starts collapsed; when the active model changes we return to that default
  // so the panel cannot accumulate open rows as models are switched.
  createEffect(() => {
    props.revision()
    const sessionID = props.sessionID
    const active = props.tracker.internals.activeModel(sessionID)
    if (sessionID !== lastSession) {
      lastSession = sessionID
      seededActive = active
      setExpanded(new Set<string>(active ? [active] : []))
      return
    }
    if (active && active !== seededActive) {
      seededActive = active
      setExpanded(new Set<string>([active]))
    }
  })

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    props.api.renderer?.requestRender?.()
  }

  const controller = { toggle, isExpanded: (key: string) => expanded().has(key) }
  setLastPanelController(controller)

  onCleanup(() => {
    if (mounted !== undefined) props.tracker.unmountSession(mounted)
    clearLastPanelController(controller)
  })

  return (
    <box flexDirection="column">
      <text fg={props.api.theme.current.text} wrapMode="none" truncate>
        <b>Model-Performance · observed</b>
      </text>
      <Show when={panel().rows.length === 0}>
        <text fg={props.api.theme.current.textMuted} wrapMode="none" truncate>
          —
        </text>
      </Show>
      <For each={panel().rows}>
        {(row) => (
          <ModelRowView api={props.api} row={row} expanded={expanded().has(row.key)} onToggle={() => toggle(row.key)} />
        )}
      </For>
      <Show when={panel().overflow > 0}>
        <text fg={props.api.theme.current.textMuted} wrapMode="none" truncate>
          {`+${panel().overflow} more models`}
        </text>
      </Show>
      <text fg={props.api.theme.current.textMuted} wrapMode="none" truncate>
        {`Session CACHE ${panel().cache ?? "—"}${panel().retries > 0 ? ` · retries ${panel().retries}` : ""}`}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const [revision, setRevision] = createSignal(0)
  const tracker = createTracker(api, () => setRevision((value) => value + 1))

  api.lifecycle.onDispose(() => tracker.dispose())

  api.slots.register({
    slots: {
      sidebar_content(_context, props) {
        return <ModelPanelView api={api} sessionID={props.session_id} tracker={tracker} revision={revision} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "opencode-tui-stats",
  tui,
}

export default plugin
