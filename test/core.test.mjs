import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseCsvList } from "../src/brain_train/core.mjs"

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function runBtrain(args, cwd) {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const exec = promisify(execFile)
  try {
    const result = await exec("node", [path.resolve("src/brain_train/cli.mjs"), ...args], {
      cwd,
      env: { ...process.env, BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home") },
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
  await fs.writeFile(filePath, content, "utf8")
  await fs.chmod(filePath, 0o755)
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

async function setHandoffPath(tmpDir, relativeHandoffPath) {
  const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
  const defaultHandoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF.md")
  const nextHandoffPath = path.join(tmpDir, relativeHandoffPath)
  const toml = await fs.readFile(tomlPath, "utf8")
  const updated = toml.replace(
    /handoff_path = ".*"/,
    `handoff_path = "${relativeHandoffPath.replaceAll("\\", "/")}"`,
  )

  await fs.writeFile(tomlPath, updated, "utf8")
  await fs.mkdir(path.dirname(nextHandoffPath), { recursive: true })
  await fs.rename(defaultHandoffPath, nextHandoffPath)

  return nextHandoffPath
}

// ──────────────────────────────────────────────
// Unit tests: parseCsvList
// ──────────────────────────────────────────────

describe("parseCsvList", () => {
  it("returns empty array for empty string", () => {
    assert.deepStrictEqual(parseCsvList(""), [])
  })

  it("returns empty array for null/undefined", () => {
    assert.deepStrictEqual(parseCsvList(null), [])
    assert.deepStrictEqual(parseCsvList(undefined), [])
  })

  it("parses comma-separated values", () => {
    assert.deepStrictEqual(parseCsvList("a.mjs, b.mjs, c.mjs"), ["a.mjs", "b.mjs", "c.mjs"])
  })

  it("trims whitespace from items", () => {
    assert.deepStrictEqual(parseCsvList("  foo ,  bar  "), ["foo", "bar"])
  })

  it("filters out empty segments", () => {
    assert.deepStrictEqual(parseCsvList("a,,b,"), ["a", "b"])
  })

  it("handles single item", () => {
    assert.deepStrictEqual(parseCsvList("core.mjs"), ["core.mjs"])
  })
})

// ──────────────────────────────────────────────
// Integration tests: btrain init
// ──────────────────────────────────────────────

describe("btrain init", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    // Create a minimal git repo so findRepoRoot works
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("creates all required files", async () => {
    const { stdout } = await runBtrain(["init", tmpDir], tmpDir)

    assert.ok(stdout.includes("Initialized"), `Expected 'Initialized' in output: ${stdout}`)

    // Check files exist
    const agentsPath = path.join(tmpDir, "AGENTS.md")
    const claudePath = path.join(tmpDir, "CLAUDE.md")
    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF.md")
    const tomlPath = path.join(tmpDir, ".btrain", "project.toml")

    await assert.doesNotReject(fs.access(agentsPath), "AGENTS.md should exist")
    await assert.doesNotReject(fs.access(claudePath), "CLAUDE.md should exist")
    await assert.doesNotReject(fs.access(handoffPath), "HANDOFF.md should exist")
    await assert.doesNotReject(fs.access(tomlPath), "project.toml should exist")
  })

  it("AGENTS.md contains the managed block with CLI-first rule", async () => {
    const content = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")
    assert.ok(content.includes("<!-- btrain:managed:start -->"), "Missing managed start fence")
    assert.ok(content.includes("<!-- btrain:managed:end -->"), "Missing managed end fence")
    assert.ok(content.includes("Always use CLI commands"), "Missing CLI-first rule")
  })

  it("HANDOFF.md has idle status", async () => {
    const content = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF.md"), "utf8")
    assert.ok(content.includes("Status: idle"), `Expected idle status in HANDOFF.md`)
  })

  it("project.toml has correct structure", async () => {
    const content = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(content.includes("[reviews]"), "Missing [reviews] section")
    assert.ok(content.includes("default_review_mode"), "Missing default_review_mode")
  })
})

// ──────────────────────────────────────────────
// Integration tests: btrain handoff lifecycle
// ──────────────────────────────────────────────

describe("btrain handoff lifecycle", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("handoff shows idle status after init", async () => {
    const { stdout } = await runBtrain(["handoff", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("status: idle"), `Expected idle status: ${stdout}`)
  })

  it("claim transitions to in-progress", async () => {
    const { stdout } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Test task", "--owner", "TestBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )
    assert.ok(stdout.includes("status: in-progress"), `Expected in-progress: ${stdout}`)
    assert.ok(stdout.includes("task: Test task"), `Expected task name: ${stdout}`)
  })

  it("update transitions to needs-review", async () => {
    const { stdout } = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--status", "needs-review", "--actor", "TestBot"],
      tmpDir,
    )
    assert.ok(stdout.includes("status: needs-review"), `Expected needs-review: ${stdout}`)
  })

  it("resolve transitions to resolved", async () => {
    const { stdout } = await runBtrain(
      ["handoff", "resolve", "--repo", tmpDir, "--summary", "All good", "--actor", "ReviewBot"],
      tmpDir,
    )
    assert.ok(stdout.includes("status: resolved"), `Expected resolved: ${stdout}`)
  })

  it("handoff guidance no longer mentions editing HANDOFF.md directly", async () => {
    const { stdout } = await runBtrain(["handoff", "--repo", tmpDir], tmpDir)
    assert.ok(!stdout.includes("edit HANDOFF.md directly"), `Guidance should not contain 'edit HANDOFF.md directly': ${stdout}`)
  })
})

// ──────────────────────────────────────────────
// Integration tests: btrain doctor
// ──────────────────────────────────────────────

describe("btrain doctor", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("reports healthy for a freshly initialized repo", async () => {
    const { stdout } = await runBtrain(["doctor", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("healthy: yes"), `Expected healthy repo: ${stdout}`)
  })
})

// ──────────────────────────────────────────────
// Integration tests: btrain sync-templates
// ──────────────────────────────────────────────

describe("btrain sync-templates", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("reports unchanged after fresh init", async () => {
    const { stdout } = await runBtrain(["sync-templates", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("unchanged"), `Expected unchanged: ${stdout}`)
  })

  it("detects and fixes managed block drift", async () => {
    // Tamper with the managed block in AGENTS.md
    const agentsPath = path.join(tmpDir, "AGENTS.md")
    const content = await fs.readFile(agentsPath, "utf8")
    const tampered = content.replace("Always use CLI commands", "Tampered text")
    await fs.writeFile(agentsPath, tampered, "utf8")

    // sync-templates should fix it
    const { stdout } = await runBtrain(["sync-templates", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("updated") || stdout.includes("AGENTS.md"), `Expected update: ${stdout}`)

    // Verify the fix
    const fixed = await fs.readFile(agentsPath, "utf8")
    assert.ok(fixed.includes("Always use CLI commands"), "Managed block should be restored")
  })
})

// ──────────────────────────────────────────────
// Integration tests: btrain review status
// ──────────────────────────────────────────────

describe("btrain review status", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("reports review configuration", async () => {
    const { stdout } = await runBtrain(["review", "status", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("mode:"), `Expected mode in output: ${stdout}`)
    assert.ok(stdout.includes("manual"), `Expected manual mode: ${stdout}`)
  })
})

// ──────────────────────────────────────────────
// Integration tests: hybrid review mode
// ──────────────────────────────────────────────

describe("hybrid review mode", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)

    // Set project.toml to hybrid mode with triggers
    const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
    const toml = await fs.readFile(tomlPath, "utf8")
    const updated = toml
      .replace('default_review_mode = "manual"', 'default_review_mode = "hybrid"')
      .replace("[reviews]", `[reviews]\nparallel_enabled = true\nhybrid_path_triggers = ["auth", "routes", "scoring"]\nhybrid_content_triggers = ["(password|token)", "(score|weight)"]`)
    await fs.writeFile(tomlPath, updated, "utf8")
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("review status shows hybrid mode from project config", async () => {
    const { stdout } = await runBtrain(["review", "status", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("hybrid"), `Expected hybrid mode in output: ${stdout}`)
    assert.ok(stdout.includes("project-config"), `Expected project-config source: ${stdout}`)
  })

  it("project config takes priority over default handoff mode", async () => {
    // Claim a handoff (which sets default reviewMode: manual)
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Hybrid test", "--owner", "Bot1", "--reviewer", "Bot2"],
      tmpDir,
    )

    // Review status should still show hybrid from project config
    const { stdout } = await runBtrain(["review", "status", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("hybrid"), `Expected hybrid despite handoff default: ${stdout}`)
    assert.ok(stdout.includes("project-config"), `Expected project-config source: ${stdout}`)
  })

  it("explicit handoff --mode overrides project config", async () => {
    // Claim with explicit --mode parallel (should override hybrid project config)
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Override test", "--owner", "Bot1", "--reviewer", "Bot2", "--mode", "parallel"],
      tmpDir,
    )

    // Review status should show parallel from handoff, not hybrid from config
    const { stdout } = await runBtrain(["review", "status", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("parallel"), `Expected parallel from explicit handoff: ${stdout}`)
    assert.ok(stdout.includes("handoff"), `Expected handoff source: ${stdout}`)
  })
})

// ──────────────────────────────────────────────
// Integration tests: btrain loop
// ──────────────────────────────────────────────

describe("btrain loop", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("prints the next notify dispatch in dry-run mode", async () => {
    await setRunnerConfig(tmpDir, ['"OwnerBot" = "notify"'])
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Loop dry run", "--owner", "OwnerBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )

    const { stdout, code } = await runBtrain(
      ["loop", "--repo", tmpDir, "--dry-run", "--poll-interval", "0.05"],
      tmpDir,
    )

    assert.equal(code, 0)
    assert.ok(stdout.includes("loop context:"), stdout)
    assert.ok(stdout.includes("selected agent:"), stdout)
    assert.ok(stdout.includes("reason: handoff status is in-progress, so the owner acts next"), stdout)
    assert.ok(stdout.includes("prompt: bth"), stdout)
    assert.ok(stdout.includes("dry-run round 1: wait for OwnerBot (notify mode)"), stdout)
    assert.ok(stdout.includes("status: dry-run"), stdout)
  })

  it("dispatches owner then reviewer and exits once the handoff resolves", async () => {
    const ownerRunner = path.join(tmpDir, "owner-runner.js")
    const reviewerRunner = path.join(tmpDir, "reviewer-runner.js")

    await writeExecutable(
      ownerRunner,
      `#!/usr/bin/env node
const fs = require("node:fs")
const handoffPath = ".claude/collab/HANDOFF.md"
const content = fs.readFileSync(handoffPath, "utf8")
const updated = content
  .replace("Status: in-progress", "Status: needs-review")
  .replace(/Last Updated: .*$/, "Last Updated: OwnerBot 2026-03-15T12:00:00.000Z")
fs.writeFileSync(handoffPath, updated)
console.log("owner runner updated handoff to needs-review")
`,
    )

    await writeExecutable(
      reviewerRunner,
      `#!/usr/bin/env node
const fs = require("node:fs")
const handoffPath = ".claude/collab/HANDOFF.md"
const content = fs.readFileSync(handoffPath, "utf8")
const updated = content
  .replace("Status: needs-review", "Status: resolved")
  .replace(/Last Updated: .*$/, "Last Updated: ReviewBot 2026-03-15T12:00:01.000Z")
fs.writeFileSync(handoffPath, updated)
console.log("reviewer runner resolved the handoff")
`,
    )

    await setRunnerConfig(tmpDir, [`"OwnerBot" = "${ownerRunner}"`, `"ReviewBot" = "${reviewerRunner}"`])
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Loop relay", "--owner", "OwnerBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )

    const { stdout, code } = await runBtrain(
      ["loop", "--repo", tmpDir, "--max-rounds", "4", "--timeout", "5", "--poll-interval", "0.05"],
      tmpDir,
    )

    assert.equal(code, 0)
    assert.ok(stdout.includes("dispatch OwnerBot"), stdout)
    assert.ok(stdout.includes("dispatch ReviewBot"), stdout)
    assert.ok(stdout.includes("agent stdout:"), stdout)
    assert.ok(stdout.includes("owner runner updated handoff to needs-review"), stdout)
    assert.ok(stdout.includes("reviewer runner resolved the handoff"), stdout)
    assert.ok(stdout.includes("handoff transition:"), stdout)
    assert.ok(stdout.includes("before: status=in-progress"), stdout)
    assert.ok(stdout.includes("after:  status=needs-review"), stdout)
    assert.ok(stdout.includes("status: completed"), stdout)
    assert.ok(stdout.includes("final handoff: resolved"), stdout)
  })

  it("streams Claude progress events while the runner is still working", async () => {
    const ownerRunner = path.join(tmpDir, "owner-notify.js")
    const reviewerRunner = path.join(tmpDir, "claude")

    await writeExecutable(
      ownerRunner,
      `#!/usr/bin/env node
const fs = require("node:fs")
const handoffPath = ".claude/collab/HANDOFF.md"
const content = fs.readFileSync(handoffPath, "utf8")
const updated = content
  .replace("Status: in-progress", "Status: needs-review")
  .replace(/Last Updated: .*$/, "Last Updated: OwnerBot 2026-03-15T12:00:01.500Z")
fs.writeFileSync(handoffPath, updated)
`,
    )

    await writeExecutable(
      reviewerRunner,
      `#!/usr/bin/env node
const fs = require("node:fs")

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n")
}

emit({
  type: "system",
  subtype: "init",
  model: "claude-sonnet-4-6",
  permissionMode: "bypassPermissions",
})
emit({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "git status --short" },
      },
    ],
  },
})
emit({
  type: "user",
  tool_use_result: {
    stdout: "M src/brain_train/core.mjs",
    stderr: "",
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
})
emit({
  type: "assistant",
  message: {
    content: [
      {
        type: "text",
        text: "Review finished.",
      },
    ],
  },
})

const handoffPath = ".claude/collab/HANDOFF.md"
const content = fs.readFileSync(handoffPath, "utf8")
const updated = content
  .replace("Status: needs-review", "Status: resolved")
  .replace(/Last Updated: .*$/, "Last Updated: ReviewBot 2026-03-15T12:00:02.000Z")
fs.writeFileSync(handoffPath, updated)

emit({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 42,
  result: "Review finished.",
})
`,
    )

    await setRunnerConfig(tmpDir, [`"OwnerBot" = "${ownerRunner}"`, `"ReviewBot" = "${reviewerRunner}"`])
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Claude stream", "--owner", "OwnerBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )
    await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--status", "needs-review", "--actor", "OwnerBot"],
      tmpDir,
    )

    const { stdout, code } = await runBtrain(
      ["loop", "--repo", tmpDir, "--max-rounds", "2", "--timeout", "5", "--poll-interval", "0.05"],
      tmpDir,
    )

    assert.equal(code, 0)
    assert.ok(stdout.includes("--output-format stream-json"), stdout)
    assert.ok(stdout.includes("agent progress:"), stdout)
    assert.ok(stdout.includes("tool Bash: git status --short"), stdout)
    assert.ok(stdout.includes("tool result: M src/brain_train/core.mjs"), stdout)
    assert.ok(stdout.includes("Review finished."), stdout)
    assert.ok(stdout.includes("final handoff: resolved"), stdout)
  })

  it("streams Codex progress events while the runner is still working", async () => {
    const ownerRunner = path.join(tmpDir, "codex")

    await writeExecutable(
      ownerRunner,
      `#!/usr/bin/env node
const fs = require("node:fs")

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n")
}

emit({ type: "thread.started", thread_id: "thread_123" })
emit({ type: "turn.started" })
emit({
  type: "item.completed",
  item: {
    id: "item_0",
    type: "agent_message",
    text: "Checking the handoff state first.",
  },
})
emit({
  type: "item.started",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/bin/zsh -lc 'git status --short'",
    aggregated_output: "",
    exit_code: null,
    status: "in_progress",
  },
})
emit({
  type: "item.completed",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/bin/zsh -lc 'git status --short'",
    aggregated_output: "M src/brain_train/core.mjs\\n",
    exit_code: 0,
    status: "completed",
  },
})

const handoffPath = ".claude/collab/HANDOFF.md"
const content = fs.readFileSync(handoffPath, "utf8")
const updated = content
  .replace("Status: in-progress", "Status: resolved")
  .replace(/Last Updated: .*$/, "Last Updated: OwnerBot 2026-03-15T12:00:03.000Z")
fs.writeFileSync(handoffPath, updated)

emit({
  type: "item.completed",
  item: {
    id: "item_2",
    type: "agent_message",
    text: "Done.",
  },
})
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
  },
})
`,
    )

    await setRunnerConfig(tmpDir, [`"OwnerBot" = "${ownerRunner}"`, `"ReviewBot" = "notify"`])
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Codex stream", "--owner", "OwnerBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )

    const { stdout, code } = await runBtrain(
      ["loop", "--repo", tmpDir, "--max-rounds", "2", "--timeout", "5", "--poll-interval", "0.05"],
      tmpDir,
    )

    assert.equal(code, 0)
    assert.ok(stdout.includes("exec --json -C"), stdout)
    assert.ok(stdout.includes("agent progress:"), stdout)
    assert.ok(stdout.includes("Checking the handoff state first."), stdout)
    assert.ok(stdout.includes("command: git status --short"), stdout)
    assert.ok(stdout.includes("command result: M src/brain_train/core.mjs"), stdout)
    assert.ok(stdout.includes("Done."), stdout)
    assert.ok(stdout.includes("final handoff: resolved"), stdout)
    assert.ok(!stdout.includes("agent stdout (unparsed):"), stdout)
  })

  it("stops when max rounds is exceeded", async () => {
    const ownerRunner = path.join(tmpDir, "owner-loop.js")
    const reviewerRunner = path.join(tmpDir, "reviewer-loop.js")

    await writeExecutable(
      ownerRunner,
      `#!/usr/bin/env node
const fs = require("node:fs")
const handoffPath = ".claude/collab/HANDOFF.md"
const content = fs.readFileSync(handoffPath, "utf8")
const updated = content
  .replace("Status: in-progress", "Status: needs-review")
  .replace(/Last Updated: .*$/, "Last Updated: OwnerBot 2026-03-15T12:00:02.000Z")
fs.writeFileSync(handoffPath, updated)
`,
    )

    await writeExecutable(
      reviewerRunner,
      `#!/usr/bin/env node
const fs = require("node:fs")
const handoffPath = ".claude/collab/HANDOFF.md"
const content = fs.readFileSync(handoffPath, "utf8")
const updated = content
  .replace("Status: needs-review", "Status: in-progress")
  .replace(/Last Updated: .*$/, "Last Updated: ReviewBot 2026-03-15T12:00:03.000Z")
fs.writeFileSync(handoffPath, updated)
`,
    )

    await setRunnerConfig(tmpDir, [`"OwnerBot" = "${ownerRunner}"`, `"ReviewBot" = "${reviewerRunner}"`])
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Loop guardrail", "--owner", "OwnerBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )

    const { stdout, code } = await runBtrain(
      ["loop", "--repo", tmpDir, "--max-rounds", "2", "--timeout", "5", "--poll-interval", "0.05"],
      tmpDir,
    )

    assert.equal(code, 1)
    assert.ok(stdout.includes("selected agent:"), stdout)
    assert.ok(stdout.includes("runner selection:"), stdout)
    assert.ok(stdout.includes("status: max-rounds-exceeded"), stdout)
    assert.ok(stdout.includes("reason: Reached max rounds (2)"), stdout)
  })

  it("exits immediately when the handoff is already resolved", async () => {
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Already done", "--owner", "OwnerBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )
    await runBtrain(
      ["handoff", "resolve", "--repo", tmpDir, "--summary", "Done already", "--actor", "ReviewBot"],
      tmpDir,
    )

    const { stdout, code } = await runBtrain(["loop", "--repo", tmpDir], tmpDir)

    assert.equal(code, 0)
    assert.ok(stdout.includes("loop exit: handoff already resolved"), stdout)
    assert.ok(stdout.includes("status: noop"), stdout)
    assert.ok(stdout.includes("final handoff: resolved"), stdout)
  })
})

