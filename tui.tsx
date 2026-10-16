/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { createTracker, type TrackerHandle } from "./tracker"

function SessionPromptRight(props: {
  api: TuiPluginApi
  sessionID: string
  tracker: TrackerHandle
  revision: Accessor<number>
}) {
  let mounted: string | undefined

  const content = createMemo(() => {
    props.revision()
    const sessionID = props.sessionID
    if (mounted !== sessionID) {
      if (mounted !== undefined) props.tracker.unmountSession(mounted)
      props.tracker.mountSession(sessionID)
      mounted = sessionID
    }
    return props.tracker.statusText(sessionID)
  })

  onCleanup(() => {
    if (mounted !== undefined) props.tracker.unmountSession(mounted)
  })

  return <text fg={props.api.theme.current.textMuted}>{content()}</text>
}

const tui: TuiPlugin = async (api) => {
  const [revision, setRevision] = createSignal(0)
  const tracker = createTracker(api, () => setRevision((value) => value + 1))

  api.lifecycle.onDispose(() => tracker.dispose())

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
