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
    ["s1", { location: { directory: workspace }, time: {} }],
    ["s2", { location: { directory: workspace }, time: {} }],
  ])
  const calls = { prompt: [], synthetic: [] }
  const commands = new Map()
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
  }
  const module = await import(`${PLUGIN}?t=${Math.random()}`)
  const cleanup = await module.default.setup(ctx)
  if (typeof cleanup === "function") previousCleanup = cleanup
  const run = async (name, sessionID, text = "") => {
    const definition = commands.get(name)
    if (!definition) throw new Error(`command ${name} is not registered`)
    await definition.execute({ sessionID, prompt: { text }, delivery: "steer" })
  }
  return {
    file,
    dir: path.dirname(file),
    workspace,
    sessions,
    calls,
    commands,
    run,
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
  const names = ["shadow-register", "shadow-register-manual", "shadow-wake", "shadow-wake-manual"]
  check("registers the four commands", names.every((name) => m.commands.has(name)))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  check("register sends the default initial message", m.calls.prompt[0]?.text === "DEFAULT INITIAL")
  check(
    "register binds a session outside a repository to its directory",
    stateOf(m).bindings[path.resolve(m.workspace)]?.sessionID === "s1",
  )
  check("register reports the binding", m.calls.synthetic.at(-1)?.text.includes("registered for"))
  check("register writes a log line", logOf(m).includes("bound s1"))
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
    check("a tilde binding uses the resolved path", stateOf(m).bindings[repo]?.sessionID === "s1")
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
    "a session inside a repository binds to the git root",
    stateOf(m).bindings[path.resolve(repo)]?.sessionID === "s1",
  )
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  await m.run("shadow-register", "s2")
  const bindings = stateOf(m).bindings
  check("a second registration replaces the workspace binding", bindings[path.resolve(m.workspace)]?.sessionID === "s2")
  check("a workspace keeps one binding", Object.keys(bindings).length === 1)
}

{
  const m = await mount(config())
  const other = path.join(tempDir("so-other-"), "workspace")
  mkdirSync(other, { recursive: true })
  m.sessions.set("s3", { location: { directory: other }, time: {} })
  await m.run("shadow-register", "s1")
  await m.run("shadow-register", "s3")
  const bindings = stateOf(m).bindings
  check(
    "register leaves another workspace binding untouched",
    bindings[path.resolve(m.workspace)]?.sessionID === "s1" && bindings[path.resolve(other)]?.sessionID === "s3",
  )
}

{
  const m = await mount(config())
  await m.run("shadow-register-manual", "s1", "   ")
  check("an empty manual registration sends no prompt", m.calls.prompt.length === 0)
  check("an empty manual registration writes no binding", !existsSync(m.stateFile))
  check("an empty manual registration reports the cancellation", m.calls.synthetic.at(-1)?.text.includes("No message entered"))
}

{
  const m = await mount(config())
  await m.run("shadow-register-manual", "s1", "CUSTOM INITIAL")
  check("a manual registration sends the typed message", m.calls.prompt[0]?.text === "CUSTOM INITIAL")
  check("a manual registration binds the session", stateOf(m).bindings[path.resolve(m.workspace)]?.sessionID === "s1")
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("wake sends the default wake message", m.calls.prompt[0]?.text === "DEFAULT WAKE")
  check("wake targets the bound orchestrator", m.calls.prompt[0]?.sessionID === "s1")
  check("wake marks the injected prompt", m.calls.prompt[0]?.metadata?.shadowOrchestrator === true)
  check("wake leaves the invoking session without a prompt", m.calls.prompt.every((call) => call.sessionID === "s1"))
  check("wake reports to the invoking session", m.calls.synthetic.at(-1)?.sessionID === "s2")
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.calls.prompt.length = 0
  await m.run("shadow-wake-manual", "s2", "CUSTOM WAKE")
  check("a manual wake sends the typed message", m.calls.prompt[0]?.text === "CUSTOM WAKE")
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.calls.prompt.length = 0
  await m.run("shadow-wake-manual", "s2", "")
  check("an empty manual wake sends no prompt", m.calls.prompt.length === 0)
  check("an empty manual wake reports the cancellation", m.calls.synthetic.at(-1)?.text.includes("No message entered"))
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
  m.sessions.delete("s1")
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("a stale target sends no wake prompt", m.calls.prompt.length === 0)
  check("a stale target clears the binding", stateOf(m).bindings[path.resolve(m.workspace)] === undefined)
  check("a stale target asks for a registration", m.calls.synthetic.at(-1)?.text.includes("/shadow-register"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  m.sessions.get("s1").time.archived = Date.now()
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
  check("a saved config applies without a restart", m.calls.prompt[0]?.text === "SECOND WAKE", logOf(m))
  check("a config reload writes a log line", logOf(m).includes("config reloaded"))
}

{
  const m = await mount(config())
  await m.run("shadow-register", "s1")
  writeFileSync(m.file, "{ not json")
  await sleep(400)
  m.calls.prompt.length = 0
  await m.run("shadow-wake", "s2")
  check("an invalid config keeps the previous settings", m.calls.prompt[0]?.text === "DEFAULT WAKE")
  check("an invalid config is logged", logOf(m).includes("reload failed"))
}

{
  const first = await mount(config())
  await first.run("shadow-register", "s1")
  const second = await mount(undefined, { file: first.file, workspace: first.workspace })
  await second.run("shadow-wake", "s2")
  check("a binding survives a plugin restart", second.calls.prompt[0]?.sessionID === "s1")
  check("a restarted plugin sends the wake message", second.calls.prompt[0]?.text === "DEFAULT WAKE")
}

{
  const first = await mount(config())
  await first.run("shadow-register", "s1")
  const second = await mount(undefined, { file: first.file, workspace: first.workspace, keepState: true })
  await second.run("shadow-wake", "s2")
  check("two live plugin instances share a binding", second.calls.prompt[0]?.sessionID === "s1")
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
