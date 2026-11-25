// Spec 025 WS3 step 1 (T016): the listener's two read calls over the
// low-level `callSlack` of spec 024, with paging, the 60-second overlap, and
// the read budget of FR-11.
//
// - `conversations.history` and `conversations.replies` go as GET requests
//   with query parameters (`conversations.replies` takes no JSON body).
// - Each read asks for messages from 60 seconds before its cursor, so a
//   message Slack lists late is still seen; the caller's handled set drops
//   the repeats.
// - A read pages with `cursor` until `has_more` is false. Its messages come
//   back oldest first, or not at all: a read cut short by the budget or an
//   error returns none, so a caller never moves a cursor past messages it did
//   not get. A read the budget cut short keeps its pages and continues on the
//   next call for the same read, so a long backlog still completes; an error
//   drops them.
// - The budget: at most 30 read calls a minute for each channel, and 40 a
//   minute for each method over all channels (Slack counts Tier 3 per method
//   across the workspace). A 429 holds its method for at least its
//   Retry-After. Thread reads take turns when the budget is short.
//
// The token goes only to `callSlack`. Imports nothing from core.mjs.

import { callSlack, DEFAULT_CALL_TIMEOUT_MS } from "./client.mjs"
import { compareTs } from "./decide.mjs"

export const READ_OVERLAP_SECONDS = 60
export const CHANNEL_READS_PER_MINUTE = 30
export const METHOD_READS_PER_MINUTE = 40
export const READ_PAGE_LIMIT = 200
// Thread reads leave this many of a channel's reads a minute free, so the
// channel's own read still fits every cycle: one a cycle at the default
// pollSeconds of 10 (FR-11: a channel read comes before thread reads).
export const CHANNEL_READ_RESERVE = 6
const WINDOW_MS = 60_000
// A 429 with no usable Retry-After still holds its method this long.
const MIN_RATE_LIMIT_HOLD_MS = 1_000

const HISTORY = "conversations.history"
const REPLIES = "conversations.replies"

/** `ts` moved back by `seconds`, as a Slack ts ("1700000000.000100"); "" stays "". */
export function overlapTs(ts, seconds = READ_OVERLAP_SECONDS) {
  if (!ts) return ""
  const [whole = "0", fraction = ""] = String(ts).split(".")
  const back = Math.max(0, Number(whole) - seconds)
  return `${back}.${fraction.padEnd(6, "0").slice(0, 6)}`
}

/**
 * What the listener does after a failed read (the plan's "Read errors"):
 * `stop-all` for a token or scope error, `stop-channel` when the channel is
 * gone or the app is not in it, `close-thread` for a thread that is gone, and
 * `skip` (try again next cycle) for everything else.
 */
export function readErrorAction(error) {
  switch (String(error || "")) {
    case "not_authed":
    case "invalid_auth":
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
    case "missing_scope":
    case "not_allowed_token_type":
      return "stop-all"
    case "channel_not_found":
    case "not_in_channel":
    case "is_archived":
      return "stop-channel"
    case "thread_not_found":
      return "close-thread"
    default:
      return "skip"
  }
}

/**
 * The read budget, with an injected clock: sliding one-minute windows for
 * each channel and each method, and a hold for each method after a 429.
 */
export function createReadBudget({ now = Date.now, channelPerMinute = CHANNEL_READS_PER_MINUTE, methodPerMinute = METHOD_READS_PER_MINUTE } = {}) {
  const byChannel = new Map()
  const byMethod = new Map()
  const heldUntil = new Map()

  const recent = (map, key, t) => {
    const kept = (map.get(key) || []).filter((at) => t - at < WINDOW_MS)
    map.set(key, kept)
    return kept
  }

  return {
    /**
     * True when one more `method` call on `channel` fits now, leaving
     * `reserve` of the channel's minute free for other calls.
     */
    allows(channel, method, reserve = 0) {
      const t = now()
      if ((heldUntil.get(method) || 0) > t) return false
      return recent(byChannel, channel, t).length < channelPerMinute - reserve && recent(byMethod, method, t).length < methodPerMinute
    },
    /** Record one call. */
    spend(channel, method) {
      const t = now()
      recent(byChannel, channel, t).push(t)
      recent(byMethod, method, t).push(t)
    },
    /** Hold `method` until at least `retryAfterMs` from now. */
    hold(method, retryAfterMs) {
      const until = now() + Math.max(MIN_RATE_LIMIT_HOLD_MS, Number(retryAfterMs) || 0)
      heldUntil.set(method, Math.max(heldUntil.get(method) || 0, until))
    },
    /** The time `method` is held until, or 0. */
    heldUntil(method) {
      return heldUntil.get(method) || 0
    },
  }
}

