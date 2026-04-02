import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-e2e-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
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

function buildNpmEnv(baseDir) {
  return {
    ...process.env,
    npm_config_audit: "false",
    npm_config_cache: path.join(baseDir, ".npm-cache"),
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  }
}

function buildProjectEnv(projectDir, overrides = {}) {
  return {
    ...process.env,
    BRAIN_TRAIN_HOME: path.join(projectDir, ".btrain-test-home"),
    ...overrides,
  }
}

async function installPackedCli() {
  const workspaceDir = await makeTmpDir()
  const packDir = path.join(workspaceDir, "pack")
  const prefixDir = path.join(workspaceDir, "prefix")

  await fs.mkdir(packDir, { recursive: true })

  const packResult = await runCommand("npm", ["pack", REPO_ROOT, "--json"], {
    cwd: packDir,
    env: buildNpmEnv(workspaceDir),
  })
  assert.equal(packResult.code, 0, packResult.stderr)

  const packInfo = JSON.parse(packResult.stdout)
  const tarballPath = path.join(packDir, packInfo[0].filename)

  const installResult = await runCommand("npm", ["install", "--global", "--prefix", prefixDir, tarballPath], {
    cwd: workspaceDir,
    env: buildNpmEnv(workspaceDir),
  })
  assert.equal(installResult.code, 0, installResult.stderr)

  return {
    btrainBin: path.join(prefixDir, "bin", "btrain"),
    workspaceDir,
  }
}

async function createProjectRepo(btrainBin) {
  const projectDir = await makeTmpDir()

  const gitInit = await runCommand("git", ["init", projectDir], { cwd: REPO_ROOT, env: process.env })
  assert.equal(gitInit.code, 0, gitInit.stderr)

  const initResult = await runCommand(btrainBin, ["init", projectDir], {
    cwd: projectDir,
    env: buildProjectEnv(projectDir),
  })
  assert.equal(initResult.code, 0, initResult.stderr)

  return projectDir
}

