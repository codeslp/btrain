import { withoutLaneScope } from "./helpers/runner-scope.mjs"
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
      env: { ...withoutLaneScope(), BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home"), ...envOverrides },
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
    assert.ok(handoffResult.stdout.includes("reason code: state-conflict"), `Expected reason code state-conflict: ${handoffResult.stdout}`)
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
    assert.ok(handoffResult.stdout.includes("reason code: ownership-conflict"), `Expected reason code ownership-conflict: ${handoffResult.stdout}`)
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
    assert.ok(handoffResult.stdout.includes("reason code: lock-mismatch"), `Expected reason code lock-mismatch: ${handoffResult.stdout}`)

    const recoveryResult = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--lane", "c", "--files", "README.md", "--actor", "btrain doctor"],
      tmpDir,
      { BTRAIN_AGENT: "btrain doctor" },
    )
    assert.equal(recoveryResult.code, 0, recoveryResult.stderr)
  })

  it("resyncs lock coverage for an in-progress lane as the FR-2 guardian (spec 015 row 17, Q2)", async () => {
    const claim = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Resync me", "--owner", "Gemini", "--reviewer", "Claude", "--files", "src/"],
      tmpDir,
    )
    assert.equal(claim.code, 0, claim.stderr)
    // Drop the registry entry behind the handoff's back.
    const locksPath = path.join(tmpDir, ".btrain", "locks.json")
    const registry = JSON.parse(await fs.readFile(locksPath, "utf8"))
    registry.locks = registry.locks.filter((lock) => lock.lane !== "a")
    await fs.writeFile(locksPath, JSON.stringify(registry, null, 2), "utf8")

    const repairResult = await runBtrain(["doctor", "--repo", tmpDir, "--repair"], tmpDir)
    assert.equal(repairResult.code, 0, repairResult.stderr)
    assert.match(repairResult.stdout, /lane a: lock-resync repair/)
    assert.doesNotMatch(repairResult.stdout, /contradictory-state repair/)

    const locks = await runBtrain(["locks", "--repo", tmpDir], tmpDir)
    assert.match(locks.stdout, /a: src\//)
    const handoffResult = await runBtrain(["handoff", "--repo", tmpDir, "--lane", "a"], tmpDir)
    assert.match(handoffResult.stdout, /status: in-progress/)
    const events = (await fs.readFile(path.join(tmpDir, ".btrain", "events", "lane-a.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    const resync = [...events].reverse().find((event) => event.type === "watchdog-repair")
    assert.equal(resync.details.repairType, "lock-resync")
    assert.deepEqual(resync.details.paths, ["src/"])
  })

  it("does not resync a needs-review lane; the owner restores coverage there (Q2 Option B)", async () => {
    const claim = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "b", "--task", "Fixed view", "--owner", "Gemini", "--reviewer", "Claude", "--files", "docs/"],
      tmpDir,
    )
    assert.equal(claim.code, 0, claim.stderr)
    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_B.md")
    let content = await fs.readFile(handoffPath, "utf8")
    content = content.replace(/^Status: in-progress$/m, "Status: needs-review")
    await fs.writeFile(handoffPath, content, "utf8")
    const locksPath = path.join(tmpDir, ".btrain", "locks.json")
    const registry = JSON.parse(await fs.readFile(locksPath, "utf8"))
    registry.locks = registry.locks.filter((lock) => lock.lane !== "b")
    await fs.writeFile(locksPath, JSON.stringify(registry, null, 2), "utf8")

    const repairResult = await runBtrain(["doctor", "--repo", tmpDir, "--repair"], tmpDir)
    assert.doesNotMatch(repairResult.stdout, /lane b: lock-resync repair/)
    const locks = await runBtrain(["locks", "--repo", tmpDir], tmpDir)
    assert.doesNotMatch(locks.stdout, /b: docs\//)

    const ownerResync = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--lane", "b", "--files", "docs/", "--actor", "Gemini"],
      tmpDir,
      { BTRAIN_AGENT: "Gemini" },
    )
    assert.equal(ownerResync.code, 0, ownerResync.stderr)
    assert.doesNotMatch(ownerResync.stdout, /transition-advisory/)
    const locksAfter = await runBtrain(["locks", "--repo", tmpDir], tmpDir)
    assert.match(locksAfter.stdout, /b: docs\//)
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
