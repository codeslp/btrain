// Spec 025 FR-15 and the plan's "The orchestrator run" (WS4 step 1, task
// T020): one model run of the orchestrator. Imports nothing from core.mjs.
//
// A runner string is split on spaces and never given to a shell. Its first
// word's basename picks a profile; every other word must be one the profile
// allows, or the string has no profile and nothing starts. The first version
// has one profile, `claude`, for macOS and Linux.
//
// One run: an empty directory from mkdtemp, the runner started there in its
// own process group with only the profile's environment names, the input
// written to standard input and closed. At most 64 KB of output is kept. At
// `turnSeconds` the group gets SIGTERM and, one second later, SIGKILL. The
// directory is removed afterwards.
//
// Every run is held to the amended FR-15 check on its first event: no tool,
// no MCP server, no API key as the credential source, no skill, no slash
// command, and exactly the four built-in agents. The messaging socket path
// is not checked. A run that fails the check, or whose first event cannot be
// read, is stopped at once, its output is discarded, and the result says the
// profile failed. The reply is the text of the event whose type is `result`,
// wherever it falls in the stream (real runs order the other events
// differently).
//
// Error output goes to the local log, scrubbed, and is never in a reply.

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { scrubSecrets } from "./text.mjs"

export const PROFILE_VERSION = 1
export const OUTPUT_CAP_BYTES = 64 * 1024
const STDERR_CAP_BYTES = 16 * 1024
const KILL_GRACE_MS = 1000

/** Fixed reply text for each outcome but a reply (plan, "Outcomes"). */
export const RUN_REPLIES = Object.freeze({
  timedOut: "The orchestrator timed out. Commands still work.",
  missing: "The orchestrator is not installed. Commands still work.",
  outOfUsage: "The orchestrator is out of usage or signed out. Commands still work.",
  failed: "The orchestrator run failed. Commands still work.",
})

/** The arguments the `claude` profile adds after the runner's own words. */
export const ADDED_ARGS = Object.freeze([
  "--tools", "",
  "--safe-mode",
  "--restricted",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--permission-prompts", "none",
  "--disable-slash-commands",
  "--output-format", "stream-json",
  "--verbose",
])

const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]

/** The environment names a run gets (FR-15). Nothing else is passed. */
export const ALLOWED_ENV_NAMES = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TERM", "LANG", "SHELL", "USER",
  ...PROXY_NAMES,
  ...PROXY_NAMES.map((name) => name.toLowerCase()),
  "CLAUDE_CONFIG_DIR",
])

/** The four built-in agents the first event must list, exactly (FR-15). */
export const BUILT_IN_AGENTS = Object.freeze(["claude", "Explore", "general-purpose", "Plan"])

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"])
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,99}$/

// Out of usage or signed out (plan, "Outcomes"): matched on a failed run's
// error output, its result text, and its assistant error field. Not matched
// on event type names: every run has a `rate_limit_event`.
const USAGE_PATTERNS = Object.freeze([
  /\busage limit\b/i,
  /\blimit (?:reached|exceeded)\b/i,
  /\bout of (?:usage|credits?)\b/i,
  /\bfailed to authenticate\b/i,
  /\bauthentication_failed\b/,
  /\bnot logged in\b/i,
  /\bplease run \/login\b/i,
  /\boauth (?:session|token) (?:expired|has expired)\b/i,
])

const PROFILES = Object.freeze({
  claude: Object.freeze({
    name: "claude",
    platforms: Object.freeze(["darwin", "linux"]),
    // Returns the number of words taken at `index`, or 0 when not allowed.
    takeWord(words, index) {
      const word = words[index]
      if (word === "-p" || word === "--print") return 1
      if (word === "--model") return MODEL_NAME.test(words[index + 1] ?? "") ? 2 : 0
      if (word === "--effort") return EFFORT_LEVELS.has(words[index + 1] ?? "") ? 2 : 0
      return 0
    },
  }),
})

/**
 * The profile of a runner string. Returns `{ ok, reason, profile,
 * executable, words }`; `words` are the runner's own words after the
 * executable.
 */
