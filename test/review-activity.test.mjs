// Spec 023 FR-5 and the plan's WS2 step 3 and 4 (task T010): the reviewer's
// pickup and progress signals, and the owner's pickup of a fix-confirmation
// lane. `recordReviewActivity` owns no I/O: these tests pass it an in-memory
// event log, a lane, and a lock, the way `cli.mjs` passes the core functions.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  PROGRESS_MIN_INTERVAL_MS,
  activityKindFor,
  recordReviewActivity,
} from "../src/brain_train/review/activity.mjs"
import { foldReviewRecord } from "../src/brain_train/review/record.mjs"

const HEAD = "a".repeat(40)
const FIX_HEAD = "b".repeat(40)
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0)

function ev(type, { actor = "claude", details, after, at } = {}) {
  return { version: 1, recordedAt: at || new Date(T0).toISOString(), laneId: "e", type, actor, ...(after ? { after } : {}), ...(details ? { details } : {}) }
}

function needsReviewLog({ reviewer = "codex-reviewer" } = {}) {
  return [
    ev("claim", { after: { owner: "claude", reviewer, status: "in-progress" } }),
    ev("review-request", { details: { requestId: "r1", branch: "refs/heads/feat/x", head: HEAD, otherLab: [reviewer], sameLab: [] } }),
    ev("review-attempt", { details: { attemptId: "t1", requestId: "r1", reviewer, previousReviewer: "", reason: "", tier: "other-lab", head: HEAD, opened: "dispatch", by: "btrain-system" } }),
  ]
}

function fixConfirmationLog() {
  return [
    ...needsReviewLog(),
    ev("fix-applied", {
      actor: "codex-reviewer",
      details: { attemptId: "t1", fixBase: HEAD, fixHead: FIX_HEAD, commits: [FIX_HEAD], round: 1, files: ["src/x.mjs"], changedLines: 3 },
    }),
  ]
}

/**
 * An in-memory harness. `events` is the lane's log; `lane` is what
 * `readLane()` returns. The lock records that every read and write happens
 * while it is held.
 */
function harness({ events, lane = { status: "needs-review", owner: "claude", reviewer: "codex-reviewer" }, start = T0 } = {}) {
  const state = { events: [...events], lane: { ...lane }, clock: start, locked: false, lockCalls: 0, unlockedAccess: [] }
  const io = {
    now: () => new Date(state.clock),
    async withLaneLock(fn) {
      state.lockCalls += 1
      assert.equal(state.locked, false, "the lane lock is not re-entered")
      state.locked = true
      try {
        return await fn()
      } finally {
        state.locked = false
      }
    },
    async readLane() {
      if (!state.locked) state.unlockedAccess.push("readLane")
      return { ...state.lane }
    },
    async readEvents() {
      if (!state.locked) state.unlockedAccess.push("readEvents")
      return [...state.events]
    },
    async appendEvent(event) {
      if (!state.locked) state.unlockedAccess.push("appendEvent")
      // appendWorkflowEvent stamps recordedAt; the harness stamps the clock.
      state.events.push({ version: 1, recordedAt: new Date(state.clock).toISOString(), ...event })
    },
  }
  const run = (kind, agentName, { status = "verified", laneId = "e" } = {}) =>
    recordReviewActivity({ laneId, kind, identity: { status, agentName }, ...io })
  const written = () => state.events.slice(events.length)
  return { state, io, run, written, advance: (ms) => (state.clock += ms) }
}

describe("activityKindFor", () => {
  it("maps a bare `btrain handoff` to a pickup and other lane commands to progress", () => {
    assert.equal(activityKindFor("handoff", ""), "pickup")
    assert.equal(activityKindFor("handoff"), "pickup")
    assert.equal(activityKindFor("handoff", "update"), "progress")
    assert.equal(activityKindFor("handoff", "resolve"), "progress")
    assert.equal(activityKindFor("review", "code"), "progress")
    assert.equal(activityKindFor("pr", "poll"), "progress")
    assert.equal(activityKindFor("pr", "create"), "progress")
  })

  it("maps `btrain pr status` and commands that are not lane-scoped handlers to nothing", () => {
    assert.equal(activityKindFor("pr", "status"), "")
    assert.equal(activityKindFor("status", ""), "")
    assert.equal(activityKindFor("loop", ""), "")
    assert.equal(activityKindFor("doctor", ""), "")
    assert.equal(activityKindFor("", ""), "")
  })
})

