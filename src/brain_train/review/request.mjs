// Spec 023 FR-4 to FR-8, implementation plan "Review request loop" (task
// T022): the attempt loop of one review request.
//
// `runReviewRequest` owns no I/O. The caller passes in everything it touches:
//
//   readEvents()          the lane's workflow events (the record is folded from them)
//   writeEvent(event)     append one review event under the lane's handoff lock
//   readLane()            { status, owner, reviewer, prNumber, head, branch,
//                           headMovedByReviewer }
//   startAttempt(args)    one write that sets the lane's reviewer and records
//                         `review-attempt` (row 20 for a change of reviewer);
//                         returns { ok: false, reason } when it refuses
//   runAttempt(args)      starts the runner and returns at once with a handle:
//                         { exit: Promise<{ exitCode }>, tail(), lastOutputAt(),
//                           executable? }
//   now(), sleep(ms)      time, so a test runs a 15-minute window in milliseconds
//
// and, optionally, `probe(reviewer)` (the runner table's presence probe),
// `lock` (a holder from request-lock.mjs, checked before every dispatch),
// `newId()`, `executableOf(reviewer)`, and `extraSignals` per executable.
//
// `readLane().head` is the commit the caller treats as the lane's head, and
// `headMovedByReviewer` says the only commits after the request's head are the
// active attempt's reviewer's (FR-4: that is a fix in progress, not a new
// head). Which commit that is belongs to the caller: the plan resolves the
// request's branch ref, while PR #122 pins a `reviewHead` at needs-review.
// This module only compares the two.
//
// Each pass applies the plan's eight rules in order:
//   1. verdict: the lane left needs-review -> return;
//   2. new head: the owner moved the head -> new request, open attempt superseded;
//   3. open attempt: watch it; unresponsive or stopped-at-max ends it;
//   4. runner exit: classified with the runner table;
//   5. next other-lab reviewer: untried first, then a re-probe at each
//      silence limit until the window ends;
//   6. fallback: after the window, every other-lab reviewer tried and none
//      progressing, a same-lab reviewer outside the author history;
//   7. no candidate (or two same-lab requests for changes): escalate;
//   8. wait.
// and the three short cases: no other-lab agent configured (rule 6 at once),
// a linked PR (the recorded reviewer only, escalate at the window's end), and a
// notify runner (never a candidate: the caller leaves it out of `candidates`).

import { randomUUID } from "node:crypto"
import { activeAttempt, attemptsForCurrentRequest, foldReviewRecord } from "./record.mjs"
import { getReviewPolicy } from "./review-config.mjs"
import { classifyExit } from "./runner-table.mjs"

export const DEFAULT_POLL_INTERVAL_MS = 5_000

export const FALLBACK_REASONS = Object.freeze({
  NEXT_OTHER_LAB: "next-other-lab",
  OTHER_LAB_RECOVERED: "other-lab-recovered",
  OTHER_LAB_UNAVAILABLE: "other-lab-unavailable",
  NO_OTHER_LAB_CONFIGURED: "no-other-lab-configured",
})

export const ESCALATION_REASONS = Object.freeze({
  NO_REVIEWER: "no-reviewer",
  SAME_LAB_LIMIT: "same-lab-limit",
  PR_LINKED: "pr-linked",
  REASSIGNMENT_REFUSED: "reassignment-refused",
})

// Two same-lab requests for changes stop the same-lab tier (plan WS5 step 7).
const SAME_LAB_CHANGE_REQUEST_LIMIT = 2

function toMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value || ""))
  return Number.isNaN(parsed) ? null : parsed
}

