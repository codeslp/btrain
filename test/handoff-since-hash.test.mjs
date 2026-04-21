import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  checkHandoff,
  computeHandoffStateHash,
} from "../src/brain_train/core.mjs"

const exec = promisify(execFile)

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-since-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function runBtrain(args, cwd, envOverrides = {}) {
  try {
    const result = await exec("node", [path.resolve("src/brain_train/cli.mjs"), ...args], {
      cwd,
      env: { ...process.env, BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home"), ...envOverrides },
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

async function bootstrapRepo() {
  const tmpDir = await makeTmpDir()
  await exec("git", ["init", "-q", tmpDir])
  await exec("git", ["-C", tmpDir, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", tmpDir, "config", "user.name", "Test Bot"])
  const init = await runBtrain(
    ["init", tmpDir, "--agent", "claude", "--agent", "codex"],
    tmpDir,
  )
  assert.equal(init.code, 0, init.stderr)
  return tmpDir
}

describe("computeHandoffStateHash", () => {
  it("returns '' for non-object inputs", () => {
    assert.equal(computeHandoffStateHash(null), "")
    assert.equal(computeHandoffStateHash(undefined), "")
    assert.equal(computeHandoffStateHash("not-a-result"), "")
  })

  it("is deterministic across identical states and insensitive to lane/lock/override ordering", () => {
    const base = {
      lanes: [
        {
          _laneId: "a",
          task: "alpha",
          owner: "claude",
          reviewer: "codex",
          status: "in-progress",
          lockedFiles: ["src/a.mjs", "docs/"],
          nextAction: "keep building",
        },
        {
          _laneId: "b",
          task: "beta",
          owner: "codex",
          reviewer: "claude",
          status: "needs-review",
          lockedFiles: ["README.md"],
          nextAction: "please review",
        },
      ],
      locks: [
        { lane: "a", path: "src/a.mjs", owner: "claude" },
        { lane: "b", path: "README.md", owner: "codex" },
      ],
      overrides: [
        { id: "ov-1", action: "push", scope: "global", laneId: "", requestedBy: "claude", confirmedBy: "human" },
      ],
    }
    const reordered = {
      lanes: [base.lanes[1], base.lanes[0]].map((lane) => ({
        ...lane,
        lockedFiles: [...lane.lockedFiles].reverse(),
      })),
      locks: [base.locks[1], base.locks[0]],
      overrides: [...base.overrides],
    }

    const hashA = computeHandoffStateHash(base)
    const hashB = computeHandoffStateHash(reordered)
    assert.ok(hashA, "hash should be non-empty")
    assert.equal(hashA.length, 16)
    assert.equal(hashA, hashB, "hash must not depend on input order")
  })

  it("changes when material fields change", () => {
    const baseline = {
      lanes: [
        {
          _laneId: "a",
          task: "alpha",
          owner: "claude",
          reviewer: "codex",
          status: "in-progress",
          lockedFiles: [],
          nextAction: "",
        },
      ],
      locks: [],
      overrides: [],
    }
    const mutated = {
      ...baseline,
      lanes: [{ ...baseline.lanes[0], status: "needs-review" }],
    }
    assert.notEqual(
      computeHandoffStateHash(baseline),
      computeHandoffStateHash(mutated),
    )
  })
})

describe("btrain handoff --since hash", () => {
  let tmpDir
  before(async () => {
    tmpDir = await bootstrapRepo()
    const claim = await runBtrain(
      [
        "handoff",
        "claim",
        "--repo",
        tmpDir,
        "--lane",
        "a",
        "--task",
        "Since-hash fixture",
        "--owner",
        "claude",
        "--reviewer",
        "codex",
        "--files",
        "src/",
      ],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(claim.code, 0, claim.stderr)
  })
  after(async () => {
    await rmDir(tmpDir)
  })

  it("checkHandoff embeds a stable 16-char stateHash that matches computeHandoffStateHash", async () => {
    const result = await checkHandoff(tmpDir)
    assert.ok(result.stateHash, "stateHash should be populated")
    assert.equal(result.stateHash.length, 16)
    assert.match(result.stateHash, /^[0-9a-f]{16}$/)
    assert.equal(result.stateHash, computeHandoffStateHash(result))

    const again = await checkHandoff(tmpDir)
    assert.equal(again.stateHash, result.stateHash, "repeated reads of unchanged state must match")
  })

  it("prints the state hash on the default handoff output", async () => {
    const plain = await runBtrain(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "claude" })
    assert.equal(plain.code, 0, plain.stderr)
    const match = /state hash: ([0-9a-f]{16})/.exec(plain.stdout)
    assert.ok(match, `expected state hash in output, got:\n${plain.stdout}`)
  })

  it("short-circuits with 'unchanged' when --since matches the current state hash", async () => {
    const result = await checkHandoff(tmpDir)
    const currentHash = result.stateHash
    assert.ok(currentHash, "fixture must have a stateHash")

    const matched = await runBtrain(
      ["handoff", "--repo", tmpDir, "--since", currentHash],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(matched.code, 0, matched.stderr)
    const lines = matched.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    assert.equal(lines[0], "unchanged")
    assert.equal(lines[1], `state hash: ${currentHash}`)
    // Short-circuit output should be compact — no lane/focus blocks.
    assert.ok(lines.length <= 3, `expected <=3 lines in short-circuit output, got ${lines.length}`)
    assert.ok(!matched.stdout.includes("repo:"))
    assert.ok(!matched.stdout.includes("Since-hash fixture"))
  })

  it("falls back to full output when --since does not match the current state hash", async () => {
    const result = await checkHandoff(tmpDir)
    const staleHash = result.stateHash === "0".repeat(16) ? "1".repeat(16) : "0".repeat(16)
    const missed = await runBtrain(
      ["handoff", "--repo", tmpDir, "--since", staleHash],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(missed.code, 0, missed.stderr)
    // Fallback must render the usual handoff block and the current (non-stale) hash.
    assert.ok(missed.stdout.includes("repo:"), "fallback should include the full state")
    assert.ok(missed.stdout.includes(`state hash: ${result.stateHash}`))
    assert.ok(!missed.stdout.startsWith("unchanged"))
    assert.ok(missed.stdout.includes("Since-hash fixture"))
  })

  it("falls back to full output when --since is empty", async () => {
    const result = await checkHandoff(tmpDir)
    const emptySince = await runBtrain(
      ["handoff", "--repo", tmpDir, "--since", ""],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(emptySince.code, 0, emptySince.stderr)
    assert.ok(emptySince.stdout.includes("repo:"))
    assert.ok(emptySince.stdout.includes(`state hash: ${result.stateHash}`))
  })

  it("stateHash flips when the lane state actually changes", async () => {
    const before = await checkHandoff(tmpDir)
    const update = await runBtrain(
      [
        "handoff",
        "update",
        "--repo",
        tmpDir,
        "--lane",
        "a",
        "--actor",
        "claude",
        "--next",
        "short progress update",
      ],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(update.code, 0, update.stderr)

    const after = await checkHandoff(tmpDir)
    assert.notEqual(before.stateHash, after.stateHash, "hash should change after a material update")

    // The old hash should now miss (fall back to full output), the new hash should match.
    const missed = await runBtrain(
      ["handoff", "--repo", tmpDir, "--since", before.stateHash],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(missed.code, 0, missed.stderr)
    assert.ok(missed.stdout.includes("repo:"))

    const matched = await runBtrain(
      ["handoff", "--repo", tmpDir, "--since", after.stateHash],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(matched.code, 0, matched.stderr)
    assert.ok(matched.stdout.split("\n")[0].trim() === "unchanged")
  })
})
