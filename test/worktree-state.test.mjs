import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { resolveStateRoot, isLinkedWorktree, clearStateRootCache } from "../src/brain_train/worktree.mjs"

const exec = promisify(execFile)

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

async function makeRepo(root) {
  const repo = path.join(root, "repo")
  await exec("git", ["init", "-q", "-b", "main", repo])
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Test Bot")
  await git(repo, "config", "commit.gpgsign", "false")
  await fs.writeFile(path.join(repo, "README.md"), "base\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "base")
  return repo
}

async function withTmp(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-worktree-state-")))
  try {
    await fn(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("resolveStateRoot", () => {
  beforeEach(() => clearStateRootCache())

  it("is the checkout itself for a primary checkout", async () => {
    await withTmp(async (root) => {
      const repo = await makeRepo(root)
      assert.equal(resolveStateRoot(repo), repo)
      assert.equal(isLinkedWorktree(repo), false)
    })
  })

  it("is the main worktree for a linked worktree, wherever it lives", async () => {
    await withTmp(async (root) => {
      const repo = await makeRepo(root)
      const sibling = path.join(root, "sibling-worktree")
      const nested = path.join(repo, ".claude", "worktrees", "nested")
      await git(repo, "worktree", "add", "-q", "-b", "lane-x", sibling)
      await git(repo, "worktree", "add", "-q", "-b", "lane-y", nested)
      assert.equal(resolveStateRoot(sibling), repo)
      assert.equal(resolveStateRoot(nested), repo)
      assert.equal(isLinkedWorktree(sibling), true)
      // The primary checkout is unaffected by having linked worktrees.
      assert.equal(resolveStateRoot(repo), repo)
    })
  })

  it("is the checkout itself for a submodule-style .git pointer with no commondir", async () => {
    await withTmp(async (root) => {
      const outer = await makeRepo(root)
      const inner = path.join(root, "inner")
      await fs.mkdir(path.join(outer, ".git", "modules", "inner"), { recursive: true })
      await fs.mkdir(inner)
      await fs.writeFile(path.join(inner, ".git"), `gitdir: ${path.join(outer, ".git", "modules", "inner")}\n`)
      assert.equal(resolveStateRoot(inner), inner)
    })
  })

  it("is the directory itself when it is not a git checkout", async () => {
    await withTmp(async (root) => {
      const plain = path.join(root, "plain")
      await fs.mkdir(plain)
      assert.equal(resolveStateRoot(plain), plain)
    })
  })

  it("does not follow a pointer whose common dir is not a working tree's .git", async () => {
    await withTmp(async (root) => {
      const bare = path.join(root, "bare.git")
      await exec("git", ["init", "-q", "--bare", bare])
      const fake = path.join(root, "fake")
      await fs.mkdir(path.join(bare, "worktrees", "fake"), { recursive: true })
      await fs.writeFile(path.join(bare, "worktrees", "fake", "commondir"), "../..\n")
      await fs.mkdir(fake)
      await fs.writeFile(path.join(fake, ".git"), `gitdir: ${path.join(bare, "worktrees", "fake")}\n`)
      assert.equal(resolveStateRoot(fake), fake)
    })
  })
})

// ---------------------------------------------------------------------------
// End to end: btrain pointed at a linked worktree shares the main checkout's
// lane state and diffs the worktree's own branch.
// ---------------------------------------------------------------------------

const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

function cliEnv(home, agent) {
  const env = { ...process.env }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) {
    delete env[key]
  }
  return {
    ...env,
    BRAIN_TRAIN_HOME: home,
    BTRAIN_NO_REVIEW_DISPATCH: "1",
    CI: "true",
    BTRAIN_AGENT: agent,
  }
}

async function btrain(args, { cwd, home, agent = "alpha" }) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], { cwd, env: cliEnv(home, agent), maxBuffer: 5 * 1024 * 1024 })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      code: typeof error.code === "number" ? error.code : 1,
    }
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

