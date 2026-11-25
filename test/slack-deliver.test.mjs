// Spec 024 FR-4, FR-5, FR-6, FR-10 through src/brain_train/slack/deliver.mjs
// (plan WS3, T015): the cases the plan lists for WS3. Every call goes to the
// fake Slack. Time is a fake clock except in the budget test, which needs a
// real wall-clock bound.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { clearPause, collapsedReplyText, deliver, DELIVERY_LOCK_FILENAME, MAX_UNKNOWN_ATTEMPTS } from "../src/brain_train/slack/deliver.mjs"
import { listEntries, outboxDir, readDeliveryState, writeEntry } from "../src/brain_train/slack/outbox.mjs"
import { getThread } from "../src/brain_train/slack/threads.mjs"
import { tryAcquireLock } from "../src/brain_train/slack/lock.mjs"
import { createFakeSlack } from "./helpers/fake-slack.mjs"

const FAKE_BOT = ["xoxb", "0000", "fake", "deliver"].join("-")
const CHANNEL = "C0000FAKE"
const HOUR = 60 * 60 * 1000

const roots = []
after(async () => Promise.all(roots.map(async (root) => {
  await fs.chmod(path.join(root, ".btrain", "slack", "outbox"), 0o700).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})))

const LANES = [
  { lane: "a", task: "Task A", owner: "claude", reviewer: "codex-reviewer", status: "needs-review", prNumber: "", lockedFiles: ["src/a.mjs"], lastUpdated: "claude 2026-11-23T21:00:00.000Z" },
  { lane: "b", task: "Task B", owner: "codex", reviewer: "claude-reviewer", status: "in-progress", prNumber: "", lockedFiles: [], lastUpdated: "codex 2026-11-23T21:00:00.000Z" },
]

async function setup({ lanes = LANES, start = Date.now() } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-deliver-"))
  roots.push(root)
  const slackDir = path.join(root, ".btrain", "slack")
  const clock = { at: start }
  const fake = createFakeSlack({ expectedToken: FAKE_BOT, now: () => clock.at })
  const now = () => clock.at
  const sleep = async (ms) => { clock.at += ms }
  const state = { lanes: lanes.map((lane) => ({ ...lane })) }
  const queue = (laneId, kind, fields = {}, { at = clock.at, claimKey = `claim-${laneId}` } = {}) =>
    writeEntry(slackDir, { laneId, claimKey, kind, reply: kind !== "card-refresh", mention: false, fields: { lane: laneId, actor: "claude", ...fields } }, { now: () => at })
  const run = (options = {}) => deliver({
    slackDir,
    repo: { name: "fixture-repo", path: root },
    channel: CHANNEL,
    token: FAKE_BOT,
    fetchImpl: fake.fetch,
    readLanes: async () => state.lanes,
    context: { label: "test-dev", mention: [] },
    now,
    sleep,
    ...options,
  })
  const posts = () => fake.calls.filter((call) => call.method === "chat.postMessage")
  const replies = () => posts().filter((call) => call.body.thread_ts)
  return { root, slackDir, fake, clock, state, queue, run, posts, replies }
}

