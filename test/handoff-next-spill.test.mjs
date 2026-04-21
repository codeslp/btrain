import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  DEFAULT_SPILL_NEXT_CHARS,
  HANDOFF_NOTES_DIRNAME,
  extractSpillPathFromNextAction,
  readSpilledNextActionBody,
  resolveSpillThreshold,
} from "../src/brain_train/core.mjs"

const exec = promisify(execFile)

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-spill-test-"))
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

function buildLongReviewBody() {
  const paragraph =
    "Reviewer notes: this change is narrow, preserves determinism, and only affects presentation. "
  // ~500 characters — comfortably over the default 400-char threshold.
  return paragraph.repeat(8).trim()
}

describe("resolveSpillThreshold", () => {
  it("returns the default when config is missing or empty", () => {
    assert.equal(resolveSpillThreshold(null), DEFAULT_SPILL_NEXT_CHARS)
    assert.equal(resolveSpillThreshold({}), DEFAULT_SPILL_NEXT_CHARS)
    assert.equal(resolveSpillThreshold({ handoff: {} }), DEFAULT_SPILL_NEXT_CHARS)
  })

  it("reads [handoff].spill_next_chars from project config", () => {
    assert.equal(resolveSpillThreshold({ handoff: { spill_next_chars: 120 } }), 120)
    assert.equal(resolveSpillThreshold({ handoff: { spill_next_chars: "250" } }), 250)
  })

  it("treats 0 as 'spill disabled' and falls back for bad input", () => {
    assert.equal(resolveSpillThreshold({ handoff: { spill_next_chars: 0 } }), 0)
    assert.equal(resolveSpillThreshold({ handoff: { spill_next_chars: -5 } }), DEFAULT_SPILL_NEXT_CHARS)
    assert.equal(resolveSpillThreshold({ handoff: { spill_next_chars: "abc" } }), DEFAULT_SPILL_NEXT_CHARS)
  })
})

describe("extractSpillPathFromNextAction", () => {
  it("returns null when the string has no spill marker", () => {
    assert.equal(extractSpillPathFromNextAction("Approved. Short note."), null)
    assert.equal(extractSpillPathFromNextAction(""), null)
    assert.equal(extractSpillPathFromNextAction(undefined), null)
  })

  it("pulls the relative path out of a pointer value", () => {
    const pointer = "Approved. Full review… [spilled: .btrain/handoff-notes/lane-a-next-2026.md, 812B]"
    assert.equal(
      extractSpillPathFromNextAction(pointer),
      ".btrain/handoff-notes/lane-a-next-2026.md",
    )
  })
})

describe("btrain handoff next-action spill", () => {
  let tmpDir
  before(async () => {
    tmpDir = await bootstrapRepo()
  })
  after(async () => {
    await rmDir(tmpDir)
  })

  it("spills an over-threshold --next body to .btrain/handoff-notes/ and stores a pointer inline", async () => {
    const claim = await runBtrain(
      [
        "handoff",
        "claim",
        "--repo",
        tmpDir,
        "--lane",
        "a",
        "--task",
        "Spill fixture task",
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

    const longBody = buildLongReviewBody()
    assert.ok(longBody.length > DEFAULT_SPILL_NEXT_CHARS)

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
        longBody,
      ],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(update.code, 0, update.stderr)

    const handoffFile = await fs.readFile(
      path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"),
      "utf8",
    )
    const nextActionMatch = /^Next Action: (.*)$/m.exec(handoffFile)
    assert.ok(nextActionMatch, "Next Action line should be present")
    const storedValue = nextActionMatch[1]
    assert.ok(
      storedValue.includes("[spilled:"),
      `Next Action should be a pointer, got: ${storedValue}`,
    )
    assert.ok(
      storedValue.length < longBody.length,
      `Pointer (${storedValue.length}B) should be shorter than body (${longBody.length}B)`,
    )

    const spillRelative = extractSpillPathFromNextAction(storedValue)
    assert.ok(spillRelative, "pointer should expose a relative spill path")
    const spillAbsolute = path.resolve(tmpDir, spillRelative)
    const spillBody = await fs.readFile(spillAbsolute, "utf8")
    assert.ok(spillBody.includes(longBody), "spill file should contain the full body")
    assert.ok(spillBody.startsWith("---"), "spill file should have a YAML header")

    const showNext = await runBtrain(
      ["handoff", "show-next", "--repo", tmpDir, "--lane", "a"],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(showNext.code, 0, showNext.stderr)
    assert.ok(
      showNext.stdout.includes(longBody),
      "show-next should print the full spilled body",
    )
    assert.ok(
      showNext.stdout.includes(spillRelative),
      "show-next should reference the spill path",
    )
  })

  it("leaves short next actions inline (no spill file)", async () => {
    await runBtrain(
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
        "short update",
      ],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )

    const handoffFile = await fs.readFile(
      path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"),
      "utf8",
    )
    const nextActionMatch = /^Next Action: (.*)$/m.exec(handoffFile)
    assert.ok(nextActionMatch)
    assert.equal(nextActionMatch[1], "short update")
    assert.equal(extractSpillPathFromNextAction(nextActionMatch[1]), null)
  })

  it("honors spill_next_chars = 0 by keeping long bodies inline", async () => {
    const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
    const originalToml = await fs.readFile(tomlPath, "utf8")
    await fs.writeFile(
      tomlPath,
      `${originalToml.trimEnd()}\n\n[handoff]\nspill_next_chars = 0\n`,
      "utf8",
    )

    try {
      const longBody = buildLongReviewBody()
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
          longBody,
        ],
        tmpDir,
        { BTRAIN_AGENT: "claude" },
      )
      assert.equal(update.code, 0, update.stderr)

      const handoffFile = await fs.readFile(
        path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"),
        "utf8",
      )
      const nextActionMatch = /^Next Action: (.*)$/m.exec(handoffFile)
      assert.ok(nextActionMatch)
      assert.equal(nextActionMatch[1], longBody)
      assert.equal(extractSpillPathFromNextAction(nextActionMatch[1]), null)
    } finally {
      await fs.writeFile(tomlPath, originalToml, "utf8")
    }
  })

  it("readSpilledNextActionBody returns null for inline values and the body for pointers", async () => {
    // Use a distinct body so the updater detects a real change and re-spills.
    const longBody = `${buildLongReviewBody()} Follow-up note for roundtrip coverage.`
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
        longBody,
      ],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(update.code, 0, update.stderr)

    const handoffFile = await fs.readFile(
      path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"),
      "utf8",
    )
    const nextActionMatch = /^Next Action: (.*)$/m.exec(handoffFile)
    assert.ok(nextActionMatch)

    const inlineResult = await readSpilledNextActionBody(tmpDir, "short inline note")
    assert.equal(inlineResult, null)

    const pointerResult = await readSpilledNextActionBody(tmpDir, nextActionMatch[1])
    assert.ok(pointerResult, "pointer should resolve to a spill record")
    assert.equal(pointerResult.missing, false)
    assert.ok(pointerResult.body.includes(longBody))

    // Verify that the handoff-notes dir is the canonical location.
    const notesDir = path.join(tmpDir, ".btrain", HANDOFF_NOTES_DIRNAME)
    const entries = await fs.readdir(notesDir)
    assert.ok(entries.length > 0, "spill file should exist under .btrain/handoff-notes/")
  })
})
