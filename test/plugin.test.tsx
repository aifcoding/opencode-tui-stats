import { afterEach, expect, setSystemTime, test } from "bun:test"
import { RGBA, TextAttributes } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode/client"
import { batch, createSignal, Show } from "solid-js"
import type { TrackerInternals } from "../tracker"

const { default: plugin } = await import("../tui")
const { getLastPanelController } = await import("../tracker")
const { getLastInternals } = await import("../tracker")

function internals(): TrackerInternals {
  const value = getLastInternals()
  if (!value) throw new Error("tracker internals were not initialized")
  return value
}

function controller() {
  const value = getLastPanelController()
  if (!value) throw new Error("panel controller was not initialized")
  return value
}

type SidebarRender = (input: { sessionID: string }) => JSX.Element
type Listener = (event: unknown) => void
type Status = "idle" | "running"

type Harness = {
  emit(type: string, data: Record<string, unknown>, options?: { id?: string; created?: number }): void
  setStatus(sessionID: string, status: Status): void
  setSession(sessionID: string, parentID?: string): void
  setMessage(sessionID: string, message: SessionMessageInfo): void
  switchSession(sessionID: string): void
  setRoute(route: { type: "home" } | { type: "session"; sessionID: string }): void
  renderOnce(): Promise<void>
  frame(): string
  spans(): ReturnType<TestRendererSetup["captureSpans"]>
  subscriptionCount(): number
  sessionLookups(): number
  renderRequests(): number
  controller(): ReturnType<typeof controller>
  dispose(): Promise<void>
}

let activeHarness: Harness | undefined

afterEach(async () => {
  await activeHarness?.dispose()
  activeHarness = undefined
  setSystemTime()
})

function assistantMessage(input: {
  id: string
  providerID?: string
  modelID?: string
  created?: number
}): SessionMessageInfo {
  return {
    id: input.id,
    type: "assistant",
    time: { created: input.created ?? 1 },
    agent: "build",
    model: { id: input.modelID ?? "model", providerID: input.providerID ?? "provider" },
    content: [],
  } as unknown as SessionMessageInfo
}

function sessionInfo(id: string, parentID?: string) {
  return { id, parentID, projectID: "project", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
}

async function createHarness(): Promise<Harness> {
  const screen: TestRendererSetup = await createTestRenderer({ width: 120, height: 24 })
  const listeners = new Map<string, Set<Listener>>()
  const subscriptions = new Set<() => void>()
  const statuses = new Map<string, Status>()
  const sessions = new Map<string, ReturnType<typeof sessionInfo>>()
  const messages = new Map<string, SessionMessageInfo>()
  const disposeHandlers: Array<() => void | Promise<void>> = []
  const [routeState, setRouteState] = createSignal<{ type: "home" } | { type: "session"; sessionID: string }>({
    type: "session",
    sessionID: "one",
  })
  let sidebarRender: SidebarRender | undefined
  let disposed = false
  let sessionLookups = 0
  let renderRequests = 0
  let eventSeq = 0

  const context = {
    options: {},
    location: undefined,
    app: { version: "2.0.0", channel: "dev" },
    renderer: {
      requestRender: () => {
        renderRequests += 1
      },
    },
    client: {},
    data: {
      on(type: string, handler: Listener) {
        const group = listeners.get(type) ?? new Set<Listener>()
        group.add(handler)
        listeners.set(type, group)
        const unsubscribe = () => {
          group.delete(handler)
          if (group.size === 0) listeners.delete(type)
          subscriptions.delete(unsubscribe)
        }
        subscriptions.add(unsubscribe)
        return unsubscribe
      },
      listen: () => () => {},
      session: {
        status: (sessionID: string) => statuses.get(sessionID) ?? "idle",
        get: (sessionID: string) => {
          sessionLookups += 1
          return sessions.get(sessionID)
        },
        message: {
          get: (_sessionID: string, messageID: string) => messages.get(messageID),
          list: () => [],
          sync: async () => {},
          invalidate: () => {},
        },
      },
    },
    ui: {
      slot(claim: { append?: string; prepend?: string; render: SidebarRender }) {
        if ((claim.append ?? claim.prepend) === "sidebar.content") sidebarRender = claim.render
        return () => {
          sidebarRender = undefined
        }
      },
      toast: { show: () => {} },
      dialog: { clear: () => {} },
      router: {
        register: () => () => {},
        navigate: () => {},
        current: () => routeState(),
      },
    },
    keymap: { layer: () => {} },
    theme: {
      text: {
        base: RGBA.fromHex("#ffffff"),
        muted: RGBA.fromHex("#8a8a8a"),
        feedback: { success: { base: RGBA.fromHex("#00ff00"), muted: RGBA.fromHex("#00aa00") } },
      },
    },
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => {} },
    storage: { store: () => [{}, () => {}], memory: () => [{}, () => {}] },
    attention: { notify: async () => ({ ok: true, notification: false, sound: false }) },
  } as unknown as Context

  const cleanup = await plugin.setup(context)
  if (cleanup) disposeHandlers.push(cleanup)

  const routeSession = () => {
    const current = routeState()
    return current.type === "session" ? current.sessionID : undefined
  }

  await render(
    () => (
      <box flexDirection="column" width={120}>
        <Show when={routeState().type === "session" && sidebarRender}>
          {sidebarRender!({ get sessionID() { return routeSession() ?? "" } })}
        </Show>
      </box>
    ),
    screen.renderer,
  )

  return {
    emit(type, data, options) {
      eventSeq += 1
      const event = {
        id: options?.id ?? `event-${eventSeq}`,
        created: options?.created ?? Date.now(),
        type,
        location: { directory: "/" },
        data,
      }
      for (const handler of listeners.get(type) ?? []) handler(event)
    },
    setStatus(sessionID, status) {
      statuses.set(sessionID, status)
    },
    setSession(sessionID, parentID) {
      sessions.set(sessionID, sessionInfo(sessionID, parentID))
    },
    setMessage(_sessionID, message) {
      messages.set(message.id, message)
    },
    switchSession(sessionID) {
      setRouteState({ type: "session", sessionID })
    },
    setRoute(route) {
      setRouteState(route)
    },
    renderOnce() {
      return screen.renderOnce()
    },
    frame() {
      return screen.captureCharFrame()
    },
    spans() {
      return screen.captureSpans()
    },
    subscriptionCount() {
      return subscriptions.size
    },
    sessionLookups() {
      return sessionLookups
    },
    renderRequests() {
      return renderRequests
    },
    controller,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const handler of [...disposeHandlers]) await handler()
      disposeHandlers.length = 0
      screen.renderer.destroy()
    },
  }
}

