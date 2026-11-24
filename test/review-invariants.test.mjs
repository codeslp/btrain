// The thirteen invariants of spec 023 (implementation plan, "Architecture and
// invariants"). WS0 adds them skipped; the workstream named in each skip
// removes it when its code makes the test pass (tasks T011, T028, T039).
//
// The tests are written against the planned interfaces: modules under
// src/brain_train/review/ that do not exist yet (`request.mjs`,
// `fix-rules.mjs`), the `handoff fix` and `handoff confirm-fix` commands, the
// review events of the plan's data model, and the display states in
// `btrain status`. Every such module is imported inside a test body, never at
// module load, so this file loads on `main`. The workstream that enables a test
// fixes a name here if it settles on another one, and says so in its handoff.
//
// No test starts a real model. Every reviewer is test/helpers/fake-runner.mjs
// behind a shim named for the executable whose lab it should have: `codex`
// (openai), `gemini` (google), `claude` (anthropic). Every repository gets its
// own BRAIN_TRAIN_HOME in a temporary directory, so nothing registers in the
// real ~/.btrain.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import {
  fakeRunnerEnv,
  installFakeRunner,
  readFakeRunnerLog,
  readFakeRunnerStarts,
  writeFakeRunnerScenario,
} from "./helpers/fake-runner.mjs"
import { createFakeClock } from "./helpers/fake-clock.mjs"
import { foldReviewRecord, REVIEW_EVENT_TYPES } from "../src/brain_train/review/record.mjs"

const exec = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(REPO_ROOT, "src/brain_train/cli.mjs")
const SAMPLES = path.join(REPO_ROOT, "test/fixtures/runner-signals")
const reviewModule = (name) => import(new URL(`../src/brain_train/review/${name}`, import.meta.url))

const MIN = 60_000
// A command that hangs is killed after this, so a regression fails the test
// instead of wedging the suite (node --test has no default timeout).
const COMMAND_TIMEOUT_MS = 60_000

// The agents of every repository here. The owner is `claude`; the shims give
// each one its lab through the runner table, never through its name.
const AGENTS = Object.freeze({
  owner: { name: "claude", shim: "claude" },
  otherLabA: { name: "codex-reviewer", shim: "codex" },
  otherLabB: { name: "gem", shim: "gemini" },
  sameLab: { name: "claude-reviewer", shim: "claude" },
})

const roots = []
after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

/**
 * A temporary repository initialised by the real CLI, with a fake runner for
 * every agent and lane `a` claimed by the owner on `src/feature.mjs`.
 * `agents` picks which reviewers are configured (default: all three).
 */
async function createReviewRepo({ prFlow = false, reviewers = ["otherLabA", "otherLabB", "sameLab"], review = "" } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-inv-")))
  roots.push(root)
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  const bin = path.join(root, "bin")
  const logPath = path.join(root, "runner-log.jsonl")
  const scenarioPath = path.join(root, "scenario.json")
  await fs.mkdir(home, { recursive: true })
  await writeFakeRunnerScenario(scenarioPath, {})
  await exec("git", ["init", "-q", "-b", "main", repo])
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", repo, "config", "user.name", "Test Bot"])

  const agents = [AGENTS.owner, ...reviewers.map((key) => AGENTS[key])]
  const shims = {}
  for (const agent of agents) {
    shims[agent.name] = await installFakeRunner(path.join(bin, agent.name), agent.shim)
  }

  const baseEnv = {
    ...withoutLaneScope(),
    BRAIN_TRAIN_HOME: home,
    BTRAIN_DASHBOARD_DISABLED: "1",
    ...fakeRunnerEnv({ scenarioPath, logPath, cliPath: CLI }),
  }

  async function btrain(args, { agent = AGENTS.owner.name, env = {} } = {}) {
    try {
      const result = await exec("node", [CLI, ...args], {
        cwd: repo,
        env: { ...baseEnv, ...(agent ? { BTRAIN_AGENT: agent } : {}), ...env },
        maxBuffer: 5 * 1024 * 1024,
        timeout: COMMAND_TIMEOUT_MS,
      })
      return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || "" }
    }
  }

  const init = await btrain(["init", repo, "--tracked", "--core-only", ...agents.flatMap((agent) => ["--agent", agent.name])])
  assert.equal(init.code, 0, init.stderr)

  const tomlPath = path.join(repo, ".btrain", "project.toml")
  let toml = await fs.readFile(tomlPath, "utf8")
  const runnerLines = agents.map((agent) => `"${agent.name}" = "${shims[agent.name]}"`).join("\n")
  toml = toml.replace(/\[agents\.runners\][\s\S]*?\n\[reviews\]/, `[agents.runners]\n${runnerLines}\n\n[reviews]`)
  if (prFlow) toml = toml.replace(/(\[pr_flow\]\n)enabled = false/, "$1enabled = true")
  if (review) toml = `${toml.trimEnd()}\n\n${review.trim()}\n`
  await fs.writeFile(tomlPath, toml, "utf8")

  await fs.mkdir(path.join(repo, "src"), { recursive: true })
  await fs.writeFile(path.join(repo, "src", "feature.mjs"), "export const feature = 1\n", "utf8")
  await exec("git", ["-C", repo, "add", "-A"])
  await exec("git", ["-C", repo, "commit", "-q", "-m", "initial"])
  await exec("git", ["-C", repo, "checkout", "-q", "-b", "feat/x"])

  const claim = await btrain([
    "handoff", "claim", "--lane", "a", "--task", "Change the feature",
    "--owner", AGENTS.owner.name, "--files", "src/feature.mjs",
  ])
  assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)
  // The owner's work, so `needs-review` finds a diff against main.
  await fs.writeFile(path.join(repo, "src", "feature.mjs"), "export const feature = 2\n", "utf8")
  await exec("git", ["-C", repo, "commit", "-q", "-am", "owner change"])

  return {
    root,
    repo,
    home,
    logPath,
    scenarioPath,
    btrain,
    async scenario(value) {
      await writeFakeRunnerScenario(scenarioPath, value)
    },
    async ownerCommit(content = `export const feature = ${Date.now()}\n`) {
      await fs.writeFile(path.join(repo, "src", "feature.mjs"), content, "utf8")
      await exec("git", ["-C", repo, "commit", "-q", "-am", "owner change"])
      return (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim()
    },
    async head() {
      return (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim()
    },
    async events(lane = "a") {
      const text = await fs.readFile(path.join(repo, ".btrain", "events", `lane-${lane}.jsonl`), "utf8").catch(() => "")
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    },
    async appendEvents(events, lane = "a") {
      const file = path.join(repo, ".btrain", "events", `lane-${lane}.jsonl`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const lines = events.map((event) => JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), laneId: lane, ...event }))
      await fs.appendFile(file, `${lines.join("\n")}\n`, "utf8")
    },
    async handoffFile(lane = "a") {
      return fs.readFile(path.join(repo, ".claude", "collab", `HANDOFF_${lane.toUpperCase()}.md`), "utf8")
    },
    async record(lane = "a") {
      return foldReviewRecord(await this.events(lane))
    },
  }
}

