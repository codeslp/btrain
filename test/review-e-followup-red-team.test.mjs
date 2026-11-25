// Spec 023 FR-4 to FR-8, plan "Review request loop" and WS5 tests, through
// src/brain_train/review/request.mjs (task T022). Every case runs the loop
// against an in-memory lane and event log with the fake clock, so a
// 15-minute window runs in milliseconds; one case starts the real fake runner
// to show that ending an attempt stops its process.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { runReviewRequest } from "../src/brain_train/review/request.mjs"
import { foldReviewRecord } from "../src/brain_train/review/record.mjs"
import { createFakeClock } from "./helpers/fake-clock.mjs"
import { fakeRunnerEnv, installFakeRunner, readFakeRunnerLog, writeFakeRunnerScenario } from "./helpers/fake-runner.mjs"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"

const MIN = 60_000
const POLICY = { otherLabWindowMs: 15 * MIN, silenceLimitMs: 5 * MIN, attemptMaxMs: 45 * MIN }
const OWNER = "claude"
const A = "codex-reviewer"
const B = "gem"
const SAME = "claude-reviewer"
const QUOTA_TAIL = "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 9:30 PM."

/**
 * An in-memory lane, event log, and runner. `behaviors` maps a reviewer to:
 *   "silent"                 runs until aborted, no pickup, no output
 *   "quota" | "fail" | "exit0"  exits at once (codex quota tail, code 2, code 0)
 *   { pickupAtMs, outputUntilMs }  picks up, then prints every minute until outputUntilMs
 *   { verdictAtMs, verdict }      gives a verdict ("resolve" or "request-changes") then exits 0
 */
function createWorld({ clock, reviewer = A, behaviors = {}, prNumber = "", events: extraEvents = [], refuse = null, head = "h1" }) {
  const lane = { status: "needs-review", owner: OWNER, reviewer, prNumber, head, branch: "refs/heads/feat/x", headMovedByReviewer: false }
  const events = [
    { type: "claim", actor: OWNER, recordedAt: clock.iso(), after: { owner: OWNER, reviewer, status: "in-progress" } },
    { type: "review-request", actor: OWNER, recordedAt: clock.iso(), details: { requestId: "r1", branch: lane.branch, head: "h1", requestedAt: clock.iso() } },
    ...extraEvents,
  ]
  const dispatched = []
  const aborted = []
  const starts = []
  return {
    lane,
    events,
    dispatched,
    aborted,
    starts,
    readEvents: async () => events.map((event) => ({ ...event })),
    writeEvent: async (event) => {
      events.push({ recordedAt: clock.iso(), laneId: "a", ...event })
    },
    readLane: async () => ({ ...lane }),
    startAttempt: async (args) => {
      starts.push(args)
      if (refuse && refuse(args)) return { ok: false, reason: "reassignment-refused" }
      lane.reviewer = args.reviewer
      events.push({
        type: "review-attempt", actor: OWNER, recordedAt: clock.iso(), laneId: "a",
        details: { attemptId: args.attemptId, requestId: args.requestId, reviewer: args.reviewer, previousReviewer: args.previousReviewer, reason: args.reason, tier: args.tier, head: args.head, startedAt: args.startedAt, opened: args.opened, by: "btrain-system" },
      })
      // Invariant 4: the recorded reviewer is the active attempt's reviewer.
      const record = foldReviewRecord(events)
      const active = record.attempts.find((attempt) => attempt.id === record.activeAttemptId)
      assert.equal(lane.reviewer, active.reviewer)
      return { ok: true }
    },
    runAttempt: async ({ reviewer: who, attemptId, signal, tier, sameLab }) => {
      dispatched.push({ reviewer: who, attemptId, at: clock.elapsed(), tier, sameLab })
      const behavior = behaviors[who] || "silent"
      const startedAt = clock.now()
      let lastOutputAt = null
      let settle
      const exit = new Promise((resolve) => { settle = resolve })
      signal.addEventListener("abort", () => {
        aborted.push(attemptId)
        settle({ exitCode: null })
      })
      const handle = (tail = "", executable = "codex") => ({ exit, tail: () => tail, lastOutputAt: () => lastOutputAt, executable })
      if (behavior === "quota") { settle({ exitCode: 1 }); return handle(QUOTA_TAIL) }
      if (behavior === "fail") { settle({ exitCode: 2 }); return handle("panic") }
      if (behavior === "exit0") { settle({ exitCode: 0 }); return handle("done") }
      if (behavior && typeof behavior === "object" && typeof behavior.pickupAtMs === "number") {
        clock.atTime(startedAt + behavior.pickupAtMs, () => {
          events.push({ type: "review-pickup", actor: who, recordedAt: clock.iso(), laneId: "a", details: { attemptId, at: clock.iso() } })
          lastOutputAt = clock.now()
        })
        for (let minute = 1; minute * MIN <= (behavior.outputUntilMs ?? 0); minute += 1) {
          clock.atTime(startedAt + minute * MIN, () => { lastOutputAt = clock.now() })
        }
      }
      if (behavior && typeof behavior === "object" && typeof behavior.verdictAtMs === "number") {
        clock.atTime(startedAt + behavior.verdictAtMs, () => {
          const verdict = behavior.verdict || "resolve"
          lane.status = verdict === "resolve" ? "ready-for-pr" : "changes-requested"
          events.push({ type: verdict, actor: who, recordedAt: clock.iso(), laneId: "a", details: { attemptId, tier } })
          settle({ exitCode: 0 })
        })
      }
      return handle()
    },
    now: clock.now,
    // A loop that never returns would run on the fake clock forever and keep
    // the test process alive after its timeout; after six simulated hours the
    // world's sleep throws, so such a loop fails its test (lane review M18).
    sleep: async (ms) => {
      if (clock.elapsed() > 6 * 60 * MIN) throw new Error("runaway request loop: six simulated hours")
      return clock.sleep(ms)
    },
  }
}

