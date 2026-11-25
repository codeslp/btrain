// Spec 024 FR-4, FR-5, FR-6, FR-10 and the plan's WS3: drain the outbox of one
// repository to Slack.
//
// - The caller gives the repository, the channel and token, the time budget
//   (2 seconds after a lane command, none for `btrain slack flush`), and a
//   `readLanes` function for current lane state. Nothing here imports core.mjs.
// - One process delivers at a time (lock.mjs). A process that finds a live
//   lock returns at once.
// - Entries are sent lane by lane, in queue order: the reply, then the card
//   rendered from current state. A lane stops at its first entry that must
//   wait; other lanes go on.
// - A transient error records the earliest next try (a 429 waits at least its
//   Retry-After) and moves to the next lane. A configuration error pauses
//   delivery for the repository until `clearPause` (`btrain slack test`). An
//   error about one message drops that entry. An unknown error is retried for
//   5 attempts, then dropped.
// - Entries older than 24 hours collapse into one reply for their lane.
// - At most one message a second goes to a channel. When keeping that pace
//   would pass the budget, delivery stops and leaves the rest queued.
// - The lock is touched before every call, and a holder whose lock was taken
//   over stops at its next call.
// - Every error is caught: `deliver` resolves with a summary and never throws.
//
// Replies are at-least-once (FR-10): a process that stops between Slack's
// answer and the entry's removal sends that reply again next time. The card is
// rewritten whole, so it is always right.

import path from "node:path"
import { classifySlackError, DEFAULT_CALL_TIMEOUT_MS, ERROR_CLASSES, postMessage, updateMessage } from "./client.mjs"
import { tryAcquireLock } from "./lock.mjs"
import { listEntries, readDeliveryState, removeEntry, writeDeliveryState } from "./outbox.mjs"
import { renderCard, renderReply } from "./render.mjs"
import { getThread, setThread } from "./threads.mjs"

export const DELIVERY_LOCK_FILENAME = "delivery.lock"
export const COLLAPSE_AGE_MS = 24 * 60 * 60 * 1000
export const CHANNEL_INTERVAL_MS = 1000
export const MAX_UNKNOWN_ATTEMPTS = 5
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 15 * 60 * 1000

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function backoffMs(attempts) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

function laneIdOf(lane) {
  return String(lane?.lane ?? lane?.laneId ?? "")
}

/** The reply for entries that waited more than 24 hours (FR-4). */
export function collapsedReplyText(count) {
  return `${count} ${count === 1 ? "update was" : "updates were"} not delivered`
}

/** Clear a configuration pause, after `btrain slack test` succeeds. */
export async function clearPause(slackDir) {
  const state = await readDeliveryState(slackDir)
  state.paused = null
  await writeDeliveryState(slackDir, state)
}

/**
 * Drain one repository's outbox. Resolves with
 * `{ status, sent, dropped, collapsed, deferred, cards }`, where `status` is
 * `done`, `skipped` (with `reason`), `paused`, `budget`, `lost-lock`, or
 * `error`.
 */
