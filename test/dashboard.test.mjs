import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import {
  ensureDashboard,
  findAvailableDashboardPort,
  getDashboardStatus,
  shouldAutoStartDashboard,
  stopDashboard,
} from "../src/brain_train/dashboard.mjs"

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cleanupRepos = []

function dashboardStateFile(env) {
  return path.join(env.BRAIN_TRAIN_HOME, "dashboard.json")
}

async function stateFileExists(env) {
  return fs.access(dashboardStateFile(env)).then(() => true, () => false)
}

async function writeRecordedDashboard(env, state) {
  await fs.mkdir(env.BRAIN_TRAIN_HOME, { recursive: true })
  await fs.writeFile(dashboardStateFile(env), JSON.stringify(state), "utf8")
}

async function exitedChild(signal) {
  const child = spawn(process.execPath, ["-e", signal ? "setInterval(() => {}, 1000)" : "process.exit(3)"], { stdio: "ignore" })
  if (signal) {
    await new Promise((resolve) => child.once("spawn", resolve))
    child.kill(signal)
  }
  await new Promise((resolve) => child.once("exit", resolve))
  return child
}

const unhealthyFetch = () => Promise.reject(new Error("connection refused"))
const healthyResponse = { ok: true, json: async () => ({ ok: true, scope: "global" }) }

