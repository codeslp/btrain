import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { annotationCandidates, freezeLabeledManifest } from "../../src/brain_train/jev/manifest.mjs"

const snapshot = (id, prNumber, eventHead = "a".repeat(40)) => ({ id, repository: "o/r", prNumber, eventHead, sourceHash: "b".repeat(64), sourceRef: `https://example.test/${id}`, surface: "review", author: "bot" })
const entry = (id, prNumber, templateGroup, split = "test") => ({
  sourceId: id, repository: "o/r", prNumber, templateGroup, split, label: "feedback",
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

  it("freezes reproducibly with source and label hashes", () => {
    const sources = [snapshot("s1", 1), snapshot("s2", 2)]
    const cases = [entry("s1", 1, "template-a", "train"), entry("s2", 2, "template-b", "test")]
    const first = freezeLabeledManifest({ sources, cases, pins, labels: ["clear", "feedback", "unavailable", "uncertain"], requireEventHead: true })
    const second = freezeLabeledManifest({ sources: [...sources].reverse(), cases: [...cases].reverse(), pins, labels: ["clear", "feedback", "unavailable", "uncertain"], requireEventHead: true })
    assert.deepEqual(first, second)
    assert.equal(first.datasetHash.length, 64)
    assert.equal(first.cases.length, 2)
  })

  it("rejects a PR or normalized template across splits", () => {
    const sources = [snapshot("s1", 1), snapshot("s2", 1), snapshot("s3", 2)]
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "a", "train"), entry("s2", 1, "b", "test")], pins, labels: ["feedback"] }), /PR group crosses splits/)
    assert.throws(() => freezeLabeledManifest({ sources, cases: [entry("s1", 1, "a", "train"), entry("s3", 2, "a", "test")], pins, labels: ["feedback"] }), /Template group crosses splits/)
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
