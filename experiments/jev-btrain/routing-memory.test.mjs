import test from "node:test"
import assert from "node:assert/strict"
import { evaluateRoutingPairs, evaluateMemoryPairs } from "./routing-memory.mjs"

const routePair = (id, extra = {}) => ({ id, kind: "reviewer", origin: "synthetic", eligibleIds: ["a", "b"],
  baselineId: "a", suggestedId: "b", baselineSucceeded: false, suggestedSucceeded: true, ...extra })
const memoryPair = (id, extra = {}) => ({ id, origin: "synthetic", superseded: true, ageBaselineStale: false, warned: true, ...extra })

test("G8 accounting separates routing kinds and real cases from synthetic controls", () => {
  const report = evaluateRoutingPairs("reviewer", [routePair("real", { origin: "real", sourceRef: "https://example.test/1", sourceSnapshotHash: "a".repeat(64) }),
    routePair("control", { suggestedId: "ineligible" })])
  assert.equal(report.real.successDifferencePercentagePoints, 100)
  assert.equal(report.real.ineligibleRoutes, 0)
  assert.equal(report.synthetic.ineligibleRoutes, 1)
  assert.equal(report.gateReady, false)
  assert.throws(() => evaluateRoutingPairs("reviewer", [routePair("wrong", { kind: "runner" })]))
})

test("routing accounting includes failed routes and unavailable eligible destinations", () => {
  const report = evaluateRoutingPairs("reviewer", [routePair("a"), routePair("b", {
    eligibleIds: [], baselineId: null, suggestedId: null, baselineSucceeded: false, suggestedSucceeded: false,
  })])
  assert.equal(report.synthetic.suggestedSuccessRate, 0.5)
  assert.equal(report.synthetic.successDifferencePercentagePoints, 50)
  assert.equal(report.synthetic.ineligibleRoutes, 0)
})

test("memory accounting compares semantic warnings and age baseline on identical claims", () => {
  const report = evaluateMemoryPairs([memoryPair("tp"), memoryPair("fn", { warned: false }),
    memoryPair("fp", { superseded: false, ageBaselineStale: true }),
    memoryPair("tn", { superseded: false, warned: false, ageBaselineStale: true })])
  assert.equal(report.synthetic.semantic.precision, 0.5)
  assert.equal(report.synthetic.semantic.recall, 0.5)
  assert.equal(report.synthetic.age.precision, 0)
  assert.equal(report.synthetic.age.recall, 0)
  assert.equal(report.real.cases, 0)
  assert.equal(report.gateReady, false)
})

test("measurement validation rejects duplicates invalid origins unproven real cases and malformed booleans", () => {
  for (const pairs of [[routePair("a"), routePair("a")], [routePair("a", { origin: "invalid" })],
    [routePair("a", { origin: "real" })], [routePair("a", { suggestedSucceeded: "yes" })],
    [routePair("a", { baselineId: "ineligible" })], [routePair("a", { eligibleIds: ["a", "a"] })]]) {
    assert.throws(() => evaluateRoutingPairs("reviewer", pairs))
  }
  assert.throws(() => evaluateMemoryPairs([memoryPair("a", { superseded: "yes" })]))
  assert.throws(() => evaluateMemoryPairs([memoryPair("a", { origin: "real", sourceRef: "https://user:pass@example.test/1", sourceSnapshotHash: "a".repeat(64) })]))
})

test("coercible hashes cannot be counted as real routing or memory evidence", () => {
  const extra = { origin: "real", sourceRef: "https://example.test/1", sourceSnapshotHash: ["a".repeat(64)] }
  assert.throws(() => evaluateRoutingPairs("reviewer", [routePair("a", extra)]))
  assert.throws(() => evaluateMemoryPairs([memoryPair("a", extra)]))
})

test("routing measurements must retain the adapter's first eligible baseline destination", () => {
  assert.throws(() => evaluateRoutingPairs("reviewer", [routePair("a", { baselineId: null })]))
  assert.throws(() => evaluateRoutingPairs("reviewer", [routePair("a", { baselineId: "b" })]))
})

test("identical paired destinations cannot claim contradictory success outcomes", () => {
  assert.throws(() => evaluateRoutingPairs("reviewer", [routePair("same", { suggestedId: "a" })]))
  const report = evaluateRoutingPairs("reviewer", [routePair("same", { suggestedId: "a", baselineSucceeded: true })])
  assert.equal(report.synthetic.successDifferencePercentagePoints, 0)
})
