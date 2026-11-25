// Spec 025 FR-3, FR-5, FR-6, FR-7, FR-10, FR-13 and the plan's "decide.mjs":
// every rule about what the listener does with one input lives here. Pure: it
// reads no file and makes no call, so a test can put any message against any
// state. slack/listen.mjs (WS3) only carries out the actions it returns.
//
//   decide(state, input, config, now) -> { state, actions }
//
// `state` is the inbox (slack/inbox.mjs); it is not changed, a new one is
// returned. `now` is milliseconds since the epoch. Inputs:
//
//   { kind: "message", channel, ts, threadTs, heard, command }
//       One message from a read call. `heard` is classifyInbound's result;
//       `command` is parseOperatorCommand's result when `heard` says command.
//       `threadTs` is the open thread a reply came from.
//   { kind: "proposal", channel, thread, ts, sourceTs, proposal }
//       A model's proposal whose post succeeded with `ts`. `proposal` is
//       splitModelReply's `{ verb, repo, values, canonical }`.
//   { kind: "turn-done", channel, thread }
//       An orchestrator run for the thread finished.
//   { kind: "tick" }
//       Expire proposals, close conversations, drop what aged out.
//
// Actions:
//
//   { type: "reply", channel, thread, text }        post fixed text in the thread
//   { type: "command", channel, thread, ts, verb, canonical, repo, source, proposalTs? }
//                                                   run the stored canonical text
//   { type: "turn", channel, thread, ts }           start an orchestrator run
//   { type: "pause", channel, thread }              write the pause flag; drop the rest read
//   { type: "ignored", channel, ts, reason, authors } one local log line, no text

import { parseCanonical } from "./grammar.mjs"
import { HEARD } from "./inbound.mjs"
import { normalizeInbox, pruneInbox } from "./inbox.mjs"
import { prepareAgentText } from "./text.mjs"
import { APPROVAL, DEFAULT_AUTO, runsWithoutApproval, VERBS } from "./verbs.mjs"

export const DECIDE_DEFAULTS = Object.freeze({
  approvalMinutes: 15,
  conversationMinutes: 30,
  maxTurnsPerHour: 30,
  runner: "claude -p",
})

export const REPO_DEFAULTS = Object.freeze({
  auto: DEFAULT_AUTO,
  maxActive: 3,
  maxCommandsPerHour: 20,
  retryReviewPerHour: 3,
  maxRounds: 4,
})

const HOUR_MS = 60 * 60 * 1000
// Verbs that start a loop, counted against `max_active`.
const LOOP_VERBS = new Set(["start", "retry-review"])

export const REPLIES = Object.freeze({
  modelOff: "The orchestrator model is off. Commands still work.",
  nothingToApprove: "Nothing to approve in this thread.",
  nothingToReject: "Nothing to reject in this thread.",
  rejected: "Rejected. Nothing ran.",
  cancelled: "The earlier proposal in this thread was cancelled.",
  paused: "Paused. Slack messages are ignored until `btrain slack listen --resume` is run on the machine.",
  typedOnly: (verb) => `A proposal may not run ${verb}; only the operator can type it.`,
  expired: (minutes) => `The proposal expired after ${minutes} minutes. Nothing ran.`,
  tooOld: (minutes) => `Skipped: this message is older than ${minutes} minutes, so nothing was started.`,
  invalid: (reason) => `Rejected: ${reason}. Nothing ran.`,
  limit: (what) => `Refused: ${what}. Nothing ran.`,
})

function iso(ms) {
  return new Date(ms).toISOString()
}

/** A Slack `ts` ("1700000000.000100") as milliseconds. */
export function slackTsToMs(ts) {
  const [seconds = "0", fraction = ""] = String(ts ?? "").split(".")
  return Number(seconds) * 1000 + Number(`0.${fraction || "0"}`) * 1000
}

function countRecent(times, now) {
  return (Array.isArray(times) ? times : []).filter((at) => now - Date.parse(at) < HOUR_MS).length
}

