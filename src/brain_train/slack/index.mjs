// Spec 024 WS4 (T016, T017): the publisher's three entry points, and the only
// slack/ module core.mjs imports (invariant 8).
//
// - `offerWorkflowEvent` queues one outbox entry for a workflow event, after
//   core.mjs appends it. `offerDispatchFailure` queues the dispatch-failed
//   entry before finishPatchWithReviewerDispatch throws. Both return at once
//   when `[features].slack` is not true, never call Slack, and catch every
//   error: a failure is logged to the repository's publisher log, scrubbed,
//   and never reaches the lane command.
// - `deliverAfterCommand` runs once, after the command's output and error
//   (the end of cli.mjs). It delivers the queue of the command's repository
//   and of every repository this process queued for, within the inline
//   budget (`[slack].inline_timeout_ms`, 2 seconds), and prints one warning
//   line when delivery is paused (FR-10). It cannot throw.
//
// cli.mjs passes the readers this needs (the repository, its config, its lane
// states), so nothing here imports core.mjs.

import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { getSlackOptions, isSlackEnabled } from "./config.mjs"
import { claimKeyOf, classifyWorkflowEvent } from "./events.mjs"
import { readDeliveryState, writeEntry } from "./outbox.mjs"
import { pullRequestLink, REMOTE_CONFIG_PATTERN } from "./remote.mjs"
import { deliverToTarget, deliveryTarget, slackDirFor } from "./target.mjs"
import { prepareAgentText } from "./text.mjs"
import { getThread } from "./threads.mjs"

export { collectSlackDoctorFindings } from "./doctor.mjs"

const execFileAsync = promisify(execFile)

export const PUBLISHER_LOG_FILENAME = "publisher.log"
// FR-12: the guidance printed after the thread of a lane.
export const THREAD_GUIDANCE = "btrain posts lane status; post in this thread only to ask the operator a question or report a blocker"
const REMOTE_READ_TIMEOUT_MS = 1000

// Repositories (by their Slack state directory) this process queued entries
// for, so deliverAfterCommand delivers them even when the command named
// another repository.
const offeredRepos = new Map()

function lanesEnabled(config) {
  const value = config?.lanes?.enabled
  return value === true || (typeof value === "string" && /^true\b/.test(value.trim()))
}

// One line in the repository's publisher log: the time, where, and the
// error's message, scrubbed and flattened. Never throws.
async function logError(slackDir, where, error) {
  try {
    const message = prepareAgentText(String(error?.message || error), { maxChars: 300, singleLine: true })
    await fs.mkdir(slackDir, { recursive: true })
    await fs.appendFile(path.join(slackDir, PUBLISHER_LOG_FILENAME), `${new Date().toISOString()} ${where}: ${message}\n`, { mode: 0o600 })
  } catch {
    // The log is best effort.
  }
}

// The events of one lane's log, parsed; a line that does not parse is skipped.
async function readEventLog(eventLogPath) {
  if (!eventLogPath) return []
  const text = await fs.readFile(eventLogPath, "utf8").catch(() => "")
  const events = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn or foreign line names no claim.
    }
  }
  return events
}

// The GitHub link of the lane's PR, from the base remote, or "".
async function pullRequestUrl(stateRoot, prNumber) {
  if (!prNumber) return ""
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get-regexp", REMOTE_CONFIG_PATTERN], {
      cwd: stateRoot,
      timeout: REMOTE_READ_TIMEOUT_MS,
    })
    return pullRequestLink(stdout, prNumber) || ""
  } catch {
    return ""
  }
}

/**
 * Queue an outbox entry for a workflow event (core.mjs, after the append to
 * `eventLogPath`, the lane's log). The entry's claim key is the time of the
 * lane's last claim event in that log (FR-5), so a task claimed while the
 * publisher was off still gets its own card on its next event. A
 * repository-wide event in a repository with lanes has no lane thread and is
 * not queued.
 */