function startStep(
  harness: Harness,
  sessionID: string,
  base: number,
  options: {
    id?: string
    providerID?: string
    modelID?: string
  } = {},
) {
  const messageID = options.id ?? `${sessionID}-message`
  const providerID = options.providerID ?? "provider"
  const modelID = options.modelID ?? "model"
  // Event timestamps and the live-rate staleness check both read the wall clock, so the fake
  // clock has to move with the step.
  setSystemTime(base)
  harness.setStatus(sessionID, "running")
  harness.setMessage(sessionID, assistantMessage({ id: messageID, providerID, modelID, created: base }))
  harness.emit(
    "session.step.started",
    {
      sessionID,
      assistantMessageID: messageID,
      agent: "build",
      model: { id: modelID, providerID },
      started: base,
    },
    { created: base },
  )
  return messageID
}

function endStep(
  harness: Harness,
  sessionID: string,
  base: number,
  options: {
    id?: string
    output?: number
    input?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: number
    finish?: string
    eventID?: string
  } = {},
) {
  const messageID = options.id ?? `${sessionID}-message`
  harness.emit(
    "session.step.ended",
    {
      sessionID,
      assistantMessageID: messageID,
      finish: options.finish ?? "stop",
      cost: options.cost ?? 0,
      tokens: {
        input: options.input ?? 0,
        output: options.output ?? 0,
        reasoning: options.reasoning ?? 0,
        cache: { read: options.cacheRead ?? 0, write: options.cacheWrite ?? 0 },
      },
    },
    { created: base, id: options.eventID },
  )
}

function completeMessage(
  harness: Harness,
  sessionID: string,
  base: number,
  options: {
    id?: string
    output?: number
    input?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: number
    providerID?: string
    modelID?: string
    /** Emit a streaming delta (default true). Set false to leave no TPS history behind. */
    stream?: boolean
  } = {},
) {
  const messageID = startStep(harness, sessionID, base, options)

  if (options.stream !== false) {
    harness.emit(
      "session.text.delta",
      { sessionID, assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
      { created: base + 500 },
    )
  }

  endStep(harness, sessionID, base + 2_500, { ...options, id: messageID })
}

function completeStep(harness: Harness, sessionID: string, base: number, output: number) {
  completeMessage(harness, sessionID, base, { output })
}

test("empty session renders the placeholder row", async () => {
  const harness = await createHarness()
  activeHarness = harness
  harness.setStatus("one", "running")
  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("Model-Performance · observed")
  expect(frame).toContain("Session CACHE —")
  expect(frame).not.toContain("retries")
})

test("model rows default to collapsed except the active model", async () => {
  const harness = await createHarness()
  activeHarness = harness

  startStep(harness, "one", 1, { id: "a", modelID: "a" })
  startStep(harness, "one", 2, { id: "b", modelID: "b" })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(internals().activeModel("one")).toBe("provider/b")
  expect(frame).toContain("▼ provider/b")
  expect(frame).toContain("▶ provider/a")
  expect(harness.controller().isExpanded("provider/b")).toBe(true)
  expect(harness.controller().isExpanded("provider/a")).toBe(false)
  // Only the active row contributes a detail line.
  expect((frame.match(/TTFT /g) ?? []).length).toBe(1)
})

test("sidebar panel renders nothing on a non-session route", async () => {
  const harness = await createHarness()
  activeHarness = harness
  completeStep(harness, "one", 1_700_000_000_000, 20)
  harness.setRoute({ type: "home" })
  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).not.toContain("TPS")
  expect(frame).not.toContain("Performance")
})

