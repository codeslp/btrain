// Spec 024 FR-4, FR-5, FR-6, FR-10 and the plan's WS3: drain the outbox of one
// repository to Slack.
//
// - The caller gives the repository, the channel and token, the time budget
//   (2 seconds after a lane command, none for `btrain slack flush`), and a
//   `readLanes` function for current lane state. A lane state may carry its
//   `claimKey`; when it does, a card for an older claim of that lane is never
//   rendered from the newer claim's state. Nothing here imports core.mjs.
// - One process delivers at a time (lock.mjs). A process that finds a live
//   lock returns at once.
// - Replies are sent lane by lane, in queue order. A lane stops at its first
//   entry that must wait; other lanes go on.
// - The card of each lane task that got a reply is owed a refresh, kept in the
//   delivery state until a `chat.update` from current state succeeds, so a
//   failed or unsent refresh is retried by a later run (FR-6).
// - A transient error records the entry's earliest next try. A 429 also holds
//   the whole channel, for every repository of the developer, until its
//   Retry-After, and ends the run. A configuration
//   error pauses delivery for the repository until `clearPause`
//   (`btrain slack test`). An error about one message drops that entry. An
//   unknown error is retried for 5 attempts, then dropped.
// - Entries older than 24 hours collapse into one reply for their lane.
// - At most one message a second goes to a channel, across runs and across
//   repositories: each send runs under the home lock and records, in
//   `channels.json` in the btrain home (threads.mjs), when it ended. When keeping that pace, or starting a call with
//   too little time left, would pass the budget, delivery stops and leaves
//   the rest for later.
// - The lock is touched before every call, and a holder whose lock was taken
//   over stops at its next call and writes no state.
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
import { btrainHome } from "./credentials.mjs"
import { deleteThread, getThread, sendOnChannel, setThread, threadKey } from "./threads.mjs"

export const DELIVERY_LOCK_FILENAME = "delivery.lock"
export const COLLAPSE_AGE_MS = 24 * 60 * 60 * 1000
export const CHANNEL_INTERVAL_MS = 1000
export const MAX_UNKNOWN_ATTEMPTS = 5
// An owed card refresh that keeps failing with an unknown error is given up
// after this many runs; the next event on the lane owes a new one.
export const MAX_CARD_ATTEMPTS = 5
// A call is not started with less time than this left in the budget: one cut
// off by the deadline may already have posted, and would be sent again.
export const MIN_CALL_MS = 750
// How many times one send waits for its channel before it gives up for this
// run (other senders keep taking the channel first).
const MAX_CLAIM_TRIES = 20
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 15 * 60 * 1000
// A card update that fails like this means the card is gone: forget the
// thread, so the lane's next event posts a new card.
const CARD_GONE_ERRORS = new Set(["message_not_found", "cant_update_message"])

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function backoffMs(attempts) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

function laneIdOf(lane) {
  return String(lane?.lane ?? lane?.laneId ?? "")
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function timeOf(value) {
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
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

// readLanes, bounded by the budget. Resolves `{ lanes }` or `{ error }`.
async function readLanesWithin(readLanes, deadline, now) {
  const call = Promise.resolve().then(() => readLanes())
  let result
  if (Number.isFinite(deadline)) {
    let timer
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, deadline - now()))
    })
    result = await Promise.race([call.then((lanes) => ({ lanes }), (error) => ({ error })), limit])
    clearTimeout(timer)
  } else {
    result = await call.then((lanes) => ({ lanes }), (error) => ({ error }))
  }
  if (result.timedOut) return { error: "lane state was not read within the budget" }
  if (result.error) return { error: String(result.error?.message || result.error) }
  if (!Array.isArray(result.lanes)) return { error: "readLanes did not return a list" }
  return { lanes: result.lanes }
}

/**
 * Drain one repository's outbox. Resolves with
 * `{ status, reason, sent, dropped, collapsed, deferred, cards }`, where
 * `status` is `done`, `skipped` (with `reason`), `paused`, `budget`,
 * `ratelimited`, `lost-lock`, or `error`.
 */
