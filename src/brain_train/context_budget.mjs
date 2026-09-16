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
 * with every character outside `[A-Za-z0-9]` replaced by a hyphen and a leading
 * hyphen for the root. `/Users/x/btrain` becomes `-Users-x-btrain`.
 *
 * Replacing only `/` was wrong, and wrong in the one place it had to be right:
 * btrain's lane worktrees live under `<repo>/.claude/worktrees/<name>`, so the
 * dot produced a directory that does not exist, the lookup returned
 * `unavailable`, and the gate silently never fired on the layout it is built
 * for. Checked against the real directories under `~/.claude/projects`:
 * `/Users/bfaris96/job_search` is stored as `-Users-bfaris96-job-search`, and
 * `/Users/bfaris96/btrain/.claude/worktrees/jolly-moser-9f6967` as
 * `-Users-bfaris96-btrain--claude-worktrees-jolly-moser-9f6967`.
 */
function encodeRepoPath(repoRoot) {
  return "-" + path.resolve(repoRoot).replace(/^\/+/, "").replace(/[^A-Za-z0-9]/g, "-")
}

function resolveTranscriptDir(repoRoot, env = process.env) {
  if (env.BTRAIN_TRANSCRIPT_DIR) return env.BTRAIN_TRANSCRIPT_DIR
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
  return path.join(home, "projects", encodeRepoPath(repoRoot))
}

/**
 * The directory holding every project's transcript directory.
 *
 * `null` when BTRAIN_TRANSCRIPT_DIR pins a single directory, because then the
 * caller has named the only place to look and a wider search would ignore them.
 */
function resolveProjectsRoot(env = process.env) {
  if (env.BTRAIN_TRANSCRIPT_DIR) return null
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
  return path.join(home, "projects")
}

/**
 * Find `<sessionId>.jsonl` under any project directory.
 *
 * `repoRoot` is btrain's idea of the repo; the transcript directory is named
 * after the directory the Claude session was launched in. Those disagree
 * whenever btrain runs with `--repo` pointed elsewhere, or from a lane
 * worktree, which is the normal case for this project. A session id is
 * globally unique, so the id is the reliable key and the directory is not.
 */
async function findTranscriptBySessionId(projectsRoot, sessionId) {
  if (!projectsRoot) return ""
  let entries
  try {
    entries = await fs.readdir(projectsRoot)
  } catch {
    return ""
  }
  for (const entry of entries) {
    const candidate = path.join(projectsRoot, entry, `${sessionId}.jsonl`)
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // Not this project, or raced with a delete.
    }
  }
  return ""
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

  // The latest reading, as { tokens, order }. `order` is the record's timestamp
  // in milliseconds, or -Infinity when it has none.
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
    const tokens = turnContextTokens(usage)
    // A `usage` object with every field zero is not a measurement of zero
    // context. Claude Code writes exactly that shape for a failed API call
    // (`isApiErrorMessage`, `apiErrorStatus: 401`) and for a synthetic
    // "No response requested." turn -- and no real prompt is zero tokens, so
    // there is nothing to confuse it with.
    //
    // Taking it as a reading was the module's own stated failure mode, arriving
    // through the transcript rather than through a missing file: a session
    // carrying 300,000 tokens read as 0 and passed silently, and the hard block
    // cleared itself on the next auth blip. Three transcripts on this machine
    // read 0 permanently that way, one of them at 303,843 real tokens.
    if (tokens === 0) continue
    usageRecords += 1
    responseIds.add(record.requestId || record.message?.id || `record:${usageRecords}`)
    // The LATEST record, not the largest. The question this module answers is
    // "how much context is this session carrying now", and the answer has to
    // fall when the session compacts or clears.
    //
    // An earlier version took the maximum across the whole file, which read
    // well until it was run against a real transcript: a session that had
    // compacted correctly still reported its pre-compaction peak, because that
    // record never leaves the file. The gate would have blocked the session
    // forever, and blocked it hardest immediately after doing the right thing.
    //
    // Latest by time, not by file position. A resumed or forked session
    // replays older records into the tail; one transcript here jumps 7.6 hours
    // backwards mid-file, from 997,512 tokens to 63,638. Records with no
    // timestamp all compare equal, so a file without them keeps file order.
    const stamped = Date.parse(record.timestamp || "")
    const order = Number.isFinite(stamped) ? stamped : -Infinity
    if (latest === null || order >= latest.order) latest = { tokens, order }
    if (tokens > peak) peak = tokens
  }
  return latest === null ? null : { tokens: latest.tokens, peak, turns: responseIds.size }
}

/**
 * Find the transcript for the session asking the question.
 *
 * Returns `{ source, transcriptPath, sessionId, reason }`. See the module
 * header for what each `source` licenses the caller to do.
 */
