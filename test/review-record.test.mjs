// Spec 023 FR-5, FR-6, FR-13: the review record folded from a lane's workflow
// events (plan WS2, T009). Each sequence follows the plan's "Data model".
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  activeAttempt,
  attemptsForCurrentRequest,
  eventsSinceLastClaim,
  foldReviewRecord,
  unacknowledgedLateReviews,
} from "../src/brain_train/review/record.mjs"

let clock = 0
function at() {
  clock += 1
  return new Date(Date.UTC(2026, 10, 23, 12, 0, clock)).toISOString()
}

function ev(type, { actor = "owner", details, before, after } = {}) {
  return {
    version: 1,
    recordedAt: at(),
    type,
    actor,
    laneId: "a",
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(details ? { details } : {}),
  }
}

const claim = () => ev("claim", { after: { owner: "owner", reviewer: "codex-reviewer", status: "in-progress" } })
const request = (requestId, head = "a".repeat(40)) =>
  ev("review-request", { details: { requestId, branch: "refs/heads/feat/x", head, requestedAt: "", otherLab: ["codex-reviewer", "gem"], sameLab: ["claude-reviewer"] } })
const attempt = (attemptId, reviewer, { tier = "other-lab", reason = "", previousReviewer = "", requestId = "r1", opened = "dispatch" } = {}) =>
  ev("review-attempt", { details: { attemptId, requestId, reviewer, previousReviewer, reason, tier, head: "a".repeat(40), startedAt: "", opened, by: "btrain-system" } })
const pickup = (attemptId, actor) => ev("review-pickup", { actor, details: { attemptId, at: at() } })
const progress = (attemptId, actor) => ev("review-progress", { actor, details: { attemptId, at: at() } })
const ended = (attemptId, outcome, detail = "") => ev("review-attempt-ended", { details: { attemptId, outcome, detail } })