export function resolveProfile(runner, { platform = process.platform } = {}) {
  const parts = String(runner ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { ok: false, reason: "the runner is empty" }
  const [executable, ...words] = parts
  const base = path.basename(executable)
  const profile = Object.hasOwn(PROFILES, base) ? PROFILES[base] : null
  if (!profile) return { ok: false, reason: `no profile for the runner ${base}` }
  if (!profile.platforms.includes(platform)) return { ok: false, reason: `the ${profile.name} profile is for macOS and Linux only` }
  for (let index = 0; index < words.length;) {
    const taken = profile.takeWord(words, index)
    if (taken === 0) return { ok: false, reason: `the ${profile.name} profile does not allow the word ${words[index]}` }
    index += taken
  }
  return { ok: true, reason: "", profile, executable, words }
}

/** The run's environment: only the allowed names, from `env`. */
export function runnerEnv(env = process.env) {
  const out = {}
  for (const name of ALLOWED_ENV_NAMES) {
    if (Object.hasOwn(env, name) && typeof env[name] === "string") out[name] = env[name]
  }
  return out
}

function isEmptyList(value) {
  return Array.isArray(value) && value.length === 0
}

/**
 * The amended FR-15 check on one run's first stream line. Returns
 * `{ ok, reason }`.
 */
export function checkFirstEvent(line) {
  let event
  try {
    event = JSON.parse(String(line ?? ""))
  } catch {
    return { ok: false, reason: "the first event cannot be read" }
  }
  if (!event || typeof event !== "object" || event.type !== "system" || event.subtype !== "init") {
    return { ok: false, reason: "the first event is not the init event" }
  }
  if (!isEmptyList(event.tools)) return { ok: false, reason: "the run reports tools" }
  if (!isEmptyList(event.mcp_servers)) return { ok: false, reason: "the run reports MCP servers" }
  if (event.apiKeySource !== "none") return { ok: false, reason: "the run's credential source is not the subscription login" }
  if (!isEmptyList(event.skills)) return { ok: false, reason: "the run reports skills" }
  if (!isEmptyList(event.slash_commands)) return { ok: false, reason: "the run reports slash commands" }
  const agents = Array.isArray(event.agents) ? event.agents.map(String).sort() : null
  if (!agents || JSON.stringify(agents) !== JSON.stringify([...BUILT_IN_AGENTS].sort())) {
    return { ok: false, reason: "the run's agents are not exactly the four built-in agents" }
  }
  return { ok: true, reason: "" }
}

function parseLines(text) {
  const events = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A line that does not parse is not an event; the first line is
      // checked on its own.
    }
  }
  return events
}

function usageText(events, stderr) {
  const parts = [stderr]
  for (const event of events) {
    if (event?.type === "result" && typeof event.result === "string") parts.push(event.result)
    if (event?.type === "assistant" && typeof event.error === "string") parts.push(event.error)
  }
  return parts.join("\n")
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
}

function logError(log, stderr) {
  const text = scrubSecrets(stderr.trim()).text
  if (text) log(`orchestrator error output: ${text.slice(0, 2000)}`)
}

/**
 * One orchestrator run. `runner` is the runner string, `input` the text for
 * standard input, `turnSeconds` the time limit, `env` the environment to take
 * the allowed names from. Returns `{ outcome, reply, reason, profileFailed }`
 * where `outcome` is `reply`, `timedOut`, `missing`, `outOfUsage`, `failed`,
 * `noProfile` (nothing started), or `cancelled` (the signal aborted it),
 * and `reply` is the text to post: the model's reply, or the fixed text of
 * the outcome. `signal` is an optional AbortSignal that stops the run.
 */
