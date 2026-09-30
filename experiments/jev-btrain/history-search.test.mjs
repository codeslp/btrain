import test from "node:test"
import assert from "node:assert/strict"
import { evaluateHistoryPairs } from "./history-search.mjs"

function pair(overrides = {}) {
  return { id: "q1", origin: "synthetic", principalId: "alice", sourceAccessRoles: ["reviewer"],
    authorizedIds: ["a", "b", "c", "d", "e", "f"], relevantIds: ["f"],
    baselineIds: ["a", "b", "c", "d", "e", "f"], rankedIds: ["f", "a", "b", "c", "d", "e"], elapsedMs: 20,
    gatewayAttempts: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, eligible: true, attemptedCall: true, outcome: "decision" })),
    ...overrides }
}

test("history reports paired recall at five, latency and gateway floors by origin", () => {
  const result = evaluateHistoryPairs([pair(), pair({ id: "q2", origin: "real", sourceRef: "https://example.test/queries/2",
    sourceSnapshotHash: "a".repeat(64), elapsedMs: 1000 })])
  for (const origin of ["synthetic", "real"]) {
    assert.equal(result[origin].cases, 1)
    assert.equal(result[origin].baselineRecallAt5, 0)
    assert.equal(result[origin].semanticRecallAt5, 1)
    assert.equal(result[origin].recallDifferencePercentagePoints, 100)
    assert.equal(result[origin].unauthorizedResults, 0)
    assert.equal(result[origin].gateway.actionableCoverage, 1)
  }
  assert.equal(result.real.latencyMs.p95, 1000)
  assert.equal(result.unknown.baselineRecallAt5, null)
  assert.equal(result.gateReady, false)
})

test("history counts attempted failures and skips without crediting partial rankings", () => {
  const input = pair()
  input.rankedIds = [...input.baselineIds]
  input.gatewayAttempts[0] = { id: "a", eligible: true, attemptedCall: true, outcome: "failure" }
  input.gatewayAttempts[1] = { id: "b", eligible: true, attemptedCall: false, outcome: "skipped" }
  const result = evaluateHistoryPairs([input]).synthetic
  assert.equal(result.gateway.eligible, 6)
  assert.equal(result.gateway.attempted, 5)
  assert.equal(result.gateway.failures, 1)
  assert.equal(result.gateway.skipped, 1)
  assert.equal(result.gateway.actionable, 4)
  assert.equal(result.gateway.actionableCoverage, 4 / 6)
  assert.equal(result.semanticRecallAt5, 0)
})

test("history rejects unauthorized IDs, invented reranks, incomplete gateway evidence and false role metadata", () => {
  const changes = [
    { rankedIds: ["secret", "a", "b", "c", "d", "e"] },
    { relevantIds: ["secret"] }, { authorizedIds: ["a"] }, { rankedIds: ["f"] },
    { sourceAccessRoles: "reviewer" }, { elapsedMs: -1 },
    { gatewayAttempts: [] }, { gatewayAttempts: [pair().gatewayAttempts[0]] },
    { gatewayAttempts: pair().gatewayAttempts.map((attempt) => ({ ...attempt, id: "a" })) },
    { gatewayAttempts: pair().gatewayAttempts.map((attempt) => ({ ...attempt, eligible: false })) },
    { gatewayAttempts: pair().gatewayAttempts.map((attempt) => ({ ...attempt, outcome: "skipped" })) },
  ]
  for (const changed of changes) assert.throws(() => evaluateHistoryPairs([pair(changed)]))
  const partial = pair()
  partial.gatewayAttempts[0].outcome = "failure"
  assert.throws(() => evaluateHistoryPairs([partial]), /baseline/)
  assert.throws(() => evaluateHistoryPairs([pair({ origin: "real" })]), /proof/)
  assert.throws(() => evaluateHistoryPairs([pair(), pair()]), /unique/)
})

test("history rejects sparse or iterator-disguised measurement catalogs", () => {
  const sparse = new Array(6)
  sparse[0] = pair().gatewayAttempts[0]
  sparse[Symbol.iterator] = function* () { yield* pair().gatewayAttempts }
  assert.throws(() => evaluateHistoryPairs([pair({ gatewayAttempts: sparse })]))
  const disguised = pair().gatewayAttempts.map((attempt) => ({ ...attempt, id: "a" }))
  disguised[Symbol.iterator] = function* () { yield* pair().gatewayAttempts }
  assert.throws(() => evaluateHistoryPairs([pair({ gatewayAttempts: disguised })]))
})


test("history failure rate uses attempted calls and reports failures without calls separately", () => {
  const input = pair()
  input.rankedIds = [...input.baselineIds]
  input.gatewayAttempts = input.gatewayAttempts.map((attempt, index) => ({ ...attempt,
    outcome: index < 2 ? "failure" : "skipped", attemptedCall: index === 0 }))
  const gateway = evaluateHistoryPairs([input]).synthetic.gateway
  assert.equal(gateway.attempted, 1)
  assert.equal(gateway.failureRate, 1)
  assert.equal(gateway.attemptedFailures, 1)
  assert.equal(gateway.failuresWithoutCall, 1)
  assert.equal(gateway.validPredictionCoverage, 0)
})