test("streaming deltas produce a live TPS reading", async () => {
  const harness = await createHarness()
  activeHarness = harness
  const base = 1_700_000_000_000
  const messageID = startStep(harness, "one", base)

  for (let index = 0; index < 2; index++) {
    harness.emit(
      "session.text.delta",
      { sessionID: "one", assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
      { created: base },
    )
  }

  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG — · TPS 10.0t/s")
  expect(harness.frame()).toContain("TPS 10.0")
})

test("a streaming row starts with one of the spinner frames", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  const messageID = startStep(harness, "one", base, { id: "message", modelID: "a" })
  harness.emit(
    "session.text.delta",
    { sessionID: "one", assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
    { created: base + 1_000 },
  )

  await harness.renderOnce()
  const row = harness
    .frame()
    .split("\n")
    .find((line) => line.includes("provider/a"))
  expect(row).toBeDefined()
  // Any of the four frames is acceptable; the assertion must not pin a specific tick.
  expect(row).toMatch(/[◐◓◑◒] ▼ provider\/a/)
})

test("an idle panel renders neither marker", async () => {
  const harness = await createHarness()
  activeHarness = harness

  completeMessage(harness, "one", 1_700_000_000_000, { output: 20 })
  harness.setStatus("one", "idle")
  harness.emit("session.status", { sessionID: "one", status: { type: "idle" } })
  await harness.renderOnce()

  const frame = harness.frame()
  expect(frame).toContain("provider/model")
  // The stream ended and the session is idle, so the row falls back to the blank alignment slot.
  expect(frame).not.toContain("●")
  expect(frame).not.toMatch(/[◐◓◑◒]/)
})

test("finished session keeps the last live TPS reading, dimmed", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  const sessionID = "one"
  const messageID = startStep(harness, sessionID, base)
  for (let index = 0; index < 2; index++) {
    harness.emit(
      "session.text.delta",
      { sessionID, assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
      { created: base },
    )
  }

  // The first render observes and remembers the live reading.
  await harness.renderOnce()
  const live = harness.spans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("10.0t/s"))
  expect(live).toBeDefined()
  expect(live!.attributes & TextAttributes.DIM).toBe(0)

  // Once idle, the same value must remain visible (frozen) and be marked non-live.
  setSystemTime(base + 60_000)
  harness.setStatus(sessionID, "idle")
  harness.emit("session.idle", { sessionID })
  await harness.renderOnce()

  const frame = harness.frame()
  expect(frame).toContain("TPS 10.0t/s")
  const frozen = harness.spans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("10.0t/s"))
  expect(frozen).toBeDefined()
  expect(frozen!.attributes & TextAttributes.DIM).not.toBe(0)
})

test("a model that never streamed renders no TPS field", async () => {
  const harness = await createHarness()
  activeHarness = harness

  startStep(harness, "one", 1_700_000_000_000, { id: "never-streamed" })

  await harness.renderOnce()
  expect(harness.frame()).not.toContain("TPS")
})

test("finished message accumulates AVG and TTFT", async () => {
  const harness = await createHarness()
  activeHarness = harness

  completeStep(harness, "one", 1_700_000_000_000, 20)

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("AVG 10.0")
  expect(frame).toContain("TTFT 0.5s")
})

test("cache hit rate and cost accumulate from a completed step", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  const messageID = "one-message"
  const base = 1_700_000_000_000
  startStep(harness, sessionID, base, { id: messageID })

  harness.emit(
    "session.text.delta",
    { sessionID, assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
    { created: base + 500 },
  )

  endStep(harness, sessionID, base + 2_500, {
    id: messageID,
    input: 24234,
    output: 2,
    reasoning: 0,
    cacheRead: 10752,
    cacheWrite: 0,
    cost: 0.007337112,
  })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("CACHE  30.7%")
  expect(frame).toContain("$0.0073")
  expect(frame).not.toContain("retries")

  // Both detail lines are indented under the model row and carry explicit units.
  const avgLine = frame.split("\n").find((line) => line.includes("AVG "))!
  const ttftLine = frame.split("\n").find((line) => line.includes("TTFT "))!
  expect(avgLine.startsWith("   AVG ")).toBe(true)
  expect(ttftLine.startsWith("   TTFT ")).toBe(true)
  expect(avgLine).toContain("t/s")
  expect(ttftLine).toContain("CACHE  ")
})