let ids = 0
const newId = () => `t${(ids += 1)}`

async function run(world, options = {}) {
  return runReviewRequest({
    candidates: { otherLab: [A, B], sameLab: [SAME] },
    policy: POLICY,
    newId,
    pollIntervalMs: 15_000,
    ...world,
    ...options,
  })
}

const ended = (world) => world.events.filter((event) => event.type === "review-attempt-ended").map((event) => [event.details.outcome, event.details.detail])

// A hung loop fails its test instead of wedging the suite (node --test has no
// default timeout); the lane review's mutants M15 and M18 hung without it.
const TIMEOUT = { timeout: 20_000 }


it("does not dispatch a third same-lab round for a linked PR", async () => {
  const clock = createFakeClock()
  const w = createWorld({ clock, reviewer: SAME, prNumber: "42" })
  const prior = []
  for (let i = 0; i < 2; i += 1) prior.push(
    { type: "review-attempt", actor: OWNER, recordedAt: clock.iso(), details: { attemptId: `prior${i}`, requestId: `old${i}`, reviewer: SAME, tier: "same-lab", head: "h0", startedAt: clock.iso() } },
    { type: "request-changes", actor: SAME, recordedAt: clock.iso(), details: { attemptId: `prior${i}`, tier: "same-lab" } },
  )
  w.events.splice(1, 0, ...prior)
  assert.equal(foldReviewRecord(w.events).sameLabChangeRequests, 2)
  const result = await run(w, { maxAttempts: 1 })
  assert.deepEqual(result, { outcome: "escalation", reason: "same-lab-limit" })
  assert.equal(w.dispatched.length, 0)
})

it("preserves the verdict runner after an owner metadata-only update", async () => {
  const clock = createFakeClock()
  const w = createWorld({ clock })
  let changed = false
  w.sleep = async (ms) => {
    if (!changed) {
      changed = true
      w.events.push(
        { type: "resolve", actor: A, recordedAt: clock.iso(), before: { status: "needs-review", reviewer: A }, after: { status: "ready-for-pr", reviewer: A } },
        { type: "update", actor: OWNER, recordedAt: clock.iso(), before: { status: "ready-for-pr", reviewer: A }, after: { status: "ready-for-pr", reviewer: A } },
      )
      w.lane.status = "ready-for-pr"
    }
    return clock.sleep(ms)
  }
  assert.deepEqual(await run(w), { outcome: "verdict", status: "ready-for-pr" })
  assert.deepEqual(w.aborted, [], "the verdict runner must be allowed to finish")
})
