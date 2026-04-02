import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  installPreCommitHook,
  parseCsvList,
  checkLockConflicts,
  findAvailableLane,
  getLaneConfigs,
} from "../src/brain_train/core.mjs"

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function runBtrain(args, cwd, envOverrides = {}) {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const exec = promisify(execFile)
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
  const defaultHandoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md")
  const nextHandoffPath = path.join(tmpDir, relativeHandoffPath)
  let toml = await fs.readFile(tomlPath, "utf8")

  // Replace the top-level handoff_path (before [agents] section)
  toml = toml.replace(
    /^handoff_path = ".*"/m,
    `handoff_path = "${relativeHandoffPath.replaceAll("\\", "/")}"`,
  )
  // Remove entire [lanes] block to test single-file custom handoff path
  toml = toml.replace(/\n\[lanes\][\s\S]*$/, "\n")

  await fs.writeFile(tomlPath, toml, "utf8")
  await fs.mkdir(path.dirname(nextHandoffPath), { recursive: true })
  await fs.rename(defaultHandoffPath, nextHandoffPath)

  return nextHandoffPath
}

async function disableLanes(tmpDir) {
  const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  await fs.writeFile(tomlPath, toml.replace(/\n\[lanes\][\s\S]*$/, "\n"), "utf8")
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
    const handoffPath = path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md")
    const tomlPath = path.join(tmpDir, ".btrain", "project.toml")

    await assert.doesNotReject(fs.access(agentsPath), "AGENTS.md should exist")
    await assert.doesNotReject(fs.access(claudePath), "CLAUDE.md should exist")
    await assert.doesNotReject(fs.access(handoffPath), "HANDOFF_A.md should exist")
    await assert.doesNotReject(fs.access(tomlPath), "project.toml should exist")
  })

  it("copies the bundled skill pack by default and excludes the multispeaker skill", async () => {
    await assert.doesNotReject(
      fs.access(path.join(tmpDir, ".claude", "skills", "pre-handoff", "SKILL.md")),
      "pre-handoff skill should exist",
    )
    await assert.doesNotReject(
      fs.access(path.join(tmpDir, ".claude", "skills", "tessl__webapp-testing", "scripts", "with_server.py")),
      "webapp-testing helper should exist",
    )
    await assert.doesNotReject(
      fs.access(path.join(tmpDir, ".claude", "skills", "tessl__yeet", "agents", "openai.yaml")),
      "yeet metadata should exist",
    )
    await assert.rejects(
      fs.access(
        path.join(
          tmpDir,
          ".claude",
          "skills",
          "create-multi-speaker-static-recordings-using-tts",
          "SKILL.md",
        ),
      ),
      "excluded multispeaker skill should not exist",
    )
  })

  it("AGENTS.md contains the managed block with CLI-first rule", async () => {
    const content = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")
    assert.ok(content.includes("<!-- btrain:managed:start -->"), "Missing managed start fence")
    assert.ok(content.includes("<!-- btrain:managed:end -->"), "Missing managed end fence")
    assert.ok(content.includes("Always use CLI commands"), "Missing CLI-first rule")
    assert.ok(content.includes("Run `btrain handoff` before acting"), "Missing handoff identity check rule")
    assert.ok(content.includes("Before editing, do a short pre-flight review"), "Missing pre-flight review rule")
  })

  it("HANDOFF_A.md has idle status", async () => {
    const content = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
    assert.ok(content.includes("Status: idle"), `Expected idle status in HANDOFF_A.md`)
  })

  it("project.toml has correct structure", async () => {
    const content = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(content.includes("[reviews]"), "Missing [reviews] section")
    assert.ok(content.includes("default_review_mode"), "Missing default_review_mode")
    assert.ok(content.includes("active = []"), "Missing [agents].active scaffold")
    assert.ok(content.includes("[lanes.d]"), "Expected default 4-lane scaffold")
  })

  it("supports core-only init", async () => {
    const localTmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)

    try {
      await exec("git", ["init", localTmpDir])
      const { code, stderr, stdout } = await runBtrain(["init", localTmpDir, "--core-only"], localTmpDir)
      assert.equal(code, 0, stderr)
      assert.ok(stdout.includes("bundled skills: skipped (--core-only)"), stdout)
      await assert.doesNotReject(fs.access(path.join(localTmpDir, "AGENTS.md")), "AGENTS.md should exist")
      await assert.rejects(
        fs.access(path.join(localTmpDir, ".claude", "skills", "pre-handoff", "SKILL.md")),
        "bundled skills should be skipped in core-only mode",
      )
    } finally {
      await rmDir(localTmpDir)
    }
  })

  it("re-running init restores missing bundled skill files without overwriting existing skill content", async () => {
    const localTmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)

    try {
      await exec("git", ["init", localTmpDir])
      let result = await runBtrain(["init", localTmpDir], localTmpDir)
      assert.equal(result.code, 0, result.stderr)

      const preservedSkillPath = path.join(localTmpDir, ".claude", "skills", "pre-handoff", "SKILL.md")
      const restoredAssetPath = path.join(localTmpDir, ".claude", "skills", "tessl__yeet", "agents", "openai.yaml")

      await fs.writeFile(preservedSkillPath, "custom skill text\n", "utf8")
      await fs.rm(restoredAssetPath)

      result = await runBtrain(["init", localTmpDir], localTmpDir)
      assert.equal(result.code, 0, result.stderr)

      assert.equal(await fs.readFile(preservedSkillPath, "utf8"), "custom skill text\n")
      await assert.doesNotReject(fs.access(restoredAssetPath), "missing bundled asset should be restored")
    } finally {
      await rmDir(localTmpDir)
    }
  })
})

