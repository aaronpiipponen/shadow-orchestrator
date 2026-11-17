// Verify the shadow orchestrator plugin against a mock OpenCode context.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PLUGIN = new URL("../index.js", import.meta.url).href
const STATE = Symbol.for("opencode.shadow-orchestrator.state")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0
function check(name, condition, extra = "") {
  if (condition) {
    passed++
    console.log("ok   " + name)
  } else {
    failed++
    console.log("FAIL " + name + (extra ? "  -> " + extra : ""))
  }
}

const DEFAULTS = {
  initial_message: "DEFAULT INITIAL",
  wake_message: "DEFAULT WAKE",
}

function config(overrides = {}) {
  return {
    logFile: "shadow.log",
    default: { ...DEFAULTS },
    ...overrides,
  }
}

function tempDir(prefix = "so-") {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

let previousCleanup

async function mount(settings, opts = {}) {
  if (previousCleanup) {
    await previousCleanup()
    previousCleanup = undefined
  }
  if (!opts.keepState) delete globalThis[STATE]
  const file = opts.file ?? path.join(tempDir(), "config.json")
  if (!opts.file) writeFileSync(file, JSON.stringify(settings))
  const workspace = opts.workspace ?? path.dirname(file)
  const sessions = new Map([
    ["s1", { location: { directory: workspace }, model: { providerID: "provider", id: "model" }, time: {} }],
    ["s2", { location: { directory: workspace }, model: { providerID: "provider", id: "model" }, time: {} }],
  ])
  const calls = { prompt: [], synthetic: [], create: [] }
  const commands = new Map()
  const rpcMethods = new Map()
  let createdCount = 0
  const ctx = {
    options: { config: file },
    location: { directory: workspace },
    session: {
      get: async ({ sessionID }) => {
        if (opts.get) {
          const result = opts.get(sessionID)
          if (result !== undefined) return result
        }
        const info = sessions.get(sessionID)
        if (!info) throw new Error(`session ${sessionID} not found`)
        return info
      },
      create: async (input) => {
        const id = `ses_new_${++createdCount}`
        const info = {
          id,
          location: { directory: input.location?.directory ?? workspace },
          model: input.model,
          time: {},
        }
        sessions.set(id, info)
        calls.create.push(input)
        return info
      },
      prompt: async (input) => {
        calls.prompt.push(input)
      },
      synthetic: async (input) => {
        calls.synthetic.push(input)
      },
    },
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => commands.set(definition.name, definition) })
        return { dispose: async () => {} }
      },
    },
    rpc: {
      register: async (_contract, methods) => {
        for (const [name, handler] of Object.entries(methods)) rpcMethods.set(name, handler)
        return { dispose: async () => {} }
      },
    },
  }
  const module = await import(`${PLUGIN}?t=${Math.random()}`)
  const cleanup = await module.default.setup(ctx)
  if (typeof cleanup === "function") previousCleanup = cleanup
  const run = async (name, sessionID, text = "") => {
    const definition = commands.get(name)
    if (!definition) throw new Error(`command ${name} is not registered`)
    await definition.execute({ sessionID, prompt: { text }, delivery: "steer" })
  }
  const callRpc = async (name, input) => {
    const handler = rpcMethods.get(name)
    if (!handler) throw new Error(`method ${name} is not registered`)
    return handler(input)
  }
  return {
    file,
    dir: path.dirname(file),
    workspace,
    sessions,
    calls,
    commands,
    rpcMethods,
    run,
    callRpc,
    stateFile: path.join(path.dirname(file), "state.json"),
    logFile: path.join(path.dirname(file), "shadow.log"),
  }
}

function stateOf(m) {
  return JSON.parse(readFileSync(m.stateFile, "utf8"))
}

function logOf(m) {
  try {
    return readFileSync(m.logFile, "utf8")
  } catch {
    return ""
  }
}

