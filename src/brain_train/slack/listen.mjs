// Spec 025 WS3 (T017, T018) and the plan's "The cycle": the listener. Every
// `pollSeconds`, in order:
//
//   1. Check the lease and the stop flag.
//   2. Collect finished children (none until WS5).
//   3. Unless paused: read each served channel and each open thread inside
//      the read budget, oldest first. For each message, ask decide.mjs what
//      to do, write the state (handled set included), and only then act.
//   4. Expire proposals and close conversations past their time.
//   5. Send replies whose post failed earlier.
//   6. Drain each served repository's spec 024 outbox, also while paused.
//   7. Every sixth cycle, read the registry and the toggles again.
//
// In this workstream a mention is answered with a note that the model is
// not built yet, and a command with a note that commands are not built yet
// (FR-1). `btrain> pause` works: it writes the pause flag and drops the rest
// of what was read. Removing the flag (`--resume`) moves every channel
// cursor and every open thread's reply cursor to the time of the resume, so
// nothing sent during the pause is handled.
//
// Every state write checks the lease nonce last, synchronously, before the
// rename (inbox.mjs, lease.mjs). A listener whose lease is gone writes
// nothing and acts on nothing. No message text is logged or stored. Lane and
// repository state come only through the reader functions (`readers`), so
// nothing here imports core.mjs.

import fs from "node:fs/promises"
import path from "node:path"
import { authTest, classifySlackError, ERROR_CLASSES, postMessage } from "./client.mjs"
import { getListenerSettings, servedRepositories } from "./config.mjs"
import { loadSlackCredentials } from "./credentials.mjs"
import { compareTs, decide, slackTsToMs } from "./decide.mjs"
import { parseOperatorCommand } from "./grammar.mjs"
import { classifyInbound, HEARD, SOURCES } from "./inbound.mjs"
import { checkApprovalMinutes, loadInbox, writeInbox } from "./inbox.mjs"
import { consumeStop, isPaused, setPaused, startLeaseTimer, stopRequested, takeLease } from "./lease.mjs"
import { createReader } from "./read-client.mjs"
import { deliverToTarget, deliveryTarget } from "./target.mjs"

/** The fixed notes of this workstream (FR-1): what is not built yet. */
export const LISTEN_NOTES = Object.freeze({
  modelNotBuilt: "The orchestrator model is not built yet. Nothing ran.",
  commandsNotBuilt: "Commands typed in Slack are not built yet. Nothing ran.",
})

const DAY_MS = 24 * 60 * 60 * 1000
// Read the registry and the toggles again every this many cycles (step 7).
export const RELOAD_EVERY_CYCLES = 6
const MAX_OUTGOING_ATTEMPTS = 5
const OUTGOING_BACKOFF_MS = 30_000
// Author fields are logged only when they look like Slack IDs.
const SAFE_FIELD = /^[A-Za-z0-9._-]+$/

function tsOf(ms) {
  return `${Math.floor(ms / 1000)}.${String(Math.floor(ms) % 1000).padStart(3, "0")}000`
}

// A cursor more than 25 hours old moves to 24 hours ago: the handled set
// keeps a ts for 48 hours, so nothing read again is acted on twice. The hour
// of slack keeps a clamped cursor still while a read longer than one minute
// of budget pages from it (read-client resumes a read only for the same
// lower bound).
const CLAMP_SLACK_MS = 60 * 60 * 1000