describe("recordReviewActivity: the reviewer of the open attempt", () => {
  it("writes one pickup for the dispatched reviewer's first `btrain handoff`, and none for the second", async () => {
    const h = harness({ events: needsReviewLog() })
    const first = await h.run("pickup", "codex-reviewer")
    assert.equal(first.written, "review-pickup")
    assert.deepEqual(h.written().map((e) => [e.type, e.actor, e.laneId, e.details.attemptId, e.details.at]), [
      ["review-pickup", "codex-reviewer", "e", "t1", new Date(T0).toISOString()],
    ])

    h.advance(5 * 60_000)
    const second = await h.run("pickup", "codex-reviewer")
    assert.equal(second.written, "")
    assert.equal(h.written().length, 1)
    assert.deepEqual(h.state.unlockedAccess, [])
  })

  it("after the pickup, the fold shows in-review while the stored status stays needs-review", async () => {
    const h = harness({ events: needsReviewLog() })
    await h.run("pickup", "codex-reviewer")
    const record = foldReviewRecord(h.state.events, { status: h.state.lane.status })
    assert.equal(record.display, "in-review")
    assert.equal(h.state.lane.status, "needs-review")
  })

  it("writes one progress for `btrain review code`, none again within a minute, and one after it", async () => {
    const h = harness({ events: needsReviewLog() })
    assert.equal((await h.run("progress", "codex-reviewer")).written, "review-progress")
    h.advance(PROGRESS_MIN_INTERVAL_MS - 1)
    assert.equal((await h.run("progress", "codex-reviewer")).written, "")
    h.advance(1)
    assert.equal((await h.run("progress", "codex-reviewer")).written, "review-progress")
    assert.deepEqual(h.written().map((e) => e.type), ["review-progress", "review-progress"])
    assert.equal(PROGRESS_MIN_INTERVAL_MS, 60_000)
  })

  it("counts the minute from the pickup too", async () => {
    const h = harness({ events: needsReviewLog() })
    await h.run("pickup", "codex-reviewer")
    h.advance(30_000)
    assert.equal((await h.run("progress", "codex-reviewer")).written, "")
    h.advance(30_000)
    assert.equal((await h.run("progress", "codex-reviewer")).written, "review-progress")
  })

  it("writes progress when the last signal's time is in the future (a skewed clock never silences the reviewer)", async () => {
    const h = harness({ events: needsReviewLog() })
    await h.run("pickup", "codex-reviewer")
    h.advance(-10 * 60_000)
    assert.equal((await h.run("progress", "codex-reviewer")).written, "review-progress")
  })

  it("matches the attempt's reviewer without regard to case", async () => {
    const h = harness({ events: needsReviewLog({ reviewer: "Codex-Reviewer" }) })
    assert.equal((await h.run("pickup", "codex-reviewer")).written, "review-pickup")
  })

  it("writes progress for a reviewer that has not picked up, and the display stays needs-review", async () => {
    const h = harness({ events: needsReviewLog() })
    assert.equal((await h.run("progress", "codex-reviewer")).written, "review-progress")
    assert.equal(foldReviewRecord(h.state.events, { status: "needs-review" }).display, "")
  })
})

