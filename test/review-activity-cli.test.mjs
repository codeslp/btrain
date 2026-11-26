// Spec 023 T010, the CLI part: `cli.mjs` calls review/activity.mjs after
// `resolveRepoRoot` in the lane-scoped handlers `handoff`, `review`, and `pr`.
// The dispatched reviewer's first `btrain handoff` writes one pickup; any
// other lane-scoped command writes progress at most once a minute; another
// agent, an unverified actor, `btrain pr status`, and the startup snapshot
// write nothing.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { appendWorkflowEvent, getStartupSnapshot, readProjectConfig, readWorkflowEvents } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

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

// Lane a claimed by alpha, in needs-review, with an open review attempt for
// beta, as a dispatch writes it (WS5 writes it for real).
async function withReviewLane(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-activity-cli-")))
  roots.push(root)
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  await exec("git", ["init", "-q", "-b", "main", repo])
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Test Bot")
  await git(repo, "config", "commit.gpgsign", "false")
  const init = await btrain(["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--agent", "gamma", "--core-only", "--no-hooks"], { cwd: repo, home })
  assert.equal(init.code, 0, init.stderr)
  await fs.mkdir(path.join(repo, "src"), { recursive: true })
  await fs.writeFile(path.join(repo, "src", "feature.mjs"), "export const feature = 0\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "base")
  await git(repo, "checkout", "-q", "-b", "feat/activity")
  const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "change the feature", "--owner", "alpha", "--reviewer", "beta", "--files", "src/"], { cwd: repo, home, agent: "alpha" })
  assert.equal(claim.code, 0, claim.stderr)
  await fs.writeFile(path.join(repo, "src", "feature.mjs"), "export const feature = 1\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "change")
  const handoff = await btrain(["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-dispatch",
    "--preflight", "read the files", "--changed", "src/feature.mjs - the change", "--verification", "node --test",
    "--verification", "- [X] code-simplifier passed", "--gap", "none", "--why", "exercise activity", "--review-ask", "check it"], { cwd: repo, home, agent: "alpha" })
  assert.equal(handoff.code, 0, `${handoff.stdout}\n${handoff.stderr}`)
  const config = await readProjectConfig(repo)
  await appendWorkflowEvent(repo, config, {
    laneId: "a", type: "review-attempt", actor: "alpha",
    details: { attemptId: "t1", requestId: "r1", reviewer: "beta", previousReviewer: "", reason: "", tier: "other-lab", head: await git(repo, "rev-parse", "HEAD"), opened: "dispatch", by: "btrain-system" },
  })
  const signals = async () => (await readWorkflowEvents(repo, config, "a")).filter((event) => event.type === "review-pickup" || event.type === "review-progress")
  await fn({ repo, home, config, signals, run: (args, agent) => btrain(args, { cwd: repo, home, agent }) })
}

describe("review activity from the CLI (spec 023 T010)", () => {
  it("writes one pickup for the dispatched reviewer's btrain handoff, and no second", async () => {
    await withReviewLane(async ({ run, signals }) => {
      assert.equal((await run(["handoff", "--lane", "a"], "beta")).code, 0)
      assert.deepEqual((await signals()).map((event) => [event.type, event.actor, event.details.attemptId]), [["review-pickup", "beta", "t1"]])
      assert.equal((await run(["handoff", "--lane", "a"], "beta")).code, 0)
      assert.equal((await signals()).length, 1, "a second btrain handoff writes nothing")
    })
  })

  it("writes one progress event for btrain review code --lane, at most once a minute", async () => {
    await withReviewLane(async ({ run, signals }) => {
      const first = await run(["review", "code", "--lane", "a", "--base", "main"], "beta")
      assert.ok(first.code === 0 || first.code === 2, first.stderr)
      assert.deepEqual((await signals()).map((event) => event.type), ["review-progress"])
      await run(["review", "code", "--lane", "a", "--base", "main"], "beta")
      assert.equal((await signals()).length, 1, "a second command within the minute writes nothing")
    })
  })

  it("takes the lane from BTRAIN_LANE as the handlers do", async () => {
    await withReviewLane(async ({ repo, home, signals }) => {
      const env = { ...cliEnv(home, "beta"), BTRAIN_LANE: "a" }
      await exec("node", [CLI_PATH, "handoff"], { cwd: repo, env })
      assert.deepEqual((await signals()).map((event) => event.type), ["review-pickup"])
    })
  })

  it("writes nothing for another agent, an unverified actor, btrain pr status, or the startup snapshot", async () => {
    await withReviewLane(async ({ repo, run, signals }) => {
      await run(["handoff", "--lane", "a"], "gamma")
      await run(["handoff", "--lane", "a"], "alpha")
      await run(["handoff", "--lane", "a"], "nobody")
      await run(["handoff", "--lane", "a"], "")
      await run(["pr", "status", "--lane", "a"], "beta")
      await getStartupSnapshot(repo)
      assert.deepEqual(await signals(), [])
    })
  })
})