/** The arguments that move lane `a` to needs-review. */
function needsReviewArgs({ dispatch = true } = {}) {
  return [
    "handoff", "update", "--lane", "a", "--status", "needs-review",
    "--actor", AGENTS.owner.name,
    "--base", "main",
    "--preflight",
    "--changed", "src/feature.mjs - change the feature",
    "--verification", "node --test",
    "--gap", "None",
    "--why", "Ready for review.",
    "--review-ask", "Check the change.",
    // Bounds today's dispatch wait, so a regression fails in seconds.
    ...(dispatch ? ["--timeout", "30", "--poll-interval", "0.05"] : ["--no-dispatch"]),
  ]
}

const DISPATCH_ON = { BTRAIN_NO_REVIEW_DISPATCH: "0" }

/**
 * Events that put lane `a` in an open request with one dispatched attempt, as
 * WS5 writes them. `at` is the time of both, in every field the fold reads.
 */
function openAttemptEvents({ head, reviewer = AGENTS.otherLabA.name, attemptId = "t1", requestId = "r1", tier = "other-lab", at = new Date().toISOString(), request = true }) {
  return [
    ...(request
      ? [{ type: "review-request", actor: AGENTS.owner.name, recordedAt: at, details: { requestId, branch: "refs/heads/feat/x", head, requestedAt: at, otherLab: [AGENTS.otherLabA.name, AGENTS.otherLabB.name], sameLab: [AGENTS.sameLab.name] } }]
      : []),
    { type: "review-attempt", actor: AGENTS.owner.name, recordedAt: at, details: { attemptId, requestId, reviewer, previousReviewer: "", reason: "", tier, head, startedAt: at, opened: "dispatch", by: "btrain-system" } },
  ]
}

// A short review policy, so a test of the request loop runs its window,
// silence limit, and re-probe in seconds, inside COMMAND_TIMEOUT_MS. The
// silence limit leaves a fake runner time to start node and pick up even on
// a loaded CI machine.
const SHORT_REVIEW = '[review]\nother_lab_window = "6s"\nsilence_limit = "2500ms"\nattempt_max = "10s"'

/**
 * The seven functions `runReviewRequest` takes (plan, "Modules"), over an
 * in-memory lane and event log, with the fake clock. `behaviors` maps a
 * reviewer to what its runner does: `silent`, `quota`, `progress` (output
 * every minute), or `{ verdictAtMs }`. Every write checks invariant 4.
 */