export async function runOnce({ runner, input = "", turnSeconds = 180, env = process.env, platform = process.platform, log = () => {}, signal } = {}) {
  const resolved = resolveProfile(runner, { platform })
  if (!resolved.ok) return { outcome: "noProfile", reply: "", reason: resolved.reason, profileFailed: false }
  if (signal?.aborted) return { outcome: "cancelled", reply: "", reason: "the run was cancelled before it started", profileFailed: false }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-orchestrator-"))
  try {
    // An abort while the directory was being made: nothing has started.
    if (signal?.aborted) return { outcome: "cancelled", reply: "", reason: "the run was cancelled before it started", profileFailed: false }
    return await new Promise((resolve) => {
      // Output is kept as bytes and decoded once, so a UTF-8 character split
      // across chunks is not corrupted.
      const chunks = []
      let stdoutBytes = 0
      let capped = false
      let stderr = ""
      let firstChecked = false
      let firstFailure = ""
      let timedOut = false
      let spawnError = null
      let killTimer = null

      const stop = () => {
        killGroup(child.pid, "SIGTERM")
        if (!killTimer) killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS)
      }

      const child = spawn(resolved.executable, [...resolved.words, ...ADDED_ARGS], {
        cwd: dir,
        env: runnerEnv(env),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const turnTimer = setTimeout(() => {
        timedOut = true
        stop()
      }, Math.max(0, Number(turnSeconds) * 1000))
      // An abort (the listener stopping) ends the run at once.
      let cancelled = false
      const onAbort = () => {
        cancelled = true
        stop()
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      child.on("error", (error) => {
        spawnError = error
      })
      child.stdin.on("error", () => {})
      child.stdout.on("data", (chunk) => {
        if (firstFailure) return
        if (stdoutBytes + chunk.length > OUTPUT_CAP_BYTES) {
          capped = true
          const room = OUTPUT_CAP_BYTES - stdoutBytes
          if (room > 0) chunks.push(chunk.subarray(0, room))
          stdoutBytes = OUTPUT_CAP_BYTES
        } else {
          chunks.push(chunk)
          stdoutBytes += chunk.length
        }
        if (!firstChecked) {
          const kept = Buffer.concat(chunks)
          const end = kept.indexOf(0x0a)
          if (end >= 0 || capped) {
            firstChecked = true
            const check = checkFirstEvent((end >= 0 ? kept.subarray(0, end) : kept).toString("utf8"))
            if (!check.ok) {
              firstFailure = check.reason
              chunks.length = 0
              stop()
            }
          }
        }
      })
      child.stderr.on("data", (chunk) => {
        if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString("utf8").slice(0, STDERR_CAP_BYTES - stderr.length)
      })
      child.stdin.end(String(input))

      child.on("close", (code) => {
        clearTimeout(turnTimer)
        signal?.removeEventListener("abort", onAbort)
        if (killTimer) clearTimeout(killTimer)
        if (child.pid) killGroup(child.pid, "SIGKILL")
        logError(log, stderr)
        const done = (outcome, reason, extra = {}) => {
          if (reason) log(`orchestrator run ${outcome}: ${reason}`)
          resolve({ outcome, reply: RUN_REPLIES[outcome] ?? "", reason, profileFailed: false, ...extra })
        }
        if (spawnError) {
          return spawnError.code === "ENOENT"
            ? done("missing", "the runner executable was not found")
            : done("failed", `the runner did not start (${spawnError.code || "error"})`)
        }
        if (cancelled) return done("cancelled", "the run was cancelled")
        if (firstFailure) return done("failed", firstFailure, { profileFailed: true })
        if (timedOut) return done("timedOut", `the run passed ${turnSeconds} seconds`)
        const stdout = Buffer.concat(chunks).toString("utf8")
        if (!firstChecked && stdout.trim() !== "") {
          const check = checkFirstEvent(stdout.trim())
          if (!check.ok) return done("failed", check.reason, { profileFailed: true })
        }
        // A run that exits 0 without a first event cannot be checked: the
        // profile fails, as for an unreadable first event.
        if (code === 0 && stdout.trim() === "") return done("failed", "the run wrote no first event", { profileFailed: true })
        const events = parseLines(stdout)
        const result = events.find((event) => event?.type === "result")
        if (code !== 0 || result?.is_error === true) {
          const text = usageText(events, stderr)
          if (USAGE_PATTERNS.some((pattern) => pattern.test(text))) return done("outOfUsage", `exit ${code}: usage or sign-in`)
          return done("failed", `exit ${code}`)
        }
        if (capped) return done("failed", "the output passed 64 KB")
        if (!result || typeof result.result !== "string" || result.result.trim() === "") {
          return done("failed", "the run wrote no result event with text")
        }
        resolve({ outcome: "reply", reply: result.result, reason: "", profileFailed: false })
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
