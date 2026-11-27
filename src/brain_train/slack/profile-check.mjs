// Spec 025 FR-15 and the plan's "The profile check" (WS4 step 5, task T023).
// Imports nothing from core.mjs.
//
// `runProfileCheck` starts the runner once with the profile and the input
// "Reply with OK", through the same `runOnce` an ordinary run uses, so the
// arguments and the first-event test are the ones every run gets. The
// verdict is saved in `<btrain home>/slack/runner-check.json` with the runner
// string, the profile version, and the first line of `<runner> --version`.
// A saved verdict counts only for that runner string, profile version, and
// CLI version.
//
// Only a run that reached its first event judges the profile: it passes when
// the run replied, and fails when its first event failed the check. A run
// that could not judge it (missing executable, timed out, out of usage or
// signed out, any other failure) saves nothing, so the next start tries again.

import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { PROFILE_VERSION, resolveProfile, runOnce, runnerEnv } from "./runner.mjs"

export const RUNNER_CHECK_FILE = "runner-check.json"
export const CHECK_INPUT = "Reply with OK"
const VERSION_TIMEOUT_MS = 10_000
const VERSION_CHARS = 200

function checkPath(slackDir) {
  return path.join(slackDir, RUNNER_CHECK_FILE)
}

/** The saved verdict, or null when there is none or it cannot be read. */
export function readRunnerCheck(slackDir) {
  try {
    const verdict = JSON.parse(fs.readFileSync(checkPath(slackDir), "utf8"))
    return verdict && typeof verdict === "object" && typeof verdict.ok === "boolean" ? verdict : null
  } catch {
    return null
  }
}

/** Whether a saved verdict is for this runner string and CLI version, at this profile version. */
export function verdictMatches(verdict, { runner, cliVersion: version }) {
  return Boolean(verdict) &&
    verdict.runner === runner &&
    verdict.profileVersion === PROFILE_VERSION &&
    verdict.cliVersion === version
}

/**
 * Save a verdict, through a temporary file and a rename, readable by the
 * user only. Also used when an ordinary run fails the first-event check.
 */
export function saveVerdict(slackDir, { runner, cliVersion: version, ok, reason = "", now = Date.now }) {
  const verdict = { runner, profileVersion: PROFILE_VERSION, cliVersion: version, ok: Boolean(ok), reason, checkedAt: new Date(now()).toISOString() }
  fs.mkdirSync(slackDir, { recursive: true })
  const temp = path.join(slackDir, `.${RUNNER_CHECK_FILE}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temp, `${JSON.stringify(verdict, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, checkPath(slackDir))
  return verdict
}

/**
 * The first line of `<runner executable> --version`, with the profile's
 * environment, or "" when it cannot be read. No model runs.
 */
export function cliVersion(runner, { env = process.env } = {}) {
  const executable = String(runner ?? "").trim().split(/\s+/)[0]
  if (!executable) return Promise.resolve("")
  return new Promise((resolve) => {
    const child = execFile(executable, ["--version"], { env: runnerEnv(env), timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) return resolve("")
      resolve(String(stdout).split("\n")[0].trim().slice(0, VERSION_CHARS))
    })
    // Nothing is written to it, so a CLI that reads it does not wait.
    child.stdin?.on("error", () => {})
    child.stdin?.end()
  })
}

/**
 * Run the profile check and save its verdict when the run judged the
 * profile. Returns `{ ok, reason, saved, cliVersion }`.
 */
export async function runProfileCheck({ runner, env = process.env, slackDir, turnSeconds = 180, version, log = () => {}, now = Date.now, signal } = {}) {
  const resolved = resolveProfile(runner)
  if (!resolved.ok) return { ok: false, reason: resolved.reason, saved: false, cliVersion: "" }
  // A caller that already read the version passes it, so the verdict is
  // saved under the version it compared against.
  if (typeof version !== "string") version = await cliVersion(runner, { env })
  const result = await runOnce({ runner, input: CHECK_INPUT, turnSeconds, env, log, signal })
  if (result.outcome === "reply" || result.profileFailed) {
    const ok = result.outcome === "reply"
    saveVerdict(slackDir, { runner, cliVersion: version, ok, reason: ok ? "" : result.reason, now })
    return { ok, reason: ok ? "" : result.reason, saved: true, cliVersion: version }
  }
  return { ok: false, reason: result.reason || result.outcome, saved: false, cliVersion: version }
}
