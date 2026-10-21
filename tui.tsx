/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import {
  MODEL_ROW_LIMIT,
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
/** Quarter-circle frames keep the live marker distinct from the braille spinners other tools use. */
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"]
const SPINNER_MS = 100

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

/** Guard against a drag-select being read as a click: only activate when the press and the
 * release land on the same cell. Shared by model rows and the overflow rows. */
function createPressGuard(onActivate: () => void) {
  let pressed: { x: number; y: number } | undefined

  const onMouseDown = (event: { x: number; y: number }) => {
    pressed = { x: event.x, y: event.y }
  }

  const onMouseUp = (event: { x: number; y: number }) => {
    const start = pressed
    pressed = undefined
    if (start && (start.x !== event.x || start.y !== event.y)) return
    onActivate()
  }

  return { onMouseDown, onMouseUp }
}

/** A single model row: fold marker + summary line, plus its detail lines when expanded. */
function ModelRowView(props: {
  api: TuiPluginApi
  row: ModelRow
  expanded: boolean
  frame: number
  onToggle: () => void
}) {
  const press = createPressGuard(() => props.onToggle())

  const theme = () => props.api.theme.current
  const parts = () => splitLabel(props.row.label)
  // Three-state marker: streaming spins, a busy model that has not produced tokens yet shows a
  // solid dot, and every other row keeps a blank slot so names stay aligned.
  const marker = () => {
    if (props.row.streaming) return `${SPINNER_FRAMES[props.frame]} `
    return props.row.busy ? "● " : "  "
  }

  return (
    <box flexDirection="column" onMouseDown={press.onMouseDown} onMouseUp={press.onMouseUp}>
      <text wrapMode="none" truncate>
        {/* The animated marker flags a model that is streaming right now, so parallel sessions can
         * light up several rows at once; a busy row that has not tokenised yet gets a solid dot. */}
        <span style={{ fg: theme().success } as Record<string, unknown>}>{marker()}</span>
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
        {/* Only a live stream gets an inline rate, so collapsed rows still expose parallel activity
         * without expanding; the frozen value stays in the expanded detail lines. */}
        <Show when={props.row.streaming && props.row.tps !== undefined}>
          <span style={{ fg: theme().textMuted } as Record<string, unknown>}>{`  ${rateCell(props.row.tps)}`}</span>
        </Show>
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

/** Overflow row: either counts the hidden models or offers to fold the list back. It shares the
 * row click handling so a click (not a drag) expands or collapses the full list. */
function OverflowRow(props: { api: TuiPluginApi; label: string; onActivate: () => void }) {
  const press = createPressGuard(() => props.onActivate())

  return (
    <box flexDirection="column" onMouseDown={press.onMouseDown} onMouseUp={press.onMouseUp}>
      <text fg={props.api.theme.current.textMuted} wrapMode="none" truncate>
        {props.label}
      </text>
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
  // The panel folds to MODEL_ROW_LIMIT rows by default; the overflow row expands it to every model.
  const [showAll, setShowAll] = createSignal(false)
  // The whole module can fold down to its title; the title row stays clickable in both states.
  const [collapsed, setCollapsed] = createSignal(false)
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
    return props.tracker.modelRows(sessionID, showAll() ? Number.POSITIVE_INFINITY : MODEL_ROW_LIMIT)
  })

  const [now, setNow] = createSignal(Date.now())
  const frame = () => Math.floor(now() / SPINNER_MS) % SPINNER_FRAMES.length

  // Only a live stream needs the 10fps animation: an idle panel keeps no timer at all, and the
  // revision signal stays out of the frame so TPS recalculation keeps its own cadence.
  // The interval is created once and toggled: streaming bumps the revision on nearly every delta,
  // so recreating it per effect run would clear each timer before its first 100ms tick.
  let animationTimer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    const streaming = panel().rows.some((row) => row.streaming)
    if (streaming && animationTimer === undefined) {
      // Signal updates only touch the virtual tree; the host paints on demand, so the animation
      // tick has to request a render or the glyph would stay on its first frame.
      animationTimer = setInterval(() => {
        setNow(Date.now())
        props.api.renderer?.requestRender?.()
      }, SPINNER_MS)
    } else if (!streaming && animationTimer !== undefined) {
      clearInterval(animationTimer)
      animationTimer = undefined
    }
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

  const toggleOverflow = () => {
    setShowAll((prev) => !prev)
    props.api.renderer?.requestRender?.()
  }

  const toggleCollapsed = () => {
    setCollapsed((prev) => !prev)
    props.api.renderer?.requestRender?.()
  }

  // Reuse the row click guard so a drag-select over the title does not fold the module.
  const titlePress = createPressGuard(() => toggleCollapsed())

  const controller = {
    toggle,
    isExpanded: (key: string) => expanded().has(key),
    toggleOverflow: () => toggleOverflow(),
    overflowExpanded: () => showAll(),
    toggleModule: () => toggleCollapsed(),
    moduleCollapsed: () => collapsed(),
  }
  setLastPanelController(controller)

  onCleanup(() => {
    if (animationTimer !== undefined) clearInterval(animationTimer)
    if (mounted !== undefined) props.tracker.unmountSession(mounted)
    clearLastPanelController(controller)
  })

  return (
    <box flexDirection="column">
      <box flexDirection="column" onMouseDown={titlePress.onMouseDown} onMouseUp={titlePress.onMouseUp}>
        <text wrapMode="none" truncate>
          {/* Fold marker stays muted so the bright bold title keeps the emphasis it had before. */}
          <span style={{ fg: props.api.theme.current.textMuted } as Record<string, unknown>}>
            {collapsed() ? "▶ " : "▼ "}
          </span>
          <b>Model-Performance · observed</b>
        </text>
      </box>
      <Show when={!collapsed()}>
        <Show when={panel().rows.length === 0}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none" truncate>
            —
          </text>
        </Show>
        <For each={panel().rows}>
          {(row) => (
            <ModelRowView
              api={props.api}
              row={row}
              expanded={expanded().has(row.key)}
              frame={frame()}
              onToggle={() => toggle(row.key)}
            />
          )}
        </For>
        <Show when={!showAll() && panel().overflow > 0}>
          <OverflowRow api={props.api} label={`+${panel().overflow} more models`} onActivate={toggleOverflow} />
        </Show>
        <Show when={showAll() && panel().rows.length > MODEL_ROW_LIMIT}>
          <OverflowRow api={props.api} label="− show fewer models" onActivate={toggleOverflow} />
        </Show>
        <text fg={props.api.theme.current.textMuted} wrapMode="none" truncate>
          {`Session CACHE ${panel().cache ?? "—"}${panel().retries > 0 ? ` · retries ${panel().retries}` : ""}`}
        </text>
      </Show>
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
