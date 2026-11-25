// Spec 023 implementation plan, "Request lock" (task T021): one heartbeat lock
// for each lane's review request, so one process at a time dispatches its
// reviewers. It is not lane state; removing the file loses nothing. The
// handoff lock, not this one, orders attempts against verdicts.
//
// The design is the spec 024 delivery lock's, with the same bounds:
// - exclusive create, with a random nonce written into the file;
// - a lock touched less than `staleMs` (60 s) ago is live, and a process that
//   finds one does not dispatch;
// - an older lock's holder is taken to be gone: the finder removes it and
//   creates its own, and skips if the removal fails;
// - the holder touches the file every `heartbeatMs` (15 s) for the whole life
//   of the loop, also while a runner is alive, so a long attempt never looks
//   abandoned;
// - the holder reads the nonce again before every dispatch and stops if it is
//   not its own. Two processes can both judge one lock stale; the second
//   removal then deletes the first one's new lock, and the nonce check ends
//   the first at its next dispatch.
//
// The lock path is an argument: `<state root>/.btrain/reviews/lane-<id>.lock`
// in production. No import of core.mjs.

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export const REQUEST_LOCK_STALE_MS = 60_000
export const REQUEST_LOCK_HEARTBEAT_MS = 15_000

async function readNonce(lockPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"))
    return typeof parsed?.nonce === "string" ? parsed.nonce : ""
  } catch {
    return ""
  }
}

async function createLock(lockPath, nonce, now) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const handle = await fs.open(lockPath, "wx")
  try {
    await handle.writeFile(`${JSON.stringify({ nonce, pid: process.pid, createdAt: new Date(now).toISOString() })}\n`, "utf8")
  } finally {
    await handle.close()
  }
}

/**
 * Try to take the request lock at `lockPath`.
 *
 * Returns `{ acquired: false, reason }` when a live lock is held by another
 * process (`live`), or when a stale lock could not be removed or another
 * process took it first (`contended`). Otherwise returns a holder:
 *
 *   { acquired: true, nonce, stillHeld(), touch(), release() }
 *
 * `stillHeld()` reads the nonce again; call it before every dispatch.
 * `release()` stops the heartbeat and removes the file only if it still holds
 * this holder's nonce.
 */
export async function acquireRequestLock(lockPath, {
  staleMs = REQUEST_LOCK_STALE_MS,
  heartbeatMs = REQUEST_LOCK_HEARTBEAT_MS,
  now = Date.now,
} = {}) {
  const nonce = randomUUID()
  try {
    await createLock(lockPath, nonce, now())
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    let stat
    try {
      stat = await fs.stat(lockPath)
    } catch (statError) {
      if (statError?.code !== "ENOENT") throw statError
      stat = null
    }
    if (stat && now() - stat.mtimeMs < staleMs) {
      return { acquired: false, reason: "live" }
    }
    try {
      await fs.rm(lockPath, { force: true })
      await createLock(lockPath, nonce, now())
    } catch {
      return { acquired: false, reason: "contended" }
    }
  }

  let released = false
  const touch = async () => {
    if (released) return false
    const date = new Date(now())
    try {
      await fs.utimes(lockPath, date, date)
      return true
    } catch {
      return false
    }
  }
  const timer = heartbeatMs > 0 ? setInterval(() => { void touch() }, heartbeatMs) : null
  timer?.unref?.()

  return {
    acquired: true,
    nonce,
    touch,
    async stillHeld() {
      if (released) return false
      return (await readNonce(lockPath)) === nonce
    },
    async release() {
      if (released) return
      released = true
      if (timer) clearInterval(timer)
      if ((await readNonce(lockPath)) === nonce) {
        await fs.rm(lockPath, { force: true })
      }
    },
  }
}
