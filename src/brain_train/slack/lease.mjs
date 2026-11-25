// Spec 025 FR-11 and the plan's "listen.lock", "listen.stop", and
// "listen.paused" (WS2 step 4, task T014): the listener lease and its two
// flag files, all in `<btrain home>/slack/`. Imports nothing from core.mjs:
// the caller passes the slack directory, which `BRAIN_TRAIN_HOME` moves.
//
// The lease is the spec 024 delivery lock (`lock.mjs`) at another path: a
// lease touched within the last 60 seconds is live, and an older one is
// taken over. Its content is a JSON record of a random nonce, the process
// ID, the operator ID, and the start time, so a refused listener can name
// the holder. That whole record is the lock's nonce: ownership is "the file
// still holds my record".
//
// - The holder touches the lease on a 15-second timer for as long as it
//   runs, so a cycle that waits out a Retry-After never looks dead.
// - A timer does not run while the process is suspended, so the listener
//   also checks `isMineSync()` as `writeInbox`'s `beforeRename`: synchronous
//   calls, no await between that read and the rename.
//
// The flags hold no content. Nothing from Slack is written here.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { tryAcquireLock } from "./lock.mjs"

export const LEASE_FILE = "listen.lock"
export const STOP_FILE = "listen.stop"
export const PAUSE_FILE = "listen.paused"
export const LEASE_TOUCH_MS = 15_000

export function leasePath(slackDir) {
  return path.join(slackDir, LEASE_FILE)
}

function holderOf(content) {
  let record
  try {
    record = JSON.parse(content)
  } catch {
    record = null
  }
  if (!record || typeof record !== "object") return { pid: null, operator: "", startedAt: "" }
  return {
    pid: Number.isInteger(record.pid) ? record.pid : null,
    operator: typeof record.operator === "string" ? record.operator : "",
    startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
  }
}

/**
 * The holder named in the lease file: `{ pid, operator, startedAt }`, with
 * empty fields for a file in another format, or null when there is no lease.
 */
export function readLeaseHolder(slackDir) {
  let content
  try {
    content = fs.readFileSync(leasePath(slackDir), "utf8")
  } catch {
    return null
  }
  return holderOf(content)
}

/**
 * Take the listener lease. Returns `{ lease, reason, holder }`:
 *   lease   a handle, or null when the lease is not taken
 *   reason  `acquired`, `taken-over`, `held`, or `remove-failed` (lock.mjs)
 *   holder  for a refusal, who holds the lease (null if it vanished meanwhile)
 *
 * The handle has `path`, `holder`, `touch()`, `release()`, and
 * `isMineSync()`. An empty operator is refused: the listener does not start
 * without one.
 */
export async function takeLease(slackDir, { operator, pid = process.pid, now = Date.now } = {}) {
  if (typeof operator !== "string" || operator.trim() === "") {
    throw new TypeError("The listener lease needs the operator's Slack user ID.")
  }
  const startedAt = new Date(now()).toISOString()
  const content = JSON.stringify({ nonce: randomUUID(), pid, operator, startedAt })
  const target = leasePath(slackDir)
  const { lock, reason } = await tryAcquireLock(target, { now, nonce: content })
  if (!lock) return { lease: null, reason, holder: readLeaseHolder(slackDir) }
  const lease = {
    path: target,
    holder: { pid, operator, startedAt },
    touch: () => lock.touch(),
    release: () => lock.release(),
    /** True while the lease file still holds this holder's record. Synchronous. */
    isMineSync() {
      try {
        return fs.readFileSync(target, "utf8") === content
      } catch {
        return false
      }
    },
  }
  return { lease, reason, holder: lease.holder }
}

/**
 * Touch the lease every 15 seconds. The timer does not keep the process
 * alive. When a touch finds the lease is no longer this holder's, the timer
 * stops and `onLost` runs once. Returns a function that stops the timer.
 */
export function startLeaseTimer(lease, {
  intervalMs = LEASE_TOUCH_MS,
  onLost = () => {},
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval,
} = {}) {
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    cancel(handle)
  }
  const handle = schedule(async () => {
    if (stopped) return
    if (!(await lease.touch())) {
      stop()
      onLost()
    }
  }, intervalMs)
  handle?.unref?.()
  return stop
}

async function writeFlag(slackDir, name) {
  await fsp.mkdir(slackDir, { recursive: true, mode: 0o700 })
  const target = path.join(slackDir, name)
  await fsp.writeFile(target, "", { mode: 0o600 })
  // The mode given to open is masked by the umask; set it outright.
  await fsp.chmod(target, 0o600)
}

async function flagExists(slackDir, name) {
  try {
    await fsp.access(path.join(slackDir, name))
    return true
  } catch {
    return false
  }
}

/** Remove a flag. True when this call removed it. */
async function removeFlag(slackDir, name) {
  try {
    await fsp.unlink(path.join(slackDir, name))
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

/** `btrain slack listen --stop` writes the stop flag. */
export function requestStop(slackDir) {
  return writeFlag(slackDir, STOP_FILE)
}

export function stopRequested(slackDir) {
  return flagExists(slackDir, STOP_FILE)
}

/** The listener removes the stop flag when it sees it. True when it was set. */
export function consumeStop(slackDir) {
  return removeFlag(slackDir, STOP_FILE)
}

/** The listener writes the pause flag when the operator types `pause`. */
export function setPaused(slackDir) {
  return writeFlag(slackDir, PAUSE_FILE)
}

export function isPaused(slackDir) {
  return flagExists(slackDir, PAUSE_FILE)
}

/** `btrain slack listen --resume` removes the pause flag. True when it was set. */
export function clearPaused(slackDir) {
  return removeFlag(slackDir, PAUSE_FILE)
}
