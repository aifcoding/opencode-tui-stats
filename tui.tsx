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

/** A single model row: fold marker + summary line, plus a detail line when expanded. */
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

  return (
    <box flexDirection="column" onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
      <text wrapMode="none" truncate>
        <span style={{ fg: theme().textMuted } as Record<string, unknown>}>{`${props.expanded ? "▼" : "▶"} `}</span>
        <span style={{ fg: theme().text } as Record<string, unknown>}>{props.row.label}</span>
        <Show when={props.row.active}>
          <span style={{ fg: theme().success } as Record<string, unknown>}>{"   active"}</span>
        </Show>
      </text>
      <Show when={props.expanded}>
        <text fg={theme().text} wrapMode="none" truncate>
          {`TPS ${props.row.tps ?? "—"} · AVG ${props.row.avg ?? "—"}`}
        </text>
        <text fg={theme().text} wrapMode="none" truncate>
          {`TTFT ${props.row.ttft ?? "—"} · CACHE ${props.row.cache ?? "—"} · ${props.row.cost ?? "—"}`}
        </text>
      </Show>
    </box>
  )
}

/** Per-session model panel, mounted at `sidebar_content`. */
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
      <text fg={props.api.theme.current.textMuted}>Performance · observed</text>
      <Show when={panel().rows.length === 0}>
        <text fg={props.api.theme.current.textMuted}>—</text>
      </Show>
      <For each={panel().rows}>
        {(row) => (
          <ModelRowView api={props.api} row={row} expanded={expanded().has(row.key)} onToggle={() => toggle(row.key)} />
        )}
      </For>
      <Show when={panel().overflow > 0}>
        <text fg={props.api.theme.current.textMuted}>{`+${panel().overflow} more models`}</text>
      </Show>
      <text fg={props.api.theme.current.text}>
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