test("expanded rows align metric columns and omit idle TPS", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  // The first model repeats its provider name, so the muted prefix is dropped.
  completeMessage(harness, "one", base, {
    providerID: "deepseek",
    modelID: "deepseek-flash",
    input: 1_000,
    cacheRead: 0,
    cost: 0.007337112,
    output: 20,
    stream: false,
  })
  completeMessage(harness, "one", base + 100_000, {
    id: "one-message-2",
    providerID: "deepseek",
    modelID: "other",
    input: 0,
    cacheRead: 1_000,
    cost: 0.65,
    output: 20,
    stream: false,
  })

  // The active row ("other") starts expanded; open the older row as well.
  harness.controller().toggle("deepseek/deepseek-flash")
  await harness.renderOnce()
  const frame = harness.frame()

  expect(frame).toContain("▼ deepseek-flash")
  expect(frame).not.toContain("deepseek/deepseek-flash")
  expect(frame).toContain("deepseek/other")
  // The spinner marks streaming rows, not the active one: nothing streamed here.
  expect(frame).not.toMatch(/[◐◓◑◒]/)
  // Neither model was ever observed streaming, so no TPS history exists.
  expect(frame).not.toContain("TPS")

  const avgLines = frame.split("\n").filter((line) => line.includes("AVG "))
  const detailLines = frame.split("\n").filter((line) => line.includes("TTFT "))
  expect(avgLines).toHaveLength(2)
  expect(detailLines).toHaveLength(2)
  for (const line of avgLines) expect(line.startsWith("   AVG ")).toBe(true)
  for (const line of detailLines) expect(line.startsWith("   TTFT ")).toBe(true)

  // The same field starts on the same column even when the percentage width changes.
  expect(new Set(avgLines.map((line) => line.indexOf("AVG "))).size).toBe(1)
  expect(new Set(detailLines.map((line) => line.indexOf("CACHE "))).size).toBe(1)
  // The cost moved to its own line; it still aligns across rows.
  const costLines = frame.split("\n").filter((line) => line.includes("$"))
  expect(costLines).toHaveLength(2)
  expect(new Set(costLines.map((line) => line.indexOf("$"))).size).toBe(1)
  expect(detailLines.some((line) => line.includes("CACHE   0.0%"))).toBe(true)
  expect(detailLines.some((line) => line.includes("CACHE 100.0%"))).toBe(true)
  expect(frame).toContain("$0.0073")
  expect(frame).toContain("$0.6500")
})

test("retry count follows the reported attempt number", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  await harness.renderOnce()
  expect(harness.frame()).not.toContain("retries")

  harness.emit("session.status", {
    sessionID,
    status: { type: "retry", attempt: 1, message: "rate limited", next: 0 },
  })
  harness.emit("session.status", {
    sessionID,
    status: { type: "retry", attempt: 2, message: "rate limited", next: 0 },
  })
  await harness.renderOnce()
  expect(harness.frame()).toContain("Session CACHE — · retries 2")
  expect(internals().retries(sessionID)).toBe(2)

  // A non-retry status resets the baseline, so the next burst counts from 0 again.
  harness.emit("session.status", { sessionID, status: { type: "busy" } })
  await harness.renderOnce()
  expect(harness.frame()).toContain("Session CACHE — · retries 2")

  harness.emit("session.status", {
    sessionID,
    status: { type: "retry", attempt: 1, message: "rate limited", next: 0 },
  })
  harness.emit("session.status", {
    sessionID,
    status: { type: "retry", attempt: 2, message: "rate limited", next: 0 },
  })
  await harness.renderOnce()
  expect(harness.frame()).toContain("Session CACHE — · retries 4")
  expect(internals().retries(sessionID)).toBe(4)
})

test("switching sessions keeps each session's accumulated totals", async () => {
  const harness = await createHarness()
  activeHarness = harness

  harness.switchSession("one")
  completeStep(harness, "one", 1_700_000_000_000, 20)
  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG 10.0")

  harness.switchSession("two")
  completeStep(harness, "two", 1_700_000_100_000, 60)
  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG 30.0")

  harness.switchSession("one")
  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG 10.0")
})

test("disposing unsubscribes every event listener", async () => {
  const harness = await createHarness()
  activeHarness = harness
  expect(harness.subscriptionCount()).toBeGreaterThan(0)

  await harness.dispose()
  expect(harness.subscriptionCount()).toBe(0)
})

test("replaying a completed step does not accumulate twice", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  const messageID = "one-message"
  const base = 1_700_000_000_000
  startStep(harness, sessionID, base, { id: messageID })

  harness.emit(
    "session.text.delta",
    { sessionID, assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
    { created: base + 500 },
  )

  const ended = {
    sessionID,
    assistantMessageID: messageID,
    finish: "stop",
    cost: 0.007337112,
    tokens: { input: 24234, output: 2, reasoning: 0, cache: { read: 10752, write: 0 } },
  }
  const eventID = "step-ended-1"
  harness.emit("session.step.ended", ended, { id: eventID, created: base + 2_500 })
  // A reconnect replays the same durable event.
  harness.emit("session.step.ended", ended, { id: eventID, created: base + 2_500 })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("CACHE  30.7%")
  expect(frame).toContain("$0.0073")
})

