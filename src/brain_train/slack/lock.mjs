// Spec 024 FR-4 and the plan's "The delivery lock": one process delivers at a
// time, and a process that finds the lock never waits.
//
// - The lock is created with an exclusive open, holding a random nonce.
// - A lock touched within the last 60 seconds is live: another process skips
//   delivery and returns. An older one is taken over: removed, then created
//   again. If the removal fails, the process skips.
// - The holder touches the lock before every Slack call, so a long flush never
//   looks abandoned, and reads the nonce back before every send, stopping when
//   it is no longer its own. Two processes can both judge one lock stale; the
//   one whose lock was replaced stops at its next send.
//
// The lock's path is an argument, so the spec 025 listener can use its own
// lock with the same rules (plan, "Modules"). Imports nothing from core.mjs.

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export const LOCK_STALE_MS = 60_000

async function createLock(lockPath, nonce) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  let handle
  try {
    handle = await fs.open(lockPath, "wx", 0o600)
  } catch (error) {
    if (error.code === "EEXIST") return false
    throw error
  }
  try {
    await handle.writeFile(nonce, "utf8")
  } finally {
    await handle.close()
  }
  return true
}

async function readNonce(lockPath) {
  try {
    return await fs.readFile(lockPath, "utf8")
  } catch {
    return null
  }
}

/**
 * Try to take the lock at `lockPath`. Returns a handle, or `null` when a live
 * lock is held by another process or a stale one could not be removed.
 * `tryAcquireLock` also says which.
 */
export async function acquireLock(lockPath, options = {}) {
  const result = await tryAcquireLock(lockPath, options)
  return result.lock
}

/**
 * Like `acquireLock`, with the reason for a miss: `{ lock, reason }`, where
 * `reason` is `acquired`, `taken-over`, `held`, or `remove-failed`.
 */
export async function tryAcquireLock(lockPath, { now = Date.now, staleMs = LOCK_STALE_MS } = {}) {
  const nonce = randomUUID()
  if (await createLock(lockPath, nonce)) {
    return { lock: makeHandle(lockPath, nonce, now), reason: "acquired" }
  }
  let stat
  try {
    stat = await fs.stat(lockPath)
  } catch (error) {
    // Released between our create and our stat: one more try, never a wait.
    if (error.code === "ENOENT" && (await createLock(lockPath, nonce))) {
      return { lock: makeHandle(lockPath, nonce, now), reason: "acquired" }
    }
    return { lock: null, reason: "held" }
  }
  if (now() - stat.mtimeMs < staleMs) {
    return { lock: null, reason: "held" }
  }
  try {
    await fs.unlink(lockPath)
  } catch (error) {
    if (error.code !== "ENOENT") return { lock: null, reason: "remove-failed" }
  }
  if (await createLock(lockPath, nonce)) {
    return { lock: makeHandle(lockPath, nonce, now), reason: "taken-over" }
  }
  return { lock: null, reason: "held" }
}

function makeHandle(lockPath, nonce, now) {
  return {
    path: lockPath,
    nonce,
    /** True while the lock file still holds this holder's nonce. */
    async stillMine() {
      return (await readNonce(lockPath)) === nonce
    },
    /**
     * Refresh the lock's modification time. Returns false, and touches
     * nothing, when the lock is no longer this holder's.
     */
    async touch() {
      if ((await readNonce(lockPath)) !== nonce) return false
      const at = new Date(now())
      try {
        await fs.utimes(lockPath, at, at)
        return true
      } catch {
        return false
      }
    },
    /** Remove the lock if it is still this holder's. Never throws. */
    async release() {
      try {
        if ((await readNonce(lockPath)) === nonce) await fs.unlink(lockPath)
      } catch {
        // Already gone, or taken over: nothing of ours to remove.
      }
    },
  }
}