export async function offerWorkflowEvent(repoRoot, config, event, eventLogPath = "") {
  if (!isSlackEnabled(config)) return
  let slackDir = ""
  try {
    slackDir = slackDirFor(repoRoot)
    const laneId = String(event?.laneId || "")
    if (!laneId && lanesEnabled(config)) return
    const classified = classifyWorkflowEvent(event, { summaryChars: getSlackOptions(config).summaryChars })
    // The event is already appended, so a claim finds itself, with the time
    // the log recorded (the event object may not carry it).
    const claimKey = claimKeyOf(await readEventLog(eventLogPath))
    const entry = { laneId, claimKey, kind: classified.kind, reply: classified.reply, mention: classified.mention, fields: classified.fields }
    if (classified.kind === "ready-to-merge") {
      const prUrl = await pullRequestUrl(path.dirname(path.dirname(slackDir)), event?.after?.prNumber)
      if (prUrl) entry.prUrl = prUrl
    }
    await writeEntry(slackDir, entry)
    offeredRepos.set(slackDir, repoRoot)
  } catch (error) {
    if (slackDir) await logError(slackDir, "offer", error)
  }
}

/**
 * Queue the dispatch-failed entry for a lane whose reviewer dispatch failed
 * or timed out (core.mjs, before the throw). `lane` is the lane's state after
 * its update.
 */
export async function offerDispatchFailure(repoRoot, config, { laneId = "", lane = {}, agentName = "", status = "", reason = "", eventLogPath = "" } = {}) {
  if (!isSlackEnabled(config)) return
  const reviewer = agentName || lane?.reviewer || ""
  await offerWorkflowEvent(repoRoot, config, {
    type: "dispatch-failed",
    laneId,
    actor: reviewer,
    recordedAt: new Date().toISOString(),
    before: lane,
    after: { ...lane, reviewer },
    details: { summary: reason || `reviewer dispatch ${status || "failed"}` },
  }, eventLogPath)
}

/**
 * The FR-12 thread line of each lane whose current task has a thread, by lane
 * id. `readLanes(repoRoot)` gives the lane states with their claim keys. Empty,
 * with nothing read, when the publisher is off.
 */
export async function threadLines(repoRoot, config, readLanes) {
  const lines = new Map()
  try {
    if (!isSlackEnabled(config)) return lines
    const slackDir = slackDirFor(repoRoot)
    for (const lane of await readLanes(repoRoot)) {
      const laneId = String(lane?.laneId ?? "")
      const thread = await getThread(slackDir, laneId, lane?.claimKey)
      if (thread) lines.set(laneId, `slack thread: ${thread.channel} ${thread.cardTs} · ${THREAD_GUIDANCE}`)
    }
  } catch {
    // No line is better than a failed command.
  }
  return lines
}

/**
 * Deliver after a command. Options: `resolveRepo` (the command's repository
 * root, or null), `readConfig(repoRoot)`, `readLanes(repoRoot)`, and for
 * tests `env`, `fetchImpl`, `now`, and `warn`. Resolves with the delivery
 * summaries; never throws.
 */
export async function deliverAfterCommand(options = {}) {
  const now = options.now || Date.now
  const started = now()
  const warn = options.warn || ((line) => process.stderr.write(`${line}\n`))
  const summaries = []
  try {
    const repos = new Map(offeredRepos)
    offeredRepos.clear()
    const resolved = await Promise.resolve().then(() => options.resolveRepo?.()).catch(() => null)
    if (resolved) repos.set(slackDirFor(resolved), resolved)
    for (const repoRoot of repos.values()) {
      const summary = await deliverRepo(repoRoot, options, started, now, warn)
      if (summary) summaries.push(summary)
    }
  } catch {
    // Delivery never reaches the command.
  }
  return summaries
}

async function deliverRepo(repoRoot, options, started, now, warn) {
  let slackDir = ""
  try {
    const config = await options.readConfig(repoRoot)
    if (!isSlackEnabled(config)) return null
    const target = await deliveryTarget(repoRoot, config, { env: options.env })
    slackDir = target.slackDir
    if (!target.token || !target.channel) return null
    if (!(await fs.stat(target.slackDir).then((stat) => stat.isDirectory(), () => false))) return null
    const summary = await deliverToTarget(target, {
      readLanes: () => options.readLanes(repoRoot),
      fetchImpl: options.fetchImpl || globalThis.fetch,
      budgetMs: Math.max(0, started + target.inlineTimeoutMs - now()),
      now,
    })
    if (summary.status === "paused") {
      const reason = summary.reason || (await readDeliveryState(target.slackDir)).paused?.error || "configuration error"
      warn(`btrain slack: delivery is paused (${reason}); run btrain slack test to resume`)
    } else if (summary.status === "error") {
      await logError(target.slackDir, "deliver", summary.reason)
    }
    return summary
  } catch (error) {
    if (slackDir) await logError(slackDir, "deliver", error)
    return null
  }
}
