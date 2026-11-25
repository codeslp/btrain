// Tests for the read calls of the fake Slack Web API (spec 025 WS0, T001):
// `conversations.history` and `conversations.replies` with scripted messages,
// paging, order, the time window, every failure the fake supports, and the
// refusal of a JSON body on `conversations.replies`.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { compareSlackTs, createFakeSlack, fakeSlackProcessEnv, readFakeSlackLog } from "./helpers/fake-slack.mjs"

const exec = promisify(execFile)
// Fake values, built at runtime so the source holds no string that matches a
// secret pattern.
const TOKEN = ["xoxb", "0000", "fake", "reads"].join("-")
const CHANNEL = "C0000FAKE"

const message = (ts, extra = {}) => ({ type: "message", user: "U0000OPER", text: `m ${ts}`, ts, ...extra })

function get(fake, method, args = {}, { token = TOKEN } = {}) {
  const query = new URLSearchParams(args).toString()
  return fake.fetch(`https://slack.com/api/${method}${query ? `?${query}` : ""}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  })
}

async function json(responsePromise) {
  return (await responsePromise).json()
}

describe("fake Slack: conversations.history", () => {
  it("answers newest first, filtered by oldest (exclusive), with the arguments from the query", async () => {
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message("1700000001.000100"), message("1700000003.000100"), message("1700000002.000100")])
    const body = await json(get(fake, "conversations.history", { channel: CHANNEL, oldest: "1700000001.000100" }))
    assert.equal(body.ok, true)
    assert.deepEqual(body.messages.map((item) => item.ts), ["1700000003.000100", "1700000002.000100"])
    assert.equal(body.has_more, false)
    assert.equal(body.response_metadata.next_cursor, "")
    const [call] = fake.callsTo("conversations.history")
    assert.equal(call.httpMethod, "GET")
    assert.deepEqual(call.body, { channel: CHANNEL, oldest: "1700000001.000100" })
    assert.equal(call.auth, "match")
  })

  it("includes the oldest message when inclusive is set, and honors latest", async () => {
    const fake = createFakeSlack()
    fake.history(CHANNEL, [message("1.000001"), message("2.000001"), message("3.000001")])
    const inclusive = await json(get(fake, "conversations.history", { channel: CHANNEL, oldest: "1.000001", latest: "2.000001", inclusive: "true" }))
    assert.deepEqual(inclusive.messages.map((item) => item.ts), ["2.000001", "1.000001"])
  })

  it("pages with limit, has_more, and next_cursor until the last page", async () => {
    const fake = createFakeSlack()
    fake.history(CHANNEL, Array.from({ length: 5 }, (_, index) => message(`1700000000.00000${index}`)))
    const seen = []
    let cursor = ""
    let pages = 0
    do {
      const body = await json(get(fake, "conversations.history", { channel: CHANNEL, limit: "2", ...(cursor ? { cursor } : {}) }))
      seen.push(...body.messages.map((item) => item.ts))
      cursor = body.response_metadata.next_cursor
      assert.equal(body.has_more, Boolean(cursor))
      pages += 1
    } while (cursor)
    assert.equal(pages, 3)
    assert.deepEqual(seen, ["1700000000.000004", "1700000000.000003", "1700000000.000002", "1700000000.000001", "1700000000.000000"])
    assert.deepEqual(await json(get(fake, "conversations.history", { channel: CHANNEL, cursor: "bogus" })), { ok: false, error: "invalid_cursor" })
  })

  it("answers an unscripted channel with no messages, and a missing channel with channel_not_found", async () => {
    const fake = createFakeSlack()
    assert.deepEqual((await json(get(fake, "conversations.history", { channel: "C0000NONE" }))).messages, [])
    assert.deepEqual(await json(get(fake, "conversations.history", {})), { ok: false, error: "channel_not_found" })
  })

  it("returns the scripted message fields untouched, and copies the script", async () => {
    const fake = createFakeSlack()
    const scripted = [message("5.000001", { app_id: "A0000FAKE", client_msg_id: "fake-id", thread_ts: "4.000001", subtype: "thread_broadcast" })]
    fake.history(CHANNEL, scripted)
    scripted[0].text = "changed after scripting"
    const [returned] = (await json(get(fake, "conversations.history", { channel: CHANNEL }))).messages
    assert.equal(returned.text, "m 5.000001")
    assert.equal(returned.app_id, "A0000FAKE")
    assert.equal(returned.subtype, "thread_broadcast")
  })

  it("applies every failure the fake supports", async () => {
    const fake = createFakeSlack()
    fake.history(CHANNEL, [message("1.000001")])
    fake.queue("conversations.history", { retryAfter: 90 }, { error: "not_in_channel" }, { status: 500 }, { network: "ECONNRESET" })
    const limited = await get(fake, "conversations.history", { channel: CHANNEL })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get("retry-after"), "90")
    assert.deepEqual(await json(get(fake, "conversations.history", { channel: CHANNEL })), { ok: false, error: "not_in_channel" })
    assert.equal((await get(fake, "conversations.history", { channel: CHANNEL })).status, 500)
    await assert.rejects(get(fake, "conversations.history", { channel: CHANNEL }), /fetch failed/)
    fake.queue("conversations.history", { hang: true })
    const controller = new AbortController()
    const pending = fake.fetch(`https://slack.com/api/conversations.history?channel=${CHANNEL}`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, (error) => error.name === "AbortError")
    assert.equal((await json(get(fake, "conversations.history", { channel: CHANNEL }))).messages.length, 1, "succeeds once the queue is empty")
  })

  it("answers not_authed with no token and keeps a query token out of the record", async () => {
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const noToken = await json(fake.fetch(`https://slack.com/api/conversations.history?channel=${CHANNEL}`, { method: "GET" }))
    assert.deepEqual(noToken, { ok: false, error: "not_authed" })
    await json(fake.fetch(`https://slack.com/api/conversations.history?channel=${CHANNEL}&token=${TOKEN}`, { method: "GET" }))
    const call = fake.callsTo("conversations.history").at(-1)
    assert.equal(call.auth, "match")
    assert.ok(!JSON.stringify(call).includes(TOKEN), "no token in the record")
  })
})

