import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  evaluateContextBudget,
  getContextBudgetConfig,
  locateSessionTranscript,
  readLatestContextTokens,
  turnContextTokens,
  resolveTranscriptDir,
  DEFAULT_SOFT_CEILING,
  DEFAULT_HARD_CEILING,
} from "../src/brain_train/context_budget.mjs"

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function makeTranscriptDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-ctx-budget-"))
}

/** One assistant turn, in the shape Claude Code writes. */
function turn({ input = 0, cacheWrite = 0, cacheRead = 0, output = 0, timestamp = "" }) {
  const record = {
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  }
  if (timestamp) record.timestamp = timestamp
  return JSON.stringify(record)
}

/**
 * A record Claude Code writes when the API call itself failed, or a synthetic
 * "No response requested." turn. Both carry a full `usage` object with every
 * field zero. Verified on this repo's own transcripts: an `apiErrorStatus: 401`
 * record and a synthetic record, both all-zero.
 */
function errorTurn({ timestamp = "" } = {}) {
  const record = {
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 401,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Failed to authenticate. API Error: 401" }],
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  }
  if (timestamp) record.timestamp = timestamp
  return JSON.stringify(record)
}

async function writeTranscript(dir, sessionId, lines, mtimeMs = Date.now()) {
  const full = path.join(dir, `${sessionId}.jsonl`)
  await fs.writeFile(full, lines.join("\n") + "\n", "utf8")
  const when = new Date(mtimeMs)
  await fs.utimes(full, when, when)
  return full
}

// ──────────────────────────────────────────────
// Measurement
// ──────────────────────────────────────────────

