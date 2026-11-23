// A fake Slack Web API for tests (spec 024, implementation plan WS0).
//
// `createFakeSlack()` returns a `fetch` replacement that the publisher's
// client takes as `fetchImpl`, the way `createSystemOneClient` does in
// test/system-one.test.mjs. No test calls Slack: the fake answers every
// request itself and rejects any URL that is not a Slack Web API method.
//
// Each call is recorded with its method, URL, parsed body, and headers. The
// token value is never recorded: the authorization header is replaced by
// `[redacted]`, and `auth` says only whether a token was sent and, when the
// test passed `expectedToken`, whether it matched.
//
// An outcome tells the fake how to answer one call:
//
//   undefined or null                 Slack-style success for the method
//   { error: "channel_not_found" }    HTTP 200, { ok: false, error }
//   { retryAfter: 30 }                HTTP 429, Retry-After: 30, error "ratelimited"
//   { status: 503, body?, headers? }  any HTTP status; body defaults to { ok: false }
//   { network: "ECONNRESET" }         rejects like undici: TypeError("fetch failed")
//                                     with a cause that carries the code
//   { hang: true }                    never resolves; an AbortSignal still rejects it,
//                                     as a real fetch would
//   { hang: true, ignoreAbort: true } never settles, even when aborted
//   { ok: true, ...fields }           success with these fields merged in; also
//                                     the way to script a method that has no
//                                     built-in body in SUCCESS_BODIES
//
// `queue(method, ...outcomes)` answers the next calls to that method in order,
// one outcome per call. `setDefault(method, outcome)` answers every call to
// that method once its queue is empty. The method "*" matches every method.
// A queued outcome for the method wins over a queued "*" outcome, which wins
// over the method's default, which wins over the "*" default.
//
// test/helpers/fake-slack-preload.mjs installs the same fake as the global
// `fetch` in a btrain subprocess and appends each call to a JSONL log, so a
// test that drives the real CLI can read the calls with `readFakeSlackLog`.

import fs from "node:fs"

export const SLACK_API_PREFIX = "https://slack.com/api/"
export const ANY_METHOD = "*"

// Obviously fake identifiers (spec 024 WS5 searches the repository for real
// ones outside fixtures like these).
export const FAKE_TEAM_ID = "T0000FAKE"
export const FAKE_BOT_USER_ID = "U0000FAKE"
export const FAKE_BOT_ID = "B0000FAKE"

const REDACTED = "[redacted]"
const DEFAULT_RETRY_AFTER_SECONDS = 30

