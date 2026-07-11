import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import {
  ensureDashboard,
  findAvailableDashboardPort,
  getDashboardStatus,
  shouldAutoStartDashboard,
  stopDashboard,
} from "../src/brain_train/dashboard.mjs"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cleanupRepos = []

async function createDashboardRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-dashboard-"))
  cleanupRepos.push(repoRoot)
  await fs.mkdir(path.join(repoRoot, ".btrain"), { recursive: true })
  await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true })
  await fs.copyFile(
    path.join(REPO_ROOT, "scripts", "serve-dashboard.js"),
    path.join(repoRoot, "scripts", "serve-dashboard.js"),
  )
  return repoRoot
}

afterEach(async () => {
  for (const repoRoot of cleanupRepos.splice(0)) {
    await stopDashboard(repoRoot).catch(() => {})
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

  it("starts and opens once, then reuses the healthy repo dashboard", async () => {
    const repoRoot = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3400)
    const openedUrls = []

    const first = await ensureDashboard(repoRoot, {
      port,
      openUrlImpl: async (url) => openedUrls.push(url),
    })
    assert.equal(first.running, true)
    assert.equal(first.started, true)
    assert.equal(first.browserOpened, true)
    assert.deepEqual(openedUrls, [first.url])

    const second = await ensureDashboard(repoRoot, {
      port,
      openUrlImpl: async (url) => openedUrls.push(url),
    })
    assert.equal(second.running, true)
    assert.equal(second.started, false)
    assert.equal(second.browserOpened, false)
    assert.equal(second.pid, first.pid)
    assert.deepEqual(openedUrls, [first.url])

    const status = await getDashboardStatus(repoRoot)
    assert.equal(status.running, true)
    assert.equal(status.url, first.url)
  })

  it("supports an explicit environment opt-out", async () => {
    const repoRoot = await createDashboardRepo()
    const result = await ensureDashboard(repoRoot, {
      env: { ...process.env, BTRAIN_DASHBOARD_DISABLED: "true" },
    })
    assert.deepEqual(result, { running: false, disabled: true })
    assert.equal((await getDashboardStatus(repoRoot)).running, false)
  })

  it("stops only the dashboard recorded for this repo", async () => {
    const repoRoot = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3425)
    const started = await ensureDashboard(repoRoot, { port, openBrowser: false })

    const stopped = await stopDashboard(repoRoot)
    assert.equal(stopped.stopped, true)
    assert.equal(stopped.pid, started.pid)
    assert.equal((await getDashboardStatus(repoRoot)).running, false)
  })
})
