// Regression tests for unlocked check-then-act paths over btrain's shared
// state: single-use overrides, the lockfile primitive itself, handoff history
// compaction, and the spilled next-action reader in a linked worktree.

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"

import {
  compactHandoffHistory,
  consumeOverride,
  extractSpillPathFromNextAction,
  grantOverride,
  listActiveOverrides,
  readSpilledNextActionBody,
  withFileLock,
} from "../src/brain_train/core.mjs"
import { clearStateRootCache } from "../src/brain_train/worktree.mjs"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"

const exec = promisify(execFile)
const CLI_PATH = path.resolve("src/brain_train/cli.mjs")

async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-C", cwd, ...args])
  return stdout.trim()
}

async function btrain(args, { cwd, home, agent = "alpha" }) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], {
      cwd,
      env: { ...withoutLaneScope(), BRAIN_TRAIN_HOME: home, CI: "true", BTRAIN_AGENT: agent },
      maxBuffer: 5 * 1024 * 1024,
    })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      code: typeof error.code === "number" ? error.code : 1,
    }
  }
}

async function withTmp(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-state-races-")))
  try {
    await fn(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// A committed, btrain-initialised repository with lanes for alpha and beta.
async function makeBtrainRepo(root) {
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  await exec("git", ["init", "-q", "-b", "main", repo])
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Test Bot")
  await git(repo, "config", "commit.gpgsign", "false")
  await fs.mkdir(path.join(repo, "src"), { recursive: true })
  await fs.writeFile(path.join(repo, "src", "base.mjs"), "export const base = 1\n")
  const init = await btrain(
    ["init", repo, "--tracked", "--agent", "alpha", "--agent", "beta", "--core-only", "--no-hooks"],
    { cwd: repo, home },
  )
  assert.equal(init.code, 0, init.stderr)
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "base")
  return { repo, home }
}

async function countWorkflowEvents(repo, type) {
  const eventsDir = path.join(repo, ".btrain", "events")
  let count = 0
  for (const name of await fs.readdir(eventsDir).catch(() => [])) {
    const lines = (await fs.readFile(path.join(eventsDir, name), "utf8")).split("\n").filter(Boolean)
    count += lines.filter((line) => JSON.parse(line).type === type).length
  }
  return count
}

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false)
}

beforeEach(() => clearStateRootCache())

describe("single-use overrides under concurrency", () => {
  it("lets exactly one of several concurrent consumers take a single override", async () => {
    await withTmp(async (root) => {
      const { repo } = await makeBtrainRepo(root)
      await grantOverride(repo, {
        action: "push",
        requestedBy: "alpha",
        confirmedBy: "human",
        reason: "single-use override race repro",
      })

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) => consumeOverride(repo, { action: "push", actor: `consumer-${index}` })),
      )
      const fulfilled = results.filter((result) => result.status === "fulfilled")
      const rejected = results.filter((result) => result.status === "rejected")

      assert.equal(fulfilled.length, 1, `one override authorises one action, but ${fulfilled.length} consumers succeeded`)
      for (const result of rejected) {
        assert.match(result.reason.message, /No active override found/)
      }
      assert.equal(await countWorkflowEvents(repo, "override-consumed"), 1, "the audit log records one consumption")
      assert.deepEqual(await listActiveOverrides(repo), [])
    })
  })

  it("lets exactly one of several concurrent grants create the override for an action and scope", async () => {
    await withTmp(async (root) => {
      const { repo } = await makeBtrainRepo(root)

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          grantOverride(repo, {
            action: "push",
            requestedBy: "alpha",
            confirmedBy: "human",
            reason: `concurrent grant ${index}`,
          }),
        ),
      )
      const fulfilled = results.filter((result) => result.status === "fulfilled")
      const rejected = results.filter((result) => result.status === "rejected")

      assert.equal(fulfilled.length, 1, `one override per action and scope, but ${fulfilled.length} grants succeeded`)
      for (const result of rejected) {
        assert.match(result.reason.message, /An active override already exists/)
      }
      assert.equal((await listActiveOverrides(repo)).length, 1)
      assert.equal(await countWorkflowEvents(repo, "override-granted"), 1, "the audit log records one grant")
    })
  })
})

describe("overrides on a directory btrain never initialised", () => {
  it("reports a missing override as a btrain error, not a missing lockfile directory", async () => {
    await withTmp(async (root) => {
      const bare = path.join(root, "never-initialised")
      await fs.mkdir(bare)

      await assert.rejects(
        consumeOverride(bare, { action: "push", actor: "alpha" }),
        /No active override found/,
      )
      const record = await grantOverride(bare, {
        action: "push",
        requestedBy: "alpha",
        confirmedBy: "human",
        reason: "grant with no .btrain directory yet",
      })
      assert.deepEqual((await listActiveOverrides(bare)).map((entry) => entry.id), [record.id])
    })
  })
})