for (const [name, settings] of [
  ["a config without a default object", {}],
  ["a config without an initial message", { default: { wake_message: "W" } }],
  ["a config with an empty initial message", { default: { initial_message: " ", wake_message: "W" } }],
  ["a config without a wake message", { default: { initial_message: "I" } }],
  ["a repository entry that is not an object", { default: DEFAULTS, repositories: { "/tmp/x": "text" } }],
  ["a repository entry with an empty message", { default: DEFAULTS, repositories: { "/tmp/x": { wake_message: "" } } }],
  ["a log file that is not a string", { logFile: 5, default: DEFAULTS }],
  ["a paths alias that is not an object", { default: DEFAULTS, paths: [] }],
]) {
  let threw = false
  try {
    await mount(settings)
  } catch {
    threw = true
  }
  check(`rejects ${name}`, threw)
}

{
  const m = await mount(config())
  const names = ["shadow-register", "shadow-wake"]
  check("registers the two automatic commands", names.every((name) => m.commands.has(name)))
  check("registers the two manual methods", ["registerManual", "wakeManual"].every((name) => m.rpcMethods.has(name)))
  check(
    "registers no manual command name",
    !m.commands.has("shadow-register-manual") && !m.commands.has("shadow-wake-manual"),
  )
}

{
  const m = await mount(config())
  m.sessions.get("s1").model = { providerID: "provider", id: "chosen-model" }
  await m.run("shadow-register", "s1")
  const binding = stateOf(m).bindings[path.resolve(m.workspace)]
  const created = m.calls.create[0]
  check("register starts one session", m.calls.create.length === 1)
  check("register starts the session in the workspace", path.resolve(created?.location?.directory) === path.resolve(m.workspace))
  check("register passes the invoking model", created?.model?.id === "chosen-model")
  check("register binds the started session", binding?.sessionID === "ses_new_1")
  check("register leaves the invoking session unbound", binding?.sessionID !== "s1")
  check(
    "register sends the default initial message to the started session",
    m.calls.prompt[0]?.sessionID === "ses_new_1" && m.calls.prompt[0]?.text === "DEFAULT INITIAL",
  )
  check(
    "register reports the started session to the invoking session",
    m.calls.synthetic.at(-1)?.sessionID === "s1" && m.calls.synthetic.at(-1)?.text.includes("ses_new_1"),
  )
  check("register writes a log line", logOf(m).includes("started ses_new_1"))
}

{
  const root = tempDir("so-tree-")
  const parent = path.join(root, "projects")
  const child = path.join(parent, "repo")
  mkdirSync(child, { recursive: true })
  const file = path.join(root, "config.json")
  writeFileSync(
    file,
    JSON.stringify(
      config({
        repositories: {
          [parent]: { initial_message: "PARENT INITIAL", wake_message: "PARENT WAKE" },
          [child]: { initial_message: "CHILD INITIAL", wake_message: "CHILD WAKE" },
        },
      }),
    ),
  )
  const m = await mount(undefined, { file, workspace: child })
  await m.run("shadow-register", "s1")
  check("longest prefix selects the child entry", m.calls.prompt[0]?.text === "CHILD INITIAL")
  await m.run("shadow-wake", "s2")
  check("wake uses the child wake message", m.calls.prompt[1]?.text === "CHILD WAKE")
}

{
  const root = tempDir("so-merge-")
  const firstWorkspace = path.join(root, "a")
  const secondWorkspace = path.join(root, "b")
  mkdirSync(firstWorkspace)
  mkdirSync(secondWorkspace)
  const file = path.join(root, "config.json")
  writeFileSync(
    file,
    JSON.stringify(
      config({
        repositories: {
          [firstWorkspace]: { initial_message: "A INITIAL" },
          [secondWorkspace]: { wake_message: "B WAKE" },
        },
      }),
    ),
  )
  const first = await mount(undefined, { file, workspace: firstWorkspace })
  await first.run("shadow-register", "s1")
  await first.run("shadow-wake", "s2")
  check("a partial entry keeps the default wake message", first.calls.prompt[1]?.text === "DEFAULT WAKE")
  const second = await mount(undefined, { file, workspace: secondWorkspace })
  await second.run("shadow-register", "s1")
  await second.run("shadow-wake", "s2")
  check("a partial entry keeps the default initial message", second.calls.prompt[0]?.text === "DEFAULT INITIAL")
  check("a partial entry overrides the wake message", second.calls.prompt[1]?.text === "B WAKE")
}