describe("custom handoff_path", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("uses the configured handoff_path for handoff and loop commands", async () => {
    const customHandoffPath = await setHandoffPath(tmpDir, "workflow/current-handoff.md")

    const claimResult = await runBtrain(
      [
        "handoff",
        "claim",
        "--repo",
        tmpDir,
        "--task",
        "Custom path task",
        "--owner",
        "OwnerBot",
        "--reviewer",
        "ReviewBot",
      ],
      tmpDir,
    )

    assert.equal(claimResult.code, 0)
    await assert.rejects(fs.access(path.join(tmpDir, ".claude", "collab", "HANDOFF.md")))

    const handoffContent = await fs.readFile(customHandoffPath, "utf8")
    assert.ok(handoffContent.includes("Task: Custom path task"), handoffContent)
    assert.ok(handoffContent.includes("Status: in-progress"), handoffContent)

    const { stdout: handoffStdout, code: handoffCode } = await runBtrain(["handoff", "--repo", tmpDir], tmpDir)
    assert.equal(handoffCode, 0)
    assert.ok(handoffStdout.includes(`handoff file: ${customHandoffPath}`), handoffStdout)

    const { stdout: loopStdout, code: loopCode } = await runBtrain(["loop", "--repo", tmpDir, "--dry-run"], tmpDir)
    assert.equal(loopCode, 0)
    assert.ok(loopStdout.includes(`handoff file: ${customHandoffPath}`), loopStdout)
    assert.ok(loopStdout.includes("task: Custom path task"), loopStdout)
  })
})
