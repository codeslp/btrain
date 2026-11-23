// Tests for the fake Slack Web API in test/helpers/fake-slack.mjs (spec 024,
// implementation plan WS0). The publisher's own tests rely on these behaviors.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  FAKE_BOT_USER_ID,
  createFakeSlack,
  fakeSlackProcessEnv,
  readFakeSlackLog,
  readFakeSlackRefusals,
} from "./helpers/fake-slack.mjs"

const exec = promisify(execFile)
const PRELOAD = fileURLToPath(new URL("./helpers/fake-slack-preload.mjs", import.meta.url))
// Built at runtime so the source holds no string that matches a Slack token
// pattern (`btrain review code` reports those as hardcoded secrets).
const TOKEN = ["xoxb", "fake", "test", "token", "not", "real"].join("-")
const OTHER_TOKEN = ["xoxb", "some", "other", "fake", "token"].join("-")

function post(fake, method, body, { token = TOKEN, signal } = {}) {
  return fake.fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })
}

async function settledWithin(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms)
  })
  try {
    return await Promise.race([
      promise.then(() => "resolved", () => "rejected"),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe("fake Slack: recording", () => {
  it("records method, URL, parsed body and headers, and never the token", async () => {
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const response = await post(fake, "chat.postMessage", {
      channel: "C0000FAKE",
      text: "lane e: claimed",
      unfurl_links: false,
      unfurl_media: false,
    })
    const payload = await response.json()

    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.channel, "C0000FAKE")
    assert.match(payload.ts, /^\d{10}\.\d{6}$/)
    assert.equal(payload.message.user, FAKE_BOT_USER_ID)

    assert.equal(fake.calls.length, 1)
    const [call] = fake.calls
    assert.equal(call.method, "chat.postMessage")
    assert.equal(call.url, "https://slack.com/api/chat.postMessage")
    assert.equal(call.httpMethod, "POST")
    assert.deepEqual(call.body, {
      channel: "C0000FAKE",
      text: "lane e: claimed",
      unfurl_links: false,
      unfurl_media: false,
    })
    assert.equal(call.headers["content-type"], "application/json; charset=utf-8")
    assert.equal(call.headers.authorization, "[redacted]")
    assert.equal(call.auth, "match")
    assert.equal(call.result.ts, payload.ts)
    assert.doesNotMatch(JSON.stringify(fake.calls), new RegExp(TOKEN))
  })

  it("reports a missing or wrong token without recording it", async () => {
    const fake = createFakeSlack({ expectedToken: TOKEN })
    await post(fake, "auth.test", {}, { token: null })
    await post(fake, "auth.test", {}, { token: OTHER_TOKEN })
    assert.deepEqual(fake.calls.map((call) => call.auth), ["missing", "mismatch"])
    assert.doesNotMatch(JSON.stringify(fake.calls), new RegExp(OTHER_TOKEN))

    const noExpectation = createFakeSlack()
    await post(noExpectation, "auth.test", {})
    assert.equal(noExpectation.calls[0].auth, "present")
  })

  it("gives every post a distinct ts and echoes update and pin targets", async () => {
    const fake = createFakeSlack()
    const first = await (await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "a" })).json()
    const second = await (await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "b", thread_ts: first.ts })).json()
    assert.notEqual(first.ts, second.ts)

    const update = await (await post(fake, "chat.update", { channel: "C0000FAKE", ts: first.ts, text: "a2" })).json()
    assert.deepEqual(update, { ok: true, channel: "C0000FAKE", ts: first.ts, text: "a2" })
    assert.deepEqual(await (await post(fake, "pins.add", { channel: "C0000FAKE", timestamp: first.ts })).json(), { ok: true })

    const auth = await (await post(fake, "auth.test", {})).json()
    assert.equal(auth.ok, true)
    assert.equal(auth.user_id, FAKE_BOT_USER_ID)

    assert.equal(fake.posts.length, 2)
    assert.equal(fake.posts[1].body.thread_ts, first.ts)
    assert.deepEqual(fake.callsTo("chat.update").map((call) => call.body.ts), [first.ts])
  })

  it("parses a form-encoded body", async () => {
    const fake = createFakeSlack()
    await fake.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channel: "C0000FAKE", text: "hi" }).toString(),
    })
    await fake.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      body: new URLSearchParams({ channel: "C0000FAKE", text: "there" }),
    })
    assert.deepEqual(fake.calls.map((call) => call.body), [
      { channel: "C0000FAKE", text: "hi" },
      { channel: "C0000FAKE", text: "there" },
    ])
  })

  it("answers an unknown method the way Slack does and refuses any other URL", async () => {
    const fake = createFakeSlack()
    const unknown = await (await post(fake, "conversations.create", { name: "x" })).json()
    assert.deepEqual(unknown, { ok: false, error: "unknown_method" })

    // A method with no built-in body can still be scripted by name.
    fake.setDefault("conversations.history", { ok: true, messages: [{ ts: "1.000001", text: "hi" }] })
    fake.queue("conversations.history", { retryAfter: 3 })
    assert.equal((await post(fake, "conversations.history", { channel: "C0000FAKE" })).status, 429)
    assert.deepEqual(await (await post(fake, "conversations.history", { channel: "C0000FAKE" })).json(), {
      ok: true,
      messages: [{ ts: "1.000001", text: "hi" }],
    })

    await assert.rejects(
      fake.fetch("https://hooks.slack.com/services/T0000FAKE/B0000FAKE/fake", { method: "POST" }),
      /fake-slack: refused a request/,
    )
    await assert.rejects(fake.fetch("http://127.0.0.1:1/api/health"), /fake-slack: refused a request/)
    assert.equal(fake.calls.length, 3, "a refused URL is not recorded as a Slack call")
    assert.deepEqual(fake.refused.map((refusal) => refusal.url), [
      "https://hooks.slack.com/services/T0000FAKE/B0000FAKE/fake",
      "http://127.0.0.1:1/api/health",
    ], "but it is recorded as a refusal")
  })

  it("answers a built-in method called without a needed argument with Slack's error", async () => {
    const fake = createFakeSlack()
    const errorFor = async (method, body) => (await (await post(fake, method, body)).json()).error
    assert.equal(await errorFor("chat.postMessage", { text: "x" }), "channel_not_found")
    assert.equal(await errorFor("chat.postMessage", { channel: "C0000FAKE" }), "no_text")
    assert.equal(await errorFor("chat.update", { channel: "C0000FAKE", text: "x" }), "message_not_found")
    assert.equal(await errorFor("pins.add", { channel: "C0000FAKE" }), "no_item_specified")
    assert.equal(fake.posts.every((call) => call.result.kind === "slack-error"), true)
  })

  it("rejects a body on GET, as a real fetch does", async () => {
    const fake = createFakeSlack()
    await assert.rejects(
      fake.fetch("https://slack.com/api/chat.postMessage", { body: JSON.stringify({ channel: "C0000FAKE", text: "x" }) }),
      (error) => error instanceof TypeError && /GET\/HEAD/.test(error.message),
    )
    const auth = await fake.fetch("https://slack.com/api/auth.test")
    assert.equal((await auth.json()).ok, true, "a GET without a body is answered")
    assert.equal(fake.calls.at(-1).httpMethod, "GET")
  })

  it("reset clears calls, queues, and defaults", async () => {
    const fake = createFakeSlack()
    fake.queue("chat.postMessage", { error: "is_archived" }).setDefault("*", { error: "invalid_auth" })
    await post(fake, "auth.test", {})
    fake.reset()
    assert.equal(fake.calls.length, 0)
    assert.equal((await (await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "x" })).json()).ok, true)
  })
})

