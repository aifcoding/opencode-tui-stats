/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/**
 * Quote a previous message into the prompt.
 *
 * v1.19.x has no message-level UI hook, so the entrypoint is a keybind / slash command:
 *   ctrl+q  (or /quote) -> centered message picker -> append "> ..." to the prompt.
 *
 * The quoted content is plain text; the prompt protocol has no structured quote part.
 */

const MAX_MESSAGES = 40
const MAX_QUOTE_CHARS = 2000

function textOf(parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>) {
  return parts
    .filter((part) => part.type === "text" && !part.synthetic && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

function firstLine(text: string, max = 60) {
  const line = text.split("\n").find((x) => x.trim().length > 0)?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function clock(ms?: number) {
  if (!ms) return ""
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function quoteBody(text: string) {
  const clipped = text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}\n…（已截断）` : text
  return `> ${clipped.replace(/\n/g, "\n> ")}\n\n`
}

export function registerQuote(api: TuiPluginApi) {
  const open = () => {
    const route = api.route.current
    if (route.name !== "session") {
      api.ui.toast({ variant: "warning", message: "请先进入一个会话" })
      return
    }
    const sessionID = (route as { params?: { sessionID?: string } }).params?.sessionID
    if (!sessionID) {
      api.ui.toast({ variant: "warning", message: "没有找到当前会话" })
      return
    }

    const rows = api.state.session
      .messages(sessionID)
      .map((message) => ({ message, text: textOf(api.state.part(message.id) as never) }))
      .filter((row) => row.text.length > 0)
      .slice(-MAX_MESSAGES)
      .reverse()

    if (rows.length === 0) {
      api.ui.toast({ variant: "info", message: "当前会话还没有可引用的文本消息" })
      return
    }

    const byID = new Map(rows.map((row) => [row.message.id, row]))

    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="引用消息"
        placeholder="输入关键字过滤"
        options={rows.map((row) => ({
          title: `${row.message.role === "user" ? "你" : "AI"} · ${firstLine(row.text)}`,
          value: row.message.id,
          description: `${clock((row.message as { time?: { created?: number } }).time?.created)} · ${row.text.length} 字符`,
        }))}
        onSelect={(option: { value?: string } | undefined) => {
          const row = option?.value ? byID.get(option.value) : undefined
          if (row) {
            void api.client.tui.appendPrompt({ text: quoteBody(row.text) })
          }
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  api.keymap.registerLayer({
    mode: "base",
    commands: [
      {
        name: "quote.message",
        title: "引用消息",
        category: "Plugin",
        namespace: "palette",
        slashName: "quote",
        run: open,
      },
    ],
    bindings: [
      { key: "ctrl+q", cmd: "quote.message", desc: "引用消息到输入框" },
      { key: "ctrl+shift+q", cmd: "quote.message", desc: "引用消息到输入框" },
    ],
  })
}