describe("dynamic collaborator bootstrap", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("scaffolds 2 lanes per configured collaborator and renders their names into docs", async () => {
    const { code, stderr } = await runBtrain(
      [
        "init",
        tmpDir,
        "--agent",
        "Opus 4.6",
        "--agent",
        "GPT-5 Codex",
        "--agent",
        "Gemini 3.1",
      ],
      tmpDir,
    )

    assert.equal(code, 0, stderr)

    const projectToml = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(
      projectToml.includes('active = ["Opus 4.6", "GPT-5 Codex", "Gemini 3.1"]'),
      projectToml,
    )
    assert.ok(projectToml.includes("[lanes.f]"), projectToml)

    for (const laneId of ["A", "B", "C", "D", "E", "F"]) {
      await assert.doesNotReject(
        fs.access(path.join(tmpDir, ".claude", "collab", `HANDOFF_${laneId}.md`)),
        `HANDOFF_${laneId}.md should exist`,
      )
    }

    const agentsDoc = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")
    assert.ok(agentsDoc.includes("Active collaborating agents: `Opus 4.6`, `GPT-5 Codex`, `Gemini 3.1`"), agentsDoc)
    assert.ok(agentsDoc.includes("Current lane target: 6 lane(s) (2 per collaborating agent)"), agentsDoc)
    assert.ok(agentsDoc.includes("e.g. `a`, `b`, `c`, `d`, `e`, `f`"), agentsDoc)
  })

  it("uses the configured lanes-per-agent value during init", async () => {
    const localTmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)

    try {
      await exec("git", ["init", localTmpDir])

      const { code, stderr } = await runBtrain(
        [
          "init",
          localTmpDir,
          "--agent",
          "GPT-5 Codex",
          "--lanes-per-agent",
          "3",
        ],
        localTmpDir,
      )

      assert.equal(code, 0, stderr)

      const projectToml = await fs.readFile(path.join(localTmpDir, ".btrain", "project.toml"), "utf8")
      assert.ok(projectToml.includes('active = ["GPT-5 Codex"]'), projectToml)
      assert.ok(projectToml.includes('writer_default = "GPT-5 Codex"'), projectToml)
      assert.ok(projectToml.includes('reviewer_default = ""'), projectToml)
      assert.ok(projectToml.includes("per_agent = 3"), projectToml)
      assert.ok(projectToml.includes("[lanes.c]"), projectToml)
      assert.ok(!projectToml.includes("[lanes.d]"), projectToml)

      for (const laneId of ["A", "B", "C"]) {
        await assert.doesNotReject(
          fs.access(path.join(localTmpDir, ".claude", "collab", `HANDOFF_${laneId}.md`)),
          `HANDOFF_${laneId}.md should exist`,
        )
      }

      const agentsDoc = await fs.readFile(path.join(localTmpDir, "AGENTS.md"), "utf8")
      assert.ok(agentsDoc.includes("Current lane target: 3 lane(s) (3 per collaborating agent)"), agentsDoc)
      assert.ok(agentsDoc.includes("Change `[agents].active` or `[lanes].per_agent`"), agentsDoc)
    } finally {
      await rmDir(localTmpDir)
    }
  })
})

describe("dynamic collaborator migration", () => {
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

  it("re-running init with --agent updates the active agent list on an existing repo", async () => {
    const { code, stderr } = await runBtrain(
      ["init", tmpDir, "--agent", "GPT-5 Codex", "--agent", "Opus 4.6"],
      tmpDir,
    )
    assert.equal(code, 0, stderr)

    const projectToml = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(projectToml.includes('active = ["GPT-5 Codex", "Opus 4.6"]'), projectToml)
    assert.ok(projectToml.includes('writer_default = "GPT-5 Codex"'), projectToml)
    assert.ok(projectToml.includes('reviewer_default = "Opus 4.6"'), projectToml)

    const agentsDoc = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")
    assert.ok(agentsDoc.includes("Active collaborating agents: `GPT-5 Codex`, `Opus 4.6`"), agentsDoc)
  })

  it("re-running init with --lanes-per-agent appends missing lane sections and files", async () => {
    const { code, stderr } = await runBtrain(
      ["init", tmpDir, "--agent", "GPT-5 Codex", "--agent", "Opus 4.6", "--lanes-per-agent", "3"],
      tmpDir,
    )
    assert.equal(code, 0, stderr)

    const projectToml = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(projectToml.includes('active = ["GPT-5 Codex", "Opus 4.6"]'), projectToml)
    assert.ok(projectToml.includes("per_agent = 3"), projectToml)
    assert.ok(projectToml.includes("[lanes.e]"), projectToml)
    assert.ok(projectToml.includes("[lanes.f]"), projectToml)

    for (const laneId of ["E", "F"]) {
      await assert.doesNotReject(
        fs.access(path.join(tmpDir, ".claude", "collab", `HANDOFF_${laneId}.md`)),
        `HANDOFF_${laneId}.md should exist`,
      )
    }

    const agentsDoc = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")
    assert.ok(agentsDoc.includes("Current lane target: 6 lane(s) (3 per collaborating agent)"), agentsDoc)
  })
})

