// The gh-codex bot's three P2 findings on PR #125 (lane e), as failing tests
// committed before their fix.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runReviewRequest } from "../src/brain_train/review/request.mjs"
import { inLockedFiles, isTestPath } from "../src/brain_train/review/fix-rules.mjs"
import { scanDiff } from "../src/brain_train/review/code-rules.mjs"
import { createFakeClock } from "./helpers/fake-clock.mjs"

const MIN = 60_000
const OWNER = "claude"
const A = "codex-reviewer"
const B = "gem"
const SAME = "claude-reviewer"
const POLICY = { otherLabWindowMs: 15 * MIN, silenceLimitMs: 5 * MIN, attemptMaxMs: 45 * MIN }

let ids = 0
const newId = () => `bot${(ids += 1)}`

// A small in-memory lane and event log. `outputUntilMs` makes a runner pick
// up after 30 s and print every minute until then.
function world(clock, { reviewer = A, behaviors = {}, onSleep } = {}) {
  const lane = { status: "needs-review", owner: OWNER, reviewer, prNumber: "", head: "h1", branch: "refs/heads/feat/x", headMovedByReviewer: false }
  const events = [
    { type: "claim", actor: OWNER, recordedAt: clock.iso(), after: { owner: OWNER, reviewer, status: "in-progress" } },
    { type: "review-request", actor: OWNER, recordedAt: clock.iso(), details: { requestId: "r1", branch: lane.branch, head: "h1", requestedAt: clock.iso() } },
  ]
  const log = []
  return {
    lane,
    events,
    log,
    readEvents: async () => events.map((event) => ({ ...event })),
    writeEvent: async (event) => { events.push({ recordedAt: clock.iso(), laneId: "a", ...event }) },
    readLane: async () => ({ ...lane }),
    startAttempt: async (args) => {
      lane.reviewer = args.reviewer
      events.push({
        type: "review-attempt", actor: OWNER, recordedAt: clock.iso(), laneId: "a",
        details: { attemptId: args.attemptId, requestId: args.requestId, reviewer: args.reviewer, previousReviewer: args.previousReviewer, reason: args.reason, tier: args.tier, head: args.head, startedAt: args.startedAt, opened: args.opened, by: "btrain-system" },
      })
      return { ok: true }
    },
    runAttempt: async ({ reviewer: who, attemptId, signal, tier }) => {
      log.push({ kind: "dispatch", reviewer: who, attemptId, tier, at: clock.elapsed() })
      const startedAt = clock.now()
      let lastOutputAt = null
      let settle
      const exit = new Promise((resolve) => { settle = resolve })
      signal.addEventListener("abort", () => {
        log.push({ kind: "abort", reviewer: who, attemptId, at: clock.elapsed() })
        settle({ exitCode: null })
      })
      const behavior = behaviors[who]
      if (behavior?.outputUntilMs) {
        clock.atTime(startedAt + 30_000, () => {
          events.push({ type: "review-pickup", actor: who, recordedAt: clock.iso(), laneId: "a", details: { attemptId, at: clock.iso() } })
          lastOutputAt = clock.now()
        })
        for (let minute = 1; minute * MIN <= behavior.outputUntilMs; minute += 1) {
          clock.atTime(startedAt + minute * MIN, () => { lastOutputAt = clock.now() })
        }
      }
      return { exit, tail: () => "", lastOutputAt: () => lastOutputAt, executable: "codex" }
    },
    now: clock.now,
    sleep: async (ms) => {
      if (clock.elapsed() > 6 * 60 * MIN) throw new Error("runaway request loop")
      await onSleep?.()
      return clock.sleep(ms)
    },
  }
}

