// Spec 024 FR-8, FR-10 and the plan's "Slack contract" through
// src/brain_train/slack/client.mjs (plan WS3, T013). Every call goes to the
// fake Slack; no test calls Slack.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  addPin,
  authTest,
  callSlack,
  classifySlackError,
  ERROR_CLASSES,
  postMessage,
  updateMessage,
} from "../src/brain_train/slack/client.mjs"
import { createFakeSlack } from "./helpers/fake-slack.mjs"

// Built at runtime so the source holds no string that matches a secret pattern.
const FAKE_BOT = ["xoxb", "0000", "fake", "client"].join("-")

describe("callSlack", () => {
  it("sends every post with unfurl_links and unfurl_media false and never link_names", async () => {
    const fake = createFakeSlack({ expectedToken: FAKE_BOT })
    const reply = await postMessage({ token: FAKE_BOT, fetchImpl: fake.fetch, channel: "C0000FAKE", text: "hi @here", threadTs: "1.1" })
    const card = await postMessage({ token: FAKE_BOT, fetchImpl: fake.fetch, channel: "C0000FAKE", text: "card" })
    assert.equal(reply.ok, true)
    assert.ok(card.body.ts)
    for (const call of fake.calls) {
      assert.equal(call.method, "chat.postMessage")
      assert.equal(call.body.unfurl_links, false)
      assert.equal(call.body.unfurl_media, false)
      assert.equal(Object.hasOwn(call.body, "link_names"), false)
      assert.equal(call.auth, "match")
      assert.equal(call.httpMethod, "POST")
    }
    assert.equal(fake.calls[0].body.thread_ts, "1.1")
    assert.equal(Object.hasOwn(fake.calls[1].body, "thread_ts"), false)
  })

  it("sends the token only in the Authorization header, and no result carries it", async () => {
    const fake = createFakeSlack({ expectedToken: FAKE_BOT })
    const results = [
      await authTest({ token: FAKE_BOT, fetchImpl: fake.fetch }),
      await updateMessage({ token: FAKE_BOT, fetchImpl: fake.fetch, channel: "C0000FAKE", ts: "1.2", text: "x" }),
      await addPin({ token: FAKE_BOT, fetchImpl: fake.fetch, channel: "C0000FAKE", timestamp: "1.2" }),
      await callSlack({ method: "auth.test", token: "wrong-value", fetchImpl: fake.fetch }),
    ]
    for (const call of fake.calls) assert.ok(!JSON.stringify(call.body).includes(FAKE_BOT))
    for (const result of results) assert.ok(!JSON.stringify(result).includes(FAKE_BOT))
    assert.deepEqual(results.slice(0, 3).map((result) => result.ok), [true, true, true])
    assert.equal(results[3].error, "invalid_auth")
    assert.equal(results[3].errorClass, ERROR_CLASSES.CONFIGURATION)
  })

  it("sends a GET with query parameters and no body", async () => {
    const fake = createFakeSlack()
    fake.queue("conversations.history", { ok: true, messages: [] })
    const result = await callSlack({ method: "conversations.history", httpMethod: "GET", token: FAKE_BOT, fetchImpl: fake.fetch, args: { channel: "C0000FAKE", limit: 5, oldest: undefined } })
    assert.equal(result.ok, true)
    const [call] = fake.calls
    assert.equal(call.httpMethod, "GET")
    const url = new URL(call.url)
    assert.equal(url.searchParams.get("channel"), "C0000FAKE")
    assert.equal(url.searchParams.get("limit"), "5")
    assert.equal(url.searchParams.has("oldest"), false)
  })

  it("classifies a Slack error, an HTTP 429 with Retry-After, a 5xx, and a network error", async () => {
    const fake = createFakeSlack()
    fake.queue("chat.postMessage", { error: "channel_not_found" }, { retryAfter: 42 }, { status: 503 }, { network: "ECONNRESET" }, { error: "msg_too_long" }, { error: "something_new" })
    const send = () => postMessage({ token: FAKE_BOT, fetchImpl: fake.fetch, channel: "C0000FAKE", text: "x" })
    const results = []
    for (let index = 0; index < 6; index += 1) results.push(await send())
    assert.deepEqual(results.map((result) => [result.error, result.errorClass]), [
      ["channel_not_found", "configuration"],
      ["ratelimited", "transient"],
      ["http_error", "transient"],
      ["network_error", "transient"],
      ["msg_too_long", "entry"],
      ["something_new", "unknown"],
    ])
    assert.equal(results[1].retryAfterMs, 42_000)
    assert.equal(results[1].status, 429)
  })

  it("stops a call that hangs at its timeout, also one that ignores the abort", async () => {
    for (const outcome of [{ hang: true }, { hang: true, ignoreAbort: true }]) {
      const fake = createFakeSlack()
      fake.queue("chat.postMessage", outcome)
      const started = Date.now()
      const result = await postMessage({ token: FAKE_BOT, fetchImpl: fake.fetch, channel: "C0000FAKE", text: "x", timeoutMs: 100 })
      assert.equal(result.error, "timeout")
      assert.equal(result.errorClass, ERROR_CLASSES.TRANSIENT)
      assert.ok(Date.now() - started < 1000, JSON.stringify(outcome))
    }
  })

  it("stops when the caller's signal aborts", async () => {
    const fake = createFakeSlack()
    fake.queue("chat.postMessage", { hang: true })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await postMessage({ token: FAKE_BOT, fetchImpl: fake.fetch, channel: "C0000FAKE", text: "x", signal: controller.signal })
    assert.equal(result.error, "timeout")
  })

  it("refuses without calling for a missing token, a bad method name, or no time left", async () => {
    const fake = createFakeSlack()
    assert.equal((await callSlack({ method: "auth.test", token: "", fetchImpl: fake.fetch })).error, "not_authed")
    assert.equal((await callSlack({ method: "../x", token: FAKE_BOT, fetchImpl: fake.fetch })).error, "invalid_method")
    assert.equal((await callSlack({ method: "auth.test", token: FAKE_BOT, fetchImpl: fake.fetch, timeoutMs: 0 })).error, "timeout")
    assert.equal(fake.calls.length, 0)
  })
})

describe("classifySlackError", () => {
  it("puts each error of the plan's table in its class", () => {
    for (const name of ["ratelimited", "internal_error", "service_unavailable", "fatal_error", "request_timeout"]) {
      assert.equal(classifySlackError(name), "transient", name)
    }
    for (const name of ["invalid_auth", "token_revoked", "token_expired", "account_inactive", "missing_scope", "not_allowed_token_type", "channel_not_found", "not_in_channel", "no_permission", "is_archived"]) {
      assert.equal(classifySlackError(name), "configuration", name)
    }
    for (const name of ["msg_too_long", "invalid_arguments"]) {
      assert.equal(classifySlackError(name), "entry", name)
    }
    assert.equal(classifySlackError("never_heard_of_it"), "unknown")
  })
})
