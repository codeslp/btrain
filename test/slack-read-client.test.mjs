// Spec 025 T016: the read client. No test calls Slack: every call goes to the
// fake of test/helpers/fake-slack.mjs, with an injected clock.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  createReadBudget,
  createReader,
  overlapTs,
  readErrorAction,
  CHANNEL_READS_PER_MINUTE,
  METHOD_READS_PER_MINUTE,
} from "../src/brain_train/slack/read-client.mjs"
import { createFakeSlack } from "./helpers/fake-slack.mjs"

const FAKE_BOT = ["xoxb", "0000", "fake", "bot", "reads"].join("-")
const CHANNEL = "C0000FAKE"
const OTHER = "C0000FAKF"
const BASE = 1_700_000_000

const ts = (seconds, micro = 0) => `${BASE + seconds}.${String(micro).padStart(6, "0")}`
const message = (seconds, micro = 0) => ({ type: "message", user: "UOPER", text: `m${seconds}.${micro}`, ts: ts(seconds, micro) })

function setup() {
  const clock = { at: (BASE + 1_000) * 1000 }
  const now = () => clock.at
  const fake = createFakeSlack({ expectedToken: FAKE_BOT, now })
  const reader = createReader({ token: FAKE_BOT, fetchImpl: fake.fetch, now })
  const reads = () => fake.calls.filter((call) => call.method.startsWith("conversations."))
  return { clock, fake, reader, reads }
}

describe("overlapTs", () => {
  it("moves a Slack ts back 60 seconds and keeps its fraction", () => {
    assert.equal(overlapTs("1700000100.000123"), "1700000040.000123")
    assert.equal(overlapTs("1700000100"), "1700000040.000000")
    assert.equal(overlapTs("30.5"), "0.500000")
    assert.equal(overlapTs(""), "")
  })
})

describe("readChannel", () => {
  it("reads with GET from 60 seconds before the cursor and returns messages oldest first", async () => {
    const t = setup()
    t.fake.history(CHANNEL, [message(10), message(70), message(95), message(130), message(200)])
    const result = await t.reader.readChannel(CHANNEL, ts(100))
    assert.equal(result.ok, true)
    // 70 and 95 are within 60 seconds before the cursor: a late-listed message is still seen.
    assert.deepEqual(result.messages.map((item) => item.ts), [ts(70), ts(95), ts(130), ts(200)])
    const [call] = t.reads()
    assert.equal(call.httpMethod, "GET")
    assert.equal(call.body.oldest, ts(40))
    assert.equal(call.body.channel, CHANNEL)
  })

  it("pages with the cursor until has_more is false", async () => {
    const t = setup()
    t.fake.history(CHANNEL, Array.from({ length: 450 }, (_, index) => message(index)))
    const result = await t.reader.readChannel(CHANNEL, "")
    assert.equal(result.ok, true)
    assert.equal(result.messages.length, 450)
    assert.equal(result.messages[0].ts, ts(0))
    assert.equal(result.messages.at(-1).ts, ts(449))
    assert.equal(t.reads().length, 3)
    assert.equal(t.reads()[0].body.cursor, undefined)
    assert.ok(t.reads()[1].body.cursor)
  })

  it("returns no messages when a later page fails, and says what to do", async () => {
    const t = setup()
    t.fake.history(CHANNEL, Array.from({ length: 250 }, (_, index) => message(index)))
    t.fake.queue("conversations.history", { body: undefined })
    t.fake.queue("conversations.history", { error: "not_in_channel" })
    const result = await t.reader.readChannel(CHANNEL, "")
    assert.equal(result.ok, false)
    assert.equal(result.messages, undefined)
    assert.equal(result.error, "not_in_channel")
    assert.equal(result.action, "stop-channel")
  })
})