{
  const home = tempDir("so-home-")
  const repo = path.join(home, "projects", "repo")
  mkdirSync(repo, { recursive: true })
  const file = path.join(tempDir("so-cfg-"), "config.json")
  writeFileSync(file, JSON.stringify(config({ repositories: { "~/projects/repo": { initial_message: "TILDE INITIAL" } } })))
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    const m = await mount(undefined, { file, workspace: repo })
    await m.run("shadow-register", "s1")
    check("a tilde expands to the home directory", m.calls.prompt[0]?.text === "TILDE INITIAL")
    check("a tilde binding uses the resolved path", stateOf(m).bindings[repo]?.sessionID === "ses_new_1")
  } finally {
    process.env.HOME = previous
  }
}

{
  const repo = tempDir("so-git-")
  execFileSync("git", ["init", "-q"], { cwd: repo })
  const nested = path.join(repo, "nested")
  mkdirSync(nested)
  const m = await mount(config(), { workspace: nested })
  await m.run("shadow-register", "s1")
  check(
    "a session inside a repository binds the git root",
    stateOf(m).bindings[path.resolve(repo)]?.sessionID === "ses_new_1",
  )
  check("the orchestrator session starts in the invoking directory", path.resolve(m.calls.create[0]?.location?.directory) === path.resolve(nested))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  await m.run("shadow-register", "s1")
  const bindings = stateOf(m).bindings
  check("a second registration replaces the workspace binding", bindings[path.resolve(m.workspace)]?.sessionID === "ses_new_2")
  check("a workspace keeps one binding", Object.keys(bindings).length === 1)
}

{
  const m = await mount(config())
  const other = path.join(tempDir("so-other-"), "workspace")
  mkdirSync(other, { recursive: true })
  m.sessions.set("s3", { location: { directory: other }, model: { providerID: "provider", id: "model" }, time: {} })
  await m.run("shadow-register", "s1")
  await m.run("shadow-register", "s3")
  const bindings = stateOf(m).bindings
  check(
    "register leaves another workspace binding untouched",
    bindings[path.resolve(m.workspace)]?.sessionID === "ses_new_1" && bindings[path.resolve(other)]?.sessionID === "ses_new_2",
  )
}

{
  const m = await mount(config())
  const result = await m.callRpc("registerManual", { directory: m.workspace, text: "CUSTOM INITIAL" })
  check("a manual registration starts a session", m.calls.create.length === 1)
  check("a manual registration returns the started session", result.sessionID === "ses_new_1")
  check("a manual registration sends the typed message", m.calls.prompt[0]?.text === "CUSTOM INITIAL")
  check(
    "a manual registration binds the started session",
    stateOf(m).bindings[path.resolve(m.workspace)]?.sessionID === "ses_new_1",
  )
  check("a manual registration reports the start", result.message.includes("started for"))
}

{
  const m = await mount(config())
  m.sessions.get("s1").model = { providerID: "provider", id: "session-model" }
  const result = await m.callRpc("registerManual", { sessionID: "s1", text: "CUSTOM" })
  check("a manual registration uses the invoking model", m.calls.create[0]?.model?.id === "session-model")
  check("a manual registration starts in the invoking directory", path.resolve(m.calls.create[0]?.location?.directory) === path.resolve(m.workspace))
  check("a manual registration returns the session ID", result.sessionID === "ses_new_1")
}