// Resolve with the elapsed ms, or reject once the guard passes, so a stop
// that never returns fails the test instead of hanging it.
async function timed(promise, guardMs) {
  const started = Date.now()
  let timer
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`did not return within ${guardMs}ms`)), guardMs)
  })
  try {
    const value = await Promise.race([promise, guard])
    return { value, elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

async function createDashboardRepo(sharedHome) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-dashboard-"))
  const env = {
    ...withoutLaneScope(),
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

  it("keeps the legacy port when the legacy dashboard is slow to exit", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3475)
    // Exits 1.5 s after SIGTERM: longer than the old 1 s wait for the port,
    // after which ensureDashboard silently moved to the next port.
    const legacySource = [
      "const http = require('node:http')",
      "const port = Number(process.env.PORT)",
      "const server = http.createServer((req, res) => {",
      "  res.writeHead(200, { 'Content-Type': 'application/json' })",
      "  res.end(JSON.stringify({ ok: true, repo: process.cwd(), port }))",
      "}).listen(port, '127.0.0.1', () => process.stdout.write('listening\\n'))",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500))",
    ].join("\n")
    const legacy = spawn(process.execPath, ["-e", legacySource], {
      cwd: repoRoot,
      env: { ...env, PORT: String(port) },
      stdio: ["ignore", "pipe", "ignore"],
    })
    try {
      await new Promise((resolve, reject) => {
        legacy.stdout.once("data", resolve)
        legacy.once("exit", () => reject(new Error("legacy dashboard exited before listening")))
      })
      await fs.writeFile(path.join(repoRoot, ".btrain", "dashboard.json"), JSON.stringify({ pid: legacy.pid, port, repo: repoRoot }), "utf8")

      const started = await ensureDashboard(repoRoot, { env, port, openBrowser: false })
      assert.equal(started.running, true)
      assert.equal(started.port, port)
    } finally {
      legacy.kill("SIGKILL")
    }
  })

  it("fails fast when the dashboard process exits during startup", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3500)
    const started = Date.now()
    await assert.rejects(
      ensureDashboard(repoRoot, {
        env,
        port,
        openBrowser: false,
        spawnImpl: (command, args, options) => spawn(process.execPath, ["-e", "process.exit(3)"], options),
      }),
      /Dashboard exited with code 3 before it became healthy/,
    )
    assert.ok(Date.now() - started < 4000, "a dead dashboard must not use the whole startup budget")
    assert.equal((await getDashboardStatus(repoRoot, { env })).running, false)
    assert.equal(await stateFileExists(env), false, "a failed startup must remove its dashboard state")
  })

  it("rejects a dead child even when another server answers health on its port", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3650)
    const child = await exitedChild()
    // A competing server binds the selected port after the dead child was
    // spawned; its health answer must not count as this child's startup.
    const other = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ ok: true, scope: "global" }))
    })
    try {
      await assert.rejects(
        ensureDashboard(repoRoot, {
          env,
          port,
          openBrowser: false,
          spawnImpl: () => {
            other.listen(port, "127.0.0.1")
            return child
          },
        }),
        /Dashboard exited with code 3 before it became healthy/,
      )
      assert.equal(await stateFileExists(env), false, "a failed startup must remove its dashboard state")
    } finally {
      await new Promise((resolve) => other.close(resolve))
    }
  })

  it("names the signal when the dashboard was killed before startup is watched", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3675)
    const child = await exitedChild("SIGTERM")
    const started = Date.now()
    await assert.rejects(
      ensureDashboard(repoRoot, { env, port, openBrowser: false, spawnImpl: () => child }),
      /Dashboard exited with signal SIGTERM before it became healthy/,
    )
    assert.ok(Date.now() - started < 4000, "a killed dashboard must not use the whole startup budget")
    assert.equal(await stateFileExists(env), false, "a failed startup must remove its dashboard state")
  })

  it("fails fast when the dashboard process exited before startup is watched", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3550)
    // The child has exited, and its exit event has already been emitted,
    // before ensureDashboard starts waiting: a missed event must not cost the
    // whole startup budget.
    const exited = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" })
    await new Promise((resolve) => exited.once("exit", resolve))
    const started = Date.now()
    await assert.rejects(
      ensureDashboard(repoRoot, {
        env,
        port,
        openBrowser: false,
        spawnImpl: () => exited,
      }),
      /Dashboard exited with code 3 before it became healthy/,
    )
    assert.ok(Date.now() - started < 4000, "an already-exited dashboard must not use the whole startup budget")
    assert.equal((await getDashboardStatus(repoRoot, { env })).running, false)
  })

  it("stops a dashboard child that never becomes healthy once startup gives up", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3725)
    let child
    try {
      // Alive for the whole startup budget, but never listening.
      const { elapsedMs } = await timed(assert.rejects(
        ensureDashboard(repoRoot, {
          env,
          port,
          openBrowser: false,
          spawnImpl: (command, args, options) => {
            child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)
            return child
          },
        }),
        /Dashboard did not become healthy/,
      ), 25_000)
      assert.ok(elapsedMs >= 14_000, `startup gave up after ${elapsedMs}ms, before its cap`)
      assert.equal(await stateFileExists(env), false, "a failed startup must remove its dashboard state")
      const exited = child.exitCode !== null || child.signalCode !== null
        || await timed(new Promise((resolve) => child.once("exit", resolve)), 5000).then(() => true, () => false)
      assert.ok(exited, "a dashboard child that never became healthy must be stopped")
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  })

  it("waits for a dashboard that is slow to start but still running", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3525)
    // Answers health checks only after 6 s, past the old 5 s budget.
    const result = await ensureDashboard(repoRoot, {
      env,
      port,
      openBrowser: false,
      spawnImpl: (command, args, options) => spawn(
        process.execPath,
        ["-e", `setTimeout(() => require(${JSON.stringify(args[0])}), 6000)`],
        options,
      ),
    })
    assert.equal(result.running, true)
    assert.equal(result.port, port)
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

  it("stops a running dashboard whose first health probe times out", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const port = await findAvailableDashboardPort(3575)
    const started = await ensureDashboard(repoRoot, { env, port, openBrowser: false })
    // On a loaded machine one health probe can miss its 750 ms budget. That
    // alone must not make stop forget a dashboard that is still running.
    let probes = 0
    const slowOnce = (url, options) => {
      probes += 1
      if (probes === 1) {
        return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      }
      return fetch(url, options)
    }
    try {
      const stopped = await stopDashboard(repoRoot, { env, fetchImpl: slowOnce })
      assert.equal(stopped.stopped, true)
      assert.equal(stopped.pid, started.pid)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        try { process.kill(started.pid, 0) } catch (error) { if (error.code === "ESRCH") break; throw error }
        await delay(50)
      }
      assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" }, "the dashboard process must be stopped")
    } finally {
      // A stop that forgot the dashboard leaves it running; stop it here, but
      // only while that PID is still this test's dashboard server.
      const { stdout } = await execFileAsync("/bin/ps", ["-o", "args=", "-p", String(started.pid)]).catch(() => ({ stdout: "" }))
      if (stdout.includes("serve-dashboard.js")) {
        try { process.kill(started.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
      }
    }
  })

  it("stops promptly when the recorded dashboard has no PID", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    await writeRecordedDashboard(env, { pid: 0, port: 3700 })
    const { value, elapsedMs } = await timed(stopDashboard(repoRoot, { env, fetchImpl: unhealthyFetch }), 8000)
    assert.equal(value.stopped, false)
    assert.ok(elapsedMs < 2000, `stop waited ${elapsedMs}ms for a dashboard with no PID`)
  })

  it("stops promptly when the recorded dashboard process has exited", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    const child = await exitedChild()
    await writeRecordedDashboard(env, { pid: child.pid, port: 3700 })
    const { value, elapsedMs } = await timed(stopDashboard(repoRoot, { env, fetchImpl: unhealthyFetch }), 8000)
    assert.equal(value.stopped, false)
    assert.ok(elapsedMs < 2000, `stop waited ${elapsedMs}ms for a dashboard that had exited`)
  })

  it("gives up at the probe cap on a live process that never answers", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    // A live process that is never signalled, because no probe succeeds.
    // Killing it afterwards also ends a stop loop that ignored the cap.
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    await new Promise((resolve) => live.once("spawn", resolve))
    try {
      await writeRecordedDashboard(env, { pid: live.pid, port: 3700 })
      const { value, elapsedMs } = await timed(stopDashboard(repoRoot, { env, fetchImpl: unhealthyFetch }), 8000)
      assert.equal(value.stopped, false)
      assert.ok(elapsedMs >= 4500, `stop gave up after ${elapsedMs}ms, before the probe cap`)
      assert.equal(await stateFileExists(env), false)
    } finally {
      live.kill("SIGKILL")
    }
  })

  it("treats a process it may not signal (EPERM) as alive and keeps probing", async () => {
    const { repoRoot, env } = await createDashboardRepo()
    await writeRecordedDashboard(env, { pid: 999_999, port: 3700 })
    const originalKill = process.kill
    const sent = []
    process.kill = (pid, signal) => {
      if (pid !== 999_999) return originalKill.call(process, pid, signal)
      sent.push(signal)
      if (signal === 0) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      return true
    }
    let probes = 0
    const answersSecond = async () => {
      probes += 1
      if (probes === 1) throw new Error("timed out")
      return healthyResponse
    }
    try {
      const { value } = await timed(stopDashboard(repoRoot, { env, fetchImpl: answersSecond }), 8000)
      assert.equal(value.stopped, true)
      assert.equal(probes, 2)
      assert.deepEqual(sent, [0, "SIGTERM"])
    } finally {
      process.kill = originalKill
    }
  })
})
