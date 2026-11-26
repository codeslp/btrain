// Spec 025 FR-11 and the plan's "Data model": the listener's state file,
// `<btrain home>/slack/inbox.json`. Only the listener writes it. Imports
// nothing from core.mjs: the caller passes the directory, which
// `BRAIN_TRAIN_HOME` moves.
//
// The file is written to a temporary name beside it, with mode 0600, and
// renamed into place, so a reader never sees half a file. The write is
// synchronous end to end: the listener reads its lease nonce in
// `beforeRename` and nothing can run between that read and the rename (plan,
// "listen.lock").
//
// No message text from Slack is stored here.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const INBOX_FILE = "inbox.json"
export const INBOX_VERSION = 1
export const HANDLED_KEEP_MS = 48 * 60 * 60 * 1000
export const WINDOW_MS = 60 * 60 * 1000
export const RESULTS_KEEP = 20
// A handled `ts` is kept 48 hours and a cursor never moves back more than 24,
// so `approvalMinutes` above 24 hours could let a forgotten message be read
// and acted on again.
export const MAX_APPROVAL_MINUTES = 24 * 60
const FINAL_PROPOSAL_KEEP_MS = 48 * 60 * 60 * 1000

export function emptyInbox() {
  return {
    version: INBOX_VERSION,
    channels: {},
    threads: {},
    handled: {},
    proposals: {},
    results: {},
    windows: { commands: {}, retryReview: {}, turns: [] },
    loops: [],
    outgoing: [],
    // When the listener handled `btrain> pause` (ISO time), or "". Resuming
    // moves every cursor to the time of the resume (plan, "listen.paused").
    paused: "",
  }
}

function objectOr(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback
}

/** Fill in any part a file is missing, so callers never meet `undefined`. */
export function normalizeInbox(raw) {
  const base = emptyInbox()
  const state = objectOr(raw, {})
  const windows = objectOr(state.windows, {})
  return {
    version: INBOX_VERSION,
    channels: objectOr(state.channels, base.channels),
    threads: objectOr(state.threads, base.threads),
    handled: objectOr(state.handled, base.handled),
    proposals: objectOr(state.proposals, base.proposals),
    results: objectOr(state.results, base.results),
    windows: {
      commands: objectOr(windows.commands, {}),
      retryReview: objectOr(windows.retryReview, {}),
      turns: Array.isArray(windows.turns) ? windows.turns : [],
    },
    loops: Array.isArray(state.loops) ? state.loops : [],
    outgoing: Array.isArray(state.outgoing) ? state.outgoing : [],
    paused: typeof state.paused === "string" ? state.paused : "",
  }
}

export function inboxPath(slackDir) {
  return path.join(slackDir, INBOX_FILE)
}

/**
 * Read the state file. A missing file is an empty state. A file that does not
 * parse, or has another version, is reported in `error` and an empty state is
 * returned; the caller decides whether to go on. Temporary files beside it
 * are never read.
 */
export function loadInbox(slackDir) {
  const file = inboxPath(slackDir)
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return { state: emptyInbox(), error: "" }
    throw error
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { state: emptyInbox(), error: `${INBOX_FILE} does not parse` }
  }
  if (raw?.version !== INBOX_VERSION) {
    return { state: emptyInbox(), error: `${INBOX_FILE} has version ${raw?.version}, expected ${INBOX_VERSION}` }
  }
  return { state: normalizeInbox(raw), error: "" }
}

/**
 * Write the state file: a temporary file with mode 0600, then a rename.
 * `beforeRename()` runs after the data is on disk and before the rename, with
 * nothing in between; when it returns false the temporary file is removed and
 * nothing is renamed. Returns true when the file was replaced.
 */
export function writeInbox(slackDir, state, { beforeRename } = {}) {
  fs.mkdirSync(slackDir, { recursive: true, mode: 0o700 })
  const target = inboxPath(slackDir)
  const temp = path.join(slackDir, `.${INBOX_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`)
  const fd = fs.openSync(temp, "wx", 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify(normalizeInbox(state), null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // The mode given to open is masked by the umask; set it outright.
  fs.chmodSync(temp, 0o600)
  let proceed = true
  try {
    proceed = beforeRename ? beforeRename() !== false : true
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
  if (!proceed) {
    fs.rmSync(temp, { force: true })
    return false
  }
  fs.renameSync(temp, target)
  return true
}

function recent(times, now, keepMs) {
  return (Array.isArray(times) ? times : []).filter((iso) => {
    const at = Date.parse(iso)
    return Number.isFinite(at) && now - at < keepMs
  })
}

/**
 * Drop what has aged out: `handled` entries after 48 hours, window times after
 * an hour, finished proposals 48 hours after they expired, and results beyond
 * the last 20 for each repository. Returns a new state.
 */
export function pruneInbox(state, now = Date.now()) {
  const next = normalizeInbox(structuredClone(state))
  for (const [key, iso] of Object.entries(next.handled)) {
    const at = Date.parse(iso)
    if (!Number.isFinite(at) || now - at >= HANDLED_KEEP_MS) delete next.handled[key]
  }
  next.windows.turns = recent(next.windows.turns, now, WINDOW_MS)
  for (const group of ["commands", "retryReview"]) {
    for (const [key, times] of Object.entries(next.windows[group])) {
      const kept = recent(times, now, WINDOW_MS)
      if (kept.length > 0) next.windows[group][key] = kept
      else delete next.windows[group][key]
    }
  }
  for (const [key, proposal] of Object.entries(next.proposals)) {
    const expires = Date.parse(proposal?.expiresAt)
    if (proposal?.state !== "pending" && (!Number.isFinite(expires) || now - expires >= FINAL_PROPOSAL_KEEP_MS)) {
      delete next.proposals[key]
    }
  }
  for (const [repo, results] of Object.entries(next.results)) {
    next.results[repo] = (Array.isArray(results) ? results : []).slice(-RESULTS_KEEP)
  }
  return next
}

/** Add one command result for a repository, keeping the last 20. Returns a new state. */
export function recordResult(state, repo, result) {
  const next = normalizeInbox(structuredClone(state))
  const list = Array.isArray(next.results[repo]) ? next.results[repo] : []
  next.results[repo] = [...list, { ...result }].slice(-RESULTS_KEEP)
  return next
}

/**
 * Check `approvalMinutes`. Returns the reason it is refused, or "". A value
 * above 24 hours is a configuration error (FR-11).
 */
export function checkApprovalMinutes(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return "approvalMinutes must be a positive number of minutes"
  if (number > MAX_APPROVAL_MINUTES) return `approvalMinutes may not be above ${MAX_APPROVAL_MINUTES} (24 hours)`
  return ""
}
