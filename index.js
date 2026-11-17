// Route messages between a working session and a shadow orchestrator session.
//
// The plugin registers four commands, stores one session binding per workspace, and injects
// one prompt per wake. Configuration loads from config.json and reloads when the file changes.

import { execFile } from "node:child_process"
import { appendFileSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Shadow } from "./rpc.js"

const git = promisify(execFile)
// A config save arrives as a burst of file events, so a reload waits for the burst to end.
const RELOAD_DEBOUNCE = 150
const STATE_KEY = Symbol.for("opencode.shadow-orchestrator.state")
const PROMPT_METADATA = { shadowOrchestrator: true }

// Expand a leading tilde to the home directory and resolve a relative path against the config.
function resolveDirectory(value, base) {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded)
}

function pathSegments(value) {
  return path.resolve(value).split(path.sep).filter(Boolean)
}

// Compare whole path segments, so /projects-two does not match a /projects entry.
function isPathPrefix(prefix, target) {
  if (prefix.length > target.length) return false
  return prefix.every((segment, index) => segment === target[index])
}

function requireObject(value, file, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: "${key}" must be an object`)
  }
}

function requireMessage(value, file, key) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${file}: "${key}" must be a non-empty string`)
  }
}

function loadConfig(file) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${error.message}`)
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: the config must be a JSON object`)
  }
  if (raw.logFile !== undefined && (typeof raw.logFile !== "string" || !raw.logFile.trim())) {
    throw new Error(`${file}: "logFile" must be a non-empty path`)
  }
  requireObject(raw.default, file, "default")
  requireMessage(raw.default.initial_message, file, "default.initial_message")
  requireMessage(raw.default.wake_message, file, "default.wake_message")

  // repositories win over the paths alias when both name the same directory.
  const entries = new Map()
  for (const key of ["paths", "repositories"]) {
    if (raw[key] === undefined) continue
    requireObject(raw[key], file, key)
    for (const [directory, entry] of Object.entries(raw[key])) {
      if (!directory.trim()) throw new Error(`${file}: "${key}" contains an empty directory`)
      requireObject(entry, file, `${key}["${directory}"]`)
      if (entry.initial_message !== undefined) {
        requireMessage(entry.initial_message, file, `${key}["${directory}"].initial_message`)
      }
      if (entry.wake_message !== undefined) {
        requireMessage(entry.wake_message, file, `${key}["${directory}"].wake_message`)
      }
      entries.set(directory, { ...entries.get(directory), ...entry })
    }
  }

  const base = path.dirname(file)
  return {
    logFile: raw.logFile === undefined ? undefined : path.resolve(base, raw.logFile),
    initialMessage: raw.default.initial_message,
    wakeMessage: raw.default.wake_message,
    entries: [...entries].map(([directory, entry]) => {
      const resolved = resolveDirectory(directory, base)
      return {
        directory,
        segments: pathSegments(resolved),
        initialMessage: entry.initial_message ?? raw.default.initial_message,
        wakeMessage: entry.wake_message ?? raw.default.wake_message,
      }
    }),
  }
}

// Return the entry with the longest matching path prefix, or the defaults for no match.
function matchEntry(config, workspaceKey) {
  const target = pathSegments(workspaceKey)
  let best
  for (const entry of config.entries) {
    if (!isPathPrefix(entry.segments, target)) continue
    if (!best || entry.segments.length > best.segments.length) best = entry
  }
  return best ?? { initialMessage: config.initialMessage, wakeMessage: config.wakeMessage }
}

// Return the git root of a directory, or the resolved directory when it is outside a repository.
async function resolveWorkspace(directory) {
  const resolved = path.resolve(directory)
  try {
    const { stdout } = await git("git", ["rev-parse", "--show-toplevel"], { cwd: resolved, timeout: 5000 })
    const root = stdout.trim()
    if (root) return path.resolve(root)
  } catch {
    // A directory outside a git repository is its own workspace.
  }
  return resolved
}