export function createFakeSlack({
  expectedToken,
  firstTs = 1700000000,
  tsSuffix = "",
  now = () => Date.now(),
  onCall,
  onResult,
} = {}) {
  const calls = []
  const queues = new Map()
  const defaults = new Map()
  let sequence = 0
  let pendingHangs = 0

  function nextTs() {
    sequence += 1
    // Seconds advance with each message, so two posts never share a `ts`.
    // `tsSuffix` keeps timestamps from separate processes apart.
    return `${firstTs + sequence}.${String(sequence).padStart(6 - tsSuffix.length, "0")}${tsSuffix}`
  }

  function takeOutcome(method) {
    for (const key of [method, ANY_METHOD]) {
      const queue = queues.get(key)
      if (queue?.length) {
        return { outcome: queue.shift(), source: key === method ? "queue" : "queue:*" }
      }
    }
    for (const key of [method, ANY_METHOD]) {
      if (defaults.has(key)) {
        return { outcome: defaults.get(key), source: key === method ? "default" : "default:*" }
      }
    }
    return { outcome: null, source: "success" }
  }

  async function fetchImpl(input, options = {}) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url
    const signal = options.signal
    if (typeof url !== "string" || !url.startsWith(SLACK_API_PREFIX)) {
      throw new Error(`fake-slack: refused a request to ${url}; only ${SLACK_API_PREFIX}<method> is served`)
    }
    const method = url.slice(SLACK_API_PREFIX.length).split(/[?#]/)[0]
    const headers = recordHeaders(options.headers)
    const body = parseBody(options.body, headers["content-type"])
    const { outcome, source } = takeOutcome(method)
    const call = {
      index: calls.length,
      method,
      url,
      httpMethod: String(options.method || "GET").toUpperCase(),
      body,
      headers,
      auth: authState(options.headers, expectedToken),
      at: now(),
      outcome: describeOutcome(outcome),
      source,
    }
    calls.push(call)
    // Reported before answering, so a call that never settles is still seen.
    // `onResult` follows once the answer is decided.
    onCall?.(call)
    const settle = (result) => {
      call.result = result
      onResult?.(call)
    }

    if (signal?.aborted) {
      settle({ kind: "aborted" })
      throw abortReason(signal)
    }
    if (outcome?.hang) {
      pendingHangs += 1
      settle({ kind: "hang" })
      return new Promise((_resolve, reject) => {
        if (signal && !outcome.ignoreAbort) {
          signal.addEventListener("abort", () => {
            pendingHangs -= 1
            settle({ kind: "aborted" })
            reject(abortReason(signal))
          }, { once: true })
        }
      })
    }
    if (outcome?.network) {
      const code = typeof outcome.network === "string" ? outcome.network : "ECONNRESET"
      settle({ kind: "network", code })
      throw networkError(code)
    }
    const response = buildResponse(method, body, outcome, nextTs)
    settle(response.record)
    return response.response
  }

  return {
    fetch: fetchImpl,
    calls,
    queue(method, ...outcomes) {
      if (!queues.has(method)) {
        queues.set(method, [])
      }
      queues.get(method).push(...outcomes)
      return this
    },
    setDefault(method, outcome) {
      if (outcome === undefined) {
        defaults.delete(method)
      } else {
        defaults.set(method, outcome)
      }
      return this
    },
    reset() {
      calls.length = 0
      queues.clear()
      defaults.clear()
      return this
    },
    callsTo(method) {
      return calls.filter((call) => call.method === method)
    },
    get posts() {
      return calls.filter((call) => call.method === "chat.postMessage")
    },
    get pendingHangs() {
      return pendingHangs
    },
  }
}

function buildResponse(method, body, outcome, nextTs) {
  if (outcome?.retryAfter !== undefined) {
    const seconds = String(outcome.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS)
    return jsonResponse(429, { ok: false, error: "ratelimited" }, { "retry-after": seconds }, {
      kind: "http", status: 429, retryAfter: seconds, error: "ratelimited",
    })
  }
  if (outcome?.status !== undefined) {
    const payload = outcome.body === undefined ? { ok: false } : outcome.body
    return jsonResponse(outcome.status, payload, outcome.headers || {}, {
      kind: "http", status: outcome.status,
    })
  }
  if (outcome?.error) {
    return jsonResponse(200, { ok: false, error: outcome.error }, {}, {
      kind: "slack-error", status: 200, error: outcome.error,
    })
  }
  const builder = SUCCESS_BODIES[method]
  // A method with no built-in body answers `unknown_method`, as Slack does,
  // unless the test scripted a success for it with `{ ok: true, ... }`.
  if (!builder && outcome?.ok !== true) {
    return jsonResponse(200, { ok: false, error: "unknown_method" }, {}, {
      kind: "slack-error", status: 200, error: "unknown_method",
    })
  }
  const success = builder ? builder(body && typeof body === "object" ? body : {}, nextTs) : { ok: true }
  const { ok: _ignored, ...extra } = outcome || {}
  const payload = { ...success, ...extra }
  return jsonResponse(200, payload, {}, { kind: "ok", status: 200, ts: payload.ts })
}

// Built-in success bodies, keyed by Slack method name. A method added later
// (spec 025 reads `conversations.history` and `conversations.replies`) gets one
// entry here, or a scripted `{ ok: true, ... }` outcome in the test.
export const SUCCESS_BODIES = {
  "chat.postMessage"(fields, nextTs) {
    const ts = nextTs()
    return {
      ok: true,
      channel: fields.channel,
      ts,
      message: { type: "message", text: fields.text, ts, bot_id: FAKE_BOT_ID, user: FAKE_BOT_USER_ID },
    }
  },
  "chat.update"(fields) {
    return { ok: true, channel: fields.channel, ts: fields.ts, text: fields.text }
  },
  "pins.add"() {
    return { ok: true }
  },
  "auth.test"() {
    return {
      ok: true,
      url: "https://fake-workspace.example.invalid/",
      team: "Fake Workspace",
      user: "btrain",
      team_id: FAKE_TEAM_ID,
      user_id: FAKE_BOT_USER_ID,
      bot_id: FAKE_BOT_ID,
    }
  },
}

function jsonResponse(status, payload, headers, record) {
  const response = new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
  return { response, record }
}

function recordHeaders(headers) {
  const out = {}
  for (const [name, value] of headerEntries(headers)) {
    const key = name.toLowerCase()
    out[key] = key === "authorization" ? REDACTED : String(value)
  }
  return out
}

function authState(headers, expectedToken) {
  const value = headerEntries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1]
  if (!value) {
    return "missing"
  }
  if (expectedToken === undefined) {
    return "present"
  }
  return String(value) === `Bearer ${expectedToken}` ? "match" : "mismatch"
}

function headerEntries(headers) {
  if (!headers) {
    return []
  }
  if (typeof headers.entries === "function" && !Array.isArray(headers)) {
    return [...headers.entries()]
  }
  if (Array.isArray(headers)) {
    return headers
  }
  return Object.entries(headers)
}

