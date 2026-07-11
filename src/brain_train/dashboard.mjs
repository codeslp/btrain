import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const DEFAULT_DASHBOARD_PORT = 3333
const DASHBOARD_HOST = "127.0.0.1"
const DASHBOARD_STATE_FILENAME = "dashboard.json"
const DASHBOARD_LOG_FILENAME = "dashboard.log"
const TRUE_VALUES = new Set(["1", "true", "yes"])
const FALSE_VALUES = new Set(["0", "false", "no"])

function statePath(repoRoot) {
  return path.join(repoRoot, ".btrain", DASHBOARD_STATE_FILENAME)
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

async function readDashboardState(repoRoot) {
  try {
    return JSON.parse(await fs.readFile(statePath(repoRoot), "utf8"))
  } catch {
    return null
  }
}

async function writeDashboardState(repoRoot, state) {
  const btrainDir = path.join(repoRoot, ".btrain")
  const target = statePath(repoRoot)
  const temporary = `${target}.${process.pid}.tmp`
  await fs.mkdir(btrainDir, { recursive: true })
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await fs.rename(temporary, target)
}

async function removeDashboardState(repoRoot) {
  await fs.rm(statePath(repoRoot), { force: true })
}

async function probeDashboard(repoRoot, port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${dashboardUrl(port)}/api/health`, {
      signal: AbortSignal.timeout(750),
    })
    if (!response.ok) {
      return false
    }
    const payload = await response.json()
    return payload.ok === true
      && await normalizedPath(payload.repo) === await normalizedPath(repoRoot)
  } catch {
    return false
  }
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

async function waitForDashboard(repoRoot, port, fetchImpl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await probeDashboard(repoRoot, port, fetchImpl)) {
      return true
    }
    await delay(100)
  }
  return false
}

async function getDashboardStatus(repoRoot, { fetchImpl = fetch } = {}) {
  const state = await readDashboardState(repoRoot)
  if (!state?.port || !await probeDashboard(repoRoot, state.port, fetchImpl)) {
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

  const existing = await getDashboardStatus(repoRoot, { fetchImpl })
  if (existing.running) {
    return { ...existing, started: false, browserOpened: false }
  }

  const script = path.join(repoRoot, "scripts", "serve-dashboard.js")
  await fs.access(script)
  const selectedPort = await findAvailableDashboardPort(configuredPort(port, env))
  const logPath = path.join(repoRoot, ".btrain", DASHBOARD_LOG_FILENAME)
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
    pid: child.pid,
    port: selectedPort,
    repo: await normalizedPath(repoRoot),
    startedAt: new Date().toISOString(),
  }
  await writeDashboardState(repoRoot, state)

  if (!await waitForDashboard(repoRoot, selectedPort, fetchImpl)) {
    try {
      process.kill(child.pid, "SIGTERM")
    } catch {}
    await removeDashboardState(repoRoot)
    throw new Error(`Dashboard did not become healthy. See ${logPath}.`)
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

async function stopDashboard(repoRoot, { fetchImpl = fetch } = {}) {
  const state = await readDashboardState(repoRoot)
  if (!state) {
    return { stopped: false, reason: "not-running" }
  }

  const ownsProcess = state.port && await probeDashboard(repoRoot, state.port, fetchImpl)
  if (ownsProcess && state.pid) {
    try {
      process.kill(state.pid, "SIGTERM")
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error
      }
    }
  }
  await removeDashboardState(repoRoot)
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