describe("btrain agents commands", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir, "--agent", "GPT-5 Codex", "--lanes-per-agent", "3"], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("agents add appends collaborators and scaffolds newly required lanes", async () => {
    const { code, stderr } = await runBtrain(
      ["agents", "add", "--repo", tmpDir, "--agent", "Opus 4.6"],
      tmpDir,
    )
    assert.equal(code, 0, stderr)

    const projectToml = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(projectToml.includes('active = ["GPT-5 Codex", "Opus 4.6"]'), projectToml)
    assert.ok(projectToml.includes("per_agent = 3"), projectToml)
    assert.ok(projectToml.includes("[lanes.f]"), projectToml)

    for (const laneId of ["D", "E", "F"]) {
      await assert.doesNotReject(
        fs.access(path.join(tmpDir, ".claude", "collab", `HANDOFF_${laneId}.md`)),
        `HANDOFF_${laneId}.md should exist`,
      )
    }

    const agentsDoc = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")
    assert.ok(agentsDoc.includes("Active collaborating agents: `GPT-5 Codex`, `Opus 4.6`"), agentsDoc)
    assert.ok(agentsDoc.includes("Current lane target: 6 lane(s) (3 per collaborating agent)"), agentsDoc)
  })

  it("agents set replaces the active agent list and refreshes docs", async () => {
    const { code, stderr } = await runBtrain(
      ["agents", "set", "--repo", tmpDir, "--agent", "Opus 4.6", "--agent", "Gemini 3.1"],
      tmpDir,
    )
    assert.equal(code, 0, stderr)

    const projectToml = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(projectToml.includes('active = ["Opus 4.6", "Gemini 3.1"]'), projectToml)

    const agentsDoc = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf8")
    assert.ok(agentsDoc.includes("Active collaborating agents: `Opus 4.6`, `Gemini 3.1`"), agentsDoc)
    assert.ok(agentsDoc.includes("Current lane target: 6 lane(s) (3 per collaborating agent)"), agentsDoc)
  })
})