function repoConfig(config, repoPath) {
  const repos = config?.repos && typeof config.repos === "object" ? config.repos : {}
  return { ...REPO_DEFAULTS, ...(repos[repoPath] || {}) }
}

function settings(config) {
  return { ...DECIDE_DEFAULTS, ...(config || {}) }
}

// A reason that quotes message text, made safe to post.
function safe(text) {
  return prepareAgentText(text, { maxChars: 500, singleLine: true })
}

function laneOf(canonical) {
  return parseCanonical(canonical).values?.lane || ""
}

/**
 * The limit that refuses running `verb` in `repoPath` now, or "". `fromProposal`
 * adds the per-lane `retry_review_per_hour` limit for an unapproved
 * `retry-review` (FR-10).
 */
function refusal(state, config, { verb, repoPath, lane, fromProposal }, now) {
  const repo = repoConfig(config, repoPath)
  if (countRecent(state.windows.commands[repoPath], now) >= repo.maxCommandsPerHour) {
    return `${repo.maxCommandsPerHour} commands an hour for this repository`
  }
  if (LOOP_VERBS.has(verb) && state.loops.filter((loop) => loop.repo === repoPath).length >= repo.maxActive) {
    return `${repo.maxActive} loops started from Slack are already running in this repository`
  }
  if (fromProposal && verb === "retry-review" && countRecent(state.windows.retryReview[`${repoPath}#${lane}`], now) >= repo.retryReviewPerHour) {
    return `${repo.retryReviewPerHour} unapproved retry-review runs an hour for lane ${lane}`
  }
  return ""
}

function countCommand(state, { verb, repoPath, lane, fromProposal }, now) {
  const commands = state.windows.commands
  commands[repoPath] = [...(commands[repoPath] || []), iso(now)]
  if (fromProposal && verb === "retry-review") {
    const key = `${repoPath}#${lane}`
    state.windows.retryReview[key] = [...(state.windows.retryReview[key] || []), iso(now)]
  }
}

function turnRefusal(state, cfg, now) {
  if (!cfg.runner || !String(cfg.runner).trim()) return REPLIES.modelOff
  if (countRecent(state.windows.turns, now) >= cfg.maxTurnsPerHour) {
    return REPLIES.limit(`${cfg.maxTurnsPerHour} orchestrator runs an hour`)
  }
  return ""
}

function startTurn(state, actions, { channel, thread, ts }, now) {
  state.windows.turns = [...state.windows.turns, iso(now)]
  state.threads[`${channel}:${thread}`].busy = true
  actions.push({ type: "turn", channel, thread, ts })
}

function handleCommand(state, config, input, thread, actions, now) {
  const { channel, ts } = input
  const command = input.command
  if (!command?.ok) {
    actions.push({ type: "reply", channel, thread, text: REPLIES.invalid(safe(command?.reason || "not a command")) })
    return
  }
  if (command.verb === "pause") {
    actions.push({ type: "pause", channel, thread })
    actions.push({ type: "reply", channel, thread, text: REPLIES.paused })
    return
  }
  const repoPath = command.repo.path
  const job = { verb: command.verb, repoPath, lane: command.values?.lane || "", fromProposal: false }
  const refused = refusal(state, config, job, now)
  if (refused) {
    actions.push({ type: "reply", channel, thread, text: REPLIES.limit(refused) })
    return
  }
  countCommand(state, job, now)
  actions.push({ type: "command", channel, thread, ts, verb: command.verb, canonical: command.canonical, repo: repoPath, source: "operator" })
}