export async function deliver({
  slackDir,
  lockPath = path.join(slackDir, DELIVERY_LOCK_FILENAME),
  repo = {},
  channel = "",
  token = "",
  fetchImpl = globalThis.fetch,
  readLanes = async () => [],
  context = {},
  budgetMs = Infinity,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  const summary = { status: "done", reason: "", sent: 0, dropped: 0, collapsed: 0, deferred: 0, cards: 0 }
  if (!token) return { ...summary, status: "skipped", reason: "no-token" }
  if (!channel) return { ...summary, status: "skipped", reason: "no-channel" }

  const deadline = Number.isFinite(budgetMs) ? now() + Math.max(0, budgetMs) : Infinity
  let lock = null
  let state = null
  try {
    const attempt = await tryAcquireLock(lockPath, { now })
    lock = attempt.lock
    if (!lock) return { ...summary, status: "skipped", reason: attempt.reason }

    state = await readDeliveryState(slackDir)
    if (state.paused) return { ...summary, status: "paused", reason: String(state.paused.error || "") }

    const entries = await listEntries(slackDir)
    let lanes = []
    try {
      lanes = (await readLanes()) || []
    } catch {
      lanes = []
    }
    const renderContext = { ...context, repoName: context.repoName || repo.name || path.basename(String(repo.path || "")) }

    const groups = new Map()
    for (const item of entries) {
      const key = String(item.entry?.laneId ?? "")
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }

    const run = { slackDir, channel, token, fetchImpl, callTimeoutMs, now, sleep, deadline, lock, state, summary, renderContext, lastSentAt: 0 }
    for (const [laneId, items] of groups) {
      const laneState = lanes.find((lane) => laneIdOf(lane) === laneId) || null
      const outcome = await deliverLane(run, laneId, laneState, items)
      if (outcome !== "next") {
        summary.status = outcome
        break
      }
    }
    if (state.paused && summary.status === "done") summary.status = "paused"
    return summary
  } catch (error) {
    return { ...summary, status: "error", reason: String(error?.message || error) }
  } finally {
    // A holder whose lock was taken over must not overwrite the new holder's
    // state.
    if (lock && state && (await lock.stillMine())) {
      await writeDeliveryState(slackDir, state).catch(() => {})
    }
    await lock?.release()
  }
}

// One Slack call under the run's rules: budget, channel pace, lock heartbeat.
// Returns `{ result }`, or `{ stop }` with `budget` or `lost-lock`.
async function send(run, call) {
  if (run.now() >= run.deadline) return { stop: "budget" }
  const wait = run.lastSentAt + CHANNEL_INTERVAL_MS - run.now()
  if (wait > 0) {
    if (run.now() + wait >= run.deadline) return { stop: "budget" }
    await run.sleep(wait)
  }
  if (!(await run.lock.touch())) return { stop: "lost-lock" }
  const timeoutMs = Math.min(run.callTimeoutMs, run.deadline - run.now())
  if (!(timeoutMs > 0)) return { stop: "budget" }
  const result = await call({ token: run.token, fetchImpl: run.fetchImpl, timeoutMs })
  run.lastSentAt = run.now()
  return { result }
}

// Record a failed call for an entry. Returns `next-entry` (dropped), `stop-lane`
// (wait), or `pause`.
function recordFailure(run, entry, result) {
  const errorClass = result.errorClass || classifySlackError(result.error)
  const id = String(entry?.id || "")
  run.state.lastError = `${result.error}${entry?.kind ? ` (${entry.kind})` : ""}`
  if (errorClass === ERROR_CLASSES.CONFIGURATION) {
    run.state.paused = { error: result.error, at: new Date(run.now()).toISOString() }
    return "pause"
  }
  if (errorClass === ERROR_CLASSES.ENTRY) {
    return "drop"
  }
  const previous = run.state.entries[id] || { attempts: 0 }
  const attempts = (Number(previous.attempts) || 0) + 1
  if (errorClass === ERROR_CLASSES.UNKNOWN && attempts >= MAX_UNKNOWN_ATTEMPTS) {
    return "drop"
  }
  run.state.entries[id] = {
    attempts,
    nextTryAt: new Date(run.now() + Math.max(result.retryAfterMs || 0, backoffMs(attempts))).toISOString(),
    lastError: String(result.error),
  }
  return "stop-lane"
}

async function dropEntries(run, items) {
  for (const item of items) {
    await removeEntry(run.slackDir, item.name)
    if (item.entry?.id) delete run.state.entries[item.entry.id]
    run.summary.dropped += 1
    run.state.counters.dropped += 1
  }
}

async function finishEntries(run, items, counter = "sent") {
  for (const item of items) {
    await removeEntry(run.slackDir, item.name)
    if (item.entry?.id) delete run.state.entries[item.entry.id]
  }
  run.summary[counter] += items.length
  run.state.counters[counter] += items.length
}

// Make sure the lane task has its thread: post the card if it has none.
// Returns `{ thread }`, or `{ outcome }` to stop the lane or the run.
async function ensureThread(run, laneId, claimKey, laneState, entry) {
  const existing = await getThread(run.slackDir, laneId, claimKey)
  if (existing) return { thread: existing, fresh: false }
  const text = renderCard(laneState || { lane: laneId, status: "unknown" }, run.renderContext)
  const sent = await send(run, (options) => postMessage({ ...options, channel: run.channel, text }))
  if (sent.stop) return { outcome: sent.stop }
  if (!sent.result.ok) {
    const failure = recordFailure(run, entry, sent.result)
    return { outcome: failure === "pause" ? "paused" : "next", dropCurrent: failure === "drop" }
  }
  const thread = { channel: run.channel, cardTs: String(sent.result.body.ts || "") }
  await setThread(run.slackDir, laneId, claimKey, thread)
  run.summary.cards += 1
  return { thread, fresh: true }
}

async function deliverLane(run, laneId, laneState, items) {
  let thread = null
  let cardFresh = false
  let handled = 0

  // Entries that do not parse cannot be sent: drop them (FR-10).
  const broken = items.filter((item) => !item.entry)
  if (broken.length > 0) await dropEntries(run, broken)
  const pending = items.filter((item) => item.entry)

  // Entries older than 24 hours become one reply (FR-4).
  const old = pending.filter((item) => run.now() - Date.parse(item.entry.queuedAt) > COLLAPSE_AGE_MS)
  const fresh = pending.filter((item) => !old.includes(item))

  const sendReply = async (entry, text) => {
    const claimKey = entry.claimKey
    if (!thread || thread.claimKey !== claimKey) {
      const ensured = await ensureThread(run, laneId, claimKey, laneState, entry)
      if (ensured.outcome) return ensured
      thread = { ...ensured.thread, claimKey }
      cardFresh = ensured.fresh
    }
    if (!text) return { ok: true }
    const sent = await send(run, (options) => postMessage({ ...options, channel: thread.channel, text, threadTs: thread.cardTs }))
    if (sent.stop) return { outcome: sent.stop }
    if (sent.result.ok) return { ok: true }
    const failure = recordFailure(run, entry, sent.result)
    if (failure === "pause") return { outcome: "paused" }
    return { outcome: "next", dropCurrent: failure === "drop" }
  }

  if (old.length > 0) {
    const newest = old[old.length - 1].entry
    const retry = run.state.entries[String(newest.id || "")]
    if (retry?.nextTryAt && Date.parse(retry.nextTryAt) > run.now()) {
      run.summary.deferred += pending.length
      return "next"
    }
    const result = await sendReply(newest, collapsedReplyText(old.length))
    if (result.ok) {
      await finishEntries(run, old, "collapsed")
      handled += old.length
    } else if (result.dropCurrent) {
      await dropEntries(run, old)
    } else {
      run.summary.deferred += pending.length
      return result.outcome
    }
  }

  for (let index = 0; index < fresh.length; index += 1) {
    const item = fresh[index]
    const entry = item.entry
    const retry = run.state.entries[String(entry.id || "")]
    if (retry?.nextTryAt && Date.parse(retry.nextTryAt) > run.now()) {
      run.summary.deferred += fresh.length - index
      break
    }
    const text = entry.reply ? renderReply({ kind: entry.kind, mention: Boolean(entry.mention), fields: entry.fields || {} }, run.renderContext) : ""
    const result = await sendReply(entry, text)
    if (result.ok) {
      await finishEntries(run, [item])
      handled += 1
      continue
    }
    if (result.dropCurrent) {
      await dropEntries(run, [item])
      continue
    }
    run.summary.deferred += fresh.length - index
    if (result.outcome !== "next") return result.outcome
    break
  }

  // The card, from current state, after the lane's replies (FR-6).
  if (handled > 0 && thread && laneState && !cardFresh) {
    const text = renderCard(laneState, run.renderContext)
    const sent = await send(run, (options) => updateMessage({ ...options, channel: thread.channel, ts: thread.cardTs, text }))
    if (sent.stop) return sent.stop
    if (!sent.result.ok && sent.result.errorClass === ERROR_CLASSES.CONFIGURATION) {
      run.state.paused = { error: sent.result.error, at: new Date(run.now()).toISOString() }
      return "paused"
    }
    if (sent.result.ok) run.summary.cards += 1
  }
  return "next"
}