describe("fake Slack: failures on demand", () => {
  it("returns any Slack error name, once per queued outcome, then succeeds", async () => {
    const fake = createFakeSlack()
    fake.queue("chat.postMessage", { error: "channel_not_found" }, { error: "msg_too_long" })

    const first = await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "1" })
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: false, error: "channel_not_found" })
    assert.deepEqual(await (await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "2" })).json(), {
      ok: false,
      error: "msg_too_long",
    })
    assert.equal((await (await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "3" })).json()).ok, true)
    assert.deepEqual(fake.calls.map((call) => call.source), ["queue", "queue", "success"])
    assert.deepEqual(fake.calls[0].outcome, { error: "channel_not_found" })
  })

  it("fails every call to a method by default, and a queued outcome wins over it", async () => {
    const fake = createFakeSlack()
    fake.setDefault("chat.update", { error: "invalid_auth" })
    fake.queue("chat.update", { ok: true })

    assert.equal((await (await post(fake, "chat.update", { channel: "C0000FAKE", ts: "1.1", text: "x" })).json()).ok, true)
    for (let index = 0; index < 3; index += 1) {
      const payload = await (await post(fake, "chat.update", { channel: "C0000FAKE", ts: "1.1", text: "x" })).json()
      assert.deepEqual(payload, { ok: false, error: "invalid_auth" })
    }
    assert.equal((await (await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "x" })).json()).ok, true,
      "a default for one method leaves the others alone")

    fake.setDefault("chat.update", undefined)
    assert.equal((await (await post(fake, "chat.update", { channel: "C0000FAKE", ts: "1.1", text: "x" })).json()).ok, true)
  })

  it("applies '*' after the method's own queue and default", async () => {
    const fake = createFakeSlack()
    fake.setDefault("*", { error: "token_revoked" })
    fake.queue("*", { error: "internal_error" })
    fake.setDefault("pins.add", { ok: true })

    const errors = []
    for (const method of ["auth.test", "auth.test", "pins.add"]) {
      const body = method === "pins.add" ? { channel: "C0000FAKE", timestamp: "1.000001" } : {}
      errors.push((await (await post(fake, method, body)).json()).error ?? "ok")
    }
    assert.deepEqual(errors, ["internal_error", "token_revoked", "ok"])
    assert.deepEqual(fake.calls.map((call) => call.source), ["queue:*", "default:*", "default"])
  })

  it("rate-limits with HTTP 429 and a Retry-After header", async () => {
    const fake = createFakeSlack()
    fake.queue("chat.postMessage", { retryAfter: 17 })

    const response = await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "x" })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get("retry-after"), "17")
    assert.deepEqual(await response.json(), { ok: false, error: "ratelimited" })
    assert.deepEqual(fake.calls[0].result, { kind: "http", status: 429, retryAfter: "17", error: "ratelimited" })
  })

  it("returns any HTTP status", async () => {
    const fake = createFakeSlack()
    fake.queue("auth.test", { status: 503 }, { status: 500, body: "upstream", headers: { "content-type": "text/plain" } })
    const unavailable = await post(fake, "auth.test", {})
    assert.equal(unavailable.status, 503)
    assert.deepEqual(await unavailable.json(), { ok: false })
    const plain = await post(fake, "auth.test", {})
    assert.equal(plain.status, 500)
    assert.equal(plain.headers.get("content-type"), "text/plain")
  })

  it("rejects like a network failure", async () => {
    const fake = createFakeSlack()
    fake.queue("chat.postMessage", { network: true }, { network: "ENOTFOUND" })
    await assert.rejects(post(fake, "chat.postMessage", {}), (error) => {
      assert.equal(error.name, "TypeError")
      assert.equal(error.message, "fetch failed")
      assert.equal(error.cause.code, "ECONNRESET")
      return true
    })
    await assert.rejects(post(fake, "chat.postMessage", {}), (error) => error.cause.code === "ENOTFOUND")
    assert.deepEqual(fake.calls.map((call) => call.result), [
      { kind: "network", code: "ECONNRESET" },
      { kind: "network", code: "ENOTFOUND" },
    ])
  })
})

