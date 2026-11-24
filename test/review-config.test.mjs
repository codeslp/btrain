// Spec 023 "Configuration" through src/brain_train/review/review-config.mjs
// (plan WS1, T005).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { getReviewPolicy, parseDuration, REVIEW_DEFAULTS, stripTomlComment } from "../src/brain_train/review/review-config.mjs"

const MIN = 60_000

describe("parseDuration", () => {
  for (const [text, ms] of [
    ["15m", 15 * MIN],
    ["30s", 30_000],
    ["1h", 60 * MIN],
    ["1h30m", 90 * MIN],
    ["500ms", 500],
    [" 5M ", 5 * MIN],
  ]) {
    it(`parses ${JSON.stringify(text)}`, () => assert.equal(parseDuration(text), ms))
  }

  for (const text of ["", "15", "15 m", "m", "-5m", "0m", "1.5h", "15min", "1d"]) {
    it(`refuses ${JSON.stringify(text)}`, () => assert.equal(parseDuration(text), null))
  }

  it("refuses a value that is not a string", () => {
    assert.equal(parseDuration(15), null)
    assert.equal(parseDuration(undefined), null)
  })
})

describe("getReviewPolicy", () => {
  it("applies the spec's defaults when nothing is configured", () => {
    const policy = getReviewPolicy({})
    assert.equal(policy.otherLabWindowMs, 15 * MIN)
    assert.equal(policy.silenceLimitMs, 5 * MIN)
    assert.equal(policy.attemptMaxMs, 45 * MIN)
    assert.equal(policy.botPendingTimeoutMs, 30 * MIN)
    assert.deepEqual(policy.reviewerOrder, [])
    assert.deepEqual(policy.fixes, { enabled: true, maxFiles: 3, maxChangedLines: 60, maxRounds: 2 })
    assert.deepEqual(policy.signals, {})
    assert.deepEqual(policy.errors, [])
    assert.equal(getReviewPolicy(null).silenceLimitMs, 5 * MIN)
  })

  it("reads every key the way the project TOML parser returns it", () => {
    const policy = getReviewPolicy({
      review: {
        other_lab_window: "20m",
        silence_limit: "2m",
        attempt_max: "1h",
        reviewer_order: ["gem", "codex-reviewer"],
        fixes: { enabled: false, max_files: "5", max_changed_lines: "120", max_rounds: "1" },
        signals: { codex: { unavailable: ["usage limit"], refused: ["content policy"] } },
      },
      pr_flow: { bot_pending_timeout: "10m" },
    })
    assert.equal(policy.otherLabWindowMs, 20 * MIN)
    assert.equal(policy.silenceLimitMs, 2 * MIN)
    assert.equal(policy.attemptMaxMs, 60 * MIN)
    assert.equal(policy.botPendingTimeoutMs, 10 * MIN)
    assert.deepEqual(policy.reviewerOrder, ["gem", "codex-reviewer"])
    assert.deepEqual(policy.fixes, { enabled: false, maxFiles: 5, maxChangedLines: 120, maxRounds: 1 })
    assert.deepEqual(policy.signals, { codex: { unavailable: ["usage limit"], refused: ["content policy"] } })
    assert.deepEqual(policy.errors, [])
  })

  it("reads the spec's own sample, whose values end in inline comments the TOML parser keeps", () => {
    // What parseProjectToml in core.mjs returns for the spec's Configuration block.
    const policy = getReviewPolicy({
      review: {
        other_lab_window: '"20m"   # no same-lab review before this has passed',
        silence_limit: '"2m"       # no progress for this long ends one attempt',
        attempt_max: '"1h"        # hard cap on one attempt that keeps progressing',
        reviewer_order: '["gem", "codex-reviewer"]        # optional preference among other-lab agents',
        signals: { codex: { unavailable: '["usage limit"]  # note' } },
        fixes: { max_files: "3" },
      },
      pr_flow: { bot_pending_timeout: '"10m"   # new key: wait before asking the next bot' },
    })
    assert.deepEqual(policy.errors, [])
    assert.equal(policy.otherLabWindowMs, 20 * MIN)
    assert.equal(policy.silenceLimitMs, 2 * MIN)
    assert.equal(policy.attemptMaxMs, 60 * MIN)
    assert.equal(policy.botPendingTimeoutMs, 10 * MIN)
    assert.deepEqual(policy.reviewerOrder, ["gem", "codex-reviewer"])
    assert.deepEqual(policy.signals.codex.unavailable, ["usage limit"])
  })

  it("stripTomlComment recovers a quoted value or a list of quoted values, and leaves anything else", () => {
    assert.equal(stripTomlComment('"anthropic"  # x'), "anthropic")
    assert.equal(stripTomlComment('"a # b"  # c'), "a # b")
    assert.deepEqual(stripTomlComment("[]  # empty"), [])
    assert.deepEqual(stripTomlComment('["a", "b"] # c'), ["a", "b"])
    assert.equal(stripTomlComment("15m"), "15m")
    assert.equal(stripTomlComment('"15m'), '"15m')
    assert.deepEqual(stripTomlComment(["a"]), ["a"])
  })

  it("uses the default and reports an error for a duration that does not parse", () => {
    const policy = getReviewPolicy({ review: { other_lab_window: "15", silence_limit: "soon" }, pr_flow: { bot_pending_timeout: "0m" } })
    assert.equal(policy.otherLabWindowMs, 15 * MIN)
    assert.equal(policy.silenceLimitMs, 5 * MIN)
    assert.equal(policy.botPendingTimeoutMs, 30 * MIN)
    assert.deepEqual(policy.errors.map((error) => error.key), ["review.other_lab_window", "review.silence_limit", "pr_flow.bot_pending_timeout"])
    assert.match(policy.errors[0].message, /not a duration.*default 15m/)
  })

  it("uses the default and reports an error for a fix limit or flag that does not parse", () => {
    const policy = getReviewPolicy({ review: { fixes: { enabled: "yes", max_files: "0", max_changed_lines: "lots", max_rounds: "-1" } } })
    assert.deepEqual(policy.fixes, { ...REVIEW_DEFAULTS.fixes })
    assert.deepEqual(policy.errors.map((error) => error.key), [
      "review.fixes.enabled",
      "review.fixes.max_files",
      "review.fixes.max_changed_lines",
      "review.fixes.max_rounds",
    ])
  })

  it("reports a reviewer_order or signal list that is not a list", () => {
    const policy = getReviewPolicy({ review: { reviewer_order: "codex", signals: { codex: { unavailable: "usage limit" } } } })
    assert.deepEqual(policy.reviewerOrder, [])
    assert.deepEqual(policy.signals, { codex: { unavailable: [], refused: [] } })
    assert.deepEqual(policy.errors.map((error) => error.key), ["review.reviewer_order", "review.signals.codex.unavailable"])
  })
})
