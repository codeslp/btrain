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

describe("runReviewRequest", TIMEOUT, () => {
  it("returns the new status once a verdict arrives, without dispatching again", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: { pickupAtMs: 30_000, outputUntilMs: 3 * MIN, verdictAtMs: 3 * MIN } } })
    assert.deepEqual(await run(world), { outcome: "verdict", status: "ready-for-pr" })
    assert.deepEqual(world.dispatched.map((item) => item.reviewer), [A])
    assert.equal(world.starts[0].reason, "", "a review-attempt that keeps the reviewer has no reason")
  })

  it("ends a quota exit as tool_unavailable and dispatches the next other-lab reviewer at once", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: "quota", [B]: { pickupAtMs: 30_000, outputUntilMs: MIN, verdictAtMs: MIN } } })
    assert.equal((await run(world)).outcome, "verdict")
    assert.deepEqual(ended(world), [["tool_unavailable", "quota"]])
    assert.deepEqual(world.dispatched.map((item) => [item.reviewer, item.at]), [[A, 0], [B, 0]])
    assert.equal(world.starts[1].reason, "next-other-lab")
    assert.equal(world.starts[1].previousReviewer, A)
  })

  it("assigns no same-lab reviewer before the window, then one outside the author history with its reason", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock })
    assert.deepEqual(await run(world), { outcome: "same-lab-ended" })
    const sameLab = world.dispatched.filter((item) => item.reviewer === SAME)
    assert.equal(sameLab.length, 1)
    assert.ok(sameLab[0].at >= 15 * MIN, `same-lab at ${sameLab[0].at}`)
    assert.equal(sameLab[0].sameLab, true, "dispatched with the fresh-session flags and the environment allowlist")
    assert.deepEqual(world.dispatched.slice(0, 2).map((item) => item.reviewer), [A, B])
    const record = foldReviewRecord(world.events)
    assert.equal(record.tier, "same-lab")
    assert.equal(record.fallbackReason, "other-lab-unavailable")
    assert.deepEqual(record.attempts.map((attempt) => [attempt.reviewer, attempt.outcome]), [[A, "unresponsive"], [B, "unresponsive"], [SAME, "unresponsive"]])
  })

  it("keeps a progressing reviewer past the window, stops it at attempt_max, and tries the untried one before the same lab", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: { pickupAtMs: 30_000, outputUntilMs: 60 * MIN } } })
    await run(world)
    const at = (name) => world.dispatched.find((item) => item.reviewer === name)?.at
    assert.equal(at(B), 45 * MIN, "B is tried when A stops at attempt_max")
    assert.ok(at(SAME) >= 50 * MIN, `no same-lab reviewer while A progresses or B is untried (at ${at(SAME)})`)
    assert.deepEqual(ended(world).slice(0, 2), [["stopped-at-max", "attempt_max"], ["unresponsive", "no-pickup"]])
  })

  it("does not assign the same lab while a second other-lab reviewer is untried, even past the window", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: { pickupAtMs: 30_000, outputUntilMs: 20 * MIN } } })
    await run(world)
    const order = world.dispatched.map((item) => [item.reviewer, item.at])
    assert.deepEqual(order[0], [A, 0])
    assert.deepEqual(order[1], [B, 25 * MIN], "A goes silent at minute 20 and ends at 25; B is tried next")
    assert.equal(order[2][0], SAME)
    assert.ok(order[2][1] >= 30 * MIN)
  })

  it("ends an attempt with no pickup within the silence limit and aborts its runner", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [B]: { pickupAtMs: 30_000, outputUntilMs: MIN, verdictAtMs: MIN } } })
    await run(world)
    assert.deepEqual(ended(world)[0], ["unresponsive", "no-pickup"])
    assert.deepEqual(world.aborted, [world.dispatched[0].attemptId])
    assert.equal(world.dispatched[1].at, 5 * MIN)
  })

  it("goes to the same lab at once when no other-lab agent is configured", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, reviewer: SAME, behaviors: { [SAME]: { pickupAtMs: 30_000, outputUntilMs: MIN, verdictAtMs: MIN } } })
    assert.equal((await run(world, { candidates: { otherLab: [], sameLab: [SAME] } })).outcome, "verdict")
    assert.deepEqual(world.dispatched.map((item) => [item.reviewer, item.at]), [[SAME, 0]])
    assert.equal(world.starts[0].reason, "no-other-lab-configured")
    assert.equal(foldReviewRecord(world.events).fallbackReason, "no-other-lab-configured")
  })

  it("with a linked PR, dispatches only the recorded reviewer, again at each silence limit, and escalates at the window's end", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, prNumber: "42" })
    assert.deepEqual(await run(world), { outcome: "escalation", reason: "pr-linked" })
    assert.ok(world.dispatched.every((item) => item.reviewer === A), "no reassignment while a PR is linked")
    assert.deepEqual(world.dispatched.map((item) => item.at), [0, 10 * MIN])
    assert.equal(world.events.at(-1).type, "review-escalation")
    assert.equal(world.events.at(-1).details.reason, "pr-linked")
  })

  it("ends an attempt whose dispatcher was killed as unresponsive (dispatcher-lost) and continues", async () => {
    const clock = createFakeClock()
    const orphan = { type: "review-attempt", actor: OWNER, recordedAt: clock.iso(), details: { attemptId: "orphan", requestId: "r1", reviewer: A, tier: "other-lab", head: "h1", startedAt: clock.iso(), opened: "dispatch" } }
    const world = createWorld({ clock, events: [orphan], behaviors: { [B]: { pickupAtMs: 30_000, outputUntilMs: MIN, verdictAtMs: MIN } } })
    assert.equal((await run(world)).outcome, "verdict")
    assert.deepEqual(ended(world)[0], ["unresponsive", "dispatcher-lost"])
    assert.deepEqual(world.dispatched.map((item) => [item.reviewer, item.at]), [[B, 5 * MIN]])
  })

  it("escalates instead of a third same-lab round after two same-lab requests for changes", async () => {
    const clock = createFakeClock()
    const prior = []
    for (const [index, requestId] of ["p1", "p2"].entries()) {
      prior.push(
        { type: "review-attempt", actor: OWNER, recordedAt: clock.iso(), details: { attemptId: `s${index}`, requestId, reviewer: SAME, tier: "same-lab", reason: "other-lab-unavailable", head: "h0", startedAt: clock.iso() } },
        { type: "request-changes", actor: SAME, recordedAt: clock.iso(), details: { attemptId: `s${index}`, tier: "same-lab" } },
      )
    }
    const world = createWorld({ clock })
    world.events.splice(1, 0, ...prior)
    assert.deepEqual(await run(world), { outcome: "escalation", reason: "same-lab-limit" })
    assert.ok(world.dispatched.every((item) => item.reviewer !== SAME))
    assert.equal(world.events.filter((event) => event.type === "review-escalation").length, 1)
  })

  it("makes exactly one dispatch with maxAttempts 1", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock })
    assert.deepEqual(await run(world, { maxAttempts: 1 }), { outcome: "attempts-done" })
    assert.equal(world.dispatched.length, 1)
  })

  it("starts a new request when the owner moves the head, and not when the active reviewer commits", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: { pickupAtMs: 30_000, outputUntilMs: 10 * MIN } } })
    clock.at(2 * MIN, () => { world.lane.head = "h2"; world.lane.headMovedByReviewer = true })
    clock.at(3 * MIN, () => { world.lane.head = "h3"; world.lane.headMovedByReviewer = false })
    clock.at(4 * MIN, () => { world.lane.status = "changes-requested" })
    await run(world)
    const requests = world.events.filter((event) => event.type === "review-request")
    assert.deepEqual(requests.map((event) => event.details.head), ["h1", "h3"], "the reviewer's own commit at h2 is no new head")
    assert.deepEqual(ended(world)[0], ["superseded", "new-head"])
    assert.ok(Date.parse(requests[1].details.requestedAt) >= clock.now() - clock.elapsed() + 3 * MIN, "a new window starts")
    assert.equal(world.dispatched.at(-1).reviewer, A, "the new request starts with the lane's other-lab reviewer")
  })

  it("re-probes a tried reviewer at each silence limit until the window ends, then escalates with no same-lab candidate", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: "fail" } })
    assert.deepEqual(await run(world, { candidates: { otherLab: [A], sameLab: [] } }), { outcome: "escalation", reason: "no-reviewer" })
    assert.deepEqual(world.dispatched.map((item) => item.at), [0, 5 * MIN, 10 * MIN])
    assert.ok(ended(world).every(([outcome]) => outcome === "failed"))
  })

  it("retries the available reviewer at each silence limit when another candidate keeps failing its probe", async () => {
    // Lane review (codex-reviewer) repro: the reviewer that failed its probe
    // was picked again on every re-probe and the available one never was.
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: "fail" } })
    const result = await run(world, { candidates: { otherLab: [A, B], sameLab: [] }, probe: async (name) => name !== B })
    assert.deepEqual(result, { outcome: "escalation", reason: "no-reviewer" })
    assert.deepEqual(world.dispatched.map((entry) => [entry.reviewer, entry.at]), [[A, 0], [A, 5 * MIN], [A, 10 * MIN]])
  })

  it("ends a picked-up attempt a silence limit after its output stops", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: { pickupAtMs: 30_000, outputUntilMs: MIN } } })
    assert.deepEqual(await run(world, { maxAttempts: 1 }), { outcome: "attempts-done" })
    assert.deepEqual(ended(world), [["unresponsive", "no-progress"]])
    assert.equal(clock.elapsed(), 6 * MIN)
  })

  it("calls a clean exit with no verdict a failure, never an approval", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: "exit0", [B]: "exit0" } })
    await run(world, { candidates: { otherLab: [A, B], sameLab: [] } })
    assert.equal(world.lane.status, "needs-review")
    assert.deepEqual(ended(world).slice(0, 2), [["failed", "exited without a verdict"], ["failed", "exited without a verdict"]])
  })

  it("counts a failed probe as tried and records no attempt for it", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [B]: { pickupAtMs: 30_000, outputUntilMs: MIN, verdictAtMs: MIN } } })
    const probe = async (name) => name !== A
    assert.equal((await run(world, { probe })).outcome, "verdict")
    assert.deepEqual(world.dispatched.map((item) => [item.reviewer, item.at]), [[B, 0]])
  })

  it("escalates when the start of an attempt is refused (row 20)", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock, behaviors: { [A]: "quota" }, refuse: (args) => args.reviewer === B })
    assert.deepEqual(await run(world), { outcome: "escalation", reason: "reassignment-refused" })
    assert.equal(world.lane.reviewer, A)
  })

  it("does not dispatch once the request lock is no longer this holder's", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock })
    assert.deepEqual(await run(world, { lock: { stillHeld: async () => false } }), { outcome: "lock-lost" })
    assert.equal(world.dispatched.length, 0)
  })

  it("makes no change while nothing calls it, however long (invariant 2)", async () => {
    const clock = createFakeClock()
    const world = createWorld({ clock })
    const before = JSON.stringify(world.events)
    await clock.advance(60 * MIN)
    assert.equal(JSON.stringify(world.events), before)
    assert.equal(world.lane.reviewer, A)
  })
})

