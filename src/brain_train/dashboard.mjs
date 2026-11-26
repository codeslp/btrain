import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { resolveStateRoot } from "./worktree.mjs"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const DEFAULT_DASHBOARD_PORT = 3333
const DASHBOARD_HOST = "127.0.0.1"
const DASHBOARD_STATE_FILENAME = "dashboard.json"
const DASHBOARD_LOG_FILENAME = "dashboard.log"
const TRUE_VALUES = new Set(["1", "true", "yes"])
const FALSE_VALUES = new Set(["0", "false", "no"])
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function dashboardHome(env = process.env) {
  return path.resolve(env.BRAIN_TRAIN_HOME || path.join(os.homedir(), ".btrain"))
}

function statePath(env) {
  return path.join(dashboardHome(env), DASHBOARD_STATE_FILENAME)
}

function legacyStatePath(repoRoot) {
  return path.join(resolveStateRoot(repoRoot), ".btrain", DASHBOARD_STATE_FILENAME)
}

function dashboardUrl(port) {
  return `http://${DASHBOARD_HOST}:${port}`
}

async function normalizedPath(value) {
  try {
    return await fs.realpath(value)
  } catch {
    return path.resolve(value)
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return null
  }
}

async function readDashboardState(env) {
  return readJson(statePath(env))
}

async function writeDashboardState(state, env) {
  const home = dashboardHome(env)
  const target = statePath(env)
  const temporary = `${target}.${process.pid}.tmp`
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await fs.rename(temporary, target)
}

async function removeDashboardState(env) {
  await fs.rm(statePath(env), { force: true })
}

async function fetchHealth(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${dashboardUrl(port)}/api/health`, {
      signal: AbortSignal.timeout(750),
    })
    if (!response.ok) {
      return null
    }
    return response.json()
  } catch {
    return null
  }
}

async function probeDashboard(port, fetchImpl = fetch) {
  const payload = await fetchHealth(port, fetchImpl)
  return payload?.ok === true && payload.scope === "global"
}

async function probeLegacyDashboard(repoRoot, port, fetchImpl = fetch) {
  const payload = await fetchHealth(port, fetchImpl)
  return payload?.ok === true
    && !payload.scope
    && payload.repo
    && await normalizedPath(payload.repo) === await normalizedPath(repoRoot)
}

function isProcessAlive(pid) {
  if (!pid) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

// One health probe can miss its 750 ms budget on a loaded machine. While the
// recorded process is still alive, keep asking; the cap only guards against a
// process that stays up without ever answering, which is then not ours to stop.
const DASHBOARD_PROBE_TIMEOUT_MS = 5_000

async function probeRecordedDashboard(state, fetchImpl) {
  const deadline = Date.now() + DASHBOARD_PROBE_TIMEOUT_MS
  while (true) {
    if (await probeDashboard(state.port, fetchImpl)) {
      return true
    }
    if (!isProcessAlive(state.pid) || Date.now() >= deadline) {
      return false
    }
    await delay(100)
  }
}

function terminateProcess(pid) {
  if (!pid) {
    return false
  }
  try {
    process.kill(pid, "SIGTERM")
    return true
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error
    }
    return false
  }
}

async function migrateLegacyDashboard(repoRoot, fetchImpl) {
  const legacyPath = legacyStatePath(repoRoot)
  const legacy = await readJson(legacyPath)
  if (!legacy) {
    return false
  }
  if (!legacy.port || !await probeLegacyDashboard(repoRoot, legacy.port, fetchImpl)) {
    await fs.rm(legacyPath, { force: true })
    return false
  }
  terminateProcess(legacy.pid)
  await fs.rm(legacyPath, { force: true })
  return true
}

async function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", () => resolve(false))
    server.listen(port, DASHBOARD_HOST, () => {
      server.close(() => resolve(true))
    })
  })
}

async function findAvailableDashboardPort(startPort = DEFAULT_DASHBOARD_PORT) {
  for (let port = startPort; port <= Math.min(startPort + 20, 65535); port += 1) {
    if (await canListen(port)) {
      return port
    }
  }
  throw new Error(`No dashboard port is available between ${startPort} and ${Math.min(startPort + 20, 65535)}.`)
}

// After a legacy dashboard is told to stop, its port frees when the process
// exits, which on a loaded machine can take well over a second. Wait for that
// rather than moving to another port; the cap only guards against a legacy
// process that never exits.
const LEGACY_PORT_RELEASE_TIMEOUT_MS = 10_000

async function waitForAvailablePort(startPort, timeoutMs = LEGACY_PORT_RELEASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canListen(startPort)) {
      return startPort
    }
    await delay(50)
  }
  return findAvailableDashboardPort(startPort)
}

async function openDashboardUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let command = "xdg-open"
  let args = [url]
  if (platform === "darwin") {
    command = "open"
  } else if (platform === "win32") {
    command = "cmd"
    args = ["/c", "start", "", url]
  }

  await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

function normalizedSetting(value) {
  return String(value || "").toLowerCase()
}

function dashboardDisabled(env) {
  return TRUE_VALUES.has(normalizedSetting(env.BTRAIN_DASHBOARD_DISABLED))
}

function shouldAutoStartDashboard({ env = process.env, isTTY = process.stdout.isTTY } = {}) {
  if (dashboardDisabled(env) || TRUE_VALUES.has(normalizedSetting(env.CI))) {
    return false
  }
  const setting = normalizedSetting(env.BTRAIN_DASHBOARD_AUTO_OPEN)
  if (FALSE_VALUES.has(setting)) {
    return false
  }
  if (TRUE_VALUES.has(setting)) {
    return true
  }
  return Boolean(isTTY)
}

function configuredPort(value, env) {
  const parsed = Number(value ?? env.BTRAIN_DASHBOARD_PORT ?? DEFAULT_DASHBOARD_PORT)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid dashboard port: ${value ?? env.BTRAIN_DASHBOARD_PORT}`)
  }
  return parsed
}

