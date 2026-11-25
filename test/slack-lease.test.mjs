// Spec 025 FR-11 and the plan's "listen.lock", "listen.stop", and
// "listen.paused" through src/brain_train/slack/lease.mjs (plan WS2 step 4,
// T014). Every test uses its own temporary slack directory; nothing here
// touches the real btrain home.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  LEASE_FILE,
  LEASE_TOUCH_MS,
  PAUSE_FILE,
  STOP_FILE,
  clearPaused,
  consumeStop,
  isPaused,
  leasePath,
  readLeaseHolder,
  requestStop,
  setPaused,
  startLeaseTimer,
  stopRequested,
  takeLease,
} from "../src/brain_train/slack/lease.mjs"
import { LOCK_STALE_MS } from "../src/brain_train/slack/lock.mjs"
import { emptyInbox, inboxPath, writeInbox } from "../src/brain_train/slack/inbox.mjs"

const OPERATOR = "U0FAKEOPERATOR"
const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function slackDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-lease-"))
  roots.push(root)
  return path.join(root, "slack")
}

async function age(target, ms) {
  const at = new Date(Date.now() - ms)
  await fs.utimes(target, at, at)
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false)
}

describe("listener lease", () => {
  it("lives at listen.lock with mode 0600 and names its holder: nonce, process ID, operator, start time", async () => {
    const dir = await slackDir()
    const startedAt = Date.UTC(2026, 10, 25, 12, 0, 0)
    const { lease, reason } = await takeLease(dir, { operator: OPERATOR, pid: 4242, now: () => startedAt })
    assert.equal(reason, "acquired")
    assert.equal(LEASE_FILE, "listen.lock")
    assert.equal(leasePath(dir), path.join(dir, "listen.lock"))
    assert.equal(lease.path, leasePath(dir))

    const stat = await fs.stat(lease.path)
    assert.equal(stat.mode & 0o777, 0o600)
    const record = JSON.parse(await fs.readFile(lease.path, "utf8"))
    assert.deepEqual(Object.keys(record).sort(), ["nonce", "operator", "pid", "startedAt"])
    assert.match(record.nonce, /^[0-9a-f-]{36}$/)
    assert.deepEqual([record.pid, record.operator, record.startedAt], [4242, OPERATOR, new Date(startedAt).toISOString()])
    assert.deepEqual(lease.holder, { pid: 4242, operator: OPERATOR, startedAt: record.startedAt })
    await lease.release()
  })

  it("refuses a second lease for the same btrain home and names the holder's process ID and start time", async () => {
    const dir = await slackDir()
    const first = await takeLease(dir, { operator: OPERATOR, pid: 111 })
    const second = await takeLease(dir, { operator: OPERATOR, pid: 222 })
    assert.equal(second.lease, null)
    assert.equal(second.reason, "held")
    assert.equal(second.holder.pid, 111)
    assert.equal(second.holder.startedAt, first.lease.holder.startedAt)
    assert.equal(second.holder.operator, OPERATOR)
    assert.equal(first.lease.isMineSync(), true)
    await first.lease.release()
    assert.equal((await takeLease(dir, { operator: OPERATOR, pid: 222 })).reason, "acquired")
  })

  it("keeps a lease touched within 60 seconds and takes over one untouched for 60 seconds", async () => {
    const dir = await slackDir()
    const first = await takeLease(dir, { operator: OPERATOR, pid: 111 })
    await age(first.lease.path, LOCK_STALE_MS - 2_000)
    assert.equal((await takeLease(dir, { operator: OPERATOR, pid: 222 })).reason, "held")

    await age(first.lease.path, LOCK_STALE_MS + 1_000)
    const second = await takeLease(dir, { operator: OPERATOR, pid: 222 })
    assert.equal(second.reason, "taken-over")
    assert.equal(second.lease.holder.pid, 222)
    assert.equal(first.lease.isMineSync(), false)
    assert.equal(await first.lease.touch(), false)
    await first.lease.release()
    assert.equal(await exists(second.lease.path), true, "the old holder's release leaves the new lease")
    assert.equal(second.lease.isMineSync(), true)
    assert.equal(LEASE_TOUCH_MS, 15_000)
    assert.ok(LEASE_TOUCH_MS * 4 <= LOCK_STALE_MS, "four touches fit in one stale window")
  })

  it("reads the holder of a lease file in another format as unknown, and still refuses", async () => {
    const dir = await slackDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(leasePath(dir), "a-bare-nonce", { mode: 0o600 })
    const result = await takeLease(dir, { operator: OPERATOR, pid: 222 })
    assert.equal(result.reason, "held")
    assert.deepEqual(result.holder, { pid: null, operator: "", startedAt: "" })
    assert.deepEqual(readLeaseHolder(dir), { pid: null, operator: "", startedAt: "" })
    await fs.writeFile(leasePath(dir), JSON.stringify({ nonce: "x", pid: "77", operator: 5, startedAt: 9 }))
    assert.deepEqual(readLeaseHolder(dir), { pid: null, operator: "", startedAt: "" })
    await fs.writeFile(leasePath(dir), JSON.stringify({ nonce: "x", pid: 77.5 }))
    assert.equal(readLeaseHolder(dir).pid, null)
    await fs.rm(leasePath(dir))
    assert.equal(readLeaseHolder(dir), null)
  })

  it("refuses to take a lease with no operator", async () => {
    const dir = await slackDir()
    await assert.rejects(takeLease(dir, { operator: "" }), /operator/)
    await assert.rejects(takeLease(dir, {}), /operator/)
    assert.equal(await exists(leasePath(dir)), false)
  })

  it("gates the inbox rename on a synchronous nonce check", async () => {
    const dir = await slackDir()
    const first = await takeLease(dir, { operator: OPERATOR, pid: 111 })
    const state = emptyInbox()
    assert.equal(writeInbox(dir, state, { beforeRename: () => first.lease.isMineSync() }), true)
    const written = await fs.readFile(inboxPath(dir), "utf8")

    await age(first.lease.path, LOCK_STALE_MS + 1_000)
    const second = await takeLease(dir, { operator: OPERATOR, pid: 222 })
    assert.equal(second.reason, "taken-over")
    const changed = { ...emptyInbox(), cursors: { C0FAKE: "1.000001" } }
    assert.equal(writeInbox(dir, changed, { beforeRename: () => first.lease.isMineSync() }), false)
    assert.equal(await fs.readFile(inboxPath(dir), "utf8"), written, "a replaced holder renames nothing")
    assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp")), [])
  })

  it("is not its holder's once the file is gone", async () => {
    const dir = await slackDir()
    const { lease } = await takeLease(dir, { operator: OPERATOR, pid: 111 })
    await lease.release()
    assert.equal(await exists(lease.path), false)
    assert.equal(lease.isMineSync(), false)
  })
})