describe("installPreCommitHook", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("writes hooks into the common git dir for worktree-style repos", async () => {
    const worktreeGitDir = path.join(tmpDir, ".git-state", "worktree")
    const commonGitDir = path.join(tmpDir, ".git-state", "common")

    await fs.mkdir(worktreeGitDir, { recursive: true })
    await fs.mkdir(commonGitDir, { recursive: true })
    await fs.writeFile(path.join(tmpDir, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8")
    await fs.writeFile(path.join(worktreeGitDir, "commondir"), "../common\n", "utf8")

    const result = await installPreCommitHook(tmpDir)
    const hookPath = path.join(commonGitDir, "hooks", "pre-commit")
    const hookContent = await fs.readFile(hookPath, "utf8")

    assert.deepStrictEqual(result, { installed: true, reason: "created" })
    assert.ok(hookContent.includes("# btrain:pre-commit-hook"), "Expected btrain hook marker")
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
    await disableLanes(tmpDir)
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
    assert.ok(stdout.includes("peer reviewer: ReviewBot"), `Expected peer reviewer to stay on the peer: ${stdout}`)
  })

  it("update fills structured reviewer context fields", async () => {
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Structured handoff", "--owner", "TestBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )

    const { stdout } = await runBtrain(
      [
        "handoff",
        "update",
        "--repo",
        tmpDir,
        "--status",
        "needs-review",
        "--actor",
        "TestBot",
        "--base",
        "feat/structured-handoff",
        "--preflight",
        "--changed",
        "src/engine/synthesizer.ts — align reviewer context parsing",
        "--changed",
        "README.md — document structured reviewer context flags",
        "--verification",
        "node --test test/core.test.mjs",
        "--verification",
        "git diff --check",
        "--gap",
        "Did not re-run end-to-end browser validation",
        "--why",
        "The public CLI needs to fill the same structured handoff fields that the docs require.",
        "--review-ask",
        "Verify the placeholder review asks are replaced",
        "--review-ask",
        "Confirm the Base field is written to Current",
      ],
      tmpDir,
    )

    assert.ok(stdout.includes("status: needs-review"), stdout)

    const content = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
    assert.ok(content.includes("Base: feat/structured-handoff"), content)
    assert.ok(content.includes("- [x] Checked locked files, nearby diff, and likely risk areas before editing"), content)
    assert.ok(content.includes("- src/engine/synthesizer.ts — align reviewer context parsing"), content)
    assert.ok(content.includes("- README.md — document structured reviewer context flags"), content)
    assert.ok(content.includes("- node --test test/core.test.mjs"), content)
    assert.ok(content.includes("- git diff --check"), content)
    assert.ok(content.includes("- Did not re-run end-to-end browser validation"), content)
    assert.ok(content.includes("The public CLI needs to fill the same structured handoff fields that the docs require."), content)
    assert.ok(content.includes("- Verify the placeholder review asks are replaced"), content)
    assert.ok(content.includes("- Confirm the Base field is written to Current"), content)
    assert.ok(!content.includes("Fill this in before handoff"), content)
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

describe("btrain handoff reviewer intelligence", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(
      ["init", tmpDir, "--agent", "OwnerBot", "--agent", "ReviewBot", "--agent", "BackupBot"],
      tmpDir,
    )
    await disableLanes(tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("keeps needs-review pointed at a peer even if --reviewer matches the actor", async () => {
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Peer review", "--owner", "OwnerBot", "--reviewer", "ReviewBot"],
      tmpDir,
    )

    const { stdout, code, stderr } = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--status", "needs-review", "--reviewer", "OwnerBot", "--actor", "OwnerBot"],
      tmpDir,
    )

    assert.equal(code, 0, stderr)
    assert.ok(stdout.includes("status: needs-review"), stdout)
    assert.ok(stdout.includes("peer reviewer: ReviewBot"), stdout)
  })

  it("supports --reviewer any-other during claim", async () => {
    const { stdout, code, stderr } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Auto peer", "--owner", "OwnerBot", "--reviewer", "any-other"],
      tmpDir,
    )

    assert.equal(code, 0, stderr)
    assert.ok(stdout.includes("peer reviewer: ReviewBot"), stdout)
  })

  it("snaps claim reviewer to a peer when it matches the owner", async () => {
    const { stdout, code, stderr } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Same owner reviewer", "--owner", "OwnerBot", "--reviewer", "OwnerBot"],
      tmpDir,
    )

    assert.equal(code, 0, stderr)
    assert.ok(stdout.includes("peer reviewer: ReviewBot"), stdout)
  })

  it("accepts --reviewer any-other during needs-review updates", async () => {
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Any other update", "--owner", "OwnerBot", "--reviewer", "BackupBot"],
      tmpDir,
    )

    const { stdout, code, stderr } = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--status", "needs-review", "--reviewer", "any-other", "--actor", "OwnerBot"],
      tmpDir,
    )

    assert.equal(code, 0, stderr)
    assert.ok(stdout.includes("peer reviewer: BackupBot"), stdout)
  })

  it("errors when any-other cannot resolve to a peer", async () => {
    const localTmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)

    try {
      await exec("git", ["init", localTmpDir])
      await runBtrain(["init", localTmpDir, "--agent", "SoloBot"], localTmpDir)
      await disableLanes(localTmpDir)

      const result = await runBtrain(
        ["handoff", "claim", "--repo", localTmpDir, "--task", "No peer", "--owner", "SoloBot", "--reviewer", "any-other"],
        localTmpDir,
      )

      assert.notEqual(result.code, 0)
      assert.ok(
        result.stderr.includes('Could not infer a reviewer different from "SoloBot"'),
        result.stderr,
      )
    } finally {
      await rmDir(localTmpDir)
    }
  })
})

