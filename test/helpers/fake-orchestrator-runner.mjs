// A fake `claude` executable for the orchestrator run of spec 025
// (implementation plan, WS0 step 2; task T002).
//
// `installFakeOrchestratorRunner(dir)` writes three things into `dir`:
//
//   claude          the executable. A test puts its path in
//                   `orchestrator.runner`, or puts `dir` first on `PATH`.
//   control.json    how the next run behaves (optional; see below).
//   record.jsonl    one JSON line for each run, appended by the executable.
//
// The executable is a CommonJS Node script whose first line names this
// Node by absolute path. It adds no environment variable and no argument of
// its own, so the record shows exactly what the runner passed. It needs a
// Node path with no whitespace in it, and it is for macOS and Linux only:
// tests that use it are skipped on Windows.
//
// A run does this, in order:
//
//   1. Reads all of standard input (the runner closes it).
//   2. Appends a record: `argv` (arguments after the executable), `cwd`,
//      `cwdListing` (sorted names in the working directory, read at start),
//      `envNames` (sorted names only, never values, without the names Node
//      adds to itself at startup), `stdin`, and `pid`.
//   3. Writes the first stream event, then waits `delayMs`.
//   4. Writes an assistant event, a rate limit event, and a result event with the reply text,
//      writes `stderr`, and exits with `exitCode`. With `neverExit` it stays
//      alive after step 3 until it is signalled.
//
// Control file (all keys optional):
//
//   firstEvent  an object written as one JSON line, as it is; a string
//               written as a raw line (an unreadable event); null for none.
//               Default: DEFAULT_FIRST_EVENT with `cwd` set to the run's
//               working directory.
//   reply       the reply text; null writes none of those three events.
//               Default "OK".
//   exitCode    default 0.
//   stderr      text written to standard error. Default "".
//   delayMs     milliseconds between the first event and the rest. Default 0.
//   neverExit   stay alive after the first event until signalled.
//   ignoreTerm  ignore SIGTERM, for tests of the SIGKILL that follows it.
//   rateLimitFirst  write the rate limit event before the assistant event
//               instead of after it; real runs do both.
//   raw         write this text to standard output instead of a stream, then
//               exit with `exitCode` (for `claude --version`).
//   runs       a list of controls: the Nth run (counted from the records
//               already written) follows the Nth, later runs the last. Runs
//               are counted at start, so give concurrent runs one control.
//
// The stream shape. The default stream has the field names of the real run
// of the amended `claude` profile (CLI 2.1.274, with
// `--disable-slash-commands`), stored as `profileProbe` in
// `test/fixtures/claude-stream/profile-probe.json`: a `system`/`init` event
// first, then an `assistant` event, a `rate_limit_event`, and a `result`
// event. Real runs put the rate limit event before or after the assistant
// event, so a reader finds events by type. The values are fake. A test
// checks the names against the fixture, so a new probe that changes them
// fails that test until this file follows.

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const FAKE_ORCHESTRATOR_RUNNER_PATH = fileURLToPath(import.meta.url)

const CONTROL_KEYS = new Set([
  "firstEvent",
  "reply",
  "exitCode",
  "stderr",
  "delayMs",
  "neverExit",
  "ignoreTerm",
  "rateLimitFirst",
  "raw",
  "runs",
])

/** The four built-in agents the amended FR-15 check requires, exactly. */
export const BUILT_IN_AGENTS = Object.freeze(["claude", "Explore", "general-purpose", "Plan"])

// Names Node adds to its own environment as it starts, so they are not what
// the runner passed. On macOS, CoreFoundation sets `__CF_USER_TEXT_ENCODING`
// in every Node process, even one started with an explicit environment.
const NODE_STARTUP_ENV_NAMES = new Set(["__CF_USER_TEXT_ENCODING"])

const FAKE_SESSION_ID = "00000000-0000-4000-8000-000000000000"
const FAKE_MODEL = "claude-fake-model"

