import test from "node:test"
import assert from "node:assert/strict"
import { evaluateRulePairs, evaluateReviewQueues } from "./rules-risk.mjs"

function pair(id, extra = {}) {
  return { id, kind: "diff", origin: "synthetic", violation: true, baselineWarned: false,
    semanticWarned: true, inventedCitations: 0, eligible: true, outcome: "decision", attemptedCall: true, ...extra }
}

function queue(id, extra = {}) {
  return { id, origin: "synthetic", baselineIds: ["a", "b", "c", "d"], prioritizedIds: ["d", "a", "b", "c"],
    defectIds: ["d"], severeIds: ["d"], baselineFoundIds: ["d"], prioritizedFoundIds: ["d"],
    gatewayAttempts: ["a", "b", "c", "d"].map((reviewId) => ({ reviewId, eligible: true, attemptedCall: true, outcome: "decision" })),
    baselineMinutes: 10, prioritizedMinutes: 11, ...extra }
}

test("G6-R and G6-T report independent baselines precision recall and gateway outcomes", () => {
  const result = evaluateRulePairs("diff", [pair("tp"), pair("fn", { semanticWarned: false, outcome: "failure" }),
    pair("fp", { violation: false, baselineWarned: true }),
    pair("tn", { violation: false, semanticWarned: false, outcome: "abstain" })])
  assert.equal(result.synthetic.semantic.precision, 0.5)
  assert.equal(result.synthetic.semantic.recall, 0.5)
  assert.equal(result.synthetic.baseline.precision, 0)
  assert.equal(result.synthetic.gateway.attemptedFailureRate, 0.25)
  assert.equal(result.synthetic.gateway.validPredictionCoverage, 0.75)
  assert.equal(result.synthetic.gateway.actionableDecisionCoverage, 0.5)
  assert.equal(result.gateReady, false)
  assert.throws(() => evaluateRulePairs("turn", [pair("mixed")]))
  assert.equal(evaluateRulePairs("turn", [pair("turn", { kind: "turn" })]).family, "end-of-turn-rules")
})

test("synthetic citations and failures cannot be hidden inside real rule-case metrics", () => {
  const result = evaluateRulePairs("diff", [pair("real", { origin: "real", sourceRef: "https://example.test/1", sourceSnapshotHash: "a".repeat(64) }),
    pair("control", { inventedCitations: 2 }), pair("skipped", { eligible: false, semanticWarned: false, attemptedCall: false, outcome: "skipped" }),
    pair("no-provider", { semanticWarned: false, attemptedCall: false, outcome: "failure" })])
  assert.equal(result.real.cases, 1)
  assert.equal(result.real.inventedCitations, 0)
  assert.equal(result.synthetic.inventedCitations, 2)
  assert.equal(result.synthetic.gateway.skipped, 1)
  assert.equal(result.synthetic.gateway.failuresWithoutCall, 1)
})

test("G6-V accounts for severe findings in the top 30 percent and time at equal defect recall", () => {
  const result = evaluateReviewQueues([queue("one"), queue("two", { baselineMinutes: 20, prioritizedMinutes: 20 })])
  assert.equal(result.synthetic.severeRecallInTopThirtyPercent, 1)
  assert.equal(result.synthetic.baselineSevereRecallInTopThirtyPercent, 0)
  assert.equal(result.synthetic.baselineDefectRecall, 1)
  assert.equal(result.synthetic.prioritizedDefectRecall, 1)
  assert.equal(result.synthetic.equalDefectRecall, true)
  assert.ok(Math.abs(result.synthetic.reviewerTimeChangeFraction - 1 / 30) < 1e-10)
  assert.equal(result.gateReady, false)
})

test("review queue evaluation reports loss of defect recall and does not invent precision for empty classes", () => {
  const result = evaluateReviewQueues([queue("one", { prioritizedFoundIds: [] })])
  assert.equal(result.synthetic.equalDefectRecall, false)
  assert.equal(result.synthetic.prioritizedDefectRecall, 0)
  assert.equal(result.real.severeRecallInTopThirtyPercent, null)
  assert.equal(result.real.reviewerTimeChangeFraction, null)
})

