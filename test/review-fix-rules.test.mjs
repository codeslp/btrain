// Spec 023 FR-11 through src/brain_train/review/fix-rules.mjs (task T033): one
// refusal, with its own message, for each condition.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { evaluateFixRules, FIX_RULES, inLockedFiles, isTestPath } from "../src/brain_train/review/fix-rules.mjs"

const HEAD = "a".repeat(40)
const GOOD = Object.freeze({
  tier: "other-lab",
  fixesEnabled: true,
  attempt: { head: HEAD, startedAt: "2026-11-23T12:00:00.000Z", reviewer: "codex-reviewer" },
  fixBase: HEAD,
  fixHeadDescendsFromBase: true,
  commits: [{ sha: "b".repeat(40), committedAt: "2026-11-23T12:05:00.000Z", trailerAgent: "codex-reviewer" }],
  files: ["src/feature.mjs"],
  lockedFiles: ["src/feature.mjs"],
  changedLines: 2,
  testLinesRemovedOrChanged: 0,
  weakenedTestFindings: 0,
  round: 1,
  limits: { maxFiles: 3, maxChangedLines: 60, maxRounds: 2 },
})

const BREAKS = {
  tier: { tier: "same-lab" },
  enabled: { fixesEnabled: false },
  base: { fixBase: "c".repeat(40) },
  descends: { fixHeadDescendsFromBase: false },
  commits: { commits: [] },
  "commit-time": { commits: [{ ...GOOD.commits[0], committedAt: "2026-11-23T11:59:00.000Z" }] },
  trailer: { commits: [{ ...GOOD.commits[0], trailerAgent: "" }] },
  "locked-files": { files: ["src/other.mjs"] },
  "max-files": { files: ["a", "b", "c", "d"], lockedFiles: ["a", "b", "c", "d"] },
  "max-lines": { changedLines: 61 },
  "test-lines": { testLinesRemovedOrChanged: 1 },
  "weakened-tests": { weakenedTestFindings: 1 },
  rounds: { round: 3 },
}

describe("evaluateFixRules", () => {
  it("accepts a fix that meets every condition", () => {
    assert.deepEqual(evaluateFixRules(GOOD), { ok: true, failures: [] })
  })

  it("has a test case for every rule", () => {
    assert.deepEqual(FIX_RULES.map((rule) => rule.id).sort(), Object.keys(BREAKS).sort())
  })

  for (const [id, change] of Object.entries(BREAKS)) {
    it(`refuses on ${id} alone, with that rule's message`, () => {
      const { ok, failures } = evaluateFixRules({ ...GOOD, ...change })
      assert.equal(ok, false)
      assert.deepEqual(failures.map((failure) => failure.id), [id])
      assert.ok(failures[0].message.length > 20)
    })
  }

  it("gives every condition its own message", () => {
    const messages = Object.entries(BREAKS).map(([, change]) => evaluateFixRules({ ...GOOD, ...change }).failures[0].message)
    assert.equal(new Set(messages).size, messages.length)
  })

  it("names the trailer the reviewer needs and the files outside the lane", () => {
    assert.match(evaluateFixRules({ ...GOOD, ...BREAKS.trailer }).failures[0].message, /Btrain-Agent: codex-reviewer/)
    assert.match(evaluateFixRules({ ...GOOD, files: ["src/feature.mjs", "src/other.mjs"] }).failures[0].message, /src\/other\.mjs/)
  })

  it("refuses a commit by another agent and a commit made at the attempt's start", () => {
    assert.deepEqual(evaluateFixRules({ ...GOOD, commits: [{ ...GOOD.commits[0], trailerAgent: "claude" }] }).failures.map((f) => f.id), ["trailer"])
    assert.deepEqual(evaluateFixRules({ ...GOOD, commits: [{ ...GOOD.commits[0], committedAt: GOOD.attempt.startedAt }] }).failures.map((f) => f.id), ["commit-time"])
  })

  it("allows the last round and refuses one more", () => {
    assert.equal(evaluateFixRules({ ...GOOD, round: 2 }).ok, true)
    assert.match(evaluateFixRules({ ...GOOD, round: 3 }).failures[0].message, /had 2 reviewer fixes/)
  })

  it("reports every failing condition at once", () => {
    const { failures } = evaluateFixRules({ ...GOOD, tier: "same-lab", changedLines: 999 })
    assert.deepEqual(failures.map((failure) => failure.id), ["tier", "max-lines"])
  })

  it("fails closed on missing facts", () => {
    const ids = evaluateFixRules({}).failures.map((failure) => failure.id)
    for (const id of ["tier", "enabled", "base", "descends", "commits"]) assert.ok(ids.includes(id), id)
  })
})

describe("inLockedFiles and isTestPath", () => {
  it("matches a locked file, a file under a locked directory, and nothing else", () => {
    assert.equal(inLockedFiles("src/a.mjs", ["src/a.mjs"]), true)
    assert.equal(inLockedFiles("./src/a.mjs", ["src/a.mjs"]), true)
    assert.equal(inLockedFiles("src/x/a.mjs", ["src/x/"]), true)
    assert.equal(inLockedFiles("src/x/a.mjs", ["src/x"]), true)
    assert.equal(inLockedFiles("src/xy/a.mjs", ["src/x"]), false)
    assert.equal(inLockedFiles("src/a.mjs", []), false)
  })

  it("recognizes test files and test configuration", () => {
    for (const file of ["test/a.test.mjs", "src/a.spec.ts", "pkg/__tests__/x.js", "vitest.config.ts", ".mocharc.json", "tests/conftest.py", "test_x.py"]) {
      assert.equal(isTestPath(file), true, file)
    }
    for (const file of ["src/a.mjs", "docs/testing.md", "src/contest.mjs"]) {
      assert.equal(isTestPath(file), false, file)
    }
  })
})