describe("btrain in a linked worktree", () => {
  beforeEach(() => clearStateRootCache())

  it("claims, reads and reviews one lane set from the main checkout while diffing the worktree branch", async () => {
    await withTmp(async (root) => {
      const home = path.join(root, "home")
      const repo = await makeRepo(root)
      await fs.mkdir(path.join(repo, "src", "a"), { recursive: true })
      await fs.writeFile(path.join(repo, "src", "a", "base.mjs"), "export const base = 1\n")
      await git(repo, "add", "-A")
      await git(repo, "commit", "-q", "-m", "src")

      const init = await btrain(["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--core-only", "--no-hooks"], { cwd: repo, home })
      assert.equal(init.code, 0, init.stderr)
      await git(repo, "add", "-A")
      await git(repo, "commit", "-q", "-m", "btrain init")

      // The lane's work lives on a branch checked out in a linked worktree.
      const worktree = path.join(root, "lane-a-worktree")
      await git(repo, "worktree", "add", "-q", "-b", "lane-a-work", worktree)
      await fs.writeFile(path.join(worktree, "src", "a", "feature.mjs"), "export const feature = true\n")
      await git(worktree, "add", "-A")
      await git(worktree, "commit", "-q", "-m", "lane a work")

      // Claim from inside the worktree.
      const claim = await btrain(
        ["handoff", "claim", "--lane", "a", "--task", "worktree lane", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"],
        { cwd: worktree, home },
      )
      assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)

      // State landed in the main checkout, and nowhere in the worktree.
      const mainHandoff = path.join(repo, ".claude", "collab", "HANDOFF_A.md")
      assert.equal(await exists(mainHandoff), true, "handoff file lives in the main checkout")
      assert.match(await fs.readFile(mainHandoff, "utf8"), /worktree lane/)
      assert.equal(await exists(path.join(worktree, ".claude", "collab", "HANDOFF_A.md")), false, "no handoff copy in the worktree")
      assert.equal(await exists(path.join(worktree, ".btrain", "locks.json")), false, "no lock registry in the worktree")
      const locks = JSON.parse(await fs.readFile(path.join(repo, ".btrain", "locks.json"), "utf8"))
      assert.ok(locks.locks.some((lock) => lock.lane === "a" && lock.path === "src/a/"), "lock recorded in the main registry")

      // Both checkouts read the same lane, under the repository's name.
      const fromWorktree = await btrain(["handoff", "--lane", "a"], { cwd: worktree, home })
      assert.equal(fromWorktree.code, 0, fromWorktree.stderr)
      assert.match(fromWorktree.stdout, /^repo: repo$/m, "the worktree reports the repository, not its own directory name")
      assert.match(fromWorktree.stdout, /status: in-progress/)
      const fromMain = await btrain(["handoff", "--lane", "a"], { cwd: repo, home })
      assert.match(fromMain.stdout, /status: in-progress/)

      // needs-review without --no-diff: the diff gate runs against the
      // worktree's branch, where the locked files really changed.
      const review = await btrain(
        [
          "handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha",
          "--base", "main", "--no-dispatch",
          "--preflight", "read src/a before editing",
          "--changed", "src/a/feature.mjs - new feature flag",
          "--verification", "node --test",
          "--gap", "none",
          "--why", "exercise the worktree diff gate",
          "--review-ask", "confirm the diff is read from the worktree",
        ],
        { cwd: worktree, home },
      )
      assert.equal(review.code, 0, `${review.stdout}\n${review.stderr}`)
      assert.match(await fs.readFile(mainHandoff, "utf8"), /^Status: needs-review/m)

      // The same command from the main checkout, whose tree has no such diff,
      // still fails the gate: the worktree is what made the diff reviewable.
      const fromMainReview = await btrain(["handoff", "--lane", "a"], { cwd: repo, home })
      assert.match(fromMainReview.stdout, /status: needs-review/)
    })
  })
})

describe("managed hooks in a linked worktree", () => {
  beforeEach(() => clearStateRootCache())

  it("pre-commit reads the main checkout's handoff files, not the worktree's", async () => {
    await withTmp(async (root) => {
      const home = path.join(root, "home")
      const repo = await makeRepo(root)
      await fs.mkdir(path.join(repo, "src", "a"), { recursive: true })
      await fs.writeFile(path.join(repo, "src", "a", "base.mjs"), "export const base = 1\n")
      await git(repo, "add", "-A")
      await git(repo, "commit", "-q", "-m", "src")
      const init = await btrain(["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--core-only", "--hooks"], { cwd: repo, home })
      assert.equal(init.code, 0, init.stderr)
      await git(repo, "add", "-A")
      await git(repo, "commit", "-q", "-m", "btrain init")

      const worktree = path.join(root, "lane-a-worktree")
      await git(repo, "worktree", "add", "-q", "-b", "lane-a-work", worktree)

      // Lane a goes to needs-review with src/a/ locked; the handoff file exists
      // only in the main checkout.
      const claim = await btrain(["handoff", "claim", "--lane", "a", "--task", "hook lane", "--owner", "alpha", "--reviewer", "beta", "--files", "src/a/"], { cwd: worktree, home })
      assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)
      await fs.writeFile(path.join(worktree, "src", "a", "feature.mjs"), "export const feature = true\n")
      await git(worktree, "add", "-A")
      await git(worktree, "commit", "-q", "-m", "lane a work")
      const review = await btrain(
        ["handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "alpha", "--base", "main", "--no-dispatch",
          "--preflight", "p", "--changed", "src/a/feature.mjs - x", "--verification", "v", "--gap", "g", "--why", "w", "--review-ask", "r"],
        { cwd: worktree, home },
      )
      assert.equal(review.code, 0, `${review.stdout}\n${review.stderr}`)
      assert.equal(await exists(path.join(worktree, ".claude", "collab", "HANDOFF_A.md")), false)

      // A commit in the worktree touching the locked path, by the owner, is
      // blocked by the hook even though the worktree holds no handoff copy.
      await fs.writeFile(path.join(worktree, "src", "a", "feature.mjs"), "export const feature = false\n")
      await git(worktree, "add", "-A")
      await assert.rejects(
        exec("git", ["-C", worktree, "commit", "-q", "-m", "owner edits during review"], { env: { ...cliEnv(home, "alpha") } }),
        (error) => /blocked commit/.test(`${error.stdout}${error.stderr}`),
        "the pre-commit hook blocks using the main checkout's lane state",
      )
      // The reviewer may commit.
      await exec("git", ["-C", worktree, "commit", "-q", "-m", "reviewer edits"], { env: { ...cliEnv(home, "beta") } })
    })
  })
})