describe("foldReviewRecord", () => {
  it("is empty for a lane with no review events", () => {
    const record = foldReviewRecord([claim()])
    assert.equal(record.request, null)
    assert.deepEqual(record.attempts, [])
    assert.equal(record.activeAttemptId, "")
    assert.equal(record.display, "")
    assert.equal(foldReviewRecord(undefined).display, "")
  })

  it("records a request and a dispatched attempt, then pickup and progress", () => {
    const pick = pickup("t1", "codex-reviewer")
    const prog = progress("t1", "codex-reviewer")
    const record = foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer"), pick, prog])
    assert.equal(record.request.id, "r1")
    assert.equal(record.request.branch, "refs/heads/feat/x")
    assert.deepEqual(record.request.otherLab, ["codex-reviewer", "gem"])
    assert.equal(record.activeAttemptId, "t1")
    assert.equal(record.tier, "other-lab")
    assert.equal(record.fallbackReason, "")
    const active = activeAttempt(record)
    assert.equal(active.reviewer, "codex-reviewer")
    assert.equal(active.pickedUpAt, pick.details.at)
    assert.equal(active.lastProgressAt, prog.details.at)
    assert.equal(record.display, "in-review")
  })

  it("keeps the first pickup time when a reviewer picks up twice", () => {
    const first = pickup("t1", "codex-reviewer")
    const record = foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer"), first, pickup("t1", "codex-reviewer")])
    assert.equal(activeAttempt(record).pickedUpAt, first.details.at)
  })

  it("shows no display state before pickup", () => {
    assert.equal(foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer")]).display, "")
  })

  it("ends an attempt without a verdict and clears the display", () => {
    const record = foldReviewRecord([
      claim(), request("r1"), attempt("t1", "codex-reviewer"), pickup("t1", "codex-reviewer"), ended("t1", "unresponsive", "no-progress"),
    ])
    assert.equal(record.activeAttemptId, "")
    assert.equal(record.attempts[0].outcome, "unresponsive")
    assert.equal(record.attempts[0].outcomeDetail, "no-progress")
    assert.equal(record.display, "")
  })

  it("ignores pickup and progress for an attempt that has ended", () => {
    const record = foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer"), ended("t1", "failed"), pickup("t1", "codex-reviewer")])
    assert.equal(record.attempts[0].pickedUpAt, "")
    assert.equal(record.display, "")
  })

  it("records a fallback to the next other-lab reviewer, then to the same lab with its reason", () => {
    const record = foldReviewRecord([
      claim(),
      request("r1"),
      attempt("t1", "codex-reviewer"),
      ended("t1", "tool_unavailable"),
      attempt("t2", "gem", { previousReviewer: "codex-reviewer", reason: "next-other-lab" }),
      ended("t2", "unresponsive"),
      attempt("t3", "claude-reviewer", { previousReviewer: "gem", reason: "other-lab-unavailable", tier: "same-lab" }),
    ])
    assert.deepEqual(record.attempts.map((item) => [item.id, item.outcome]), [["t1", "tool_unavailable"], ["t2", "unresponsive"], ["t3", ""]])
    assert.equal(record.tier, "same-lab")
    assert.equal(record.fallbackReason, "other-lab-unavailable")
    assert.deepEqual(attemptsForCurrentRequest(record).map((item) => item.reviewer), ["codex-reviewer", "gem", "claude-reviewer"])
  })

  it("supersedes an open attempt when a new attempt starts without an end event", () => {
    const record = foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer"), attempt("t2", "gem", { reason: "next-other-lab" })])
    assert.equal(record.attempts[0].outcome, "superseded")
    assert.equal(record.activeAttemptId, "t2")
    assert.equal(record.tier, "other-lab")
  })

  it("supersedes the open attempt on a new request (the owner moved the head)", () => {
    const record = foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer"), request("r2", "b".repeat(40))])
    assert.equal(record.attempts[0].outcome, "superseded")
    assert.equal(record.attempts[0].outcomeDetail, "new-request")
    assert.equal(record.request.id, "r2")
    assert.equal(record.requests.length, 2)
    assert.deepEqual(attemptsForCurrentRequest(record), [])
  })

  it("ends the open attempt when a lane agent changes the reviewer with handoff update", () => {
    const record = foldReviewRecord([
      claim(), request("r1"), attempt("t1", "codex-reviewer"), pickup("t1", "codex-reviewer"),
      ev("update", { before: { reviewer: "codex-reviewer", status: "needs-review" }, after: { reviewer: "gem", status: "needs-review" } }),
    ])
    assert.equal(record.attempts[0].outcome, "superseded")
    assert.equal(record.attempts[0].outcomeDetail, "reviewer-changed")
    assert.equal(record.display, "")
  })

  it("keeps the open attempt on an update that leaves the reviewer alone", () => {
    const record = foldReviewRecord([
      claim(), request("r1"), attempt("t1", "codex-reviewer"),
      ev("update", { before: { reviewer: "codex-reviewer" }, after: { reviewer: "codex-reviewer" } }),
    ])
    assert.equal(record.activeAttemptId, "t1")
  })

  it("closes the active attempt with a verdict", () => {
    const approved = foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer"), ev("resolve", { actor: "codex-reviewer", details: { attemptId: "t1", tier: "other-lab" } })])
    assert.equal(approved.attempts[0].outcome, "verdict")
    assert.equal(approved.attempts[0].verdict, "resolve")
    assert.equal(approved.activeAttemptId, "")
  })

  it("does not close the active attempt for a verdict that names another attempt", () => {
    const record = foldReviewRecord([
      claim(), request("r1"), attempt("t1", "codex-reviewer"), ended("t1", "unresponsive"), attempt("t2", "gem"),
      ev("resolve", { actor: "codex-reviewer", details: { attemptId: "t1" } }),
    ])
    assert.equal(record.activeAttemptId, "t2")
    assert.equal(record.attempts[0].outcome, "unresponsive")
  })

  it("counts same-lab requests for changes from the event's tier or the attempt's", () => {
    const record = foldReviewRecord([
      claim(), request("r1"),
      attempt("t1", "claude-reviewer", { tier: "same-lab", reason: "no-other-lab-configured" }),
      ev("request-changes", { actor: "claude-reviewer", details: { attemptId: "t1" } }),
      request("r2", "b".repeat(40)),
      attempt("t2", "claude-reviewer", { tier: "same-lab", requestId: "r2" }),
      ev("request-changes", { actor: "claude-reviewer", details: { attemptId: "t2", tier: "same-lab" } }),
      request("r3", "c".repeat(40)),
      attempt("t3", "codex-reviewer", { requestId: "r3" }),
      ev("request-changes", { actor: "codex-reviewer", details: { attemptId: "t3", tier: "other-lab" } }),
    ])
    assert.equal(record.sameLabChangeRequests, 2)
  })

  it("records a reviewer fix, its author, its round, and the owner's pickup and confirmation", () => {
    const fixApplied = ev("fix-applied", {
      actor: "codex-reviewer",
      details: { attemptId: "t1", fixBase: "a".repeat(40), fixHead: "d".repeat(40), commits: ["d".repeat(40)], round: 1, files: ["src/x.mjs"], changedLines: 4 },
    })
    const ownerPickup = ev("review-pickup", { actor: "owner", details: { fixHead: "d".repeat(40), at: at() } })
    const base = [claim(), request("r1"), attempt("t1", "codex-reviewer"), pickup("t1", "codex-reviewer"), fixApplied]

    const pending = foldReviewRecord(base)
    assert.equal(pending.attempts[0].verdict, "fix")
    assert.deepEqual(pending.fixAuthors, ["codex-reviewer"])
    assert.equal(pending.fixRounds, 1)
    assert.equal(pending.fix.base, "a".repeat(40))
    assert.equal(pending.fix.head, "d".repeat(40))
    assert.equal(pending.fix.confirmed, false)
    assert.equal(pending.display, "")

    const confirming = foldReviewRecord([...base, ownerPickup], { status: "fix-confirmation" })
    assert.equal(confirming.display, "confirming-fix")

    const confirmed = foldReviewRecord([...base, ownerPickup, ev("fix-confirmed", { details: { how: "confirm-fix", fixHead: "d".repeat(40) } })])
    assert.equal(confirmed.fix.confirmed, true)
    assert.equal(confirmed.fix.how, "confirm-fix")
    assert.equal(confirmed.display, "")
  })

  it("counts fix rounds when the event has no round", () => {
    const fix = () => ev("fix-applied", { actor: "codex-reviewer", details: { fixBase: "a", fixHead: "b" } })
    const record = foldReviewRecord([claim(), fix(), fix()])
    assert.equal(record.fixRounds, 2)
    assert.deepEqual(record.fixAuthors, ["codex-reviewer"])
  })

  it("lets a duplicate or stale verdict change nothing", () => {
    const changes = (attemptId) => ev("request-changes", { actor: "claude-reviewer", details: { attemptId, tier: "same-lab" } })
    const twice = foldReviewRecord([claim(), request("r1"), attempt("t1", "claude-reviewer", { tier: "same-lab", reason: "other-lab-unavailable" }), changes("t1"), changes("t1")])
    assert.equal(twice.sameLabChangeRequests, 1, "the same verdict twice is one round")

    const stale = foldReviewRecord([
      claim(), request("r1"), attempt("t1", "claude-reviewer", { tier: "same-lab" }), ended("t1", "failed"),
      attempt("t2", "claude-reviewer", { tier: "same-lab" }), changes("t1"),
    ])
    assert.equal(stale.sameLabChangeRequests, 0, "a verdict for an ended attempt is not a round")
    assert.equal(stale.activeAttemptId, "t2", "and it leaves the active attempt open")

    const fix = (round) => ev("fix-applied", { actor: "codex-reviewer", details: { attemptId: "t1", fixBase: "a", fixHead: "b", round } })
    const fixTwice = foldReviewRecord([claim(), request("r1"), attempt("t1", "codex-reviewer"), fix(1), fix(1)])
    assert.equal(fixTwice.fixRounds, 1)
  })

  it("keeps a recorded fallback reason through a later same-lab attempt with no reason, and clears it for an other-lab one", () => {
    const base = [
      claim(), request("r1"),
      attempt("t1", "codex-reviewer"), ended("t1", "tool_unavailable"),
      attempt("t2", "claude-reviewer", { tier: "same-lab", reason: "other-lab-unavailable", previousReviewer: "codex-reviewer" }), ended("t2", "unresponsive"),
      attempt("t3", "claude-reviewer", { tier: "same-lab", reason: "" }),
    ]
    assert.equal(foldReviewRecord(base).fallbackReason, "other-lab-unavailable")
    const recovered = foldReviewRecord([...base, attempt("t4", "codex-reviewer", { reason: "other-lab-recovered", previousReviewer: "claude-reviewer" })])
    assert.equal(recovered.fallbackReason, "")
    assert.equal(recovered.tier, "other-lab")
  })

  it("starts each request with no tier and no fallback reason", () => {
    const record = foldReviewRecord([
      claim(), request("r1"),
      attempt("t1", "claude-reviewer", { tier: "same-lab", reason: "other-lab-unavailable" }),
      ev("request-changes", { actor: "claude-reviewer", details: { attemptId: "t1" } }),
      request("r2", "b".repeat(40)),
    ])
    assert.equal(record.tier, "")
    assert.equal(record.fallbackReason, "")
  })

  it("does not count the fix author's own pickup as the owner's", () => {
    const record = foldReviewRecord([
      claim(), request("r1"), attempt("t1", "codex-reviewer"),
      ev("fix-applied", { actor: "codex-reviewer", details: { attemptId: "t1", fixBase: "a", fixHead: "b", round: 1 } }),
      ev("review-pickup", { actor: "codex-reviewer", details: { attemptId: "t1", at: at() } }),
    ], { status: "fix-confirmation" })
    assert.equal(record.fix.pickedUpAt, "")
    assert.equal(record.display, "")
  })

  it("counts the owner's pickup that names the attempt of an unconfirmed fix", () => {
    const record = foldReviewRecord([
      claim(), request("r1"), attempt("t1", "codex-reviewer"), pickup("t1", "codex-reviewer"),
      ev("fix-applied", { actor: "codex-reviewer", details: { attemptId: "t1", fixBase: "a", fixHead: "b", round: 1 } }),
      ev("review-pickup", { actor: "owner", details: { attemptId: "t1", at: at() } }),
    ], { status: "fix-confirmation" })
    assert.equal(record.display, "confirming-fix")
    assert.ok(record.fix.pickedUpAt)
  })

  it("records late reviews and their acknowledgement", () => {
    const late = (attemptId, verdict) => ev("late-review", { actor: "codex-reviewer", details: { attemptId, verdict, head: "a".repeat(40), summary: "found a bug" } })
    const one = foldReviewRecord([claim(), late("t1", "request-changes"), late("t2", "resolve")])
    assert.equal(unacknowledgedLateReviews(one).length, 2)
    assert.equal(one.lateReviews[0].reviewer, "codex-reviewer")

    const partial = foldReviewRecord([claim(), late("t1", "request-changes"), late("t2", "resolve"), ev("late-review-ack", { details: { attemptId: "t1" } })])
    assert.deepEqual(unacknowledgedLateReviews(partial).map((item) => item.attemptId), ["t2"])

    const all = foldReviewRecord([claim(), late("t1", "request-changes"), late("t2", "resolve"), ev("late-review-ack", { details: {} })])
    assert.deepEqual(unacknowledgedLateReviews(all), [])
  })

  it("records escalations", () => {
    const record = foldReviewRecord([claim(), request("r1"), ev("review-escalation", { details: { requestId: "r1", reason: "pr-linked" } })])
    assert.deepEqual(record.escalations.map((item) => item.reason), ["pr-linked"])
  })

  it("ignores every event before the lane's last claim", () => {
    const old = [claim(), request("r0"), attempt("t0", "codex-reviewer"), pickup("t0", "codex-reviewer"),
      ev("fix-applied", { actor: "codex-reviewer", details: { fixBase: "a", fixHead: "b" } }),
      ev("late-review", { actor: "gem", details: { attemptId: "t0", verdict: "request-changes" } })]
    const record = foldReviewRecord([...old, claim(), request("r1")])
    assert.equal(record.request.id, "r1")
    assert.deepEqual(record.attempts, [])
    assert.equal(record.fix, null)
    assert.deepEqual(record.fixAuthors, [])
    assert.deepEqual(record.lateReviews, [])
    assert.equal(record.display, "")
    assert.equal(eventsSinceLastClaim([...old, claim(), request("r1")]).length, 1)
  })

  it("shows in-review only while the stored status is needs-review", () => {
    const events = [claim(), request("r1"), attempt("t1", "codex-reviewer"), pickup("t1", "codex-reviewer")]
    assert.equal(foldReviewRecord(events, { status: "needs-review" }).display, "in-review")
    assert.equal(foldReviewRecord(events, { status: "changes-requested" }).display, "")
  })
})
