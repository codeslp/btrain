// Spec 023 FR-5 and the implementation plan's WS2 steps 3 and 4 (task T010):
// the signals that show a review is under way.
//
//   review-pickup    the open attempt's reviewer runs `btrain handoff` for
//                    the lane the first time; or the lane's owner does, for a
//                    `fix-confirmation` lane with an unconfirmed fix
//   review-progress  the open attempt's reviewer runs any other lane-scoped
//                    command, at most once a minute
//
// `recordReviewActivity` owns no I/O and does not import core.mjs. `cli.mjs`
// calls it once after `resolveRepoRoot` in each lane-scoped handler
// (`handoff`, `review`, `pr`) and passes in:
//
//   identity          the result of `detectCurrentAgent`: { status, agentName }
//   withLaneLock(fn)  runs fn under the lane's handoff lock (`withFileLock`)
//   readLane()        { status, owner, reviewer } of the lane
//   readEvents()      the lane's workflow events
//   appendEvent(e)    `appendWorkflowEvent`, which takes no lock itself
//   now()             the time
//
// Only `cli.mjs` calls it. Code that calls `checkHandoff` from inside btrain,
// such as the startup snapshot, writes nothing.
//
// Opening an attempt for a reviewer that was not dispatched (`opened:
// pickup`) is WS5 step 6 and is not done here: with no open attempt, this
// module writes nothing.

import { activeAttempt, foldReviewRecord } from "./record.mjs"

/** Progress is written at most this often per attempt. A pickup counts. */
export const PROGRESS_MIN_INTERVAL_MS = 60_000

// The `pr` subcommands that only read. They write no signal.
const READ_ONLY_PR_SUBCOMMANDS = new Set(["status"])

const NOTHING = Object.freeze({ written: "", event: null })

function keyOf(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

/**
 * The signal a lane-scoped command can write: "pickup" for a bare
 * `btrain handoff`, "progress" for the other subcommands of `handoff`,
 * `review`, and `pr`, and "" for `btrain pr status` and every other command.
 */
export function activityKindFor(command, subcommand = "") {
  const sub = typeof subcommand === "string" ? subcommand.trim() : ""
  switch (command) {
    case "handoff":
      return sub ? "progress" : "pickup"
    case "review":
      return "progress"
    case "pr":
      return READ_ONLY_PR_SUBCOMMANDS.has(sub) ? "" : "progress"
    default:
      return ""
  }
}

function elapsedSince(iso, nowMs) {
  const then = Date.parse(iso || "")
  return Number.isFinite(then) ? nowMs - then : Number.NaN
}

/**
 * The event this call writes, or null. Pure: decides from the lane, its
 * events, the caller, and the time.
 */
export function planReviewActivity({ kind, agentName, lane, events, now }) {
  const agent = keyOf(agentName)
  if (!agent || !lane) return null
  const status = String(lane.status || "")
  const record = foldReviewRecord(events, { status })
  const nowMs = now.getTime()
  const at = now.toISOString()

  if (status === "needs-review") {
    const attempt = activeAttempt(record)
    if (!attempt || keyOf(attempt.reviewer) !== agent) return null
    if (kind === "pickup") {
      if (attempt.pickedUpAt) return null
      return { type: "review-pickup", details: { attemptId: attempt.id, at } }
    }
    // A last signal in the future (a skewed clock) does not hold progress back.
    const elapsed = elapsedSince(attempt.lastProgressAt, nowMs)
    if (elapsed >= 0 && elapsed < PROGRESS_MIN_INTERVAL_MS) return null
    return { type: "review-progress", details: { attemptId: attempt.id, at } }
  }

  if (status === "fix-confirmation" && kind === "pickup") {
    const fix = record.fix
    if (!fix || fix.confirmed || fix.pickedUpAt) return null
    if (keyOf(lane.owner) !== agent || keyOf(fix.author) === agent) return null
    const details = fix.attemptId ? { attemptId: fix.attemptId, fixHead: fix.head, at } : { fixHead: fix.head, at }
    return { type: "review-pickup", details }
  }

  return null
}

/**
 * Write the pickup or progress signal for this command, if one is due.
 * Returns { written, event }: `written` is the event type, or "" when
 * nothing was written.
 */
export async function recordReviewActivity({
  laneId,
  kind,
  identity,
  withLaneLock,
  readLane,
  readEvents,
  appendEvent,
  now = () => new Date(),
} = {}) {
  if (!laneId || (kind !== "pickup" && kind !== "progress")) return NOTHING
  // One identity rule for a dispatched runner (BTRAIN_AGENT) and a session
  // started by hand (runtime hints): only a verified agent writes.
  if (identity?.status !== "verified" || !keyOf(identity.agentName)) return NOTHING

  return withLaneLock(async () => {
    const lane = await readLane()
    const events = await readEvents()
    const planned = planReviewActivity({ kind, agentName: identity.agentName, lane, events, now: now() })
    if (!planned) return NOTHING
    const event = { laneId, type: planned.type, actor: identity.agentName, details: planned.details }
    await appendEvent(event)
    return { written: event.type, event }
  })
}
