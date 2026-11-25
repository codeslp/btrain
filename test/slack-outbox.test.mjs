// Spec 024 FR-3 and the plan's "Data model" through src/brain_train/slack/outbox.mjs
// and threads.mjs (plan WS3, T011 and T014).
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  formatStamp,
  listEntries,
  outboxDir,
  readDeliveryState,
  removeEntry,
  writeDeliveryState,
  writeEntry,
  writeJsonAtomic,
} from "../src/brain_train/slack/outbox.mjs"
import { boardsPath, getBoard, getThread, readThreads, setThread, threadKey, updateBoard } from "../src/brain_train/slack/threads.mjs"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function tempDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-outbox-"))
  roots.push(root)
  return path.join(root, ".btrain", "slack")
}

describe("outbox", () => {
  it("names an entry <stamp>-<sequence>-<uuid>.json with no colon, sortable by time", async () => {
    assert.equal(formatStamp("2026-11-23T21:45:00.123Z"), "20261123T214500123Z")
    const slackDir = await tempDir()
    let clock = Date.parse("2026-11-23T21:45:00.000Z")
    const { name, entry } = await writeEntry(slackDir, { laneId: "e", claimKey: "c1", kind: "claimed", reply: true, mention: false, fields: { actor: "claude" } }, { now: () => clock })
    assert.match(name, /^20261123T214500000Z-\d{10}-[0-9a-f-]{36}\.json$/)
    assert.ok(!name.includes(":"))
    assert.equal(entry.queuedAt, "2026-11-23T21:45:00.000Z")
    assert.match(entry.id, /^[0-9a-f-]{36}$/)
    clock += 1
    await writeEntry(slackDir, { laneId: "e", kind: "sent-to-review" }, { now: () => clock })
    clock -= 10_000
    await writeEntry(slackDir, { laneId: "f", kind: "claimed" }, { now: () => clock })
    const listed = await listEntries(slackDir)
    assert.deepEqual(listed.map((item) => item.entry.kind + item.entry.laneId), ["claimedf", "claimede", "sent-to-reviewe"])
    const stored = JSON.parse(await fs.readFile(path.join(outboxDir(slackDir), name), "utf8"))
    assert.deepEqual(stored, entry)
  })

  it("keeps queue order for entries queued in the same millisecond", async () => {
    const slackDir = await tempDir()
    const at = Date.parse("2026-11-23T21:45:00.000Z")
    for (let index = 0; index < 50; index += 1) await writeEntry(slackDir, { laneId: "e", kind: `k${index}` }, { now: () => at })
    assert.deepEqual((await listEntries(slackDir)).map((item) => item.entry.kind), Array.from({ length: 50 }, (_, index) => `k${index}`))
  })

  it("leaves out an entry it cannot read now, rather than drop it", async () => {
    const slackDir = await tempDir()
    const { name } = await writeEntry(slackDir, { laneId: "e", kind: "claimed" })
    await fs.chmod(path.join(outboxDir(slackDir), name), 0o000)
    try {
      assert.deepEqual(await listEntries(slackDir), [])
    } finally {
      await fs.chmod(path.join(outboxDir(slackDir), name), 0o600)
    }
    assert.equal((await listEntries(slackDir)).length, 1)
  })

  it("never lists a half-written entry, and lists one that does not parse as broken", async () => {
    const slackDir = await tempDir()
    await fs.mkdir(outboxDir(slackDir), { recursive: true })
    await fs.writeFile(path.join(outboxDir(slackDir), ".tmp-20261123T214500000Z-x.json-1-y"), "{\"id\":", "utf8")
    await fs.writeFile(path.join(outboxDir(slackDir), "notes.txt"), "x", "utf8")
    const brokenName = "20261123T214500000Z-00000000-0000-0000-0000-000000000000.json"
    await fs.writeFile(path.join(outboxDir(slackDir), brokenName), "{\"id\":", "utf8")
    const listed = await listEntries(slackDir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, brokenName)
    assert.equal(listed[0].entry, null)
    assert.ok(listed[0].error)
    assert.deepEqual(await listEntries(path.join(slackDir, "missing")), [])
  })

  it("writes through a temporary file and a rename, so a failed write leaves nothing behind", async () => {
    const slackDir = await tempDir()
    const target = path.join(slackDir, "x.json")
    await writeJsonAtomic(target, { a: 1 })
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { a: 1 })
    await assert.rejects(writeJsonAtomic(target, { big: 1n }))
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { a: 1 })
    assert.deepEqual((await fs.readdir(slackDir)).sort(), ["x.json"])
  })

  it("removes a finished entry, and a second removal is not an error", async () => {
    const slackDir = await tempDir()
    const { name } = await writeEntry(slackDir, { laneId: "e", kind: "claimed" })
    await removeEntry(slackDir, name)
    await removeEntry(slackDir, name)
    assert.deepEqual(await listEntries(slackDir), [])
    await assert.rejects(removeEntry(slackDir, "../escape.json"), /Not an outbox entry name/)
  })

  it("reads and writes the delivery state, with defaults for anything missing", async () => {
    const slackDir = await tempDir()
    assert.deepEqual(await readDeliveryState(slackDir), { entries: {}, cards: {}, paused: null, counters: { sent: 0, dropped: 0, collapsed: 0 }, lastError: "" })
    const state = await readDeliveryState(slackDir)
    state.entries.abc = { attempts: 2, nextTryAt: "2026-11-23T22:00:00.000Z", lastError: "ratelimited" }
    state.paused = { error: "channel_not_found", at: "2026-11-23T21:00:00.000Z" }
    state.counters.sent = 3
    await writeDeliveryState(slackDir, state)
    assert.deepEqual(await readDeliveryState(slackDir), state)
    await fs.writeFile(path.join(slackDir, "delivery-state.json"), "not json", "utf8")
    assert.equal((await readDeliveryState(slackDir)).paused, null)
  })
})

