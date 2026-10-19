import { afterEach, expect, setSystemTime, test } from "bun:test"
import { RGBA, TextAttributes } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"
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

type SidebarRender = (context: unknown, props: { session_id: string }) => JSX.Element
type Listener = (event: unknown) => void

type Harness = {
  emit(type: string, properties: Record<string, unknown>): void
  setStatus(sessionID: string, status: SessionStatus | undefined): void
  setSession(sessionID: string, parentID?: string): void
  setParts(messageID: string, value: Part[]): void
  switchSession(sessionID: string): void
  setRoute(route: TuiRouteCurrent): void
  renderOnce(): Promise<void>
  frame(): string
  spans(): ReturnType<TestRendererSetup["captureSpans"]>
  subscriptionCount(): number
  partLookups(): number
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

function textPart(id: string, messageID: string, sessionID: string): Part {
  return { id, sessionID, messageID, type: "text", text: "" }
}

function reasoningPart(id: string, messageID: string, sessionID: string): Part {
  return { id, sessionID, messageID, type: "reasoning", text: "", time: { start: 0 } }
}

function stepStartPart(id: string, messageID: string, sessionID: string): Part {
  return { id, sessionID, messageID, type: "step-start" }
}

function toolPart(id: string, messageID: string, sessionID: string, state: ToolPart["state"]): Part {
  return { id, sessionID, messageID, type: "tool", callID: "call", tool: "bash", state }
}

function assistantMessage(input: {
  id: string
  sessionID: string
  created: number
  completed?: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
  finish?: string
  providerID?: string
  modelID?: string
}): Message {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: input.completed === undefined ? { created: input.created } : { created: input.created, completed: input.completed },
    parentID: "user-message",
    modelID: input.modelID ?? "model",
    providerID: input.providerID ?? "provider",
    mode: "normal",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: input.cost ?? 0,
    tokens: {
      input: input.input ?? 0,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: { read: input.cacheRead ?? 0, write: input.cacheWrite ?? 0 },
    },
    finish: input.finish,
  }
}

function sessionInfo(id: string, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/",
    title: id,
    version: "1.0.0",
    parentID,
    time: { created: 1, updated: 1 },
  }
}