describe("fake Slack: hanging calls", () => {
  it("never resolves a hanging call, and records it at once", async () => {
    const seen = []
    const fake = createFakeSlack({ onCall: (call) => seen.push(call.method) })
    fake.queue("chat.postMessage", { hang: true })

    const pending = post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "x" })
    assert.equal(await settledWithin(pending, 50), "pending")
    assert.equal(fake.pendingHangs, 1)
    assert.deepEqual(seen, ["chat.postMessage"])
    assert.equal(fake.calls[0].result.kind, "hang")

    // The next call is not held up by the one that hangs.
    assert.equal((await (await post(fake, "chat.postMessage", { channel: "C0000FAKE", text: "y" })).json()).ok, true)
  })

  it("rejects a hanging call when its signal aborts, as a real fetch does", async () => {
    const fake = createFakeSlack()
    fake.setDefault("*", { hang: true })
    const controller = new AbortController()
    const pending = post(fake, "auth.test", {}, { signal: controller.signal })
    assert.equal(await settledWithin(pending, 20), "pending")

    controller.abort()
    await assert.rejects(pending, (error) => error.name === "AbortError")
    assert.equal(fake.pendingHangs, 0)
    assert.equal(fake.calls[0].result.kind, "aborted")

    await assert.rejects(post(fake, "auth.test", {}, { signal: AbortSignal.abort() }), (error) => error.name === "AbortError")
  })

  it("can ignore the abort signal, so a caller's own deadline is what ends the wait", async () => {
    const fake = createFakeSlack()
    fake.queue("chat.update", { hang: true, ignoreAbort: true })
    const controller = new AbortController()
    const pending = post(fake, "chat.update", { channel: "C0000FAKE", ts: "1.1", text: "x" }, { signal: controller.signal })
    controller.abort()
    assert.equal(await settledWithin(pending, 50), "pending")
    assert.equal(fake.pendingHangs, 1)
  })
})

