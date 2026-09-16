/**
 * Context budget: measure how much context a lane's agent session is carrying,
 * and decide whether that is worth a warning or a block.
 *
 * Spec 020 workstream 3. The measurement behind it: cache reads are ~72% of
 * btrain's token cost, and cache reads scale with context size multiplied by
 * turn count. `CLAUDE.md` already asks agents to clear context at natural
 * stopping points; the transcripts show they do not. btrain enforces its review
 * gates mechanically, and it can enforce this the same way.
 *
 * ## The attribution problem, and why this module is careful about it
 *
 * btrain runs as a CLI *inside* an agent session, and nothing in the environment
 * reliably names that session. `CLAUDE_CODE_HOST_SESSION_ID` exists but does not
 * match the transcript filename. So the session has to be identified, and a
 * wrong identification would block a lane on some other session's context.
 *
 * This module therefore reports **how** it identified the session, and the
 * caller is expected to act on that. Only an unambiguous attribution may block:
 *
 *   - `explicit`   the caller named the session. Trusted.
 *   - `inferred`   exactly one transcript was written recently enough to be a
 *                  live session. Trusted.
 *   - `ambiguous`  several sessions are live in this repo, which is the normal
 *                  state for multi-lane work. Warn, never block: we cannot tell
 *                  which one is asking.
 *   - `unavailable` no transcripts, or none recent. Say nothing.
 *
 * Absence of a reading is not a reading of zero. An unavailable measurement
 * produces `level: "ok"` with a stated reason, never a silent pass that looks
 * like a healthy session.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Tokens of context above which a session gets a warning. */
const DEFAULT_SOFT_CEILING = 200_000
/** Tokens of context above which a lane may not advance to `needs-review`. */
const DEFAULT_HARD_CEILING = 400_000
/**
 * How recently a transcript must have been written to count as a live session.
 * Generous on purpose: a slow turn, a long tool call, or a user reading the
 * screen can all leave a real session idle for minutes, and treating it as dead
 * would silently drop the measurement.
 */
const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000

/** Attribution confidence levels that may drive a hard block. */
const BLOCKING_SOURCES = Object.freeze(["explicit", "inferred"])

/**
 * Claude Code stores transcripts under a directory named for the repo path,
 * with every separator replaced by a hyphen and a leading hyphen for the root.
 * `/Users/x/btrain` becomes `-Users-x-btrain`.
 */
function encodeRepoPath(repoRoot) {
  return "-" + path.resolve(repoRoot).replace(/^\/+/, "").replace(/\//g, "-")
}

function resolveTranscriptDir(repoRoot, env = process.env) {
  if (env.BTRAIN_TRANSCRIPT_DIR) return env.BTRAIN_TRANSCRIPT_DIR
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
  return path.join(home, "projects", encodeRepoPath(repoRoot))
}

/**
 * Context carried by a single turn.
 *
 * All three input buckets are context: `cache_read_input_tokens` is the part
 * served from cache, `cache_creation_input_tokens` is the part being written to
 * it, and `input_tokens` is the uncached remainder. They partition the prompt,
 * so they sum to its size. Output tokens are not context and are excluded.
 */
function turnContextTokens(usage) {
  if (!usage || typeof usage !== "object") return 0
  const input = Number(usage.input_tokens) || 0
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0
  const cacheRead = Number(usage.cache_read_input_tokens) || 0
  return input + cacheWrite + cacheRead
}

/**
 * Read the last turn's context size from a transcript.
 *
 * Reads the whole file rather than seeking backwards: transcripts are tens of
 * megabytes at worst, this runs once per `btrain handoff`, and a partial tail
 * read would have to handle a split JSON line. Returns null when the file holds
 * no usage record at all, which is a real state during the first turn.
 */
async function readLatestContextTokens(transcriptPath) {
  let raw
  try {
    raw = await fs.readFile(transcriptPath, "utf8")
  } catch {
    return null
  }

  let latest = null
  let peak = 0
  let turns = 0
  for (const line of raw.split("\n")) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // A transcript being appended to can end mid-line. Skip it; the previous
      // complete turn is close enough for a ceiling check.
      continue
    }
    const usage = record?.message?.usage
    if (!usage) continue
    turns += 1
    const tokens = turnContextTokens(usage)
    // The LAST record, not the largest. The question this module answers is
    // "how much context is this session carrying now", and the answer has to
    // fall when the session compacts or clears.
    //
    // An earlier version took the maximum across the whole file, which read
    // well until it was run against a real transcript: a session that had
    // compacted correctly still reported its pre-compaction peak, because that
    // record never leaves the file. The gate would have blocked the session
    // forever, and blocked it hardest immediately after doing the right thing.
    latest = tokens
    if (tokens > peak) peak = tokens
  }
  return latest === null ? null : { tokens: latest, peak, turns }
}

/**
 * Find the transcript for the session asking the question.
 *
 * Returns `{ source, transcriptPath, candidates, reason }`. See the module
 * header for what each `source` licenses the caller to do.
 */