test("text and reasoning deltas both count toward the live rate", async () => {
  const harness = await createHarness()
  activeHarness = harness
  const base = 1_700_000_000_000
  const messageID = startStep(harness, "one", base)

  harness.emit(
    "session.text.delta",
    { sessionID: "one", assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
    { created: base },
  )
  harness.emit(
    "session.reasoning.delta",
    { sessionID: "one", assistantMessageID: messageID, ordinal: 1, delta: "x".repeat(25) },
    { created: base },
  )

  await harness.renderOnce()
  // Two 5-token samples inside one second read as 10 tok/s.
  expect(harness.frame()).toContain("TPS 10.0")
})

test("internal caches stay bounded under sustained traffic", async () => {
  const harness = await createHarness()
  activeHarness = harness

  for (let index = 0; index < 1_100; index++) {
    const messageID = `m-${index}`
    startStep(harness, "one", 1_700_000_000_000 + index, { id: messageID })
    harness.emit(
      "session.text.delta",
      { sessionID: "one", assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
      { created: 1_700_000_000_100 + index },
    )
    endStep(harness, "one", 1_700_000_000_200 + index, { id: messageID, eventID: `step-${index}` })
  }

  for (let index = 0; index < 70; index++) {
    completeStep(harness, `s-${index}`, 1_700_000_000_000 + index * 10_000, 20)
  }

  const sizes = internals().sizes()
  expect(internals().dedupSize("one")).toBeLessThanOrEqual(64)
  expect(sizes.stats).toBeLessThanOrEqual(64)
  expect(sizes.averages).toBeLessThanOrEqual(64)

  // LRU eviction drops the least recently used background sessions, keeps the newest
  // and the session currently being viewed ("one" is mounted, so it is protected).
  expect(internals().hasStats("s-69")).toBe(true)
  expect(internals().hasStats("s-0")).toBe(false)
  expect(internals().hasStats("one")).toBe(true)
})

test("the mounted session survives eviction of background sessions", async () => {
  const harness = await createHarness()
  activeHarness = harness

  completeStep(harness, "one", 1_700_000_000_000, 20)
  await harness.renderOnce()
  expect(internals().sizes().mounted).toBe(1)

  // Batch the background traffic so reactive flushes cannot touch the mounted session in between.
  batch(() => {
    for (let index = 0; index < 80; index++) {
      completeStep(harness, `bg-${index}`, 1_700_000_000_000 + index * 10_000, 20)
    }
  })

  expect(internals().sizes().stats).toBeLessThanOrEqual(64)
  expect(internals().sizes().averages).toBeLessThanOrEqual(64)
  expect(internals().hasStats("one")).toBe(true)

  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG 10.0")
})

test("dedup window covers the most recent 64 completed steps per session", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  for (let index = 0; index < 65; index++) {
    startStep(harness, sessionID, 1, { id: `d-${index}` })
    endStep(harness, sessionID, 2, { id: `d-${index}`, cost: 0.01, eventID: `d-${index}` })
  }

  // 65 distinct completed steps accumulate once each; only the newest 64 event ids are retained.
  expect(internals().dedupSize(sessionID)).toBe(64)
  expect(internals().hasStats(sessionID)).toBe(true)
  await harness.renderOnce()
  expect(harness.frame()).toContain("$0.6500")

  // Inside the window: replaying a retained event is deduplicated.
  harness.emit(
    "session.step.ended",
    {
      sessionID,
      assistantMessageID: "d-64",
      finish: "stop",
      cost: 0.01,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    { id: "d-64", created: 2 },
  )
  await harness.renderOnce()
  expect(harness.frame()).toContain("$0.6500")

  // Outside the window: the oldest event id (d-0) was evicted, so replaying it accumulates again.
  harness.emit(
    "session.step.ended",
    {
      sessionID,
      assistantMessageID: "d-0",
      finish: "stop",
      cost: 0.01,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    { id: "d-0", created: 2 },
  )
  await harness.renderOnce()
  expect(harness.frame()).toContain("$0.6600")
})

test("idle clears unfinished timings for the session", async () => {
  const harness = await createHarness()
  activeHarness = harness

  startStep(harness, "one", 1, { id: "m1" })
  startStep(harness, "two", 1, { id: "m2" })
  expect(internals().sizes().timings).toBe(2)

  harness.emit("session.idle", { sessionID: "one" })
  expect(internals().sizes().timings).toBe(1)

  harness.emit("session.status", { sessionID: "two", status: { type: "idle" } })
  expect(internals().sizes().timings).toBe(0)
})

test("tool-only turn still accumulates AVG and TTFT", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  const messageID = "tool-message"
  const base = 1_700_000_000_000
  startStep(harness, sessionID, base, { id: messageID })

  harness.emit(
    "session.tool.input.started",
    { sessionID, assistantMessageID: messageID, id: "call", name: "bash" },
    { created: base + 500 },
  )

  harness.emit(
    "session.tool.called",
    { sessionID, assistantMessageID: messageID, id: "call", input: {}, executed: true },
    { created: base + 1_500 },
  )

  endStep(harness, sessionID, base + 2_000, { id: messageID, output: 20, reasoning: 0, finish: "tool-calls" })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("AVG 20.0")
  expect(frame).toContain("TTFT 0.5s")
})

test("model panel keeps rows in first-seen order regardless of the active model", async () => {
  const harness = await createHarness()
  activeHarness = harness

  startStep(harness, "one", 1, { id: "a", modelID: "a" })
  startStep(harness, "one", 2, { id: "b", modelID: "b" })

  await harness.renderOnce()
  const frame = harness.frame()
  // `b` is the most recent model, but ordering follows first appearance: `a` then `b`.
  expect(internals().activeModel("one")).toBe("provider/b")
  expect(frame).toContain("▼ provider/b")
  expect(frame).not.toContain("active")
  expect(frame.indexOf("provider/a")).toBeLessThan(frame.indexOf("provider/b"))
})

test("changing the active model does not reorder rows", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  for (const [id, modelID, created] of [
    ["a", "a", 1],
    ["b", "b", 2],
  ] as const) {
    startStep(harness, "one", created, { id, modelID })
  }
  await harness.renderOnce()
  expect(internals().activeModel("one")).toBe("provider/b")

  // Use the older model again: it becomes active, but its row must stay in the first slot.
  setSystemTime(base)
  startStep(harness, "one", 4, { id: "a-2", modelID: "a" })
  await harness.renderOnce()

  // The default expanded row moved to the newly active model; the row order did not.
  const panel = harness.frame()
  expect(internals().activeModel("one")).toBe("provider/a")
  expect(panel).toContain("▼ provider/a")
  expect(panel).toContain("▶ provider/b")
  expect(panel.indexOf("provider/a")).toBeLessThan(panel.indexOf("provider/b"))
})

test("a subagent and its parent swapping activity recency does not reorder rows", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  harness.setSession("child", "one")
  harness.emit("session.created", { sessionID: "child", parentID: "one", projectID: "project", location: { directory: "/" }, slug: "child" })

  // The parent sees `a` first, then the child sees `b`: first-seen order is a, b.
  setSystemTime(base)
  startStep(harness, "one", 1, { id: "parent-a", modelID: "a" })
  setSystemTime(base + 1_000)
  startStep(harness, "child", 2, { id: "child-b", modelID: "b" })

  await harness.renderOnce()
  const before = harness.frame()
  expect(before.indexOf("provider/a")).toBeLessThan(before.indexOf("provider/b"))

  // The parent becomes the most recently active session again, so the subtree fold order flips
  // (child first, then parent). The rendered rows must keep their first-seen slots.
  setSystemTime(base + 2_000)
  startStep(harness, "one", 3, { id: "parent-a2", modelID: "a" })

  await harness.renderOnce()
  const after = harness.frame()
  expect(internals().activeModel("one")).toBe("provider/a")
  expect(after.indexOf("provider/a")).toBeLessThan(after.indexOf("provider/b"))
})

