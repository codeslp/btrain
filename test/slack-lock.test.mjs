// Spec 024 FR-4 and the plan's "The delivery lock" through
// src/brain_train/slack/lock.mjs (plan WS3, T012).
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LOCK_STALE_MS, tryAcquireLock } from "../src/brain_train/slack/lock.mjs"

const roots = []
after(async () => Promise.all(roots.map(async (root) => {
  await fs.chmod(root, 0o700).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})))

async function lockPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-lock-"))
  roots.push(root)
  return path.join(root, "slack", "delivery.lock")
}

async function age(target, ms) {
  const at = new Date(Date.now() - ms)
  await fs.utimes(target, at, at)
}

describe("delivery lock", () => {
  it("lets one process hold a fresh lock; a second skips at once", async () => {
    const target = await lockPath()
    const first = await tryAcquireLock(target)
    assert.equal(first.reason, "acquired")
    assert.ok(first.lock)
    const started = Date.now()
    const second = await tryAcquireLock(target)
    assert.deepEqual([second.lock, second.reason], [null, "held"])
    assert.ok(Date.now() - started < 500, "the second process does not wait")
    assert.equal(await first.lock.stillMine(), true)
    await first.lock.release()
    assert.equal((await tryAcquireLock(target)).reason, "acquired")
  })

  it("takes over a lock not touched for 60 seconds", async () => {
    const target = await lockPath()
    const first = await tryAcquireLock(target)
    await age(target, LOCK_STALE_MS + 1000)
    const second = await tryAcquireLock(target)
    assert.equal(second.reason, "taken-over")
    assert.equal(await second.lock.stillMine(), true)
    assert.equal(await first.lock.stillMine(), false)
  })

  it("keeps a lock live while its holder touches it", async () => {
    const target = await lockPath()
    const holder = await tryAcquireLock(target)
    await age(target, LOCK_STALE_MS - 5000)
    assert.equal(await holder.lock.touch(), true)
    const stat = await fs.stat(target)
    assert.ok(Date.now() - stat.mtimeMs < 5000, "the touch refreshed the time")
    assert.equal((await tryAcquireLock(target)).reason, "held")
  })

  it("skips when a stale lock cannot be removed", async () => {
    const target = await lockPath()
    await tryAcquireLock(target)
    await age(target, LOCK_STALE_MS + 1000)
    await fs.chmod(path.dirname(target), 0o500)
    try {
      const result = await tryAcquireLock(target)
      assert.deepEqual([result.lock, result.reason], [null, "remove-failed"])
    } finally {
      await fs.chmod(path.dirname(target), 0o700)
    }
  })

  it("stops a holder whose stale lock another process replaced: touch fails and release leaves the new lock", async () => {
    const target = await lockPath()
    const first = await tryAcquireLock(target)
    await age(target, LOCK_STALE_MS + 1000)
    // Both judge it stale; the second takes it over.
    const second = await tryAcquireLock(target)
    assert.equal(second.reason, "taken-over")
    assert.equal(await first.lock.touch(), false, "the first holder sees at its next touch that the lock is not its own")
    await first.lock.release()
    assert.equal(await second.lock.stillMine(), true, "the first holder's release removed nothing of the second's")
    await second.lock.release()
    await assert.rejects(fs.stat(target), /ENOENT/)
  })
})