async function locateSessionTranscript(repoRoot, opts = {}) {
  const env = opts.env || process.env
  const dir = resolveTranscriptDir(repoRoot, env)
  const freshnessMs = Number.isFinite(opts.freshnessMs) ? opts.freshnessMs : DEFAULT_FRESHNESS_MS
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()

  const sessionId = opts.sessionId || env.BTRAIN_SESSION_ID || ""
  if (sessionId) {
    const explicitPath = path.join(dir, `${sessionId}.jsonl`)
    try {
      await fs.stat(explicitPath)
      return { source: "explicit", transcriptPath: explicitPath, candidates: 1, reason: "" }
    } catch {
      return {
        source: "unavailable",
        transcriptPath: "",
        candidates: 0,
        reason: `no transcript for session ${sessionId} under ${dir}`,
      }
    }
  }

  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return {
      source: "unavailable",
      transcriptPath: "",
      candidates: 0,
      reason: `no transcript directory at ${dir}`,
    }
  }

  const fresh = []
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue
    const full = path.join(dir, name)
    try {
      const stat = await fs.stat(full)
      if (now - stat.mtimeMs <= freshnessMs) fresh.push({ full, mtimeMs: stat.mtimeMs })
    } catch {
      // Raced with a delete. Not a live session.
    }
  }

  if (fresh.length === 0) {
    return {
      source: "unavailable",
      transcriptPath: "",
      candidates: 0,
      reason: `no session transcript in ${dir} written in the last ${Math.round(freshnessMs / 60000)} minutes`,
    }
  }

  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (fresh.length > 1) {
    // Normal for multi-lane work: several agents, one repo. Picking the newest
    // would attribute one lane's context to another, so say so instead.
    return {
      source: "ambiguous",
      transcriptPath: fresh[0].full,
      candidates: fresh.length,
      reason: `${fresh.length} sessions are live in this repo, so the reading cannot be attributed to one lane`,
    }
  }

  return { source: "inferred", transcriptPath: fresh[0].full, candidates: 1, reason: "" }
}

/**
 * Ceilings for a lane. Lane config overrides repo config; either may be absent.
 * Setting a ceiling to 0 disables that ceiling, which is the documented
 * rollback for this workstream.
 */
function getContextBudgetConfig(config, laneId = "") {
  const repo = config?.context_budget || {}
  const lane = laneId ? repo?.lanes?.[laneId] || {} : {}
  const pick = (key, fallback) => {
    for (const source of [lane, repo]) {
      const value = Number(source?.[key])
      if (Number.isFinite(value) && value >= 0) return value
    }
    return fallback
  }
  return {
    enabled: repo?.enabled !== false,
    softCeiling: pick("soft_ceiling", DEFAULT_SOFT_CEILING),
    hardCeiling: pick("hard_ceiling", DEFAULT_HARD_CEILING),
    freshnessMs: pick("freshness_ms", DEFAULT_FRESHNESS_MS),
  }
}

function formatTokens(tokens) {
  return tokens.toLocaleString("en-US")
}

/**
 * The one entry point. Everything above is implementation.
 *
 * @returns {Promise<{
 *   level: "ok"|"warn"|"block",
 *   tokens: number|null,
 *   peak: number,
 *   turns: number,
 *   source: string,
 *   softCeiling: number,
 *   hardCeiling: number,
 *   message: string,
 *   reason: string,
 *   blockable: boolean,
 * }>}
 */
async function evaluateContextBudget(repoRoot, config, opts = {}) {
  const laneId = opts.laneId || ""
  const budget = getContextBudgetConfig(config, laneId)
  const base = {
    level: "ok",
    tokens: null,
    peak: 0,
    turns: 0,
    source: "disabled",
    softCeiling: budget.softCeiling,
    hardCeiling: budget.hardCeiling,
    message: "",
    reason: "",
    blockable: false,
  }

  if (!budget.enabled) return { ...base, reason: "context budget disabled in config" }

  const located = await locateSessionTranscript(repoRoot, {
    ...opts,
    freshnessMs: budget.freshnessMs,
  })
  if (!located.transcriptPath) {
    return { ...base, source: located.source, reason: located.reason }
  }

  const reading = await readLatestContextTokens(located.transcriptPath)
  if (!reading) {
    return {
      ...base,
      source: located.source,
      reason: `transcript ${path.basename(located.transcriptPath)} holds no usage record yet`,
    }
  }

  const blockable = BLOCKING_SOURCES.includes(located.source)
  const result = {
    ...base,
    tokens: reading.tokens,
    peak: reading.peak,
    turns: reading.turns,
    source: located.source,
    reason: located.reason,
    blockable,
  }

  const overHard = budget.hardCeiling > 0 && reading.tokens > budget.hardCeiling
  const overSoft = budget.softCeiling > 0 && reading.tokens > budget.softCeiling

  if (overHard && blockable) {
    return {
      ...result,
      level: "block",
      message:
        `context is ${formatTokens(reading.tokens)} tokens, over the ${formatTokens(budget.hardCeiling)} hard ceiling. `
        + "Write the current state to MEMORY.md, clear context, and resume. "
        + "To proceed anyway: btrain override grant --action context-budget.",
    }
  }

  if (overHard) {
    // Over the hard ceiling but the reading cannot be pinned to this lane.
    // Warning is the strongest honest response.
    return {
      ...result,
      level: "warn",
      message:
        `a session in this repo is at ${formatTokens(reading.tokens)} tokens, over the ${formatTokens(budget.hardCeiling)} hard ceiling, `
        + `but ${located.reason}. Not blocking. Clear context if this is your session.`,
    }
  }

  if (overSoft) {
    return {
      ...result,
      level: "warn",
      message:
        `context is ${formatTokens(reading.tokens)} tokens over ${reading.turns} turns, past the ${formatTokens(budget.softCeiling)} soft ceiling. `
        + "Cache reads scale with context multiplied by turns. Write state to MEMORY.md and clear at the next stopping point."
        + (located.source === "ambiguous" ? ` (${located.reason})` : ""),
    }
  }

  return result
}

export {
  evaluateContextBudget,
  getContextBudgetConfig,
  locateSessionTranscript,
  readLatestContextTokens,
  turnContextTokens,
  resolveTranscriptDir,
  DEFAULT_SOFT_CEILING,
  DEFAULT_HARD_CEILING,
  DEFAULT_FRESHNESS_MS,
}