async function locateSessionTranscript(repoRoot, opts = {}) {
  const env = opts.env || process.env
  // Claude Code records the real path, so a symlinked spelling of the repo
  // (`/tmp/x` for `/private/tmp/x`) encodes to a directory that does not
  // exist. btrain accepts a symlinked `--repo`, so resolve before encoding.
  let realRoot = repoRoot
  try {
    realRoot = await fs.realpath(repoRoot)
  } catch {
    // Missing or unreadable; encode the path as given.
  }
  const dir = resolveTranscriptDir(realRoot, env)

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
      // The session is named and unique, so a miss here means the transcript
      // directory is not the one this session writes to -- not that the
      // session has no transcript. Look for the id itself before giving up;
      // reporting `unavailable` would read as `ok` to the caller and silently
      // disarm the gate, which is the failure this module exists to prevent.
      const found = await findTranscriptBySessionId(resolveProjectsRoot(env), named)
      if (found) {
        return { source: "explicit", transcriptPath: found, sessionId: named, reason: "" }
      }
      return {
        source: "unavailable",
        transcriptPath: "",
        sessionId: "",
        reason: `no transcript for session ${named} under ${dir} or any sibling project directory`,
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
    // TOML puts underscores between digits, so accept that form and nothing
    // looser. Stripping first and then testing let `_5`, `5_` and `05` through,
    // all of which TOML itself rejects. btrain's parser also does not strip
    // trailing comments, so `400000  # raised` arrives whole and is refused
    // here rather than silently becoming the default.
    const trimmed = raw.trim()
    if (!/^\d+(_\d+)*$/.test(trimmed)) return null
    const value = Number(trimmed.replace(/_/g, ""))
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

  // `enabled` is the documented rollback, so it must fail loudly rather than
  // quietly. btrain's TOML parser returns a string for anything it does not
  // recognise as a literal, and `"false" !== false`, so the original
  // `enabled !== false` test left a quoted value with the gate fully armed and
  // said nothing -- the exact shape of the ceiling bug, on the one key the
  // ceiling fix did not cover. Guessing that a non-boolean means "off" would be
  // worse: a typo would disable a safety gate. Refuse it and report it.
  const pickEnabled = () => {
    for (const source of [lane, repo]) {
      if (source?.enabled === undefined || source?.enabled === null) continue
      if (typeof source.enabled === "boolean") return source.enabled
      invalid.push(`enabled=${JSON.stringify(source.enabled)}`)
    }
    return true
  }

  // Lane overrides everything else, as with the ceilings. Reading `enabled`
  // from the repo table alone made the documented rollback repo-wide only.
  const enabled = pickEnabled()
  const softCeiling = pick("soft_ceiling", DEFAULT_SOFT_CEILING)
  const hardCeiling = pick("hard_ceiling", DEFAULT_HARD_CEILING)

  // Legal to write and the block still wins, but the warning can never fire, so
  // the documented "warn first, then block" behaviour disappears with no
  // diagnostic. Both values are applied as written; only the contradiction is
  // reported.
  const notes = []
  if (softCeiling > 0 && hardCeiling > 0 && softCeiling > hardCeiling) {
    notes.push(
      `soft_ceiling (${softCeiling}) is above hard_ceiling (${hardCeiling}), `
      + "so the warning can never fire before the block",
    )
  }

  return { enabled, softCeiling, hardCeiling, invalid, notes }
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

  // Appended to `reason` AND to every message. It reached `reason` alone, which
  // neither the warn nor the block path prints, so a user whose ceiling btrain
  // had thrown away got no sign of it at the one moment it mattered.
  const configNote =
    (budget.invalid.length > 0 ? ` Ignored unparseable config: ${budget.invalid.join(", ")}.` : "")
    + (budget.notes.length > 0 ? ` Note: ${budget.notes.join("; ")}.` : "")

  if (!budget.enabled) {
    return { ...base, reason: "context budget disabled in config" + configNote, message: configNote.trim() }
  }

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
        + "in .btrain/project.toml."
        + configNote,
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
        + `but ${located.reason} Not blocking. Clear context if this is your session.`
        + configNote,
    }
  }

  if (overSoft) {
    // An inferred reading belongs to the most recently active session, which is
    // probably not the caller. The hard-ceiling warning already hedges for that
    // ("a session in this repo is at..."); this one said "context is ..." and
    // presented somebody else's session as the caller's own.
    const subject = located.source === "explicit" ? "context is" : "a session in this repo is at"
    return {
      ...result,
      level: "warn",
      message:
        `${subject} ${formatTokens(reading.tokens)} tokens over ${reading.turns} turns, past the ${formatTokens(budget.softCeiling)} soft ceiling. `
        + "Cache reads scale with context multiplied by turns. Write state to MEMORY.md and clear at the next stopping point."
        + (located.source === "explicit" ? "" : ` (${located.reason})`)
        + configNote,
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
