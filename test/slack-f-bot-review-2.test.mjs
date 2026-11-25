// The gh-codex bot's two open P2 findings on PR #126 (lane f) at fa1ad9d, as
// failing tests committed before their fix.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { deliver, DELIVERY_LOCK_FILENAME } from "../src/brain_train/slack/deliver.mjs"
import { DELIVERY_STATE_FILENAME, listEntries, writeEntry } from "../src/brain_train/slack/outbox.mjs"
import { holdChannel, sendOnChannel, setThread, threadKey, CHANNELS_RELATIVE } from "../src/brain_train/slack/threads.mjs"
import { createFakeSlack } from "./helpers/fake-slack.mjs"

const FAKE_BOT = ["xoxb", "0000", "fake", "bot", "review"].join("-")
const CHANNEL = "C0000FAKE"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-bot-review-2-"))
  roots.push(root)
  return root
}

test("a card refresh owed by a sent reply is on disk before its outbox entry is removed", async (t) => {
  const root = await tempRoot()
  const slackDir = path.join(root, ".btrain", "slack")
  const lanes = [{ lane: "a", task: "Task A", owner: "claude", reviewer: "codex-reviewer", status: "needs-review", lockedFiles: [], lastUpdated: "claude 2026-11-23T21:00:00.000Z" }]
  await setThread(slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  await writeEntry(slackDir, { laneId: "a", claimKey: "claim-a", kind: "needs-review", reply: true, fields: { actor: "claude", lane: "a" } })
  const fake = createFakeSlack({ expectedToken: FAKE_BOT })

  // The process stops for good right after the entry file is removed.
  const rm = fs.rm
  let removed
  const entryRemoved = new Promise((resolve) => { removed = resolve })
  fs.rm = async (target, ...rest) => {
    await rm(target, ...rest)
    if (String(target).includes(`${path.sep}outbox${path.sep}`)) {
      removed()
      return new Promise(() => {})
    }
  }
  t.after(() => { fs.rm = rm })

  deliver({
    slackDir,
    homeDir: path.join(root, "home"),
    repo: { name: "fixture-repo", path: root },
    channel: CHANNEL,
    token: FAKE_BOT,
    fetchImpl: fake.fetch,
    readLanes: async () => lanes,
  })
  await entryRemoved
  fs.rm = rm

  const stored = JSON.parse(await fs.readFile(path.join(slackDir, DELIVERY_STATE_FILENAME), "utf8").catch(() => "{}"))
  assert.ok(stored.cards?.[threadKey("a", "claim-a")], `the owed refresh survives the stop: ${JSON.stringify(stored)}`)
})

test("a sender whose home lock was superseded during the send keeps the new holder's channel records", async () => {
  const root = await tempRoot()
  const dir = path.join(root, "slack")
  const options = { now: Date.now, intervalMs: 1000, waitMs: 200 }
  const until = Date.now() + 120_000
  const sent = await sendOnChannel(root, "CFAKEA", options, async () => {
    // The send outlives the home-lock lease; another sender takes over and
    // records a 429 on another channel.
    const names = (await fs.readdir(dir)).filter((name) => name.startsWith("home.lock"))
    const stale = new Date(Date.now() - 60_000)
    for (const name of names) await fs.utimes(path.join(dir, name), stale, stale)
    await holdChannel(root, "CFAKEB", until, { waitMs: 200 })
    return { ok: true }
  })
  assert.equal(sent.result?.ok, true)
  const channels = JSON.parse(await fs.readFile(path.join(root, CHANNELS_RELATIVE), "utf8"))
  assert.equal(channels.CFAKEB?.retryUntil, until, `the replacement's Retry-After survives: ${JSON.stringify(channels)}`)
  assert.ok(channels.CFAKEA?.lastSentAt > 0, "the send itself is still recorded")
})

test("a sender that lost its delivery lock during a reply neither saves its state nor removes the entry", async () => {
  const root = await tempRoot()
  const slackDir = path.join(root, ".btrain", "slack")
  const lanes = [{ lane: "a", task: "Task A", owner: "claude", reviewer: "codex-reviewer", status: "needs-review", lockedFiles: [], lastUpdated: "claude 2026-11-23T21:00:00.000Z" }]
  await setThread(slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  await writeEntry(slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } })
  const stateFile = path.join(slackDir, DELIVERY_STATE_FILENAME)
  const replacement = JSON.stringify({ entries: {}, cards: {}, counters: { sent: 7, dropped: 0, collapsed: 0 }, paused: null, lastError: "" })
  const fake = createFakeSlack({
    expectedToken: FAKE_BOT,
    onCall: (call) => {
      if (call.method === "chat.postMessage" && call.body.thread_ts) {
        // While the reply is in flight, another process takes the lock over
        // and writes its own delivery state.
        writeFileSync(path.join(slackDir, DELIVERY_LOCK_FILENAME), "another-process-nonce", "utf8")
        writeFileSync(stateFile, replacement, "utf8")
      }
    },
  })
  const result = await deliver({
    slackDir,
    homeDir: path.join(root, "home"),
    repo: { name: "fixture-repo", path: root },
    channel: CHANNEL,
    token: FAKE_BOT,
    fetchImpl: fake.fetch,
    readLanes: async () => lanes,
  })
  assert.equal(result.status, "lost-lock")
  assert.equal(await fs.readFile(stateFile, "utf8"), replacement, "the replacement's state is kept")
  assert.equal((await listEntries(slackDir)).length, 1, "the entry waits for the new holder")
})

