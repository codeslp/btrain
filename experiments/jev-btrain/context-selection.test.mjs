import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { evaluateContextPairs } from "./context-selection.mjs"

describe("G7 offline paired accounting", () => {
  const pair = (id, kind, extra = {}) => ({ id, kind, baselineTokens: 100, selectedTokens: 80, baselineCompleted: true, selectedCompleted: true, pinnedOmissions: 0, origin: "synthetic", ...extra })

  it("reports dispatch and transcript independently without implying promotion", () => {
    const dispatch = evaluateContextPairs("dispatch", [pair("a", "dispatch"), pair("b", "dispatch", { selectedTokens: 70, selectedCompleted: false })])
    const transcript = evaluateContextPairs("transcript", [pair("c", "transcript", { selectedTokens: 50 })])
    assert.equal(dispatch.medianTokenReduction, 0.25)
    assert.equal(dispatch.completionDifferencePercentagePoints, -50)
    assert.equal(transcript.medianTokenReduction, 0.5)
    assert.equal(dispatch.gateReady, false)
    assert.equal(transcript.gateReady, false)
  })

  it("counts pinned omissions and excludes synthetic cases from real quota", () => {
    const result = evaluateContextPairs("dispatch", [pair("a", "dispatch", { pinnedOmissions: 1, origin: "real", sourceRef: "https://example.test/cases/a", sourceSnapshotHash: "a".repeat(64) }), pair("b", "dispatch")])
    assert.equal(result.pinnedOmissions, 1)
    assert.equal(result.realCases, 1)
    assert.equal(result.gateReady, false)
  })

  it("rejects mixed families, duplicate IDs, and invalid paired measurements", () => {
    for (const pairs of [[pair("a", "dispatch"), pair("b", "transcript")], [pair("a", "dispatch"), pair("a", "dispatch")], [pair("a", "dispatch", { selectedTokens: -1 })], [pair("a", "dispatch", { origin: "real" })], [pair("a", "dispatch", { origin: "false" })]]) {
      assert.throws(() => evaluateContextPairs("dispatch", pairs))
    }
  })

  it("does not count unknown-origin cases as real", () => {
    const result = evaluateContextPairs("dispatch", [pair("a", "dispatch", { origin: "unknown" })])
    assert.equal(result.realCases, 0)
  })
})
