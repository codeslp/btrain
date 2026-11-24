#!/usr/bin/env node
// A fake agent runner for spec 023 tests (implementation plan, WS0).
//
// A test names it in `[agents.runners]` through a shim with the executable
// basename it wants: a shim called `codex` gets the `openai` lab from the
// runner table, one called `claude` gets `anthropic`, and one called `agent`
// gets none. `installFakeRunner` writes the shim. btrain then starts it the way
// it starts a real runner, with whatever arguments it normalizes in. The fake
// ignores those arguments, records them, and follows a scenario file.
//
// Scenario file (JSON), selected by `FAKE_RUNNER_SCENARIO`:
//
//   { "agents": { "<agent>": <plan> }, "default": <plan> }
//
// The agent is `BTRAIN_AGENT`, which btrain sets for every runner it starts.
// A plan is a list of steps, or `{ "invocations": [<steps>, <steps>, ...] }`
// where the Nth start of that agent follows the Nth list and later starts
// follow the last one.
//
// Steps run in order. Each may carry `at` (milliseconds since start, waits
// until then) or `after` (milliseconds after the previous step):
//
//   { "do": "handoff" }                         run `btrain handoff --lane <lane>`
//   { "do": "print", "text": "...", "stream": "stdout"|"stderr" }
//   { "do": "silent", "ms": 1000 }              stay alive with no output; no ms: until killed
//   { "do": "commit", "file": "src/x.mjs", "content": "...", "message": "...",
//     "trailer": true, "noVerify": false }      commit with or without `Btrain-Agent: <agent>`
//   { "do": "resolve", "summary": "..." }       `btrain handoff resolve --lane <lane> --actor <agent>`
//   { "do": "request-changes", "summary": "...", "reasonCode": "spec-mismatch" }
//   { "do": "fix", "summary": "..." }           `btrain handoff fix --lane <lane> --actor <agent>`
//   { "do": "btrain", "args": [...] }           any btrain command
//
// `handoff`, `resolve`, `request-changes`, and `fix` add `--lane <BTRAIN_LANE>`.
// With no `BTRAIN_LANE` they fail (exit 64) instead of running without a lane,
// unless the step has `"noLane": true` (a repository without lanes).
//   { "do": "exit", "code": 1, "text": "...", "stream": "stderr" }
//
// With no `exit` step the fake exits 0 after its last step. A btrain step that
// fails is logged and does not stop the scenario unless it has `"stopOnError": true`.
// `"ignoreTerm": true` on the plan's step list (as `{ "ignoreTerm": true, "steps": [...] }`)
// makes the fake ignore SIGTERM, for tests of process-group termination.
//
// Every start and every step is appended to `FAKE_RUNNER_LOG` (JSON lines), so
// a test can read who was started, with which arguments and environment, and
// what each step did. `readFakeRunnerLog` parses it.
//
// The btrain CLI is `BTRAIN_CLI` when set, else this repository's cli.mjs.

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FAKE_RUNNER_PATH = fileURLToPath(import.meta.url)
export const DEFAULT_BTRAIN_CLI = path.resolve(HERE, "../../src/brain_train/cli.mjs")

// The environment keys a log entry records. The full environment is not
// logged: a test that needs one key asks for it through `FAKE_RUNNER_ENV_KEYS`.
const LOGGED_ENV_KEYS = [
  "BTRAIN_AGENT",
  "BRAIN_TRAIN_AGENT",
  "BTRAIN_LANE",
  "BTRAIN_LANE_LOCKED",
  "BTRAIN_REPO",
  "BTRAIN_LOOP_ACTIVE",
]

// ---------------------------------------------------------------------------
// Helpers for tests (imported, not run)
// ---------------------------------------------------------------------------

/**
 * Write an executable shim named `name` (default `codex`) into `dir` that runs
 * this fake with the current node. Returns the shim's absolute path, which a
 * test puts in `[agents.runners]`.
 */
export async function installFakeRunner(dir, name = "codex") {
  await fsp.mkdir(dir, { recursive: true })
  const shimPath = path.join(dir, name)
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
  await fsp.writeFile(
    shimPath,
    `#!/bin/sh\nFAKE_RUNNER_SHIM=${quote(name)} exec ${quote(process.execPath)} ${quote(FAKE_RUNNER_PATH)} "$@"\n`,
    "utf8",
  )
  await fsp.chmod(shimPath, 0o755)
  return shimPath
}

/** Write a scenario file. Returns its path. */
export async function writeFakeRunnerScenario(filePath, scenario) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8")
  return filePath
}

