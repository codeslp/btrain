import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

function cliEnv(home, agent) {
  const env = { ...process.env }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) {
    delete env[key]
  }
  return { ...env, BRAIN_TRAIN_HOME: home, BTRAIN_NO_REVIEW_DISPATCH: "1", CI: "true", BTRAIN_AGENT: agent }
}

async function btrain(args, { cwd, home, agent = "alpha" }) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], { cwd, env: cliEnv(home, agent), maxBuffer: 5 * 1024 * 1024 })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return { stdout: error.stdout?.trim() || "", stderr: error.stderr?.trim() || "", code: typeof error.code === "number" ? error.code : 1 }
  }
}

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

const REVIEW_CONTEXT = [
  "--preflight", "read the lane files",
  "--changed", "src/a/feature.mjs - the change",
  "--verification", "node --test",
  "--gap", "none",
  "--why", "exercise doctor",
  "--review-ask", "none",
]

// A PR-flow repo with lane a parked at the given status and its locks
// acquired 25 hours ago. Returns the repo path and the lock paths.
async function withLaneAt(status, fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-doctor-prflow-")))
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  try {
    await exec("git", ["init", "-q", "-b", "main", repo])
    await git(repo, "config", "user.email", "test@example.com")
    await git(repo, "config", "user.name", "Test Bot")
    await git(repo, "config", "commit.gpgsign", "false")
    await fs.mkdir(path.join(repo, "src", "a"), { recursive: true })
    await fs.writeFile(path.join(repo, "src", "a", "feature.mjs"), "export const feature = 1\n")
    const init = await btrain(["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--core-only", "--no-hooks"], { cwd: repo, home })
    assert.equal(init.code, 0, init.stderr)
    await fs.appendFile(path.join(repo, ".btrain", "project.toml"), '\n[pr_flow]\nenabled = true\nbase = "main"\n')
    await git(repo, "add", "-A")
    await git(repo, "commit", "-q", "-m", "base")

    const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "doctor lane", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: repo, home })
    assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)

    if (status !== "in-progress") {
      const review = await btrain(["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-diff", "--no-dispatch", ...REVIEW_CONTEXT], { cwd: repo, home })
      assert.equal(review.code, 0, `${review.stdout}\n${review.stderr}`)
      const approve = await btrain(["handoff", "resolve", "--lane", "a", "--summary", "approved locally", "--actor", "beta"], { cwd: repo, home, agent: "beta" })
      assert.equal(approve.code, 0, `${approve.stdout}\n${approve.stderr}`)
      assert.match(approve.stdout, /ready-for-pr/)
      if (status !== "ready-for-pr") {
        const link = await btrain(["handoff", "update", "--lane", "a", "--status", "pr-review", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
        assert.equal(link.code, 0, `${link.stdout}\n${link.stderr}`)
      }
      if (status === "ready-to-merge") {
        const clear = await btrain(["handoff", "update", "--lane", "a", "--status", "ready-to-merge", "--actor", "alpha"], { cwd: repo, home })
        assert.equal(clear.code, 0, `${clear.stdout}\n${clear.stderr}`)
      }
      if (status === "changes-requested") {
        const round = await btrain(["handoff", "update", "--lane", "a", "--status", "changes-requested", "--reason-code", "pr-review-feedback", "--pr", "7", "--actor", "alpha"], { cwd: repo, home })
        assert.equal(round.code, 0, `${round.stdout}\n${round.stderr}`)
      }
    }

    const locksPath = path.join(repo, ".btrain", "locks.json")
    const registry = JSON.parse(await fs.readFile(locksPath, "utf8"))
    const acquired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    for (const lock of registry.locks) lock.acquired_at = acquired
    await fs.writeFile(locksPath, JSON.stringify(registry, null, 2))

    await fn({ repo, home, locksPath })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("doctor and lock TTL on PR-flow lanes", () => {
  it("keeps pr-review locks past the TTL: no warning, and --repair leaves them in place", async () => {
    await withLaneAt("pr-review", async ({ repo, home, locksPath }) => {
      const check = await btrain(["doctor", "--repo", repo], { cwd: repo, home })
      assert.doesNotMatch(check.stdout, /older than 24h TTL/, check.stdout)

      const repair = await btrain(["doctor", "--repo", repo, "--repair"], { cwd: repo, home })
      assert.doesNotMatch(repair.stdout, /released \d+ expired lock/, repair.stdout)
      const registry = JSON.parse(await fs.readFile(locksPath, "utf8"))
      assert.ok(registry.locks.some((lock) => lock.lane === "a" && lock.path === "src/a/"), "the PR's locks survive a repair")
    })
  })

  it("keeps ready-for-pr locks past the TTL too", async () => {
    await withLaneAt("ready-for-pr", async ({ repo, home }) => {
      const check = await btrain(["doctor", "--repo", repo], { cwd: repo, home })
      assert.doesNotMatch(check.stdout, /older than 24h TTL/, check.stdout)
    })
  })

  it("keeps ready-to-merge locks past the TTL", async () => {
    await withLaneAt("ready-to-merge", async ({ repo, home }) => {
      const check = await btrain(["doctor", "--repo", repo], { cwd: repo, home })
      assert.doesNotMatch(check.stdout, /older than 24h TTL/, check.stdout)
    })
  })

  it("keeps the locks of a PR-linked changes-requested round past the TTL", async () => {
    await withLaneAt("changes-requested", async ({ repo, home, locksPath }) => {
      const repair = await btrain(["doctor", "--repo", repo, "--repair"], { cwd: repo, home })
      assert.doesNotMatch(repair.stdout, /released \d+ expired lock/, repair.stdout)
      const registry = JSON.parse(await fs.readFile(locksPath, "utf8"))
      assert.ok(registry.locks.some((lock) => lock.lane === "a"), "the fix round keeps its locks")
    })
  })

  it("still warns about and releases expired locks on an in-progress lane", async () => {
    await withLaneAt("in-progress", async ({ repo, home, locksPath }) => {
      const check = await btrain(["doctor", "--repo", repo], { cwd: repo, home })
      assert.match(check.stdout, /older than 24h TTL/)
      const repair = await btrain(["doctor", "--repo", repo, "--repair"], { cwd: repo, home })
      assert.match(repair.stdout, /released 1 expired lock/)
      const registry = JSON.parse(await fs.readFile(locksPath, "utf8"))
      assert.equal(registry.locks.filter((lock) => lock.lane === "a").length, 0)
    })
  })
})