test("the row marker moves through busy, streaming, and idle", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  const sessionID = "one"
  const messageID = startStep(harness, sessionID, base, { id: "m", modelID: "a" })

  // Busy, no tokens yet: a solid dot at the start of the row.
  await harness.renderOnce()
  const busy = harness
    .frame()
    .split("\n")
    .find((line) => line.includes("provider/a"))
  expect(busy).toMatch(/^● ▼ provider\/a/)
  expect(busy).not.toMatch(/[◐◓◑◒]/)

  // First tokens: the dot is replaced by one of the spinner frames.
  setSystemTime(base + 1_000)
  harness.emit(
    "session.text.delta",
    { sessionID, assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(25) },
    { created: base + 1_000 },
  )
  await harness.renderOnce()
  const streaming = harness
    .frame()
    .split("\n")
    .find((line) => line.includes("provider/a"))
  expect(streaming).toMatch(/^[◐◓◑◒] ▼ provider\/a/)
  expect(streaming).not.toContain("●")

  // Idle: neither marker is left, only the blank alignment slot.
  setSystemTime(base + 2_000)
  harness.setStatus(sessionID, "idle")
  harness.emit("session.idle", { sessionID })
  await harness.renderOnce()
  const idle = harness
    .frame()
    .split("\n")
    .find((line) => line.includes("provider/a"))
  expect(idle).toContain("▼ provider/a")
  expect(idle).not.toContain("●")
  expect(idle).not.toMatch(/[◐◓◑◒]/)
})

test("a busy subagent marks only its own model row", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  harness.setSession("child", "one")
  harness.emit("session.created", { sessionID: "child", parentID: "one", projectID: "project", location: { directory: "/" }, slug: "child" })

  completeMessage(harness, "one", base, { modelID: "a", output: 20 })
  harness.setStatus("one", "idle")

  // The child is busy on `b` without any tokens; the parent is idle.
  startStep(harness, "child", base + 200_000, { id: "child-m", modelID: "b" })

  await harness.renderOnce()
  const lines = harness.frame().split("\n")
  const rowA = lines.find((line) => line.includes("provider/a"))
  const rowB = lines.find((line) => line.includes("↳ provider/b"))
  expect(rowB).toMatch(/^● ▶ ↳ provider\/b/)
  expect(rowA).not.toContain("●")
  expect(rowA).not.toMatch(/[◐◓◑◒]/)
})

test("model panel caps at four models and reports the overflow", async () => {
  const harness = await createHarness()
  activeHarness = harness

  for (const modelID of ["a", "b", "c", "d", "e", "f"]) {
    startStep(harness, "one", 1, { id: modelID, modelID })
  }

  await harness.renderOnce()
  const frame = harness.frame()
  // Fixed order keeps the four oldest models; the newest two are only counted in the overflow.
  expect(frame).toContain("▶ provider/a")
  expect(frame).toContain("▶ provider/d")
  expect(frame).toContain("+2 more models")
  expect(frame).not.toContain("provider/e")
  expect(frame).not.toContain("provider/f")
})

