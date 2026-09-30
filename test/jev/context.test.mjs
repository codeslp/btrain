import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendDecisionTrace } from "../../src/brain_train/jev/decision.mjs"
import { sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"
import { contextManifestHash, contextSourceHash, dispatchContextFamily, selectContext } from "../../src/brain_train/jev/context.mjs"

const ref = "https://example.test/artifacts/1"
const answer = (choice) => ({
  ok: true,
  model: "local-fixture",
  answers: { signal: { choice, probabilities: Object.fromEntries(
    ["full", "reference", "omit"].map((value) => [value, value === choice ? 1 : 0]),
  ) } },
})
const item = (id, kind, extra = {}) => {
  const value = {
    id, kind, sourceRef: ref, content: `private ${id}`, tokens: 100,
    evidenceClass: kind === "artifact" ? "low-risk-artifact" : kind === "transcript" ? "older-transcript" : undefined,
    ...extra,
  }
  return value
}
const frozen = (items) => items.map((value) => ({
  id: value.id, sourceRef: value.sourceRef, sourceSnapshotHash: contextSourceHash(value),
  kind: value.kind, evidenceClass: value.evidenceClass ?? "unclassified", pinned: value.pinned === true,
}))
const offline = (options) => {
  const frozenSources = options.frozenSources ?? frozen(options.items)
  return selectContext({
    ...options, frozenSources,
    expectedManifestHash: options.expectedManifestHash ?? contextManifestHash(frozenSources, options.objective ?? ""),
    mode: "offline", modelPin: "local-fixture", codeRevision: "a".repeat(40),
  })
}

describe("offline context selection", () => {
  it("pins selector limits and rules in each family policy", () => {
    assert.equal(dispatchContextFamily.policyConfig.maxItems, 256)
    assert.equal(dispatchContextFamily.policyConfig.maxCalls, 16)
    assert.equal(dispatchContextFamily.policyConfig.optionalKind.dispatch, "artifact")
    assert.ok(dispatchContextFamily.policyConfig.selectionRules.includes("selectContext"))
    assert.ok(dispatchContextFamily.policyConfig.selectionRules.includes("function digest(value)"))
    assert.ok(dispatchContextFamily.policyConfig.selectionRules.includes("function validSourceRef(value)"))
  })

  it("never calls a provider for required evidence and keeps it full", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("omit") } }
    const items = ["instruction", "task", "constraint", "lock", "state", "finding", "error"].map((kind) => item(kind, kind))
    const plan = await offline({ kind: "dispatch", items, provider })
    assert.deepEqual(plan.selections.map(({ selection }) => selection), Array(items.length).fill("full"))
    assert.equal(calls, 0)
    assert.equal(plan.traces.length, items.length)
    assert.deepEqual(plan.traces.map(({ outcome, reason, attemptedCall }) => [outcome, reason, attemptedCall]),
      Array(items.length).fill(["skipped", "ineligible", false]))
  })

  it("treats explicit pins and unknown kinds as required", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("omit") } }
    const plan = await offline({ kind: "dispatch", items: [item("a", "artifact", { pinned: true }), item("b", "unknown")], provider })
    assert.deepEqual(plan.selections.map(({ selection }) => selection), ["full", "full"])
    assert.equal(calls, 0)
  })

  it("rejects a malformed pin marker before consulting the provider", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("omit") } }
    await assert.rejects(() => offline({
      kind: "dispatch", items: [item("a", "artifact", { pinned: "true" })], provider,
    }), /pin marker/)
    assert.equal(calls, 0)
  })

  it("rejects a packet missing any frozen evidence", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("omit") } }
    const optional = item("optional", "artifact")
    for (const missing of [item("pinned", "artifact", { pinned: true }), item("instruction", "instruction"), item("other-optional", "artifact")]) {
      const frozenSources = frozen([missing, optional])
      await assert.rejects(() => offline({
        kind: "dispatch", items: [optional], frozenSources, provider,
      }), /context item is missing/)
    }
    assert.equal(calls, 0)
  })

  it("permits recoverable optional artifact references only offline", async () => {
    const source = item("a", "artifact")
    const plan = await offline({ kind: "dispatch", items: [source], provider: { localOnly: true, decide: async () => answer("reference") } })
    assert.deepEqual(plan.selections, [{ id: "a", selection: "reference", sourceSnapshotHash: contextSourceHash(source) }])
    assert.equal(plan.traces[0].outcome, "decision")
    assert.equal(JSON.stringify(plan).includes("private a"), false)
  })

  it("binds an optional selection trace to its frozen source for persistence", async () => {
    const source = item("a", "artifact")
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-context-trace-"))
    try {
      const plan = await offline({ kind: "dispatch", items: [source], provider: { localOnly: true, decide: async () => answer("reference") } })
      const trace = plan.traces[0]
      const sourceProof = { sources: [{ id: source.id, sourceRef: source.sourceRef, sourceHash: createHash("sha256").update(source.content).digest("hex") }] }
      sourceProof.sourceSnapshotHash = sourceSnapshotHashFor(sourceProof.sources)
      assert.equal(trace.sourceSnapshotHash, sourceProof.sourceSnapshotHash)
      const record = await appendDecisionTrace(root, trace, dispatchContextFamily, sourceProof)
      assert.equal(record.sourceBindings.length, 1)
      assert.equal(JSON.stringify(record).includes(source.content), false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("retains full content on invalid output, low confidence, and provider failure", async () => {
    const cases = [
      { ok: false, reason: "timeout" },
      answer("delete"),
      { ...answer("omit"), answers: { signal: { choice: "omit", probabilities: { full: 0.05, reference: 0.2, omit: 0.75 } } } },
    ]
    for (const response of cases) {
      const plan = await offline({ kind: "dispatch", items: [item("a", "artifact")], provider: { localOnly: true, decide: async () => response } })
      assert.equal(plan.selections[0].selection, "full")
    }
  })

  it("keeps full content when off, private provider is remote, or a source reference is absent", async () => {
    let calls = 0
    const provider = { decide: async () => { calls += 1; return answer("omit") } }
    for (const [mode, currentProvider, sourceRef] of [["off", provider, ref], ["offline", provider, ref], ["offline", { localOnly: true, decide: provider.decide }, null]]) {
      const plan = await selectContext({ kind: "dispatch", items: [item("a", "artifact", { sourceRef })], provider: currentProvider, mode, modelPin: "local-fixture", codeRevision: "a".repeat(40) })
      assert.equal(plan.selections[0].selection, "full")
    }
    assert.equal(calls, 0)
  })

  it("keeps transcript selection distinct and pins mismatched optional kinds", async () => {
    const provider = { localOnly: true, decide: async () => answer("omit") }
    const transcript = await offline({ kind: "transcript", items: [item("turn-1", "transcript")], provider })
    const dispatch = await offline({ kind: "dispatch", items: [item("turn-1", "transcript")], provider })
    assert.equal(transcript.selections[0].selection, "omit")
    assert.equal(dispatch.selections[0].selection, "full")
    assert.notEqual(transcript.familyPolicyHash, dispatch.familyPolicyHash)
  })

  it("caps total provider calls and keeps later optional items full", async () => {
    assert.equal(dispatchContextFamily.maxCalls, 16)
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("omit") } }
    const items = Array.from({ length: 20 }, (_, index) => item(String(index), "artifact"))
    const plan = await offline({ kind: "dispatch", items, provider })
    assert.equal(calls, 16)
    assert.deepEqual(plan.selections.map(({ selection }) => selection), [
      ...Array(16).fill("omit"), ...Array(4).fill("full"),
    ])
    assert.equal(plan.traces[16].reason, "call-budget")
  })

  it("selects the same bounded items regardless of caller order", async () => {
    const items = Array.from({ length: 17 }, (_, index) => item(String(index).padStart(2, "0"), "artifact"))
    const frozenSources = frozen(items)
    const provider = { localOnly: true, decide: async () => answer("omit") }
    const first = await offline({ kind: "dispatch", items, frozenSources, provider })
    const reversed = await offline({ kind: "dispatch", items: [...items].reverse(), frozenSources, provider })
    assert.deepEqual(reversed.selections, first.selections)
    assert.deepEqual(reversed.traces.map(({ outcome, reason }) => [outcome, reason]), first.traces.map(({ outcome, reason }) => [outcome, reason]))
    assert.deepEqual(first.selections[16], { id: "16", selection: "full" })
  })

  it("rejects duplicate IDs, unbounded inputs, and invalid estimates", async () => {
    const provider = { localOnly: true, decide: async () => answer("omit") }
    for (const items of [[item("a", "artifact"), item("a", "artifact")], [item("a", "artifact", { tokens: -1 })], Array(257).fill(0).map((_, i) => item(String(i), "artifact"))]) {
      await assert.rejects(() => offline({ kind: "dispatch", items, provider }))
    }
  })

  it("pins mandatory content despite an optional surface label", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("omit") } }
    const items = [item("current", "artifact", { evidenceClass: "current-state" }), item("error", "transcript", { evidenceClass: "recent-error" }), item("unknown", "artifact", { evidenceClass: undefined })]
    const dispatch = await offline({ kind: "dispatch", items, provider })
    const transcript = await offline({ kind: "transcript", items, provider })
    assert.deepEqual(dispatch.selections.map(({ selection }) => selection), ["full", "full", "full"])
    assert.deepEqual(transcript.selections.map(({ selection }) => selection), ["full", "full", "full"])
    assert.equal(calls, 0)
    const original = item("current", "artifact", { evidenceClass: "current-state" })
    const tampered = { ...original, evidenceClass: "low-risk-artifact" }
    const manifest = frozen([original])
    const relabeled = await offline({ kind: "dispatch", items: [tampered], frozenSources: manifest, expectedManifestHash: contextManifestHash(manifest), provider })
    assert.equal(relabeled.selections[0].selection, "full")
    assert.equal(calls, 0)
  })

  it("fails closed on changed source content and a mismatched model pin", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("omit") } }
    const source = item("a", "artifact")
    const originalSources = frozen([source])
    const originalManifestHash = contextManifestHash(originalSources)
    const changed = await offline({ kind: "dispatch", items: [{ ...source, content: "changed after snapshot", sourceSnapshotHash: contextSourceHash({ ...source, content: "changed after snapshot" }) }], frozenSources: originalSources, expectedManifestHash: originalManifestHash, provider })
    assert.equal(changed.selections[0].selection, "full")
    assert.equal(calls, 0)
    const changedManifest = await offline({ kind: "dispatch", items: [source], frozenSources: [{ ...originalSources[0], sourceRef: "https://example.test/mutable" }], expectedManifestHash: originalManifestHash, provider })
    assert.equal(changedManifest.selections[0].selection, "full")
    assert.equal(calls, 0)
    const changedTokens = await offline({ kind: "dispatch", items: [{ ...source, tokens: 101 }], frozenSources: originalSources, expectedManifestHash: originalManifestHash, provider })
    assert.equal(changedTokens.selections[0].selection, "full")
    assert.equal(calls, 0)
    const changedObjective = await offline({ kind: "dispatch", items: [source], objective: "changed objective", frozenSources: originalSources, expectedManifestHash: originalManifestHash, provider })
    assert.equal(changedObjective.selections[0].selection, "full")
    assert.equal(calls, 0)
    const wrongModel = await offline({ kind: "dispatch", items: [source], provider: { localOnly: true, decide: async () => ({ ...answer("omit"), model: "other-model" }) } })
    assert.equal(wrongModel.selections[0].selection, "full")
    assert.equal(wrongModel.traces[0].reason, "model-mismatch")
    await assert.rejects(() => selectContext({ kind: "dispatch", items: [source], provider, mode: "offline" }), /pinned model/)
  })

  it("hashes the same frozen source set identically across Unicode ID orderings", () => {
    const composed = { id: "é", sourceRef: ref, sourceSnapshotHash: "a".repeat(64), kind: "artifact", evidenceClass: "low-risk-artifact", pinned: false }
    const decomposed = { ...composed, id: "e\u0301" }
    assert.notEqual(composed.id, decomposed.id)
    assert.equal(contextManifestHash([composed, decomposed]), contextManifestHash([decomposed, composed]))
  })

  it("rejects inherited Object property names as unsupported context kinds", async () => {
    for (const kind of ["toString", "constructor", "__proto__"]) {
      await assert.rejects(() => offline({ kind, items: [] }), /Only offline dispatch or transcript/)
    }
  })
})