function handleApproval(state, config, input, threadTs, actions, now) {
  const { channel } = input
  const threadKey = `${channel}:${threadTs}`
  const thread = state.threads[threadKey]
  const pendingTs = thread?.pending || ""
  const proposalKey = `${channel}:${pendingTs}`
  const proposal = pendingTs ? state.proposals[proposalKey] : null
  const pending = proposal && proposal.state === "pending"
  if (input.heard.approval === "reject") {
    if (!pending) {
      actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.nothingToReject })
      return
    }
    proposal.state = "rejected"
    thread.pending = null
    actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.rejected })
    return
  }
  if (!pending) {
    actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.nothingToApprove })
    return
  }
  // `approve` checks the expiry itself, not the tick that marks it later.
  if (now >= Date.parse(proposal.expiresAt)) {
    proposal.state = "expired"
    thread.pending = null
    actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.expired(settings(config).approvalMinutes) })
    return
  }
  const verb = parseCanonical(proposal.canonical).verb
  const job = { verb, repoPath: proposal.repo, lane: laneOf(proposal.canonical), fromProposal: false }
  const refused = refusal(state, config, job, now)
  if (refused) {
    actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.limit(refused) })
    return
  }
  proposal.state = "approved"
  thread.pending = null
  countCommand(state, job, now)
  actions.push({
    type: "command", channel, thread: threadTs, ts: input.ts, verb,
    canonical: proposal.canonical, repo: proposal.repo, source: "orchestrator", proposalTs: pendingTs,
  })
}

function handleMessage(state, config, input, now) {
  const cfg = settings(config)
  const actions = []
  const { channel, ts } = input
  const key = `${channel}:${ts}`
  if (Object.hasOwn(state.handled, key)) return actions
  // Record first, then act (FR-7): the caller writes this state before it
  // starts anything the actions name.
  state.handled[key] = iso(now)

  const heard = input.heard || { heard: HEARD.IGNORED, reason: "unclassified", authors: {} }
  if (heard.heard === HEARD.IGNORED) {
    actions.push({ type: "ignored", channel, ts, reason: heard.reason, authors: heard.authors || {} })
    return actions
  }
  const fromThread = heard.heard === HEARD.TURN || heard.heard === HEARD.APPROVAL || Boolean(input.threadTs)
  const threadTs = fromThread ? input.threadTs : ts
  if (now - slackTsToMs(ts) > cfg.approvalMinutes * 60 * 1000) {
    actions.push({ type: "reply", channel, thread: threadTs || ts, text: REPLIES.tooOld(cfg.approvalMinutes) })
    return actions
  }
  const openThread = threadTs ? state.threads[`${channel}:${threadTs}`] : null
  if (openThread && fromThread) openThread.lastOperatorTs = ts

  switch (heard.heard) {
    case HEARD.COMMAND:
      handleCommand(state, config, input, threadTs || ts, actions, now)
      break
    case HEARD.APPROVAL:
      handleApproval(state, config, input, threadTs, actions, now)
      break
    case HEARD.CONVERSATION: {
      const refused = turnRefusal(state, cfg, now)
      if (refused) {
        actions.push({ type: "reply", channel, thread: ts, text: refused })
        break
      }
      state.threads[`${channel}:${ts}`] = { lastOperatorTs: ts, replyCursor: ts, busy: false, queued: [], pending: null }
      startTurn(state, actions, { channel, thread: ts, ts }, now)
      break
    }
    case HEARD.TURN: {
      if (!openThread) break
      const refused = turnRefusal(state, cfg, now)
      if (openThread.busy) {
        // One run at a time for a thread: this one waits for the reply.
        openThread.queued = [...openThread.queued, ts]
        break
      }
      if (refused) {
        actions.push({ type: "reply", channel, thread: threadTs, text: refused })
        break
      }
      startTurn(state, actions, { channel, thread: threadTs, ts }, now)
      break
    }
    default:
      break
  }
  return actions
}