async function createHarness(): Promise<Harness> {
  const screen: TestRendererSetup = await createTestRenderer({ width: 120, height: 24 })
  const listeners = new Map<string, Set<Listener>>()
  const subscriptions = new Set<() => void>()
  const statuses = new Map<string, SessionStatus>()
  const sessions = new Map<string, Session>()
  const parts = new Map<string, Part[]>()
  const disposeHandlers: Array<() => void | Promise<void>> = []
  const [routeState, setRouteState] = createSignal<TuiRouteCurrent>({ name: "session", params: { sessionID: "one" } })
  let sidebarRender: SidebarRender | undefined
  let disposed = false
  let partLookups = 0
  let sessionLookups = 0
  let renderRequests = 0

  const api = {
    event: {
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
    },
    state: {
      session: {
        status: (sessionID: string) => statuses.get(sessionID),
        get: (sessionID: string) => {
          sessionLookups += 1
          return sessions.get(sessionID)
        },
      },
      part: (messageID: string) => {
        partLookups += 1
        return parts.get(messageID) ?? []
      },
    },
    route: {
      register: () => () => {},
      navigate: () => {},
      get current() {
        return routeState()
      },
    },
    slots: {
      register(registered: { slots?: Record<string, unknown> }) {
        const slots = registered.slots ?? {}
        if (typeof slots.sidebar_footer === "function") sidebarRender = slots.sidebar_footer as SidebarRender
        return "opencode-tui-stats"
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(handler: () => void | Promise<void>) {
        disposeHandlers.push(handler)
        return () => {}
      },
    },
    theme: {
      current: {
        textMuted: RGBA.fromHex("#8a8a8a"),
        text: RGBA.fromHex("#ffffff"),
        warning: RGBA.fromHex("#ffaa00"),
        success: RGBA.fromHex("#00ff00"),
      },
    },
    renderer: {
      requestRender: () => {
        renderRequests += 1
      },
      width: 120,
    },
  } as unknown as TuiPluginApi

  await plugin.tui(api, undefined, undefined as unknown as TuiPluginMeta)

  const routeSession = () => {
    const current = routeState()
    return current.name === "session" ? (current as { params: { sessionID: string } }).params.sessionID : undefined
  }

  await render(
    () => (
      <box flexDirection="column" width={120}>
        <Show when={routeState().name === "session"}>
          {sidebarRender!({ theme: api.theme }, { get session_id() { return routeSession() ?? "" } })}
        </Show>
      </box>
    ),
    screen.renderer,
  )

  return {
    emit(type, properties) {
      for (const handler of listeners.get(type) ?? []) handler({ id: "event", type, properties })
    },
    setStatus(sessionID, status) {
      if (status === undefined) statuses.delete(sessionID)
      else statuses.set(sessionID, status)
    },
    setSession(sessionID, parentID) {
      sessions.set(sessionID, sessionInfo(sessionID, parentID))
    },
    setParts(messageID, value) {
      parts.set(messageID, value)
    },
    switchSession(sessionID) {
      setRouteState({ name: "session", params: { sessionID } })
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
    partLookups() {
      return partLookups
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
  const messageID = options.id ?? `${sessionID}-message`
  const partID = `${messageID}-part`
  harness.setStatus(sessionID, { type: "busy" })
  harness.setParts(messageID, [textPart(partID, messageID, sessionID)])

  setSystemTime(base)
  harness.emit("message.updated", {
    sessionID,
    info: assistantMessage({
      id: messageID,
      sessionID,
      created: base,
      providerID: options.providerID,
      modelID: options.modelID,
    }),
  })

  if (options.stream !== false) {
    setSystemTime(base + 500)
    harness.emit("message.part.delta", {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta: "x".repeat(25),
    })
  }

  setSystemTime(base + 2_500)
  harness.emit("message.updated", {
    sessionID,
    info: assistantMessage({
      id: messageID,
      sessionID,
      created: base,
      completed: base + 2_500,
      output: options.output ?? 0,
      reasoning: 0,
      input: options.input,
      cacheRead: options.cacheRead,
      cacheWrite: options.cacheWrite,
      cost: options.cost,
      finish: "stop",
      providerID: options.providerID,
      modelID: options.modelID,
    }),
  })
}

function completeStep(harness: Harness, sessionID: string, base: number, output: number) {
  completeMessage(harness, sessionID, base, { output })
}

test("empty session renders the placeholder row", async () => {
  const harness = await createHarness()
  activeHarness = harness
  harness.setStatus("one", { type: "busy" })
  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("Model-Performance · observed")
  expect(frame).toContain("Session CACHE —")
  expect(frame).not.toContain("retries")
})

test("model rows default to collapsed except the active model", async () => {
  const harness = await createHarness()
  activeHarness = harness

  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "a", sessionID: "one", created: 1, providerID: "provider", modelID: "a" }),
  })
  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "b", sessionID: "one", created: 2, providerID: "provider", modelID: "b" }),
  })

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
  harness.setRoute({ name: "home" })
  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).not.toContain("TPS")
  expect(frame).not.toContain("Performance")
})

test("streaming deltas produce a live TPS reading", async () => {
  const harness = await createHarness()
  activeHarness = harness
  harness.setStatus("one", { type: "busy" })
  harness.setParts("message", [textPart("part", "message", "one")])
  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "message", sessionID: "one", created: 1_700_000_000_000 }),
  })

  for (let index = 0; index < 2; index++) {
    harness.emit("message.part.delta", {
      sessionID: "one",
      messageID: "message",
      partID: "part",
      field: "text",
      delta: "x".repeat(25),
    })
  }

  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG — · TPS 10.0t/s")
  expect(harness.frame()).toContain("TPS 10.0")
})