describe("lease timer", () => {
  function fakeTimers() {
    const timers = { calls: [], cleared: [], unrefed: 0 }
    timers.setInterval = (fn, ms) => {
      const handle = { fn, ms, unref: () => (timers.unrefed += 1) }
      timers.calls.push(handle)
      return handle
    }
    timers.clearInterval = (handle) => timers.cleared.push(handle)
    return timers
  }

  it("touches the lease every 15 seconds without keeping the process alive", async () => {
    const dir = await slackDir()
    const { lease } = await takeLease(dir, { operator: OPERATOR, pid: 111 })
    const timers = fakeTimers()
    const stop = startLeaseTimer(lease, { setInterval: timers.setInterval, clearInterval: timers.clearInterval })
    assert.equal(timers.calls.length, 1)
    assert.equal(timers.calls[0].ms, LEASE_TOUCH_MS)
    assert.equal(timers.unrefed, 1)

    await age(lease.path, LOCK_STALE_MS - 1_000)
    await timers.calls[0].fn()
    const { mtimeMs } = await fs.stat(lease.path)
    assert.ok(Date.now() - mtimeMs < 5_000, "the tick refreshed the lease")
    stop()
    assert.deepEqual(timers.cleared, [timers.calls[0]])
    await lease.release()
  })

  it("calls onLost once and stops when the lease was taken over", async () => {
    const dir = await slackDir()
    const first = await takeLease(dir, { operator: OPERATOR, pid: 111 })
    const timers = fakeTimers()
    let lost = 0
    startLeaseTimer(first.lease, { setInterval: timers.setInterval, clearInterval: timers.clearInterval, onLost: () => (lost += 1) })
    await age(first.lease.path, LOCK_STALE_MS + 1_000)
    const second = await takeLease(dir, { operator: OPERATOR, pid: 222 })
    assert.equal(second.reason, "taken-over")
    await timers.calls[0].fn()
    await timers.calls[0].fn()
    assert.equal(lost, 1)
    assert.deepEqual(timers.cleared, [timers.calls[0]])
    assert.equal(second.lease.isMineSync(), true)
  })
})

describe("stop and pause flags", () => {
  it("writes the stop flag, sees it, and consumes it once", async () => {
    const dir = await slackDir()
    assert.equal(STOP_FILE, "listen.stop")
    assert.equal(await stopRequested(dir), false)
    assert.equal(await consumeStop(dir), false)
    await requestStop(dir)
    assert.equal(await exists(path.join(dir, STOP_FILE)), true)
    assert.equal(await stopRequested(dir), true)
    assert.equal(await consumeStop(dir), true)
    assert.equal(await exists(path.join(dir, STOP_FILE)), false)
    assert.equal(await consumeStop(dir), false)
  })

  it("sets and clears the pause flag, and says whether it was set", async () => {
    const dir = await slackDir()
    assert.equal(PAUSE_FILE, "listen.paused")
    assert.equal(await isPaused(dir), false)
    await setPaused(dir)
    await setPaused(dir)
    assert.equal(await isPaused(dir), true)
    assert.equal(await clearPaused(dir), true)
    assert.equal(await isPaused(dir), false)
    assert.equal(await clearPaused(dir), false)
  })

  it("writes both flags with mode 0600 and no content from Slack, even under a strict umask, and can write them again", async () => {
    const dir = await slackDir()
    await fs.mkdir(dir, { recursive: true })
    const previous = process.umask(0o277)
    try {
      await requestStop(dir)
      await setPaused(dir)
      await setPaused(dir)
    } finally {
      process.umask(previous)
    }
    for (const name of [STOP_FILE, PAUSE_FILE]) {
      const target = path.join(dir, name)
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600, name)
      assert.equal(await fs.readFile(target, "utf8"), "", name)
    }
  })
})
