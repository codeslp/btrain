// Spec 023 plan "Request lock" through src/brain_train/review/request-lock.mjs
// (task T021).
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireRequestLock, REQUEST_LOCK_HEARTBEAT_MS, REQUEST_LOCK_STALE_MS } from "../src/brain_train/review/request-lock.mjs"

const roots = []
after(async () => {
  for (const root of roots) {
    await fs.chmod(root, 0o700).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function lockPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-request-lock-"))
  roots.push(root)
  return path.join(root, ".btrain", "reviews", "lane-a.lock")
}

async function age(file, ms) {
  const date = new Date(Date.now() - ms)
  await fs.utimes(file, date, date)
}

describe("acquireRequestLock", () => {
  it("uses the plan's bounds: 60 s liveness and a 15 s heartbeat", () => {
    assert.equal(REQUEST_LOCK_STALE_MS, 60_000)
    assert.equal(REQUEST_LOCK_HEARTBEAT_MS, 15_000)
  })

  it("creates the lock with a nonce, and a second process finds it live and does not dispatch", async () => {
    const file = await lockPath()
    const first = await acquireRequestLock(file, { heartbeatMs: 0 })
    assert.equal(first.acquired, true)
    assert.match(first.nonce, /^[0-9a-f-]{36}$/)
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).nonce, first.nonce)
    assert.equal(await first.stillHeld(), true)

    const second = await acquireRequestLock(file, { heartbeatMs: 0 })
    assert.deepEqual(second, { acquired: false, reason: "live" })
    await first.release()
  })

  it("takes over a lock older than 60 seconds, and the old holder's nonce check fails", async () => {
    const file = await lockPath()
    const old = await acquireRequestLock(file, { heartbeatMs: 0 })
    await age(file, 61_000)
    const fresh = await acquireRequestLock(file, { heartbeatMs: 0 })
    assert.equal(fresh.acquired, true)
    assert.equal(await fresh.stillHeld(), true)
    assert.equal(await old.stillHeld(), false, "the old holder stops at its next dispatch")
    await old.release()
    assert.equal(await fresh.stillHeld(), true, "the old holder's release leaves the new lock alone")
    await fresh.release()
    await assert.rejects(fs.stat(file), { code: "ENOENT" })
  })

  it("keeps a lock under 60 seconds old live", async () => {
    const file = await lockPath()
    const holder = await acquireRequestLock(file, { heartbeatMs: 0 })
    await age(file, 59_000)
    assert.equal((await acquireRequestLock(file, { heartbeatMs: 0 })).reason, "live")
    await holder.release()
  })

  it("skips when a stale lock cannot be removed", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs a non-root POSIX user" : false }, async () => {
    const file = await lockPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ nonce: "someone-else" }))
    await age(file, 120_000)
    await fs.chmod(path.dirname(file), 0o500)
    try {
      assert.deepEqual(await acquireRequestLock(file, { heartbeatMs: 0 }), { acquired: false, reason: "contended" })
    } finally {
      await fs.chmod(path.dirname(file), 0o700)
    }
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).nonce, "someone-else")
  })

  it("ends the first process at its next dispatch when two both judged one lock stale", async () => {
    const file = await lockPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ nonce: "gone" }))
    await age(file, 120_000)
    const first = await acquireRequestLock(file, { heartbeatMs: 0 })
    assert.equal(first.acquired, true)
    // The second process judged the same stale lock before the first replaced
    // it, so its removal deletes the first one's new lock and creates its own.
    await fs.rm(file)
    await fs.writeFile(file, JSON.stringify({ nonce: "second" }), { flag: "wx" })
    assert.equal(await first.stillHeld(), false)
    await first.release()
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).nonce, "second", "release removes only its own lock")
  })

  it("touches the lock on its heartbeat, so a long attempt never looks abandoned", async () => {
    const file = await lockPath()
    let fakeNow = Date.now()
    const holder = await acquireRequestLock(file, { heartbeatMs: 0, now: () => fakeNow })
    // Ten minutes of an attempt with steady output: the loop's heartbeat
    // touches the lock every 15 seconds.
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += REQUEST_LOCK_HEARTBEAT_MS) {
      fakeNow += REQUEST_LOCK_HEARTBEAT_MS
      assert.equal(await holder.touch(), true)
    }
    const other = await acquireRequestLock(file, { heartbeatMs: 0, now: () => fakeNow })
    assert.deepEqual(other, { acquired: false, reason: "live" })
    assert.equal(await holder.stillHeld(), true)
    await holder.release()
  })

  it("runs the heartbeat on a timer for the life of the holder", async () => {
    const file = await lockPath()
    const holder = await acquireRequestLock(file, { heartbeatMs: 20 })
    await age(file, 50_000)
    const before = (await fs.stat(file)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.ok((await fs.stat(file)).mtimeMs > before + 40_000, "the timer touched the lock")
    await holder.release()
    assert.equal(await holder.touch(), false, "a released holder no longer touches")
  })
})
