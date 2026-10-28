import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const { registerQuote } = await import("../quote")

test("quote inserts the selected message text into the prompt", async () => {
  const appended: string[] = []
  let cleared = 0
  let layer: any
  let render: (() => unknown) | undefined
  let selectProps: any

  const api = {
    keymap: {
      registerLayer: (value: any) => {
        layer = value
      },
    },
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    ui: {
      toast: () => {},
      dialog: {
        replace: (value: () => unknown) => {
          render = value
        },
        clear: () => {
          cleared++
        },
      },
      DialogSelect: (props: any) => {
        selectProps = props
        return null
      },
    },
    state: {
      session: {
        messages: () => [
          { id: "m1", role: "assistant", time: { created: 1 } },
          { id: "m2", role: "user", time: { created: 2 } },
        ],
      },
      part: (id: string) =>
        id === "m1"
          ? [{ type: "text", text: "hello\nworld" }]
          : [{ type: "text", text: "question" }],
    },
    client: {
      tui: {
        appendPrompt: async (input: { text: string }) => {
          appended.push(input.text)
          return true
        },
      },
    },
  } as unknown as TuiPluginApi

  registerQuote(api)

  expect(layer.bindings.map((binding: any) => binding.key)).toContain("ctrl+q")
  const command = layer.commands.find((item: any) => item.name === "quote.message")
  expect(command).toBeTruthy()
  command.run()

  expect(render).toBeTruthy()
  render!()
  expect(selectProps.options.length).toBe(2)

  // Newest message is listed first; selecting it quotes the stored text.
  expect(selectProps.options[0].value).toBe("m2")
  selectProps.onSelect({ value: "m1" })

  expect(appended).toEqual(["> hello\n> world\n\n"])
  expect(cleared).toBe(1)
})

test("quote truncates long messages", async () => {
  const appended: string[] = []
  let layer: any
  let render: (() => unknown) | undefined
  let selectProps: any
  const long = "x".repeat(2500)

  const api = {
    keymap: {
      registerLayer: (value: any) => {
        layer = value
      },
    },
    route: { current: { name: "session", params: { sessionID: "s1" } } },
    ui: {
      toast: () => {},
      dialog: {
        replace: (value: () => unknown) => {
          render = value
        },
        clear: () => {},
      },
      DialogSelect: (props: any) => {
        selectProps = props
        return null
      },
    },
    state: {
      session: { messages: () => [{ id: "m1", role: "assistant", time: { created: 1 } }] },
      part: () => [{ type: "text", text: long }],
    },
    client: {
      tui: {
        appendPrompt: async (input: { text: string }) => {
          appended.push(input.text)
          return true
        },
      },
    },
  } as unknown as TuiPluginApi

  registerQuote(api)
  layer.commands.find((item: any) => item.name === "quote.message").run()
  render!()
  selectProps.onSelect({ value: "m1" })

  expect(appended[0].startsWith("> xxx")).toBe(true)
  expect(appended[0]).toContain("…（已截断）")
  expect(appended[0].length).toBeLessThan(2100)
})