describe("context budget measurement", () => {
  it("counts all three input buckets as context and excludes output", () => {
    // The buckets partition the prompt: cache reads are the cached part, cache
    // creation the part being written, input_tokens the uncached remainder.
    // Output is not context. Counting output would inflate a long-answer turn
    // into a false ceiling breach.
    assert.equal(
      turnContextTokens({
        input_tokens: 2,
        cache_creation_input_tokens: 496,
        cache_read_input_tokens: 167_441,
        output_tokens: 9_000,
      }),
      167_939,
    )
  })

  it("treats a missing or malformed usage record as zero rather than throwing", () => {
    assert.equal(turnContextTokens(null), 0)
    assert.equal(turnContextTokens(undefined), 0)
    assert.equal(turnContextTokens("nonsense"), 0)
    assert.equal(turnContextTokens({}), 0)
    assert.equal(turnContextTokens({ input_tokens: "abc" }), 0)
  })

  it("reports the current turn, so a compacted session stops being over the ceiling", async () => {
    // Caught by running the module against a real transcript rather than a
    // fixture. An earlier version took the maximum across the whole file, so a
    // session that compacted correctly still reported its pre-compaction peak
    // forever -- the gate would have punished the exact behaviour it exists to
    // encourage. `tokens` is now the latest reading; `peak` is kept separately
    // for anyone who wants the history.
    const dir = await makeTranscriptDir()
    try {
      const file = await writeTranscript(dir, "compacted", [
        turn({ cacheRead: 100_000 }),
        turn({ cacheRead: 450_000 }),
        turn({ cacheRead: 30_000 }),
      ])
      const reading = await readLatestContextTokens(file)
      assert.equal(reading.tokens, 30_000, "a compaction must lower the reading")
      assert.equal(reading.peak, 450_000, "the peak is still available, just not what the gate uses")
      assert.equal(reading.turns, 3)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("does not block a session that was over the ceiling and then compacted", async () => {
    // The end-to-end form of the same property, through the public interface.
    const dir = await makeTranscriptDir()
    try {
      await writeTranscript(dir, "recovered", [
        turn({ cacheRead: 900_000 }),
        turn({ cacheRead: 40_000 }),
      ])
      const verdict = await evaluateContextBudget("/repo", {}, {
        env: { BTRAIN_TRANSCRIPT_DIR: dir },
        sessionId: "recovered",
      })
      assert.equal(verdict.level, "ok", "clearing context must clear the block")
      assert.equal(verdict.tokens, 40_000)
      assert.equal(verdict.peak, 900_000)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("skips a truncated trailing line instead of failing the whole read", async () => {
    // Transcripts are appended to live, so the last line can be half-written
    // at the moment btrain reads it.
    const dir = await makeTranscriptDir()
    try {
      const file = path.join(dir, "partial.jsonl")
      await fs.writeFile(file, turn({ cacheRead: 250_000 }) + "\n" + '{"message":{"usage":{"cache_rea', "utf8")
      const reading = await readLatestContextTokens(file)
      assert.equal(reading.tokens, 250_000)
      assert.equal(reading.turns, 1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("counts API responses, not transcript records", async () => {
    // Claude Code writes one record per content block -- thinking, text, each
    // tool_use -- and all of them repeat the same `usage`. Counting records
    // overcounted turns by 2.1x on this repo's real transcripts, and the number
    // is printed to the user next to a claim that cost scales with turn count.
    const dir = await makeTranscriptDir()
    try {
      const withId = (id, cacheRead) => JSON.stringify({
        type: "assistant",
        requestId: id,
        message: { role: "assistant", id: `msg_${id}`, usage: { cache_read_input_tokens: cacheRead } },
      })
      const file = await writeTranscript(dir, "blocks", [
        withId("req_1", 100),   // thinking block
        withId("req_1", 100),   // text block, same API response
        withId("req_1", 100),   // tool_use block, same API response
        withId("req_2", 200),
      ])
      const reading = await readLatestContextTokens(file)
      assert.equal(reading.turns, 2, "four records, two API responses")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null for a transcript with no usage record yet", async () => {
    const dir = await makeTranscriptDir()
    try {
      const file = await writeTranscript(dir, "empty", [JSON.stringify({ type: "user", message: { role: "user" } })])
      assert.equal(await readLatestContextTokens(file), null)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null for a transcript that does not exist", async () => {
    assert.equal(await readLatestContextTokens("/nonexistent/nope.jsonl"), null)
  })
})

describe("context budget measurement, records that are not measurements", () => {
  it("does not read an API error record as zero context", async () => {
    // Claude Code writes a full `usage` object with every field zero for a
    // failed API call (401, 429) and for a synthetic "No response requested."
    // turn. Taking the last usage record unconditionally read that as "this
    // session is carrying 0 tokens" -- a silent pass at any context size, and a
    // hard block that clears itself on the next auth blip. Reproduced on this
    // repo's own transcript: truncated at its 401 record it returned
    // {tokens: 0, peak: 771183} against a real 187,000 tokens.
    const dir = await makeTranscriptDir()
    try {
      const file = await writeTranscript(dir, "errored", [
        turn({ cacheRead: 300_000 }),
        errorTurn(),
      ])
      const reading = await readLatestContextTokens(file)
      assert.equal(
        reading.tokens,
        300_000,
        "an error record proves nothing about context and must not overwrite the last real reading",
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("reports no reading at all when every record is an error record", async () => {
    // The honest degradation. Absence of a reading is not a reading of zero,
    // so this must reach the caller as "no measurement", not as a healthy 0.
    const dir = await makeTranscriptDir()
    try {
      const file = await writeTranscript(dir, "all-errors", [errorTurn(), errorTurn()])
      assert.equal(await readLatestContextTokens(file), null)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("takes the latest turn by time, not by position in the file", async () => {
    // A resumed or forked session replays older records into the tail of the
    // file. One real transcript on this machine jumps 7.6 hours backwards
    // mid-file, from 997,512 tokens to 63,638. Reading the last line would
    // report the stale, much smaller figure as current.
    const dir = await makeTranscriptDir()
    try {
      const file = await writeTranscript(dir, "resumed", [
        turn({ cacheRead: 100_000, timestamp: "2026-09-15T10:00:00.000Z" }),
        turn({ cacheRead: 450_000, timestamp: "2026-09-15T18:00:00.000Z" }),
        turn({ cacheRead: 60_000, timestamp: "2026-09-15T10:30:00.000Z" }),
      ])
      const reading = await readLatestContextTokens(file)
      assert.equal(reading.tokens, 450_000, "the newest turn by timestamp is the current reading")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("falls back to file order when no record carries a timestamp", async () => {
    const dir = await makeTranscriptDir()
    try {
      const file = await writeTranscript(dir, "untimed", [
        turn({ cacheRead: 400_000 }),
        turn({ cacheRead: 90_000 }),
      ])
      assert.equal((await readLatestContextTokens(file)).tokens, 90_000)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────
// Attribution
// ──────────────────────────────────────────────

describe("context budget session attribution", () => {
  it("encodes the repo path the way Claude Code names its transcript directory", () => {
    const dir = resolveTranscriptDir("/Users/x/btrain", { CLAUDE_CONFIG_DIR: "/cfg" })
    assert.equal(dir, path.join("/cfg", "projects", "-Users-x-btrain"))
  })

  it("replaces every non-alphanumeric character, not just the separators", () => {
    // The original only replaced "/". Claude Code replaces every character
    // outside [A-Za-z0-9]. Checked against real directories under
    // ~/.claude/projects: /Users/bfaris96/job_search resolves to
    // -Users-bfaris96-job-search, and a path with a dot doubles the hyphen.
    //
    // The btrain case is the one that matters: lane worktrees live under
    // <repo>/.claude/worktrees/<name>, so the "/"-only encoder pointed at a
    // directory that does not exist, returned "unavailable", and the gate
    // silently never fired on exactly the layout it is built for.
    const at = (repo) => path.basename(resolveTranscriptDir(repo, { CLAUDE_CONFIG_DIR: "/cfg" }))
    assert.equal(at("/Users/x/job_search"), "-Users-x-job-search", "underscore")
    assert.equal(at("/Users/x/btrain/.claude/worktrees/lane-c"), "-Users-x-btrain--claude-worktrees-lane-c", "dot")
    assert.equal(at("/Users/x/Claude Code/app"), "-Users-x-Claude-Code-app", "space")
  })

  it("trusts an explicitly named session", async () => {
    const dir = await makeTranscriptDir()
    try {
      await writeTranscript(dir, "sess-a", [turn({ cacheRead: 10 })])
      const located = await locateSessionTranscript("/repo", {
        env: { BTRAIN_TRANSCRIPT_DIR: dir },
        sessionId: "sess-a",
      })
      assert.equal(located.source, "explicit")
      assert.match(located.transcriptPath, /sess-a\.jsonl$/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("does not fall back to guessing when a named session has no transcript", async () => {
    // Falling back here would silently measure a different session than the
    // one the caller named, which is worse than reporting nothing.
    const dir = await makeTranscriptDir()
    try {
      await writeTranscript(dir, "other", [turn({ cacheRead: 999_999 })])
      const located = await locateSessionTranscript("/repo", {
        env: { BTRAIN_TRANSCRIPT_DIR: dir },
        sessionId: "missing",
      })
      assert.equal(located.source, "unavailable")
      assert.equal(located.transcriptPath, "")
      assert.match(located.reason, /no transcript for session missing/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("reads CLAUDE_CODE_SESSION_ID, which names the transcript exactly", async () => {
    // The finding that restructured this module. An earlier version asserted
    // "nothing in the environment reliably names that session", having checked
    // only CLAUDE_CODE_HOST_SESSION_ID (prefixed `local_`, genuinely not a
    // transcript name) and generalized. Claude Code also exports
    // CLAUDE_CODE_SESSION_ID, whose value IS the transcript basename, so an
    // in-session call needs no heuristic at all.
    const dir = await makeTranscriptDir()
    try {
      await writeTranscript(dir, "env-named", [turn({ cacheRead: 10 })])
      const located = await locateSessionTranscript("/repo", {
        env: { BTRAIN_TRANSCRIPT_DIR: dir, CLAUDE_CODE_SESSION_ID: "env-named" },
      })
      assert.equal(located.source, "explicit", "the env var must give an exact attribution")
      assert.match(located.transcriptPath, /env-named\.jsonl$/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("prefers an explicitly passed session id over the environment", async () => {
    const dir = await makeTranscriptDir()
    try {
      await writeTranscript(dir, "from-arg", [turn({ cacheRead: 10 })])
      await writeTranscript(dir, "from-env", [turn({ cacheRead: 10 })])
      const located = await locateSessionTranscript("/repo", {
        env: { BTRAIN_TRANSCRIPT_DIR: dir, CLAUDE_CODE_SESSION_ID: "from-env" },
        sessionId: "from-arg",
      })
      assert.match(located.transcriptPath, /from-arg\.jsonl$/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("reports the newest session as inferred when no session id is set", async () => {
    // btrain run from a human shell or the launchd history agent. The newest
    // transcript is reliably the most recently active session, but that session
    // is not the caller, so this is information and never a gate.
    const dir = await makeTranscriptDir()
    try {
      const now = Date.now()
      await writeTranscript(dir, "older", [turn({ cacheRead: 10 })], now - 60_000)
      await writeTranscript(dir, "newest", [turn({ cacheRead: 10 })], now)
      const located = await locateSessionTranscript("/repo", {
        env: { BTRAIN_TRANSCRIPT_DIR: dir },
      })
      assert.equal(located.source, "inferred")
      assert.match(located.transcriptPath, /newest\.jsonl$/)
      assert.match(located.reason, /not running inside an agent session/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("refuses a session id that could escape the transcript directory", async () => {
    const located = await locateSessionTranscript("/repo", {
      env: { BTRAIN_TRANSCRIPT_DIR: "/tmp" },
      sessionId: "../../../../etc/hosts",
    })
    assert.equal(located.source, "unavailable")
    assert.match(located.reason, /not a plain transcript name/)
  })

  it("reports unavailable when the transcript directory does not exist", async () => {
    const located = await locateSessionTranscript("/repo", {
      env: { BTRAIN_TRANSCRIPT_DIR: "/nonexistent/transcripts" },
    })
    assert.equal(located.source, "unavailable")
    assert.match(located.reason, /no transcript directory/)
  })
})

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

describe("context budget session attribution across project directories", () => {
  // Round-2 P1. The session id is globally unique; the transcript directory is
  // named after the directory the Claude session was launched in. btrain's
  // repoRoot and that directory disagree whenever btrain runs with --repo
  // pointed elsewhere or from a lane worktree, which is this project's normal
  // case. Before the fix the named lookup missed, returned "unavailable", and
  // evaluateContextBudget reported level "ok" with blockable false -- a silent
  // pass indistinguishable from a healthy session.

  let projects
  before(async () => {
    projects = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-ctx-projects-"))
  })
  after(async () => {
    await fs.rm(projects, { recursive: true, force: true })
  })

  it("finds the session under a sibling project directory when repoRoot disagrees", async () => {
    const launched = path.join(projects, "projects", "-Users-x-btrain")
    await fs.mkdir(launched, { recursive: true })
    await writeTranscript(launched, "sess-cross", [turn({ cacheRead: 500_000 })])

    // repoRoot points at a worktree, which encodes to a different directory.
    const located = await locateSessionTranscript("/Users/x/btrain/.claude/worktrees/lane-c", {
      env: { CLAUDE_CONFIG_DIR: projects, CLAUDE_CODE_SESSION_ID: "sess-cross" },
    })
    assert.equal(located.source, "explicit", "a named session must stay explicit")
    assert.equal(located.sessionId, "sess-cross")
    assert.equal(located.transcriptPath, path.join(launched, "sess-cross.jsonl"))
  })

  it("keeps the gate armed for a session found in a sibling directory", async () => {
    const launched = path.join(projects, "projects", "-Users-x-btrain")
    await fs.mkdir(launched, { recursive: true })
    await writeTranscript(launched, "sess-armed", [turn({ cacheRead: 500_000 })])

    const result = await evaluateContextBudget(
      "/Users/x/btrain/.claude/worktrees/lane-c",
      { enabled: true, softCeiling: 100_000, hardCeiling: 400_000, invalid: [], notes: [] },
      { env: { CLAUDE_CONFIG_DIR: projects, CLAUDE_CODE_SESSION_ID: "sess-armed" } },
    )
    // The bug reported level "ok", tokens null, blockable false here.
    assert.equal(result.source, "explicit")
    assert.equal(result.tokens, 500_000)
    assert.equal(result.level, "block")
    assert.equal(result.blockable, true)
  })

  it("still reports unavailable when the session exists nowhere", async () => {
    await fs.mkdir(path.join(projects, "projects", "-Users-x-other"), { recursive: true })
    const located = await locateSessionTranscript("/Users/x/btrain", {
      env: { CLAUDE_CONFIG_DIR: projects, CLAUDE_CODE_SESSION_ID: "sess-absent" },
    })
    assert.equal(located.source, "unavailable")
    assert.match(located.reason, /sibling project director/)
  })

  it("does not widen the search when BTRAIN_TRANSCRIPT_DIR pins one directory", async () => {
    // The caller named the only place to look. Searching elsewhere would
    // ignore them and could report a session from an unrelated repo.
    const pinned = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-ctx-pinned-"))
    const elsewhere = path.join(projects, "projects", "-Users-x-elsewhere")
    await fs.mkdir(elsewhere, { recursive: true })
    await writeTranscript(elsewhere, "sess-pinned", [turn({ cacheRead: 1_000 })])

    const located = await locateSessionTranscript("/Users/x/btrain", {
      env: {
        CLAUDE_CONFIG_DIR: projects,
        BTRAIN_TRANSCRIPT_DIR: pinned,
        CLAUDE_CODE_SESSION_ID: "sess-pinned",
      },
    })
    assert.equal(located.source, "unavailable", "a pinned directory must not fall back")
    await fs.rm(pinned, { recursive: true, force: true })
  })

  it("resolves a symlinked repo spelling before encoding it", async () => {
    // Round-2 P2-1. Claude Code records the real path. btrain accepts a
    // symlinked --repo, and on macOS /tmp is a symlink to /private/tmp, so
    // the unresolved spelling encoded to a directory that does not exist.
    //
    // Exercised through the inferred path deliberately: the named path now
    // falls back to a cross-directory search, which would mask the encoding
    // bug rather than expose it. Here the encoded directory is the only
    // thing consulted.
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-ctx-real-"))
    const link = path.join(projects, "link-to-real")
    await fs.symlink(real, link)

    const resolved = await fs.realpath(real)
    const launched = path.join(
      projects,
      "projects",
      "-" + resolved.replace(/^\/+/, "").replace(/[^A-Za-z0-9]/g, "-"),
    )
    await fs.mkdir(launched, { recursive: true })
    await writeTranscript(launched, "sess-link", [turn({ cacheRead: 7_000 })])

    const located = await locateSessionTranscript(link, {
      env: { CLAUDE_CONFIG_DIR: projects },
    })
    assert.equal(located.source, "inferred", "the symlinked spelling must still find the directory")
    assert.equal(located.sessionId, "sess-link")
    assert.equal(located.transcriptPath, path.join(launched, "sess-link.jsonl"))
    await fs.rm(real, { recursive: true, force: true })
    await fs.rm(link, { force: true })
  })

  it("honours BTRAIN_SESSION_ID for an out-of-session caller", async () => {
    // M14: the variable is documented in the module header and was untested,
    // so removing it survived the suite.
    const launched = path.join(projects, "projects", "-Users-x-btrain")
    await fs.mkdir(launched, { recursive: true })
    await writeTranscript(launched, "sess-btrain-var", [turn({ cacheRead: 9_000 })])

    const located = await locateSessionTranscript("/Users/x/btrain", {
      env: { CLAUDE_CONFIG_DIR: projects, BTRAIN_SESSION_ID: "sess-btrain-var" },
    })
    assert.equal(located.source, "explicit")
    assert.equal(located.sessionId, "sess-btrain-var")
  })

  it("ignores a non-jsonl entry that is newer than every transcript", async () => {
    // M26: dropping the ".jsonl" filter survived the suite, but the filter is
    // load-bearing on real data -- 19 of 53 real project directories have a
    // subdirectory (usually memory/) as their newest entry by mtime. Without
    // it the inferred path selects a directory and readFile throws EISDIR.
    const dir = await makeTranscriptDir()
    await writeTranscript(dir, "real-session", [turn({ cacheRead: 11_000 })], Date.now() - 60_000)
    const decoy = path.join(dir, "memory")
    await fs.mkdir(decoy)
    const now = new Date()
    await fs.utimes(decoy, now, now)

    const located = await locateSessionTranscript("/Users/x/btrain", {
      env: { BTRAIN_TRANSCRIPT_DIR: dir },
    })
    assert.equal(located.source, "inferred")
    assert.equal(located.sessionId, "real-session")
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("context budget, absence of a reading is not a reading of zero", () => {
  // M22: replacing the "no reading" branch with a dead one survived all 42
  // tests. The module's headline invariant had no end-to-end test -- the only
  // "no measurement" case used a nonexistent directory, which returns two
  // branches earlier and never reaches this code.

  it("passes without a figure when a named transcript holds only error turns", async () => {
    const dir = await makeTranscriptDir()
    await writeTranscript(dir, "all-errors", [errorTurn(), errorTurn()])

    const result = await evaluateContextBudget(
      "/Users/x/btrain",
      { enabled: true, softCeiling: 1, hardCeiling: 2, invalid: [], notes: [] },
      { env: { BTRAIN_TRANSCRIPT_DIR: dir, CLAUDE_CODE_SESSION_ID: "all-errors" } },
    )
    // Located explicitly, so the ceilings are as low as they can be -- if a
    // missing reading were ever read as 0 this would still say "ok", but if it
    // were read as a real figure it would block. The distinguishing assertion
    // is that there is no figure at all and nothing is blockable.
    assert.equal(result.source, "explicit")
    assert.equal(result.tokens, null, "no reading must not become a reading")
    assert.equal(result.level, "ok")
    assert.equal(result.blockable, false)
    assert.match(result.message + result.reason, /usage record/)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("context budget configuration", () => {
  it("defaults to the spec's ceilings", () => {
    const budget = getContextBudgetConfig({})
    assert.equal(budget.softCeiling, DEFAULT_SOFT_CEILING)
    assert.equal(budget.hardCeiling, DEFAULT_HARD_CEILING)
    assert.equal(budget.enabled, true)
  })

  it("lets a lane override the repo ceilings", () => {
    const config = {
      context_budget: { soft_ceiling: 100_000, hard_ceiling: 300_000, lanes: { a: { hard_ceiling: 500_000 } } },
    }
    const lane = getContextBudgetConfig(config, "a")
    assert.equal(lane.hardCeiling, 500_000, "lane value wins")
    assert.equal(lane.softCeiling, 100_000, "repo value fills the gap")

    const other = getContextBudgetConfig(config, "b")
    assert.equal(other.hardCeiling, 300_000, "an unconfigured lane uses the repo value")
  })

  it("ignores a non-numeric or negative ceiling rather than disabling the gate", () => {
    // A typo in project.toml must not silently turn the ceiling off.
    const budget = getContextBudgetConfig({ context_budget: { soft_ceiling: "lots", hard_ceiling: -1 } })
    assert.equal(budget.softCeiling, DEFAULT_SOFT_CEILING)
    assert.equal(budget.hardCeiling, DEFAULT_HARD_CEILING)
  })

  it("does not read a blank or empty ceiling as zero, which would disable the block", () => {
    // Found by review. `Number("")`, `Number(" ")`, `Number(false)`,
    // `Number([])` and `Number(null)` are all 0, and this module reads 0 as
    // "ceiling disabled". An earlier version accepted every one of them, so
    // `hard_ceiling = ""` in project.toml silently switched the hard block off
    // while reading as a deliberate setting. The original test only tried
    // "lots" and -1, both of which are NaN/negative and were already rejected.
    for (const bad of ["", " ", "\t", false, [], null]) {
      const budget = getContextBudgetConfig({ context_budget: { hard_ceiling: bad } })
      assert.equal(
        budget.hardCeiling,
        DEFAULT_HARD_CEILING,
        `hard_ceiling=${JSON.stringify(bad)} must fall back to the default, not to 0`,
      )
      assert.notEqual(budget.hardCeiling, 0)
    }
  })

  it("accepts TOML's underscore integer form instead of silently dropping it", () => {
    // `hard_ceiling = 350_000` is the natural thing to write -- the module
    // itself uses that form in JS. It arrives as the string "350_000",
    // `Number()` returns NaN, and an earlier version fell through to the
    // default. The setting read as applied and was not, and the bug was
    // invisible whenever the intended value happened to be the default.
    const budget = getContextBudgetConfig({ context_budget: { hard_ceiling: "350_000" } })
    assert.equal(budget.hardCeiling, 350_000)
    assert.equal(budget.invalid.length, 0)
  })

  it("reports a rejected config value instead of swallowing it", () => {
    const budget = getContextBudgetConfig({ context_budget: { hard_ceiling: "lots" } })
    assert.equal(budget.hardCeiling, DEFAULT_HARD_CEILING)
    assert.ok(
      budget.invalid.some((entry) => entry.includes("hard_ceiling")),
      "a value that could not be parsed must be reported, not silently defaulted",
    )
  })

  it("honours a lane-level enabled override, not just the repo one", () => {
    // Every other key honoured the lane override; `enabled` was read from the
    // repo table alone, so the documented rollback was repo-wide only.
    const config = { context_budget: { lanes: { a: { enabled: false } } } }
    assert.equal(getContextBudgetConfig(config, "a").enabled, false)
    assert.equal(getContextBudgetConfig(config, "b").enabled, true)
  })
})

// ──────────────────────────────────────────────
// The gate
// ──────────────────────────────────────────────

describe("context budget gate", () => {
  let dir

  before(async () => {
    dir = await makeTranscriptDir()
  })

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function evaluate(sessionId, tokens, extra = {}) {
    await writeTranscript(dir, sessionId, [turn({ cacheRead: tokens })])
    return evaluateContextBudget("/repo", extra.config || {}, {
      env: { BTRAIN_TRANSCRIPT_DIR: dir },
      sessionId,
      ...extra,
    })
  }

  it("passes a session under the soft ceiling", async () => {
    const verdict = await evaluate("under", 150_000)
    assert.equal(verdict.level, "ok")
    assert.equal(verdict.tokens, 150_000)
    assert.equal(verdict.message, "")
  })

  it("warns above the soft ceiling and names the current size", async () => {
    const verdict = await evaluate("soft", 250_000)
    assert.equal(verdict.level, "warn")
    assert.match(verdict.message, /250,000 tokens/, "the warning must state the measured size")
    assert.match(verdict.message, /200,000 soft ceiling/)
  })

  it("prints the real turn count in the warning, not just in the return value", async () => {
    // The turn count was fixed because it is printed to the user beside the
    // claim that cost scales with turns. Only the internal counter was
    // asserted, so replacing the printed value with 0 passed every test.
    await writeTranscript(dir, "turns", [
      turn({ cacheRead: 250_000, timestamp: "2026-09-15T10:00:00.000Z" }),
      turn({ cacheRead: 250_000, timestamp: "2026-09-15T10:01:00.000Z" }),
      turn({ cacheRead: 250_000, timestamp: "2026-09-15T10:02:00.000Z" }),
    ])
    const verdict = await evaluateContextBudget("/repo", {}, {
      env: { BTRAIN_TRANSCRIPT_DIR: dir },
      sessionId: "turns",
    })
    assert.equal(verdict.turns, 3)
    assert.match(verdict.message, /over 3 turns/, "the printed count must be the measured one")
  })

  it("applies a lane ceiling through the gate, not only through the config reader", async () => {
    // The lane override was tested one level down, at getContextBudgetConfig.
    // Nothing passed a laneId to evaluateContextBudget, so the wire between
    // them was unpinned: dropping `opts.laneId` entirely still passed.
    const config = { context_budget: { lanes: { c: { soft_ceiling: 100_000 } } } }
    const verdict = await evaluate("laned", 150_000, { config, laneId: "c" })
    assert.equal(verdict.level, "warn", "the lane's lower soft ceiling must apply")
    assert.equal(verdict.softCeiling, 100_000)

    const other = await evaluate("unlaned", 150_000, { config, laneId: "d" })
    assert.equal(other.level, "ok", "a lane with no override keeps the default")
  })

  it("reports exactly at a ceiling as under it, consistently for both", async () => {
    // Nothing tested equality, so flipping both comparisons to >= passed. The
    // choice matters at a round number a user is likely to configure.
    assert.equal((await evaluate("at-soft", 200_000)).level, "ok")
    assert.equal((await evaluate("at-hard", 400_000)).level, "warn")
    assert.equal((await evaluate("over-hard", 400_001)).level, "block")
  })

  it("tells the user in the message, not only in the reason, that a setting was ignored", async () => {
    // btrain's TOML parser does not strip trailing comments, so
    // `hard_ceiling = 400000  # raised` arrives as one string and is rejected.
    // The note reached `reason` alone, which the warn and block paths do not
    // print, so a user whose ceiling was thrown away saw no sign of it.
    const verdict = await evaluate("noted", 250_000, {
      config: { context_budget: { soft_ceiling: "200000 # tuned" } },
    })
    assert.match(verdict.message, /Ignored unparseable config/, "the message is what the user reads")
    assert.match(verdict.message, /soft_ceiling/)
  })

  it("does not silently arm the gate when `enabled` is not a boolean", async () => {
    // The documented rollback is `enabled = false`. btrain's TOML parser
    // returns a string for anything it does not recognise as a literal, and
    // `"false" !== false`, so a quoted value left the gate fully armed and said
    // nothing. Refusing the value and saying so is the only honest option:
    // guessing the user meant off would disable a safety gate on a typo.
    const verdict = await evaluate("stringly", 450_000, {
      config: { context_budget: { enabled: "false" } },
    })
    assert.equal(verdict.level, "block", "a value btrain cannot read must not be taken as off")
    assert.match(verdict.message, /enabled/, "and the user must be told it was rejected")
  })

  it("says so when the soft ceiling sits above the hard one", async () => {
    // Legal to write, and the block still wins, but the warn step can never
    // fire -- so the documented "warn first, then block" contract disappears
    // with no diagnostic at all.
    const verdict = await evaluate("inverted", 450_000, {
      config: { context_budget: { soft_ceiling: 500_000, hard_ceiling: 400_000 } },
    })
    assert.equal(verdict.level, "block")
    assert.match(verdict.message, /soft_ceiling/, "the inverted pair must be called out")
  })

  it("blocks above the hard ceiling when the session is known", async () => {
    const verdict = await evaluate("hard", 450_000)
    assert.equal(verdict.level, "block")
    assert.equal(verdict.blockable, true)
    assert.match(verdict.message, /450,000 tokens/)
    // The escape hatch must be a real one. An earlier version pointed at
    // `btrain override grant --action context-budget`, which is not in
    // VALID_OVERRIDE_ACTIONS, so every blocked user followed the printed
    // instruction into a hard error. Asserting the word "override" appeared was
    // what let that ship.
    assert.match(verdict.message, /hard_ceiling/, "a block must name a real escape hatch")
    assert.match(verdict.message, /project\.toml/)
    assert.doesNotMatch(
      verdict.message,
      /override grant/,
      "must not name an override action btrain does not accept",
    )
  })

  it("warns but never blocks when no session id names the caller", async () => {
    // The safety property, restated for the corrected model. Without a session
    // id btrain is not running inside an agent session, so the newest
    // transcript belongs to somebody else. Blocking a lane on another
    // session's context would be worse than not gating at all.
    const looseDir = await makeTranscriptDir()
    try {
      await writeTranscript(looseDir, "someone-else", [turn({ cacheRead: 900_000 })])
      const verdict = await evaluateContextBudget("/repo", {}, {
        env: { BTRAIN_TRANSCRIPT_DIR: looseDir },
      })
      assert.equal(verdict.source, "inferred")
      assert.equal(verdict.level, "warn", "an unattributed reading must never block")
      assert.equal(verdict.blockable, false)
      assert.match(verdict.message, /Not blocking/)
    } finally {
      await fs.rm(looseDir, { recursive: true, force: true })
    }
  })

  it("names the attribution in a soft-ceiling warning that is not exact", async () => {
    // Otherwise an informational reading is indistinguishable from the
    // caller's own, which is the whole point of tracking the source.
    const looseDir = await makeTranscriptDir()
    try {
      await writeTranscript(looseDir, "other", [turn({ cacheRead: 250_000 })])
      const verdict = await evaluateContextBudget("/repo", {}, {
        env: { BTRAIN_TRANSCRIPT_DIR: looseDir },
      })
      assert.equal(verdict.level, "warn")
      assert.match(verdict.message, /not running inside an agent session/)
    } finally {
      await fs.rm(looseDir, { recursive: true, force: true })
    }
  })

  it("passes with a stated reason when no measurement is available", async () => {
    // Absence of a reading is not a reading of zero. The verdict is `ok` so the
    // workflow proceeds, but `reason` says why, so an operator can tell a
    // healthy session from an unmeasured one.
    const verdict = await evaluateContextBudget("/repo", {}, {
      env: { BTRAIN_TRANSCRIPT_DIR: "/nonexistent/transcripts" },
    })
    assert.equal(verdict.level, "ok")
    assert.equal(verdict.tokens, null)
    assert.equal(verdict.source, "unavailable")
    assert.match(verdict.reason, /no transcript directory/)
  })

  it("is fully disabled by config, which is the documented rollback", async () => {
    const verdict = await evaluate("disabled", 900_000, { config: { context_budget: { enabled: false } } })
    assert.equal(verdict.level, "ok")
    assert.equal(verdict.tokens, null)
    assert.match(verdict.reason, /disabled/)
  })

  it("treats a zero ceiling as off for that ceiling only", async () => {
    const verdict = await evaluate("zeroed", 900_000, {
      config: { context_budget: { hard_ceiling: 0 } },
    })
    assert.equal(verdict.level, "warn", "the soft ceiling still applies")
    assert.notEqual(verdict.level, "block")

    // The other half of the documented rollback, and it was unpinned: deleting
    // the soft-ceiling zero check passed every test.
    const softOff = await evaluate("soft-zeroed", 250_000, {
      config: { context_budget: { soft_ceiling: 0 } },
    })
    assert.equal(softOff.level, "ok", "a zero soft ceiling must silence the warning")
  })
})