describe("btrain handoff agent verification", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
    await disableLanes(tmpDir)
    await setRunnerConfig(tmpDir, ['"GPT-5 Codex" = "codex"', '"Opus 4.6" = "claude"'])
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("shows the detected agent during handoff checks", async () => {
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--task", "Verified handoff", "--owner", "GPT-5 Codex", "--reviewer", "Opus 4.6"],
      tmpDir,
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    const { stdout, code, stderr } = await runBtrain(
      ["handoff", "--repo", tmpDir],
      tmpDir,
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    assert.equal(code, 0, stderr)
    assert.ok(stdout.includes("agent check: GPT-5 Codex"), stdout)
  })

  it("auto-detects the actor and rejects mismatched --actor values", async () => {
    let result = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--status", "needs-review"],
      tmpDir,
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.stdout.includes("peer reviewer: Opus 4.6"), result.stdout)

    result = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--status", "in-progress", "--actor", "Opus 4.6"],
      tmpDir,
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    assert.notEqual(result.code, 0)
    assert.ok(result.stderr.includes('does not match the detected agent "GPT-5 Codex"'), result.stderr)
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
    await disableLanes(tmpDir)
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
    await disableLanes(tmpDir)
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
    await disableLanes(tmpDir)
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
    await disableLanes(tmpDir)

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
    await disableLanes(tmpDir)
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
    assert.ok(stdout.includes("reason: handoff status is in-progress, so the active agent acts next"), stdout)
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
const handoffPath = ".claude/collab/HANDOFF_A.md"
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
const handoffPath = ".claude/collab/HANDOFF_A.md"
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
const handoffPath = ".claude/collab/HANDOFF_A.md"
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

const handoffPath = ".claude/collab/HANDOFF_A.md"
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

const handoffPath = ".claude/collab/HANDOFF_A.md"
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
const handoffPath = ".claude/collab/HANDOFF_A.md"
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
const handoffPath = ".claude/collab/HANDOFF_A.md"
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

describe("btrain push", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
    await disableLanes(tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("rejects the removed push command", async () => {
    const { stdout, stderr, code } = await runBtrain(
      ["push", "OwnerBot", "--repo", tmpDir, "--prompt", "check lane e"],
      tmpDir,
    )

    const output = `${stdout}\n${stderr}`
    assert.equal(code, 1, output)
    assert.ok(
      output.includes("`btrain push` has been removed. Use `btrain handoff` plus `handoff claim|update|resolve` only."),
      output,
    )
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
    await assert.rejects(fs.access(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md")))

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

// ──────────────────────────────────────────────
// Helper: enable lanes in project.toml
// ──────────────────────────────────────────────

async function enableLanes(tmpDir) {
  const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  const lanesSection = [
    "",
    "[lanes]",
    "enabled = true",
    "",
    "[lanes.a]",
    'handoff_path = ".claude/collab/HANDOFF_A.md"',
    "",
    "[lanes.b]",
    'handoff_path = ".claude/collab/HANDOFF_B.md"',
  ].join("\n")

  await fs.writeFile(tomlPath, toml + lanesSection, "utf8")
}

// ──────────────────────────────────────────────
// Unit tests: checkLockConflicts
// ──────────────────────────────────────────────

describe("checkLockConflicts", () => {
  it("returns empty when no locks exist", () => {
    const registry = { version: 1, locks: [] }
    const conflicts = checkLockConflicts(registry, "a", ["src/foo.mjs"])
    assert.deepStrictEqual(conflicts, [])
  })

  it("returns empty when file is locked by the same lane", () => {
    const registry = {
      version: 1,
      locks: [{ path: "src/foo.mjs", lane: "a", owner: "Claude" }],
    }
    const conflicts = checkLockConflicts(registry, "a", ["src/foo.mjs"])
    assert.deepStrictEqual(conflicts, [])
  })

  it("detects exact path conflict from another lane", () => {
    const registry = {
      version: 1,
      locks: [{ path: "src/foo.mjs", lane: "b", owner: "Gemini" }],
    }
    const conflicts = checkLockConflicts(registry, "a", ["src/foo.mjs"])
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0].lockedBy, "b")
    assert.equal(conflicts[0].owner, "Gemini")
  })

  it("detects directory prefix conflict", () => {
    const registry = {
      version: 1,
      locks: [{ path: "src/auth/", lane: "b", owner: "Gemini" }],
    }
    const conflicts = checkLockConflicts(registry, "a", ["src/auth/login.mjs"])
    assert.equal(conflicts.length, 1)
  })

  it("detects when a claimed file is a parent of a locked path", () => {
    const registry = {
      version: 1,
      locks: [{ path: "src/auth/login.mjs", lane: "b", owner: "Gemini" }],
    }
    const conflicts = checkLockConflicts(registry, "a", ["src/auth/"])
    assert.equal(conflicts.length, 1)
  })

  it("returns empty for non-overlapping paths", () => {
    const registry = {
      version: 1,
      locks: [{ path: "src/auth/", lane: "b", owner: "Gemini" }],
    }
    const conflicts = checkLockConflicts(registry, "a", ["src/scoring/engine.mjs"])
    assert.deepStrictEqual(conflicts, [])
  })
})

// ──────────────────────────────────────────────
// Unit tests: findAvailableLane
// ──────────────────────────────────────────────

describe("findAvailableLane", () => {
  it("picks idle lane over resolved", () => {
    const states = [
      { _laneId: "a", status: "in-progress" },
      { _laneId: "b", status: "idle" },
    ]
    assert.equal(findAvailableLane(states), "b")
  })

  it("picks resolved lane when no idle", () => {
    const states = [
      { _laneId: "a", status: "in-progress" },
      { _laneId: "b", status: "resolved" },
    ]
    assert.equal(findAvailableLane(states), "b")
  })

  it("returns null when all lanes are busy", () => {
    const states = [
      { _laneId: "a", status: "in-progress" },
      { _laneId: "b", status: "needs-review" },
    ]
    assert.equal(findAvailableLane(states), null)
  })
})

// ──────────────────────────────────────────────
// Unit tests: getLaneConfigs
// ──────────────────────────────────────────────

describe("getLaneConfigs", () => {
  it("returns null when no lanes section exists", () => {
    assert.equal(getLaneConfigs({}), null)
    assert.equal(getLaneConfigs({ name: "test" }), null)
  })

  it("returns null when lanes.enabled is false", () => {
    assert.equal(getLaneConfigs({ lanes: { enabled: false } }), null)
  })

  it("returns default lane configs (a-d) when lanes is enabled with no subsections", () => {
    const configs = getLaneConfigs({ lanes: { enabled: true } })
    assert.ok(configs)
    assert.equal(configs.length, 4)
    assert.equal(configs[0].id, "a")
    assert.equal(configs[1].id, "b")
    assert.equal(configs[2].id, "c")
    assert.equal(configs[3].id, "d")
  })

  it("derives 2 lanes per active collaborator when names are configured", () => {
    const configs = getLaneConfigs({
      agents: { active: ["Opus 4.6", "GPT-5 Codex", "Gemini 3.1"] },
      lanes: { enabled: true },
    })
    assert.ok(configs)
    assert.equal(configs.length, 6)
    assert.equal(configs[5].id, "f")
  })

  it("uses the configured collaborator count when only one active agent is set", () => {
    const configs = getLaneConfigs({
      agents: { active: ["GPT-5 Codex"] },
      lanes: { enabled: true, per_agent: 3 },
    })
    assert.ok(configs)
    assert.equal(configs.length, 3)
    assert.equal(configs[2].id, "c")
  })

  it("uses lanes.per_agent when deriving the default lane set", () => {
    const configs = getLaneConfigs({
      agents: { active: ["Opus 4.6", "GPT-5 Codex"] },
      lanes: { enabled: true, per_agent: 3 },
    })
    assert.ok(configs)
    assert.equal(configs.length, 6)
    assert.equal(configs[5].id, "f")
  })

  it("uses custom handoff paths from config", () => {
    const configs = getLaneConfigs({
      lanes: {
        enabled: true,
        a: { handoff_path: "custom/A.md" },
        b: { handoff_path: "custom/B.md" },
      },
    })
    assert.equal(configs[0].handoffPath, "custom/A.md")
    assert.equal(configs[1].handoffPath, "custom/B.md")
  })

  it("dynamically discovers lanes c and d from config", () => {
    const configs = getLaneConfigs({
      lanes: {
        enabled: true,
        a: { handoff_path: ".claude/collab/HANDOFF_A.md" },
        b: { handoff_path: ".claude/collab/HANDOFF_B.md" },
        c: { handoff_path: ".claude/collab/HANDOFF_C.md" },
        d: { handoff_path: ".claude/collab/HANDOFF_D.md" },
      },
    })
    assert.equal(configs.length, 4)
    assert.equal(configs[0].id, "a")
    assert.equal(configs[1].id, "b")
    assert.equal(configs[2].id, "c")
    assert.equal(configs[3].id, "d")
    assert.equal(configs[2].handoffPath, ".claude/collab/HANDOFF_C.md")
    assert.equal(configs[3].handoffPath, ".claude/collab/HANDOFF_D.md")
  })

  it("generates default handoff paths for unconfigured lanes", () => {
    const configs = getLaneConfigs({
      lanes: {
        enabled: true,
        a: {},
        c: {},
      },
    })
    assert.equal(configs.length, 2)
    assert.equal(configs[0].id, "a")
    assert.equal(configs[0].handoffPath, ".claude/collab/HANDOFF_A.md")
    assert.equal(configs[1].id, "c")
    assert.equal(configs[1].handoffPath, ".claude/collab/HANDOFF_C.md")
  })

  it("sorts multi-letter lane ids in lane order", () => {
    const configs = getLaneConfigs({
      lanes: {
        enabled: true,
        z: {},
        aa: {},
        b: {},
      },
    })
    assert.deepStrictEqual(configs.map((config) => config.id), ["b", "z", "aa"])
  })
})

// ──────────────────────────────────────────────
// Integration tests: lane upgrade migration (2→4)
// ──────────────────────────────────────────────

describe("lane upgrade migration", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)

    // Simulate an old 2-lane repo by removing lanes c and d from the toml
    const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
    let toml = await fs.readFile(tomlPath, "utf8")
    toml = toml.replace(/\n\[lanes\.c\][\s\S]*?\[lanes\.d\][\s\S]*$/, "\n")
    await fs.writeFile(tomlPath, toml, "utf8")

    // Remove the scaffolded C/D handoff files
    const collabDir = path.join(tmpDir, ".claude", "collab")
    await fs.rm(path.join(collabDir, "HANDOFF_C.md"), { force: true })
    await fs.rm(path.join(collabDir, "HANDOFF_D.md"), { force: true })
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("re-running init adds missing lanes c and d to existing 2-lane config", async () => {
    // Verify only A/B exist before upgrade
    const tomlBefore = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(tomlBefore.includes("[lanes.a]"), "Should have lane a before upgrade")
    assert.ok(tomlBefore.includes("[lanes.b]"), "Should have lane b before upgrade")
    assert.ok(!tomlBefore.includes("[lanes.c]"), "Should NOT have lane c before upgrade")
    assert.ok(!tomlBefore.includes("[lanes.d]"), "Should NOT have lane d before upgrade")

    // Run init to trigger migration
    const { code, stderr } = await runBtrain(["init", tmpDir], tmpDir)
    assert.equal(code, 0, stderr)

    // Verify lanes c and d were added to toml
    const tomlAfter = await fs.readFile(path.join(tmpDir, ".btrain", "project.toml"), "utf8")
    assert.ok(tomlAfter.includes("[lanes.c]"), "Should have lane c after upgrade")
    assert.ok(tomlAfter.includes("[lanes.d]"), "Should have lane d after upgrade")
    assert.ok(tomlAfter.includes("HANDOFF_C.md"), "Should have HANDOFF_C path")
    assert.ok(tomlAfter.includes("HANDOFF_D.md"), "Should have HANDOFF_D path")

    // Verify handoff files were scaffolded
    await assert.doesNotReject(fs.access(path.join(tmpDir, ".claude", "collab", "HANDOFF_C.md")), "HANDOFF_C.md should exist")
    await assert.doesNotReject(fs.access(path.join(tmpDir, ".claude", "collab", "HANDOFF_D.md")), "HANDOFF_D.md should exist")

    // Verify existing lanes a/b are untouched
    assert.ok(tomlAfter.includes("[lanes.a]"), "Lane a should still exist")
    assert.ok(tomlAfter.includes("[lanes.b]"), "Lane b should still exist")
  })
})

// ──────────────────────────────────────────────
// Integration tests: multi-lane handoff lifecycle
// ──────────────────────────────────────────────

describe("multi-lane handoff lifecycle", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
    await enableLanes(tmpDir)
    // Re-run init to create lane handoff files
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("init creates per-lane handoff files", async () => {
    const handoffA = path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md")
    const handoffB = path.join(tmpDir, ".claude", "collab", "HANDOFF_B.md")
    const locksFile = path.join(tmpDir, ".btrain", "locks.json")

    await assert.doesNotReject(fs.access(handoffA), "HANDOFF_A.md should exist")
    await assert.doesNotReject(fs.access(handoffB), "HANDOFF_B.md should exist")
    await assert.doesNotReject(fs.access(locksFile), "locks.json should exist")
  })

  it("handoff shows both lanes", async () => {
    const { stdout } = await runBtrain(["handoff", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("lane a"), `Expected lane a output: ${stdout}`)
    assert.ok(stdout.includes("lane b"), `Expected lane b output: ${stdout}`)
  })

  it("claim with --lane targets specific lane", async () => {
    const { stdout } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Auth work", "--owner", "Claude", "--reviewer", "Gemini", "--files", "src/auth/"],
      tmpDir,
    )
    assert.ok(stdout.includes("status: in-progress"), `Expected in-progress: ${stdout}`)
    assert.ok(stdout.includes("Auth work"), `Expected task name: ${stdout}`)
    assert.ok(stdout.includes("locked files: src/auth/"), `Expected lock summary: ${stdout}`)
    assert.ok(stdout.includes("lock state: active"), `Expected active lock state: ${stdout}`)

    // Verify lane-specific handoff file was written
    const contentA = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
    assert.ok(contentA.includes("Auth work"), "Lane A handoff should contain the task")
    assert.ok(contentA.includes("Status: in-progress"), "Lane A should be in-progress")

    // Verify lane B is still idle
    const contentB = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_B.md"), "utf8")
    assert.ok(contentB.includes("Status: idle"), "Lane B should still be idle")
  })

  it("claim on lane b while lane a is in-progress", async () => {
    const { stdout } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "b", "--task", "Scoring work", "--owner", "Gemini", "--reviewer", "Claude", "--files", "src/scoring/"],
      tmpDir,
    )
    assert.ok(stdout.includes("Scoring work"), `Expected task name: ${stdout}`)

    // Both lanes should be in-progress
    const contentA = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
    const contentB = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_B.md"), "utf8")
    assert.ok(contentA.includes("Status: in-progress"), "Lane A should be in-progress")
    assert.ok(contentB.includes("Status: in-progress"), "Lane B should be in-progress")
  })

  it("locks are created during lane claim", async () => {
    const { stdout } = await runBtrain(["locks", "--repo", tmpDir], tmpDir)
    assert.ok(stdout.includes("src/auth/"), `Expected auth lock: ${stdout}`)
    assert.ok(stdout.includes("src/scoring/"), `Expected scoring lock: ${stdout}`)
    assert.ok(stdout.includes("lane a"), `Expected lane a lock: ${stdout}`)
    assert.ok(stdout.includes("lane b"), `Expected lane b lock: ${stdout}`)
  })

  it("update lane a to needs-review", async () => {
    const { stdout } = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--lane", "a", "--status", "needs-review", "--actor", "Claude"],
      tmpDir,
    )
    assert.ok(stdout.includes("lane a"), stdout)

    const contentA = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
    assert.ok(contentA.includes("Status: needs-review"), "Lane A should be needs-review")
    assert.ok(contentA.includes("Peer Reviewer: Gemini"), contentA)

    // Lane B should still be in-progress
    const contentB = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_B.md"), "utf8")
    assert.ok(contentB.includes("Status: in-progress"), "Lane B should still be in-progress")
  })

  it("resolve lane a releases its locks", async () => {
    await runBtrain(
      ["handoff", "resolve", "--repo", tmpDir, "--lane", "a", "--summary", "Auth done", "--actor", "Gemini"],
      tmpDir,
    )

    const contentA = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
    assert.ok(contentA.includes("Status: resolved"), "Lane A should be resolved")
    assert.match(contentA, /^Locked Files:\s*$/m, "Lane A should clear Locked Files on resolve")

    // Lane A locks should be released, Lane B locks should remain
    const locks = JSON.parse(await fs.readFile(path.join(tmpDir, ".btrain", "locks.json"), "utf8"))
    const laneALocks = locks.locks.filter((l) => l.lane === "a")
    const laneBLocks = locks.locks.filter((l) => l.lane === "b")
    assert.equal(laneALocks.length, 0, "Lane A should have no locks")
    assert.ok(laneBLocks.length > 0, "Lane B should still have locks")
  })

  it("locks release-lane clears all locks for a lane", async () => {
    const { stdout } = await runBtrain(
      ["locks", "release-lane", "--repo", tmpDir, "--lane", "b"],
      tmpDir,
    )
    assert.ok(stdout.includes("Released"), stdout)

    const locks = JSON.parse(await fs.readFile(path.join(tmpDir, ".btrain", "locks.json"), "utf8"))
    assert.equal(locks.locks.length, 0, "All locks should be released")
  })
})

// ──────────────────────────────────────────────
// Integration tests: multi-lane guardrails
// ──────────────────────────────────────────────

describe("multi-lane guardrails", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
    await enableLanes(tmpDir)
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("requires --files when claiming a lane", async () => {
    const { stderr, code } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Unsafely unscoped", "--owner", "Claude", "--reviewer", "Gemini"],
      tmpDir,
    )

    assert.notEqual(code, 0)
    assert.ok(stderr.includes("require --files"), stderr)
  })

  it("requires --lane for update and resolve in multi-lane mode", async () => {
    const updateResult = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--status", "needs-review", "--actor", "Claude"],
      tmpDir,
    )
    assert.notEqual(updateResult.code, 0)
    assert.ok(updateResult.stderr.includes("requires --lane"), updateResult.stderr)

    const resolveResult = await runBtrain(
      ["handoff", "resolve", "--repo", tmpDir, "--summary", "done", "--actor", "Gemini"],
      tmpDir,
    )
    assert.notEqual(resolveResult.code, 0)
    assert.ok(resolveResult.stderr.includes("requires --lane"), resolveResult.stderr)
  })

  it("rejects claiming an already-active lane", async () => {
    const claimResult = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Auth", "--owner", "Claude", "--reviewer", "Gemini", "--files", "src/auth/"],
      tmpDir,
    )
    assert.equal(claimResult.code, 0, claimResult.stderr)

    const secondClaim = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "More auth", "--owner", "Claude", "--reviewer", "Gemini", "--files", "src/auth/"],
      tmpDir,
    )
    assert.notEqual(secondClaim.code, 0)
    assert.ok(secondClaim.stderr.includes("already in-progress"), secondClaim.stderr)
  })

  it("resyncs the lane lock registry when --files changes", async () => {
    const { stdout, code, stderr } = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--lane", "a", "--files", "src/auth/, test/auth/", "--actor", "Claude"],
      tmpDir,
    )
    assert.equal(code, 0, stderr)
    assert.ok(stdout.includes("locked files: src/auth/, test/auth/"), stdout)
    assert.ok(stdout.includes("lock state: active"), stdout)

    const contentA = await fs.readFile(path.join(tmpDir, ".claude", "collab", "HANDOFF_A.md"), "utf8")
    assert.ok(contentA.includes("Locked Files: src/auth/, test/auth/"), contentA)

    const locks = JSON.parse(await fs.readFile(path.join(tmpDir, ".btrain", "locks.json"), "utf8"))
    const laneALocks = locks.locks.filter((lock) => lock.lane === "a").map((lock) => lock.path).sort()
    assert.deepStrictEqual(laneALocks, ["src/auth/", "test/auth/"])
  })

  it("does not allow in-progress without active locks after resolve", async () => {
    const resolveResult = await runBtrain(
      ["handoff", "resolve", "--repo", tmpDir, "--lane", "a", "--summary", "done", "--actor", "Gemini"],
      tmpDir,
    )
    assert.equal(resolveResult.code, 0, resolveResult.stderr)

    const updateResult = await runBtrain(
      ["handoff", "update", "--repo", tmpDir, "--lane", "a", "--status", "in-progress", "--actor", "Claude"],
      tmpDir,
    )
    assert.notEqual(updateResult.code, 0)
    assert.ok(updateResult.stderr.includes("without locked files"), updateResult.stderr)
  })
})