test("finished session keeps the last live TPS reading, dimmed", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const base = 1_700_000_000_000
  const sessionID = "one"
  const messageID = "message"
  const partID = "part"
  harness.setStatus(sessionID, { type: "busy" })
  harness.setParts(messageID, [textPart(partID, messageID, sessionID)])

  setSystemTime(base)
  harness.emit("message.updated", {
    sessionID,
    info: assistantMessage({ id: messageID, sessionID, created: base }),
  })
  for (let index = 0; index < 2; index++) {
    harness.emit("message.part.delta", {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta: "x".repeat(25),
    })
  }

  // The first render observes and remembers the live reading.
  await harness.renderOnce()
  const live = harness.spans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("10.0t/s"))
  expect(live).toBeDefined()
  expect(live!.attributes & TextAttributes.DIM).toBe(0)

  // Once idle, the same value must remain visible (frozen) and be marked non-live.
  setSystemTime(base + 60_000)
  harness.setStatus(sessionID, { type: "idle" })
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

  harness.setStatus("one", { type: "busy" })
  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "never-streamed", sessionID: "one", created: 1_700_000_000_000 }),
  })

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
  const partID = "one-part"
  harness.setStatus(sessionID, { type: "busy" })
  harness.setParts(messageID, [textPart(partID, messageID, sessionID)])

  setSystemTime(1_700_000_000_000)
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: messageID, sessionID, created: 1_700_000_000_000 }) })

  setSystemTime(1_700_000_000_500)
  harness.emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta: "x".repeat(25) })

  setSystemTime(1_700_000_002_500)
  harness.emit("message.updated", {
    sessionID,
    info: assistantMessage({
      id: messageID,
      sessionID,
      created: 1_700_000_000_000,
      completed: 1_700_000_002_500,
      input: 24234,
      output: 2,
      reasoning: 0,
      cacheRead: 10752,
      cacheWrite: 0,
      cost: 0.007337112,
      finish: "stop",
    }),
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
  // Only the active model row carries the green dot.
  expect(frame).toContain("● ▼ deepseek/other")
  expect(frame).not.toContain("● ▼ deepseek-flash")
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

  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 1, message: "rate limited", next: 0 } })
  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 2, message: "rate limited", next: 0 } })
  await harness.renderOnce()
  expect(harness.frame()).toContain("Session CACHE — · retries 2")
  expect(internals().retries(sessionID)).toBe(2)

  // A non-retry status resets the baseline, so the next burst counts from 0 again.
  harness.emit("session.status", { sessionID, status: { type: "busy" } })
  await harness.renderOnce()
  expect(harness.frame()).toContain("Session CACHE — · retries 2")

  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 1, message: "rate limited", next: 0 } })
  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 2, message: "rate limited", next: 0 } })
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

test("re-emitting a completed message does not accumulate twice", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  const messageID = "one-message"
  const partID = "one-part"
  harness.setStatus(sessionID, { type: "busy" })
  harness.setParts(messageID, [textPart(partID, messageID, sessionID)])

  setSystemTime(1_700_000_000_000)
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: messageID, sessionID, created: 1_700_000_000_000 }) })
  setSystemTime(1_700_000_000_500)
  harness.emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta: "x".repeat(25) })
  setSystemTime(1_700_000_002_500)

  const completed = assistantMessage({
    id: messageID,
    sessionID,
    created: 1_700_000_000_000,
    completed: 1_700_000_002_500,
    input: 24234,
    output: 2,
    reasoning: 0,
    cacheRead: 10752,
    cacheWrite: 0,
    cost: 0.007337112,
    finish: "stop",
  })
  harness.emit("message.updated", { sessionID, info: completed })
  harness.emit("message.updated", { sessionID, info: completed })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("CACHE  30.7%")
  expect(frame).toContain("$0.0073")
})

