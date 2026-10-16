import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export type StreamSample = {
  at: number
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

export type Tracker = {
  samples: Record<string, StreamSample[]>
  timings: Record<string, MessageTiming>
  averages: Record<string, SessionAverage>
  stats: Record<string, SessionStats>
  dedup: Record<string, Set<string>>
}

const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000
const PART_CACHE_LIMIT = 1_024
/** Per-session dedup window: only the most recent completed messages are deduplicated;
 * a repeated completed event beyond this window accumulates again. */
const DEDUP_WINDOW_LIMIT = 64
const SESSION_LIMIT = 64

function emptyStats(): SessionStats {
  return { cacheRead: 0, cachePrompt: 0, cost: 0, steps: 0, retries: 0, lastAttempt: 0 }
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

export function cacheRate(stats: SessionStats | undefined) {
  if (!stats || stats.cachePrompt <= 0) return "-"
  return `${Math.round((stats.cacheRead / stats.cachePrompt) * 100)}%`
}

export function costText(stats: SessionStats | undefined) {
  if (!stats || stats.steps <= 0) return "-"
  return `$${stats.cost >= 1 ? stats.cost.toFixed(2) : stats.cost.toFixed(4)}`
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
}

export type TrackerHandle = {
  statusText(sessionID: string): string
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
  const tracker: Tracker = { samples: {}, timings: {}, averages: {}, stats: {}, dedup: {} }
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

  const liveRate = (sessionID: string) => {
    const status = api.state.session.status(sessionID)
    if (!status || status.type === "idle") return undefined

    const now = Date.now()
    const samples = (tracker.samples[sessionID] ?? []).filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
    const last = samples[samples.length - 1]
    if (!last || now - last.at > LIVE_STALE_MS) return undefined

    const tokens = samples.reduce((sum, sample) => sum + sample.tokens, 0)
    return formatRate(tokens / (activeDuration(samples, now) / 1_000))
  }

  const statusText = (sessionID: string) => {
    const average = tracker.averages[sessionID]
    const stats = tracker.stats[sessionID]
    const live = liveRate(sessionID) ?? "-"
    const avg = averageRate(average) ?? "-"
    const ttft = averageTtft(average) ?? "-"
    return `TPS ${live} | AVG ${avg} | TTFT ${ttft} | CACHE ${cacheRate(stats)} | COST ${costText(stats)} | RETRY ${stats?.retries ?? 0}`
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
        tokens: estimateTokens(event.properties.delta),
      })
    }),
  )

  listeners.push(
    api.event.on("message.updated", (event) => {
      const info = event.properties.info
      if (info.role !== "assistant") return
      const sessionID = event.properties.sessionID

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
  }
  lastInternals = internals

  return {
    statusText,
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