// A new dashboard is waited for until it answers or its process exits. The
// cap only guards against a process that stays up without ever answering; a
// slow start on a loaded machine is not a failure.
const DASHBOARD_START_TIMEOUT_MS = 15_000

async function waitForDashboard(port, fetchImpl, child) {
  // The child can exit while ensureDashboard is still writing its state, and
  // then its exit event has already been emitted. Read the recorded exit
  // first, and listen only for an exit that is still to come.
  let exit = null
  if (typeof child?.exitCode === "number" || typeof child?.signalCode === "string") {
    exit = { code: child.exitCode, signal: child.signalCode }
  } else {
    child?.once?.("exit", (code, signal) => {
      exit = { code, signal }
    })
  }
  const deadline = Date.now() + DASHBOARD_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const answered = await probeDashboard(port, fetchImpl)
    // An exit, including one during the probe, outranks a health answer:
    // once this child is gone, whatever answers on the port is not it.
    if (exit) {
      return { healthy: false, exit }
    }
    if (answered) {
      return { healthy: true }
    }
    await delay(100)
  }
  return { healthy: false, exit }
}

async function getDashboardStatus(repoRoot, { env = process.env, fetchImpl = fetch } = {}) {
  const state = await readDashboardState(env)
  if (!state?.port || !await probeDashboard(state.port, fetchImpl)) {
    return { running: false, state }
  }
  return {
    running: true,
    pid: state.pid,
    port: state.port,
    url: dashboardUrl(state.port),
    state,
  }
}

async function resolveDashboardScript(repoRoot) {
  const bundled = path.join(PACKAGE_ROOT, "scripts", "serve-dashboard.js")
  try {
    await fs.access(bundled)
    return bundled
  } catch {
    const local = path.join(repoRoot, "scripts", "serve-dashboard.js")
    await fs.access(local)
    return local
  }
}

async function ensureDashboard(repoRoot, {
  env = process.env,
  fetchImpl = fetch,
  openBrowser = true,
  openUrlImpl = openDashboardUrl,
  port,
  spawnImpl = spawn,
} = {}) {
  if (dashboardDisabled(env)) {
    return { running: false, disabled: true }
  }

  const existing = await getDashboardStatus(repoRoot, { env, fetchImpl })
  if (existing.running) {
    return { ...existing, started: false, browserOpened: false }
  }

  const preferredPort = configuredPort(port, env)
  const migratedLegacy = await migrateLegacyDashboard(repoRoot, fetchImpl)
  const selectedPort = migratedLegacy
    ? await waitForAvailablePort(preferredPort)
    : await findAvailableDashboardPort(preferredPort)
  const script = await resolveDashboardScript(repoRoot)
  const logPath = path.join(dashboardHome(env), DASHBOARD_LOG_FILENAME)
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const logHandle = await fs.open(logPath, "a")
  let child
  try {
    child = spawnImpl(process.execPath, [script], {
      cwd: repoRoot,
      detached: true,
      env: { ...env, PORT: String(selectedPort) },
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    })
    child.unref()
  } finally {
    await logHandle.close()
  }

  const state = {
    scope: "global",
    pid: child.pid,
    port: selectedPort,
    startedAt: new Date().toISOString(),
    startedByRepo: await normalizedPath(repoRoot),
  }
  await writeDashboardState(state, env)

  const startup = await waitForDashboard(selectedPort, fetchImpl, child)
  if (!startup.healthy) {
    if (!startup.exit) terminateProcess(child.pid)
    await removeDashboardState(env)
    let reason = "did not become healthy"
    if (startup.exit) {
      const how = startup.exit.signal ? `signal ${startup.exit.signal}` : `code ${startup.exit.code}`
      reason = `exited with ${how} before it became healthy`
    }
    throw new Error(`Dashboard ${reason}. See ${logPath}.`)
  }

  let browserOpened = false
  let browserError = ""
  if (openBrowser) {
    try {
      await openUrlImpl(dashboardUrl(selectedPort))
      browserOpened = true
    } catch (error) {
      browserError = error.message
    }
  }

  return {
    running: true,
    started: true,
    browserOpened,
    browserError,
    pid: child.pid,
    port: selectedPort,
    url: dashboardUrl(selectedPort),
    state,
  }
}

async function stopDashboard(repoRoot, { env = process.env, fetchImpl = fetch } = {}) {
  const state = await readDashboardState(env)
  if (!state) {
    const stoppedLegacy = await migrateLegacyDashboard(repoRoot, fetchImpl)
    return { stopped: stoppedLegacy, reason: stoppedLegacy ? "legacy" : "not-running" }
  }

  const ownsProcess = Boolean(state.port) && await probeRecordedDashboard(state, fetchImpl)
  if (ownsProcess) {
    terminateProcess(state.pid)
  }
  await removeDashboardState(env)
  return { stopped: ownsProcess, pid: state.pid, port: state.port }
}

export {
  DEFAULT_DASHBOARD_PORT,
  dashboardUrl,
  ensureDashboard,
  findAvailableDashboardPort,
  getDashboardStatus,
  openDashboardUrl,
  shouldAutoStartDashboard,
  stopDashboard,
}
