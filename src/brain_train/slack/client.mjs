// Spec 024 FR-8, FR-10 and the plan's "Slack contract": the four Web API calls
// the publisher makes, over an injected `fetch`, and the four error classes.
//
// `callSlack` never throws. It returns `{ ok: true, status, body }` or
// `{ ok: false, status, error, errorClass, retryAfterMs }`. It can send a JSON
// POST or a GET with query parameters (the spec 025 listener reads with GET),
// and it stops a call after `timeoutMs` through an `AbortController`, or
// earlier when the caller's `signal` aborts.
//
// The token goes only in the `Authorization` header. No error or result
// carries it. Every post sends `unfurl_links` and `unfurl_media` as false and
// never sends `link_names`, so Slack makes no preview and no notification from
// plain `@here` text. Imports nothing from core.mjs.

export const SLACK_API_BASE = "https://slack.com/api/"
export const DEFAULT_CALL_TIMEOUT_MS = 10_000

const ABORTED = Symbol("aborted")

export const ERROR_CLASSES = Object.freeze({
  TRANSIENT: "transient",
  CONFIGURATION: "configuration",
  ENTRY: "entry",
  UNKNOWN: "unknown",
})

const TRANSIENT_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
  "timeout",
  "network_error",
  "http_error",
])

const CONFIGURATION_ERRORS = new Set([
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "not_allowed_token_type",
  "channel_not_found",
  "not_in_channel",
  "no_permission",
  "is_archived",
])

// Errors about one message's content: the entry is dropped (FR-10).
const ENTRY_ERRORS = new Set([
  "msg_too_long",
  "invalid_arguments",
  "no_text",
  "too_many_attachments",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_attachments",
  "message_not_found",
  "cant_update_message",
  "edit_window_closed",
  "already_pinned",
  "too_many_pins",
])

/** The class of a Slack error name (plan, "Slack contract"). */
export function classifySlackError(error) {
  const name = String(error || "")
  if (TRANSIENT_ERRORS.has(name)) return ERROR_CLASSES.TRANSIENT
  if (CONFIGURATION_ERRORS.has(name)) return ERROR_CLASSES.CONFIGURATION
  if (ENTRY_ERRORS.has(name)) return ERROR_CLASSES.ENTRY
  return ERROR_CLASSES.UNKNOWN
}

function retryAfterMs(headers) {
  const raw = typeof headers?.get === "function" ? headers.get("retry-after") : undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 0
}

function failure(status, error, extra = {}) {
  return { ok: false, status, error, errorClass: classifySlackError(error), retryAfterMs: 0, ...extra }
}

function buildUrl(method, query) {
  const url = new URL(`${SLACK_API_BASE}${method}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * One Web API call. `method` is the Slack method name (`chat.postMessage`).
 * `args` is the JSON body of a POST or the query of a GET (`httpMethod: "GET"`).
 */
export async function callSlack({
  method,
  token,
  args = {},
  httpMethod = "POST",
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  signal,
} = {}) {
  if (!/^[a-z]+(?:\.[A-Za-z]+)+$/.test(String(method || ""))) {
    return failure(0, "invalid_method")
  }
  if (typeof token !== "string" || !token) {
    return failure(0, "not_authed")
  }
  if (typeof fetchImpl !== "function") {
    return failure(0, "network_error", { detail: "no fetch" })
  }
  const limit = Math.max(0, Number(timeoutMs) || 0)
  if (limit <= 0 || signal?.aborted) {
    return failure(0, "timeout")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limit)
  const onAbort = () => controller.abort()
  signal?.addEventListener?.("abort", onAbort, { once: true })
  const isGet = String(httpMethod).toUpperCase() === "GET"
  const headers = { Authorization: `Bearer ${token}` }
  if (!isGet) headers["Content-Type"] = "application/json; charset=utf-8"

  // A fetch that ignores its signal must not hold the caller past the limit,
  // so the call races the abort itself.
  const aborted = new Promise((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true })
  })
  try {
    const response = await Promise.race([
      fetchImpl(isGet ? buildUrl(method, args) : buildUrl(method), {
        method: isGet ? "GET" : "POST",
        headers,
        ...(isGet ? {} : { body: JSON.stringify(args) }),
        signal: controller.signal,
      }),
      aborted,
    ])
    if (response === ABORTED) {
      return failure(0, "timeout")
    }
    const status = Number(response?.status) || 0
    if (status === 429) {
      return failure(status, "ratelimited", { retryAfterMs: retryAfterMs(response.headers) })
    }
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (body && typeof body === "object" && body.ok === true) {
      return { ok: true, status, body }
    }
    if (body && typeof body === "object" && typeof body.error === "string" && body.error) {
      return failure(status, body.error, { retryAfterMs: retryAfterMs(response.headers) })
    }
    return failure(status, status >= 500 || status === 0 ? "http_error" : "unknown_response")
  } catch (error) {
    if (controller.signal.aborted) {
      return failure(0, "timeout")
    }
    return failure(0, "network_error", { detail: String(error?.cause?.code || error?.name || "") })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", onAbort)
  }
}

export function authTest(options) {
  return callSlack({ ...options, method: "auth.test", args: {} })
}

/** A new top-level message, or a reply when `threadTs` is given. */
export function postMessage({ channel, text, threadTs, ...options }) {
  return callSlack({
    ...options,
    method: "chat.postMessage",
    args: {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    },
  })
}

export function updateMessage({ channel, ts, text, ...options }) {
  return callSlack({ ...options, method: "chat.update", args: { channel, ts, text } })
}

export function addPin({ channel, timestamp, ...options }) {
  return callSlack({ ...options, method: "pins.add", args: { channel, timestamp } })
}