const FAKE_UUID = "00000000-0000-4000-8000-000000000001"
const FAKE_VERSION = "0.0.0-fake"

/**
 * The first event of a run that passes the amended spec 025 FR-15 check: no
 * tools, no MCP servers, the subscription login as the credential source
 * (`apiKeySource: "none"`), no skills, no slash commands, and exactly the
 * four built-in agents, as the profile probe reported.
 */
export const DEFAULT_FIRST_EVENT = deepFreeze({
  type: "system",
  subtype: "init",
  cwd: "",
  session_id: FAKE_SESSION_ID,
  tools: [],
  mcp_servers: [],
  model: FAKE_MODEL,
  permissionMode: "default",
  slash_commands: [],
  apiKeySource: "none",
  claude_code_version: FAKE_VERSION,
  output_style: "default",
  agents: [...BUILT_IN_AGENTS],
  skills: [],
  plugins: [],
  capabilities: [],
  analytics_disabled: true,
  product_feedback_disabled: true,
  fast_mode_state: "off",
  fast_mode_disabled_reason: null,
  messaging_socket_path: null,
  uuid: FAKE_UUID,
})

function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value && typeof value === "object") deepFreeze(value)
  }
  return Object.freeze(object)
}

/** The default first event with some fields replaced, for a failing check. */
export function firstEventWith(overrides) {
  return { ...structuredClone(DEFAULT_FIRST_EVENT), ...overrides }
}

// ---------------------------------------------------------------------------
// Helpers for tests (imported, not run)
// ---------------------------------------------------------------------------

/**
 * Write the executable into `dir`. Returns `{ dir, executable, controlPath,
 * recordPath }`; pass the object to the other helpers.
 */
export async function installFakeOrchestratorRunner(dir) {
  if (/\s/.test(process.execPath)) {
    throw new Error(`the fake orchestrator runner needs a Node path with no whitespace: ${process.execPath}`)
  }
  await fsp.mkdir(dir, { recursive: true })
  const runner = {
    dir,
    executable: path.join(dir, "claude"),
    controlPath: path.join(dir, "control.json"),
    recordPath: path.join(dir, "record.jsonl"),
  }
  const moduleUrl = pathToFileURL(FAKE_ORCHESTRATOR_RUNNER_PATH).href
  const script = [
    `#!${process.execPath}`,
    `import(${JSON.stringify(moduleUrl)})`,
    `  .then((m) => m.runFakeOrchestrator(__dirname))`,
    `  .catch((error) => { process.stderr.write(String(error && error.stack || error) + "\\n"); process.exit(70) })`,
    "",
  ].join("\n")
  await fsp.writeFile(runner.executable, script, "utf8")
  await fsp.chmod(runner.executable, 0o755)
  return runner
}

/** Write the control file. Throws on a key the fake does not know. */
export async function writeFakeOrchestratorControl(runner, control) {
  checkControl(control)
  for (const run of control.runs ?? []) checkControl(run)
  await fsp.writeFile(runner.controlPath, `${JSON.stringify(control, null, 2)}\n`, "utf8")
}