test("a superseded sender merges its record into the same channel's newer one, never back in time", async () => {
  const root = await tempRoot()
  const dir = path.join(root, "slack")
  const options = { now: Date.now, intervalMs: 1000, waitMs: 200 }
  const later = Date.now() + 60_000
  const until = Date.now() + 120_000
  const sent = await sendOnChannel(root, "CFAKEA", options, async () => {
    const names = (await fs.readdir(dir)).filter((name) => name.startsWith("home.lock"))
    const stale = new Date(Date.now() - 60_000)
    for (const name of names) await fs.utimes(path.join(dir, name), stale, stale)
    // The new holder sends on the same channel, ending later, and a 429 holds
    // the channel for longer than this send's own Retry-After.
    await sendOnChannel(root, "CFAKEA", { ...options, now: () => later }, async () => ({ ok: true }))
    await holdChannel(root, "CFAKEA", until, { waitMs: 200 })
    return { ok: false, status: 429, error: "ratelimited", retryAfterMs: 1000 }
  })
  assert.equal(sent.result?.status, 429)
  const channels = JSON.parse(await fs.readFile(path.join(root, CHANNELS_RELATIVE), "utf8"))
  assert.equal(channels.CFAKEA?.lastSentAt, later, "the later send stays the last one")
  assert.equal(channels.CFAKEA?.retryUntil, until, "the longer hold stays")
})

test("a superseded sender does not write the channel map while a live holder has the lock", async () => {
  const root = await tempRoot()
  const dir = path.join(root, "slack")
  const options = { now: Date.now, intervalMs: 1000, waitMs: 200 }
  const sent = await sendOnChannel(root, "CFAKEA", options, async () => {
    // A live process supersedes this sender's lock and keeps holding it.
    const top = Math.max(...(await fs.readdir(dir)).map((name) => Number(/^home\.lock\.(\d+)$/.exec(name)?.[1] || 0)))
    await fs.writeFile(path.join(dir, `home.lock.${top + 1}`), "live-holder-nonce", "utf8")
    return { ok: true }
  })
  assert.equal(sent.result?.ok, true)
  const channels = await fs.readFile(path.join(root, CHANNELS_RELATIVE), "utf8").catch(() => null)
  assert.equal(channels, null, `nothing is written under another holder's lock: ${channels}`)
})

// codex-reviewer, lane f at d33b9d5: the lock check must not depend on a
// card change. The second reply owes the same card as the first, so its
// owed-card record is unchanged.
test("a second reply that lost the delivery lock keeps its entry although its owed card did not change", async () => {
  const root = await tempRoot()
  const slackDir = path.join(root, ".btrain", "slack")
  const lanes = [{ lane: "a", task: "Task A", owner: "claude", reviewer: "codex-reviewer", status: "needs-review", lockedFiles: [], lastUpdated: "claude 2026-11-23T21:00:00.000Z" }]
  await setThread(slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  await writeEntry(slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } })
  await writeEntry(slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } })
  let replies = 0
  const fake = createFakeSlack({
    expectedToken: FAKE_BOT,
    onCall: (call) => {
      if (call.method === "chat.postMessage" && call.body.thread_ts) {
        replies += 1
        // The lock is taken over while the second reply is in flight.
        if (replies === 2) writeFileSync(path.join(slackDir, DELIVERY_LOCK_FILENAME), "another-process-nonce", "utf8")
      }
    },
  })
  const result = await deliver({
    slackDir,
    homeDir: path.join(root, "home"),
    repo: { name: "fixture-repo", path: root },
    channel: CHANNEL,
    token: FAKE_BOT,
    fetchImpl: fake.fetch,
    readLanes: async () => lanes,
  })
  assert.equal(replies, 2)
  assert.equal(result.status, "lost-lock")
  assert.equal((await listEntries(slackDir)).length, 1, "the second entry waits for the new holder")
})
