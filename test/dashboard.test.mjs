import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import {
  ensureDashboard,
  findAvailableDashboardPort,
  getDashboardStatus,
  shouldAutoStartDashboard,
  stopDashboard,
} from "../src/brain_train/dashboard.mjs"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cleanupRepos = []

async function createDashboardRepo(sharedHome) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-dashboard-"))
  const env = {
    ...process.env,
    BRAIN_TRAIN_HOME: sharedHome || path.join(repoRoot, "global-home"),
  }
  cleanupRepos.push({ repoRoot, env })
  await fs.mkdir(path.join(repoRoot, ".btrain"), { recursive: true })
  await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true })
  await fs.copyFile(
    path.join(REPO_ROOT, "scripts", "serve-dashboard.js"),
    path.join(repoRoot, "scripts", "serve-dashboard.js"),
  )
  return { repoRoot, env }
}

afterEach(async () => {
  for (const { repoRoot, env } of cleanupRepos.splice(0)) {
    await stopDashboard(repoRoot, { env }).catch(() => {})
    await fs.rm(repoRoot, { recursive: true, force: true })
  }
})

describe("dashboard lifecycle", () => {
  it("auto-starts for interactive handoffs with environment overrides", () => {
    assert.equal(shouldAutoStartDashboard({ env: {}, isTTY: true }), true)
    assert.equal(shouldAutoStartDashboard({ env: {}, isTTY: false }), false)
    assert.equal(shouldAutoStartDashboard({ env: { BTRAIN_DASHBOARD_AUTO_OPEN: "true" }, isTTY: false }), true)
    assert.equal(shouldAutoStartDashboard({ env: { BTRAIN_DASHBOARD_AUTO_OPEN: "false" }, isTTY: true }), false)
    assert.equal(shouldAutoStartDashboard({ env: { CI: "true" }, isTTY: true }), false)
    assert.equal(shouldAutoStartDashboard({ env: { CI: "false" }, isTTY: true }), true)
  })

  it("starts and opens once, then reuses the global dashboard across repos", async () => {
    const firstRepo = await createDashboardRepo()
    const secondRepo = await createDashboardRepo(firstRepo.env.BRAIN_TRAIN_HOME)
    const port = await findAvailableDashboardPort(3400)
    const openedUrls = []

    const first = await ensureDashboard(firstRepo.repoRoot, {
      env: firstRepo.env,
      port,
      openUrlImpl: async (url) => openedUrls.push(url),
    })
    assert.equal(first.running, true)
    assert.equal(first.started, true)
    assert.equal(first.browserOpened, true)
    assert.deepEqual(openedUrls, [first.url])

    const second = await ensureDashboard(secondRepo.repoRoot, {
      env: secondRepo.env,
      port,
      openUrlImpl: async (url) => openedUrls.push(url),
    })
    assert.equal(second.running, true)
    assert.equal(second.started, false)
    assert.equal(second.browserOpened, false)
    assert.equal(second.pid, first.pid)
    assert.deepEqual(openedUrls, [first.url])

    const status = await getDashboardStatus(secondRepo.repoRoot, { env: secondRepo.env })
    assert.equal(status.running, true)
    assert.equal(status.url, first.url)
    assert.equal(status.state.scope, "global")
  })

  it("supports an explicit environment opt-out", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const disabledEnv = { ...env, BTRAIN_DASHBOARD_DISABLED: "true" }
    const result = await ensureDashboard(repoRoot, {
      env: disabledEnv,
    })
    assert.deepEqual(result, { running: false, disabled: true })
    assert.equal((await getDashboardStatus(repoRoot, { env: disabledEnv })).running, false)
  })

  it("migrates a repo-owned dashboard into the shared process", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3450)
    const legacySource = [
      "const http = require('node:http')",
      "const port = Number(process.env.PORT)",
      "http.createServer((req, res) => {",
      "  res.writeHead(200, { 'Content-Type': 'application/json' })",
      "  res.end(JSON.stringify({ ok: true, repo: process.cwd(), port }))",
      "}).listen(port, '127.0.0.1')",
    ].join("\n")
    const legacy = spawn(process.execPath, ["-e", legacySource], {
      cwd: repoRoot,
      env: { ...env, PORT: String(port) },
      stdio: "ignore",
    })

    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
            break
          }
        } catch {}
        await delay(50)
      }
      const legacyStatePath = path.join(repoRoot, ".btrain", "dashboard.json")
      await fs.writeFile(legacyStatePath, JSON.stringify({ pid: legacy.pid, port, repo: repoRoot }), "utf8")

      const started = await ensureDashboard(repoRoot, { env, port, openBrowser: false })
      assert.equal(started.running, true)
      assert.equal(started.port, port)
      assert.notEqual(started.pid, legacy.pid)
      await assert.rejects(fs.access(legacyStatePath), { code: "ENOENT" })
    } finally {
      legacy.kill("SIGKILL")
    }
  })

  it("stops the shared dashboard from any repo", async () => {
    const firstRepo = await createDashboardRepo()
    const secondRepo = await createDashboardRepo(firstRepo.env.BRAIN_TRAIN_HOME)
    const port = await findAvailableDashboardPort(3425)
    const started = await ensureDashboard(firstRepo.repoRoot, {
      env: firstRepo.env,
      port,
      openBrowser: false,
    })

    const stopped = await stopDashboard(secondRepo.repoRoot, { env: secondRepo.env })
    assert.equal(stopped.stopped, true)
    assert.equal(stopped.pid, started.pid)
    assert.equal((await getDashboardStatus(firstRepo.repoRoot, { env: firstRepo.env })).running, false)
  })
})