describe("fake Slack: subprocess preload", () => {
  it("answers Slack calls in another process from the script and logs them without the token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-fake-slack-"))
    try {
      const logPath = path.join(root, "slack-calls.jsonl")
      const env = {
        ...process.env,
        BRAIN_TRAIN_HOME: path.join(root, "home"),
        ...fakeSlackProcessEnv({
          logPath,
          expectedToken: TOKEN,
          script: {
            queue: { "chat.postMessage": [{ error: "not_in_channel" }] },
            defaults: { "chat.update": { retryAfter: 5 } },
          },
        }),
      }
      const program = `
        const call = async (method, body) => {
          const response = await fetch("https://slack.com/api/" + method, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer ${TOKEN}" },
            body: JSON.stringify(body),
          })
          return { status: response.status, body: await response.json() }
        }
        console.log("started")
        const out = []
        out.push(await call("chat.postMessage", { channel: "C0000FAKE", text: "first" }))
        out.push(await call("chat.postMessage", { channel: "C0000FAKE", text: "second" }))
        out.push(await call("chat.update", { channel: "C0000FAKE", ts: "1.1", text: "card" }))
        try { await fetch("https://example.invalid/") } catch (error) { out.push(error.message) }
        console.log(JSON.stringify(out))
      `
      const { stdout } = await exec(process.execPath, ["--import", PRELOAD, "--input-type=module", "-e", program], { env })
      const [started, result] = stdout.trim().split("\n")
      assert.equal(started, "started")
      const [rejected, posted, limited, refused] = JSON.parse(result)

      assert.deepEqual(rejected, { status: 200, body: { ok: false, error: "not_in_channel" } })
      assert.equal(posted.status, 200)
      assert.equal(posted.body.ok, true)
      assert.match(posted.body.ts, /^\d{10}\.\d{6}$/)
      assert.equal(limited.status, 429)
      assert.match(refused, /fake-slack: refused a request/)
      assert.deepEqual(readFakeSlackRefusals(logPath).map((refusal) => refusal.url), ["https://example.invalid/"])

      const log = readFakeSlackLog(logPath)
      assert.deepEqual(log.map((call) => [call.method, call.body.text, call.auth, call.result.kind]), [
        ["chat.postMessage", "first", "match", "slack-error"],
        ["chat.postMessage", "second", "match", "ok"],
        ["chat.update", "card", "match", "http"],
      ])
      assert.equal(log[1].result.ts, posted.body.ts, "the log carries the ts the fake returned")
      assert.ok(log.every((call) => Number.isInteger(call.pid)))
      assert.ok(
        log.every((call) => call.outputBefore.stdout === "started\n".length && call.outputBefore.stderr === 0),
        "each call records the output written before it",
      )
      assert.doesNotMatch(await fs.readFile(logPath, "utf8"), new RegExp(TOKEN))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("reads a missing log as no calls, and changes nothing without a log path", async () => {
    assert.deepEqual(readFakeSlackLog(path.join(os.tmpdir(), "btrain-fake-slack-missing", "none.jsonl")), [])
    assert.deepEqual(readFakeSlackRefusals(path.join(os.tmpdir(), "btrain-fake-slack-missing", "none.jsonl")), [])
    assert.throws(() => fakeSlackProcessEnv({}), /needs logPath/)

    const env = { ...process.env }
    delete env.BTRAIN_FAKE_SLACK_LOG
    const { stdout } = await exec(process.execPath, [
      "--import", PRELOAD, "--input-type=module", "-e", "console.log(String(fetch).includes('fake-slack'))",
    ], { env })
    assert.equal(stdout.trim(), "false")
  })
})