test("overflow row expands every model and folds back", async () => {
  const harness = await createHarness()
  activeHarness = harness

  for (const modelID of ["a", "b", "c", "d", "e", "f"]) {
    startStep(harness, "one", 1, { id: modelID, modelID })
  }

  await harness.renderOnce()
  expect(harness.frame()).toContain("+2 more models")
  expect(harness.controller().overflowExpanded()).toBe(false)

  const before = harness.renderRequests()
  harness.controller().toggleOverflow()
  expect(harness.controller().overflowExpanded()).toBe(true)
  expect(harness.renderRequests()).toBeGreaterThan(before)

  await harness.renderOnce()
  const expanded = harness.frame()
  for (const modelID of ["a", "b", "c", "d", "e", "f"]) expect(expanded).toContain(`provider/${modelID}`)
  expect(expanded).toContain("− show fewer models")
  expect(expanded).not.toContain("+2 more models")

  harness.controller().toggleOverflow()
  expect(harness.controller().overflowExpanded()).toBe(false)
  await harness.renderOnce()
  const collapsed = harness.frame()
  expect(collapsed).toContain("+2 more models")
  expect(collapsed).not.toContain("− show fewer models")
  expect(collapsed).not.toContain("provider/e")
  expect(collapsed).not.toContain("provider/f")
})

test("collapsing the module leaves only the title", async () => {
  const harness = await createHarness()
  activeHarness = harness

  completeStep(harness, "one", 1_700_000_000_000, 20)
  await harness.renderOnce()
  const expanded = harness.frame()
  expect(expanded).toContain("▼ Model-Performance · observed")
  expect(expanded).toContain("Session CACHE")
  expect(expanded).toContain("provider/model")

  const before = harness.renderRequests()
  harness.controller().toggleModule()
  expect(harness.controller().moduleCollapsed()).toBe(true)
  expect(harness.renderRequests()).toBeGreaterThan(before)

  await harness.renderOnce()
  const collapsed = harness.frame()
  expect(collapsed).toContain("▶ Model-Performance · observed")
  expect(collapsed).not.toContain("Session CACHE")
  expect(collapsed).not.toContain("provider/model")

  harness.controller().toggleModule()
  expect(harness.controller().moduleCollapsed()).toBe(false)
  await harness.renderOnce()
  const restored = harness.frame()
  expect(restored).toContain("▼ Model-Performance · observed")
  expect(restored).toContain("Session CACHE")
  expect(restored).toContain("provider/model")
})

test("model panel reports session retries without per-model attribution", async () => {
  const harness = await createHarness()
  activeHarness = harness

  startStep(harness, "one", 1, { id: "a", modelID: "a" })
  harness.emit("session.status", {
    sessionID: "one",
    status: { type: "retry", attempt: 1, message: "rate limited", next: 0 },
  })
  harness.emit("session.status", {
    sessionID: "one",
    status: { type: "retry", attempt: 2, message: "rate limited", next: 0 },
  })

  await harness.renderOnce()
  expect(harness.frame()).toContain("Session CACHE — · retries 2")
})

test("toggling a row updates the fold state and requests a redraw", async () => {
  const harness = await createHarness()
  activeHarness = harness

  completeStep(harness, "one", 1_700_000_000_000, 20)
  await harness.renderOnce()
  const panel = harness.controller()
  expect(panel.isExpanded("provider/model")).toBe(true)

  const before = harness.renderRequests()
  panel.toggle("provider/model")
  expect(panel.isExpanded("provider/model")).toBe(false)
  expect(harness.renderRequests()).toBeGreaterThan(before)

  await harness.renderOnce()
  const collapsed = harness.frame()
  expect(collapsed).toContain("▶ provider/model")
  expect(collapsed).not.toContain("TTFT 0.5s")

  panel.toggle("provider/model")
  expect(panel.isExpanded("provider/model")).toBe(true)
  await harness.renderOnce()
  const expanded = harness.frame()
  expect(expanded).toContain("▼ provider/model")
  expect(expanded).toContain("TTFT 0.5s")
})

test("toggling an inactive row expands only that row", async () => {
  const harness = await createHarness()
  activeHarness = harness

  startStep(harness, "one", 1, { id: "a", modelID: "a" })
  startStep(harness, "one", 2, { id: "b", modelID: "b" })
  await harness.renderOnce()

  harness.controller().toggle("provider/a")
  expect(harness.controller().isExpanded("provider/a")).toBe(true)
  expect(harness.controller().isExpanded("provider/b")).toBe(true)

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("▼ provider/a")
  expect((frame.match(/TTFT /g) ?? []).length).toBe(2)
})

test("subagent models are merged into the parent session panel", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  harness.setSession("one")
  harness.setSession("child", "one")
  harness.emit("session.created", { sessionID: "one", projectID: "project", location: { directory: "/" }, slug: "one" })
  harness.emit("session.created", { sessionID: "child", parentID: "one", projectID: "project", location: { directory: "/" }, slug: "child" })

  completeMessage(harness, "one", base, { modelID: "a" })
  completeMessage(harness, "child", base + 100_000, { modelID: "b" })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("provider/a")
  expect(frame).toContain("↳ provider/b")
  // The expanded (active) row is the current session's most recent model; the subagent row stays collapsed.
  expect(frame).toContain("▼ provider/a")
})

