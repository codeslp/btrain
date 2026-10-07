// `btrain handoff claim|update --files a --files b` crashed with
// "value.split is not a function" (2026-10-07). parseOptions collects a
// repeated flag into an array, and parseCsvList called .split on it. Repeated
// and comma-separated --files now compose into one lock list.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { parseCsvList, readLockRegistry } from "../src/brain_train/core.mjs"

const execFileAsync = promisify(execFile)
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/brain_train/cli.mjs")

const PROJECT_TOML = `[project]
name = "repeated-files"

[agents]
active = ["alpha", "beta"]

[lanes]
enabled = true
ids = ["x"]

[lanes.x]
handoff_path = ".claude/collab/HANDOFF_X.md"
`

async function withRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-repeated-files-"))
  const repo = path.join(root, "repo")
  await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
  await fs.mkdir(path.join(repo, ".claude", "collab"), { recursive: true })
  await fs.writeFile(path.join(repo, ".btrain", "project.toml"), PROJECT_TOML)
  try {
    await fn(repo, path.join(root, "home"))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function runCli(repo, home, args) {
  return execFileAsync(process.execPath, [CLI, ...args, "--repo", repo], {
    cwd: repo,
    env: { ...process.env, BRAIN_TRAIN_HOME: home, BTRAIN_AGENT: "alpha" },
  })
}

async function lockedPaths(repo) {
  const registry = await readLockRegistry(repo)
  return registry.locks.filter((lock) => lock.lane === "x").map((lock) => lock.path).sort()
}

describe("repeated --files flags", () => {
  it("parseCsvList flattens an array of comma-separated values", () => {
    assert.deepEqual(parseCsvList("a, b"), ["a", "b"])
    assert.deepEqual(parseCsvList(["a", "b,c", " d "]), ["a", "b", "c", "d"])
    assert.deepEqual(parseCsvList(undefined), [])
  })

  it("claim locks every file from repeated and comma-separated --files", async () => {
    await withRepo(async (repo, home) => {
      await runCli(repo, home, [
        "handoff", "claim", "--lane", "x", "--task", "repeat files", "--owner", "alpha", "--reviewer", "beta",
        "--files", "src/a.mjs", "--files", "src/b.mjs,src/c.mjs",
      ])
      assert.deepEqual(await lockedPaths(repo), ["src/a.mjs", "src/b.mjs", "src/c.mjs"])
    })
  })

  it("update replaces the locks with every file from repeated --files", async () => {
    await withRepo(async (repo, home) => {
      await runCli(repo, home, [
        "handoff", "claim", "--lane", "x", "--task", "repeat files", "--owner", "alpha", "--reviewer", "beta",
        "--files", "src/a.mjs",
      ])
      await runCli(repo, home, [
        "handoff", "update", "--lane", "x", "--actor", "alpha", "--files", "src/d.mjs", "--files", "src/e.mjs",
      ])
      assert.deepEqual(await lockedPaths(repo), ["src/d.mjs", "src/e.mjs"])
    })
  })
})