test("delta classification is cached per part and rejects non-text parts", async () => {
  const harness = await createHarness()
  activeHarness = harness
  harness.setStatus("one", { type: "busy" })
  harness.setParts("m", [textPart("p-text", "m", "one"), reasoningPart("p-reason", "m", "one")])
  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "m", sessionID: "one", created: 1_700_000_000_000 }),
  })

  const before = harness.partLookups()
  harness.emit("message.part.delta", { sessionID: "one", messageID: "m", partID: "p-text", field: "text", delta: "x".repeat(25) })
  harness.emit("message.part.delta", { sessionID: "one", messageID: "m", partID: "p-text", field: "text", delta: "x".repeat(25) })
  harness.emit("message.part.delta", { sessionID: "one", messageID: "m", partID: "p-reason", field: "text", delta: "x".repeat(25) })

  // Each registered part is scanned at most once, even across repeated deltas.
  expect(harness.partLookups() - before).toBe(2)
  expect(internals().partDecision("p-text")).toBe(true)
  expect(internals().partDecision("p-reason")).toBe(true)

  // A miss is never negatively cached: unknown parts keep retrying the lookup.
  const afterAccepted = harness.partLookups()
  harness.emit("message.part.delta", { sessionID: "one", messageID: "m", partID: "p-unknown", field: "text", delta: "x".repeat(25) })
  harness.emit("message.part.delta", { sessionID: "one", messageID: "m", partID: "p-unknown", field: "text", delta: "x".repeat(25) })
  expect(harness.partLookups() - afterAccepted).toBe(2)
  expect(internals().partDecision("p-unknown")).toBeUndefined()

  // A registered non-text/reasoning part is rejected once, then answered from cache.
  harness.setParts("m2", [stepStartPart("p-step", "m2", "one")])
  const beforeReject = harness.partLookups()
  harness.emit("message.part.delta", { sessionID: "one", messageID: "m2", partID: "p-step", field: "text", delta: "x".repeat(25) })
  harness.emit("message.part.delta", { sessionID: "one", messageID: "m2", partID: "p-step", field: "text", delta: "x".repeat(25) })
  expect(harness.partLookups() - beforeReject).toBe(1)
  expect(internals().partDecision("p-step")).toBe(false)

  await harness.renderOnce()
  // Accepted text/reasoning deltas still produce a live reading (never the "—" placeholder).
  expect(harness.frame()).toMatch(/TPS \d/)
  expect(harness.frame()).not.toContain("TPS —")
})

test("internal caches stay bounded under sustained traffic", async () => {
  const harness = await createHarness()
  activeHarness = harness

  for (let index = 0; index < 1_100; index++) {
    const messageID = `m-${index}`
    const partID = `p-${index}`
    harness.setParts(messageID, [textPart(partID, messageID, "one")])
    harness.emit("message.part.delta", { sessionID: "one", messageID, partID, field: "text", delta: "x".repeat(25) })
    harness.emit("message.updated", {
      sessionID: "one",
      info: assistantMessage({ id: messageID, sessionID: "one", created: 1_700_000_000_000, completed: 1_700_000_000_100 }),
    })
  }

  for (let index = 0; index < 70; index++) {
    completeStep(harness, `s-${index}`, 1_700_000_000_000 + index * 10_000, 20)
  }

  const sizes = internals().sizes()
  expect(sizes.parts).toBeLessThanOrEqual(1_024)
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

test("dedup window covers the most recent 64 completed messages per session", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  for (let index = 0; index < 65; index++) {
    harness.emit("message.updated", {
      sessionID,
      info: assistantMessage({ id: `d-${index}`, sessionID, created: 1, completed: 2, cost: 0.01 }),
    })
  }

  // 65 distinct completed messages accumulate once each; only the newest 64 ids are retained.
  expect(internals().dedupSize(sessionID)).toBe(64)
  expect(internals().hasStats(sessionID)).toBe(true)
  await harness.renderOnce()
  expect(harness.frame()).toContain("$0.6500")

  // Inside the window: re-emitting a retained id is deduplicated.
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: "d-64", sessionID, created: 1, completed: 2, cost: 0.01 }) })
  await harness.renderOnce()
  expect(harness.frame()).toContain("$0.6500")

  // Outside the window: the oldest id (d-0) was evicted, so re-emitting it accumulates again.
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: "d-0", sessionID, created: 1, completed: 2, cost: 0.01 }) })
  await harness.renderOnce()
  expect(harness.frame()).toContain("$0.6600")
})