async function enableLanes(projectDir) {
  const tomlPath = path.join(projectDir, ".btrain", "project.toml")
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

async function setRunnerConfig(projectDir, mappingLines) {
  const tomlPath = path.join(projectDir, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  const updated = toml.replace(
    /\[agents\.runners\][\s\S]*?\n\[reviews\]/,
    `[agents.runners]\n${mappingLines.join("\n")}\n\n[reviews]`,
  )
  await fs.writeFile(tomlPath, updated, "utf8")
}

async function runInstalledBtrain(btrainBin, projectDir, args, envOverrides = {}) {
  return runCommand(btrainBin, args, {
    cwd: projectDir,
    env: buildProjectEnv(projectDir, envOverrides),
  })
}

describe("installed CLI e2e", () => {
  let installState
  const cleanupDirs = []

  before(async () => {
    installState = await installPackedCli()
  })

  after(async () => {
    for (const dirPath of cleanupDirs.reverse()) {
      await rmDir(dirPath)
    }
    if (installState?.workspaceDir) {
      await rmDir(installState.workspaceDir)
    }
  })

  it("runs the lane handoff flow through the installed CLI", async () => {
    const projectDir = await createProjectRepo(installState.btrainBin)
    cleanupDirs.push(projectDir)

    await assert.doesNotReject(
      fs.access(path.join(projectDir, ".claude", "skills", "pre-handoff", "SKILL.md")),
      "pre-handoff skill should be installed",
    )
    await assert.doesNotReject(
      fs.access(path.join(projectDir, ".claude", "skills", "tessl__webapp-testing", "scripts", "with_server.py")),
      "webapp-testing helper should be installed",
    )
    await assert.doesNotReject(
      fs.access(path.join(projectDir, ".claude", "skills", "tessl__yeet", "agents", "openai.yaml")),
      "yeet metadata should be installed",
    )
    await assert.rejects(
      fs.access(
        path.join(
          projectDir,
          ".claude",
          "skills",
          "create-multi-speaker-static-recordings-using-tts",
          "SKILL.md",
        ),
      ),
      "excluded multispeaker skill should not be installed",
    )

    // Lanes are auto-configured by init — no enableLanes() needed

    const reinitResult = await runInstalledBtrain(installState.btrainBin, projectDir, ["init", projectDir])
    assert.equal(reinitResult.code, 0, reinitResult.stderr)

    const claimResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "claim",
        "--repo",
        projectDir,
        "--lane",
        "a",
        "--task",
        "Installed CLI lane flow",
        "--owner",
        "GPT-5 Codex",
        "--reviewer",
        "Opus 4.6",
        "--files",
        "src/",
      ],
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    assert.equal(claimResult.code, 0, claimResult.stderr)
    assert.ok(claimResult.stdout.includes("active agent: GPT-5 Codex"), claimResult.stdout)
    assert.ok(claimResult.stdout.includes("peer reviewer: Opus 4.6"), claimResult.stdout)
    assert.ok(claimResult.stdout.includes("start with a short pre-flight review"), claimResult.stdout)

    const updateResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      ["handoff", "update", "--repo", projectDir, "--lane", "a", "--status", "needs-review"],
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    assert.equal(updateResult.code, 0, updateResult.stderr)
    assert.ok(updateResult.stdout.includes("status: needs-review"), updateResult.stdout)
    assert.ok(updateResult.stdout.includes("peer reviewer: Opus 4.6"), updateResult.stdout)
    assert.ok(updateResult.stdout.includes("Waiting on peer review from Opus 4.6."), updateResult.stdout)

    const handoffPath = path.join(projectDir, ".claude", "collab", "HANDOFF_A.md")
    const handoffContent = await fs.readFile(handoffPath, "utf8")
    assert.ok(handoffContent.includes("Active Agent: GPT-5 Codex"), handoffContent)
    assert.ok(handoffContent.includes("Peer Reviewer: Opus 4.6"), handoffContent)
    assert.ok(handoffContent.includes("## Context for Peer Review"), handoffContent)
    assert.ok(handoffContent.includes("Pre-flight review:"), handoffContent)
  })

  it("lets installed CLI claims use --reviewer any-other", async () => {
    const projectDir = await createProjectRepo(installState.btrainBin)
    cleanupDirs.push(projectDir)

    const setAgentsResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      ["agents", "set", "--repo", projectDir, "--agent", "GPT-5 Codex", "--agent", "Opus 4.6", "--agent", "Gemini 3.1"],
    )
    assert.equal(setAgentsResult.code, 0, setAgentsResult.stderr)

    const claimResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "claim",
        "--repo",
        projectDir,
        "--lane",
        "a",
        "--task",
        "Installed CLI any-other reviewer",
        "--owner",
        "GPT-5 Codex",
        "--reviewer",
        "any-other",
        "--files",
        "src/",
      ],
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    assert.equal(claimResult.code, 0, claimResult.stderr)
    assert.ok(claimResult.stdout.includes("peer reviewer: Opus 4.6"), claimResult.stdout)
  })

  it("rejects mismatched actors when the installed CLI detects the current agent", async () => {
    const projectDir = await createProjectRepo(installState.btrainBin)
    cleanupDirs.push(projectDir)

    await setRunnerConfig(projectDir, ['"GPT-5 Codex" = "codex"', '"Opus 4.6" = "claude"'])

    const claimResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "claim",
        "--repo",
        projectDir,
        "--task",
        "Installed CLI actor verification",
        "--owner",
        "GPT-5 Codex",
        "--reviewer",
        "Opus 4.6",
        "--files",
        "src/",
      ],
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )
    assert.equal(claimResult.code, 0, claimResult.stderr)

    const mismatchResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "update",
        "--repo",
        projectDir,
        "--lane",
        "a",
        "--status",
        "needs-review",
        "--actor",
        "Opus 4.6",
      ],
      { BTRAIN_AGENT: "GPT-5 Codex" },
    )

    assert.notEqual(mismatchResult.code, 0)
    assert.ok(
      mismatchResult.stderr.includes('does not match the detected agent "GPT-5 Codex"'),
      mismatchResult.stderr,
    )
  })
})