describe("gh-codex findings on #125", () => {
  it("aborts a runner whose attempt a lane agent superseded, before dispatching its replacement", async () => {
    const clock = createFakeClock()
    let changed = false
    const w = world(clock, {
      onSleep: () => {
        if (changed) return
        changed = true
        // A lane agent reassigns the reviewer with handoff update while A runs.
        w.events.push({ type: "update", actor: OWNER, recordedAt: clock.iso(), laneId: "a", before: { reviewer: A }, after: { reviewer: B } })
        w.lane.reviewer = B
      },
    })
    await runReviewRequest({ candidates: { otherLab: [A, B], sameLab: [SAME] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 2, ...w })
    const firstDispatch = w.log.find((item) => item.kind === "dispatch" && item.reviewer === A)
    const abortOfA = w.log.findIndex((item) => item.kind === "abort" && item.attemptId === firstDispatch.attemptId)
    const dispatchOfB = w.log.findIndex((item) => item.kind === "dispatch" && item.reviewer === B)
    assert.ok(dispatchOfB > 0, "the replacement was dispatched")
    assert.ok(abortOfA >= 0 && abortOfA < dispatchOfB, `the superseded runner was aborted first: ${JSON.stringify(w.log)}`)
  })

  // codex-reviewer, lane e round after 25b1ba7: pin for mutant M7 (a stopped
  // runner left in the running map), taken from its proposed test.
  it("does not read a stopped runner's handle after a lane agent superseded its attempt", async () => {
    const clock = createFakeClock()
    let changed = false
    let disposedReads = 0
    const w = world(clock, {
      onSleep: () => {
        if (changed) return
        changed = true
        w.events.push({ type: "update", actor: OWNER, recordedAt: clock.iso(), laneId: "a", before: { reviewer: A }, after: { reviewer: B } })
        w.lane.reviewer = B
      },
    })
    const runAttempt = w.runAttempt
    w.runAttempt = async (args) => {
      const handle = await runAttempt(args)
      return {
        ...handle,
        lastOutputAt: () => {
          if (args.signal.aborted) disposedReads += 1
          return handle.lastOutputAt()
        },
      }
    }
    await runReviewRequest({ candidates: { otherLab: [A, B], sameLab: [SAME] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 2, ...w })
    assert.equal(disposedReads, 0, "a stopped runner leaves the running map")
  })

  it("counts an attempt's last stream output toward FR-4's progress check after the attempt ends", async () => {
    const clock = createFakeClock()
    // A keeps printing every minute until minute 60, so at attempt_max
    // (45 min) it has just shown progress.
    const w = world(clock, { behaviors: { [A]: { outputUntilMs: 60 * MIN } } })
    await runReviewRequest({ candidates: { otherLab: [A], sameLab: [SAME] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 2, ...w })
    const sameLab = w.log.find((item) => item.kind === "dispatch" && item.reviewer === SAME)
    assert.ok(sameLab, "the same lab is reached in the end")
    assert.ok(sameLab.at >= 45 * MIN + POLICY.silenceLimitMs, `no same-lab dispatch within silence_limit of A's last output (at ${sameLab.at / MIN} min)`)
  })

  // gh-codex, #125 at 202e2f1: a verdict return left live runners running.
  it("stops a live runner when the lane leaves needs-review while it runs", async () => {
    const clock = createFakeClock()
    let changed = false
    const signals = []
    const w = world(clock, {
      onSleep: () => {
        if (changed) return
        changed = true
        // The owner takes the lane back while the reviewer still runs.
        w.lane.status = "changes-requested"
      },
    })
    const runAttempt = w.runAttempt
    w.runAttempt = async (args) => {
      signals.push(args.signal)
      return runAttempt(args)
    }
    const result = await runReviewRequest({ candidates: { otherLab: [A, B], sameLab: [SAME] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 2, ...w })
    assert.deepEqual(result, { outcome: "verdict", status: "changes-requested" })
    assert.equal(signals.length, 1)
    assert.equal(signals[0].aborted, true, "the runner is stopped before the request returns")
  })

  it("leaves the runner of the reviewer that gave the verdict to finish its own steps", async () => {
    const clock = createFakeClock()
    let changed = false
    const signals = []
    const w = world(clock, {
      onSleep: () => {
        if (changed) return
        changed = true
        // A resolves and is still running (for example, its PR steps).
        w.events.push({ type: "resolve", actor: A, recordedAt: clock.iso(), laneId: "a", before: { status: "needs-review" }, after: { status: "ready-for-pr" } })
        w.lane.status = "ready-for-pr"
      },
    })
    const runAttempt = w.runAttempt
    w.runAttempt = async (args) => {
      signals.push(args.signal)
      return runAttempt(args)
    }
    const result = await runReviewRequest({ candidates: { otherLab: [A, B], sameLab: [SAME] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 2, ...w })
    assert.deepEqual(result, { outcome: "verdict", status: "ready-for-pr" })
    assert.equal(signals[0].aborted, false)
  })

  it("stops a live runner when the owner's update, not the reviewer, ended the request", async () => {
    const clock = createFakeClock()
    let changed = false
    const signals = []
    const w = world(clock, {
      onSleep: () => {
        if (changed) return
        changed = true
        // An earlier round's resolve by A is in the log; the owner's update
        // is the latest status change.
        w.events.push({ type: "resolve", actor: A, recordedAt: clock.iso(), laneId: "a", before: { status: "needs-review" }, after: { status: "ready-for-pr" } })
        w.events.push({ type: "update", actor: OWNER, recordedAt: clock.iso(), laneId: "a", before: { status: "ready-for-pr" }, after: { status: "changes-requested" } })
        w.lane.status = "changes-requested"
      },
    })
    const runAttempt = w.runAttempt
    w.runAttempt = async (args) => {
      signals.push(args.signal)
      return runAttempt(args)
    }
    await runReviewRequest({ candidates: { otherLab: [A, B], sameLab: [SAME] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 2, ...w })
    assert.equal(signals[0].aborted, true)
  })

  // gh-codex, #125 at 202e2f1: colocated tests by runner naming convention.
  it("classifies colocated test files by their runner naming convention", () => {
    for (const file of ["pkg/foo_test.go", "src/FooTest.java", "app/foo_test.py", "lib/foo-test.js", "src/foo.spec.ts", "app/test_foo.py", "web/__tests__/foo.js", "crate/tests/it.rs", "test/helpers/fake-clock.mjs", "specs/tla/Review.tla"]) {
      assert.equal(isTestPath(file), true, file)
    }
    for (const file of ["pkg/foo.go", "src/Foo.java", "app/latest.py", "src/contest.js"]) {
      assert.equal(isTestPath(file), false, file)
    }
  })

  it("classifies shared configuration that holds test settings as test configuration", () => {
    for (const file of ["package.json", "web/package.json", "pyproject.toml", "setup.cfg", ".coveragerc", "codecov.yml", "vitest.workspace.mts", ".nycrc.json"]) {
      assert.equal(isTestPath(file), true, file)
    }
    for (const file of ["src/app.mjs", "README.md", "Cargo.toml"]) {
      assert.equal(isTestPath(file), false, file)
    }
  })
})

// codex-reviewer, lane e at fc0d26c: mutant M13. isTestPath's test-directory
// rule masked removal of the shared path patterns; the scanner uses them
// directly. Its proposed tests.
describe("shared path-named test patterns in the scanner", () => {
  for (const file of ["web/__tests__/plain.js", "crate/tests/integration.rs"]) {
    it(`keeps path-named tests in the scanner: ${file}`, () => {
      const diff = `diff --git a/${file} b/${file}
deleted file mode 100644
index 1111111..0000000
--- a/${file}
+++ /dev/null
@@ -1 +0,0 @@
-assert(true)
`
      assert.equal(scanDiff(diff).violations.filter((v) => v.rule === "deleted-test-file").length, 1)
    })
  }
})

// gh-codex, #125 at 952a806: the fix-path lock check must read a lane's
// locks as the pre-commit hook's path_matches_lock does (core.mjs), including
// the literal /** directory glob. Cases mirror test/core.test.mjs.
describe("inLockedFiles agrees with the hook's path_matches_lock", () => {
  const cases = [
    ["test/a.test.mjs", "test/a.test.mjs", true],
    ["test/b.test.mjs", "test/a.test.mjs", false],
    ["src/brain_train/cli.mjs", "src/brain_train/core.mjs", false],
    ["src/auth/guard.ts", "src/auth/", true],
    ["src/auth/deep/x.ts", "src/auth/", true],
    ["src/authz/x.ts", "src/auth/", false],
    ["src/auth/guard.ts", "src/auth", true],
    ["src/auth/guard.ts", "src/**", true],
    ["src/auth/deep/x.ts", "src/auth/**", true],
    ["src/auth", "src/auth/**", true],
    ["src/authz/x.ts", "src/auth/**", false],
    ["docs/a.md", "src/**", false],
    ["test/a.test.mjs", " test/a.test.mjs ", true],
    ["test/a.test.mjs", "(none)", false],
  ]
  for (const [file, lock, expected] of cases) {
    it(`${file} under ${JSON.stringify(lock)}: ${expected}`, () => {
      assert.equal(inLockedFiles(file, [lock]), expected)
    })
  }
})

// gh-codex, #125 at 308a499: with a linked PR, a recorded reviewer the caller
// left out of both candidate lists (a notify runner, or no cli runner) is
// never dispatched; it keeps manual pickup, and the window's end escalates.
describe("linked PR with a reviewer that is not a candidate", () => {
  it("does not dispatch a notify reviewer and escalates at the window's end", async () => {
    const clock = createFakeClock()
    const NOTIFY = "human-notify"
    const w = world(clock, { reviewer: NOTIFY })
    w.lane.prNumber = "42"
    const starts = []
    const startAttempt = w.startAttempt
    w.startAttempt = async (args) => { starts.push(args.reviewer); return startAttempt(args) }
    const result = await runReviewRequest({ candidates: { otherLab: [], sameLab: [] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 2, ...w })
    assert.deepEqual(result, { outcome: "escalation", reason: "pr-linked" })
    assert.deepEqual(starts, [], "no attempt is started for a reviewer that cannot be launched")
    assert.equal(w.log.filter((item) => item.kind === "dispatch").length, 0)
  })

  it("still dispatches a linked PR's recorded reviewer when it is a candidate", async () => {
    const clock = createFakeClock()
    const w = world(clock, { reviewer: A })
    w.lane.prNumber = "42"
    await runReviewRequest({ candidates: { otherLab: [A], sameLab: [] }, policy: POLICY, newId, pollIntervalMs: 15_000, maxAttempts: 1, ...w })
    assert.equal(w.log.filter((item) => item.kind === "dispatch" && item.reviewer === A).length, 1)
  })
})
