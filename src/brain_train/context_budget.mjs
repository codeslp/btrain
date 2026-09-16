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
 * ## Identifying the session
 *
 * Claude Code exports `CLAUDE_CODE_SESSION_ID` into the environment of every
 * tool call, and its value is exactly the transcript basename. btrain runs
 * inside that environment, so an in-session invocation can name its own
 * transcript with certainty and no guessing is required.
 *
 * An earlier version of this module asserted the opposite -- that "nothing in
 * the environment reliably names that session" -- and built a freshness window,
 * an `ambiguous` state, and a warn-only downgrade on top of that premise. The
 * assertion came from checking `CLAUDE_CODE_HOST_SESSION_ID` (which is prefixed
 * `local_` and is genuinely not a transcript name) and generalizing from one
 * variable. Review found the right one. The heuristic machinery that mistake
 * justified is gone.
 *
 * What remains is the case the environment variable cannot cover: a caller that
 * is not an agent session at all -- a human shell, or the handoff-history
 * launchd agent. There, the newest transcript is reliably the most recently
 * active session, but that session is not the caller, so its context must not
 * gate the caller's lane.
 *
 *   - `explicit`    the environment or the caller named the session. Exact.
 *                   May warn and may block.
 *   - `inferred`    no session id; the most recently written transcript is
 *                   reported so an operator can see it. Warn only, never block,
 *                   because the caller is probably not that session.
 *   - `unavailable` no transcripts at all. Say nothing.
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
 * Attribution confidence levels that may drive a hard block. Only an exactly
 * named session qualifies: an inferred one is the most recently active session,
 * which is not the same claim as "the session calling btrain".
 */
const BLOCKING_SOURCES = Object.freeze(["explicit"])

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
  // No `typeof usage !== "object"` guard: `Number(undefined) || 0` is already 0
  // for every non-object, so the guard changed no input and no test could tell
  // it apart from its own absence. A null check is still needed for property
  // access.
  if (!usage) return 0
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
  // Claude Code writes one record per content block -- thinking, text, each
  // tool_use -- and every one of them repeats the same `usage` object. Counting
  // records overcounts turns by about 2.1x on this repo's transcripts, and the
  // figure is printed to the user beside a claim that cost scales with turns.
  // Count distinct API responses instead.
  const responseIds = new Set()
  let usageRecords = 0
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
    usageRecords += 1
    responseIds.add(record.requestId || record.message?.id || `record:${usageRecords}`)
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
  return latest === null ? null : { tokens: latest, peak, turns: responseIds.size }
}

/**
 * Find the transcript for the session asking the question.
 *
 * Returns `{ source, transcriptPath, sessionId, reason }`. See the module
 * header for what each `source` licenses the caller to do.
 */
async function locateSessionTranscript(repoRoot, opts = {}) {
  const env = opts.env || process.env
  const dir = resolveTranscriptDir(repoRoot, env)

  // Claude Code sets CLAUDE_CODE_SESSION_ID to the transcript basename for
  // every tool call, so an in-session invocation takes this path and never
  // guesses. BTRAIN_SESSION_ID lets an out-of-session caller be explicit too.
  const named = opts.sessionId || env.BTRAIN_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || ""
  if (named) {
    // The id becomes a path segment, so reject anything that could escape the
    // transcript directory. Self-inflicted and read-only, but free to prevent.
    if (!/^[A-Za-z0-9._-]+$/.test(named) || named === "." || named === "..") {
      return {
        source: "unavailable",
        transcriptPath: "",
        sessionId: "",
        reason: `session id ${JSON.stringify(named)} is not a plain transcript name`,
      }
    }
    const explicitPath = path.join(dir, `${named}.jsonl`)
    try {
      await fs.stat(explicitPath)
      return { source: "explicit", transcriptPath: explicitPath, sessionId: named, reason: "" }
    } catch {
      return {
        source: "unavailable",
        transcriptPath: "",
        sessionId: "",
        reason: `no transcript for session ${named} under ${dir}`,
      }
    }
  }

  // No session id: btrain is being run from outside an agent session. The
  // newest transcript identifies the most recently active session reliably,
  // but that session is not the caller, so this reading informs and never
  // gates. No freshness window -- staleness is not what makes it untrustworthy.
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return {
      source: "unavailable",
      transcriptPath: "",
      sessionId: "",
      reason: `no transcript directory at ${dir}`,
    }
  }

  let newest = null
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue
    const full = path.join(dir, name)
    try {
      const stat = await fs.stat(full)
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { full, mtimeMs: stat.mtimeMs, id: name.slice(0, -6) }
      }
    } catch {
      // Raced with a delete.
    }
  }

  if (!newest) {
    return {
      source: "unavailable",
      transcriptPath: "",
      sessionId: "",
      reason: `no session transcript in ${dir}`,
    }
  }

  return {
    source: "inferred",
    transcriptPath: newest.full,
    sessionId: newest.id,
    reason:
      "CLAUDE_CODE_SESSION_ID is not set, so btrain is not running inside an agent session. "
      + `Reporting the most recently active session (${newest.id.slice(0, 8)}) for information only.`,
  }
}