export async function deliver(options = {}) {
  const summary = { status: "done", reason: "", sent: 0, dropped: 0, collapsed: 0, deferred: 0, cards: 0 }
  let lock = null
  let state = null
  let initialState = ""
  try {
    const {
      slackDir,
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
      homeDir = btrainHome(process.env),
    } = options
    if (!slackDir) return { ...summary, status: "skipped", reason: "no-state-dir" }
    if (!token) return { ...summary, status: "skipped", reason: "no-token" }
    if (!channel) return { ...summary, status: "skipped", reason: "no-channel" }
    const lockPath = options.lockPath || path.join(slackDir, DELIVERY_LOCK_FILENAME)
    const deadline = Number.isFinite(budgetMs) ? now() + Math.max(0, budgetMs) : Infinity

    const attempt = await tryAcquireLock(lockPath, { now })
    lock = attempt.lock
    if (!lock) return { ...summary, status: "skipped", reason: attempt.reason }

    state = await readDeliveryState(slackDir)
    initialState = JSON.stringify(state)
    if (state.paused) return { ...summary, status: "paused", reason: String(state.paused.error || "") }

    const entries = await listEntries(slackDir)
    if (entries.length === 0 && Object.keys(state.cards).length === 0) return summary

    const read = await readLanesWithin(readLanes, deadline, now)
    if (read.error) return { ...summary, status: "error", reason: read.error }
    const lanes = read.lanes

    const run = {
      slackDir,
      homeDir,
      channel,
      token,
      fetchImpl,
      callTimeoutMs,
      rateLimited: false,
      now,
      sleep,
      deadline,
      lock,
      state,
      summary,
      renderContext: { ...context, repoName: context.repoName || repo.name || path.basename(String(repo.path || "")) },
    }

    const groups = new Map()
    for (const item of entries) {
      const key = String(item.entry?.laneId ?? "")
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }

    for (const [laneId, items] of groups) {
      const laneState = lanes.find((lane) => laneIdOf(lane) === laneId) || null
      const outcome = await deliverLane(run, laneId, laneState, items)
      if (outcome !== "next") {
        summary.status = outcome
        return summary
      }
    }
    const outcome = await refreshCards(run, lanes)
    if (outcome !== "next") summary.status = outcome
    return summary
  } catch (error) {
    return { ...summary, status: "error", reason: String(error?.message || error) }
  } finally {
    // Write only what this run changed, and only while the lock is still
    // ours: a holder whose lock was taken over must not overwrite the new
    // holder's state, and a run that stopped at the pause must not undo a
    // `clearPause` made meanwhile.
    if (lock && state && JSON.stringify(state) !== initialState && (await lock.stillMine().catch(() => false))) {
      await writeDeliveryState(options.slackDir, state).catch(() => {})
    }
    await lock?.release()
  }
}

// One Slack call to `channel` under the run's rules: budget, that channel's
// shared pace and Retry-After, the lock heartbeat. `channel` is where the call
// goes: an existing thread keeps the channel it was posted in, which can
// differ from the repository's current mapping. Returns `{ result }`, or
// `{ stop }` with `budget`, `ratelimited`, or `lost-lock`.
async function send(run, channel, call) {
  const minCall = Math.min(MIN_CALL_MS, run.callTimeoutMs)
  for (let tries = 0; tries < MAX_CLAIM_TRIES; tries += 1) {
    if (run.now() + minCall > run.deadline) return { stop: "budget" }
    let outcome
    try {
      // The call runs under the home lock (threads.mjs), so no other
      // repository can send on this channel between the check and the send.
      outcome = await sendOnChannel(run.homeDir, channel, {
        now: run.now,
        intervalMs: CHANNEL_INTERVAL_MS,
        waitMs: Math.min(5000, run.deadline - run.now()),
      }, async () => {
        if (!(await run.lock.touch())) return { skipped: "lost-lock" }
        const timeoutMs = Math.min(run.callTimeoutMs, run.deadline - run.now())
        // The wait for the home lock may have used up the budget.
        if (!(timeoutMs >= minCall)) return { skipped: "budget" }
        const result = await call({ token: run.token, fetchImpl: run.fetchImpl, timeoutMs })
        // Cut off by the budget, not by the call's own limit: not a failure
        // of the entry. It stays queued with no backoff.
        if (result.error === "timeout" && timeoutMs < run.callTimeoutMs) return { ...result, budgetCut: true }
        return result
      })
    } catch {
      // The home lock was not free within the budget.
      return { stop: "budget" }
    }
    if (outcome.busy) return { stop: "budget" }
    if (outcome.blockedUntil) {
      run.rateLimited = true
      return { stop: "ratelimited" }
    }
    if (outcome.result) {
      const result = outcome.result
      if (result.skipped) return { stop: result.skipped }
      if (result.status === 429 || result.error === "ratelimited") run.rateLimited = true
      if (result.budgetCut) return { stop: "budget" }
      return { result }
    }
    const wait = outcome.waitUntil - run.now()
    if (run.now() + wait + minCall > run.deadline) return { stop: "budget" }
    await run.sleep(Math.max(1, wait))
  }
  // Other senders kept taking the channel first: leave this one for later.
  return { stop: "budget" }
}

