import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { annotationCandidates, freezeLabeledManifest, sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"

const snapshot = (id, prNumber, eventHead = "a".repeat(40)) => ({ id, repository: "o/r", prNumber, eventHead, sourceHash: "b".repeat(64), sourceRef: `https://example.test/${id}`, surface: "review", author: "bot" })
const entry = (id, prNumber, templateGroup, split = "test") => ({
  sourceId: id, repository: "o/r", prNumber, templateGroup, split, label: "feedback", baseline: "uncertain", eligible: true, privacyClass: "synthetic", callIndex: 0,
  annotations: [{ by: "one", label: "feedback" }, { by: "two", label: "feedback" }],
  adjudication: { by: "three", label: "feedback", reason: "confirmed" },
})
const pins = { family: "pr-signal", questionVersion: "1", policyHash: "c".repeat(64), model: "jev-pinned", codeRevision: "d".repeat(40), baseline: "regex-v1", thresholds: { feedback: 0.8 } }

describe("frozen Jev label manifest", () => {
  it("excludes historical unknown-head rows from exact-head annotation candidates", () => {
    const result = annotationCandidates([snapshot("known", 1), snapshot("old", 2, "unknown")], { requireEventHead: true })
    assert.deepEqual(result.eligible.map((row) => row.sourceId), ["known"])
    assert.deepEqual(result.excluded, [{ sourceId: "old", reason: "unknown-event-head" }])
  })

  it("rejects malformed event heads from exact-head annotation and freezing", () => {
    const malformed = snapshot("bad", 1, "known")
    assert.deepEqual(annotationCandidates([malformed], { requireEventHead: true }).excluded, [{ sourceId: "bad", reason: "invalid-event-head" }])
    assert.throws(() => freezeLabeledManifest({ sources: [malformed], cases: [entry("bad", 1, "a")], pins, labels: ["feedback"], requireEventHead: true }), /Invalid event-time head/)
  })

  it("rejects a revision pin that cannot appear in decision traces", () => {
    assert.throws(() => freezeLabeledManifest({
      sources: [snapshot("s1", 1)], cases: [entry("s1", 1, "a")],
      pins: { ...pins, codeRevision: "rev" }, labels: ["feedback"],
    }), /code revision/)
  })

  it("freezes reproducibly with source and label hashes", () => {
    const sources = [snapshot("s1", 1), snapshot("s2", 2)]
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
    const options = { sources: [snapshot("s1", 1)], cases: [entry("s1", 1, "a")], pins: supplied, labels: ["feedback"] }
    const manifest = freezeLabeledManifest(options)
    supplied.thresholds.feedback = 0.1
    assert.equal(manifest.pins.thresholds.feedback, 0.8)
    const changed = freezeLabeledManifest({ ...options, pins: supplied })
    assert.notEqual(manifest.datasetHash, changed.datasetHash)
    assert.notEqual(manifest.datasetHash, freezeLabeledManifest({ ...options, pins: { ...pins, baseline: "other" } }).datasetHash)
  })

  it("rejects a PR or normalized template across splits", () => {
    const sources = [snapshot("s1", 1), snapshot("s2", 1), snapshot("s3", 2)]
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "a", "train"), entry("s2", 1, "b", "test")], pins, labels: ["feedback"] }), /PR group crosses splits/)
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "a", "train"), entry("s3", 2, "a", "test")], pins, labels: ["feedback"] }), /Template group crosses splits/)
  })

  it("keeps the same template in one split across repositories", () => {
    const sources = [snapshot("s1", 1), { ...snapshot("s2", 1), repository: "other/repo" }]
    const second = { ...entry("s2", 1, "shared", "test"), repository: "other/repo" }
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "shared", "train"), second], pins, labels: ["feedback"] }), /Template group crosses splits/)
  })

  it("requires two independent annotations and explicit adjudication", () => {
    const sources = [snapshot("s1", 1)]
    const bad = entry("s1", 1, "a")
    bad.annotations[1].by = "one"
    assert.throws(() => freezeLabeledManifest({ sources, cases: [bad], pins, labels: ["feedback"] }), /independent annotators/)
    bad.annotations[1].by = "two"
    bad.adjudication = null
    assert.throws(() => freezeLabeledManifest({ sources, cases: [bad], pins, labels: ["feedback"] }), /adjudication/)
  })

  it("rejects a case whose template group differs from captured evidence", () => {
    const sources = [{ ...snapshot("s1", 1), templateGroup: "captured-group" }]
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "edited-group")], pins, labels: ["feedback"] }), /template group mismatch/)
  })
})
