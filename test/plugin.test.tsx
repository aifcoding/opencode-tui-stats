import { afterEach, expect, setSystemTime, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import type { Message, Part, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2"
import { batch, createSignal } from "solid-js"
import type { TrackerInternals } from "../tracker"

const { default: plugin } = await import("../tui")
const { getLastInternals } = await import("../tracker")

function internals(): TrackerInternals {
  const value = getLastInternals()
  if (!value) throw new Error("tracker internals were not initialized")
  return value
}

type SlotRender = (context: unknown, props: { session_id: string }) => JSX.Element
type Listener = (event: unknown) => void

type Harness = {
  emit(type: string, properties: Record<string, unknown>): void
  setStatus(sessionID: string, status: SessionStatus | undefined): void
  setParts(messageID: string, value: Part[]): void
  switchSession(sessionID: string): void
  renderOnce(): Promise<void>
  frame(): string
  subscriptionCount(): number
  partLookups(): number
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
}): Message {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: input.completed === undefined ? { created: input.created } : { created: input.created, completed: input.completed },
    parentID: "user-message",
    modelID: "model",
    providerID: "provider",
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

async function createHarness(): Promise<Harness> {
  const screen: TestRendererSetup = await createTestRenderer({ width: 120, height: 4 })
  const listeners = new Map<string, Set<Listener>>()
  const subscriptions = new Set<() => void>()
  const statuses = new Map<string, SessionStatus>()
  const parts = new Map<string, Part[]>()
  const disposeHandlers: Array<() => void | Promise<void>> = []
  let slotRender: SlotRender | undefined
  let disposed = false
  let partLookups = 0

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
      session: { status: (sessionID: string) => statuses.get(sessionID) },
      part: (messageID: string) => {
        partLookups += 1
        return parts.get(messageID) ?? []
      },
    },
    slots: {
      register(registered: { slots?: Record<string, unknown> }) {
        const candidate = registered.slots?.session_prompt_right
        if (typeof candidate === "function") slotRender = candidate as SlotRender
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
    theme: { current: { textMuted: RGBA.fromHex("#8a8a8a") } },
    renderer: { requestRender: () => {} },
  } as unknown as TuiPluginApi

  await plugin.tui(api, undefined, undefined as unknown as TuiPluginMeta)

  const [currentSession, setCurrentSession] = createSignal("one")
  await render(() => {
    if (!slotRender) throw new Error("session_prompt_right slot was not registered")
    return slotRender({ theme: api.theme }, { get session_id() { return currentSession() } })
  }, screen.renderer)

  return {
    emit(type, properties) {
      for (const handler of listeners.get(type) ?? []) handler({ id: "event", type, properties })
    },
    setStatus(sessionID, status) {
      if (status === undefined) statuses.delete(sessionID)
      else statuses.set(sessionID, status)
    },
    setParts(messageID, value) {
      parts.set(messageID, value)
    },
    switchSession(sessionID) {
      setCurrentSession(sessionID)
    },
    renderOnce() {
      return screen.renderOnce()
    },
    frame() {
      return screen.captureCharFrame()
    },
    subscriptionCount() {
      return subscriptions.size
    },
    partLookups() {
      return partLookups
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const handler of [...disposeHandlers]) await handler()
      disposeHandlers.length = 0
      screen.renderer.destroy()
    },
  }
}

function completeStep(harness: Harness, sessionID: string, base: number, output: number) {
  const messageID = `${sessionID}-message`
  const partID = `${sessionID}-part`
  harness.setStatus(sessionID, { type: "busy" })
  harness.setParts(messageID, [textPart(partID, messageID, sessionID)])

  setSystemTime(base)
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: messageID, sessionID, created: base }) })

  setSystemTime(base + 500)
  harness.emit("message.part.delta", {
    sessionID,
    messageID,
    partID,
    field: "text",
    delta: "x".repeat(25),
  })

  setSystemTime(base + 2_500)
  harness.emit("message.updated", {
    sessionID,
    info: assistantMessage({ id: messageID, sessionID, created: base, completed: base + 2_500, output, reasoning: 0, finish: "stop" }),
  })
}

