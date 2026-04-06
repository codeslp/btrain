import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-watchdog-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function runBtrain(args, cwd, envOverrides = {}) {
  try {
    const result = await exec("node", [path.resolve("src/brain_train/cli.mjs"), ...args], {
      cwd,
      env: { ...process.env, BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home"), ...envOverrides },
    })
    const out = { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
    return out
  } catch (error) {
    const out = {
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      code: error.code || 1,
    }
    return out
  }
}

describe("btrain watchdog repairs", () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await makeTmpDir()
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir, "--agent", "Gemini", "--agent", "Claude"], tmpDir)
  })

  afterEach(async () => {
    await rmDir(tmpDir)
  })

  it("detects and repairs invalid transitions (resolved -> needs-review without claim)", async () => {
    // Properly transition to resolved first to record the event
    await runBtrain(["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Initial task", "--owner", "Gemini", "--files", "README.md"], tmpDir, { BTRAIN_AGENT: "Gemini" })
    await runBtrain(["handoff", "resolve", "--repo", tmpDir, "--lane", "a", "--summary", "Done", "--actor", "Claude"], tmpDir, { BTRAIN_AGENT: "Claude" })

    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md")
    let content = await fs.readFile(handoffPath, "utf8")
    
    // Manually jump to needs-review (invalid transition)
    content = content.replace("Status: resolved", "Status: needs-review")
    // Update timestamp to be newer than the resolve event
    content = content.replace(/^Last Updated: .*$/m, "Last Updated: Gemini 2099-01-01T00:00:00.000Z")
    // Ensure it has some files so it doesn't just hit the contradictory-state check first
    content = content.replace(/^Locked Files:.*$/m, "Locked Files: README.md")
    await fs.writeFile(handoffPath, content, "utf8")

    const doctorResult = await runBtrain(["doctor", "--repo", tmpDir], tmpDir)
    assert.ok(doctorResult.stdout.includes("jumped from `resolved` to `needs-review`"), `Expected doctor to detect invalid transition: ${doctorResult.stdout}`)

    const repairResult = await runBtrain(["doctor", "--repo", tmpDir, "--repair"], tmpDir)
    assert.ok(repairResult.stdout.includes("invalid-transition repair"), `Expected repair summary in output: ${repairResult.stdout}`)
    
    const handoffResult = await runBtrain(["handoff", "--repo", tmpDir, "--lane", "a"], tmpDir)
    assert.ok(handoffResult.stdout.includes("status: repair-needed"), `Expected status to be repair-needed: ${handoffResult.stdout}`)
    assert.ok(handoffResult.stdout.includes("reason code: invalid-transition"), `Expected reason code invalid-transition: ${handoffResult.stdout}`)
  })

  it("detects and repairs actor mismatches (owner not in active list)", async () => {
    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_B.md")
    let content = await fs.readFile(handoffPath, "utf8")
    
    // Manually set an unknown owner using the correct label "Active Agent:"
    content = content.replace(/^Active Agent: .*$/m, "Active Agent: UnknownBot")
    content = content.replace("Status: idle", "Status: in-progress")
    content = content.replace(/^Last Updated: .*$/m, "Last Updated: UnknownBot 2099-01-01T00:00:00.000Z")
    // Ensure it has locks to not hit contradictory-state
    content = content.replace(/^Locked Files:.*$/m, "Locked Files: README.md")
    await fs.writeFile(handoffPath, content, "utf8")

    const doctorResult = await runBtrain(["doctor", "--repo", tmpDir], tmpDir)
    assert.ok(doctorResult.stdout.includes("is not in the active agent list"), `Expected doctor to detect actor mismatch: ${doctorResult.stdout}`)

    const repairResult = await runBtrain(["doctor", "--repo", tmpDir, "--repair"], tmpDir)
    assert.ok(repairResult.stdout.includes("actor-mismatch repair"), `Expected repair summary in output: ${repairResult.stdout}`)
    
    const handoffResult = await runBtrain(["handoff", "--repo", tmpDir, "--lane", "b"], tmpDir)
    assert.ok(handoffResult.stdout.includes("status: repair-needed"), `Expected status to be repair-needed: ${handoffResult.stdout}`)
    assert.ok(handoffResult.stdout.includes("reason code: actor-mismatch"), `Expected reason code actor-mismatch: ${handoffResult.stdout}`)
  })

  it("detects and repairs contradictory state (needs-review with zero locks)", async () => {
    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_C.md")
    let content = await fs.readFile(handoffPath, "utf8")
    
    // Set needs-review but no files locked in handoff file or registry
    content = content.replace("Status: idle", "Status: needs-review")
    // Update timestamp
    content = content.replace(/^Last Updated: .*$/m, "Last Updated: Gemini 2099-01-01T00:00:00.000Z")
    await fs.writeFile(handoffPath, content, "utf8")

    const doctorResult = await runBtrain(["doctor", "--repo", tmpDir], tmpDir)
    assert.ok(doctorResult.stdout.includes("has no active locks"), `Expected doctor to detect contradictory state: ${doctorResult.stdout}`)

    const repairResult = await runBtrain(["doctor", "--repo", tmpDir, "--repair"], tmpDir)
    assert.ok(repairResult.stdout.includes("contradictory-state repair"), `Expected repair summary in output: ${repairResult.stdout}`)
    
    const handoffResult = await runBtrain(["handoff", "--repo", tmpDir, "--lane", "c"], tmpDir)
    assert.ok(handoffResult.stdout.includes("status: repair-needed"), `Expected status to be repair-needed: ${handoffResult.stdout}`)
    assert.ok(handoffResult.stdout.includes("reason code: contradictory-state"), `Expected reason code contradictory-state: ${handoffResult.stdout}`)
  })

  it("assigns repair-needed to same-family fallback when original actor is unavailable", async () => {
    // Setup active agents: "Gemini 3.1", "Claude 3.5 Sonnet"
    await runBtrain(["agents", "set", "--repo", tmpDir, "--agent", "Gemini 3.1", "--agent", "Claude 3.5 Sonnet"], tmpDir)

    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md")
    let content = await fs.readFile(handoffPath, "utf8")
    
    // Manually set an owner that is NOT in the active list but share a family token ("Claude")
    content = content.replace(/^Active Agent: .*$/m, "Active Agent: Claude 3 Opus")
    content = content.replace("Status: idle", "Status: in-progress")
    content = content.replace(/^Last Updated: .*$/m, "Last Updated: Claude 3 Opus 2099-01-01T00:00:00.000Z")
    // Cause an integrity issue (actor-mismatch)
    content = content.replace(/^Locked Files:.*$/m, "Locked Files: README.md")
    await fs.writeFile(handoffPath, content, "utf8")

    const repairResult = await runBtrain(["doctor", "--repo", tmpDir, "--repair"], tmpDir)
    assert.ok(repairResult.stdout.includes("actor-mismatch repair"), `Expected repair summary in output: ${repairResult.stdout}`)
    
    const handoffResult = await runBtrain(["handoff", "--repo", tmpDir, "--lane", "a"], tmpDir)
    assert.ok(handoffResult.stdout.includes("status: repair-needed"), `Expected status to be repair-needed: ${handoffResult.stdout}`)
    // Should be assigned to "Claude 3.5 Sonnet" instead of "Claude 3 Opus" (unavailable) or "Gemini 3.1"
    assert.ok(handoffResult.stdout.includes("repair owner: Claude 3.5 Sonnet"), `Expected repair owner to be same-family fallback: ${handoffResult.stdout}`)
  })
})
