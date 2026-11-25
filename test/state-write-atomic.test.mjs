import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { acquireLocks, readLockRegistry } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)

// Readers such as `btrain handoff wait` do not take the registry lock. Before
// state writes were atomic, a reader that ran during a rewrite could see a
// truncated locks.json, and readJson then returned an empty registry. The
// waiter woke on that torn state and printed "locked files: (none)".
describe("state file writes", () => {
  it("never show a concurrent reader a torn lock registry", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-atomic-write-"))
    try {
      await exec("git", ["init", "-q", repoRoot])
      const files = Array.from({ length: 200 }, (_, index) => `src/module-${index}/`)
      await acquireLocks(repoRoot, "a", "claude", files)

      let writing = true
      let reads = 0
      const torn = []
      const writer = (async () => {
        try {
          for (let round = 0; round < 150; round += 1) {
            await acquireLocks(repoRoot, "a", "claude", files)
          }
        } finally {
          writing = false
        }
      })()
      const reader = (async () => {
        while (writing) {
          const registry = await readLockRegistry(repoRoot)
          reads += 1
          if (registry.locks.length !== files.length) {
            torn.push(registry.locks.length)
          }
        }
      })()
      await Promise.all([writer, reader])

      assert.ok(reads > 0, "the reader never ran")
      assert.deepEqual(torn, [], `${torn.length} of ${reads} reads saw a torn registry`)
      const leftovers = (await fs.readdir(path.join(repoRoot, ".btrain"))).filter((name) => name.endsWith(".tmp"))
      assert.deepEqual(leftovers, [])
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  })

  // Red-team cases from the lane a review: the atomic rename must keep the
  // old write's file identity rules.
  async function withStateDir(run) {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-atomic-write-"))
    try {
      const stateDir = path.join(repoRoot, ".btrain")
      await fs.mkdir(stateDir)
      await run(repoRoot, stateDir)
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true })
    }
  }

  it("keep an existing file's mode", () => withStateDir(async (repoRoot, stateDir) => {
    const target = path.join(stateDir, "locks.json")
    await fs.writeFile(target, '{"version":1,"locks":[]}')
    await fs.chmod(target, 0o640)
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  }))

  it("write through a symlink and keep the link", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.writeFile(path.join(stateDir, "actual.json"), '{"version":1,"locks":[]}')
    await fs.symlink("actual.json", path.join(stateDir, "locks.json"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal(await fs.readlink(path.join(stateDir, "locks.json")), "actual.json")
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "actual.json"), "utf8")).locks.length, 1)
  }))

  it("create the target of a dangling symlink and keep the link", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.symlink("actual.json", path.join(stateDir, "locks.json"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal(await fs.readlink(path.join(stateDir, "locks.json")), "actual.json")
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "actual.json"), "utf8")).locks.length, 1)
  }))

  it("create the last target of a dangling symlink chain and keep every link", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.symlink("middle.json", path.join(stateDir, "locks.json"))
    await fs.symlink("actual.json", path.join(stateDir, "middle.json"))
    await acquireLocks(repoRoot, "a", "claude", ["src/"])
    assert.equal(await fs.readlink(path.join(stateDir, "locks.json")), "middle.json")
    assert.equal(await fs.readlink(path.join(stateDir, "middle.json")), "actual.json")
    assert.equal(JSON.parse(await fs.readFile(path.join(stateDir, "actual.json"), "utf8")).locks.length, 1)
  }))

  it("leave no temporary file when the rename fails", () => withStateDir(async (repoRoot, stateDir) => {
    await fs.mkdir(path.join(stateDir, "locks.json"))
    await assert.rejects(acquireLocks(repoRoot, "a", "claude", ["src/"]))
    assert.deepEqual((await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp")), [])
  }))
})