/** The records of every run so far, oldest first. */
export async function readFakeOrchestratorRecords(runner) {
  let text = ""
  try {
    text = await fsp.readFile(runner.recordPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function checkControl(control) {
  if (!control || typeof control !== "object" || Array.isArray(control)) {
    throw new Error("the control must be an object")
  }
  for (const key of Object.keys(control)) {
    if (!CONTROL_KEYS.has(key)) throw new Error(`unknown control key: ${key}`)
  }
}

// ---------------------------------------------------------------------------
// The executable (run by the script `installFakeOrchestratorRunner` writes)
// ---------------------------------------------------------------------------

export async function runFakeOrchestrator(dir) {
  const cwd = process.cwd()
  const cwdListing = fs.readdirSync(cwd).sort()
  const recordPath = path.join(dir, "record.jsonl")
  const control = controlForRun(readControl(path.join(dir, "control.json")), countRecords(recordPath))

  if (control.ignoreTerm) process.on("SIGTERM", () => {})

  const stdin = await readStdin()
  const record = {
    argv: process.argv.slice(2),
    cwd,
    cwdListing,
    envNames: Object.keys(process.env)
      .filter((name) => !NODE_STARTUP_ENV_NAMES.has(name))
      .sort(),
    stdin,
    pid: process.pid,
  }
  fs.appendFileSync(recordPath, `${JSON.stringify(record)}\n`)

  if (typeof control.raw === "string") {
    await new Promise((resolve) => process.stdout.write(control.raw, resolve))
    process.exit(Number.isInteger(control.exitCode) ? control.exitCode : 0)
  }

  const firstEvent = Object.hasOwn(control, "firstEvent") ? control.firstEvent : { ...DEFAULT_FIRST_EVENT, cwd }
  if (typeof firstEvent === "string") await writeLine(firstEvent)
  else if (firstEvent !== null) await writeLine(JSON.stringify(firstEvent))

  if (control.neverExit) {
    setInterval(() => {}, 60_000)
    return
  }
  if (control.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, control.delayMs))

  const reply = Object.hasOwn(control, "reply") ? control.reply : "OK"
  if (reply !== null) {
    const middle = [assistantEvent(String(reply)), rateLimitEvent()]
    if (control.rateLimitFirst) middle.reverse()
    for (const event of middle) await writeLine(JSON.stringify(event))
    await writeLine(JSON.stringify(resultEvent(String(reply))))
  }
  if (control.stderr) await new Promise((resolve) => process.stderr.write(String(control.stderr), resolve))
  process.exit(Number.isInteger(control.exitCode) ? control.exitCode : 0)
}

function readControl(controlPath) {
  try {
    return JSON.parse(fs.readFileSync(controlPath, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return {}
    throw error
  }
}

function controlForRun(control, runIndex) {
  if (!Array.isArray(control.runs) || control.runs.length === 0) return control
  return control.runs[Math.min(runIndex, control.runs.length - 1)]
}

function countRecords(recordPath) {
  try {
    return fs.readFileSync(recordPath, "utf8").split("\n").filter(Boolean).length
  } catch (error) {
    if (error.code === "ENOENT") return 0
    throw error
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => {
      text += chunk
    })
    process.stdin.on("end", () => resolve(text))
    process.stdin.on("error", reject)
  })
}

function writeLine(line) {
  return new Promise((resolve) => process.stdout.write(`${line}\n`, resolve))
}

const FAKE_USAGE = { input_tokens: 0, output_tokens: 0 }

function assistantEvent(text) {
  return {
    type: "assistant",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: FAKE_MODEL,
      content: [{ type: "text", text }],
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: FAKE_USAGE,
    },
    parent_tool_use_id: null,
    request_id: "req_fake",
    session_id: FAKE_SESSION_ID,
    timestamp: new Date(0).toISOString(),
    uuid: FAKE_UUID,
  }
}

function rateLimitEvent() {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 0,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: null,
      isUsingOverage: false,
      unifiedWindows: {},
    },
    session_id: FAKE_SESSION_ID,
    uuid: FAKE_UUID,
  }
}

function resultEvent(text) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 0,
    duration_api_ms: 0,
    first_content_frame_ms: 0,
    time_to_request_ms: 0,
    ttft_ms: 0,
    ttft_stream_ms: 0,
    num_turns: 1,
    result: text,
    result_index: 0,
    stop_reason: "end_turn",
    terminal_reason: null,
    permission_denials: [],
    queued_turn_count: 0,
    subagent_stats: null,
    fast_mode_state: "off",
    fast_mode_disabled_reason: null,
    total_cost_usd: 0,
    usage: FAKE_USAGE,
    modelUsage: {},
    session_id: FAKE_SESSION_ID,
    uuid: FAKE_UUID,
  }
}
