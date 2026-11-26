// Spec 024 FR-11 (T019): the publisher's findings for `btrain doctor`. With
// the toggle off there are none and nothing is read. Every finding is a
// warning: the publisher never blocks a lane, so it never makes a repository
// unhealthy. Nothing here imports core.mjs.

import { isSlackEnabled } from "./config.mjs"
import { listEntries, readDeliveryState } from "./outbox.mjs"
import { deliveryTarget } from "./target.mjs"

// An entry queued longer than this means delivery is not running.
export const STALE_ENTRY_MS = 60 * 60 * 1000

function ageText(ms) {
  const minutes = Math.floor(ms / 60_000)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * `{ warnings }` for one repository: a paused publisher, the toggle on with no
 * token or no channel, and an oldest queued entry over an hour old.
 */
export async function collectSlackDoctorFindings(repoRoot, config, { env = process.env, now = Date.now } = {}) {
  const warnings = []
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
