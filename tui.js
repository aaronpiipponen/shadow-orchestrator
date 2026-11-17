// Open the shadow orchestrator message dialogs in the terminal UI.
import { Shadow } from "./rpc.js"

const MANUAL_COMMANDS = [
  {
    id: "shadow-orchestrator.register-manual",
    title: "Register shadow orchestrator with a message",
    slash: { name: "shadow-register-manual" },
    method: "registerManual",
    dialog: "Register the shadow orchestrator",
    placeholder: "Initial message for the shadow orchestrator",
  },
  {
    id: "shadow-orchestrator.wake-manual",
    title: "Wake the shadow orchestrator with a message",
    slash: { name: "shadow-wake-manual" },
    method: "wakeManual",
    dialog: "Wake the shadow orchestrator",
    placeholder: "Wake message for the shadow orchestrator",
  },
]

// Read the message from a dialog and call the matching server method.
async function runManual(context, definition) {
  const route = context.ui.router.current()
  const sessionID = route?.type === "session" ? route.sessionID : undefined
  const text = await context.ui.dialog.prompt({
    title: definition.dialog,
    placeholder: definition.placeholder,
  })
  if (!text || !text.trim()) {
    context.ui.toast.show({ message: "No message entered. The command was cancelled." })
    return
  }
  const request = { directory: context.location.directory, text }
  if (sessionID) request.sessionID = sessionID
  if (definition.method === "registerManual") {
    const selected = context.ui.model.current()
    const id = selected?.modelID ?? selected?.id
    if (selected && id) {
      request.model = { providerID: selected.providerID, id }
      if (selected.variant) request.model.variant = selected.variant
    }
  }
  try {
    const result = await context.client.rpc(Shadow)[definition.method](request)
    context.ui.toast.show({ message: result.message })
    if (result.sessionID) context.ui.router.navigate({ type: "session", sessionID: result.sessionID })
  } catch (error) {
    context.ui.toast.show({ message: `The shadow orchestrator command failed: ${error?.message ?? error}` })
  }
}

export default {
  id: "shadow-orchestrator.tui",
  setup(context) {
    if (typeof context?.keymap?.layer !== "function" || typeof context?.ui?.dialog?.prompt !== "function") return
    context.keymap.layer(() => ({
      mode: "global",
      commands: MANUAL_COMMANDS.map((definition) => ({
        id: definition.id,
        title: definition.title,
        slash: definition.slash,
        run: () => runManual(context, definition),
      })),
    }))
  },
}
