// Spec 023 FR-5, FR-6, FR-13: the review record of a lane, folded from the
// lane's workflow event log. No new state file: every fact here is an event in
// `.btrain/events/lane-<id>.jsonl` (implementation plan, "Data model").
// Pure: takes the events, returns the record. No import of core.mjs.
//
// Only events after the lane's last `claim` count. An earlier task's attempts,
// fixes, and late reviews never leak into the current one.

export const REVIEW_EVENT_TYPES = Object.freeze([
  "review-request",
  "review-attempt",
  "review-pickup",
  "review-progress",
  "review-attempt-ended",
  "review-escalation",
  "late-review",
  "late-review-ack",
  "fix-applied",
  "fix-confirmed",
])

export const ATTEMPT_OUTCOMES = Object.freeze([
  "tool_unavailable",
  "policy_blocked",
  "unresponsive",
  "failed",
  "stopped-at-max",
  "superseded",
])

export const DISPLAY_STATES = Object.freeze({
  IN_REVIEW: "in-review",
  CONFIRMING_FIX: "confirming-fix",
})

function keyOf(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function detailsOf(event) {
  return event?.details && typeof event.details === "object" ? event.details : {}
}

function timeOf(event, details) {
  return details.at || details.startedAt || event?.recordedAt || ""
}

/** The events after the lane's last `claim`, in log order. */
export function eventsSinceLastClaim(events) {
  const list = Array.isArray(events) ? events : []
  let lastClaim = -1
  list.forEach((event, index) => {
    if (event?.type === "claim") lastClaim = index
  })
  return list.slice(lastClaim + 1)
}

function emptyRecord() {
  return {
    request: null,
    requests: [],
    attempts: [],
    activeAttemptId: "",
    tier: "",
    fallbackReason: "",
    sameLabChangeRequests: 0,
    fix: null,
    fixAuthors: [],
    fixRounds: 0,
    lateReviews: [],
    escalations: [],
    display: "",
  }
}

/**
 * Fold a lane's workflow events into its review record.
 *
 * `status`, when given, is the lane's stored status. It only narrows
 * `display`: `in-review` needs `needs-review`, and `confirming-fix` needs
 * `fix-confirmation`. The stored status itself is never changed or replaced.
 */
export function foldReviewRecord(events, { status } = {}) {
  const record = emptyRecord()
  const byId = new Map()

  const active = () => (record.activeAttemptId ? byId.get(record.activeAttemptId) : null)
  const endAttempt = (attempt, outcome, { detail = "", at = "", verdict = "" } = {}) => {
    if (!attempt || attempt.outcome) return
    attempt.outcome = outcome
    attempt.outcomeDetail = detail
    attempt.endedAt = at
    if (verdict) attempt.verdict = verdict
    if (record.activeAttemptId === attempt.id) record.activeAttemptId = ""
  }
  const endVerdict = (event, verdict) => {
    const details = detailsOf(event)
    const target = details.attemptId ? byId.get(details.attemptId) : active()
    // A verdict naming an attempt that is not the active one does not close the
    // active attempt; a late verdict is recorded with its own event (FR-6).
    if (!target || (details.attemptId && target.id !== record.activeAttemptId)) return target || null
    endAttempt(target, "verdict", { at: event.recordedAt || "", verdict })
    return target
  }

  for (const event of eventsSinceLastClaim(events)) {
    const details = detailsOf(event)
    switch (event?.type) {
      case "review-request": {
        endAttempt(active(), "superseded", { detail: "new-request", at: event.recordedAt || "" })
        const request = {
          id: String(details.requestId || ""),
          branch: String(details.branch || ""),
          head: String(details.head || ""),
          requestedAt: String(details.requestedAt || event.recordedAt || ""),
          otherLab: Array.isArray(details.otherLab) ? [...details.otherLab] : [],
          sameLab: Array.isArray(details.sameLab) ? [...details.sameLab] : [],
        }
        record.requests.push(request)
        record.request = request
        break
      }
      case "review-attempt": {
        const previous = active()
        const attempt = {
          id: String(details.attemptId || ""),
          requestId: String(details.requestId || record.request?.id || ""),
          reviewer: String(details.reviewer || ""),
          previousReviewer: String(details.previousReviewer || ""),
          reason: String(details.reason || ""),
          tier: String(details.tier || ""),
          head: String(details.head || ""),
          startedAt: String(details.startedAt || event.recordedAt || ""),
          opened: String(details.opened || ""),
          by: String(details.by || ""),
          pickedUpAt: "",
          lastProgressAt: "",
          outcome: "",
          outcomeDetail: "",
          endedAt: "",
          verdict: "",
        }
        if (previous && previous.id !== attempt.id) {
          endAttempt(previous, "superseded", { detail: "new-attempt", at: attempt.startedAt })
        }
        if (attempt.id) byId.set(attempt.id, attempt)
        record.attempts.push(attempt)
        record.activeAttemptId = attempt.id
        record.tier = attempt.tier
        // A fallback is an attempt whose reviewer differs from the previous
        // one; only a same-lab one carries a fallback reason for display.
        record.fallbackReason = attempt.tier === "same-lab" ? attempt.reason : ""
        break
      }
      case "review-pickup": {
        const at = timeOf(event, details)
        if (!details.attemptId && details.fixHead && record.fix) {
          // The owner's pickup of a fix-confirmation lane (WS2, T010).
          if (!record.fix.pickedUpAt) record.fix.pickedUpAt = at
          break
        }
        const attempt = byId.get(details.attemptId)
        if (!attempt || attempt.outcome) break
        if (!attempt.pickedUpAt) attempt.pickedUpAt = at
        attempt.lastProgressAt = at
        break
      }
      case "review-progress": {
        const attempt = byId.get(details.attemptId)
        if (!attempt || attempt.outcome) break
        attempt.lastProgressAt = timeOf(event, details)
        break
      }
      case "review-attempt-ended": {
        endAttempt(byId.get(details.attemptId), String(details.outcome || "failed"), {
          detail: String(details.detail || ""),
          at: event.recordedAt || "",
        })
        break
      }
      case "update": {
        // A lane agent that changes the reviewer during an open request ends
        // the open attempt (plan, "Data model"). The loop's own reassignment
        // is a `review-attempt` event, not an `update`.
        const before = event.before || {}
        const after = event.after || {}
        const current = active()
        if (current && keyOf(before.reviewer) !== keyOf(after.reviewer) && keyOf(after.reviewer) !== keyOf(current.reviewer)) {
          endAttempt(current, "superseded", { detail: "reviewer-changed", at: event.recordedAt || "" })
        }
        break
      }
      case "resolve": {
        endVerdict(event, "resolve")
        break
      }
      case "request-changes": {
        const attempt = endVerdict(event, "request-changes")
        const tier = String(details.tier || attempt?.tier || "")
        if (tier === "same-lab") record.sameLabChangeRequests += 1
        break
      }
      case "fix-applied": {
        const attempt = endVerdict(event, "fix")
        const round = Number(details.round)
        record.fixRounds = Number.isInteger(round) && round > record.fixRounds ? round : record.fixRounds + 1
        record.fix = {
          attemptId: String(details.attemptId || attempt?.id || ""),
          base: String(details.fixBase || ""),
          head: String(details.fixHead || ""),
          commits: Array.isArray(details.commits) ? [...details.commits] : [],
          files: Array.isArray(details.files) ? [...details.files] : [],
          changedLines: Number(details.changedLines) || 0,
          round: record.fixRounds,
          author: String(event.actor || ""),
          confirmed: false,
          how: "",
          pickedUpAt: "",
        }
        const author = String(event.actor || "").trim()
        if (author && !record.fixAuthors.some((name) => keyOf(name) === keyOf(author))) {
          record.fixAuthors.push(author)
        }
        break
      }
      case "fix-confirmed": {
        if (record.fix) {
          record.fix.confirmed = true
          record.fix.how = String(details.how || "")
        }
        break
      }
      case "late-review": {
        record.lateReviews.push({
          attemptId: String(details.attemptId || ""),
          verdict: String(details.verdict || ""),
          head: String(details.head || ""),
          summary: String(details.summary || ""),
          reviewer: String(event.actor || ""),
          recordedAt: String(event.recordedAt || ""),
          acknowledged: false,
        })
        break
      }
      case "late-review-ack": {
        const ids = Array.isArray(details.attemptIds) ? details.attemptIds.map(String) : details.attemptId ? [String(details.attemptId)] : null
        for (const late of record.lateReviews) {
          if (!ids || ids.includes(late.attemptId)) late.acknowledged = true
        }
        break
      }
      case "review-escalation": {
        record.escalations.push({
          requestId: String(details.requestId || ""),
          reason: String(details.reason || ""),
          recordedAt: String(event.recordedAt || ""),
        })
        break
      }
      default:
        break
    }
  }

  const current = active()
  const statusKnown = typeof status === "string" && status !== ""
  if (current?.pickedUpAt && (!statusKnown || status === "needs-review")) {
    record.display = DISPLAY_STATES.IN_REVIEW
  } else if (record.fix && !record.fix.confirmed && record.fix.pickedUpAt && (!statusKnown || status === "fix-confirmation")) {
    record.display = DISPLAY_STATES.CONFIRMING_FIX
  }
  return record
}

/** The active attempt of a record, or null. */
export function activeAttempt(record) {
  if (!record?.activeAttemptId) return null
  return record.attempts.find((attempt) => attempt.id === record.activeAttemptId) || null
}

/** The attempts of the record's current request, in order. */
export function attemptsForCurrentRequest(record) {
  if (!record?.request) return []
  return record.attempts.filter((attempt) => attempt.requestId === record.request.id)
}

/** Late reviews not yet acknowledged by the owner. */
export function unacknowledgedLateReviews(record) {
  return (record?.lateReviews || []).filter((late) => !late.acknowledged)
}