test("idle clears unfinished timings for the session", async () => {
  const harness = await createHarness()
  activeHarness = harness

  harness.emit("message.updated", { sessionID: "one", info: assistantMessage({ id: "m1", sessionID: "one", created: 1 }) })
  harness.emit("message.updated", { sessionID: "two", info: assistantMessage({ id: "m2", sessionID: "two", created: 1 }) })
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
  const partID = "tool-part"
  const base = 1_700_000_000_000
  harness.setStatus(sessionID, { type: "busy" })

  setSystemTime(base)
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: messageID, sessionID, created: base }) })

  setSystemTime(base + 500)
  harness.emit("message.part.updated", {
    part: toolPart(partID, messageID, sessionID, { status: "pending", input: {}, raw: "" }),
  })

  setSystemTime(base + 1_500)
  harness.emit("message.part.updated", {
    part: toolPart(partID, messageID, sessionID, { status: "running", input: {}, time: { start: base + 1_500 } }),
  })

  setSystemTime(base + 2_000)
  harness.emit("message.updated", {
    sessionID,
    info: assistantMessage({ id: messageID, sessionID, created: base, completed: base + 2_000, output: 20, reasoning: 0, finish: "tool-calls" }),
  })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("AVG 20.0")
  expect(frame).toContain("TTFT 0.5s")
})

test("model panel lists the active model first", async () => {
  const harness = await createHarness()
  activeHarness = harness

  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "a", sessionID: "one", created: 1, providerID: "provider", modelID: "a" }),
  })
  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "b", sessionID: "one", created: 2, providerID: "provider", modelID: "b" }),
  })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(internals().activeModel("one")).toBe("provider/b")
  expect(frame).toContain("▼ provider/b")
  expect(frame).not.toContain("active")
  expect(frame.indexOf("provider/b")).toBeLessThan(frame.indexOf("provider/a"))
})

test("model panel caps at four models and reports the overflow", async () => {
  const harness = await createHarness()
  activeHarness = harness

  for (const modelID of ["a", "b", "c", "d", "e", "f"]) {
    harness.emit("message.updated", {
      sessionID: "one",
      info: assistantMessage({ id: modelID, sessionID: "one", created: 1, providerID: "provider", modelID }),
    })
  }

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("▼ provider/f")
  expect(frame).toContain("+2 more models")
  expect(frame).not.toContain("provider/a")
  expect(frame).not.toContain("provider/b")
})

test("model panel reports session retries without per-model attribution", async () => {
  const harness = await createHarness()
  activeHarness = harness

  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "a", sessionID: "one", created: 1, providerID: "provider", modelID: "a" }),
  })
  harness.emit("session.status", { sessionID: "one", status: { type: "retry", attempt: 1, message: "rate limited", next: 0 } })
  harness.emit("session.status", { sessionID: "one", status: { type: "retry", attempt: 2, message: "rate limited", next: 0 } })

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

  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "a", sessionID: "one", created: 1, providerID: "provider", modelID: "a" }),
  })
  harness.emit("message.updated", {
    sessionID: "one",
    info: assistantMessage({ id: "b", sessionID: "one", created: 2, providerID: "provider", modelID: "b" }),
  })
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
  harness.emit("session.created", { sessionID: "one", info: sessionInfo("one") })
  harness.emit("session.created", { sessionID: "child", info: sessionInfo("child", "one") })

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
  harness.emit("session.created", { sessionID: "child", info: sessionInfo("child", "one") })

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
    harness.emit("session.created", { sessionID: id, info: sessionInfo(id, parentID) })
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
  harness.emit("session.created", { sessionID: "child", info: sessionInfo("child", "one") })

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
  // No session.created/updated event: the relation only exists in `api.state.session.get`.
  harness.setSession("child", "one")

  completeMessage(harness, "child", base, { modelID: "b" })

  await harness.renderOnce()
  const frame = harness.frame()
  expect(frame).toContain("↳ provider/b")
  expect(harness.sessionLookups()).toBeGreaterThan(0)
})