// Record a failed call for an entry. Returns `drop`, `stop-lane`, or `pause`.
function recordFailure(run, entry, result) {
  const errorClass = result.errorClass || classifySlackError(result.error)
  const id = String(entry?.id || "")
  run.state.lastError = `${result.error}${entry?.kind ? ` (${entry.kind})` : ""}`
  if (errorClass === ERROR_CLASSES.CONFIGURATION) {
    run.state.paused = { error: result.error, at: iso(run.now()) }
    return "pause"
  }
  if (errorClass === ERROR_CLASSES.ENTRY) return "drop"
  const previous = run.state.entries[id] || {}
  const attempts = (Number(previous.attempts) || 0) + 1
  // Only unknown errors count toward the drop; transient ones never do.
  const unknownAttempts = (Number(previous.unknownAttempts) || 0) + (errorClass === ERROR_CLASSES.UNKNOWN ? 1 : 0)
  if (unknownAttempts >= MAX_UNKNOWN_ATTEMPTS) return "drop"
  run.state.entries[id] = {
    attempts,
    unknownAttempts,
    nextTryAt: iso(run.now() + Math.max(result.retryAfterMs || 0, backoffMs(attempts))),
    lastError: String(result.error),
  }
  return "stop-lane"
}

async function removeItems(run, items, counter) {
  for (const item of items) {
    await removeEntry(run.slackDir, item.name)
    if (item.entry?.id) delete run.state.entries[item.entry.id]
  }
  run.summary[counter] += items.length
  run.state.counters[counter] += items.length
}

// A lane state that may be rendered on the card of claim `claimKey`: the
// lane's current state, unless it says it belongs to another claim.
function stateForClaim(laneState, claimKey) {
  if (!laneState) return null
  if (laneState.claimKey !== undefined && String(laneState.claimKey) !== String(claimKey ?? "")) return null
  return laneState
}

// Make sure the lane task has its thread: post the card if it has none.
// Returns `{ thread, fresh }`, or `{ outcome, drop }` to stop.
async function ensureThread(run, laneId, claimKey, laneState, entry) {
  const existing = await getThread(run.slackDir, laneId, claimKey)
  if (existing) return { thread: existing, fresh: false }
  const current = stateForClaim(laneState, claimKey)
  const text = renderCard(current || { lane: laneId, status: laneState ? "earlier claim" : "unknown" }, run.renderContext)
  const sent = await send(run, run.channel, (options) => postMessage({ ...options, channel: run.channel, text }))
  if (sent.stop) return { outcome: sent.stop }
  if (!sent.result.ok) return failureOutcome(run, entry, sent.result)
  const thread = { channel: run.channel, cardTs: String(sent.result.body.ts || "") }
  // The lock may have been taken over while the card was being posted. The
  // new holder may already have recorded its own card for this lane task, so
  // a holder that lost the lock must not overwrite the thread map.
  if (!(await run.lock.stillMine())) return { outcome: "lost-lock" }
  await setThread(run.slackDir, laneId, claimKey, thread)
  run.summary.cards += 1
  return { thread, fresh: Boolean(current) }
}

function failureOutcome(run, entry, result) {
  const failure = recordFailure(run, entry, result)
  if (failure === "pause") return { outcome: "paused" }
  if (failure === "drop") return { outcome: "next", drop: true }
  // A 429 holds the channel: end the run rather than try other lanes.
  if (run.rateLimited) return { outcome: "ratelimited" }
  return { outcome: "next" }
}

