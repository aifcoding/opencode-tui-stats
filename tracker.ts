import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export type StreamSample = {
  at: number
  messageID: string
  tokens: number
}

export type MessageTiming = {
  sessionID: string
  requestStartAt: number
  firstResponseAt?: number
  lastToolCallAt?: number
}

export type SessionAverage = {
  totalTokens: number
  totalDurationMs: number
  totalTtftMs: number
  stepCount: number
}

export type SessionStats = {
  cacheRead: number
  cachePrompt: number
  cost: number
  steps: number
  retries: number
  lastAttempt: number
}

/** Per-model aggregate within a session, keyed by `providerID/modelID`.
 * `cacheRead`/`cachePrompt`/`cost`/`steps` mirror {@link SessionStats}; the `total*`/`stepCount`
 * fields mirror {@link SessionAverage} so the existing rate/TTFT helpers can be reused as-is. */
export type ModelAggregate = {
  cacheRead: number
  cachePrompt: number
  cost: number
  steps: number
  totalTokens: number
  totalDurationMs: number
  totalTtftMs: number
  stepCount: number
  /** Last time this model was observed in this session (merged with `max` across a subtree). */
  lastAt: number
}

export type SessionModels = {
  /** Most recently observed assistant `providerID/modelID` for the session. */
  active?: string
  /** Model keys in observation order (oldest first, most recent last). */
  order: string[]
  aggregates: Record<string, ModelAggregate>
  /** `messageID -> providerID/modelID`, used to attribute live samples to a model. */
  messageModels: Map<string, string>
}

export type Tracker = {
  samples: Record<string, StreamSample[]>
  timings: Record<string, MessageTiming>
  averages: Record<string, SessionAverage>
  stats: Record<string, SessionStats>
  dedup: Record<string, Set<string>>
  models: Record<string, SessionModels>
  /** `sessionID -> parentID`; a key that is present with an `undefined` value is a confirmed root. */
  parentOf: Record<string, string | undefined>
}

const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000
const PART_CACHE_LIMIT = 1_024
/** Per-session dedup window: only the most recent completed messages are deduplicated;
 * a repeated completed event beyond this window accumulates again. */
const DEDUP_WINDOW_LIMIT = 64
/** Cap on `messageID -> model` entries retained per session (FIFO). */
const MESSAGE_MODEL_LIMIT = 256
const SESSION_LIMIT = 64
/** Maximum number of descendant sessions folded into one panel (cycle-safe traversal bound). */
const SUBTREE_LIMIT = 64
/** Maximum number of model rows rendered in the sidebar panel. */
export const MODEL_ROW_LIMIT = 4

function emptyStats(): SessionStats {
  return { cacheRead: 0, cachePrompt: 0, cost: 0, steps: 0, retries: 0, lastAttempt: 0 }
}

function emptyAggregate(): ModelAggregate {
  return {
    cacheRead: 0,
    cachePrompt: 0,
    cost: 0,
    steps: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    totalTtftMs: 0,
    stepCount: 0,
    lastAt: 0,
  }
}

