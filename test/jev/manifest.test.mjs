import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { annotationCandidates, freezeLabeledManifest, sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"

const snapshot = (id, prNumber, eventHead = "a".repeat(40), templateGroup = "a") => ({ id, templateGroup, repository: "o/r", prNumber, eventHead, sourceHash: "b".repeat(64), sourceRef: `https://example.test/${id}`, surface: "review", author: "bot" })
const entry = (id, prNumber, templateGroup, split = "test") => ({
  sourceId: id, repository: "o/r", prNumber, templateGroup, split, label: "feedback", baseline: "uncertain", eligible: true, privacyClass: "synthetic", callIndex: 0,
  annotations: [{ by: "one", label: "feedback" }, { by: "two", label: "feedback" }],
  adjudication: { by: "three", label: "feedback", reason: "confirmed" },
})
const pins = { family: "pr-signal", questionVersion: "1", policyHash: "c".repeat(64), model: "jev-pinned", codeRevision: "d".repeat(40), baseline: "regex-v1", thresholds: { feedback: 0.8 } }
const labels = ["feedback", "uncertain"]

describe("frozen Jev label manifest", () => {
  it("excludes historical unknown-head rows from exact-head annotation candidates", () => {
    const result = annotationCandidates([snapshot("known", 1), snapshot("old", 2, "unknown")], { requireEventHead: true })
    assert.deepEqual(result.eligible.map((row) => row.sourceId), ["known"])
    assert.deepEqual(result.excluded, [{ sourceId: "old", reason: "unknown-event-head" }])
  })

  it("rejects malformed event heads from exact-head annotation and freezing", () => {
    const malformed = snapshot("bad", 1, "known")
    assert.deepEqual(annotationCandidates([malformed], { requireEventHead: true }).excluded, [{ sourceId: "bad", reason: "invalid-event-head" }])
    assert.throws(() => freezeLabeledManifest({ sources: [malformed], cases: [entry("bad", 1, "a")], pins, labels, requireEventHead: true }), /Invalid event-time head/)
  })

  it("rejects a revision pin that cannot appear in decision traces", () => {
    assert.throws(() => freezeLabeledManifest({
      sources: [snapshot("s1", 1)], cases: [entry("s1", 1, "a")],
      pins: { ...pins, codeRevision: "rev" }, labels,
    }), /code revision/)
  })

  it("freezes reproducibly with source and label hashes", () => {
    const sources = [snapshot("s1", 1, undefined, "template-a"), snapshot("s2", 2, undefined, "template-b")]
    const cases = [entry("s1", 1, "template-a", "train"), entry("s2", 2, "template-b", "test")]
    const first = freezeLabeledManifest({ sources, cases, pins, labels: ["clear", "feedback", "unavailable", "uncertain"], requireEventHead: true })
    const second = freezeLabeledManifest({ sources: [...sources].reverse(), cases: [...cases].reverse(), pins, labels: ["clear", "feedback", "unavailable", "uncertain"], requireEventHead: true })
    assert.deepEqual(first, second)
    assert.equal(first.datasetHash.length, 64)
    assert.equal(first.cases.length, 2)
    assert.equal(first.sources.length, 2)
    assert.equal(first.sources[0].sourceRef, "https://example.test/s1")
    assert.deepEqual([first.cases[0].baseline, first.cases[0].eligible, first.cases[0].privacyClass, first.cases[0].callIndex], ["uncertain", true, "synthetic", 0])
    assert.equal(sourceSnapshotHashFor(first.sources), first.sourceSnapshotHash)
  })

  it("copies threshold pins and binds them into the dataset hash", () => {
    const supplied = { ...pins, thresholds: { feedback: 0.8 } }
    const options = { sources: [snapshot("s1", 1)], cases: [entry("s1", 1, "a")], pins: supplied, labels }
    const manifest = freezeLabeledManifest(options)
    supplied.thresholds.feedback = 0.1
    assert.equal(manifest.pins.thresholds.feedback, 0.8)
    const changed = freezeLabeledManifest({ ...options, pins: supplied })
    assert.notEqual(manifest.datasetHash, changed.datasetHash)
    assert.notEqual(manifest.datasetHash, freezeLabeledManifest({ ...options, pins: { ...pins, baseline: "other" } }).datasetHash)
  })

  it("rejects a baseline outside the frozen label catalog", () => {
    assert.throws(() => freezeLabeledManifest({
      sources: [snapshot("s1", 1)], cases: [{ ...entry("s1", 1, "a"), baseline: "feedbak" }],
      pins, labels,
    }), /baseline.*catalog/i)
  })

  it("preserves captured event and head-observation provenance in the source hash", () => {
    const source = { ...snapshot("s1", 1), eventId: "42", laneId: "a", captureHeadObservedAt: "2026-09-01T10:05:00Z" }
    const options = { sources: [source], cases: [entry("s1", 1, "a")], pins, labels }
    const frozen = freezeLabeledManifest(options)
    assert.deepEqual([frozen.sources[0].eventId, frozen.sources[0].laneId, frozen.sources[0].captureHeadObservedAt], ["42", "a", "2026-09-01T10:05:00Z"])
    for (const changed of [
      { eventId: "43" }, { laneId: "b" }, { captureHeadObservedAt: "2026-09-01T10:06:00Z" },
    ]) {
      const updated = freezeLabeledManifest({ ...options, sources: [{ ...source, ...changed }] })
      assert.notEqual(updated.sourceSnapshotHash, frozen.sourceSnapshotHash)
    }
  })

  it("rejects a PR or normalized template across splits", () => {
    const sources = [snapshot("s1", 1), snapshot("s2", 1, undefined, "b"), snapshot("s3", 2)]
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "a", "train"), entry("s2", 1, "b", "test")], pins, labels }), /PR group crosses splits/)
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "a", "train"), entry("s3", 2, "a", "test")], pins, labels }), /Template group crosses splits/)
  })

  it("keeps the same template in one split across repositories", () => {
    const sources = [snapshot("s1", 1, undefined, "shared"), { ...snapshot("s2", 1, undefined, "shared"), repository: "other/repo" }]
    const second = { ...entry("s2", 1, "shared", "test"), repository: "other/repo" }
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "shared", "train"), second], pins, labels }), /Template group crosses splits/)
  })

  it("requires two independent annotations and explicit adjudication", () => {
    const sources = [snapshot("s1", 1)]
    const bad = entry("s1", 1, "a")
    bad.annotations[1].by = "one"
    assert.throws(() => freezeLabeledManifest({ sources, cases: [bad], pins, labels }), /independent annotators/)
    bad.annotations[1].by = "two"
    bad.adjudication = null
    assert.throws(() => freezeLabeledManifest({ sources, cases: [bad], pins, labels }), /adjudication/)
  })

  it("requires a captured template group instead of trusting case-assigned groups", () => {
    for (const templateGroup of [undefined, null, ""]) {
      const source = { ...snapshot("s1", 1), templateGroup }
      assert.throws(() => freezeLabeledManifest({ sources: [source], cases: [entry("s1", 1, "a")], pins, labels }), /captured template group/i)
    }
  })

  it("rejects a case whose template group differs from captured evidence", () => {
    const sources = [{ ...snapshot("s1", 1), templateGroup: "captured-group" }]
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "edited-group")], pins, labels }), /template group mismatch/)
  })
})
