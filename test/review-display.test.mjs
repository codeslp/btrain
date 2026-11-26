// Spec 023 T011: the review display state, the reviewer, the time since
// dispatch or pickup, the tier, and the fallback reason, in `btrain status`,
// the lane guidance of `btrain handoff`, and the dashboard. The stored
// status is never replaced: the handoff file keeps `needs-review`.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { formatReviewLine, reviewSummary } from "../src/brain_train/review/record.mjs"
import { appendWorkflowEvent, getLaneConfigs, readProjectConfig } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")
const DASHBOARD_PATH = path.resolve("scripts/serve-dashboard.js")

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

const T0 = "2026-11-26T10:00:00.000Z"
const ev = (type, details, recordedAt = T0) => ({ type, laneId: "a", actor: "alpha", recordedAt, details })
const attempt = (overrides = {}) => ev("review-attempt", { attemptId: "t1", requestId: "r1", reviewer: "beta", previousReviewer: "", reason: "", tier: "other-lab", head: "h", opened: "dispatch", by: "btrain-system", startedAt: T0, ...overrides })

describe("reviewSummary and formatReviewLine (review/record.mjs)", () => {
  it("is dispatched until pickup, then in-review from the pickup", () => {
    const dispatched = reviewSummary([attempt()], { status: "needs-review" })
    assert.deepEqual(dispatched, { display: "needs-review", reviewer: "beta", since: { kind: "dispatched", at: T0 }, tier: "other-lab", fallbackReason: "" })
    const pickedUpAt = "2026-11-26T10:02:00.000Z"
    const picked = reviewSummary([attempt(), ev("review-pickup", { attemptId: "t1", at: pickedUpAt })], { status: "needs-review" })
    assert.deepEqual(picked, { display: "in-review", reviewer: "beta", since: { kind: "picked up", at: pickedUpAt }, tier: "other-lab", fallbackReason: "" })
    assert.equal(formatReviewLine(picked, { now: Date.parse("2026-11-26T10:05:30.000Z") }), "review: in-review · reviewer beta · picked up 3m ago · tier other-lab")
  })

  it("shows the same-lab fallback reason with the tier", () => {
    const summary = reviewSummary([attempt({ tier: "same-lab", reason: "no-other-lab-configured" })], { status: "needs-review" })
    assert.equal(summary.fallbackReason, "no-other-lab-configured")
    assert.equal(formatReviewLine(summary, { now: Date.parse(T0) + 30_000 }), "review: needs-review · reviewer beta · dispatched 0m ago · tier same-lab · fallback no-other-lab-configured")
  })

  it("is needs-review again once the attempt ended unresponsive", () => {
    const ended = [attempt(), ev("review-pickup", { attemptId: "t1", at: T0 }), ev("review-attempt-ended", { attemptId: "t1", outcome: "unresponsive", detail: "" })]
    const summary = reviewSummary(ended, { status: "needs-review" })
    assert.equal(summary.display, "needs-review")
    assert.equal(summary.reviewer, "")
    assert.equal(summary.since, null)
  })

  it("ignores events from before the last claim, and has no line without a review", () => {
    const summary = reviewSummary([attempt(), ev("review-pickup", { attemptId: "t1", at: T0 }), ev("claim", {})], { status: "needs-review" })
    assert.deepEqual(summary, { display: "needs-review", reviewer: "", since: null, tier: "", fallbackReason: "" })
    assert.equal(formatReviewLine(summary), "")
    assert.equal(formatReviewLine(null), "")
  })
})

function cliEnv(home, agent) {
  const env = { ...process.env }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE", "CLAUDECODE", "CODEX_SANDBOX"]) delete env[key]
  const out = { ...env, BRAIN_TRAIN_HOME: home, BTRAIN_NO_REVIEW_DISPATCH: "1", CI: "true" }
  if (agent) out.BTRAIN_AGENT = agent
  return out
}

async function btrain(args, { cwd, home, agent }) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], { cwd, env: cliEnv(home, agent), maxBuffer: 5 * 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout || "", stderr: error.stderr || "", code: typeof error.code === "number" ? error.code : 1 }
  }
}

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