test("empty session renders the placeholder row", async () => {
  const harness = await createHarness()
  activeHarness = harness
  harness.setStatus("one", { type: "busy" })
  await harness.renderOnce()
  expect(harness.frame()).toContain("TPS - | AVG - | TTFT - | CACHE - | COST - | RETRY 0")
})

test("streaming deltas produce a live TPS reading", async () => {
  const harness = await createHarness()
  activeHarness = harness
  harness.setStatus("one", { type: "busy" })
  harness.setParts("message", [textPart("part", "message", "one")])

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
  expect(harness.frame()).toContain("TPS 10.0")
})

test("finished message accumulates AVG and TTFT", async () => {
  const harness = await createHarness()
  activeHarness = harness

  completeStep(harness, "one", 1_700_000_000_000, 20)

  await harness.renderOnce()
  expect(harness.frame()).toContain("TPS - | AVG 10.0 | TTFT 0.5s")
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
  expect(frame).toContain("CACHE 31%")
  expect(frame).toContain("COST $0.0073")
})

test("retry count follows the reported attempt number", async () => {
  const harness = await createHarness()
  activeHarness = harness

  const sessionID = "one"
  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 1, message: "rate limited", next: 0 } })
  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 2, message: "rate limited", next: 0 } })
  await harness.renderOnce()
  expect(harness.frame()).toContain("RETRY 2")
  expect(internals().retries(sessionID)).toBe(2)

  // A non-retry status resets the baseline, so the next burst counts from 0 again.
  harness.emit("session.status", { sessionID, status: { type: "busy" } })
  await harness.renderOnce()
  expect(harness.frame()).toContain("RETRY 2")

  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 1, message: "rate limited", next: 0 } })
  harness.emit("session.status", { sessionID, status: { type: "retry", attempt: 2, message: "rate limited", next: 0 } })
  await harness.renderOnce()
  expect(harness.frame()).toContain("RETRY 4")
  expect(internals().retries(sessionID)).toBe(4)
})

test("switching sessions keeps each session's accumulated totals", async () => {
  const harness = await createHarness()
  activeHarness = harness

  harness.switchSession("one")
  completeStep(harness, "one", 1_700_000_000_000, 20)
  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG 10.0 | TTFT 0.5s")

  harness.switchSession("two")
  completeStep(harness, "two", 1_700_000_100_000, 60)
  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG 30.0 | TTFT 0.5s")

  harness.switchSession("one")
  await harness.renderOnce()
  expect(harness.frame()).toContain("AVG 10.0 | TTFT 0.5s")
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
  expect(frame).toContain("CACHE 31%")
  expect(frame).toContain("COST $0.0073")
})

test("delta classification is cached per part and rejects non-text parts", async () => {
  const harness = await createHarness()
  activeHarness = harness
  harness.setStatus("one", { type: "busy" })
  harness.setParts("m", [textPart("p-text", "m", "one"), reasoningPart("p-reason", "m", "one")])

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
  expect(harness.frame()).not.toContain("TPS -")
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
  expect(harness.frame()).toContain("AVG 10.0 | TTFT 0.5s")
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
  expect(harness.frame()).toContain("COST $0.6500")

  // Inside the window: re-emitting a retained id is deduplicated.
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: "d-64", sessionID, created: 1, completed: 2, cost: 0.01 }) })
  await harness.renderOnce()
  expect(harness.frame()).toContain("COST $0.6500")

  // Outside the window: the oldest id (d-0) was evicted, so re-emitting it accumulates again.
  harness.emit("message.updated", { sessionID, info: assistantMessage({ id: "d-0", sessionID, created: 1, completed: 2, cost: 0.01 }) })
  await harness.renderOnce()
  expect(harness.frame()).toContain("COST $0.6600")
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
  expect(harness.frame()).toContain("AVG 20.0 | TTFT 0.5s")
})