function clampedCursor(cursor, nowMs) {
  return nowMs - slackTsToMs(cursor) > DAY_MS + CLAMP_SLACK_MS ? tsOf(nowMs - DAY_MS) : cursor
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function field(value) {
  return typeof value === "string" && SAFE_FIELD.test(value) ? value : "-"
}

// The registered repositories of this btrain home, `[{ path, name }]`.
async function readRegistry(home) {
  try {
    const registry = JSON.parse(await fs.readFile(path.join(home, "repos.json"), "utf8"))
    const repos = Array.isArray(registry?.repos) ? registry.repos : []
    return repos.filter((repo) => repo && typeof repo.path === "string" && repo.enabled !== false)
  } catch {
    return []
  }
}

/**
 * Build a listener for one btrain home. Options: `home`, `fetch`, `env`,
 * `readers` (from slack-readers.mjs: `readConfig`, `readLanes`, `readRoster`;
 * loaded when not given), `cliPath`, `now`, and `log` (one line for each
 * action, never message text). Rejects when the settings are invalid, such
 * as `approvalMinutes` above 24 hours.
 *
 * Returns `{ operator, token, runner, pollSeconds, served, acquire(),
 * cycle(), stop() }`. `cycle()` resolves with `{ status }`: `ok`,
 * `stopped` (the stop flag), or `lost-lease`.
 */
export async function createListener({
  home,
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  readers,
  cliPath = "",
  now = Date.now,
  log = () => {},
} = {}) {
  const homeEnv = { ...env, BRAIN_TRAIN_HOME: home }
  const slackDir = path.join(home, "slack")
  const credentials = await loadSlackCredentials({ env: homeEnv })
  const listening = getListenerSettings(credentials.settings)
  const approvalProblem = checkApprovalMinutes(listening.orchestrator.approvalMinutes)
  if (approvalProblem) throw new Error(`slack.json orchestrator: ${approvalProblem}`)
  const reading = readers || (await import("../slack-readers.mjs")).buildSlackReaders({ cliPath })
  const token = credentials.token || ""
  const operator = listening.operator

  let served = []
  let rosters = new Map()
  const loadServed = async () => {
    const repos = []
    for (const repo of await readRegistry(home)) {
      try {
        repos.push({ path: repo.path, name: repo.name, config: await reading.readConfig(repo.path) })
      } catch {
        // A repository whose config cannot be read is not served this time.
      }
    }
    served = servedRepositories(repos, credentials.settings)
    rosters = new Map()
    for (const repo of served) {
      rosters.set(repo.path, await Promise.resolve().then(() => reading.readRoster?.(repo.path)).catch(() => null) || { laneIds: [], agents: [] })
    }
  }
  await loadServed()

  let botUserId = ""
  if (token) {
    const auth = await authTest({ token, fetchImpl })
    if (auth.ok) botUserId = String(auth.body?.user_id || "")
    else log(`auth.test failed: ${field(auth.error)}`)
  }

  // The state as the file holds it. No run survives the process that started
  // it, so a thread a crash left busy, or with messages queued for a run, is
  // made idle again: its conversation then closes by its age.
  const readState = () => {
    const loaded = loadInbox(slackDir)
    if (loaded.error) log(`inbox: ${loaded.error}; starting from an empty state`)
    for (const [key, thread] of Object.entries(loaded.state.threads)) {
      if (thread?.busy || thread?.queued?.length) {
        loaded.state.threads[key] = { ...thread, busy: false, queued: [] }
        log(`conversation ${key.replace(":", " ")}: its interrupted turn was dropped`)
      }
    }
    return loaded.state
  }
  let state = readState()
  let lease = null
  let stopTimer = () => {}
  let lost = false

  // True while this listener may act: its lease file still holds its
  // record. Read synchronously, so nothing runs between the check and the
  // call that follows it.
  const stillMine = () => {
    if (lost) return false
    if (lease && !lease.isMineSync()) lost = true
    return !lost
  }
  // Every Slack call the listener makes goes through here: its reads, its
  // replies, and the publisher's calls inside deliver. A takeover stops the
  // next call, wherever the await before it was.
  const guardedFetch = (input, init) => (stillMine()
    ? fetchImpl(input, init)
    : Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "LEASE_LOST" } })))
  const reader = createReader({ token, fetchImpl: guardedFetch, now })
  let cycles = 0
  let readingStopped = false
  const stoppedChannels = new Set()

  const decideConfig = () => ({
    runner: listening.orchestrator.runner,
    approvalMinutes: listening.orchestrator.approvalMinutes,
    conversationMinutes: listening.orchestrator.conversationMinutes,
    maxTurnsPerHour: listening.orchestrator.maxTurnsPerHour,
    repos: Object.fromEntries(served.map((repo) => [repo.path, repo.options])),
  })

  // Write the state, last checking that the lease is still this listener's.
  // False when the lease is gone: nothing was written and nothing may act.
  const persist = (next) => {
    if (lost) return false
    const written = writeInbox(slackDir, next, { beforeRename: () => !lease || lease.isMineSync() })
    if (!written) {
      lost = true
      return false
    }
    state = next
    return true
  }

  const change = (mutate) => {
    const next = structuredClone(state)
    mutate(next)
    return persist(next)
  }

  const post = async (channel, thread, text) => {
    const result = await postMessage({ token, fetchImpl: guardedFetch, channel, text, threadTs: thread })
    if (lost) return
    if (result.ok) {
      log(`replied in ${channel} ${thread}`)
      return
    }
    const errorClass = result.errorClass || classifySlackError(result.error)
    if (errorClass === ERROR_CLASSES.TRANSIENT || errorClass === ERROR_CLASSES.UNKNOWN) {
      log(`reply in ${channel} ${thread} failed (${field(result.error)}); it will be tried again`)
      change((next) => next.outgoing.push({ channel, thread, text, attempts: 1, nextTryAt: iso(now() + OUTGOING_BACKOFF_MS), proposal: null }))
      return
    }
    log(`reply in ${channel} ${thread} dropped (${field(result.error)})`)
  }

  // Carry out decide's actions, in order, after their state was written.
  let pausedThisCycle = false
  const act = async (actions) => {
    for (const action of actions) {
      if (!stillMine()) return
      switch (action.type) {
        case "reply":
          await post(action.channel, action.thread, action.text)
          break
        case "command":
          log(`command ${field(action.verb)} from ${action.channel} ${action.ts}: not built yet`)
          await post(action.channel, action.thread, LISTEN_NOTES.commandsNotBuilt)
          break
        case "turn": {
          log(`conversation turn in ${action.channel} ${action.thread}: the model is not built yet`)
          await post(action.channel, action.thread, LISTEN_NOTES.modelNotBuilt)
          const done = decide(state, { kind: "turn-done", channel: action.channel, thread: action.thread }, decideConfig(), now())
          if (!persist(done.state)) return
          await act(done.actions)
          break
        }
        case "pause":
          await setPaused(slackDir)
          change((next) => {
            next.paused = iso(now())
          })
          pausedThisCycle = true
          log(`paused by ${action.channel} ${action.thread}`)
          break
        case "ignored": {
          const authors = action.authors || {}
          log(`ignored ${action.channel} ${action.ts}: ${action.reason} (user=${field(authors.user)} app_id=${field(authors.app_id)} bot_id=${field(authors.bot_id)} subtype=${field(authors.subtype)})`)
          break
        }
        default:
          break
      }
    }
  }

  // One message: decide, record, act. Returns false to stop reading this
  // cycle (the lease is gone, or the message paused the listener).
  const handle = async (input) => {
    const { state: next, actions } = decide(state, input, decideConfig(), now())
    if (!persist(next)) return false
    await act(actions)
    return !lost && !pausedThisCycle
  }

  const channelContext = (channel) => ({
    repos: served.filter((repo) => repo.channel === channel).map((repo) => ({
      name: repo.name,
      path: repo.path,
      ...(rosters.get(repo.path) || { laneIds: [], agents: [] }),
    })),
  })

  const readFailed = (result, where, onThread) => {
    log(`read of ${where} failed (${field(result.error)})`)
    if (result.action === "stop-all") readingStopped = true
    else if (result.action === "stop-channel") stoppedChannels.add(where.split(" ")[0])
    else if (result.action === "close-thread") onThread?.()
  }

  // A reply sent after an idle conversation expired: it is not answered, and
  // the tick closes the conversation.
  const expiredBefore = (thread, ts) => !thread.busy && !thread.pending
    && slackTsToMs(ts) - slackTsToMs(thread.lastOperatorTs) > listening.orchestrator.conversationMinutes * 60 * 1000

  // A message the cursor's floor excludes: one sent before a resume, which
  // must not be handled even though the read overlap returns it.
  const beforeFloor = (ts, floor) => Boolean(floor) && compareTs(ts, floor) < 0

  const readChannel = async (channel) => {
    let entry = state.channels[channel]
    const nowMs = now()
    if (!entry?.cursor) {
      // A channel with no saved cursor starts at the current time (the read
      // overlap still covers the minute before).
      entry = { cursor: tsOf(nowMs) }
    } else {
      entry = { ...entry, cursor: clampedCursor(entry.cursor, nowMs) }
    }
    // Kept in memory; the cycle's next state write, which checks the lease,
    // saves it.
    state.channels[channel] = entry
    const result = await reader.readChannel(channel, entry.cursor)
    if (result.deferred) return true
    if (!result.ok) {
      readFailed(result, channel)
      return true
    }
    const context = channelContext(channel)
    for (const message of result.messages) {
      if (beforeFloor(message?.ts, entry.floor)) continue
      const heard = classifyInbound(message, { operator, botUserId, source: SOURCES.HISTORY })
      const command = heard.heard === HEARD.COMMAND ? parseOperatorCommand(message.text, context) : undefined
      if (compareTs(message.ts, state.channels[channel]?.cursor) > 0) state.channels[channel] = { ...state.channels[channel], cursor: message.ts }
      if (!(await handle({ kind: "message", channel, ts: message.ts, threadTs: "", heard, command }))) return false
    }
    return true
  }

  const readThreads = async (channel) => {
    const prefix = `${channel}:`
    const nowMs = now()
    const open = []
    for (const [key, thread] of Object.entries(state.threads)) {
      if (!key.startsWith(prefix)) continue
      // The same 24-hour floor as a channel's, kept in the state so a long
      // read pages from one lower bound.
      const replyCursor = clampedCursor(thread.replyCursor || thread.lastOperatorTs, nowMs)
      if (replyCursor !== thread.replyCursor) state.threads[key] = { ...thread, replyCursor }
      open.push({ threadTs: key.slice(prefix.length), cursorTs: replyCursor })
    }
    const { results } = await reader.readThreads(channel, open)
    const context = channelContext(channel)
    for (const { threadTs, result } of results) {
      const key = `${prefix}${threadTs}`
      if (!result.ok) {
        readFailed(result, `${channel} ${threadTs}`, () => change((next) => { delete next.threads[key] }))
        continue
      }
      for (const message of result.messages) {
        const thread = state.threads[key]
        if (!thread) break
        if (beforeFloor(message?.ts, thread.floor)) continue
        if (expiredBefore(thread, message?.ts)) continue
        const heard = classifyInbound(message, { operator, botUserId, source: SOURCES.REPLIES, parentTs: threadTs })
        const command = heard.heard === HEARD.COMMAND ? parseOperatorCommand(message.text, context) : undefined
        if (compareTs(message.ts, thread.replyCursor) > 0) state.threads[key] = { ...thread, replyCursor: message.ts }
        if (!(await handle({ kind: "message", channel, ts: message.ts, threadTs, heard, command }))) return false
      }
    }
    return true
  }

  // After a resume: every cursor moves to now, so nothing sent during the
  // pause is handled, in a channel or in an open thread.
  const resume = () => change((next) => {
    const nowTs = tsOf(now())
    for (const channel of Object.keys(next.channels)) next.channels[channel] = { ...next.channels[channel], cursor: nowTs, floor: nowTs }
    for (const key of Object.keys(next.threads)) next.threads[key] = { ...next.threads[key], replyCursor: nowTs, floor: nowTs }
    next.paused = ""
    log("resumed")
  })

  const retryOutgoing = async () => {
    const due = state.outgoing.filter((item) => Date.parse(item.nextTryAt) <= now())
    for (const item of due) {
      if (!stillMine()) return
      const result = await postMessage({ token, fetchImpl: guardedFetch, channel: item.channel, text: item.text, threadTs: item.thread })
      change((next) => {
        const index = next.outgoing.findIndex((entry) => entry.channel === item.channel && entry.thread === item.thread && entry.text === item.text && entry.nextTryAt === item.nextTryAt)
        if (index < 0) return
        const attempts = (Number(item.attempts) || 0) + 1
        if (result.ok || attempts >= MAX_OUTGOING_ATTEMPTS) next.outgoing.splice(index, 1)
        else next.outgoing[index] = { ...item, attempts, nextTryAt: iso(now() + OUTGOING_BACKOFF_MS * attempts) }
      })
      log(result.ok ? `replied in ${item.channel} ${item.thread} (retry)` : `retry in ${item.channel} ${item.thread} failed (${field(result.error)})`)
    }
  }

  // Step 6: each served repository's spec 024 outbox, within half the poll
  // interval. Delivery keeps its own pace on the real clock.
  const drainOutboxes = async () => {
    for (const repo of served) {
      if (!stillMine()) return
      try {
        const config = await reading.readConfig(repo.path)
        const target = await deliveryTarget(repo.path, config, { env: homeEnv })
        if (!target.token || !target.channel) continue
        if (!(await fs.stat(target.slackDir).then((stat) => stat.isDirectory(), () => false))) continue
        const summary = await deliverToTarget(target, {
          readLanes: () => reading.readLanes(repo.path),
          fetchImpl: guardedFetch,
          budgetMs: (listening.pollSeconds * 1000) / 2,
        })
        if (summary.sent || summary.cards) log(`outbox of ${repo.name}: sent ${summary.sent}, cards ${summary.cards}`)
      } catch (error) {
        log(`outbox of ${repo.name}: delivery failed (${field(error?.code)})`)
      }
    }
  }

  const listener = {
    operator,
    token,
    runner: listening.orchestrator.runner,
    pollSeconds: listening.pollSeconds,
    get served() {
      return served
    },

    /** Take the lease for this btrain home: `{ ok, reason, holder }`. */
    async acquire() {
      if (!operator) return { ok: false, reason: "no-operator", holder: null }
      const taken = await takeLease(slackDir, { operator })
      if (!taken.lease) return { ok: false, reason: taken.reason, holder: taken.holder }
      lease = taken.lease
      // Another listener may have written the state since this one was built.
      state = readState()
      stopTimer = startLeaseTimer(lease, { onLost: () => { lost = true } })
      return { ok: true, reason: taken.reason, holder: taken.holder }
    },

    /** One cycle of the plan's seven steps. */
    async cycle() {
      if (lost || (lease && !lease.isMineSync())) {
        lost = true
        stopTimer()
        return { status: "lost-lease" }
      }
      if (await stopRequested(slackDir)) {
        await consumeStop(slackDir)
        await listener.stop()
        return { status: "stopped" }
      }
      cycles += 1
      pausedThisCycle = false
      const paused = await isPaused(slackDir)
      if (!paused && state.paused && !resume()) return { status: "lost-lease" }
      if (!paused && !readingStopped && token) {
        const channels = [...new Set(served.map((repo) => repo.channel))].filter((channel) => !stoppedChannels.has(channel))
        for (const channel of channels) {
          if (!(await readChannel(channel)) || !(await readThreads(channel))) break
        }
        if (lost) return { status: "lost-lease" }
      }
      const tick = decide(state, { kind: "tick" }, decideConfig(), now())
      if (!persist(tick.state)) return { status: "lost-lease" }
      await act(tick.actions)
      await retryOutgoing()
      if (lost) return { status: "lost-lease" }
      await drainOutboxes()
      if (lost) return { status: "lost-lease" }
      if (cycles % RELOAD_EVERY_CYCLES === 0) await loadServed()
      return { status: "ok", paused: paused || pausedThisCycle }
    },

    /** Stop the lease timer and release the lease. */
    async stop() {
      stopTimer()
      if (lease && !lost) await lease.release()
      lease = null
    },
  }
  return listener
}
