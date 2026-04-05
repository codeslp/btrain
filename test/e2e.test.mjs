import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
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

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a local port")))
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function waitForUrl(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return response
      }
      lastError = new Error(`Unexpected status ${response.status} for ${url}`)
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }

  throw lastError || new Error(`Timed out waiting for ${url}`)
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

function startDashboardServer(projectDir, btrainBin, port) {
  const child = spawn("node", [path.join(REPO_ROOT, "scripts", "serve-dashboard.js")], {
    cwd: projectDir,
    env: {
      ...buildProjectEnv(projectDir),
      PATH: `${path.dirname(btrainBin)}${path.delimiter}${process.env.PATH || ""}`,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return child
}

async function stopDashboardServer(child) {
  if (child.exitCode !== null) {
    return
  }

  await new Promise((resolve) => {
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
      }
    }, 1_000)
    forceKillTimer.unref?.()

    child.once("exit", () => {
      clearTimeout(forceKillTimer)
      resolve()
    })

    child.kill("SIGTERM")
  })
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

    await fs.mkdir(path.join(projectDir, "src"), { recursive: true })
    await fs.writeFile(
      path.join(projectDir, "src", "lane-flow.txt"),
      "reviewable installed CLI lane flow\n",
      "utf8",
    )

    const updateResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "update",
        "--repo",
        projectDir,
        "--lane",
        "a",
        "--files",
        "src/",
        "--status",
        "needs-review",
        "--actor",
        "GPT-5 Codex",
        "--base",
        "HEAD",
        "--preflight",
        "--changed",
        "src/lane-flow.txt - reviewable change for installed CLI lane flow",
        "--verification",
        "node -e \"process.exit(0)\"",
        "--gap",
        "Did not rerun manual smoke validation.",
        "--why",
        "Exercises the installed CLI needs-review transition with real reviewer context.",
        "--review-ask",
        "Confirm the installed CLI writes the structured reviewer context fields.",
      ],
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

  it("embeds client-side status mappings for dashboard rendering", async () => {
    const projectDir = await createProjectRepo(installState.btrainBin)
    cleanupDirs.push(projectDir)

    const setAgentsResult = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      ["agents", "set", "--repo", projectDir, "--agent", "WriterBot", "--agent", "ReviewerBot"],
    )
    assert.equal(setAgentsResult.code, 0, setAgentsResult.stderr)

    await fs.mkdir(path.join(projectDir, "src"), { recursive: true })
    await fs.writeFile(path.join(projectDir, "src", "alpha.js"), "export const alpha = true;\n", "utf8")
    await fs.writeFile(path.join(projectDir, "src", "beta.js"), "export const beta = true;\n", "utf8")

    const claimLaneA = await runInstalledBtrain(
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
        "Dashboard smoke changes-requested",
        "--owner",
        "WriterBot",
        "--reviewer",
        "ReviewerBot",
        "--files",
        "src/alpha.js",
      ],
      { BTRAIN_AGENT: "WriterBot" },
    )
    assert.equal(claimLaneA.code, 0, claimLaneA.stderr)

    const claimLaneB = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "claim",
        "--repo",
        projectDir,
        "--lane",
        "b",
        "--task",
        "Dashboard smoke repair-needed",
        "--owner",
        "WriterBot",
        "--reviewer",
        "ReviewerBot",
        "--files",
        "src/beta.js",
      ],
      { BTRAIN_AGENT: "WriterBot" },
    )
    assert.equal(claimLaneB.code, 0, claimLaneB.stderr)

    const needsReview = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "update",
        "--repo",
        projectDir,
        "--lane",
        "a",
        "--files",
        "src/alpha.js",
        "--status",
        "needs-review",
        "--actor",
        "WriterBot",
        "--base",
        "HEAD",
        "--preflight",
        "--changed",
        "src/alpha.js - smoke lane for dashboard changes-requested rendering",
        "--verification",
        "node -e \"process.exit(0)\"",
        "--gap",
        "Synthetic dashboard regression test only.",
        "--why",
        "Need a real changes-requested status for dashboard coverage.",
        "--review-ask",
        "Return this lane to the writer so the dashboard renders requested changes.",
      ],
      { BTRAIN_AGENT: "WriterBot" },
    )
    assert.equal(needsReview.code, 0, needsReview.stderr)

    const requestChanges = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "request-changes",
        "--repo",
        projectDir,
        "--lane",
        "a",
        "--summary",
        "Synthetic reviewer bounce for dashboard rendering coverage.",
        "--reason-code",
        "missing-verification",
        "--reason-tag",
        "dashboard-test",
        "--actor",
        "ReviewerBot",
      ],
      { BTRAIN_AGENT: "ReviewerBot" },
    )
    assert.equal(requestChanges.code, 0, requestChanges.stderr)

    const repairNeeded = await runInstalledBtrain(
      installState.btrainBin,
      projectDir,
      [
        "handoff",
        "update",
        "--repo",
        projectDir,
        "--lane",
        "b",
        "--files",
        "src/beta.js",
        "--status",
        "repair-needed",
        "--reason-code",
        "invalid-handoff",
        "--reason-tag",
        "dashboard-test",
        "--actor",
        "ReviewerBot",
      ],
      { BTRAIN_AGENT: "ReviewerBot" },
    )
    assert.equal(repairNeeded.code, 0, repairNeeded.stderr)

    const port = await getAvailablePort()
    const server = startDashboardServer(projectDir, installState.btrainBin, port)

    try {
      const statusResponse = await waitForUrl(`http://127.0.0.1:${port}/api/status`)
      const statusPayload = await statusResponse.json()
      const laneA = statusPayload.lanes.find((lane) => lane.id === "a")
      const laneB = statusPayload.lanes.find((lane) => lane.id === "b")
      assert.equal(laneA?.status, "changes-requested", JSON.stringify(statusPayload))
      assert.equal(laneA?.hotSeat, "WriterBot", JSON.stringify(statusPayload))
      assert.equal(laneB?.status, "repair-needed", JSON.stringify(statusPayload))
      assert.equal(laneB?.repairOwner, "WriterBot", JSON.stringify(statusPayload))
      assert.equal(laneB?.hotSeat, "WriterBot", JSON.stringify(statusPayload))

      const htmlResponse = await waitForUrl(`http://127.0.0.1:${port}/`)
      const html = await htmlResponse.text()
      assert.ok(html.includes("const statusClassNames = {"), html)
      assert.ok(html.includes('"changes-requested":"status-changes-requested"'), html)
      assert.ok(html.includes('"repair-needed":"status-repair-needed"'), html)
      assert.ok(html.includes("--repair-needed-tape: repeating-linear-gradient("), html)
      assert.ok(html.includes("return statusClassNames[status] || '';"), html)
      assert.ok(!html.includes("return STATUS_CLASS_NAMES[status] || '';"), html)
    } finally {
      await stopDashboardServer(server)
    }
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