describe("runReviewRequest with a real runner process", TIMEOUT, () => {
  const roots = []
  const children = []
  // A runner the loop failed to stop (lane review M15) is killed here, so the
  // test fails at its timeout instead of keeping the process alive.
  after(async () => {
    for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL")
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it("stops a silent runner's process when its attempt ends", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-request-runner-")))
    roots.push(root)
    const shim = await installFakeRunner(path.join(root, "bin"), "codex")
    const logPath = path.join(root, "log.jsonl")
    const scenarioPath = await writeFakeRunnerScenario(path.join(root, "scenario.json"), { default: [{ do: "silent" }] })
    const clock = { now: () => Date.now(), iso: () => new Date().toISOString(), elapsed: () => 0 }
    const world = createWorld({ clock: { ...clock, sleep: async () => {}, atTime: () => {} } })
    world.runAttempt = async ({ reviewer, signal }) => {
      const child = spawn(shim, [], { env: { ...withoutLaneScope(), ...fakeRunnerEnv({ scenarioPath, logPath }), BTRAIN_AGENT: reviewer }, stdio: "ignore" })
      children.push(child)
      const exit = new Promise((resolve) => child.on("close", (code) => resolve({ exitCode: code })))
      signal.addEventListener("abort", () => child.kill("SIGTERM"))
      return { exit, tail: () => "", lastOutputAt: () => null, executable: "codex" }
    }
    const result = await runReviewRequest({
      ...world,
      candidates: { otherLab: [A], sameLab: [] },
      policy: { otherLabWindowMs: 1_000, silenceLimitMs: 300, attemptMaxMs: 5_000 },
      pollIntervalMs: 20,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      newId,
    })
    assert.equal(result.outcome, "escalation")
    await Promise.all(children.map((child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.on("close", resolve)))))
    assert.ok(children.length >= 2, `re-probed at the silence limit: ${children.length} starts`)
    // Each runner ended by the abort's SIGTERM: a slow machine may kill it
    // before node has installed its handler (signal SIGTERM) or after (the
    // fake logs it and exits 143). None stayed silent until the test ended.
    for (const child of children) {
      assert.ok(child.signalCode === "SIGTERM" || child.exitCode === 143, `ended by the abort: ${child.signalCode} ${child.exitCode}`)
    }
    const exits = (await readFakeRunnerLog(logPath)).filter((entry) => entry.kind === "exit")
    assert.ok(exits.every((entry) => entry.reason === "SIGTERM"), "no runner ended for another reason")
  })
})