function parseBody(body, contentType = "") {
  if (body === undefined || body === null) {
    return null
  }
  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body)
  }
  const text = typeof body === "string" ? body : Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : null
  if (text === null) {
    return { unparsed: Object.prototype.toString.call(body) }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text))
  }
  try {
    return JSON.parse(text)
  } catch {
    return { unparsed: text }
  }
}

function describeOutcome(outcome) {
  if (outcome === null || outcome === undefined) {
    return null
  }
  return JSON.parse(JSON.stringify(outcome))
}

function abortReason(signal) {
  if (signal.reason !== undefined) {
    return signal.reason
  }
  const error = new Error("This operation was aborted")
  error.name = "AbortError"
  return error
}

function networkError(code) {
  const cause = new Error(`fake-slack: simulated network failure (${code})`)
  cause.code = code
  const error = new TypeError("fetch failed")
  error.cause = cause
  return error
}

// --- Cross-process use -------------------------------------------------------

// Environment read by test/helpers/fake-slack-preload.mjs.
export const FAKE_SLACK_LOG_ENV = "BTRAIN_FAKE_SLACK_LOG"
export const FAKE_SLACK_SCRIPT_ENV = "BTRAIN_FAKE_SLACK_SCRIPT"
export const FAKE_SLACK_AUTH_ENV = "BTRAIN_FAKE_SLACK_EXPECTED_AUTH"

/**
 * Environment that makes a `node --import <preload>` btrain subprocess answer
 * Slack calls from the fake and append each call to `logPath`.
 *
 * `script` is `{ queue: { method: [outcome, ...] }, defaults: { method: outcome } }`.
 * Each process starts with its own copy of the script, so a queue is per
 * process, not shared across the commands a test runs.
 */
export function fakeSlackProcessEnv({ logPath, script, expectedToken } = {}) {
  if (!logPath) {
    throw new Error("fakeSlackProcessEnv needs logPath")
  }
  const env = { [FAKE_SLACK_LOG_ENV]: logPath }
  if (script) {
    env[FAKE_SLACK_SCRIPT_ENV] = JSON.stringify(script)
  }
  if (expectedToken !== undefined) {
    env[FAKE_SLACK_AUTH_ENV] = expectedToken
  }
  return env
}

/**
 * The calls the preload recorded, oldest first, each with the `result` the
 * fake answered (for a post, `result.ts`). A call that is still hanging has
 * `result.kind` "hang"; one whose process ended before an answer has none.
 * A missing log means no call.
 */
export function readFakeSlackLog(logPath) {
  let text
  try {
    text = fs.readFileSync(logPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      return []
    }
    throw error
  }
  const calls = []
  const byKey = new Map()
  for (const line of text.split("\n").filter(Boolean)) {
    const record = JSON.parse(line)
    const key = `${record.pid}:${record.index}`
    if (record.record === "result") {
      const call = byKey.get(key)
      if (call) {
        call.result = record.result
      }
      continue
    }
    byKey.set(key, record)
    calls.push(record)
  }
  return calls
}

/**
 * Replace `globalThis.fetch` with a fake configured from `env`. Used by the
 * preload; returns the fake, or null when `env` names no log.
 *
 * Each logged call carries `outputBefore`: the bytes the process had written
 * to stdout and stderr when the call was made. A test compares it with the
 * command's whole output to prove the output came first (plan invariant 2).
 */
export function installFakeSlackFromEnv(env = process.env) {
  const logPath = env[FAKE_SLACK_LOG_ENV]
  if (!logPath) {
    return null
  }
  const script = env[FAKE_SLACK_SCRIPT_ENV] ? JSON.parse(env[FAKE_SLACK_SCRIPT_ENV]) : {}
  const written = { stdout: countWrites(process.stdout), stderr: countWrites(process.stderr) }
  const fake = createFakeSlack({
    expectedToken: env[FAKE_SLACK_AUTH_ENV],
    firstTs: Math.floor(Date.now() / 1000),
    tsSuffix: String(process.pid % 1000).padStart(3, "0"),
    onCall(call) {
      const outputBefore = { stdout: written.stdout(), stderr: written.stderr() }
      const { result: _pending, ...fields } = call
      fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, outputBefore, ...fields })}\n`)
    },
    onResult(call) {
      const record = { record: "result", pid: process.pid, index: call.index, result: call.result }
      fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`)
    },
  })
  for (const [method, outcomes] of Object.entries(script.queue || {})) {
    fake.queue(method, ...outcomes)
  }
  for (const [method, outcome] of Object.entries(script.defaults || {})) {
    fake.setDefault(method, outcome)
  }
  globalThis.fetch = fake.fetch
  return fake
}

function countWrites(stream) {
  let bytes = 0
  const write = stream.write.bind(stream)
  stream.write = (chunk, encoding, callback) => {
    bytes += typeof chunk === "string"
      ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : "utf8")
      : chunk.length
    return write(chunk, encoding, callback)
  }
  return () => bytes
}
