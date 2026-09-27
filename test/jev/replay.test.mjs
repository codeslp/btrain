import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { summarizeReplay, replayManifest } from "../../src/brain_train/jev/replay.mjs"
import { createDecisionFamily } from "../../src/brain_train/jev/decision.mjs"
import { datasetHashFor } from "../../src/brain_train/jev/manifest.mjs"

const family = createDecisionFamily({ id: "sample", questionVersion: "1", choices: ["clear", "feedback", "uncertain"], privacyClass: "synthetic", allowedActions: ["flag"], threshold: 0.8, inputBuilder: (c) => ({ id: c.sourceId }), actionPolicy: (choice) => choice === "feedback" ? "flag" : null, fallback: (baseline) => baseline })
const rows = [
  { sourceId: "a", split: "test", label: "feedback", baseline: "uncertain", eligible: true, trace: { outcome: "decision", prediction: "feedback", attemptedCall: true, latencyMs: 10, cost: 0.01 } },
  { sourceId: "b", split: "test", label: "feedback", baseline: "feedback", eligible: true, trace: { outcome: "failure", reason: "invalid-answer", failureClass: "response-shape", attemptedCall: true } },
  { sourceId: "c", split: "test", label: "uncertain", baseline: "uncertain", eligible: true, trace: { outcome: "abstain", prediction: "uncertain", attemptedCall: true, latencyMs: 20, cost: 0.02 } },
  { sourceId: "d", split: "test", label: "clear", baseline: "clear", eligible: false, trace: { outcome: "skipped", reason: "ineligible", attemptedCall: false } },
]

describe("Jev replay metrics", () => {
  it("keeps skips, valid abstentions, and failures in distinct denominators", () => {
    const result = summarizeReplay(rows, ["clear", "feedback", "uncertain"])
    assert.equal(result.counts.cases, 4)
    assert.equal(result.counts.eligible, 3)
    assert.equal(result.counts.attempted, 3)
    assert.equal(result.counts.skipped, 1)
    assert.equal(result.counts.failures, 1)
    assert.equal(result.counts.validPredictions, 2)
    assert.equal(result.counts.actionableDecisions, 1)
    assert.equal(result.coverage.validPrediction, 2 / 3)
    assert.equal(result.coverage.actionable, 1 / 3)
    assert.equal(result.model.confusion.feedback.feedback, 1)
    assert.equal(result.model.support.feedback, 2)
    assert.equal(result.model.correct, 2)
    assert.equal(result.baseline.correct, 3)
    assert.deepEqual(result.failures, [{ sourceId: "b", reason: "invalid-answer", failureClass: "response-shape" }])
  })

  it("replays a pinned manifest through an injected provider reproducibly", async () => {
    const cases = [{ sourceId: "a", split: "test", label: "feedback" }]
    const labels = ["clear", "feedback", "uncertain"]
    const sourceSnapshotHash = "source-pin"
    const manifest = { datasetHash: datasetHashFor(cases, labels, sourceSnapshotHash), sourceSnapshotHash, labels, pins: { family: "sample", questionVersion: "1", policyHash: family.policyHash, model: "pinned", codeRevision: "rev" }, cases }
    const candidates = { a: { eligible: true, sourceRefs: ["https://example.test/a"], baseline: "uncertain" } }
    const provider = { decide: async () => ({ ok: true, model: "pinned", answers: { signal: { choice: "feedback", probabilities: { clear: 0.05, feedback: 0.9, uncertain: 0.05 } } }, latencyMs: 10 }) }
    const first = await replayManifest({ manifest, family, candidates, provider })
    const second = await replayManifest({ manifest, family, candidates, provider })
    assert.deepEqual(first, second)
    assert.equal(first.splits.test.model.correct, 1)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, pins: { ...manifest.pins, policyHash: "wrong" } }, family, candidates, provider }), /policy hash/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, cases: [{ ...cases[0], label: "clear" }] }, family, candidates, provider }), /dataset hash/)
  })
})