{
  const m = await mount(config())
  const result = await m.callRpc("registerManual", { directory: m.workspace, text: "   " })
  check("an empty manual registration starts no session", m.calls.create.length === 0)
  check("an empty manual registration writes no binding", !existsSync(m.stateFile))
  check("an empty manual registration returns no session", result.sessionID === "")
  check("an empty manual registration reports the cancellation", result.message.includes("No message entered"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("wake sends the default wake message", m.calls.prompt[0]?.text === "DEFAULT WAKE")
  check("wake targets the started orchestrator", m.calls.prompt[0]?.sessionID === "ses_new_1")
  check("wake marks the injected prompt", m.calls.prompt[0]?.metadata?.shadowOrchestrator === true)
  check("wake leaves the invoking session without a prompt", m.calls.prompt.every((call) => call.sessionID === "ses_new_1"))
  check("wake reports to the invoking session", m.calls.synthetic.at(-1)?.sessionID === "s2")
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.calls.prompt.length = 0
  const result = await m.callRpc("wakeManual", { directory: m.workspace, text: "CUSTOM WAKE" })
  check("a manual wake sends the typed message", m.calls.prompt[0]?.text === "CUSTOM WAKE")
  check("a manual wake reports the wake", result.message.includes("woken"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.calls.prompt.length = 0
  const result = await m.callRpc("wakeManual", { directory: m.workspace, text: "" })
  check("an empty manual wake sends no prompt", m.calls.prompt.length === 0)
  check("an empty manual wake reports the cancellation", result.message.includes("No message entered"))
}

{
  const m = await mount(config())
  await m.run("shadow-wake", "s1")
  check("a wake without a binding sends no prompt", m.calls.prompt.length === 0)
  check("a wake without a binding names the workspace", m.calls.synthetic.at(-1)?.text.includes(path.resolve(m.workspace)))
  check("a wake without a binding asks for a registration", m.calls.synthetic.at(-1)?.text.includes("/shadow-register"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.sessions.delete("ses_new_1")
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("a stale target sends no wake prompt", m.calls.prompt.length === 0)
  check("a stale target clears the binding", stateOf(m).bindings[path.resolve(m.workspace)] === undefined)
  check("a stale target asks for a registration", m.calls.synthetic.at(-1)?.text.includes("/shadow-register"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.sessions.get("ses_new_1").time.archived = Date.now()
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("an archived target sends no wake prompt", m.calls.prompt.length === 0)
  check("an archived target clears the binding", stateOf(m).bindings[path.resolve(m.workspace)] === undefined)
  check("an archived target reports the archive", m.calls.synthetic.at(-1)?.text.includes("archived"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  writeFileSync(
    m.file,
    JSON.stringify(config({ default: { initial_message: "DEFAULT INITIAL", wake_message: "SECOND WAKE" } })),
  )
  await sleep(600)
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("a saved config applies without a restart", m.calls.prompt[0]?.text === "SECOND WAKE")
  check("a config reload writes a log line", logOf(m).includes("config reloaded"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  writeFileSync(m.file, "{ not json")
  await sleep(400)
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("an invalid config leaves the active settings in place", m.calls.prompt[0]?.text === "DEFAULT WAKE")
  check("an invalid config is logged", logOf(m).includes("reload failed"))
}

{
  const first = await mount(config())
  await first.run("shadow-register", "s1")
  const bound = stateOf(first).bindings[path.resolve(first.workspace)].sessionID
  const second = await mount(undefined, { file: first.file, workspace: first.workspace })
  second.sessions.set(bound, { location: { directory: first.workspace }, time: {} })
  await second.run("shadow-wake", "s2")
  check("a restarted plugin reads the saved binding", second.calls.prompt[0]?.sessionID === bound)
  check("a restarted plugin sends the wake message", second.calls.prompt[0]?.text === "DEFAULT WAKE")
}

{
  const first = await mount(config())
  await first.run("shadow-register", "s1")
  const bound = stateOf(first).bindings[path.resolve(first.workspace)].sessionID
  const second = await mount(undefined, { file: first.file, workspace: first.workspace, keepState: true })
  second.sessions.set(bound, { location: { directory: first.workspace }, time: {} })
  await second.run("shadow-wake", "s2")
  check("two live plugin instances share a binding", second.calls.prompt[0]?.sessionID === bound)
}

{
  const root = tempDir("so-paths-")
  const file = path.join(root, "config.json")
  writeFileSync(file, JSON.stringify(config({ paths: { [root]: { initial_message: "PATHS INITIAL" } } })))
  const m = await mount(undefined, { file, workspace: root })
  await m.run("shadow-register", "s1")
  check("the paths alias provides repository entries", m.calls.prompt[0]?.text === "PATHS INITIAL")
}

{
  const root = tempDir("so-alias-")
  const file = path.join(root, "config.json")
  writeFileSync(
    file,
    JSON.stringify(
      config({
        paths: { [root]: { initial_message: "PATHS INITIAL" } },
        repositories: { [root]: { initial_message: "REPOS INITIAL" } },
      }),
    ),
  )
  const m = await mount(undefined, { file, workspace: root })
  await m.run("shadow-register", "s1")
  check("repositories wins over the paths alias", m.calls.prompt[0]?.text === "REPOS INITIAL")
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