/**
 * Ceilings for a lane. Lane config overrides repo config; either may be absent.
 * Setting a ceiling to 0 disables that ceiling, which is the documented
 * rollback for this workstream.
 */
function getContextBudgetConfig(config, laneId = "") {
  const repo = config?.context_budget || {}
  const lane = laneId ? repo?.lanes?.[laneId] || {} : {}
  const invalid = []

  // `Number()` is too permissive to use directly here. It maps "", " ", false,
  // [] and null all to 0, and this module reads 0 as "ceiling disabled" -- so a
  // blank or mistyped value silently switched the hard block off. It also
  // returns NaN for TOML's underscore integer form (`hard_ceiling = 350_000`),
  // which fell through to the default, so a deliberate setting read as applied
  // and was not. Parse strictly, and report anything rejected rather than
  // quietly substituting a default.
  const parseCeiling = (raw) => {
    if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null
    if (typeof raw !== "string") return null
    const trimmed = raw.trim().replace(/_/g, "")
    if (!/^\d+$/.test(trimmed)) return null
    const value = Number(trimmed)
    return Number.isFinite(value) ? value : null
  }

  const pick = (key, fallback) => {
    for (const source of [lane, repo]) {
      if (source?.[key] === undefined || source?.[key] === null) continue
      const value = parseCeiling(source[key])
      if (value !== null) return value
      invalid.push(`${key}=${JSON.stringify(source[key])}`)
    }
    return fallback
  }

  return {
    // Lane overrides everything else, as with the ceilings. Reading `enabled`
    // from the repo table alone made the documented rollback repo-wide only.
    enabled: lane?.enabled !== undefined ? lane.enabled !== false : repo?.enabled !== false,
    softCeiling: pick("soft_ceiling", DEFAULT_SOFT_CEILING),
    hardCeiling: pick("hard_ceiling", DEFAULT_HARD_CEILING),
    invalid,
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

  const configNote = budget.invalid.length > 0
    ? ` Ignored unparseable config: ${budget.invalid.join(", ")}.`
    : ""

  if (!budget.enabled) return { ...base, reason: "context budget disabled in config" + configNote }

  const located = await locateSessionTranscript(repoRoot, opts)
  if (!located.transcriptPath) {
    return { ...base, source: located.source, reason: located.reason + configNote }
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
    reason: located.reason + configNote,
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
        + "To proceed without clearing, raise or zero `hard_ceiling` under [context_budget] "
        + "in .btrain/project.toml.",
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
        + `but ${located.reason} Not blocking. Clear context if this is your session.`,
    }
  }

  if (overSoft) {
    return {
      ...result,
      level: "warn",
      message:
        `context is ${formatTokens(reading.tokens)} tokens over ${reading.turns} turns, past the ${formatTokens(budget.softCeiling)} soft ceiling. `
        + "Cache reads scale with context multiplied by turns. Write state to MEMORY.md and clear at the next stopping point."
        + (located.source === "explicit" ? "" : ` (${located.reason})`),
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
}