export function modelKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`
}

export function estimateTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))
}

export function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function formatTtft(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined
  return `${value.toFixed(1)}s`
}

export function activeDuration(samples: StreamSample[], tailAt?: number) {
  if (samples.length === 0) return 0
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS)
  }

  let duration = 0
  for (let index = 1; index < samples.length; index++) {
    duration += Math.max(0, samples[index].at - samples[index - 1].at)
  }
  if (tailAt) duration += Math.max(0, tailAt - samples[samples.length - 1].at)
  return Math.max(duration, SINGLE_SAMPLE_MS)
}

export function averageRate(average: SessionAverage | undefined) {
  if (!average || average.totalTokens <= 0 || average.totalDurationMs <= 0) return undefined
  return formatRate(average.totalTokens / (average.totalDurationMs / 1_000))
}

export function averageTtft(average: SessionAverage | undefined) {
  if (!average || average.stepCount <= 0) return undefined
  return formatTtft(average.totalTtftMs / average.stepCount / 1_000)
}

/** Cache hit percentage (e.g. `31%`) or `undefined` when nothing promptable has been seen. */
export function cacheText(stats: { cacheRead: number; cachePrompt: number } | undefined) {
  if (!stats || stats.cachePrompt <= 0) return undefined
  return `${Math.round((stats.cacheRead / stats.cachePrompt) * 100)}%`
}

export function costText(stats: { cost: number; steps: number } | undefined) {
  if (!stats || stats.steps <= 0) return undefined
  // Always four decimals so the cost column keeps a stable width as spend grows.
  return `$${stats.cost.toFixed(4)}`
}

/** FIFO-bound a Set so it never grows past `limit`. */
function boundedAdd(set: Set<string>, key: string, limit: number) {
  if (set.has(key)) return
  if (set.size >= limit) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(key)
}

/** FIFO-bound a Map so it never grows past `limit`. */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  if (map.has(key)) return
  if (map.size >= limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

export type ModelRow = {
  key: string
  label: string
  active: boolean
  /** True when any descendant (subagent) session contributed data to this row. */
  subagent?: boolean
  tps?: string
  avg?: string
  ttft?: string
  cache?: string
  cost?: string
}

export type ModelPanel = {
  rows: ModelRow[]
  overflow: number
  retries: number
  /** Session-level cache hit percentage (e.g. `31%`), or `undefined` when nothing promptable was seen. */
  cache?: string
}

export type TrackerInternals = {
  sizes(): {
    parts: number
    dedup: number
    stats: number
    averages: number
    timings: number
    mounted: number
  }
  partDecision(partID: string): boolean | undefined
  hasStats(sessionID: string): boolean
  dedupSize(sessionID: string): number
  retries(sessionID: string): number
  mounted(): string[]
  activeModel(sessionID: string): string | undefined
}

export type TrackerHandle = {
  modelRows(sessionID: string): ModelPanel
  mountSession(sessionID: string): void
  unmountSession(sessionID: string): void
  prune(now?: number): void
  internals: TrackerInternals
  dispose(): void
}

let lastInternals: TrackerInternals | undefined

/** Test-only access to the most recently created tracker's internals. */
export function getLastInternals(): TrackerInternals | undefined {
  return lastInternals
}

export function createTracker(api: TuiPluginApi, onChange: () => void): TrackerHandle {
  const tracker: Tracker = {
    samples: {},
    timings: {},
    averages: {},
    stats: {},
    dedup: {},
    models: {},
    parentOf: {},
  }
  const partDecisions = new Map<string, boolean>()
  const mounted = new Set<string>()
  const order: string[] = []
  const listeners: Array<() => void> = []

  const bump = () => onChange()

  const clearLive = (sessionID: string) => {
    if (!tracker.samples[sessionID]?.length) return
    delete tracker.samples[sessionID]
    bump()
  }

  const clearTimings = (sessionID: string) => {
    let changed = false
    for (const [messageID, timing] of Object.entries(tracker.timings)) {
      if (timing.sessionID !== sessionID) continue
      delete tracker.timings[messageID]
      changed = true
    }
    if (changed) bump()
  }

  const evictSession = (sessionID: string) => {
    delete tracker.stats[sessionID]
    delete tracker.averages[sessionID]
    delete tracker.samples[sessionID]
    delete tracker.dedup[sessionID]
    delete tracker.models[sessionID]
    delete tracker.parentOf[sessionID]
    clearTimings(sessionID)
  }

  const touchSession = (sessionID: string) => {
    const at = order.indexOf(sessionID)
    if (at !== -1) order.splice(at, 1)
    order.push(sessionID)

    // Evict least recently used sessions past the cap, never the sessions currently mounted for display.
    let index = 0
    while (order.length > SESSION_LIMIT && index < order.length) {
      const candidate = order[index]
      if (mounted.has(candidate)) {
        index += 1
        continue
      }
      order.splice(index, 1)
      evictSession(candidate)
    }
  }

  const touchModel = (models: SessionModels, key: string) => {
    const at = models.order.indexOf(key)
    if (at !== -1) models.order.splice(at, 1)
    models.order.push(key)
    if (!models.aggregates[key]) models.aggregates[key] = emptyAggregate()
  }

  const prune = (now = Date.now()) => {
    let changed = false

    for (const [sessionID, samples] of Object.entries(tracker.samples)) {
      const next = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
      if (next.length === samples.length) continue
      changed = true
      if (next.length > 0) tracker.samples[sessionID] = next
      else delete tracker.samples[sessionID]
    }

    if (changed) bump()
  }

  const appendSample = (sessionID: string, messageID: string, sample: StreamSample) => {
    touchSession(sessionID)
    tracker.samples[sessionID] = [
      ...(tracker.samples[sessionID] ?? []).filter((item) => sample.at - item.at <= STREAM_WINDOW_MS),
      sample,
    ]
    const timing = tracker.timings[messageID]
    if (timing && timing.firstResponseAt === undefined) timing.firstResponseAt = sample.at
    bump()
  }

  /** Live rate restricted to samples attributed to `key` via the `messageID -> model` mapping. */
  const sessionLiveRate = (sessionID: string, key: string) => {
    const status = api.state.session.status(sessionID)
    if (!status || status.type === "idle") return undefined

    const now = Date.now()
    const mapping = tracker.models[sessionID]?.messageModels
    const samples = (tracker.samples[sessionID] ?? []).filter(
      (sample) => now - sample.at <= STREAM_WINDOW_MS && mapping?.get(sample.messageID) === key,
    )
    const last = samples[samples.length - 1]
    if (!last || now - last.at > LIVE_STALE_MS) return undefined

    const tokens = samples.reduce((sum, sample) => sum + sample.tokens, 0)
    return formatRate(tokens / (activeDuration(samples, now) / 1_000))
  }

  /** Fold a session's parent from `session.created`/`session.updated`, or lazily from state.
   * A successful lookup is cached; an unknown session is retried on the next render. */
  const resolveParent = (sessionID: string) => {
    if (sessionID in tracker.parentOf) return
    const info = api.state.session.get(sessionID)
    if (!info) return
    tracker.parentOf[sessionID] = info.parentID
  }

  const rememberParent = (sessionID: string, parentID: string | undefined) => {
    if (sessionID in tracker.parentOf && tracker.parentOf[sessionID] === parentID) return
    tracker.parentOf[sessionID] = parentID
    bump()
  }

  const knownSessions = () => {
    const ids = new Set<string>(Object.keys(tracker.models))
    for (const id of Object.keys(tracker.stats)) ids.add(id)
    for (const id of Object.keys(tracker.averages)) ids.add(id)
    return ids
  }

  /** Breadth-first descendants of `sessionID` (excluding itself), cycle-safe and capped. */
  const descendants = (sessionID: string) => {
    const children = new Map<string, string[]>()
    for (const [child, parent] of Object.entries(tracker.parentOf)) {
      if (!parent) continue
      const siblings = children.get(parent)
      if (siblings) siblings.push(child)
      else children.set(parent, [child])
    }

    const seen = new Set<string>([sessionID])
    const found: string[] = []
    const queue = [sessionID]
    while (queue.length > 0 && found.length < SUBTREE_LIMIT) {
      const current = queue.shift()!
      for (const child of children.get(current) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        found.push(child)
        queue.push(child)
        if (found.length >= SUBTREE_LIMIT) break
      }
    }
    return found
  }

  const mergeAggregate = (target: ModelAggregate, source: ModelAggregate) => {
    target.cacheRead += source.cacheRead
    target.cachePrompt += source.cachePrompt
    target.cost += source.cost
    target.steps += source.steps
    target.totalTokens += source.totalTokens
    target.totalDurationMs += source.totalDurationMs
    target.totalTtftMs += source.totalTtftMs
    target.stepCount += source.stepCount
    target.lastAt = Math.max(target.lastAt, source.lastAt)
  }

  const sessionModelAt = (sessionID: string) => {
    const models = tracker.models[sessionID]
    if (!models) return 0
    let at = 0
    for (const key of models.order) {
      const aggregate = models.aggregates[key]
      if (aggregate && aggregate.lastAt > at) at = aggregate.lastAt
    }
    return at
  }

  /** Live rate for a merged row: the parent and its subagents share one row, so only the
   * session/model pair that most recently saw activity contributes. Concurrent streams in a
   * parent and a child are therefore approximated by the newer one instead of being summed. */
  const liveRateFor = (sessions: string[], key: string) => {
    let latest: { sessionID: string; at: number } | undefined
    for (const sessionID of sessions) {
      const aggregate = tracker.models[sessionID]?.aggregates[key]
      if (!aggregate) continue
      if (!latest || aggregate.lastAt >= latest.at) latest = { sessionID, at: aggregate.lastAt }
    }
    if (!latest) return undefined
    return sessionLiveRate(latest.sessionID, key)
  }

  const modelRows = (sessionID: string): ModelPanel => {
    // Link sessions that only announced themselves through message events (a child can stream
    // before its `session.created` event is delivered).
    for (const id of knownSessions()) resolveParent(id)

    const subtree = [sessionID, ...descendants(sessionID)]
    const retries = tracker.stats[sessionID]?.retries ?? 0

    // Session CACHE uses the same subtree scope as the model rows.
    let cacheRead = 0
    let cachePrompt = 0
    for (const id of subtree) {
      const stats = tracker.stats[id]
      if (!stats) continue
      cacheRead += stats.cacheRead
      cachePrompt += stats.cachePrompt
    }
    const cache = cacheText({ cacheRead, cachePrompt })

    // Fold the subtree oldest→newest so `order` keeps its "oldest first" meaning across sessions.
    const sessions = subtree
      .filter((id) => tracker.models[id])
      .sort((left, right) => sessionModelAt(left) - sessionModelAt(right))
    if (sessions.length === 0) return { rows: [], overflow: 0, retries, cache }

    const order: string[] = []
    const aggregates: Record<string, ModelAggregate> = {}
    const subagentModels = new Set<string>()
    for (const id of sessions) {
      const models = tracker.models[id]
      for (const key of models.order) {
        const aggregate = models.aggregates[key]
        if (!aggregate) continue
        let merged = aggregates[key]
        if (!merged) {
          merged = emptyAggregate()
          aggregates[key] = merged
          order.push(key)
        }
        mergeAggregate(merged, aggregate)
        if (id !== sessionID) subagentModels.add(key)
      }
    }

    let active: string | undefined
    for (const id of sessions) active = tracker.models[id].active ?? active

    // `order` is oldest→newest; reverse for most-recent-first ordering of the non-active rows.
    const recency = [...order].reverse()
    const ordered = active && active in aggregates ? [active, ...recency.filter((key) => key !== active)] : recency

    const visible = ordered.slice(0, MODEL_ROW_LIMIT)
    const overflow = Math.max(0, ordered.length - visible.length)

    const rows = visible.map<ModelRow>((key) => {
      const aggregate = aggregates[key]
      const isActive = key === active
      return {
        key,
        label: key,
        active: isActive,
        subagent: subagentModels.has(key),
        tps: isActive ? liveRateFor(subtree, key) : undefined,
        avg: averageRate(aggregate),
        ttft: averageTtft(aggregate),
        cache: cacheText(aggregate),
        cost: costText(aggregate),
      }
    })

    return { rows, overflow, retries, cache }
  }

  listeners.push(
    api.event.on("message.part.delta", (event) => {
      if (event.properties.field !== "text") return
      const { sessionID, messageID, partID } = event.properties

      // partID → decision (true = counted, false = ignored). A part that is not registered yet is
      // never cached, so the next delta retries the lookup; once found the accept/reject decision
      // is cached so each part is scanned at most once.
      let counted = partDecisions.get(partID)
      if (counted === undefined) {
        const part = api.state.part(messageID).find((item) => item.id === partID)
        if (!part) return
        counted = part.type === "text" || part.type === "reasoning"
        boundedSet(partDecisions, partID, counted, PART_CACHE_LIMIT)
      }
      if (!counted) return

      appendSample(sessionID, messageID, {
        at: Date.now(),
        messageID,
        tokens: estimateTokens(event.properties.delta),
      })
    }),
  )

  listeners.push(
    api.event.on("message.updated", (event) => {
      const info = event.properties.info
      if (info.role !== "assistant") return
      const sessionID = event.properties.sessionID
      const key = modelKey(info.providerID, info.modelID)

      // Observe the model as soon as a message appears so the sidebar can attribute live samples
      // and mark the most recently used model as active.
      const models =
        tracker.models[sessionID] ?? (tracker.models[sessionID] = { order: [], aggregates: {}, messageModels: new Map() })
      touchModel(models, key)
      models.active = key
      models.aggregates[key] = { ...models.aggregates[key], lastAt: Date.now() }
      boundedSet(models.messageModels, info.id, key, MESSAGE_MODEL_LIMIT)

      if (!info.time.completed) {
        const existing = tracker.timings[info.id]
        tracker.timings[info.id] = {
          sessionID,
          requestStartAt: info.time.created,
          firstResponseAt: existing?.firstResponseAt,
          lastToolCallAt: existing?.lastToolCallAt,
        }
        bump()
        return
      }

      // Dedup only the most recent completed messages for this session; a repeated completed
      // event beyond the window accumulates again.
      const seen = tracker.dedup[sessionID] ?? (tracker.dedup[sessionID] = new Set<string>())
      if (!seen.has(info.id)) {
        boundedAdd(seen, info.id, DEDUP_WINDOW_LIMIT)
        touchSession(sessionID)
        const stats = tracker.stats[sessionID] ?? emptyStats()
        const cacheRead = info.tokens.cache.read
        const cacheWrite = info.tokens.cache.write
        tracker.stats[sessionID] = {
          ...stats,
          cacheRead: stats.cacheRead + cacheRead,
          cachePrompt: stats.cachePrompt + info.tokens.input + cacheRead + cacheWrite,
          cost: stats.cost + info.cost,
          steps: stats.steps + 1,
        }
        const aggregate = models.aggregates[key] ?? emptyAggregate()
        models.aggregates[key] = {
          ...aggregate,
          cacheRead: aggregate.cacheRead + cacheRead,
          cachePrompt: aggregate.cachePrompt + info.tokens.input + cacheRead + cacheWrite,
          cost: aggregate.cost + info.cost,
          steps: aggregate.steps + 1,
        }
      }

      const timing = tracker.timings[info.id]
      if (timing?.sessionID === sessionID && timing.firstResponseAt !== undefined) {
        const tokens = info.tokens.output + info.tokens.reasoning
        const endAt = info.finish === "tool-calls" ? timing.lastToolCallAt : info.time.completed
        const durationMs = endAt !== undefined ? Math.max(endAt - timing.firstResponseAt, 1) : undefined
        if (tokens > 0 && durationMs !== undefined) {
          const totals = tracker.averages[sessionID] ?? {
            totalTokens: 0,
            totalDurationMs: 0,
            totalTtftMs: 0,
            stepCount: 0,
          }
          tracker.averages[sessionID] = {
            totalTokens: totals.totalTokens + tokens,
            totalDurationMs: totals.totalDurationMs + durationMs,
            totalTtftMs: totals.totalTtftMs + Math.max(timing.firstResponseAt - timing.requestStartAt, 0),
            stepCount: totals.stepCount + 1,
          }
          const aggregate = models.aggregates[key] ?? emptyAggregate()
          models.aggregates[key] = {
            ...aggregate,
            totalTokens: aggregate.totalTokens + tokens,
            totalDurationMs: aggregate.totalDurationMs + durationMs,
            totalTtftMs: aggregate.totalTtftMs + Math.max(timing.firstResponseAt - timing.requestStartAt, 0),
            stepCount: aggregate.stepCount + 1,
          }
        }
      }
      delete tracker.timings[info.id]
      prune(info.time.completed)
      bump()
    }),
  )

  listeners.push(
    api.event.on("message.part.updated", (event) => {
      const part = event.properties.part
      if (part.type !== "tool") return

      if (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error") {
        clearLive(part.sessionID)
      }

      const timing = tracker.timings[part.messageID]
      if (!timing) return

      if (part.state.status === "pending") {
        if (timing.firstResponseAt === undefined) timing.firstResponseAt = Date.now()
        bump()
        return
      }
      if (part.state.status === "running") {
        timing.lastToolCallAt = part.state.time.start
        bump()
      }
    }),
  )

  listeners.push(
    api.event.on("session.status", (event) => {
      const { sessionID, status } = event.properties
      const type = status.type

      if (type === "idle") clearTimings(sessionID)

      const stats = tracker.stats[sessionID] ?? emptyStats()

      if (type === "retry") {
        const attempt = status.attempt
        if (attempt <= stats.lastAttempt) return
        touchSession(sessionID)
        tracker.stats[sessionID] = {
          ...stats,
          retries: stats.retries + (attempt - stats.lastAttempt),
          lastAttempt: attempt,
        }
        bump()
        return
      }

      // Any non-retry status resets the attempt baseline for the next retry burst.
      if (stats.lastAttempt === 0) return
      touchSession(sessionID)
      tracker.stats[sessionID] = { ...stats, lastAttempt: 0 }
      bump()
    }),
  )

  listeners.push(
    api.event.on("session.idle", (event) => {
      clearTimings(event.properties.sessionID)
    }),
  )

  // Subagent sessions announce their parent here; the tree is also backfilled lazily from state.
  listeners.push(
    api.event.on("session.created", (event) => {
      rememberParent(event.properties.info.id, event.properties.info.parentID)
    }),
  )

  listeners.push(
    api.event.on("session.updated", (event) => {
      rememberParent(event.properties.info.id, event.properties.info.parentID)
    }),
  )

  // The 1s tick re-evaluates live TPS staleness and prunes stale stream samples.
  const timer = setInterval(() => {
    prune()
    bump()
  }, 1_000)

  const internals: TrackerInternals = {
    sizes: () => ({
      parts: partDecisions.size,
      dedup: Object.values(tracker.dedup).reduce((sum, set) => sum + set.size, 0),
      stats: Object.keys(tracker.stats).length,
      averages: Object.keys(tracker.averages).length,
      timings: Object.keys(tracker.timings).length,
      mounted: mounted.size,
    }),
    partDecision: (partID) => partDecisions.get(partID),
    hasStats: (sessionID) => sessionID in tracker.stats,
    dedupSize: (sessionID) => tracker.dedup[sessionID]?.size ?? 0,
    retries: (sessionID) => tracker.stats[sessionID]?.retries ?? 0,
    mounted: () => [...mounted],
    activeModel: (sessionID) => tracker.models[sessionID]?.active,
  }
  lastInternals = internals

  return {
    modelRows,
    mountSession(sessionID) {
      mounted.add(sessionID)
    },
    unmountSession(sessionID) {
      mounted.delete(sessionID)
    },
    prune,
    internals,
    dispose() {
      for (const unsubscribe of listeners) unsubscribe()
      listeners.length = 0
      clearInterval(timer)
      mounted.clear()
      if (lastInternals === internals) lastInternals = undefined
    },
  }
}

/** Test-only fold controller. Kept in this non-entry module: the plugin entry (`tui.tsx`)
 * may only expose a `default` export, because the legacy loader treats every runtime export
 * as a plugin. */
export type PanelController = {
  toggle(key: string): void
  isExpanded(key: string): boolean
}

let lastPanelController: PanelController | undefined

export function setLastPanelController(controller: PanelController) {
  lastPanelController = controller
}

/** Clear the controller only when it is still the current one. */
export function clearLastPanelController(controller: PanelController) {
  if (lastPanelController === controller) lastPanelController = undefined
}

export function getLastPanelController(): PanelController | undefined {
  return lastPanelController
}