test("evaluation rejects removed reviews invented findings duplicate IDs coercible hashes and impossible trace outcomes", () => {
  for (const value of [queue("a", { prioritizedIds: ["d"] }), queue("a", { prioritizedIds: ["d", "a", "b", "invented"] }),
    queue("a", { severeIds: ["invented"] }), queue("a", { baselineFoundIds: ["a"] }),
    queue("a", { baselineMinutes: 0 }), queue("a", { prioritizedMinutes: -1 })]) {
    assert.throws(() => evaluateReviewQueues([value]))
  }
  assert.throws(() => evaluateReviewQueues([queue("a"), queue("a")]))
  const malformedReal = { origin: "real", sourceRef: "https://example.test/1", sourceSnapshotHash: ["a".repeat(64)] }
  assert.throws(() => evaluateReviewQueues([queue("a", malformedReal)]))
  assert.throws(() => evaluateRulePairs("diff", [pair("a", malformedReal)]))
  for (const value of [pair("a", { semanticWarned: true, outcome: "failure" }),
    pair("a", { outcome: "skipped", attemptedCall: true, semanticWarned: false }),
    pair("a", { eligible: false }), pair("a", { inventedCitations: -1 }), pair("a", { outcome: "decision", attemptedCall: false })]) {
    assert.throws(() => evaluateRulePairs("diff", [value]))
  }
})

test("sparse ID lists cannot hide removed reviews or inflate finding denominators", () => {
  const omitted = queue("omitted")
  delete omitted.prioritizedIds[0]
  assert.throws(() => evaluateReviewQueues([omitted]))
  for (const field of ["defectIds", "severeIds", "baselineFoundIds", "prioritizedFoundIds"]) {
    const value = queue(field)
    value[field].length = 2
    assert.throws(() => evaluateReviewQueues([value]))
  }
  const baseline = queue("baseline", { defectIds: [], severeIds: [], baselineFoundIds: [], prioritizedFoundIds: [] })
  delete baseline.baselineIds[3]
  baseline.prioritizedIds = baseline.baselineIds.slice()
  assert.throws(() => evaluateReviewQueues([baseline]))
})

test("G6-V reports gateway failures abstentions and eligible decision coverage per review", () => {
  const gatewayAttempts = [
    { reviewId: "a", eligible: true, attemptedCall: true, outcome: "decision" },
    { reviewId: "b", eligible: true, attemptedCall: true, outcome: "abstain" },
    { reviewId: "c", eligible: true, attemptedCall: true, outcome: "failure" },
    { reviewId: "d", eligible: false, attemptedCall: false, outcome: "skipped" },
  ]
  const result = evaluateReviewQueues([queue("mixed", { gatewayAttempts })])
  assert.deepEqual(result.synthetic.gateway, { eligible: 3, attemptedCalls: 3, decisions: 1, abstentions: 1,
    skipped: 1, attemptedFailures: 1, failuresWithoutCall: 0, attemptedFailureRate: 1 / 3,
    validPredictionCoverage: 2 / 3, actionableDecisionCoverage: 1 / 3 })
  assert.equal(result.real.gateway.attemptedFailureRate, null)
  const failuresWithoutCalls = evaluateReviewQueues([queue("no-provider", {
    gatewayAttempts: gatewayAttempts.map((entry) => ({ ...entry, eligible: true, attemptedCall: false, outcome: "failure" })),
  })]).synthetic.gateway
  assert.equal(failuresWithoutCalls.attemptedCalls, 0)
  assert.equal(failuresWithoutCalls.failuresWithoutCall, 4)
  assert.equal(failuresWithoutCalls.attemptedFailureRate, null)
  assert.equal(failuresWithoutCalls.actionableDecisionCoverage, 0)
})

test("G6-V rejects missing removed duplicate sparse and inconsistent gateway measurements", () => {
  const entry = { reviewId: "a", eligible: true, attemptedCall: true, outcome: "decision" }
  for (const gatewayAttempts of [undefined, [], [entry], [entry, entry, entry, entry],
    [entry, { ...entry, reviewId: "b", attemptedCall: false }, { ...entry, reviewId: "c" }, { ...entry, reviewId: "d" }]]) {
    assert.throws(() => evaluateReviewQueues([queue("bad", { gatewayAttempts })]))
  }
  const sparse = queue("sparse").gatewayAttempts
  delete sparse[0]
  assert.throws(() => evaluateReviewQueues([queue("bad", { gatewayAttempts: sparse })]))
})
