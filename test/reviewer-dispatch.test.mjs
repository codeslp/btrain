import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const exec = promisify(execFile)
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/brain_train/cli.mjs")

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-reviewer-dispatch-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

function dispatchEnv(cwd, extra = {}) {
  return {
    ...withoutLaneScope(),
    BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home"),
    BTRAIN_NO_REVIEW_DISPATCH: "0",
    BTRAIN_AGENT: "owner",
    BRAIN_TRAIN_AGENT: "owner",
    BTRAIN_CLI: CLI_PATH,
    ...extra,
  }
}

async function runBtrain(args, cwd, envOverrides = {}) {
  try {
    const result = await exec("node", [CLI_PATH, ...args], {
      cwd,
      env: dispatchEnv(cwd, envOverrides),
      maxBuffer: 5 * 1024 * 1024,
    })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      code:
        typeof error.code === "number"
          ? error.code
          : typeof error.status === "number"
            ? error.status
            : 1,
    }
  }
}

async function writeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
  await fs.chmod(filePath, 0x1ed)
}

async function setRunnerConfig(tmpDir, mappingLines) {
  const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  const updated = toml.replace(
    /\[agents\.runners\][\s\S]*?\n\[reviews\]/,
    `[agents.runners]\n${mappingLines.join("\n")}\n\n[reviews]`,
  )
  await fs.writeFile(tomlPath, updated, "utf8")
}

async function enablePrFlow(tmpDir) {
  const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  await fs.writeFile(
    tomlPath,
    toml.replace(/^enabled = false$/m, "enabled = true"),
    "utf8",
  )
}

function fakeClaudeSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs")
const { spawnSync } = require("node:child_process")
const action = process.env.REVIEWER_ACTION || "resolve"
if (process.env.REVIEWER_SPAWN_MARK) {
  fs.writeFileSync(process.env.REVIEWER_SPAWN_MARK, "spawned\\n")
}
if (process.env.REVIEWER_ARGV_PATH) {
  fs.writeFileSync(process.env.REVIEWER_ARGV_PATH, JSON.stringify(process.argv), "utf8")
}
if (action === "fail") {
  process.exit(1)
}
if (action === "hang") {
  setInterval(() => {}, 1000)
  return
}
const cli = process.env.BTRAIN_CLI
const lane = process.env.BTRAIN_LANE || "a"
const args = action === "request-changes"
  ? ["handoff", "request-changes", "--lane", lane, "--summary", "Needs a test", "--reason-code", "spec-mismatch", "--actor", "claude"]
  : ["handoff", "resolve", "--lane", lane, "--summary", "Looks good", "--actor", "claude"]
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8",
})
if (result.status) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.status)
}
if (process.env.REVIEWER_EXIT_AFTER) {
  process.exit(Number(process.env.REVIEWER_EXIT_AFTER) || 1)
}
`
}

async function setupRepo() {
  const tmpDir = await makeTmpDir()
  await exec("git", ["init", tmpDir])
  await exec("git", ["-C", tmpDir, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", tmpDir, "config", "user.name", "Test Bot"])
  const init = await runBtrain(["init", tmpDir, "--agent", "owner", "--agent", "claude", "--core-only"], tmpDir)
  assert.equal(init.code, 0, init.stderr)
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
  await fs.writeFile(path.join(tmpDir, "src", "feature.ts"), "export const feature = true\\n", "utf8")
  const claudeBin = path.join(tmpDir, "bin", "claude")
  await writeExecutable(claudeBin, fakeClaudeSource())
  await setRunnerConfig(tmpDir, [`"owner" = "notify"`, `"claude" = "${claudeBin} -p"`])
  const claim = await runBtrain(
    [
      "handoff", "claim", "--repo", tmpDir, "--lane", "a",
      "--task", "Review dispatch",
      "--owner", "owner",
      "--reviewer", "claude",
      "--files", "src/feature.ts",
    ],
    tmpDir,
    { BTRAIN_AGENT: "owner" },
  )
  assert.equal(claim.code, 0, claim.stderr)
  return { tmpDir, claudeBin }
}

function needsReviewArgs(tmpDir) {
  return [
    "handoff", "update", "--repo", tmpDir, "--lane", "a", "--status", "needs-review",
    "--actor", "owner",
    "--base", "feat/review-dispatch",
    "--no-diff",
    "--preflight",
    "--changed", "src/feature.ts - implement the change",
    "--verification", "node --test test/reviewer-dispatch.test.mjs",
    "--gap", "Did not rerun a browser smoke test",
    "--why", "The lane is ready for peer review.",
    "--review-ask", "Check the targeted behavior.",
    "--timeout", "5",
    "--poll-interval", "0.05",
  ]
}

async function readLane(tmpDir) {
  return fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
}

describe("needs-review reviewer dispatch", () => {
  it("rejects invalid dispatch timeout before writing needs-review", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const args = needsReviewArgs(tmpDir)
      const timeoutIndex = args.indexOf("--timeout")
      args[timeoutIndex + 1] = "0"
      const result = await runBtrain(args, tmpDir)
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\n${result.stderr}`, /--timeout must be a positive number/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: in-progress/)
      assert.doesNotMatch(content, /Status: needs-review/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("spawns a claude -p reviewer and resolves the lane on approval", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const argvPath = path.join(tmpDir, "argv.json")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        REVIEWER_ARGV_PATH: argvPath,
        REVIEWER_ACTION: "resolve",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /dispatch claude/)
      assert.match(result.stdout, /status: resolved/)
      const spawned = await fs.readFile(spawnMark, "utf8")
      assert.match(spawned, /spawned/)
      const argv = JSON.parse(await fs.readFile(argvPath, "utf8"))
      assert.ok(argv.includes("-p"), `expected -p in ${JSON.stringify(argv)}`)
      assert.ok(argv.some((token) => token === "bth" || token.startsWith("bth ")), `expected bth prompt in ${JSON.stringify(argv)}`)
      assert.ok(argv.some((token) => String(token).includes("--lane a") || token === "--lane"), `expected lane in prompt: ${JSON.stringify(argv)}`)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("applies request-changes onto the lane instead of approving", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        REVIEWER_ACTION: "request-changes",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /dispatch claude/)
      assert.match(result.stdout, /status: changes-requested/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: changes-requested/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("keeps local approval on PR-flow lanes at ready-for-pr", async () => {
    const { tmpDir } = await setupRepo()
    try {
      await enablePrFlow(tmpDir)
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_ACTION: "resolve",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /status: ready-for-pr/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: ready-for-pr/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("does not spawn notify reviewers", async () => {
    const { tmpDir, claudeBin } = await setupRepo()
    try {
      await setRunnerConfig(tmpDir, [`"owner" = "notify"`, `"claude" = "notify"`])
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /reviewer dispatch skipped: notify runner for claude is not spawned/)
      assert.match(result.stdout, /status: needs-review/)
      assert.equal(await fs.access(spawnMark).then(() => true, () => false), false)
      assert.equal(await fs.access(claudeBin).then(() => true, () => false), true)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: needs-review/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("accepts a completed review even if the reviewer CLI then exits nonzero", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_ACTION: "resolve",
        REVIEWER_EXIT_AFTER: "1",
      })
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /status: resolved/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("treats a failing reviewer runner as infrastructure failure, not approval", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        REVIEWER_ACTION: "fail",
      })
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\\n${result.stderr}`, /Reviewer dispatch failed/)
      assert.match(`${result.stdout}\\n${result.stderr}`, /not approved|needs-review/)
      const spawned = await fs.readFile(spawnMark, "utf8")
      assert.match(spawned, /spawned/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: needs-review/)
      assert.doesNotMatch(content, /Status: resolved/)
      assert.doesNotMatch(content, /Status: ready-for-pr/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("treats a timed-out reviewer as infrastructure failure, not approval", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const args = needsReviewArgs(tmpDir)
      const timeoutIndex = args.indexOf("--timeout")
      args[timeoutIndex + 1] = "0.4"
      const result = await runBtrain(args, tmpDir, {
        REVIEWER_ACTION: "hang",
      })
      assert.notEqual(result.code, 0)
      assert.match(`${result.stdout}\\n${result.stderr}`, /Reviewer dispatch timed-out|Timed out/)
      const content = await readLane(tmpDir)
      assert.match(content, /Status: needs-review/)
      assert.doesNotMatch(content, /Status: resolved/)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("does not nested-dispatch when already inside btrain loop", async () => {
    const { tmpDir } = await setupRepo()
    try {
      const spawnMark = path.join(tmpDir, "spawned.txt")
      const result = await runBtrain(needsReviewArgs(tmpDir), tmpDir, {
        REVIEWER_SPAWN_MARK: spawnMark,
        BTRAIN_LOOP_ACTIVE: "1",
      })
      assert.equal(result.code, 0, `${result.stdout}\\n${result.stderr}`)
      assert.match(result.stdout, /status: needs-review/)
      assert.doesNotMatch(result.stdout, /dispatch claude/)
      assert.equal(await fs.access(spawnMark).then(() => true, () => false), false)
    } finally {
      await rmDir(tmpDir)
    }
  })
})