describe("withFileLock", () => {
  it("keeps a waiter out while the holder is still inside a critical section older than the stale window", async () => {
    await withTmp(async (root) => {
      const lockPath = path.join(root, "state.lock")
      const holderInside = deferred()
      const releaseHolder = deferred()
      let inside = 0
      let maxInside = 0
      const enter = () => {
        inside += 1
        maxInside = Math.max(maxInside, inside)
      }

      // heartbeatMs is the holder's lease-refresh interval; code without a
      // lease ignores it.
      const holder = withFileLock(lockPath, async () => {
        enter()
        holderInside.resolve()
        await releaseHolder.promise
        inside -= 1
      }, { heartbeatMs: 20 })
      await holderInside.promise

      // The holder has now been working for 31 seconds.
      const longAgo = new Date(Date.now() - 31_000)
      await fs.utimes(lockPath, longAgo, longAgo)
      await delay(120)

      const waiter = withFileLock(lockPath, async () => {
        enter()
        await delay(20)
        inside -= 1
      }, { timeoutMs: 3000 })
      await delay(200)
      releaseHolder.resolve()
      await Promise.all([holder, waiter])

      assert.equal(maxInside, 1, "the waiter entered the critical section while the holder was still inside it")
    })
  })

  it("does not remove a successor's lock when a holder that lost its lock releases", async () => {
    await withTmp(async (root) => {
      const lockPath = path.join(root, "state.lock")
      const firstInside = deferred()
      const releaseFirst = deferred()
      const secondInside = deferred()
      const releaseSecond = deferred()
      let secondIsInside = false
      let thirdEnteredDuringSecond = false

      const first = withFileLock(lockPath, async () => {
        firstInside.resolve()
        await releaseFirst.promise
      })
      await firstInside.promise

      // The first holder's lock is reaped (as a waiter does to a stale lock)
      // and a second holder takes the lock.
      await fs.unlink(lockPath)
      const second = withFileLock(lockPath, async () => {
        secondIsInside = true
        secondInside.resolve()
        await releaseSecond.promise
        secondIsInside = false
      })
      await secondInside.promise

      // The first holder finishes late and releases.
      releaseFirst.resolve()
      await first

      const third = withFileLock(lockPath, async () => {
        thirdEnteredDuringSecond = secondIsInside
      }, { timeoutMs: 300 }).catch(() => {})
      await third
      releaseSecond.resolve()
      await second

      assert.equal(thirdEnteredDuringSecond, false, "the first holder's release deleted the second holder's lock and let a third caller in")
    })
  })
})

describe("handoff history compaction", () => {
  it("waits for the handoff lock instead of rewriting the file under another writer", async () => {
    await withTmp(async (root) => {
      const { repo } = await makeBtrainRepo(root)
      const handoffPath = path.join(repo, ".claude", "collab", "HANDOFF_A.md")
      const entries = Array.from({ length: 6 }, (_, index) => `- history entry ${index + 1}`)
      const seeded = (await fs.readFile(handoffPath, "utf8"))
        .replace(/^## Previous Handoffs[\s\S]*$/m, "")
        .trimEnd() + `\n\n## Previous Handoffs\n\n${entries.join("\n")}\n`
      await fs.writeFile(handoffPath, seeded)
      const historyEntries = (content) => content.split("\n").filter((line) => line.startsWith("- history entry "))

      let compaction
      let compactedWhileLocked
      // A writer holds the handoff lock the way updateHandoff does: read,
      // change, write back.
      await withFileLock(`${handoffPath}.lock`, async () => {
        const read = await fs.readFile(handoffPath, "utf8")
        compaction = compactHandoffHistory(repo, { laneId: "a", keep: 1, actorLabel: "compactor" })
        compactedWhileLocked = await Promise.race([
          compaction.then(() => true, () => true),
          delay(400).then(() => false),
        ])
        await fs.writeFile(handoffPath, read.replace("## Previous Handoffs", "<!-- writer update -->\n\n## Previous Handoffs"))
      })
      const [result] = await compaction

      const final = await fs.readFile(handoffPath, "utf8")
      assert.deepEqual(historyEntries(final), ["- history entry 1"], "the compaction was lost: the writer put the archived entries back")
      assert.equal(compactedWhileLocked, false, "compaction rewrote the handoff file while another writer held its lock")
      assert.equal(result.archivedCount, 5)
      assert.match(final, /<!-- writer update -->/, "the writer's update survives compaction")
    })
  })
})

describe("spilled next action from a linked worktree", () => {
  it("reads a spill file written from the main checkout", async () => {
    await withTmp(async (root) => {
      const { repo, home } = await makeBtrainRepo(root)
      const worktree = path.join(root, "lane-a-worktree")
      await git(repo, "worktree", "add", "-q", "-b", "lane-a-work", worktree)

      const claim = await btrain(
        ["handoff", "claim", "--lane", "a", "--task", "spill fixture", "--owner", "alpha", "--reviewer", "beta", "--files", "src/"],
        { cwd: repo, home },
      )
      assert.equal(claim.code, 0, `${claim.stdout}\n${claim.stderr}`)
      const longBody = "Reviewer notes: the full next action lives in a spill file shared by every worktree. ".repeat(8).trim()
      const update = await btrain(
        ["handoff", "update", "--lane", "a", "--actor", "alpha", "--next", longBody],
        { cwd: repo, home },
      )
      assert.equal(update.code, 0, `${update.stdout}\n${update.stderr}`)

      const handoff = await fs.readFile(path.join(repo, ".claude", "collab", "HANDOFF_A.md"), "utf8")
      const pointer = /^Next Action: (.*)$/m.exec(handoff)?.[1] || ""
      const spillRelative = extractSpillPathFromNextAction(pointer)
      assert.ok(spillRelative, `Next Action should be a spill pointer, got: ${pointer}`)
      assert.equal(await exists(path.join(repo, spillRelative)), true, "the spill file lives in the main checkout")
      assert.equal(await exists(path.join(worktree, spillRelative)), false, "the worktree has no copy of the spill file")

      const spill = await readSpilledNextActionBody(worktree, pointer)
      assert.equal(spill.missing, false, `the spill file read as missing from the worktree (looked at ${spill.path})`)
      assert.ok(spill.body.includes(longBody))

      const showNext = await btrain(["handoff", "show-next", "--lane", "a"], { cwd: worktree, home })
      assert.equal(showNext.code, 0, showNext.stderr)
      assert.ok(showNext.stdout.includes(longBody), `show-next from the worktree should print the full body, got:\n${showNext.stdout}`)
    })
  })
})