async function deliverLane(run, laneId, laneState, items) {
  let thread = null

  const owe = (target) => {
    run.state.cards[threadKey(laneId, target.claimKey)] = { laneId, claimKey: target.claimKey, channel: target.channel, cardTs: target.cardTs }
  }

  // Send one reply in its lane task's thread, posting the card first if the
  // task has none. Returns `{ ok }` or an outcome.
  const sendReply = async (entry, text) => {
    const claimKey = entry.claimKey
    if (!thread || thread.claimKey !== claimKey) {
      const ensured = await ensureThread(run, laneId, claimKey, laneState, entry)
      if (ensured.outcome) return ensured
      thread = { ...ensured.thread, claimKey, fresh: ensured.fresh }
    }
    if (text) {
      const sent = await send(run, thread.channel, (options) => postMessage({ ...options, channel: thread.channel, text, threadTs: thread.cardTs }))
      if (sent.stop) return { outcome: sent.stop }
      if (!sent.result.ok) {
        const outcome = failureOutcome(run, entry, sent.result)
        // A reply that is dropped (refused by Slack, or out of attempts) must
        // not also drop the card's update: the card is still owed one. A reply
        // that will be retried owes it when it is sent.
        if (outcome.drop && !thread.fresh) owe(thread)
        return outcome
      }
    }
    // A card posted in this run was rendered from current state; any other
    // card is owed a refresh until one succeeds (FR-6).
    if (!thread.fresh) owe(thread)
    return { ok: true }
  }

  // Entries that do not parse cannot be sent: drop them (FR-10).
  const broken = items.filter((item) => !item.entry)
  if (broken.length > 0) await removeItems(run, broken, "dropped")
  const pending = items.filter((item) => item.entry)

  // Entries older than 24 hours become one reply (FR-4).
  const old = pending.filter((item) => run.now() - Date.parse(item.entry.queuedAt) > COLLAPSE_AGE_MS)
  const fresh = pending.filter((item) => !old.includes(item))

  if (old.length > 0) {
    // The set grows as entries age past 24 hours, so its retry time is the
    // latest of its members': a newly aged entry never resets the wait.
    if (old.some((item) => timeOf(run.state.entries[String(item.entry.id || "")]?.nextTryAt) > run.now())) {
      run.summary.deferred += pending.length
      return "next"
    }
    const newest = old[old.length - 1].entry
    const result = await sendReply(newest, collapsedReplyText(old.length))
    if (result.ok) {
      await removeItems(run, old, "collapsed")
    } else if (result.drop) {
      await removeItems(run, old, "dropped")
    } else {
      const retry = run.state.entries[String(newest.id || "")]
      if (retry) {
        for (const item of old) run.state.entries[String(item.entry.id || "")] = { ...retry }
      }
      run.summary.deferred += pending.length
      return result.outcome
    }
  }

  for (let index = 0; index < fresh.length; index += 1) {
    const item = fresh[index]
    const entry = item.entry
    if (timeOf(run.state.entries[String(entry.id || "")]?.nextTryAt) > run.now()) {
      run.summary.deferred += fresh.length - index
      return "next"
    }
    const text = entry.reply ? renderReply({ kind: entry.kind, mention: Boolean(entry.mention), fields: entry.fields || {} }, run.renderContext) : ""
    const result = await sendReply(entry, text)
    if (result.ok) {
      await removeItems(run, [item], "sent")
      continue
    }
    if (result.drop) {
      await removeItems(run, [item], "dropped")
      continue
    }
    run.summary.deferred += fresh.length - index
    return result.outcome
  }
  return "next"
}

// Refresh every card that is owed one, from current state. A card stays owed
// until its update succeeds, so a 429, an error, or the budget only delays it.
async function refreshCards(run, lanes) {
  for (const [key, owed] of Object.entries(run.state.cards)) {
    const laneState = lanes.find((lane) => laneIdOf(lane) === String(owed.laneId ?? "")) || null
    const current = stateForClaim(laneState, owed.claimKey)
    if (!current || !owed.cardTs) {
      // Nothing current to show for that claim: leave its card as it is.
      delete run.state.cards[key]
      continue
    }
    const text = renderCard(current, run.renderContext)
    const destination = owed.channel || run.channel
    const sent = await send(run, destination, (options) => updateMessage({ ...options, channel: destination, ts: owed.cardTs, text }))
    if (sent.stop) return sent.stop
    const result = sent.result
    if (result.ok) {
      delete run.state.cards[key]
      run.summary.cards += 1
      continue
    }
    const errorClass = result.errorClass || classifySlackError(result.error)
    run.state.lastError = `${result.error} (card)`
    if (errorClass === ERROR_CLASSES.CONFIGURATION) {
      run.state.paused = { error: result.error, at: iso(run.now()) }
      return "paused"
    }
    if (CARD_GONE_ERRORS.has(result.error)) {
      await deleteThread(run.slackDir, owed.laneId, owed.claimKey)
      delete run.state.cards[key]
      continue
    }
    if (run.rateLimited) return "ratelimited"
    if (errorClass === ERROR_CLASSES.ENTRY) {
      // The card's own text was refused: retrying it would fail the same way.
      delete run.state.cards[key]
      continue
    }
    // Transient errors leave the card owed for a later run; unknown ones do
    // too, up to MAX_CARD_ATTEMPTS.
    if (errorClass === ERROR_CLASSES.UNKNOWN) {
      const attempts = (Number(owed.attempts) || 0) + 1
      if (attempts >= MAX_CARD_ATTEMPTS) delete run.state.cards[key]
      else run.state.cards[key] = { ...owed, attempts }
    }
  }
  return "next"
}