// ──────────────────────────────────────────────
// Integration tests: lock conflict detection
// ──────────────────────────────────────────────

describe("multi-lane lock conflicts", () => {
  let tmpDir

  before(async () => {
    tmpDir = await makeTmpDir()
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const exec = promisify(execFile)
    await exec("git", ["init", tmpDir])
    await runBtrain(["init", tmpDir], tmpDir)
    await enableLanes(tmpDir)
    await runBtrain(["init", tmpDir], tmpDir)
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("claiming overlapping files on different lanes fails", async () => {
    // Claim lane A with src/shared/
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Task A", "--owner", "Claude", "--reviewer", "Gemini", "--files", "src/shared/"],
      tmpDir,
    )

    // Claiming lane B with overlapping path should fail
    const { stderr, code } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "b", "--task", "Task B", "--owner", "Gemini", "--reviewer", "Claude", "--files", "src/shared/utils.mjs"],
      tmpDir,
    )

    assert.ok(code !== 0 || stderr.includes("lock conflict"), `Expected lock conflict error: ${stderr}`)
  })

  it("claiming non-overlapping files on different lanes succeeds", async () => {
    // Clean up lane A first
    await runBtrain(
      ["handoff", "resolve", "--repo", tmpDir, "--lane", "a", "--summary", "done", "--actor", "Gemini"],
      tmpDir,
    )

    // Claim lane A with src/auth/
    await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Auth", "--owner", "Claude", "--reviewer", "Gemini", "--files", "src/auth/"],
      tmpDir,
    )

    // Claim lane B with src/scoring/ — should succeed
    const { code } = await runBtrain(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "b", "--task", "Scoring", "--owner", "Gemini", "--reviewer", "Claude", "--files", "src/scoring/"],
      tmpDir,
    )

    assert.equal(code, 0, "Non-overlapping file claims should succeed")
  })
})