function keyOf(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function includesName(list, name) {
  return (list || []).some((item) => keyOf(item) === keyOf(name))
}

/**
 * Run one review request until a verdict, an escalation, the end of a
 * same-lab attempt, or (with `maxAttempts`) the end of the attempts this call
 * started. Returns `{ outcome, ... }`:
 *
 *   verdict          the lane left needs-review; `status` is the new status
 *   escalation       `reason` is one of ESCALATION_REASONS
 *   same-lab-ended   a same-lab attempt this call started ended with no verdict
 *   attempts-done    `maxAttempts` attempts started here have ended
 *   lock-lost        the request lock's nonce is no longer this holder's
 */
export async function runReviewRequest({
  candidates = {},
  policy,
  readEvents,
  writeEvent,
  readLane,
  startAttempt,
  runAttempt,
  now,
  sleep,
  probe = async () => true,
  lock = null,
  newId = randomUUID,
  executableOf = () => "",
  extraSignals = {},
  maxAttempts = Infinity,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const limits = { ...getReviewPolicy({}), ...(policy || {}) }
  const otherLab = Array.isArray(candidates.otherLab) ? candidates.otherLab : []
  const sameLab = Array.isArray(candidates.sameLab) ? candidates.sameLab : []
  const running = new Map()
  // The last stream output of each attempt this process ran, kept after the
  // attempt ends: FR-4's fallback needs every other-lab attempt's progress
  // within the last silence limit, not only that of live runners.
  const lastOutputAt = new Map()
  // When each candidate last failed its presence probe, by lower-case name.
  const probeFailedAt = new Map()
  // The start of the current pass over the other-lab list. A candidate is
  // untried in this pass when its last attempt or failed probe is older. The
  // first pass covers the whole request; a re-probe starts a new one, so every
  // candidate is visited again, not only the one tried longest ago.
  let passStart = -Infinity
  let started = 0

  const iso = () => new Date(now()).toISOString()

  const systemEvent = (lane, type, details) => ({
    type,
    actor: lane.owner || "",
    details: { ...details, by: "btrain-system" },
  })

  // Stop a runner this process started and forget its handle, keeping its
  // last output time.
  const stopRunner = (attemptId) => {
    const entry = running.get(attemptId)
    if (!entry) return null
    const outputAt = toMs(entry.handle?.lastOutputAt?.())
    if (outputAt !== null) lastOutputAt.set(attemptId, outputAt)
    entry.controller.abort()
    running.delete(attemptId)
    return entry
  }

  // Runners whose attempt is no longer the active one, because a lane agent
  // changed the reviewer or a verdict ended it, are stopped before anything
  // else is watched or dispatched, so a superseded reviewer never works
  // alongside its replacement.
  const reconcile = (record) => {
    const activeId = activeAttempt(record)?.id || ""
    for (const attemptId of [...running.keys()]) {
      if (attemptId !== activeId) stopRunner(attemptId)
    }
  }

  const endAttempt = async (lane, attempt, outcome, detail = "") => {
    const entry = stopRunner(attempt.id)
    await writeEvent(systemEvent(lane, "review-attempt-ended", { attemptId: attempt.id, outcome, detail }))
    return { mine: Boolean(entry), tier: attempt.tier }
  }

  const escalate = async (lane, record, reason) => {
    await writeEvent(systemEvent(lane, "review-escalation", { requestId: record.request?.id || "", reason }))
    return { outcome: "escalation", reason }
  }

  const writeRequest = async (lane) => {
    const requestId = newId()
    await writeEvent(systemEvent(lane, "review-request", {
      requestId,
      branch: lane.branch || "",
      head: lane.head || "",
      requestedAt: iso(),
      otherLab: [...otherLab],
      sameLab: [...sameLab],
    }))
  }

  // The last signal of an attempt: pickup, a persisted progress event, and
  // (after pickup, and only in the process that started it) runner output.
  const signals = (attempt) => {
    const startedAt = toMs(attempt.startedAt) ?? now()
    const pickedUpAt = toMs(attempt.pickedUpAt)
    const progressAt = toMs(attempt.lastProgressAt)
    const outputAt = toMs(running.get(attempt.id)?.handle?.lastOutputAt?.()) ?? lastOutputAt.get(attempt.id) ?? null
    const last = pickedUpAt === null ? null : Math.max(pickedUpAt, progressAt ?? pickedUpAt, outputAt ?? pickedUpAt)
    return { startedAt, pickedUpAt, last }
  }

  // Rules 3 and 4 for the open attempt. Returns null while it runs, or the
  // result of a return-worthy end.
  const watch = async (lane, record, attempt) => {
    const entry = running.get(attempt.id)
    if (entry?.exited) {
      // A runner that gave a verdict exits after writing it: read the lane
      // again before calling the exit a failure.
      const latest = await readLane()
      if (latest.status !== "needs-review") return { outcome: "verdict", status: latest.status }
      const executable = entry.handle.executable || executableOf(attempt.reviewer) || ""
      const classified = classifyExit({
        executable,
        exitCode: entry.exited.exitCode,
        tail: typeof entry.handle.tail === "function" ? entry.handle.tail() : "",
        extraSignals: extraSignals[executable] || {},
      })
      const outcome = classified.outcome || "failed"
      const detail = classified.outcome ? classified.kind || classified.match : "exited without a verdict"
      return { ended: await endAttempt(lane, attempt, outcome, detail) }
    }

    const t = now()
    const { startedAt, pickedUpAt, last } = signals(attempt)
    const lost = !entry
    if (t - startedAt >= limits.attemptMaxMs) {
      return { ended: await endAttempt(lane, attempt, "stopped-at-max", "attempt_max") }
    }
    if (pickedUpAt === null && t - startedAt >= limits.silenceLimitMs) {
      return { ended: await endAttempt(lane, attempt, "unresponsive", lost ? "dispatcher-lost" : "no-pickup") }
    }
    if (pickedUpAt !== null && t - last >= limits.silenceLimitMs) {
      return { ended: await endAttempt(lane, attempt, "unresponsive", lost ? "dispatcher-lost" : "no-progress") }
    }
    return null
  }

  const dispatch = async (lane, record, { reviewer, reason, tier }) => {
    if (started >= maxAttempts) return { outcome: "attempts-done" }
    if (lock && !(await lock.stillHeld())) return { outcome: "lock-lost" }
    const attemptId = newId()
    const changes = keyOf(reviewer) !== keyOf(lane.reviewer)
    const result = await startAttempt({
      attemptId,
      requestId: record.request.id,
      reviewer,
      previousReviewer: lane.reviewer || "",
      reason,
      tier,
      head: record.request.head,
      startedAt: iso(),
      opened: "dispatch",
      changesReviewer: changes,
    })
    if (result && result.ok === false) {
      return escalate(lane, record, result.reason || ESCALATION_REASONS.REASSIGNMENT_REFUSED)
    }
    started += 1
    const controller = new AbortController()
    const entry = { controller, handle: null, exited: null }
    running.set(attemptId, entry)
    try {
      entry.handle = await runAttempt({ attemptId, reviewer, tier, sameLab: tier === "same-lab", head: record.request.head, signal: controller.signal })
      Promise.resolve(entry.handle?.exit).then(
        (value) => { entry.exited = value || { exitCode: null } },
        (error) => { entry.exited = { exitCode: null, error } },
      )
    } catch (error) {
      entry.handle = { tail: () => String(error?.message || error), lastOutputAt: () => null }
      entry.exited = { exitCode: null, error }
    }
    return null
  }

  for (;;) {
    // Rule 1: a verdict ends the request.
    const lane = await readLane()
    if (lane.status !== "needs-review") {
      return { outcome: "verdict", status: lane.status }
    }
    const record = foldReviewRecord(await readEvents(), { status: lane.status })
    reconcile(record)
    if (!record.request) {
      await writeRequest(lane)
      continue
    }

    // Rule 2: the owner moved the head.
    if (lane.head && record.request.head && lane.head !== record.request.head && !lane.headMovedByReviewer) {
      const open = activeAttempt(record)
      if (open) await endAttempt(lane, open, "superseded", "new-head")
      probeFailedAt.clear()
      passStart = -Infinity
      await writeRequest(lane)
      continue
    }

    // Rules 3 and 4: watch the open attempt.
    const open = activeAttempt(record)
    if (open) {
      const result = await watch(lane, record, open)
      if (result?.outcome) return result
      if (result?.ended) {
        if (result.ended.mine && result.ended.tier === "same-lab") return { outcome: "same-lab-ended" }
        if (result.ended.mine && started >= maxAttempts) return { outcome: "attempts-done" }
        continue
      }
      await sleep(pollIntervalMs)
      continue
    }
    if (started >= maxAttempts) return { outcome: "attempts-done" }

    const t = now()
    const requestedAt = toMs(record.request.requestedAt) ?? t
    const windowPassed = t - requestedAt >= limits.otherLabWindowMs
    const attempts = attemptsForCurrentRequest(record)
    const attemptsOf = (name) => attempts.filter((attempt) => keyOf(attempt.reviewer) === keyOf(name))
    const laneOnOtherLab = includesName(otherLab, lane.reviewer)

    // Short case: a linked PR. Row 20 refuses a reassignment, so only the
    // recorded reviewer is dispatched, again at each silence limit.
    if (lane.prNumber) {
      if (windowPassed) return escalate(lane, record, ESCALATION_REASONS.PR_LINKED)
      const previous = attemptsOf(lane.reviewer).at(-1)
      const endedAt = toMs(previous?.endedAt)
      if (!previous || (endedAt !== null && t - endedAt >= limits.silenceLimitMs)) {
        const result = await dispatch(lane, record, {
          reviewer: lane.reviewer,
          reason: "",
          tier: laneOnOtherLab ? "other-lab" : "same-lab",
        })
        if (result) return result
        continue
      }
      await sleep(pollIntervalMs)
      continue
    }

    // Rule 5: the next other-lab reviewer. The lane's current reviewer goes
    // first when it is an other-lab candidate.
    const ordered = laneOnOtherLab
      ? [otherLab.find((name) => keyOf(name) === keyOf(lane.reviewer)), ...otherLab.filter((name) => keyOf(name) !== keyOf(lane.reviewer))]
      : [...otherLab]
    const lastTry = (name) => {
      const tries = [
        ...attemptsOf(name).map((attempt) => toMs(attempt.startedAt)).filter((value) => value !== null),
        ...(probeFailedAt.has(keyOf(name)) ? [probeFailedAt.get(keyOf(name))] : []),
      ]
      return tries.length > 0 ? Math.max(...tries) : null
    }
    const untried = ordered.filter((name) => {
      const last = lastTry(name)
      return last === null || last < passStart
    })
    const otherLabReason = (name) => {
      if (keyOf(name) === keyOf(lane.reviewer)) return ""
      return includesName(sameLab, lane.reviewer) || record.tier === "same-lab"
        ? FALLBACK_REASONS.OTHER_LAB_RECOVERED
        : FALLBACK_REASONS.NEXT_OTHER_LAB
    }
    const tryOtherLab = async (name) => {
      if (!(await probe(name))) {
        probeFailedAt.set(keyOf(name), now())
        return null
      }
      const result = await dispatch(lane, record, { reviewer: name, reason: otherLabReason(name), tier: "other-lab" })
      return result || "dispatched"
    }

    if (untried.length > 0) {
      const result = await tryOtherLab(untried[0])
      if (result && result !== "dispatched") return result
      continue
    }

    const otherLabAttempts = attempts.filter((attempt) => includesName(otherLab, attempt.reviewer))
    const progressing = otherLabAttempts.some((attempt) => {
      const { last } = signals(attempt)
      return last !== null && t - last < limits.silenceLimitMs
    })

    // Rules 6 and 7: the same-lab tier, or an escalation.
    if (otherLab.length === 0 || (windowPassed && !progressing)) {
      if (record.sameLabChangeRequests >= SAME_LAB_CHANGE_REQUEST_LIMIT) {
        return escalate(lane, record, ESCALATION_REASONS.SAME_LAB_LIMIT)
      }
      let reviewer = ""
      for (const name of sameLab) {
        if (probeFailedAt.has(keyOf(name))) continue
        if (await probe(name)) {
          reviewer = name
          break
        }
        probeFailedAt.set(keyOf(name), now())
      }
      if (!reviewer) return escalate(lane, record, ESCALATION_REASONS.NO_REVIEWER)
      const reason = otherLab.length === 0
        ? FALLBACK_REASONS.NO_OTHER_LAB_CONFIGURED
        : FALLBACK_REASONS.OTHER_LAB_UNAVAILABLE
      const result = await dispatch(lane, record, { reviewer, reason, tier: "same-lab" })
      if (result) return result
      continue
    }

    // Rule 5, re-probe: every other-lab reviewer has been tried and the
    // window is still open. Once the last pass ended a silence limit ago,
    // start a new pass: every candidate is untried again and is visited in
    // order, so one that keeps failing its probe cannot starve the others.
    if (!windowPassed) {
      const ends = [
        ...otherLabAttempts.map((attempt) => toMs(attempt.endedAt)).filter((value) => value !== null),
        ...ordered.map((name) => probeFailedAt.get(keyOf(name))).filter((value) => value !== undefined),
      ]
      const lastEnd = ends.length > 0 ? Math.max(...ends) : requestedAt
      if (t - lastEnd >= limits.silenceLimitMs) {
        passStart = t
        continue
      }
    }

    // Rule 8: wait.
    await sleep(pollIntervalMs)
  }
}