/** The environment a btrain process needs so the runners it starts use the scenario and the log. */
export function fakeRunnerEnv({ scenarioPath, logPath, cliPath = DEFAULT_BTRAIN_CLI, envKeys = [] }) {
  return {
    FAKE_RUNNER_SCENARIO: scenarioPath,
    FAKE_RUNNER_LOG: logPath,
    BTRAIN_CLI: cliPath,
    ...(envKeys.length > 0 ? { FAKE_RUNNER_ENV_KEYS: envKeys.join(",") } : {}),
  }
}

/** Parse the log: one object per line, `kind` is `start`, `step`, or `exit`. */
export async function readFakeRunnerLog(logPath) {
  let text = ""
  try {
    text = await fsp.readFile(logPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

/** The `start` entries of the log, optionally for one agent. */
export async function readFakeRunnerStarts(logPath, agent = "") {
  const entries = await readFakeRunnerLog(logPath)
  return entries.filter((entry) => entry.kind === "start" && (!agent || entry.agent === agent))
}

/** Pick the steps for the Nth start (0-based) of an agent from a scenario. */
export function selectFakeRunnerPlan(scenario, agent, invocation) {
  const agents = scenario?.agents && typeof scenario.agents === "object" ? scenario.agents : {}
  const plan = Object.hasOwn(agents, agent) ? agents[agent] : scenario?.default
  if (!plan) {
    return { steps: [], ignoreTerm: false }
  }
  if (Array.isArray(plan)) {
    return { steps: plan, ignoreTerm: false }
  }
  if (Array.isArray(plan.invocations) && plan.invocations.length > 0) {
    const index = Math.min(invocation, plan.invocations.length - 1)
    const chosen = plan.invocations[index]
    return Array.isArray(chosen)
      ? { steps: chosen, ignoreTerm: Boolean(plan.ignoreTerm) }
      : { steps: chosen?.steps || [], ignoreTerm: Boolean(chosen?.ignoreTerm ?? plan.ignoreTerm) }
  }
  return { steps: Array.isArray(plan.steps) ? plan.steps : [], ignoreTerm: Boolean(plan.ignoreTerm) }
}

// ---------------------------------------------------------------------------
// The runner (only when executed)
// ---------------------------------------------------------------------------

function appendLog(logPath, entry) {
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...entry })}\n`)
}

function countEarlierStarts(logPath, agent) {
  if (!logPath || !fs.existsSync(logPath)) return 0
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry?.kind === "start" && entry.agent === agent).length
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

function runBtrain(args, { cwd, env }) {
  const cli = env.BTRAIN_CLI || DEFAULT_BTRAIN_CLI
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" })
  return { code: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" }
}

function git(args, { cwd, env }) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

const LANE_SCOPED_STEPS = new Set(["handoff", "resolve", "request-changes", "fix"])

function btrainArgsFor(step, { agent, lane }) {
  const laneArgs = lane ? ["--lane", lane] : []
  switch (step.do) {
    case "handoff":
      return ["handoff", ...laneArgs]
    case "resolve":
      return ["handoff", "resolve", ...laneArgs, "--summary", step.summary || "Looks good", "--actor", agent]
    case "request-changes":
      return [
        "handoff", "request-changes", ...laneArgs,
        "--summary", step.summary || "Needs a change",
        "--reason-code", step.reasonCode || "spec-mismatch",
        "--actor", agent,
      ]
    case "fix":
      return ["handoff", "fix", ...laneArgs, "--summary", step.summary || "Applied a small fix", "--actor", agent]
    case "btrain":
      return Array.isArray(step.args) ? step.args.map(String) : []
    default:
      return null
  }
}

async function runStep(step, context) {
  const { agent, lane, cwd, env, logPath } = context
  const write = (stream, text) => {
    const line = String(text ?? "")
    ;(stream === "stderr" ? process.stderr : process.stdout).write(line.endsWith("\n") ? line : `${line}\n`)
  }

  if (step.do === "print") {
    write(step.stream, step.text)
    appendLog(logPath, { kind: "step", agent, do: "print", stream: step.stream || "stdout", text: step.text })
    return { stop: false }
  }

  if (step.do === "silent") {
    appendLog(logPath, { kind: "step", agent, do: "silent", ms: step.ms ?? null })
    if (typeof step.ms === "number") {
      await sleep(step.ms)
      return { stop: false }
    }
    // A pending promise alone does not keep node alive; a timer does.
    setInterval(() => {}, 60_000)
    await new Promise(() => {})
  }

  if (step.do === "exit") {
    if (step.text) write(step.stream || "stderr", step.text)
    appendLog(logPath, { kind: "exit", agent, code: step.code ?? 0, reason: "scenario" })
    return { stop: true, code: Number(step.code ?? 0) }
  }

  if (step.do === "commit") {
    const file = step.file || "fake-runner-change.txt"
    const filePath = path.resolve(cwd, file)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, step.content ?? `change by ${agent} at ${new Date().toISOString()}\n`, "utf8")
    git(["add", "--", file], { cwd, env })
    const message = step.message || `Change ${file}`
    const withTrailer = step.trailer !== false
    const fullMessage = withTrailer ? `${message}\n\nBtrain-Agent: ${agent}` : message
    git(["commit", ...(step.noVerify ? ["--no-verify"] : []), "-q", "-m", fullMessage], { cwd, env })
    const head = git(["rev-parse", "HEAD"], { cwd, env })
    appendLog(logPath, { kind: "step", agent, do: "commit", file, trailer: withTrailer, noVerify: Boolean(step.noVerify), head })
    return { stop: false }
  }

  if (LANE_SCOPED_STEPS.has(step.do) && !lane && !step.noLane) {
    appendLog(logPath, { kind: "exit", agent, code: 64, reason: `${step.do} needs BTRAIN_LANE` })
    process.stderr.write(`fake-runner: step ${step.do} needs BTRAIN_LANE (or "noLane": true)\n`)
    return { stop: true, code: 64 }
  }

  const args = btrainArgsFor(step, { agent, lane })
  if (args) {
    const result = runBtrain(args, { cwd, env })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    appendLog(logPath, { kind: "step", agent, do: step.do, args, code: result.code, stdout: result.stdout, stderr: result.stderr })
    if (result.code !== 0 && step.stopOnError) {
      appendLog(logPath, { kind: "exit", agent, code: result.code, reason: "btrain-failed" })
      return { stop: true, code: result.code }
    }
    return { stop: false }
  }

  appendLog(logPath, { kind: "step", agent, do: String(step.do), error: "unknown step" })
  return { stop: true, code: 64 }
}

async function main() {
  const env = { ...process.env }
  const agent = env.BTRAIN_AGENT || env.BRAIN_TRAIN_AGENT || ""
  const lane = env.BTRAIN_LANE || ""
  const logPath = env.FAKE_RUNNER_LOG || ""
  const cwd = process.cwd()

  const extraKeys = (env.FAKE_RUNNER_ENV_KEYS || "").split(",").map((key) => key.trim()).filter(Boolean)
  const loggedEnv = {}
  for (const key of [...LOGGED_ENV_KEYS, ...extraKeys]) {
    if (key in env) loggedEnv[key] = env[key]
  }

  const invocation = countEarlierStarts(logPath, agent)
  appendLog(logPath, {
    kind: "start",
    agent,
    lane,
    invocation,
    executable: env.FAKE_RUNNER_SHIM || "",
    argv: process.argv.slice(2),
    cwd,
    env: loggedEnv,
    envKeys: Object.keys(env).sort(),
  })

  let scenario = {}
  if (env.FAKE_RUNNER_SCENARIO) {
    scenario = JSON.parse(fs.readFileSync(env.FAKE_RUNNER_SCENARIO, "utf8"))
  }
  const { steps, ignoreTerm } = selectFakeRunnerPlan(scenario, agent, invocation)

  process.on("SIGTERM", () => {
    if (ignoreTerm) {
      appendLog(logPath, { kind: "step", agent, do: "signal", signal: "SIGTERM", ignored: true })
      return
    }
    appendLog(logPath, { kind: "exit", agent, code: null, reason: "SIGTERM" })
    process.exit(143)
  })

  const startedAt = Date.now()
  let previousAt = startedAt
  for (const step of steps) {
    if (typeof step.at === "number") {
      await sleep(startedAt + step.at - Date.now())
    } else if (typeof step.after === "number") {
      await sleep(previousAt + step.after - Date.now())
    }
    previousAt = Date.now()
    const outcome = await runStep(step, { agent, lane, cwd, env, logPath })
    if (outcome.stop) {
      process.exitCode = outcome.code
      return
    }
  }
  appendLog(logPath, { kind: "exit", agent, code: 0, reason: "end-of-scenario" })
}

if (process.argv[1] && path.resolve(process.argv[1]) === FAKE_RUNNER_PATH) {
  main().catch((error) => {
    appendLog(process.env.FAKE_RUNNER_LOG || "", { kind: "exit", agent: process.env.BTRAIN_AGENT || "", code: 70, reason: String(error?.message || error) })
    process.stderr.write(`fake-runner: ${error?.stack || error}\n`)
    process.exit(70)
  })
}