function handleProposal(state, config, input, now) {
  const cfg = settings(config)
  const actions = []
  const { channel, thread: threadTs, ts, proposal } = input
  const threadKey = `${channel}:${threadTs}`
  const thread = state.threads[threadKey] || (state.threads[threadKey] = { lastOperatorTs: threadTs, replyCursor: threadTs, busy: false, queued: [], pending: null })
  const verb = proposal?.verb
  const definition = Object.hasOwn(VERBS, verb || "") ? VERBS[verb] : null
  if (!definition || definition.approval === APPROVAL.TYPED_ONLY) {
    actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.typedOnly(safe(verb || "that")) })
    return actions
  }
  // One pending proposal for a thread: a new one cancels the earlier.
  if (thread.pending) {
    const earlier = state.proposals[`${channel}:${thread.pending}`]
    if (earlier && earlier.state === "pending") earlier.state = "cancelled"
    thread.pending = null
    actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.cancelled })
  }
  const repoPath = proposal.repo?.path ?? proposal.repo
  const record = {
    thread: threadTs,
    repo: repoPath,
    canonical: proposal.canonical,
    source: "orchestrator",
    sourceTs: input.sourceTs || "",
    expiresAt: iso(now + cfg.approvalMinutes * 60 * 1000),
    state: "pending",
  }
  if (runsWithoutApproval(verb, repoConfig(config, repoPath).auto)) {
    const job = { verb, repoPath, lane: proposal.values?.lane || "", fromProposal: true }
    const refused = refusal(state, config, job, now)
    if (refused) {
      actions.push({ type: "reply", channel, thread: threadTs, text: REPLIES.limit(refused) })
      return actions
    }
    state.proposals[`${channel}:${ts}`] = { ...record, state: "approved" }
    countCommand(state, job, now)
    actions.push({ type: "command", channel, thread: threadTs, ts, verb, canonical: proposal.canonical, repo: repoPath, source: "orchestrator", proposalTs: ts })
    return actions
  }
  state.proposals[`${channel}:${ts}`] = record
  thread.pending = ts
  return actions
}

function handleTurnDone(state, config, input, now) {
  const cfg = settings(config)
  const actions = []
  const thread = state.threads[`${input.channel}:${input.thread}`]
  if (!thread) return actions
  thread.busy = false
  while (thread.queued.length > 0) {
    const next = thread.queued[0]
    thread.queued = thread.queued.slice(1)
    const refused = turnRefusal(state, cfg, now)
    if (refused) {
      actions.push({ type: "reply", channel: input.channel, thread: input.thread, text: refused })
      continue
    }
    startTurn(state, actions, { channel: input.channel, thread: input.thread, ts: next }, now)
    break
  }
  return actions
}

function handleTick(state, config, now) {
  const cfg = settings(config)
  const actions = []
  for (const [key, proposal] of Object.entries(state.proposals)) {
    if (proposal.state !== "pending" || now < Date.parse(proposal.expiresAt)) continue
    proposal.state = "expired"
    const channel = key.slice(0, key.indexOf(":"))
    const thread = state.threads[`${channel}:${proposal.thread}`]
    if (thread && thread.pending === key.slice(key.indexOf(":") + 1)) thread.pending = null
    actions.push({ type: "reply", channel, thread: proposal.thread, text: REPLIES.expired(cfg.approvalMinutes) })
  }
  for (const [key, thread] of Object.entries(state.threads)) {
    if (thread.busy || thread.pending) continue
    if (now - slackTsToMs(thread.lastOperatorTs) > cfg.conversationMinutes * 60 * 1000) delete state.threads[key]
  }
  return { state: pruneInbox(state, now), actions }
}

/** One input against the state. Returns the new state and the actions, in order. */
export function decide(state, input, config = {}, now = Date.now()) {
  const next = normalizeInbox(structuredClone(state || {}))
  switch (input?.kind) {
    case "message":
      return { state: next, actions: handleMessage(next, config, input, now) }
    case "proposal":
      return { state: next, actions: handleProposal(next, config, input, now) }
    case "turn-done":
      return { state: next, actions: handleTurnDone(next, config, input, now) }
    case "tick":
      return handleTick(next, config, now)
    default:
      return { state: next, actions: [] }
  }
}
