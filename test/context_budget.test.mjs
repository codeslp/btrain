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
function turn({ input = 0, cacheWrite = 0, cacheRead = 0, output = 0 }) {
  return JSON.stringify({
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
  })
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

// ──────────────────────────────────────────────
// Attribution
// ──────────────────────────────────────────────

describe("context budget session attribution", () => {
  it("encodes the repo path the way Claude Code names its transcript directory", () => {
    const dir = resolveTranscriptDir("/Users/x/btrain", { CLAUDE_CONFIG_DIR: "/cfg" })
    assert.equal(dir, path.join("/cfg", "projects", "-Users-x-btrain"))
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

  it("infers the session when exactly one transcript is live", async () => {
    const dir = await makeTranscriptDir()
    try {
      const now = Date.now()
      await writeTranscript(dir, "live", [turn({ cacheRead: 10 })], now)
      await writeTranscript(dir, "stale", [turn({ cacheRead: 10 })], now - 60 * 60 * 1000)
      const located = await locateSessionTranscript("/repo", {
        env: { BTRAIN_TRANSCRIPT_DIR: dir },
        now,
      })
      assert.equal(located.source, "inferred")
      assert.match(located.transcriptPath, /live\.jsonl$/)
      assert.equal(located.candidates, 1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("reports ambiguity rather than picking the newest of several live sessions", async () => {
    // Multi-lane work is btrain's normal mode: several agents, one repo, several
    // live transcripts. Picking the newest would charge one lane's context to
    // another and could block a lane that is nowhere near its ceiling.
    const dir = await makeTranscriptDir()
    try {
      const now = Date.now()
      await writeTranscript(dir, "lane-a", [turn({ cacheRead: 10 })], now - 1000)
      await writeTranscript(dir, "lane-b", [turn({ cacheRead: 10 })], now)
      const located = await locateSessionTranscript("/repo", {
        env: { BTRAIN_TRANSCRIPT_DIR: dir },
        now,
      })
      assert.equal(located.source, "ambiguous")
      assert.equal(located.candidates, 2)
      assert.match(located.reason, /2 sessions are live/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
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

  it("blocks above the hard ceiling when the session is known", async () => {
    const verdict = await evaluate("hard", 450_000)
    assert.equal(verdict.level, "block")
    assert.equal(verdict.blockable, true)
    assert.match(verdict.message, /450,000 tokens/)
    assert.match(verdict.message, /override/, "a block must name its escape hatch")
  })

  it("warns but does not block when the reading cannot be attributed to one lane", async () => {
    // The safety property. An ambiguous reading over the hard ceiling must not
    // stop a lane, because the tokens may belong to a different session
    // entirely. Blocking on a guess would be worse than not gating at all.
    const ambiguousDir = await makeTranscriptDir()
    try {
      const now = Date.now()
      await writeTranscript(ambiguousDir, "one", [turn({ cacheRead: 900_000 })], now)
      await writeTranscript(ambiguousDir, "two", [turn({ cacheRead: 5_000 })], now - 500)
      const verdict = await evaluateContextBudget("/repo", {}, {
        env: { BTRAIN_TRANSCRIPT_DIR: ambiguousDir },
        now,
      })
      assert.equal(verdict.source, "ambiguous")
      assert.equal(verdict.level, "warn", "an unattributable reading must never block")
      assert.equal(verdict.blockable, false)
      assert.match(verdict.message, /Not blocking/)
    } finally {
      await fs.rm(ambiguousDir, { recursive: true, force: true })
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
  })
})