describe("readThread", () => {
  it("reads replies with GET (no JSON body), parent first, from 60 seconds before the cursor", async () => {
    const t = setup()
    t.fake.replies(CHANNEL, ts(0), [message(0), message(30), message(90), message(150)])
    const result = await t.reader.readThread(CHANNEL, ts(0), ts(120))
    assert.equal(result.ok, true)
    assert.deepEqual(result.messages.map((item) => item.ts), [ts(0), ts(90), ts(150)])
    const [call] = t.reads()
    assert.equal(call.method, "conversations.replies")
    assert.equal(call.httpMethod, "GET")
    assert.equal(call.body.ts, ts(0))
    assert.equal(call.body.oldest, ts(60))
  })

  it("maps a gone thread to close-thread", async () => {
    const t = setup()
    const result = await t.reader.readThread(CHANNEL, ts(5), "")
    assert.equal(result.error, "thread_not_found")
    assert.equal(result.action, "close-thread")
  })
})

describe("read budget", () => {
  it(`allows ${CHANNEL_READS_PER_MINUTE} reads a minute on one channel, then defers without a call`, async () => {
    const t = setup()
    t.fake.history(CHANNEL, [message(1)])
    for (let index = 0; index < CHANNEL_READS_PER_MINUTE; index += 1) {
      assert.equal((await t.reader.readChannel(CHANNEL, "")).ok, true)
      t.clock.at += 1000
    }
    const deferred = await t.reader.readChannel(CHANNEL, "")
    assert.deepEqual(deferred, { ok: false, deferred: true })
    assert.equal(t.reads().length, CHANNEL_READS_PER_MINUTE)
    t.clock.at += 31_000
    assert.equal((await t.reader.readChannel(CHANNEL, "")).ok, true, "the window slides")
  })

  it(`holds each method to ${METHOD_READS_PER_MINUTE} reads a minute over all channels`, async () => {
    const t = setup()
    const channels = ["C0000FAA", "C0000FAB", "C0000FAC"]
    for (const channel of channels) t.fake.history(channel, [message(1)])
    let ok = 0
    for (let index = 0; index < 45; index += 1) {
      const result = await t.reader.readChannel(channels[index % 3], "")
      if (result.ok) ok += 1
    }
    assert.equal(ok, METHOD_READS_PER_MINUTE)
    assert.equal(t.reads().length, METHOD_READS_PER_MINUTE)
  })

  it("defers a read the budget cuts short between pages, returning no messages", async () => {
    const t = setup()
    const budget = createReadBudget({ now: () => t.clock.at, channelPerMinute: 2 })
    const reader = createReader({ token: FAKE_BOT, fetchImpl: t.fake.fetch, now: () => t.clock.at, budget })
    t.fake.history(CHANNEL, Array.from({ length: 450 }, (_, index) => message(index)))
    assert.deepEqual(await reader.readChannel(CHANNEL, ""), { ok: false, deferred: true })
    assert.equal(t.reads().length, 2)
  })

  it("gives six open threads on one channel turns, inside 30 reads a minute", async () => {
    const t = setup()
    t.fake.history(CHANNEL, [message(1)])
    const threads = Array.from({ length: 6 }, (_, index) => {
      const parent = ts(100 + index)
      t.fake.replies(CHANNEL, parent, [message(100 + index)])
      return { threadTs: parent, cursorTs: parent }
    })
    const readCount = new Map(threads.map((thread) => [thread.threadTs, 0]))
    // Two minutes of 10-second cycles: the channel first, then the threads.
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const channelRead = await t.reader.readChannel(CHANNEL, "")
      assert.equal(channelRead.ok, true, "a channel read comes before thread reads")
      const { results } = await t.reader.readThreads(CHANNEL, threads)
      for (const { threadTs, result } of results) {
        assert.equal(result.ok, true)
        readCount.set(threadTs, readCount.get(threadTs) + 1)
      }
      t.clock.at += 10_000
    }
    const counts = [...readCount.values()]
    assert.ok(Math.min(...counts) >= Math.max(...counts) - 1, `threads take turns: ${counts}`)
    assert.ok(Math.min(...counts) > 0, "no thread is starved")
    // No 60-second window holds more than 30 reads of the channel.
    const times = t.reads().map((call) => call.at)
    for (const start of times) {
      const inWindow = times.filter((at) => at >= start && at < start + 60_000).length
      assert.ok(inWindow <= CHANNEL_READS_PER_MINUTE, `${inWindow} reads in one minute`)
    }
  })

  it("gives a thread the budget cut short between pages the first turn next time", async () => {
    const t = setup()
    const budget = createReadBudget({ now: () => t.clock.at, channelPerMinute: 3 })
    const reader = createReader({ token: FAKE_BOT, fetchImpl: t.fake.fetch, now: () => t.clock.at, budget, channelReserve: 0 })
    const [a, b, c] = [ts(500), ts(600), ts(700)]
    t.fake.replies(CHANNEL, a, [message(500)])
    t.fake.replies(CHANNEL, b, Array.from({ length: 450 }, (_, index) => ({ ...message(600), ts: ts(600, index) })))
    t.fake.replies(CHANNEL, c, [message(700)])
    const threads = [a, b, c].map((threadTs) => ({ threadTs, cursorTs: "" }))
    const first = await reader.readThreads(CHANNEL, threads)
    assert.deepEqual(first.results.map((item) => item.threadTs), [a], "b ran out of budget on its third page")
    t.clock.at += 60_000
    const second = await reader.readThreads(CHANNEL, threads)
    assert.equal(second.results[0]?.threadTs, b, "b goes first")
    assert.equal(second.results[0].result.messages.length, 450)
  })

  it("does not retry a method before a 429's Retry-After", async () => {
    const t = setup()
    t.fake.history(CHANNEL, [message(1)])
    t.fake.history(OTHER, [message(1)])
    t.fake.queue("conversations.history", { retryAfter: 30 })
    const limited = await t.reader.readChannel(CHANNEL, "")
    assert.equal(limited.ok, false)
    assert.equal(limited.error, "ratelimited")
    assert.equal(limited.action, "skip")
    t.clock.at += 29_000
    assert.deepEqual(await t.reader.readChannel(OTHER, ""), { ok: false, deferred: true }, "the hold is for the method, on every channel")
    assert.equal(t.reads().length, 1)
    t.clock.at += 1_000
    assert.equal((await t.reader.readChannel(CHANNEL, "")).ok, true)
    assert.equal(t.reads().length, 2)
  })
})