function createLoopWorld({ clock, owner = AGENTS.owner.name, reviewer = AGENTS.otherLabA.name, behaviors = {}, prLinked = false }) {
  const lane = { id: "a", status: "needs-review", owner, reviewer, prNumber: prLinked ? "7" : "" }
  const events = [
    { type: "claim", actor: owner, recordedAt: clock.iso(), after: { owner, reviewer, status: "in-progress" } },
    { type: "review-request", actor: owner, recordedAt: clock.iso(), details: { requestId: "r1", branch: "refs/heads/feat/x", head: "h1", requestedAt: clock.iso() } },
  ]
  const dispatched = []
  const aborted = []
  const checkInvariant4 = () => {
    const record = foldReviewRecord(events)
    const active = record.attempts.find((attempt) => attempt.id === record.activeAttemptId)
    if (lane.status === "needs-review" && active) {
      assert.equal(lane.reviewer, active.reviewer, "invariant 4: the recorded reviewer is the active attempt's")
    }
  }
  return {
    lane,
    events,
    dispatched,
    aborted,
    readEvents: async () => events.map((event) => ({ ...event })),
    writeEvent: async (event) => {
      events.push({ recordedAt: clock.iso(), laneId: "a", ...event })
      checkInvariant4()
    },
    readLane: async () => ({ ...lane }),
    startAttempt: async ({ reviewer: next, reason, tier, attemptId, previousReviewer }) => {
      lane.reviewer = next
      events.push({
        type: "review-attempt", actor: owner, recordedAt: clock.iso(), laneId: "a",
        details: { attemptId, requestId: "r1", reviewer: next, previousReviewer, reason, tier, head: "h1", startedAt: clock.iso(), opened: "dispatch", by: "btrain-system" },
      })
      checkInvariant4()
    },
    runAttempt: async ({ reviewer: who, attemptId, signal }) => {
      dispatched.push({ reviewer: who, attemptId, at: clock.elapsed() })
      const behavior = behaviors[who] || "silent"
      const startedAt = clock.now()
      let lastOutputAt = startedAt
      let settle
      const exit = new Promise((resolve) => { settle = resolve })
      signal?.addEventListener?.("abort", () => {
        aborted.push(attemptId)
        settle({ exitCode: null, signal: "SIGTERM" })
      })
      if (behavior === "quota") {
        settle({ exitCode: 1 })
        return { exit, tail: () => "You’ve hit your usage limit.", lastOutputAt: () => lastOutputAt }
      }
      if (behavior === "progress") {
        // Pick up first: output resets the silence clock only after pickup (FR-4).
        clock.atTime(startedAt + 30_000, () => {
          events.push({ type: "review-pickup", actor: who, recordedAt: clock.iso(), laneId: "a", details: { attemptId, at: clock.iso() } })
          lastOutputAt = clock.now()
        })
        for (let minute = 1; minute <= 60; minute += 1) clock.atTime(startedAt + minute * MIN, () => { lastOutputAt = clock.now() })
      }
      if (behavior && typeof behavior === "object" && typeof behavior.verdictAtMs === "number") {
        clock.atTime(startedAt + behavior.verdictAtMs, () => {
          lane.status = "ready-for-pr"
          events.push({ type: "resolve", actor: who, recordedAt: clock.iso(), laneId: "a", details: { attemptId } })
          settle({ exitCode: 0 })
        })
      }
      return { exit, tail: () => "", lastOutputAt: () => lastOutputAt }
    },
    now: clock.now,
    sleep: clock.sleep,
  }
}