/**
 * A reader for one listener. `readChannel` and `readThread` resolve with
 * `{ ok: true, messages }` (oldest first), `{ ok: false, deferred: true }`
 * when the budget has no room, or `{ ok: false, error, errorClass, action }`.
 * `readThreads` reads a channel's open threads in turns.
 */
export function createReader({
  token,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  budget = createReadBudget({ now }),
  channelReserve = CHANNEL_READ_RESERVE,
  signal,
} = {}) {
  // Where each channel's thread reads start next time, so every open thread
  // gets its turn when the budget is short.
  const nextTurn = new Map()

  // Reads the budget cut short, by method, channel, and thread: the pages
  // already read and the cursor of the next one. The next call for the same
  // read (same `oldest`) continues from there, so a read longer than one
  // minute of budget still completes. Each call takes its entry out, so two
  // concurrent calls never share one.
  const unfinished = new Map()

  // Every page of one read, or nothing.
  const readAll = async (method, channel, args, reserve = 0) => {
    const key = `${method}\u0000${channel}\u0000${args.ts || ""}`
    const saved = unfinished.get(key)
    unfinished.delete(key)
    const resume = saved && saved.oldest === (args.oldest || "") ? saved : null
    const messages = resume ? resume.messages : []
    let cursor = resume ? resume.cursor : ""
    for (;;) {
      if (!budget.allows(channel, method, reserve)) {
        if (cursor) unfinished.set(key, { oldest: args.oldest || "", cursor, messages })
        return { ok: false, deferred: true }
      }
      budget.spend(channel, method)
      const result = await callSlack({
        method,
        token,
        httpMethod: "GET",
        args: { channel, ...args, limit: READ_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        fetchImpl,
        timeoutMs,
        signal,
      })
      if (!result.ok) {
        if (result.status === 429 || result.error === "ratelimited") budget.hold(method, result.retryAfterMs)
        return { ok: false, error: result.error, errorClass: result.errorClass, action: readErrorAction(result.error) }
      }
      const body = result.body || {}
      if (Array.isArray(body.messages)) messages.push(...body.messages)
      cursor = body.has_more ? String(body.response_metadata?.next_cursor || "") : ""
      if (!cursor) break
    }
    messages.sort((left, right) => compareTs(left?.ts, right?.ts))
    return { ok: true, messages }
  }

  const reader = {
    budget,

    /** Top-level messages of `channel` from 60 seconds before `cursorTs`. */
    readChannel(channel, cursorTs = "") {
      const oldest = overlapTs(cursorTs)
      return readAll(HISTORY, channel, oldest ? { oldest } : {})
    },

    /** A thread's messages, parent included, from 60 seconds before `cursorTs`. */
    readThread(channel, threadTs, cursorTs = "") {
      const oldest = overlapTs(cursorTs)
      return readAll(REPLIES, channel, { ts: threadTs, ...(oldest ? { oldest } : {}) }, channelReserve)
    },

    /**
     * Read `threads` (`[{ threadTs, cursorTs }]`) of one channel, starting
     * after the thread this channel's last turn ended on, until the budget
     * has no room. Resolves with `{ results: [{ threadTs, result }] }`; a
     * thread with no turn this time is not in `results`.
     */
    async readThreads(channel, threads = []) {
      const list = Array.isArray(threads) ? threads : []
      const results = []
      if (list.length === 0) return { results }
      const start = (nextTurn.get(channel) || 0) % list.length
      for (let step = 0; step < list.length; step += 1) {
        const index = (start + step) % list.length
        const { threadTs, cursorTs } = list[index]
        const result = await reader.readThread(channel, threadTs, cursorTs)
        // A thread the budget cut short goes first next time.
        nextTurn.set(channel, result.deferred ? index : index + 1)
        if (result.deferred) break
        results.push({ threadTs, result })
      }
      return { results }
    },
  }
  return reader
}
