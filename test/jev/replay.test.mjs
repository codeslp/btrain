import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { summarizeReplay, replayManifest } from "../../src/brain_train/jev/replay.mjs"
import { createDecisionFamily } from "../../src/brain_train/jev/decision.mjs"
import { datasetHashFor, sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"

const family = createDecisionFamily({ id: "sample", questionVersion: "1", policyVersion: "1", policyConfig: { evaluation: { baselineId: "fixture", thresholds: { feedback: 0.8 } } }, choices: ["clear", "feedback", "uncertain"], privacyClass: "synthetic", allowedActions: ["flag"], threshold: 0.8, inputBuilder: (c) => ({ id: c.sourceId }), actionPolicy: (choice) => choice === "feedback" ? "flag" : null, fallback: (baseline) => baseline })
const sourceContent = "frozen review text"
const sourceHash = createHash("sha256").update(sourceContent).digest("hex")
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

  it("reports zero F1 when supported classes are predicted entirely incorrectly", () => {
    const wrong = [
      { sourceId: "clear", label: "clear", baseline: "clear", eligible: true, trace: { outcome: "decision", prediction: "feedback", attemptedCall: true } },
      { sourceId: "feedback", label: "feedback", baseline: "feedback", eligible: true, trace: { outcome: "decision", prediction: "clear", attemptedCall: true } },
    ]
    const metrics = summarizeReplay(wrong, ["clear", "feedback"])
    assert.equal(metrics.model.perClass.clear.f1, 0)
    assert.equal(metrics.model.perClass.feedback.f1, 0)
  })

  it("uses nearest rank for tail latency with two observations", () => {
    const measured = [10, 1000].map((latencyMs) => ({ label: "clear", baseline: "clear", eligible: true, trace: { outcome: "decision", prediction: "clear", attemptedCall: true, latencyMs } }))
    assert.equal(summarizeReplay(measured, ["clear"]).latencyMs.p95, 1000)
  })

  it("reports multiclass calibration from complete probability vectors", () => {
    const scored = [
      { label: "feedback", baseline: "feedback", eligible: true, trace: { outcome: "decision", prediction: "feedback", probabilities: { feedback: 0.9, clear: 0.1 }, attemptedCall: true } },
      { label: "clear", baseline: "clear", eligible: true, trace: { outcome: "decision", prediction: "feedback", probabilities: { feedback: 0.6, clear: 0.4 }, attemptedCall: true } },
    ]
    const result = summarizeReplay(scored, ["clear", "feedback"])
    assert.equal(result.model.calibration.evaluated, 2)
    assert.ok(Math.abs(result.model.calibration.multiclassBrier - 0.37) < 1e-12)
    const rounded = [{ ...scored[0], trace: { ...scored[0].trace, probabilities: { feedback: 0.9, clear: 0.09 } } }]
    assert.equal(summarizeReplay(rounded, ["clear", "feedback"]).model.calibration.evaluated, 1)
    assert.equal(summarizeReplay(rows, ["clear", "feedback", "uncertain"]).model.calibration.multiclassBrier, null)
  })

  it("replays a pinned manifest through an injected provider reproducibly", async () => {
    const cases = [{ sourceId: "a", split: "test", label: "feedback", baseline: "uncertain", eligible: true, privacyClass: "synthetic", callIndex: 0 }]
    const labels = ["clear", "feedback", "uncertain"]
    const sources = [{ id: "a", sourceRef: "https://example.test/a", reviewedCommit: "a".repeat(40), eventHead: "a".repeat(40), sourceHash }]
    const sourceSnapshotHash = sourceSnapshotHashFor(sources)
    const pins = { family: "sample", questionVersion: "1", policyHash: family.policyHash, model: "pinned", codeRevision: "a".repeat(40), baseline: "fixture", thresholds: { feedback: 0.8 } }
    const manifest = { datasetHash: datasetHashFor(cases, labels, sourceSnapshotHash, pins), sourceSnapshotHash, sources, labels, pins, cases }
    const candidates = { a: { eligible: true, sourceRefs: ["https://example.test/a"], sourceContent, sourceHash, baseline: "uncertain", privacyClass: "synthetic", callIndex: 0 } }
    let providerCalls = 0
    const provider = { decide: async () => { providerCalls += 1; return { ok: true, model: "pinned", answers: { signal: { choice: "feedback", probabilities: { clear: 0.05, feedback: 0.9, uncertain: 0.05 } } }, latencyMs: 10 } } }
    const first = await replayManifest({ manifest, family, candidates, provider })
    const second = await replayManifest({ manifest, family, candidates, provider })
    const withoutTiming = (result) => {
      const copy = structuredClone(result)
      for (const row of copy.rows) delete row.trace.latencyMs
      for (const group of [copy.splits, copy.syntheticControls]) {
        for (const metrics of Object.values(group)) delete metrics.latencyMs
      }
      return copy
    }
    assert.deepEqual(withoutTiming(first), withoutTiming(second))
    assert.equal(first.syntheticControls.test.model.correct, 1)
    assert.equal(first.rows[0].trace.sourceSnapshotHash, sourceSnapshotHashFor(sources))
    assert.equal(first.rows[0].trace.sourceBindings.length, 1)
    assert.equal(first.rows[0].trace.sourceBindings[0].sourceHash, sourceHash)
    assert.match(first.rows[0].trace.sourceBindings[0].sourceId, /^id-sha256:[a-f0-9]{64}$/)
    assert.ok(Number.isFinite(first.rows[0].trace.latencyMs))
    const billedFailure = await replayManifest({ manifest, family, candidates, provider: { localOnly: true, decide: async () => ({
      ok: true, model: "pinned", usage: { input_tokens: 7, cost: 0.25 },
      answers: { signal: { choice: "feedback", probabilities: { feedback: 1 } } },
    }) } })
    assert.equal(billedFailure.syntheticControls.test.counts.failures, 1)
    assert.deepEqual(billedFailure.syntheticControls.test.cost, { observedCalls: 1, total: 0.25 })
    for (const changedPins of [
      { ...pins, thresholds: { feedback: 0.1 } },
      { ...pins, baseline: "other-baseline" },
    ]) {
      const before = providerCalls
      await assert.rejects(() => replayManifest({
        manifest: { ...manifest, pins: changedPins, datasetHash: datasetHashFor(cases, labels, sourceSnapshotHash, changedPins) },
        family, candidates, provider,
      }), /evaluation (threshold|baseline) pin/)
      assert.equal(providerCalls, before)
    }
    const changedFamily = createDecisionFamily({ ...family, threshold: 0.9 })
    const changedFamilyPins = { ...pins, policyHash: changedFamily.policyHash }
    await assert.rejects(() => replayManifest({
      manifest: { ...manifest, pins: changedFamilyPins, datasetHash: datasetHashFor(cases, labels, sourceSnapshotHash, changedFamilyPins) },
      family: changedFamily, candidates, provider,
    }), /evaluation threshold pin/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, labels: ["feedback"], datasetHash: datasetHashFor(cases, ["feedback"], sourceSnapshotHash, pins) }, family, candidates, provider }), /label catalog/)
    const invalidCases = [{ ...cases[0], split: "holdout" }]
    const beforeInvalidSplit = providerCalls
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, cases: invalidCases, datasetHash: datasetHashFor(invalidCases, labels, sourceSnapshotHash, pins) }, family, candidates, provider }), /split/)
    assert.equal(providerCalls, beforeInvalidSplit)
    for (const changed of [{ label: "unknown" }, { baseline: "unknown" }]) {
      const malformedCases = [{ ...cases[0], ...changed }]
      const before = providerCalls
      await assert.rejects(() => replayManifest({
        manifest: { ...manifest, cases: malformedCases, datasetHash: datasetHashFor(malformedCases, labels, sourceSnapshotHash, pins) },
        family, candidates, provider,
      }), /case (label|baseline)/)
      assert.equal(providerCalls, before)
    }
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, pins: { ...manifest.pins, baseline: "changed" } }, family, candidates, provider }), /evaluation baseline pin/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, pins: { ...manifest.pins, thresholds: { feedback: 0.1 } } }, family, candidates, provider }), /evaluation threshold pin/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, pins: { ...manifest.pins, codeRevision: "rev" } }, family, candidates, provider }), /code revision/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, pins: { ...manifest.pins, policyHash: "wrong" } }, family, candidates, provider }), /policy hash/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, cases: [{ ...cases[0], label: "clear" }] }, family, candidates, provider }), /dataset hash/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, sources: [{ ...sources[0], sourceRef: "https://example.test/tampered" }] }, family, candidates, provider }), /source snapshot hash/)
    await assert.rejects(() => replayManifest({ manifest: { ...manifest, sources: [{ ...sources[0], reviewedCommit: "c".repeat(40) }] }, family, candidates, provider }), /source snapshot hash/)
    for (const changed of [
      { sourceContent: "different private review text" },
      { sourceHash: "c".repeat(64) },
      { sourceRefs: ["https://example.test/other"] },
      { sourceRefs: ["https://example.test/a", "https://example.test/other"] },
      { text: "different private review text" },
    ]) {
      const before = providerCalls
      await assert.rejects(() => replayManifest({ manifest, family, candidates: { a: { ...candidates.a, ...changed } }, provider }), /candidate source provenance/)
      assert.equal(providerCalls, before)
    }
    for (const changed of [{ baseline: "clear" }, { eligible: false }, { privacyClass: "private" }, { callIndex: 1 }]) {
      const before = providerCalls
      await assert.rejects(() => replayManifest({ manifest, family, candidates: { a: { ...candidates.a, ...changed } }, provider }), /candidate evaluation inputs/)
      assert.equal(providerCalls, before)
    }
  })

  it("reports synthetic controls separately from real replay metrics", async () => {
    const labels = ["clear", "feedback", "uncertain"]
    const sources = ["real", "synthetic"].map((id) => ({ id, sourceRef: `https://example.test/${id}`, sourceHash }))
    const cases = [
      { sourceId: "real", split: "test", label: "feedback", baseline: "uncertain", eligible: true, privacyClass: "private", callIndex: 0 },
      { sourceId: "synthetic", split: "test", label: "feedback", baseline: "uncertain", eligible: true, privacyClass: "synthetic", callIndex: 0 },
    ]
    const sourceSnapshotHash = sourceSnapshotHashFor(sources)
    const pins = { family: family.id, questionVersion: family.questionVersion, policyHash: family.policyHash, model: "pinned", codeRevision: "a".repeat(40), baseline: "fixture", thresholds: { feedback: 0.8 } }
    const manifest = { datasetHash: datasetHashFor(cases, labels, sourceSnapshotHash, pins), sourceSnapshotHash, sources, cases, labels, pins }
    const candidates = Object.fromEntries(sources.map((source) => [source.id, {
      sourceContent, sourceHash, sourceRefs: [source.sourceRef], baseline: "uncertain", eligible: true,
      privacyClass: source.id === "real" ? "private" : "synthetic", callIndex: 0,
    }]))
    const provider = { localOnly: true, decide: async ({ state }) => ({
      ok: true, model: "pinned", answers: { signal: { choice: state.id === "real" ? "clear" : "feedback", probabilities: state.id === "real"
        ? { clear: 1, feedback: 0, uncertain: 0 } : { clear: 0, feedback: 1, uncertain: 0 } } },
    }) }
    const result = await replayManifest({ manifest, family, candidates, provider })
    assert.equal(result.splits.test.counts.cases, 1)
    assert.equal(result.splits.test.model.correct, 0)
    assert.equal(result.syntheticControls.test.counts.cases, 1)
    assert.equal(result.syntheticControls.test.model.correct, 1)
    assert.deepEqual(result.rows.map((row) => row.privacyClass), ["private", "synthetic"])
  })
})
