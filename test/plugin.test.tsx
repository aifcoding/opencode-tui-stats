import { afterEach, expect, setSystemTime, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"

const { default: plugin } = await import("../tui")

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

function assistantMessage(input: {
  id: string
  sessionID: string
  created: number
  completed?: number
  output?: number
  reasoning?: number
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
    cost: 0,
    tokens: {
      input: 0,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: { read: 0, write: 0 },
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
      part: (messageID: string) => parts.get(messageID) ?? [],
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
  expect(harness.frame()).toContain("TPS - | AVG - | TTFT -")
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
