// Spec 024 FR-11 (T019): the publisher's findings for `btrain doctor`. With
// the toggle off there are none and nothing is read. Every finding is a
// warning: the publisher never blocks a lane, so it never makes a repository
// unhealthy. Nothing here imports core.mjs.

import path from "node:path"
import { getListenerSettings, getRepoOrchestratorOptions, isSlackEnabled, isSlackListenEnabled } from "./config.mjs"
import { btrainHome, loadSlackCredentials } from "./credentials.mjs"
import { isPaused } from "./lease.mjs"
import { listEntries, readDeliveryState } from "./outbox.mjs"
import { cliVersion, readRunnerCheck, runProfileCheck, verdictMatches } from "./profile-check.mjs"
import { resolveProfile } from "./runner.mjs"
import { deliveryTarget } from "./target.mjs"

// An entry queued longer than this means delivery is not running.
export const STALE_ENTRY_MS = 60 * 60 * 1000

function ageText(ms) {
  const minutes = Math.floor(ms / 60_000)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Spec 025 T023: the listener's findings for a repository with
 * `slack_listen` on: the toggle on with `slack` off, no operator, `start` or
 * `pause` in `auto`, a runner with no profile, a failed profile check, and a
 * paused listener. The profile check runs here only when no verdict is saved
 * for the current runner string, profile version, and CLI version, and never
 * in a lane-pinned session. Every finding is a warning.
 */
async function collectListenerFindings(config, { env }) {
  const warnings = []
  if (!isSlackEnabled(config)) {
    warnings.push("slack: slack_listen is on but [features].slack is off; the listener does not serve this repository")
  }
  for (const error of getRepoOrchestratorOptions(config).errors) warnings.push(`slack: ${error.message}`)
  try {
    const credentials = await loadSlackCredentials({ env })
    const listening = getListenerSettings(credentials.settings)
    for (const error of listening.errors) warnings.push(`slack: ${error.message}`)
    if (!listening.operator) {
      warnings.push("slack: slack_listen is on but slack.json names no operator; the listener does not start")
    }
    const slackDir = path.join(btrainHome(env), "slack")
    if (await isPaused(slackDir)) warnings.push("slack: the listener is paused; run btrain slack listen --resume")
    const runner = listening.orchestrator.runner
    if (runner) {
      const profile = resolveProfile(runner)
      if (!profile.ok) {
        warnings.push(`slack: the orchestrator runner has no profile (${profile.reason}); the model does not run`)
      } else {
        const version = await cliVersion(runner, { env })
        let verdict = readRunnerCheck(slackDir)
        if (!verdictMatches(verdict, { runner, cliVersion: version }) && env.BTRAIN_LANE_LOCKED !== "1") {
          await runProfileCheck({ runner, env, slackDir, turnSeconds: listening.orchestrator.turnSeconds, version })
          verdict = readRunnerCheck(slackDir)
        }
        if (verdictMatches(verdict, { runner, cliVersion: version }) && !verdict.ok) {
          warnings.push(`slack: the orchestrator profile check failed (${verdict.reason}); the model does not run until a check passes`)
        }
      }
    }
  } catch (error) {
    warnings.push(`slack: the listener settings could not be read (${String(error?.message || error).slice(0, 200)})`)
  }
  return warnings
}

/**
 * `{ warnings }` for one repository: a paused publisher, the toggle on with no
 * token or no channel, and an oldest queued entry over an hour old.
 */
export async function collectSlackDoctorFindings(repoRoot, config, { env = process.env, now = Date.now } = {}) {
  const warnings = []
  if (isSlackListenEnabled(config)) warnings.push(...(await collectListenerFindings(config, { env })))
  if (!isSlackEnabled(config)) return { warnings }
  try {
    const target = await deliveryTarget(repoRoot, config, { env })
    if (!target.token) {
      warnings.push(`slack: the publisher is on but has no token (${target.tokenReason || "missing"}); run btrain slack setup`)
    }
    if (!target.channel) {
      warnings.push("slack: the publisher is on but no channel is mapped for this repository; run btrain slack setup --channel <id>")
    }
    const state = await readDeliveryState(target.slackDir)
    if (state.paused) {
      warnings.push(`slack: the publisher is paused (${state.paused.error}); run btrain slack test to resume`)
    }
    const times = (await listEntries(target.slackDir))
      .map((item) => Date.parse(item.entry?.queuedAt || ""))
      .filter(Number.isFinite)
    if (times.length > 0 && now() - Math.min(...times) > STALE_ENTRY_MS) {
      warnings.push(`slack: the oldest queued entry is ${ageText(now() - Math.min(...times))} old (${times.length} queued); run btrain slack flush`)
    }
  } catch (error) {
    warnings.push(`slack: the publisher state could not be read (${String(error?.message || error).slice(0, 200)})`)
  }
  return { warnings }
}