// Lane a in needs-review with an open attempt for beta (dispatch writes it
// for real in WS5), beta's pickup not yet run.
async function withReviewLane(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-display-")))
  roots.push(root)
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  await exec("git", ["init", "-q", "-b", "main", repo])
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Test Bot")
  await git(repo, "config", "commit.gpgsign", "false")
  const run = (args, agent) => btrain(args, { cwd: repo, home, agent })
  assert.equal((await run(["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--core-only", "--no-hooks"])).code, 0)
  await fs.mkdir(path.join(repo, "src"), { recursive: true })
  await fs.writeFile(path.join(repo, "src", "feature.mjs"), "export const feature = 0\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "base")
  await git(repo, "checkout", "-q", "-b", "feat/display")
  assert.equal((await run(["handoff", "claim", "--lane", "a", "--task", "change the feature", "--owner", "alpha", "--reviewer", "beta", "--files", "src/"], "alpha")).code, 0)
  await fs.writeFile(path.join(repo, "src", "feature.mjs"), "export const feature = 1\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "change")
  const handoff = await run(["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-dispatch",
    "--preflight", "read the files", "--changed", "src/feature.mjs - the change", "--verification", "node --test",
    "--verification", "- [X] code-simplifier passed", "--gap", "none", "--why", "exercise display", "--review-ask", "check it"], "alpha")
  assert.equal(handoff.code, 0, handoff.stderr)
  const config = await readProjectConfig(repo)
  await appendWorkflowEvent(repo, config, attempt({ head: await git(repo, "rev-parse", "HEAD"), startedAt: new Date().toISOString() }))
  const handoffFile = path.resolve(repo, getLaneConfigs(config).find((lane) => lane.id === "a").handoffPath)
  await fn({ repo, home, run, handoffFile })
}

describe("the display in btrain status and btrain handoff (spec 023 T011)", () => {
  it("shows in-review after pickup while the handoff file keeps needs-review", async () => {
    await withReviewLane(async ({ run, handoffFile }) => {
      const before = await run(["status"])
      assert.match(before.stdout, /lane a: needs-review/)
      assert.match(before.stdout, /review: needs-review · reviewer beta · dispatched \d+m ago · tier other-lab/)

      assert.equal((await run(["handoff", "--lane", "a"], "beta")).code, 0)
      const after = await run(["status"])
      assert.match(after.stdout, /lane a: in-review/)
      assert.match(after.stdout, /review: in-review · reviewer beta · picked up \d+m ago · tier other-lab/)
      assert.match(await fs.readFile(handoffFile, "utf8"), /^Status: needs-review$/m)

      const json = JSON.parse((await run(["status", "--json"])).stdout)
      const laneA = json[0].lanes.find((lane) => lane._laneId === "a")
      assert.equal(laneA.status, "needs-review", "the stored status is unchanged in the JSON")
      assert.equal(laneA.review.display, "in-review")
      assert.equal(laneA.review.since.kind, "picked up")

      const guidance = await run(["handoff", "--lane", "a"], "alpha")
      assert.match(guidance.stdout, /review: in-review · reviewer beta · picked up \d+m ago/)
      assert.match(guidance.stdout, /status: needs-review/, "btrain handoff still prints the stored status")
    })
  })

  it("adds no review line for a lane that is not under review", async () => {
    await withReviewLane(async ({ run }) => {
      const status = await run(["status"])
      const otherLines = status.stdout.split("\n").filter((line) => /^\s+lane [b-z]:/.test(line))
      assert.ok(otherLines.length > 0)
      assert.doesNotMatch(status.stdout.split("lane b:")[1] || "", /^\s+review:/m)
    })
  })
})

describe("the display in the dashboard (spec 023 T011)", () => {
  it("shows the display state, reviewer, time, and tier for a lane under review", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-dashboard-display-"))
    roots.push(root)
    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    const pickedUpAt = new Date(Date.now() - 4 * 60_000).toISOString()
    const statusJson = JSON.stringify([{
      name: "repo", path: root, current: { status: "needs-review" },
      lanes: [{ _laneId: "a", status: "needs-review", task: "change", owner: "alpha", reviewer: "beta", lockPaths: [],
        review: { display: "in-review", reviewer: "beta", since: { kind: "picked up", at: pickedUpAt }, tier: "same-lab", fallbackReason: "no-other-lab-configured" } }],
    }])
    await fs.writeFile(path.join(bin, "btrain"), `#!/bin/sh\ncat <<'JSON'\n${statusJson}\nJSON\n`, { mode: 0o755 })
    const port = 40000 + Math.floor(Math.random() * 20000)
    const server = spawn("node", [DASHBOARD_PATH], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] })
    t.after(() => server.kill())
    await new Promise((resolve, reject) => {
      server.stdout.on("data", (chunk) => { if (String(chunk).includes("running")) resolve() })
      server.on("exit", (code) => reject(new Error(`dashboard exited ${code}`)))
    })
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/status`, (res) => {
        let data = ""
        res.on("data", (chunk) => { data += chunk })
        res.on("end", () => resolve(JSON.parse(data)))
      }).on("error", reject)
    })
    const lane = body.lanes[0]
    assert.equal(lane.status, "needs-review", "the stored status stays")
    assert.equal(lane.display, "in-review")
    assert.match(lane.review, /^review: in-review · reviewer beta · picked up 4m ago · tier same-lab · fallback no-other-lab-configured$/)
    assert.match(lane.fullText, /^Review: in-review · reviewer beta · picked up 4m ago · tier same-lab · fallback no-other-lab-configured$/m)
  })
})
