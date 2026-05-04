import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  buildClaimReviewContextFields,
  runUnblockedResearch,
} from "../src/brain_train/unblocked/context.mjs"

const execFileAsync = promisify(execFile)

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-unblocked-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function runBtrain(args, cwd) {
  try {
    const result = await execFileAsync("node", [path.resolve("src/brain_train/cli.mjs"), ...args], {
      cwd,
      env: { ...process.env, BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home") },
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

async function writeHelper(tmpDir, body) {
  const helperPath = path.join(tmpDir, "fake-unblocked-context.sh")
  await fs.writeFile(helperPath, `#!/usr/bin/env bash\n${body}\n`, "utf8")
  await fs.chmod(helperPath, 0o755)
  return helperPath
}

function fakePayloadScript(payload) {
  return `printf '%s\\n' '${JSON.stringify(payload)}'`
}

describe("Unblocked context helper wrapper", () => {
  it("normalizes successful research payloads", async () => {
    const tmpDir = await makeTmpDir()
    try {
      const helperPath = await writeHelper(tmpDir, fakePayloadScript({
        summary: "Prior PR changed auth",
        sources: [{ title: "Auth PR", url: "https://example.test/pr/1", sourceType: "pull_request" }],
      }))
      const result = await runUnblockedResearch(tmpDir, {
        query: "auth route",
        helperPath,
      })

      assert.equal(result.status, "ok")
      assert.equal(result.summary, "Prior PR changed auth")
      assert.equal(result.sources[0].title, "Auth PR")

      const fields = buildClaimReviewContextFields(result)
      assert.ok(fields.whyLines[0].includes("Prior PR changed auth"), fields)
      assert.ok(fields.reviewAskLines[0].includes("https://example.test/pr/1"), fields)
    } finally {
      await rmDir(tmpDir)
    }
  })

  it("treats helper skips as non-blocking context gaps", async () => {
    const tmpDir = await makeTmpDir()
    try {
      const helperPath = await writeHelper(tmpDir, fakePayloadScript({
        sources: [],
        _skipped: "unblocked CLI not installed",
      }))
      const result = await runUnblockedResearch(tmpDir, {
        query: "deploy failure",
        helperPath,
      })

      assert.equal(result.status, "skipped")
      const fields = buildClaimReviewContextFields(result)
      assert.ok(fields.gapLines[0].includes("unblocked CLI not installed"), fields)
    } finally {
      await rmDir(tmpDir)
    }
  })
})

describe("btrain Unblocked context CLI integration", () => {
  it("records opt-in claim context and prints reviewer-side context", async () => {
    const tmpDir = await makeTmpDir()
    try {
      await execFileAsync("git", ["init", tmpDir])
      const helperPath = await writeHelper(tmpDir, fakePayloadScript({
        summary: "Related lane context",
        sources: [{ title: "Prior lane", url: "https://example.test/pr/2", sourceType: "pull_request" }],
      }))

      let result = await runBtrain(["init", tmpDir, "--agent", "WriterBot", "--agent", "ReviewBot"], tmpDir)
      assert.equal(result.code, 0, result.stderr)

      result = await runBtrain([
        "handoff",
        "claim",
        "--repo",
        tmpDir,
        "--lane",
        "a",
        "--task",
        "Auth cleanup",
        "--owner",
        "WriterBot",
        "--reviewer",
        "ReviewBot",
        "--files",
        "src/auth/",
        "--unblocked-context",
        "--unblocked-helper",
        helperPath,
      ], tmpDir)
      assert.equal(result.code, 0, result.stderr)

      const handoff = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
      assert.ok(handoff.includes("Claim-time Unblocked context: Related lane context"), handoff)
      assert.ok(handoff.includes("https://example.test/pr/2"), handoff)

      result = await runBtrain([
        "review",
        "context",
        "--repo",
        tmpDir,
        "--lane",
        "a",
        "--unblocked-helper",
        helperPath,
      ], tmpDir)
      assert.equal(result.code, 0, result.stderr)
      assert.ok(result.stdout.includes("btrain review context: ok"), result.stdout)
      assert.ok(result.stdout.includes("Related lane context"), result.stdout)
      assert.ok(result.stdout.includes("https://example.test/pr/2"), result.stdout)
    } finally {
      await rmDir(tmpDir)
    }
  })
})