describe("deliver", () => {
  it("sends a lane's entries in order: card, replies, then the card from current state", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    t.clock.at += 1
    await t.queue("a", "sent-to-review", { reviewer: "codex-reviewer" })
    t.state.lanes[0].task = "Task A, renamed after the claim"
    const result = await t.run()
    assert.equal(result.status, "done")
    assert.equal(result.sent, 2)
    const calls = t.fake.calls.map((call) => [call.method, call.body.thread_ts ? "reply" : call.method === "chat.update" ? "card-update" : "card"])
    assert.deepEqual(calls, [["chat.postMessage", "card"], ["chat.postMessage", "reply"], ["chat.postMessage", "reply"]])
    assert.match(t.fake.calls[0].body.text, /Task A, renamed after the claim/, "the card is rendered from current state, not the event")
    assert.deepEqual(t.replies().map((call) => call.body.text), ["claude claimed lane a", "sent to review · reviewer codex-reviewer"])
    const thread = await getThread(t.slackDir, "a", "claim-a")
    assert.equal(thread.channel, CHANNEL)
    assert.ok(thread.cardTs)
    for (const call of t.replies()) assert.equal(call.body.thread_ts, thread.cardTs)
    assert.deepEqual(await listEntries(t.slackDir), [])
    for (const call of t.posts()) {
      assert.equal(call.body.unfurl_links, false)
      assert.equal(call.body.unfurl_media, false)
      assert.equal(Object.hasOwn(call.body, "link_names"), false)
    }
  })

  it("refreshes the card with chat.update for a lane that already has its thread", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    await t.run()
    t.state.lanes[0].status = "changes-requested"
    await t.queue("a", "card-refresh")
    const result = await t.run()
    assert.equal(result.sent, 1)
    const update = t.fake.calls.at(-1)
    assert.equal(update.method, "chat.update")
    assert.match(update.body.text, /lane a · changes-requested/)
    assert.equal(t.replies().length, 1, "a card refresh posts no reply")
  })

  it("holds back only the failing lane: a transient error on lane a does not stop lane b", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    t.clock.at += 1
    await t.queue("a", "sent-to-review")
    t.clock.at += 1
    await t.queue("b", "claimed")
    t.fake.queue("chat.postMessage", null, { status: 503 })
    const result = await t.run()
    assert.equal(result.status, "done")
    assert.equal(result.sent, 1)
    assert.equal(result.deferred, 2)
    const left = await listEntries(t.slackDir)
    assert.deepEqual(left.map((item) => `${item.entry.laneId}:${item.entry.kind}`), ["a:claimed", "a:sent-to-review"])
    const retry = (await readDeliveryState(t.slackDir)).entries[left[0].entry.id]
    assert.equal(retry.attempts, 1)
    assert.ok(Date.parse(retry.nextTryAt) > t.clock.at)
    assert.ok(t.replies().some((call) => call.body.text === "claude claimed lane b"))
  })

  it("does not retry a 429 before its Retry-After", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    t.fake.queue("chat.postMessage", null, { retryAfter: 120 })
    await t.run()
    const before = t.fake.calls.length
    t.clock.at += 60_000
    await t.run()
    assert.equal(t.fake.calls.length, before, "nothing is sent at 60 seconds")
    t.clock.at += 61_000
    const result = await t.run()
    assert.equal(result.sent, 1)
    assert.equal(t.replies().filter((call) => call.body.text === "claude claimed lane a").length, 2, "the rate-limited try, then the one after Retry-After")
  })

  it("pauses on a configuration error, sends nothing while paused, and resumes after clearPause", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    t.fake.queue("chat.postMessage", { error: "channel_not_found" })
    const first = await t.run()
    assert.equal(first.status, "paused")
    const state = await readDeliveryState(t.slackDir)
    assert.equal(state.paused.error, "channel_not_found")
    const calls = t.fake.calls.length
    const second = await t.run()
    assert.deepEqual([second.status, t.fake.calls.length], ["paused", calls])
    await clearPause(t.slackDir)
    const third = await t.run()
    assert.equal(third.status, "done")
    assert.equal(third.sent, 1)
  })

  it("drops an entry Slack refuses as too long and sends the lane's later entries", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    t.clock.at += 1
    await t.queue("a", "sent-to-review")
    t.fake.queue("chat.postMessage", null, { error: "msg_too_long" })
    const result = await t.run()
    assert.deepEqual([result.dropped, result.sent], [1, 1])
    assert.deepEqual(await listEntries(t.slackDir), [])
    const state = await readDeliveryState(t.slackDir)
    assert.equal(state.counters.dropped, 1)
    assert.match(state.lastError, /msg_too_long/)
  })

  it("retries an unknown error five times, then drops the entry", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    t.fake.queue("chat.postMessage", null)
    t.fake.setDefault("chat.postMessage", { error: "brand_new_error" })
    let result
    for (let attempt = 1; attempt <= MAX_UNKNOWN_ATTEMPTS; attempt += 1) {
      result = await t.run()
      t.clock.at += 2 * HOUR
    }
    assert.equal(result.dropped, 1)
    assert.deepEqual(await listEntries(t.slackDir), [])
    assert.equal(t.replies().length, MAX_UNKNOWN_ATTEMPTS)
  })

  it("collapses entries older than 24 hours into one reply", async () => {
    const t = await setup()
    const old = t.clock.at - 25 * HOUR
    for (let index = 0; index < 3; index += 1) await t.queue("a", "sent-to-review", {}, { at: old + index })
    await t.queue("a", "changes-requested", { reasonCode: "x" })
    const result = await t.run()
    assert.deepEqual([result.collapsed, result.sent], [3, 1])
    assert.deepEqual(t.replies().map((call) => call.body.text), [collapsedReplyText(3), "claude requested changes · x"])
    assert.equal((await readDeliveryState(t.slackDir)).counters.collapsed, 3)
  })

  it("after a crash between Slack's answer and the entry's removal, sends that reply once more and keeps the card right", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    await t.run()
    await t.queue("a", "sent-to-review")
    await fs.chmod(outboxDir(t.slackDir), 0o500)
    let crashed
    try {
      crashed = await t.run()
    } finally {
      await fs.chmod(outboxDir(t.slackDir), 0o700)
    }
    assert.equal(crashed.status, "error", "the removal failed after the reply was sent")
    t.state.lanes[0].status = "changes-requested"
    const result = await t.run()
    assert.equal(result.status, "done")
    assert.equal(t.replies().filter((call) => call.body.text.startsWith("sent to review")).length, 2, "at most one duplicate")
    const lastCard = t.fake.calls.filter((call) => call.method === "chat.update").at(-1)
    assert.match(lastCard.body.text, /lane a · changes-requested/)
  })

  it("skips at once while another process holds a fresh lock, and two processes deliver each entry once", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    const held = await tryAcquireLock(path.join(t.slackDir, DELIVERY_LOCK_FILENAME))
    const skipped = await t.run()
    assert.deepEqual([skipped.status, skipped.reason, t.fake.calls.length], ["skipped", "held", 0])
    await held.lock.release()

    for (let index = 0; index < 4; index += 1) {
      t.clock.at += 1
      await t.queue(index % 2 ? "a" : "b", "sent-to-review")
    }
    const results = await Promise.all([t.run(), t.run()])
    assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 5)
    assert.equal(t.replies().length, 5, "each entry once")
    assert.deepEqual(await listEntries(t.slackDir), [])
  })

  it("stops at its next call when another process took its stale lock; at most one entry is sent twice", async () => {
    const t = await setup()
    for (let index = 0; index < 3; index += 1) {
      t.clock.at += 1
      await t.queue("a", "sent-to-review")
    }
    const lockFile = path.join(t.slackDir, DELIVERY_LOCK_FILENAME)
    let replaced = false
    const fake = createFakeSlack({
      expectedToken: FAKE_BOT,
      onCall: (call) => {
        if (!replaced && call.body.thread_ts) {
          replaced = true
          // Another process judged the lock stale and created its own.
          writeFileSync(lockFile, "another-process-nonce", "utf8")
        }
      },
    })
    const result = await t.run({ fetchImpl: fake.fetch })
    assert.equal(result.status, "lost-lock")
    const replies = fake.calls.filter((call) => call.body.thread_ts)
    assert.equal(replies.length, 1, "the first holder sent one reply and stopped")
    assert.equal((await listEntries(t.slackDir)).length, 2)
  })

  it("ends within a 2-second budget when a call never returns", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    t.fake.setDefault("chat.postMessage", { hang: true, ignoreAbort: true })
    const started = Date.now()
    const result = await t.run({ budgetMs: 2000, now: Date.now, sleep: undefined })
    const took = Date.now() - started
    assert.ok(took < 2600, `delivery took ${took} ms`)
    assert.equal(result.status, "done")
    assert.equal((await listEntries(t.slackDir)).length, 1, "the entry stays queued")
  })

  it("keeps the lock through a flush longer than 60 seconds, because it touches it before every call", async () => {
    const t = await setup()
    for (let index = 0; index < 70; index += 1) {
      t.clock.at += 1
      await t.queue("a", "sent-to-review")
    }
    const lockFile = path.join(t.slackDir, DELIVERY_LOCK_FILENAME)
    const startedAt = t.clock.at
    let probed = null
    const fake = createFakeSlack({
      expectedToken: FAKE_BOT,
      onCall: () => {
        if (probed === null && t.clock.at - startedAt > 65_000) {
          probed = fs.stat(lockFile).then((stat) => t.clock.at - stat.mtimeMs)
        }
      },
    })
    const result = await t.run({ fetchImpl: fake.fetch })
    assert.equal(result.sent, 70)
    assert.ok(t.clock.at - startedAt > 60_000, "the flush took longer than the stale limit")
    assert.ok((await probed) < 60_000, "the lock was fresh more than 60 seconds into the flush")
  })

  it("makes no call with no token or no channel", async () => {
    const t = await setup()
    await t.queue("a", "claimed")
    assert.deepEqual([(await t.run({ token: "" })).reason, (await t.run({ channel: "" })).reason], ["no-token", "no-channel"])
    assert.equal(t.fake.calls.length, 0)
  })

  it("drops an entry file that does not parse", async () => {
    const t = await setup()
    await fs.mkdir(outboxDir(t.slackDir), { recursive: true })
    await fs.writeFile(path.join(outboxDir(t.slackDir), "20261123T214500000Z-00000000-0000-0000-0000-000000000000.json"), "{", "utf8")
    const result = await t.run()
    assert.equal(result.dropped, 1)
    assert.equal(t.fake.calls.length, 0)
  })

  it("keeps one message a second to a channel, and stops rather than pass the budget", async () => {
    const t = await setup()
    for (let index = 0; index < 3; index += 1) {
      t.clock.at += 1
      await t.queue("a", "sent-to-review")
    }
    const startedAt = t.clock.at
    const result = await t.run({ budgetMs: 1500 })
    assert.equal(result.status, "budget")
    assert.ok(t.clock.at - startedAt <= 1500)
    const times = t.fake.calls.map((call) => call.at)
    for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 1000 || times[index] === times[index - 1])
  })
})
