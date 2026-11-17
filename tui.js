// Open the shadow orchestrator message dialogs in the terminal UI.

const MANUAL_COMMANDS = [
  {
    id: "shadow-orchestrator.register-manual",
    title: "Register shadow orchestrator with a message",
    slash: { name: "shadow-register-manual" },
    command: "shadow-register-manual",
    dialog: "Register the shadow orchestrator",
    placeholder: "Initial message for the shadow orchestrator",
  },
  {
    id: "shadow-orchestrator.wake-manual",
    title: "Wake the shadow orchestrator with a message",
    slash: { name: "shadow-wake-manual" },
    command: "shadow-wake-manual",
    dialog: "Wake the shadow orchestrator",
    placeholder: "Wake message for the shadow orchestrator",
  },
]

// Read the message from a dialog and run the matching server command in the current session.
async function runManual(context, definition) {
  const route = context.ui.router.current()
  if (route?.type !== "session") {
    context.ui.toast.show({ message: "Open a session before using this command." })
    return
  }
  const text = await context.ui.dialog.prompt({
    title: definition.dialog,
    placeholder: definition.placeholder,
  })
  if (!text || !text.trim()) {
    context.ui.toast.show({ message: "No message entered. The command was cancelled." })
    return
  }
  try {
    await context.client.session.command({
      sessionID: route.sessionID,
      name: definition.command,
      text,
    })
  } catch (error) {
    context.ui.toast.show({ message: `The shadow orchestrator command failed: ${error}` })
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