describe("the invariant harness itself", () => {
  // Not an invariant: proves on main that the repository helper and the fake
  // runners work, so a workstream that removes a skip starts from a setup
  // that is known to run.
  it("claims lane a for the owner and dispatches the fake other-lab reviewer on needs-review", async () => {
    const repo = await createReviewRepo()
    assert.match(await repo.handoffFile(), new RegExp(`^Peer Reviewer: ${AGENTS.otherLabA.name}$`, "m"))
    await repo.scenario({ agents: { [AGENTS.otherLabA.name]: [{ do: "handoff" }, { do: "resolve", summary: "Looks right" }] } })
    const update = await repo.btrain(needsReviewArgs(), { env: DISPATCH_ON })
    assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`)
    const starts = await readFakeRunnerStarts(repo.logPath)
    assert.deepEqual(starts.map((start) => [start.agent, start.executable]), [[AGENTS.otherLabA.name, "codex"]])
    assert.match(await repo.handoffFile(), /^Status: resolved$/m)
    assert.ok((await repo.events()).some((event) => event.type === "resolve"))
  })

  it("drives an in-memory request world with the fake clock", async () => {
    const clock = createFakeClock()
    const world = createLoopWorld({ clock, behaviors: { [AGENTS.otherLabA.name]: { verdictAtMs: 3 * MIN } } })
    await world.startAttempt({ reviewer: AGENTS.otherLabA.name, attemptId: "t1", reason: "", tier: "other-lab", previousReviewer: "" })
    const handle = await world.runAttempt({ reviewer: AGENTS.otherLabA.name, attemptId: "t1", signal: new AbortController().signal })
    while (world.lane.status === "needs-review") await world.sleep(30_000)
    assert.deepEqual(await handle.exit, { exitCode: 0 })
    assert.equal(clock.elapsed(), 3 * MIN)
    assert.equal(foldReviewRecord(world.events).attempts[0].verdict, "resolve")
  })
})

describe("spec 023 invariants", () => {
  it("1. a same-lab reviewer is assigned only by override, or after the window with every other-lab reviewer tried and none progressing", { skip: "WS5: the request loop (T028)" }, async () => { // btrain-allow: skipped-test
    const { runReviewRequest } = await reviewModule("request.mjs")
    const clock = createFakeClock()
    const world = createLoopWorld({ clock, behaviors: { [AGENTS.otherLabA.name]: "silent", [AGENTS.otherLabB.name]: "silent" } })
    await runReviewRequest({
      laneId: "a",
      candidates: { otherLab: [AGENTS.otherLabA.name, AGENTS.otherLabB.name], sameLab: [AGENTS.sameLab.name] },
      policy: { otherLabWindowMs: 15 * MIN, silenceLimitMs: 5 * MIN, attemptMaxMs: 45 * MIN },
      ...world,
    })
    const sameLab = world.dispatched.filter((item) => item.reviewer === AGENTS.sameLab.name)
    assert.equal(sameLab.length, 1, "exactly one same-lab dispatch")
    assert.ok(sameLab[0].at >= 15 * MIN, `no same-lab dispatch before the window (at ${sameLab[0].at})`)
    for (const reviewer of [AGENTS.otherLabA.name, AGENTS.otherLabB.name]) {
      assert.ok(world.dispatched.some((item) => item.reviewer === reviewer && item.at < sameLab[0].at), `${reviewer} had an attempt first`)
    }
    const record = foldReviewRecord(world.events)
    assert.equal(record.tier, "same-lab")
    assert.equal(record.fallbackReason, "other-lab-unavailable")

    // An other-lab reviewer that keeps progressing keeps the lane past the
    // window, up to attempt_max; only then does the same lab get it.
    const progressClock = createFakeClock()
    const progressing = createLoopWorld({ clock: progressClock, behaviors: { [AGENTS.otherLabA.name]: "progress", [AGENTS.otherLabB.name]: "silent" } })
    await runReviewRequest({
      laneId: "a",
      candidates: { otherLab: [AGENTS.otherLabA.name, AGENTS.otherLabB.name], sameLab: [AGENTS.sameLab.name] },
      policy: { otherLabWindowMs: 15 * MIN, silenceLimitMs: 5 * MIN, attemptMaxMs: 45 * MIN },
      ...progressing,
    })
    const firstSameLab = progressing.dispatched.find((item) => item.reviewer === AGENTS.sameLab.name)
    assert.ok(firstSameLab, "the same lab is reached once progress stops at attempt_max")
    assert.ok(firstSameLab.at >= 45 * MIN, `no same-lab dispatch while the other-lab reviewer progresses (at ${firstSameLab.at})`)
  })

  it("2. elapsed wall time alone never assigns a same-lab reviewer; with no btrain process running the lane does not change", { skip: "WS5: the request loop (T028)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo()
    const update = await repo.btrain(needsReviewArgs({ dispatch: false }))
    assert.equal(update.code, 0, update.stderr)
    // The request and its only attempt are an hour old: no process ran since.
    const hourAgo = new Date(Date.now() - 60 * MIN).toISOString()
    const head = await repo.head()
    await repo.appendEvents(openAttemptEvents({ head, at: hourAgo }))
    const record = await repo.record()
    assert.equal(record.request.requestedAt, hourAgo, "the fold sees an hour-old request")
    assert.equal(record.attempts[0].startedAt, hourAgo, "and an hour-old attempt")
    const before = await repo.events()
    const beforeFile = await repo.handoffFile()
    // Commands that read the lane are not a dispatcher.
    for (const args of [["status"], ["handoff", "--lane", "a"], ["locks"]]) {
      const result = await repo.btrain(args)
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`)
    }
    const afterEvents = await repo.events()
    assert.deepEqual(afterEvents.slice(0, before.length), before, "no event was rewritten")
    // A read may log something of its own, but nothing that changes the lane
    // or the review record.
    const changing = new Set([...REVIEW_EVENT_TYPES, "claim", "update", "resolve", "request-changes", "watchdog-repair"])
    assert.deepEqual(afterEvents.slice(before.length).filter((event) => changing.has(event.type)), [])
    assert.equal(await repo.handoffFile(), beforeFile)
    assert.deepEqual(await readFakeRunnerStarts(repo.logPath), [])
  })

  it("3. a verdict changes the lane only from the reviewer of the active attempt at that attempt's head", { skip: "WS5: verdicts bound to attempts (T025, T028)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo()
    assert.equal((await repo.btrain(needsReviewArgs({ dispatch: false }))).code, 0)
    const reviewer = AGENTS.otherLabA.name
    const resolve = () => repo.btrain(["handoff", "resolve", "--lane", "a", "--summary", "Looks right", "--actor", reviewer], { agent: reviewer })
    const firstHead = await repo.head()

    // The recorded reviewer, whose attempt has ended: no active attempt is its.
    // `failed`, not `unresponsive`: FR-6 applies a late verdict from an
    // unresponsive other-lab attempt at the same head, by design.
    await repo.appendEvents([
      ...openAttemptEvents({ head: firstHead }),
      { type: "review-attempt-ended", actor: AGENTS.owner.name, details: { attemptId: "t1", outcome: "failed", detail: "exit 2" } },
    ])
    await resolve()
    assert.match(await repo.handoffFile(), /^Status: needs-review$/m, "a verdict from an ended attempt changes nothing")

    // The active attempt's reviewer, after the owner moved the head.
    await repo.appendEvents(openAttemptEvents({ head: firstHead, attemptId: "t2", request: false }))
    const newHead = await repo.ownerCommit()
    await resolve()
    assert.match(await repo.handoffFile(), /^Status: needs-review$/m, "a verdict at another head changes nothing")

    // The active attempt's reviewer at that attempt's head: accepted.
    await repo.appendEvents(openAttemptEvents({ head: newHead, attemptId: "t3", requestId: "r2" }))
    const accepted = await resolve()
    assert.equal(accepted.code, 0, `${accepted.stdout}\n${accepted.stderr}`)
    assert.doesNotMatch(await repo.handoffFile(), /^Status: needs-review$/m, "the active attempt's verdict at its head is applied")
  })

  it("4. while a lane is needs-review with an open request, its recorded reviewer is the active attempt's reviewer", { skip: "WS5: the request loop (T028)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo()
    const quota = await fs.readFile(path.join(SAMPLES, "codex-usage-limit.txt"), "utf8")
    await repo.scenario({
      agents: {
        [AGENTS.otherLabA.name]: [{ do: "exit", code: 1, text: quota }],
        [AGENTS.otherLabB.name]: [{ do: "handoff" }, { do: "resolve", summary: "Looks right" }],
      },
    })
    const result = await repo.btrain(needsReviewArgs(), { env: DISPATCH_ON })
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
    // While gem's attempt was open, `btrain handoff` showed gem as the reviewer.
    const gemHandoff = (await readFakeRunnerLog(repo.logPath)).find((entry) => entry.kind === "step" && entry.agent === AGENTS.otherLabB.name && entry.do === "handoff")
    assert.ok(gemHandoff, "gem ran btrain handoff")
    // Anchored to the reviewer line, so a history line naming the earlier
    // reviewer does not count.
    assert.match(gemHandoff.stdout, new RegExp(`^\\s*(?:peer )?reviewer:\\s*${AGENTS.otherLabB.name}\\b`, "im"))
    assert.doesNotMatch(gemHandoff.stdout, new RegExp(`^\\s*(?:peer )?reviewer:\\s*${AGENTS.otherLabA.name}\\b`, "im"))
    const attempts = (await repo.events()).filter((event) => event.type === "review-attempt")
    assert.deepEqual(attempts.map((event) => event.details.reviewer), [AGENTS.otherLabA.name, AGENTS.otherLabB.name])
    for (const event of attempts) {
      assert.equal(event.after?.reviewer, event.details.reviewer, "the attempt and the reviewer are one write")
      assert.equal(event.after?.status, "needs-review")
    }
  })

  it("5. the stored status is never in-review or confirming-fix", { skip: "WS2: the review record and display (T011)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo()
    assert.equal((await repo.btrain(needsReviewArgs({ dispatch: false }))).code, 0)
    await repo.appendEvents(openAttemptEvents({ head: await repo.head() }))
    const pickup = await repo.btrain(["handoff", "--lane", "a"], { agent: AGENTS.otherLabA.name })
    assert.equal(pickup.code, 0, pickup.stderr)

    const status = await repo.btrain(["status"])
    assert.match(status.stdout, /lane a: in-review/)
    assert.match(await repo.handoffFile(), /^Status: needs-review$/m)
    assert.equal((await repo.record()).display, "in-review")

    for (const display of ["in-review", "confirming-fix"]) {
      const write = await repo.btrain(["handoff", "update", "--lane", "a", "--status", display, "--actor", AGENTS.owner.name])
      assert.notEqual(write.code, 0, `--status ${display} is refused`)
    }
    assert.doesNotMatch(await repo.handoffFile(), /^Status: (in-review|confirming-fix)$/m)
  })

  it("6. a lane enters ready-for-pr only by row 4 or ConfirmFix, and leaves fix-confirmation only by the owner's hand-off to needs-review", { skip: "WS7: reviewer fixes (T039); WS3 enforces the ready-for-pr half (T016)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo({ prFlow: true })
    for (const actor of [AGENTS.owner.name, AGENTS.otherLabA.name, "someone-else"]) {
      for (const status of ["ready-for-pr", "pr-review", "ready-to-merge", "fix-confirmation"]) {
        const result = await repo.btrain(["handoff", "update", "--lane", "a", "--status", status, "--actor", actor], { agent: actor })
        assert.notEqual(result.code, 0, `${actor} cannot --status ${status}`)
      }
    }
    assert.match(await repo.handoffFile(), /^Status: in-progress$/m)

    // Into fix-confirmation by the reviewer's fix, then no exit but the owner's.
    assert.equal((await repo.btrain(needsReviewArgs({ dispatch: false }))).code, 0)
    await repo.appendEvents(openAttemptEvents({ head: await repo.head() }))
    await repo.btrain(["handoff", "--lane", "a"], { agent: AGENTS.otherLabA.name })
    await repo.scenario({ agents: { [AGENTS.otherLabA.name]: [{ do: "commit", file: "src/feature.mjs", content: "export const feature = 3\n" }] } })
    await exec(path.join(repo.root, "bin", AGENTS.otherLabA.name, "codex"), [], {
      cwd: repo.repo,
      env: { ...withoutLaneScope(), ...fakeRunnerEnv({ scenarioPath: repo.scenarioPath, logPath: repo.logPath, cliPath: CLI }), BTRAIN_AGENT: AGENTS.otherLabA.name, BTRAIN_LANE: "a", BRAIN_TRAIN_HOME: repo.home },
    })
    const fix = await repo.btrain(["handoff", "fix", "--lane", "a", "--summary", "one-line fix", "--actor", AGENTS.otherLabA.name], { agent: AGENTS.otherLabA.name })
    assert.equal(fix.code, 0, `${fix.stdout}\n${fix.stderr}`)
    assert.match(await repo.handoffFile(), /^Status: fix-confirmation$/m)
    for (const actor of [AGENTS.owner.name, AGENTS.otherLabA.name]) {
      for (const status of ["in-progress", "ready-for-pr", "resolved"]) {
        const result = await repo.btrain(["handoff", "update", "--lane", "a", "--status", status, "--actor", actor], { agent: actor })
        assert.notEqual(result.code, 0, `${actor} cannot leave fix-confirmation for ${status}`)
      }
    }
    assert.match(await repo.handoffFile(), /^Status: fix-confirmation$/m)
  })

  it("7. the agent that confirms a fix is not in the lane's fixAuthors", { skip: "WS7: reviewer fixes (T039)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo({ prFlow: true })
    assert.equal((await repo.btrain(needsReviewArgs({ dispatch: false }))).code, 0)
    await repo.appendEvents(openAttemptEvents({ head: await repo.head() }))
    await repo.btrain(["handoff", "--lane", "a"], { agent: AGENTS.otherLabA.name })
    await repo.scenario({ agents: { [AGENTS.otherLabA.name]: [
      { do: "commit", file: "src/feature.mjs", content: "export const feature = 3\n" },
      { do: "fix", summary: "one-line fix" },
    ] } })
    await exec(path.join(repo.root, "bin", AGENTS.otherLabA.name, "codex"), [], {
      cwd: repo.repo,
      env: { ...withoutLaneScope(), ...fakeRunnerEnv({ scenarioPath: repo.scenarioPath, logPath: repo.logPath, cliPath: CLI }), BTRAIN_AGENT: AGENTS.otherLabA.name, BTRAIN_LANE: "a", BRAIN_TRAIN_HOME: repo.home },
    })
    assert.match(await repo.handoffFile(), /^Status: fix-confirmation$/m)
    assert.deepEqual((await repo.record()).fixAuthors, [AGENTS.otherLabA.name])

    const byFixAuthor = await repo.btrain(["handoff", "confirm-fix", "--lane", "a", "--summary", "ok", "--actor", AGENTS.otherLabA.name], { agent: AGENTS.otherLabA.name })
    assert.notEqual(byFixAuthor.code, 0, "the fix author cannot confirm")
    const byOwner = await repo.btrain(["handoff", "confirm-fix", "--lane", "a", "--summary", "Read the fix range; it is right."])
    assert.equal(byOwner.code, 0, `${byOwner.stdout}\n${byOwner.stderr}`)
    assert.match(await repo.handoffFile(), /^Status: ready-for-pr$/m)
  })

  it("8. a system reassignment changes the reviewer only, and the canonical actor after it is a lane agent", { skip: "WS5: the system reassignment (T024, T028)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo({ review: SHORT_REVIEW })
    const quota = await fs.readFile(path.join(SAMPLES, "codex-usage-limit.txt"), "utf8")
    await repo.scenario({
      agents: {
        [AGENTS.otherLabA.name]: [{ do: "exit", code: 1, text: quota }],
        [AGENTS.otherLabB.name]: [{ do: "handoff" }, { do: "exit", code: 1, text: "crashed" }],
      },
    })
    const update = await repo.btrain(needsReviewArgs(), { env: DISPATCH_ON })
    assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`)
    const reassignment = (await repo.events()).find((event) => event.type === "review-attempt" && event.details.previousReviewer && event.details.previousReviewer !== event.details.reviewer)
    assert.ok(reassignment, "the loop reassigned the lane")
    assert.equal(reassignment.actor, AGENTS.owner.name, "the event's actor is the owner")
    assert.equal(reassignment.details.by, "btrain-system")
    assert.equal(reassignment.after.owner, reassignment.before.owner, "the owner did not change")
    assert.equal(reassignment.details.reason, "next-other-lab")
    const canonicalTypes = new Set(["claim", "update", "request-changes", "resolve", "review-attempt"])
    const laneAgents = new Set(Object.values(AGENTS).map((agent) => agent.name))
    for (const event of (await repo.events()).filter((item) => canonicalTypes.has(item.type))) {
      assert.ok(laneAgents.has(event.actor), `${event.type} has the lane agent ${event.actor} as its actor, never btrain-system`)
    }

    // A repair after the reassignment goes to the owner, not to a reviewer.
    const repair = await repo.btrain(["handoff", "update", "--lane", "a", "--status", "repair-needed", "--reason-code", "spec-mismatch", "--actor", AGENTS.owner.name])
    assert.equal(repair.code, 0, `${repair.stdout}\n${repair.stderr}`)
    assert.match(await repo.handoffFile(), new RegExp(`^Repair Owner: ${AGENTS.owner.name}$`, "m"))
  })

  it("9. an attempt that ends without a verdict leaves the status needs-review; a runner failure is never an approval", { skip: "WS5: the request loop (T028)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo({ reviewers: ["otherLabA"] , review: SHORT_REVIEW })
    const quota = await fs.readFile(path.join(SAMPLES, "codex-usage-limit.txt"), "utf8")
    await repo.scenario({ agents: { [AGENTS.otherLabA.name]: { invocations: [[{ do: "exit", code: 1, text: quota }], [{ do: "exit", code: 2, text: "boom" }]] } } })
    const update = await repo.btrain(needsReviewArgs(), { env: DISPATCH_ON })
    assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`)
    assert.match(await repo.handoffFile(), /^Status: needs-review$/m)
    const events = await repo.events()
    assert.equal(events.filter((event) => event.type === "resolve").length, 0)
    // The quota exit, then a re-probe at each silence limit until the window
    // ends (FR-4), each exiting 2.
    const starts = await readFakeRunnerStarts(repo.logPath, AGENTS.otherLabA.name)
    assert.ok(starts.length >= 2, `re-probed after the quota exit: ${starts.length} starts`)
    const ended = events.filter((event) => event.type === "review-attempt-ended")
    assert.equal(ended.length, starts.length, "every attempt ended with a recorded outcome")
    assert.equal(ended[0].details.outcome, "tool_unavailable")
    assert.ok(ended.slice(1).every((event) => event.details.outcome === "failed"), JSON.stringify(ended.map((event) => event.details.outcome)))
    // No same-lab candidate is configured, so the request ends in an escalation.
    assert.equal(events.filter((event) => event.type === "review-escalation").length, 1)
  })

  describe("10. a same-lab review always has a recorded reason and the attempts that led to it, and shows its tier", () => {
    it("in btrain handoff and btrain status", { skip: "WS5: the request loop (T028)" }, async () => { // btrain-allow: skipped-test
      const repo = await createReviewRepo({ reviewers: ["sameLab"], review: SHORT_REVIEW })
      await repo.scenario({ agents: { [AGENTS.sameLab.name]: [{ do: "handoff" }, { do: "silent", ms: 200 }, { do: "exit", code: 0 }] } })
      const update = await repo.btrain(needsReviewArgs(), { env: DISPATCH_ON })
      assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`)
      const record = await repo.record()
      const sameLab = record.attempts.filter((attempt) => attempt.tier === "same-lab")
      assert.ok(sameLab.length >= 1)
      assert.ok(sameLab.every((attempt) => attempt.reason), "every same-lab attempt has a reason")
      assert.equal(sameLab[0].reason, "no-other-lab-configured")
      for (const args of [["handoff", "--lane", "a"], ["status"]]) {
        const result = await repo.btrain(args)
        assert.match(result.stdout, /review tier: same-lab/i, args.join(" "))
        assert.match(result.stdout, /no-other-lab-configured/, args.join(" "))
      }
    })

    it("in the PR body", { skip: "WS9: the tier in PR bodies (T043)" }, async () => { // btrain-allow: skipped-test
      const { buildPrBody } = await import(new URL("../src/brain_train/pr-flow.mjs", import.meta.url))
      const body = buildPrBody({
        laneId: "a", owner: AGENTS.owner.name, reviewer: AGENTS.sameLab.name, objective: "Change the feature",
        reviewRecord: { tier: "same-lab", fallbackReason: "other-lab-unavailable", attempts: [{ reviewer: AGENTS.otherLabA.name, outcome: "unresponsive" }] },
      })
      assert.match(body, /review tier: same-lab/i)
      assert.match(body, /other-lab-unavailable/)
    })
  })

  it("11. handoff fix is refused, with its own message, for each FR-11 condition that fails", { skip: "WS7: fix-rules.mjs (T033, T039)" }, async () => { // btrain-allow: skipped-test
    const { evaluateFixRules } = await reviewModule("fix-rules.mjs")
    const head = "a".repeat(40)
    const good = {
      tier: "other-lab",
      fixesEnabled: true,
      attempt: { head, startedAt: "2026-11-23T12:00:00.000Z", reviewer: AGENTS.otherLabA.name },
      fixBase: head,
      fixHeadDescendsFromBase: true,
      commits: [{ sha: "b".repeat(40), committedAt: "2026-11-23T12:05:00.000Z", trailerAgent: AGENTS.otherLabA.name }],
      files: ["src/feature.mjs"],
      lockedFiles: ["src/feature.mjs"],
      changedLines: 2,
      testLinesRemovedOrChanged: 0,
      weakenedTestFindings: 0,
      round: 1,
      limits: { maxFiles: 3, maxChangedLines: 60, maxRounds: 2 },
    }
    assert.deepEqual(evaluateFixRules(good).failures, [])
    const breaks = {
      tier: { tier: "same-lab" },
      enabled: { fixesEnabled: false },
      base: { fixBase: "c".repeat(40) },
      descends: { fixHeadDescendsFromBase: false },
      "commit-time": { commits: [{ ...good.commits[0], committedAt: "2026-11-23T11:59:00.000Z" }] },
      trailer: { commits: [{ ...good.commits[0], trailerAgent: "" }] },
      "locked-files": { files: ["src/other.mjs"] },
      "max-files": { files: ["a", "b", "c", "d"], lockedFiles: ["a", "b", "c", "d"] },
      "max-lines": { changedLines: 61 },
      "test-lines": { testLinesRemovedOrChanged: 1 },
      "weakened-tests": { weakenedTestFindings: 1 },
      rounds: { round: 3 },
    }
    const messages = new Set()
    for (const [name, change] of Object.entries(breaks)) {
      const { failures } = evaluateFixRules({ ...good, ...change })
      assert.equal(failures.length, 1, `${name} fails exactly one condition: ${JSON.stringify(failures)}`)
      messages.add(failures[0].message)
    }
    assert.equal(messages.size, Object.keys(breaks).length, "every condition has its own message")
  })

  it("12. core.mjs gains no function; the patchHandoff and runLoop pins change once each", { skip: "WS7: checked after the last core.mjs edit of spec 023 (T039)" }, async () => { // btrain-allow: skipped-test
    const stages = await exec("node", [path.join(REPO_ROOT, "scripts/decomposition_inventory.mjs"), "--stages"], { cwd: REPO_ROOT }).then(
      () => 0,
      (error) => error.code ?? 1,
    )
    assert.equal(stages, 0, "every core.mjs function is assigned in specs/020-ws2-module-assignment.json")
    const { readFunctionSpans } = await import(new URL("../scripts/decomposition_inventory.mjs", import.meta.url))
    const { spans } = readFunctionSpans(path.join(REPO_ROOT, "src/brain_train/core.mjs"))
    // "No new function" is the stage check above: every function must be
    // assigned in specs/020-ws2-module-assignment.json, which spec 023 does
    // not edit. A raw count would fail whenever another lane adds one.
    assert.equal(spans.find((span) => span.name === "patchHandoff").lines, 587, "WS4 adds one spread line to each gate input")
    const pinned = await fs.readFile(path.join(REPO_ROOT, "test/decomposition_inventory.test.mjs"), "utf8")
    const runLoopPin = Number(/name === "runLoop"\)\.lines, (\d+)/.exec(pinned)?.[1])
    assert.notEqual(runLoopPin, 422, "WS5 changed the runLoop pin")
    assert.equal(spans.find((span) => span.name === "runLoop").lines, runLoopPin)
  })

  it("13. a verdict with no open attempt is refused; a recorded reviewer that was not dispatched gets an attempt at pickup, at the request's head", { skip: "WS5: verdicts bound to attempts (T025, T028)" }, async () => { // btrain-allow: skipped-test
    const repo = await createReviewRepo()
    assert.equal((await repo.btrain(needsReviewArgs({ dispatch: false }))).code, 0)
    const requestHead = await repo.head()
    const reviewer = AGENTS.otherLabA.name

    const early = await repo.btrain(["handoff", "resolve", "--lane", "a", "--summary", "ok", "--actor", reviewer], { agent: reviewer })
    assert.notEqual(early.code, 0, "no open attempt: refused")
    assert.match(`${early.stdout}\n${early.stderr}`, /btrain handoff --lane a/, "the refusal names the command that opens one")

    const pickup = await repo.btrain(["handoff", "--lane", "a"], { agent: reviewer })
    assert.equal(pickup.code, 0, pickup.stderr)
    const record = await repo.record()
    const attempt = record.attempts.find((item) => item.id === record.activeAttemptId)
    assert.equal(attempt.reviewer, reviewer)
    assert.equal(attempt.opened, "pickup")
    assert.equal(attempt.head, requestHead)
    assert.ok(attempt.pickedUpAt)

    const verdict = await repo.btrain(["handoff", "resolve", "--lane", "a", "--summary", "Looks right", "--actor", reviewer], { agent: reviewer })
    assert.equal(verdict.code, 0, `${verdict.stdout}\n${verdict.stderr}`)
  })
})