// Read the binding document, or undefined when the file does not exist.
function readState(file) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
  const raw = JSON.parse(text)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: the state must be a JSON object`)
  }
  const bindings = {}
  if (raw.bindings !== undefined) {
    if (!raw.bindings || typeof raw.bindings !== "object" || Array.isArray(raw.bindings)) {
      throw new Error(`${file}: "bindings" must be an object`)
    }
    for (const [key, value] of Object.entries(raw.bindings)) {
      const sessionID = typeof value === "string" ? value : value?.sessionID
      if (typeof sessionID !== "string" || !sessionID) continue
      bindings[key] = { sessionID, registeredAt: value?.registeredAt }
    }
  }
  return { bindings }
}

// Replace the state file in one step, so a reader never sees a partial document.
function writeState(file, bindings) {
  const document = { version: 1, bindings, updated: new Date().toISOString() }
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
  renameSync(temporary, file)
}

export default {
  id: "shadow-orchestrator",
  async setup(ctx) {
    if (typeof ctx?.command?.transform !== "function" || typeof ctx?.session?.get !== "function") return

    const file = ctx.options?.config ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json")
    const shared = (globalThis[STATE_KEY] ??= {})
    const configs = (shared.configs ??= new Map())
    const watchers = (shared.watchers ??= new Map())
    const states = (shared.states ??= new Map())

    if (!configs.has(file)) configs.set(file, loadConfig(file))
    const current = () => configs.get(file)

    // OpenCode does not capture plugin console output, so events go to logFile when set.
    const log = (line) => {
      const target = current().logFile
      if (!target) return
      try {
        appendFileSync(target, `${new Date().toISOString()} shadow-orchestrator: ${line}\n`)
      } catch {
        // A failed log write cannot be reported through the log.
      }
    }

    const stateFile = path.join(path.dirname(file), "state.json")
    const state = states.get(stateFile) ?? { bindings: {} }
    states.set(stateFile, state)

    // The state file is authoritative, so another OpenCode instance sees each registration.
    const refresh = () => {
      try {
        const disk = readState(stateFile)
        if (disk) state.bindings = disk.bindings
      } catch (error) {
        log(`state file could not be read, keeping the bindings in memory: ${error}`)
      }
    }

    const persist = () => {
      try {
        writeState(stateFile, state.bindings)
      } catch (error) {
        log(`state file could not be written: ${error}`)
      }
    }

    const report = async (sessionID, text) => {
      if (typeof ctx.session.synthetic !== "function") return
      try {
        await ctx.session.synthetic({ sessionID, text, description: "shadow-orchestrator", resume: false })
      } catch (error) {
        log(`synthetic report failed: ${error}`)
      }
    }

    const sessionFor = async (sessionID) => {
      const info = await ctx.session.get({ sessionID })
      const directory = info?.location?.directory ?? ctx.location?.directory
      if (!directory) throw new Error("the session has no directory")
      return { directory, model: info?.model }
    }

    const workspaceFor = async (sessionID) => resolveWorkspace((await sessionFor(sessionID)).directory)

    const messagesFor = (workspaceKey) => matchEntry(current(), workspaceKey)

    let rpcRegistration
    const announce = async (sessionID) => {
      if (!rpcRegistration?.events?.emit) return
      try {
        await rpcRegistration.events.emit("started", { sessionID })
      } catch (error) {
        log(`start event failed: ${error}`)
      }
    }

    const start = async ({ directory, workspaceKey, model }, text, notify = false) => {
      const created = await ctx.session.create({
        title: "Shadow Orchestrator",
        location: { directory },
        ...(model ? { model } : {}),
      })
      const sessionID = created?.id
      if (!sessionID) throw new Error("the orchestrator session was not created")
      refresh()
      state.bindings[workspaceKey] = { sessionID, registeredAt: new Date().toISOString() }
      persist()
      try {
        await ctx.session.prompt({ sessionID, text, metadata: PROMPT_METADATA })
      } catch (error) {
        log(`initial message to ${sessionID} failed: ${error}`)
        if (notify) await announce(sessionID)
        return { sessionID, message: `Shadow orchestrator started for ${workspaceKey} (${sessionID}), but the initial message failed.` }
      }
      if (notify) await announce(sessionID)
      return { sessionID, message: `Shadow orchestrator started for ${workspaceKey} (${sessionID}).` }
    }

    const wake = async (workspaceKey, text) => {
      refresh()
      const binding = state.bindings[workspaceKey]
      if (!binding?.sessionID) {
        log(`no binding for ${workspaceKey}`)
        return `No shadow orchestrator is registered for ${workspaceKey}. Run /shadow-register from this workspace.`
      }
      let target
      try {
        target = await ctx.session.get({ sessionID: binding.sessionID })
      } catch (error) {
        delete state.bindings[workspaceKey]
        persist()
        log(`cleared the binding for ${workspaceKey}: ${error}`)
        return `The shadow orchestrator for ${workspaceKey} is gone. Run /shadow-register from this workspace.`
      }
      if (target?.time?.archived) {
        delete state.bindings[workspaceKey]
        persist()
        log(`cleared the archived binding for ${workspaceKey}`)
        return `The shadow orchestrator for ${workspaceKey} is archived. Run /shadow-register from this workspace.`
      }
      try {
        await ctx.session.prompt({ sessionID: binding.sessionID, text, metadata: PROMPT_METADATA })
      } catch (error) {
        log(`wake to ${binding.sessionID} failed: ${error}`)
        return `The wake message to the shadow orchestrator for ${workspaceKey} failed.`
      }
      return `Shadow orchestrator woken for ${workspaceKey}.`
    }

    const failureMessage = (error) => `The shadow orchestrator command failed: ${error?.message ?? error}`

    const guard = (handler) => async (input) => {
      try {
        await report(input.sessionID, await handler(input))
      } catch (error) {
        log(`command failed: ${error?.stack ?? error}`)
        await report(input.sessionID, failureMessage(error))
      }
    }

    const definitions = [
      {
        name: "shadow-register",
        description: "Start a shadow orchestrator session for the current workspace",
        execute: guard(async ({ sessionID }) => {
          const target = await sessionFor(sessionID)
          const workspaceKey = await resolveWorkspace(target.directory)
          const result = await start(
            { directory: target.directory, workspaceKey, model: target.model },
            messagesFor(workspaceKey).initialMessage,
            true,
          )
          return result.message
        }),
      },
      {
        name: "shadow-wake",
        description: "Wake the shadow orchestrator for the current workspace",
        execute: guard(async ({ sessionID }) => {
          const workspaceKey = await workspaceFor(sessionID)
          return wake(workspaceKey, messagesFor(workspaceKey).wakeMessage)
        }),
      },
    ]

    await ctx.command.transform((editor) => {
      for (const definition of definitions) editor.add(definition)
    })

    rpcRegistration = await ctx.rpc.register(Shadow, {
      registerManual: async ({ sessionID, directory, model, text }) => {
        const message = (text ?? "").trim()
        if (!message) return { message: "No message entered. The command was cancelled.", sessionID: "" }
        try {
          const target = sessionID ? await sessionFor(sessionID) : { directory, model }
          if (!target.directory) throw new Error("the request has no session or directory")
          const workspaceKey = await resolveWorkspace(target.directory)
          return await start(
            { directory: target.directory, workspaceKey, model: target.model ?? model },
            message,
          )
        } catch (error) {
          log(`manual registration failed: ${error?.stack ?? error}`)
          return { message: failureMessage(error), sessionID: "" }
        }
      },
      wakeManual: async ({ sessionID, directory, text }) => {
        const message = (text ?? "").trim()
        if (!message) return { message: "No message entered. The command was cancelled." }
        try {
          const workspaceKey = sessionID ? await workspaceFor(sessionID) : await resolveWorkspace(directory)
          return { message: await wake(workspaceKey, message) }
        } catch (error) {
          log(`manual wake failed: ${error?.stack ?? error}`)
          return { message: failureMessage(error) }
        }
      },
    })

    // The shared map outlives a reloaded build, so an entry can be a bare watcher rather
    // than the counted entry this code stores. The count starts at zero so this load owns it.
    let watcherEntry = watchers.get(file)
    if (watcherEntry && typeof watcherEntry.close === "function") {
      watcherEntry = { watcher: watcherEntry, users: 0 }
      watchers.set(file, watcherEntry)
    }
    if (!watcherEntry) {
      try {
        const watcher = watch(path.dirname(file), { persistent: false }, (_event, name) => {
          if (name && name !== path.basename(file)) return
          clearTimeout(watcher.timer)
          watcher.timer = setTimeout(() => {
            try {
              configs.set(file, loadConfig(file))
            } catch (error) {
              log(`config reload failed, keeping the previous settings: ${error}`)
              return
            }
          }, RELOAD_DEBOUNCE)
        })
        watcherEntry = { watcher, users: 0 }
        watchers.set(file, watcherEntry)
      } catch (error) {
        log(`could not watch ${file} for changes: ${error}`)
      }
    }
    if (watcherEntry) watcherEntry.users += 1

    return async () => {
      const entry = watchers.get(file)
      if (!entry || typeof entry.users !== "number") return
      entry.users -= 1
      if (entry.users > 0) return
      clearTimeout(entry.watcher.timer)
      entry.watcher.close()
      watchers.delete(file)
    }
  },
}