describe("readErrorAction", () => {
  it("maps the plan's read errors", () => {
    for (const error of ["invalid_auth", "token_revoked", "missing_scope", "not_authed"]) assert.equal(readErrorAction(error), "stop-all", error)
    for (const error of ["channel_not_found", "not_in_channel"]) assert.equal(readErrorAction(error), "stop-channel", error)
    assert.equal(readErrorAction("thread_not_found"), "close-thread")
    for (const error of ["ratelimited", "timeout", "internal_error", "something_new"]) assert.equal(readErrorAction(error), "skip", error)
  })
})

// codex-reviewer, lane f at 651da9d: its attacks, ported (the first two fail
// until paging keeps its progress across budget windows), and pins for the
// five mutants that survived its round.
describe("codex-reviewer round on 651da9d", () => {
  const msg = (i) => ({ type: "message", user: "UOPER", ts: `${1700000000 + i}.000000`, text: "fixture" })
  const review = () => {
    let at = 1800000000000
    const now = () => at
    const fake = createFakeSlack({ expectedToken: FAKE_BOT, now })
    const reader = createReader({ token: FAKE_BOT, fetchImpl: fake.fetch, now })
    return { fake, reader, now, advance: (ms) => { at += ms }, nextWindow: () => { at += 60000 } }
  }

  it("eventually completes a channel backlog larger than one minute of calls", async () => {
    const t = review()
    t.fake.history(CHANNEL, Array.from({ length: 6001 }, (_, i) => msg(i)))
    let result
    for (let cycle = 0; cycle < 3; cycle++) {
      result = await t.reader.readChannel(CHANNEL, "")
      if (result.ok) break
      t.nextWindow()
    }
    assert.equal(result.ok, true, "three full budgets must allow a 31-page history to complete")
    assert.equal(result.messages.length, 6001)
    assert.equal(result.messages[0].ts, msg(0).ts)
    assert.equal(result.messages.at(-1).ts, msg(6000).ts)
  })

  it("does not starve a short thread behind a thread larger than the thread budget", async () => {
    const t = review()
    const long = msg(0).ts
    const short = msg(9000).ts
    t.fake.replies(CHANNEL, long, Array.from({ length: 4801 }, (_, i) => msg(i)))
    t.fake.replies(CHANNEL, short, [msg(9000)])
    const seen = new Set()
    for (let cycle = 0; cycle < 3; cycle++) {
      const { results } = await t.reader.readThreads(CHANNEL, [{ threadTs: long }, { threadTs: short }])
      for (const { threadTs } of results) seen.add(threadTs)
      t.nextWindow()
    }
    assert.ok(seen.has(short), "the short thread must get a turn")
  })

  it("caps 50 concurrent reads at 30 network calls", async () => {
    const t = review()
    t.fake.history(CHANNEL, [msg(0)])
    const results = await Promise.all(Array.from({ length: 50 }, () => t.reader.readChannel(CHANNEL)))
    assert.equal(results.filter((r) => r.ok).length, 30)
    assert.equal(t.fake.calls.length, 30)
  })

  it("holds a channel to 30 reads a minute and each method to 40 (the spec's literals, M1 and M2)", () => {
    const t = review()
    const budget = t.reader.budget
    for (let i = 0; i < 30; i++) { assert.equal(budget.allows("CA", "conversations.history"), true); budget.spend("CA", "conversations.history") }
    assert.equal(budget.allows("CA", "conversations.history"), false, "call 31 on one channel waits")
    for (let i = 0; i < 10; i++) { assert.equal(budget.allows("CB", "conversations.history"), true); budget.spend("CB", "conversations.history") }
    assert.equal(budget.allows("CC", "conversations.history"), false, "call 41 of one method waits on any channel")
    assert.equal(budget.allows("CC", "conversations.replies"), true, "another method is not held")
  })

  it("holds a method for 1 second after a 429 with no usable Retry-After (M12)", () => {
    const t = review()
    t.reader.budget.hold("conversations.history", 0)
    t.advance(999)
    assert.equal(t.reader.budget.allows(CHANNEL, "conversations.history"), false)
    t.advance(1)
    assert.equal(t.reader.budget.allows(CHANNEL, "conversations.history"), true)
  })

  it("never shortens a longer hold already in place (M13)", () => {
    const t = review()
    t.reader.budget.hold("conversations.history", 90_000)
    t.reader.budget.hold("conversations.history", 5_000)
    t.advance(89_999)
    assert.equal(t.reader.budget.allows(CHANNEL, "conversations.history"), false)
    t.advance(1)
    assert.equal(t.reader.budget.allows(CHANNEL, "conversations.history"), true)
  })

  it("restarts a saved read when its cursor moved, and after an error", async () => {
    const t = review()
    const budget = createReadBudget({ now: t.now, channelPerMinute: 2 })
    const reader = createReader({ token: FAKE_BOT, fetchImpl: t.fake.fetch, now: t.now, budget })
    t.fake.history(CHANNEL, Array.from({ length: 450 }, (_, i) => msg(i)))
    assert.equal((await reader.readChannel(CHANNEL, "")).deferred, true)
    t.nextWindow()
    // Another cursor is another read: its first page carries no saved cursor.
    await reader.readChannel(CHANNEL, msg(400).ts)
    const moved = t.fake.calls.at(-1)
    assert.equal(moved.body.oldest, msg(340).ts)
    assert.equal(moved.body.cursor, undefined, "a read with another oldest starts at its first page")

    t.nextWindow()
    assert.equal((await reader.readChannel(CHANNEL, "")).deferred, true)
    t.nextWindow()
    t.fake.queue("conversations.history", { error: "internal_error" })
    assert.equal((await reader.readChannel(CHANNEL, "")).error, "internal_error")
    t.nextWindow()
    await reader.readChannel(CHANNEL, "")
    assert.equal(t.fake.calls.at(-2).body.cursor, undefined, "an error drops the saved pages")
  })

  it("stops all reading on an expired token (M17)", async () => {
    const t = review()
    t.fake.queue("conversations.history", { error: "token_expired" })
    const result = await t.reader.readChannel(CHANNEL, "")
    assert.equal(result.action, "stop-all")
  })
})
