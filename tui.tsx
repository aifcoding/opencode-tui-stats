/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, type Accessor } from "solid-js"

type StreamSample = {
  at: number
  tokens: number
}

type MessageTiming = {
  sessionID: string
  requestStartAt: number
  firstResponseAt?: number
  lastToolCallAt?: number
}

type SessionAverage = {
  totalTokens: number
  totalDurationMs: number
  totalTtftMs: number
  stepCount: number
}

type Tracker = {
  samples: Record<string, StreamSample[]>
  timings: Record<string, MessageTiming>
  averages: Record<string, SessionAverage>
}

const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000

function estimateTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function formatTtft(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined
  return `${value.toFixed(1)}s`
}

function activeDuration(samples: StreamSample[], tailAt?: number) {
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

function averageRate(average: SessionAverage | undefined) {
  if (!average || average.totalTokens <= 0 || average.totalDurationMs <= 0) return undefined
  return formatRate(average.totalTokens / (average.totalDurationMs / 1_000))
}

function averageTtft(average: SessionAverage | undefined) {
  if (!average || average.stepCount <= 0) return undefined
  return formatTtft(average.totalTtftMs / average.stepCount / 1_000)
}

function liveRate(api: TuiPluginApi, tracker: Tracker, sessionID: string) {
  const status = api.state.session.status(sessionID)
  if (!status || status.type === "idle") return undefined

  const now = Date.now()
  const samples = (tracker.samples[sessionID] ?? []).filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
  const last = samples[samples.length - 1]
  if (!last || now - last.at > LIVE_STALE_MS) return undefined

  const tokens = samples.reduce((sum, sample) => sum + sample.tokens, 0)
  return formatRate(tokens / (activeDuration(samples, now) / 1_000))
}

function statusText(api: TuiPluginApi, tracker: Tracker, sessionID: string) {
  const average = tracker.averages[sessionID]
  const live = liveRate(api, tracker, sessionID) ?? "-"
  const avg = averageRate(average) ?? "-"
  const ttft = averageTtft(average) ?? "-"
  return `TPS ${live} | AVG ${avg} | TTFT ${ttft}`
}

function SessionPromptRight(props: {
  api: TuiPluginApi
  sessionID: string
  tracker: Tracker
  revision: Accessor<number>
}) {
  const content = createMemo(() => {
    props.revision()
    return statusText(props.api, props.tracker, props.sessionID)
  })

  return <text fg={props.api.theme.current.textMuted}>{content()}</text>
}

const tui: TuiPlugin = async (api) => {
  const tracker: Tracker = {
    samples: {},
    timings: {},
    averages: {},
  }
  const [revision, setRevision] = createSignal(0)
  const bump = () => setRevision((value) => value + 1)

  const pruneSamples = (now = Date.now()) => {
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

  const clearLive = (sessionID: string) => {
    if (!tracker.samples[sessionID]?.length) return
    delete tracker.samples[sessionID]
    bump()
  }

  const appendSample = (sessionID: string, messageID: string, sample: StreamSample) => {
    tracker.samples[sessionID] = [
      ...(tracker.samples[sessionID] ?? []).filter((item) => sample.at - item.at <= STREAM_WINDOW_MS),
      sample,
    ]
    const timing = tracker.timings[messageID]
    if (timing && timing.firstResponseAt === undefined) timing.firstResponseAt = sample.at
    bump()
  }

  const onDelta = api.event.on("message.part.delta", (event) => {
    if (event.properties.field !== "text") return
    const part = api.state.part(event.properties.messageID).find((item) => item.id === event.properties.partID)
    if (!part || (part.type !== "text" && part.type !== "reasoning")) return
    appendSample(event.properties.sessionID, event.properties.messageID, {
      at: Date.now(),
      tokens: estimateTokens(event.properties.delta),
    })
  })

  const onMessage = api.event.on("message.updated", (event) => {
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
    pruneSamples(info.time.completed)
    bump()
  })

  const onPart = api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (part.type !== "tool") return

    if (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error") {
      clearLive(part.sessionID)
    }

    const timing = tracker.timings[part.messageID]
    if (!timing) return

    if (part.state.status === "pending") {
      if (timing.firstResponseAt === undefined) timing.firstResponseAt = event.properties.time
      bump()
      return
    }
    if (part.state.status === "running") {
      timing.lastToolCallAt = part.state.time.start
      bump()
    }
  })

  const timer = setInterval(() => {
    pruneSamples()
    bump()
  }, 1_000)

  api.lifecycle.onDispose(() => {
    onDelta()
    onMessage()
    onPart()
    clearInterval(timer)
  })

  api.slots.register({
    slots: {
      session_prompt_right(_context, props) {
        return <SessionPromptRight api={api} sessionID={props.session_id} tracker={tracker} revision={revision} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "opencode-tui-stats",
  tui,
}

export default plugin