test("parent and subagent sharing one model collapse into a single summed row", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  harness.setSession("child", "one")
  harness.emit("session.created", { sessionID: "child", parentID: "one", projectID: "project", location: { directory: "/" }, slug: "child" })

  completeMessage(harness, "one", base, { output: 20 })
  completeMessage(harness, "child", base + 100_000, { output: 30 })

  await harness.renderOnce()
  const frame = harness.frame()
  // One row only: the model name appears once (detail lines never repeat it).
  expect((frame.match(/provider\/model/g) ?? []).length).toBe(1)
  expect(frame).toContain("↳ provider/model")
  // steps=2, tokens=50 over 2 x 2000ms → 12.5 tok/s; TTFT stays 0.5s per step.
  expect(frame).toContain("AVG 12.5")
  expect(frame).toContain("TTFT 0.5s")
})

test("parallel streams of different models light up both rows with their own TPS", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  for (const [messageID, modelID] of [
    ["m-a", "a"],
    ["m-b", "b"],
  ] as const) {
    startStep(harness, "one", base, { id: messageID, modelID })
  }

  // Both messages stream at the same wall clock: `a` sends 5 tokens per tick, `b` sends 10.
  for (const [messageID, size] of [
    ["m-a", 25],
    ["m-b", 50],
  ] as const) {
    for (const at of [base, base + 1_000]) {
      harness.emit(
        "session.text.delta",
        { sessionID: "one", assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(size) },
        { created: at },
      )
    }
  }

  // The newer model (b) starts expanded; open `a` too so both TPS readings are rendered.
  harness.controller().toggle("provider/a")
  await harness.renderOnce()
  const frame = harness.frame()
  // Two streams, two spinners: the marker no longer means "the active model". Any frame is valid.
  expect(frame).toMatch(/[◐◓◑◒] ▼ provider\/a/)
  expect(frame).toMatch(/[◐◓◑◒] ▼ provider\/b/)
  expect(frame).toContain("TPS 10.0t/s")
  expect(frame).toContain("TPS 20.0t/s")
})

test("parent and subagent streaming one model report the summed TPS", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  harness.setSession("child", "one")
  harness.emit("session.created", { sessionID: "child", parentID: "one", projectID: "project", location: { directory: "/" }, slug: "child" })

  const stream = (sessionID: string, messageID: string, size: number) => {
    startStep(harness, sessionID, base, { id: messageID })
    for (const at of [base, base + 1_000]) {
      harness.emit(
        "session.text.delta",
        { sessionID, assistantMessageID: messageID, ordinal: 0, delta: "x".repeat(size) },
        { created: at },
      )
    }
  }

  // Parent streams 10 tok/s while the subagent streams 20 tok/s in the same window.
  stream("one", "m-parent", 25)
  stream("child", "m-child", 50)

  setSystemTime(base + 1_000)
  await harness.renderOnce()
  const frame = harness.frame()
  // The subagent contributes this model too, so the row keeps its `↳` merge marker and lights up.
  expect(frame).toMatch(/[◐◓◑◒] ▼ ↳ provider\/model/)
  // Both sessions feed the same row, so the row reports 10 + 20 rather than the newer one.
  expect(frame).toContain("TPS 30.0t/s")
  expect(frame).not.toContain("TPS 10.0t/s")
  expect(frame).not.toContain("TPS 20.0t/s")
})

test("grandchild sessions are folded into the root panel", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  for (const [id, parentID] of [
    ["one", undefined],
    ["child", "one"],
    ["grandchild", "child"],
  ] as const) {
    harness.setSession(id, parentID)
    harness.emit("session.created", {
      sessionID: id,
      parentID,
      projectID: "project",
      location: { directory: "/" },
      slug: id,
    })
  }

  completeMessage(harness, "one", base, { modelID: "a" })
  completeMessage(harness, "grandchild", base + 100_000, { modelID: "c" })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("provider/a")
  expect(frame).toContain("↳ provider/c")
})

test("session CACHE aggregates the whole subtree", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  harness.setSession("child", "one")
  harness.emit("session.created", { sessionID: "child", parentID: "one", projectID: "project", location: { directory: "/" }, slug: "child" })

  // Parent: input 1000 + cacheRead 1000 → 2000 promptable, 1000 cached.
  completeMessage(harness, "one", base, { input: 1_000, cacheRead: 1_000 })
  // Child: input 0 + cacheRead 3000 → 3000 promptable, 3000 cached.
  completeMessage(harness, "child", base + 100_000, { input: 0, cacheRead: 3_000 })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("CACHE 80.0%")
  expect(frame).toContain("Session CACHE 80.0%")
})

test("a child session observed only through state is linked lazily", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  // No session.created/updated event: the relation only exists in `data.session.get`.
  harness.setSession("child", "one")

  completeMessage(harness, "child", base, { modelID: "b" })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("↳ provider/b")
  expect(harness.sessionLookups()).toBeGreaterThan(0)
})
