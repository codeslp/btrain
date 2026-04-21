import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getStartupSnapshot } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-startup-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function runCli(args, cwd, envOverrides = {}) {
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

async function gitInit(tmpDir) {
  await exec("git", ["init", "-q", tmpDir])
  await exec("git", ["-C", tmpDir, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", tmpDir, "config", "user.name", "Test Bot"])
}

async function commitAll(tmpDir, message) {
  await exec("git", ["-C", tmpDir, "add", "-A"])
  await exec("git", ["-C", tmpDir, "commit", "-q", "-m", message])
}

async function getCurrentBranch(tmpDir) {
  const { stdout } = await exec("git", ["-C", tmpDir, "rev-parse", "--abbrev-ref", "HEAD"])
  return stdout.trim()
}

async function bootstrapRepo() {
  const tmpDir = await makeTmpDir()
  await gitInit(tmpDir)
  const { code, stderr } = await runCli(
    ["init", tmpDir, "--agent", "claude", "--agent", "codex"],
    tmpDir,
  )
  assert.equal(code, 0, `btrain init failed: ${stderr}`)
  await commitAll(tmpDir, "init")
  return tmpDir
}

describe("getStartupSnapshot: unbootstrapped repo", () => {
  let tmpDir
  before(async () => {
    tmpDir = await makeTmpDir()
    await gitInit(tmpDir)
  })
  after(async () => {
    await rmDir(tmpDir)
  })

  it("throws a structured BtrainError when .btrain/project.toml is missing", async () => {
    await assert.rejects(
      () => getStartupSnapshot(tmpDir),
      (error) => {
        assert.equal(error.name, "BtrainError")
        assert.match(error.message, /Repo is not bootstrapped/)
        assert.match(error.message, /\.btrain\/project\.toml/)
        assert.match(error.message, /Fix:/)
        return true
      },
    )
  })
})

describe("getStartupSnapshot: bootstrapped repo", () => {
  let tmpDir
  let branchName
  before(async () => {
    tmpDir = await bootstrapRepo()
    branchName = await getCurrentBranch(tmpDir)
  })
  after(async () => {
    await rmDir(tmpDir)
  })

  it("returns a compact snapshot with expected scalar fields", async () => {
    const snapshot = await getStartupSnapshot(tmpDir)

    assert.ok(snapshot.repoName, "repoName should be populated")
    assert.equal(snapshot.repoRoot, tmpDir)
    assert.equal(snapshot.branch, branchName)
    assert.ok(Array.isArray(snapshot.activeAgents))
    assert.ok(snapshot.activeAgents.length > 0, "init seeds active agents")
    assert.ok(Array.isArray(snapshot.laneIds))
    assert.ok(snapshot.laneIds.length > 0, "init seeds default lanes")
    assert.match(snapshot.note, /Do not read \.claude\/collab\/HANDOFF_\*\.md directly/)
  })

  it("reports the bundled default harness profile and its dispatch prompt", async () => {
    const snapshot = await getStartupSnapshot(tmpDir)
    assert.equal(snapshot.harness.activeProfile, "default")
    assert.equal(snapshot.harness.dispatchPrompt, "bth")
    assert.equal(snapshot.harness.error, "")
  })

  it("includes scaffolded docs in readFirstPaths and caps the list at five", async () => {
    const snapshot = await getStartupSnapshot(tmpDir)
    assert.ok(snapshot.readFirstPaths.length <= 5)
    assert.ok(
      snapshot.readFirstPaths.includes("AGENTS.md"),
      `expected AGENTS.md in readFirstPaths — got ${JSON.stringify(snapshot.readFirstPaths)}`,
    )
    assert.ok(snapshot.readFirstPaths.includes("CLAUDE.md"))
    assert.ok(snapshot.readFirstPaths.includes(".btrain/project.toml"))
  })

  it("always suggests the standard probe-command list", async () => {
    const snapshot = await getStartupSnapshot(tmpDir)
    for (const expected of [
      "btrain handoff",
      "btrain locks",
      "btrain harness list",
      "btrain go",
      "btrain doctor",
    ]) {
      assert.ok(
        snapshot.commands.includes(expected),
        `commands should include "${expected}" — got ${JSON.stringify(snapshot.commands)}`,
      )
    }
  })

  it("suggests a claim command and reports no focus when the board is empty", async () => {
    const snapshot = await getStartupSnapshot(tmpDir)
    assert.equal(snapshot.focusLanes.length, 0)
    const claimCommand = snapshot.commands.find((command) => command.startsWith("btrain handoff claim"))
    assert.ok(claimCommand, "expected a claim command suggestion for an empty board")
  })

  it("surfaces the dirty working tree in dirtyPaths", async () => {
    const dirtyPath = path.join(tmpDir, "scratch.txt")
    await fs.writeFile(dirtyPath, "hello", "utf8")
    try {
      const snapshot = await getStartupSnapshot(tmpDir)
      assert.ok(
        snapshot.dirtyPaths.some((entry) => entry.endsWith("scratch.txt")),
        `dirtyPaths should include scratch.txt — got ${JSON.stringify(snapshot.dirtyPaths)}`,
      )
    } finally {
      await fs.rm(dirtyPath, { force: true })
    }
  })
})

describe("getStartupSnapshot: role-aware focus lanes", () => {
  let tmpDir
  before(async () => {
    tmpDir = await bootstrapRepo()
    const claim = await runCli(
      [
        "handoff", "claim",
        "--repo", tmpDir,
        "--lane", "a",
        "--task", "Investigate flake",
        "--owner", "claude",
        "--reviewer", "codex",
        "--files", "src/",
      ],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(claim.code, 0, `handoff claim failed: ${claim.stderr}`)
  })
  after(async () => {
    await rmDir(tmpDir)
  })

  it("tags the owner as writer on an in-progress lane and emits the needs-review command", async () => {
    const prior = process.env.BTRAIN_AGENT
    process.env.BTRAIN_AGENT = "claude"
    try {
      const snapshot = await getStartupSnapshot(tmpDir)
      const laneA = snapshot.focusLanes.find((lane) => lane.laneId === "a")
      assert.ok(laneA, `lane a should appear in focus lanes — got ${JSON.stringify(snapshot.focusLanes)}`)
      assert.equal(laneA.role, "writer")
      assert.equal(laneA.status, "in-progress")
      const reviewCommand = snapshot.commands.find((command) =>
        command.includes("handoff update --lane a --status needs-review"),
      )
      assert.ok(reviewCommand, `expected a needs-review command — got ${JSON.stringify(snapshot.commands)}`)
    } finally {
      if (prior === undefined) delete process.env.BTRAIN_AGENT
      else process.env.BTRAIN_AGENT = prior
    }
  })

  it("falls back to shared active-lane focus when no agent is pinned", async () => {
    const prior = process.env.BTRAIN_AGENT
    delete process.env.BTRAIN_AGENT
    try {
      const snapshot = await getStartupSnapshot(tmpDir)
      const laneA = snapshot.focusLanes.find((lane) => lane.laneId === "a")
      assert.ok(laneA, "shared fallback should still surface active lanes")
      assert.equal(laneA.role, "shared")
    } finally {
      if (prior !== undefined) process.env.BTRAIN_AGENT = prior
    }
  })

  it("caps focus lanes at three even when more are active", async () => {
    const repo = await bootstrapRepo()
    try {
      for (const [laneId, index] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]]) {
        const result = await runCli(
          [
            "handoff", "claim",
            "--repo", repo,
            "--lane", laneId,
            "--task", `Task ${laneId}`,
            "--owner", "claude",
            "--reviewer", "codex",
            "--files", `lane-${laneId}/`,
          ],
          repo,
          { BTRAIN_AGENT: "claude" },
        )
        assert.equal(result.code, 0, `lane ${laneId} (${index}) claim failed: ${result.stderr}`)
      }

      const snapshot = await getStartupSnapshot(repo)
      assert.ok(snapshot.focusLanes.length <= 3, `focus lanes should cap at 3 — got ${snapshot.focusLanes.length}`)
    } finally {
      await rmDir(repo)
    }
  })
})

describe("btrain startup CLI", () => {
  let tmpDir
  before(async () => {
    tmpDir = await bootstrapRepo()
  })
  after(async () => {
    await rmDir(tmpDir)
  })

  it("prints a compact bootstrap packet with the expected section headers", async () => {
    const { stdout, code, stderr } = await runCli(["startup", "--repo", tmpDir], tmpDir)
    assert.equal(code, 0, stderr)
    assert.match(stdout, /^repo: /m)
    assert.match(stdout, /^branch: /m)
    assert.match(stdout, /^active profile: default/m)
    assert.match(stdout, /^read first:/m)
    assert.match(stdout, /^focus:/m)
    assert.match(stdout, /^commands:/m)
    assert.match(stdout, /^note: Do not read/m)
  })

  it("exits non-zero with a BtrainError on an unbootstrapped repo", async () => {
    const bareRepo = await makeTmpDir()
    try {
      await gitInit(bareRepo)
      const { code, stderr, stdout } = await runCli(["startup", "--repo", bareRepo], bareRepo)
      assert.notEqual(code, 0)
      const output = `${stdout}\n${stderr}`
      assert.match(output, /Repo is not bootstrapped/)
    } finally {
      await rmDir(bareRepo)
    }
  })
})
