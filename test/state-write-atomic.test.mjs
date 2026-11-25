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
})