describe("recordReviewActivity: writes nothing", () => {
  it("for another agent, the lane's owner included", async () => {
    for (const agent of ["claude-reviewer", "claude", "gemini"]) {
      const h = harness({ events: needsReviewLog() })
      assert.equal((await h.run("pickup", agent)).written, "", agent)
      assert.equal((await h.run("progress", agent)).written, "", agent)
      assert.equal(h.written().length, 0, agent)
    }
  })

  it("for an unverified actor, and does not take the lane lock", async () => {
    for (const status of ["unknown", "ambiguous", "unconfigured", ""]) {
      const h = harness({ events: needsReviewLog() })
      const result = await h.run("pickup", "codex-reviewer", { status })
      assert.equal(result.written, "", status)
      assert.equal(h.state.lockCalls, 0, status)
    }
    const h = harness({ events: needsReviewLog() })
    assert.equal((await recordReviewActivity({ laneId: "e", kind: "pickup", ...h.io })).written, "")
    assert.equal((await h.run("pickup", "", { status: "verified" })).written, "")
    assert.equal(h.state.lockCalls, 0)
  })

  it("for `btrain pr status` and other untracked commands, and for no lane, without the lock", async () => {
    const h = harness({ events: needsReviewLog() })
    assert.equal((await h.run(activityKindFor("pr", "status"), "codex-reviewer")).written, "")
    assert.equal((await h.run("pickup", "codex-reviewer", { laneId: "" })).written, "")
    assert.equal((await h.run("bogus", "codex-reviewer")).written, "")
    assert.equal(h.state.lockCalls, 0)
    assert.equal(h.written().length, 0)
  })

  it("when the lane has no open attempt", async () => {
    const ended = [...needsReviewLog(), ev("review-attempt-ended", { details: { attemptId: "t1", outcome: "unresponsive", detail: "" } })]
    const h = harness({ events: ended })
    assert.equal((await h.run("pickup", "codex-reviewer")).written, "")
    assert.equal((await h.run("progress", "codex-reviewer")).written, "")
    assert.equal(foldReviewRecord(h.state.events, { status: "needs-review" }).display, "")

    const none = harness({ events: needsReviewLog().slice(0, 1) })
    assert.equal((await none.run("pickup", "codex-reviewer")).written, "")
  })

  it("when the lane is no longer in needs-review", async () => {
    for (const status of ["ready-for-pr", "changes-requested", "in-progress", "pr-review"]) {
      const h = harness({ events: needsReviewLog(), lane: { status, owner: "claude", reviewer: "codex-reviewer" } })
      assert.equal((await h.run("pickup", "codex-reviewer")).written, "", status)
      assert.equal((await h.run("progress", "codex-reviewer")).written, "", status)
    }
  })

  it("for an attempt from before the lane's last claim", async () => {
    const reclaimed = [...needsReviewLog(), ev("claim", { after: { owner: "claude", reviewer: "codex-reviewer", status: "in-progress" } })]
    const h = harness({ events: reclaimed })
    assert.equal((await h.run("pickup", "codex-reviewer")).written, "")
  })

  it("for the previous reviewer once a lane agent changed the reviewer", async () => {
    const changed = [...needsReviewLog(), ev("update", { details: {}, after: { reviewer: "gemini" } })]
    changed[changed.length - 1].before = { reviewer: "codex-reviewer" }
    const h = harness({ events: changed, lane: { status: "needs-review", owner: "claude", reviewer: "gemini" } })
    assert.equal((await h.run("pickup", "codex-reviewer")).written, "")
    assert.equal((await h.run("pickup", "gemini")).written, "")
  })
})

describe("recordReviewActivity: the owner's pickup of a fix-confirmation lane", () => {
  const lane = { status: "fix-confirmation", owner: "claude", reviewer: "codex-reviewer" }

  it("writes one pickup naming the fix head, and the fold shows confirming-fix", async () => {
    const h = harness({ events: fixConfirmationLog(), lane })
    assert.equal((await h.run("pickup", "claude")).written, "review-pickup")
    const [pickup] = h.written()
    assert.equal(pickup.actor, "claude")
    assert.equal(pickup.details.fixHead, FIX_HEAD)
    assert.equal(pickup.details.attemptId, "t1")
    assert.equal(pickup.details.at, new Date(T0).toISOString())
    assert.equal(foldReviewRecord(h.state.events, { status: "fix-confirmation" }).display, "confirming-fix")

    assert.equal((await h.run("pickup", "claude")).written, "")
    assert.equal(h.written().length, 1)
  })

  it("writes nothing for the fix author, another agent, or a progress command", async () => {
    const h = harness({ events: fixConfirmationLog(), lane })
    assert.equal((await h.run("pickup", "codex-reviewer")).written, "")
    assert.equal((await h.run("pickup", "gemini")).written, "")
    assert.equal((await h.run("progress", "claude")).written, "")
    assert.equal(h.written().length, 0)
  })

  it("writes nothing for an owner who is also the fix author (the fold would never count it)", async () => {
    const h = harness({ events: fixConfirmationLog(), lane: { ...lane, owner: "codex-reviewer" } })
    assert.equal((await h.run("pickup", "codex-reviewer")).written, "")
    assert.equal(h.written().length, 0)
  })

  it("writes nothing once the fix is confirmed, or when the lane is not in fix-confirmation", async () => {
    const confirmed = [...fixConfirmationLog(), ev("fix-confirmed", { details: { how: "confirm-fix", fixHead: FIX_HEAD } })]
    assert.equal((await harness({ events: confirmed, lane }).run("pickup", "claude")).written, "")
    const elsewhere = harness({ events: fixConfirmationLog(), lane: { ...lane, status: "in-progress" } })
    assert.equal((await elsewhere.run("pickup", "claude")).written, "")
  })

  it("omits the attempt id when the fix has none, and the fold still counts the pickup", async () => {
    const log = fixConfirmationLog()
    delete log[log.length - 1].details.attemptId
    log.splice(2, 1) // no attempt at all: a fix recorded before the request loop
    const h = harness({ events: log, lane })
    assert.equal((await h.run("pickup", "claude")).written, "review-pickup")
    const [pickup] = h.written()
    assert.equal("attemptId" in pickup.details, false)
    assert.equal(pickup.details.fixHead, FIX_HEAD)
    assert.equal(foldReviewRecord(h.state.events, { status: "fix-confirmation" }).display, "confirming-fix")
  })
})