describe("thread and board maps", () => {
  it("keys a thread by lane and claim, so a new claim starts a new thread", async () => {
    const slackDir = await tempDir()
    assert.equal(threadKey("e", "2026-11-23T21:00:00.000Z"), "e@2026-11-23T21:00:00.000Z")
    assert.equal(await getThread(slackDir, "e", "c1"), null)
    await setThread(slackDir, "e", "c1", { channel: "C0000FAKE", cardTs: "1.1" })
    await setThread(slackDir, "e", "c2", { channel: "C0000FAKE", cardTs: "2.2" })
    assert.deepEqual(await getThread(slackDir, "e", "c1"), { channel: "C0000FAKE", cardTs: "1.1" })
    assert.deepEqual(await getThread(slackDir, "e", "c2"), { channel: "C0000FAKE", cardTs: "2.2" })
    assert.deepEqual(Object.keys(await readThreads(slackDir)).sort(), ["e@c1", "e@c2"])
  })

  it("gives concurrent senders to one channel distinct slots a second apart, and holds the channel after a 429", async () => {
    const { reserveChannelSend, holdChannel, readChannelState } = await import("../src/brain_train/slack/threads.mjs")
    const home = path.dirname(path.dirname(await tempDir()))
    const now = Date.parse("2026-11-23T21:00:00.000Z")
    const slots = await Promise.all(Array.from({ length: 10 }, () => reserveChannelSend(home, "C0000FAKE", { now, intervalMs: 1000 })))
    const times = slots.map((slot) => slot.slotAt).sort((a, b) => a - b)
    assert.equal(new Set(times).size, 10)
    for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 1000)
    await holdChannel(home, "C0000FAKE", now + 60_000)
    assert.deepEqual(await reserveChannelSend(home, "C0000FAKE", { now: now + 1000, intervalMs: 1000 }), { blockedUntil: now + 60_000 })
    assert.equal((await readChannelState(home, "C0000FAKE")).retryUntil, now + 60_000)
    assert.ok((await reserveChannelSend(home, "C0000OTHR", { now, intervalMs: 1000 })).slotAt === now, "another channel is not held")
  })

  it("forgets a thread whose card is gone", async () => {
    const { deleteThread } = await import("../src/brain_train/slack/threads.mjs")
    const slackDir = await tempDir()
    await setThread(slackDir, "e", "c1", { channel: "C0000FAKE", cardTs: "1.1" })
    await deleteThread(slackDir, "e", "c1")
    await deleteThread(slackDir, "e", "c1")
    assert.equal(await getThread(slackDir, "e", "c1"), null)
  })

  it("keeps the board map in the btrain home, one record per channel, merging repositories", async () => {
    const home = path.dirname(path.dirname(await tempDir()))
    assert.equal(boardsPath(home), path.join(home, "slack", "boards.json"))
    assert.equal(await getBoard(home, "C0000FAKE"), null)
    await updateBoard(home, "C0000FAKE", { ts: "9.9", repos: { "/a": { lines: ["x"] } } })
    await updateBoard(home, "C0000FAKE", { pinned: true, repos: { "/b": { lines: ["y"] } } })
    assert.deepEqual(await getBoard(home, "C0000FAKE"), { ts: "9.9", pinned: true, repos: { "/a": { lines: ["x"] }, "/b": { lines: ["y"] } } })
  })
})