describe("fake Slack: conversations.replies", () => {
  const parent = message("1700000000.000100", { thread_ts: "1700000000.000100", reply_count: 2 })
  const replies = [
    message("1700000050.000200", { thread_ts: "1700000000.000100" }),
    message("1700000020.000200", { thread_ts: "1700000000.000100", bot_id: "B0000FAKE", app_id: "A0000FAKE" }),
  ]

  it("answers earliest first with the parent first, and keeps the parent when oldest filters replies", async () => {
    const fake = createFakeSlack()
    fake.replies(CHANNEL, parent.ts, [...replies, parent])
    const all = await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: parent.ts }))
    assert.deepEqual(all.messages.map((item) => item.ts), [parent.ts, "1700000020.000200", "1700000050.000200"])
    const recent = await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: parent.ts, oldest: "1700000020.000200" }))
    assert.deepEqual(recent.messages.map((item) => item.ts), [parent.ts, "1700000050.000200"])
  })

  it("pages earliest first", async () => {
    const fake = createFakeSlack()
    fake.replies(CHANNEL, parent.ts, [parent, ...replies])
    const first = await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: parent.ts, limit: "2" }))
    assert.deepEqual(first.messages.map((item) => item.ts), [parent.ts, "1700000020.000200"])
    assert.equal(first.has_more, true)
    const second = await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: parent.ts, limit: "2", cursor: first.response_metadata.next_cursor }))
    assert.deepEqual(second.messages.map((item) => item.ts), ["1700000050.000200"])
    assert.equal(second.has_more, false)
  })

  it("answers thread_not_found for an unscripted thread or a missing ts", async () => {
    const fake = createFakeSlack()
    assert.deepEqual(await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: "9.000001" })), { ok: false, error: "thread_not_found" })
    assert.deepEqual(await json(get(fake, "conversations.replies", { channel: CHANNEL })), { ok: false, error: "thread_not_found" })
  })

  it("refuses a JSON body and accepts a form body", async () => {
    const fake = createFakeSlack()
    fake.replies(CHANNEL, parent.ts, [parent])
    const asJson = await json(fake.fetch("https://slack.com/api/conversations.replies", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: CHANNEL, ts: parent.ts }),
    }))
    assert.deepEqual(asJson, { ok: false, error: "invalid_arguments" })
    const asForm = await json(fake.fetch("https://slack.com/api/conversations.replies", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: new URLSearchParams({ channel: CHANNEL, ts: parent.ts }),
    }))
    assert.equal(asForm.ok, true)
  })

  it("applies a queued failure to the replies method", async () => {
    const fake = createFakeSlack()
    fake.replies(CHANNEL, parent.ts, [parent])
    fake.queue("conversations.replies", { error: "thread_not_found" })
    assert.deepEqual(await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: parent.ts })), { ok: false, error: "thread_not_found" })
    assert.equal((await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: parent.ts }))).ok, true)
  })

  it("reset clears the scripted messages", async () => {
    const fake = createFakeSlack()
    fake.history(CHANNEL, [message("1.000001")]).replies(CHANNEL, parent.ts, [parent])
    fake.reset()
    assert.deepEqual((await json(get(fake, "conversations.history", { channel: CHANNEL }))).messages, [])
    assert.equal((await json(get(fake, "conversations.replies", { channel: CHANNEL, ts: parent.ts }))).error, "thread_not_found")
  })
})

describe("compareSlackTs", () => {
  it("orders by seconds, then microseconds, without float rounding", () => {
    assert.equal(compareSlackTs("1700000000.000101", "1700000000.000100"), 1)
    assert.equal(compareSlackTs("1700000000.000100", "1700000000.0001"), 0)
    assert.equal(compareSlackTs("999.999999", "1000.000000"), -1)
  })
})

describe("fake Slack: scripted reads in a subprocess", () => {
  const parent = message("1700000000.000100", { thread_ts: "1700000000.000100" })
  it("serves the script's history and replies to a process that loads the preload", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-fake-reads-"))
    try {
      const logPath = path.join(root, "calls.jsonl")
      const env = {
        ...process.env,
        ...fakeSlackProcessEnv({
          logPath,
          expectedToken: TOKEN,
          script: {
            history: { [CHANNEL]: [message("2.000001"), message("1.000001")] },
            replies: { [`${CHANNEL}:${parent.ts}`]: [parent] },
          },
        }),
      }
      const source = [
        `const h = await (await fetch("https://slack.com/api/conversations.history?channel=${CHANNEL}", { headers: { authorization: "Bearer ${TOKEN}" } })).json()`,
        `const r = await (await fetch("https://slack.com/api/conversations.replies?channel=${CHANNEL}&ts=${parent.ts}", { headers: { authorization: "Bearer ${TOKEN}" } })).json()`,
        "console.log(JSON.stringify([h.messages.map((m) => m.ts), r.messages.map((m) => m.ts)]))",
      ].join(";")
      const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", source], { env })
      assert.deepEqual(JSON.parse(stdout), [["2.000001", "1.000001"], [parent.ts]])
      assert.deepEqual(readFakeSlackLog(logPath).map((call) => call.method), ["conversations.history", "conversations.replies"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
