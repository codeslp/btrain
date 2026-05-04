import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  normalizePrNumber,
  buildCurrentSection,
  parseCurrentSection,
  buildLaneGuidance,
} from "../src/brain_train/core.mjs"

describe("normalizePrNumber", () => {
  it("returns '' on empty / null / undefined / whitespace", () => {
    assert.equal(normalizePrNumber(""), "")
    assert.equal(normalizePrNumber("   "), "")
    assert.equal(normalizePrNumber(null), "")
    assert.equal(normalizePrNumber(undefined), "")
  })

  it("accepts a bare digit string", () => {
    assert.equal(normalizePrNumber("3"), "3")
    assert.equal(normalizePrNumber("123"), "123")
  })

  it("accepts a number", () => {
    assert.equal(normalizePrNumber(42), "42")
  })

  it("strips a leading #", () => {
    assert.equal(normalizePrNumber("#7"), "7")
    assert.equal(normalizePrNumber("  #7  "), "7")
  })

  it("extracts the PR number from a github URL (singular and plural path)", () => {
    assert.equal(
      normalizePrNumber("https://github.com/owner/repo/pull/42"),
      "42",
    )
    assert.equal(
      normalizePrNumber("https://github.com/owner/repo/pulls/42"),
      "42",
    )
    assert.equal(
      normalizePrNumber("https://github.com/owner/repo/pull/42#issuecomment-1"),
      "42",
    )
  })

  it("rejects non-numeric garbage and returns ''", () => {
    assert.equal(normalizePrNumber("abc"), "")
    assert.equal(normalizePrNumber("3a"), "")
    assert.equal(normalizePrNumber("https://example.com/no/pr/here"), "")
  })
})

describe("buildCurrentSection / parseCurrentSection round-trip with prNumber", () => {
  it("emits a `PR:` line when prNumber is set", () => {
    const section = buildCurrentSection({
      task: "Test task",
      owner: "claude",
      reviewer: "codex",
      status: "needs-review",
      reviewMode: "manual",
      lockedFiles: ["foo.ts"],
      nextAction: "n/a",
      base: "main",
      prNumber: "42",
      lastUpdated: "claude 2026-05-04T00:00:00.000Z",
    })
    assert.match(section, /^PR: 42$/m)
  })

  it("omits the `PR:` line when prNumber is empty", () => {
    const section = buildCurrentSection({
      task: "Test task",
      owner: "claude",
      reviewer: "codex",
      status: "needs-review",
      reviewMode: "manual",
      lockedFiles: ["foo.ts"],
      nextAction: "n/a",
      base: "main",
      prNumber: "",
      lastUpdated: "claude 2026-05-04T00:00:00.000Z",
    })
    assert.doesNotMatch(section, /^PR:/m)
  })

  it("round-trips: build then parse returns the same prNumber", () => {
    const built = buildCurrentSection({
      task: "Test",
      owner: "claude",
      reviewer: "codex",
      status: "needs-review",
      lockedFiles: ["a"],
      nextAction: "x",
      base: "main",
      prNumber: "99",
    })
    // buildCurrentSection emits its own "## Current" header — pass the built
    // section directly; do not wrap it in another header.
    const parsed = parseCurrentSection(built)
    assert.equal(parsed.prNumber, "99")
    assert.equal(parsed.task, "Test")
    assert.equal(parsed.owner, "claude")
  })

  it("round-trips: section without PR parses to empty prNumber", () => {
    const built = buildCurrentSection({
      task: "Test",
      owner: "claude",
      reviewer: "codex",
      status: "needs-review",
      lockedFiles: ["a"],
      nextAction: "x",
      base: "main",
    })
    const parsed = parseCurrentSection(built)
    assert.equal(parsed.prNumber, "")
    assert.equal(parsed.task, "Test")
  })
})

describe("buildLaneGuidance — needs-review with linked PR", () => {
  function makeNeedsReviewLane(overrides = {}) {
    return {
      status: "needs-review",
      owner: "claude",
      reviewer: "codex",
      reviewMode: "manual",
      lockState: "ok",
      lockCount: 1,
      lockPaths: ["src/foo.ts"],
      ...overrides,
    }
  }

  it("emits the `gh pr view <N>` cue when prNumber is set", () => {
    const out = buildLaneGuidance("a", makeNeedsReviewLane({ prNumber: "3" }))
    assert.match(out, /Review the PR/i)
    assert.match(out, /gh pr view 3/)
    assert.match(out, /gh pr diff 3/)
    assert.match(out, /diff lives there, not in the local working tree/i)
  })

  it("emits the `no PR linked` cue when prNumber is empty", () => {
    const out = buildLaneGuidance("a", makeNeedsReviewLane({ prNumber: "" }))
    assert.match(out, /No PR linked/i)
    assert.match(out, /btrain handoff update --lane a --pr <number>/)
  })

  it("preserves the existing reviewer instruction", () => {
    const out = buildLaneGuidance("a", makeNeedsReviewLane({ prNumber: "3" }))
    assert.match(out, /codex: review/)
    assert.match(out, /handoff resolve --lane a --summary/)
  })
})

describe("buildLaneGuidance — changes-requested with linked PR", () => {
  function makeChangesRequestedLane(overrides = {}) {
    return {
      status: "changes-requested",
      owner: "claude",
      reviewer: "codex",
      lockState: "ok",
      lockCount: 1,
      lockPaths: ["src/foo.ts"],
      reasonCode: "spec-mismatch",
      reasonTags: ["empty-diff"],
      ...overrides,
    }
  }

  it("tells the writer the reviewer should consult the PR diff (when prNumber is set)", () => {
    const out = buildLaneGuidance("a", makeChangesRequestedLane({ prNumber: "3" }))
    assert.match(out, /Linked PR/i)
    assert.match(out, /gh pr view 3/)
    assert.match(out, /not the local working tree/i)
  })

  it("tells the writer to link a PR when prNumber is empty", () => {
    const out = buildLaneGuidance("a", makeChangesRequestedLane({ prNumber: "" }))
    assert.match(out, /No PR linked/i)
    assert.match(out, /--pr <number>/)
  })

  it("preserves reason code / tags / writer instruction", () => {
    const out = buildLaneGuidance("a", makeChangesRequestedLane({ prNumber: "3" }))
    assert.match(out, /spec-mismatch/)
    assert.match(out, /empty-diff/)
    assert.match(out, /address the reviewer findings/)
  })
})
