import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createDecisionFamily, decideCandidate, fakeProvider, appendDecisionTrace } from "../../src/brain_train/jev/decision.mjs"
import { sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"

const family = createDecisionFamily({
  id: "pr-signal", questionVersion: "1", choices: ["clear", "feedback", "unavailable", "uncertain"],
  privacyClass: "private", allowedActions: ["flag-feedback"], threshold: 0.8,
  inputBuilder: (candidate) => ({ reviewText: candidate.text }),
  actionPolicy: (choice) => choice === "feedback" ? "flag-feedback" : null,
  fallback: (baseline) => baseline,
})
const candidate = { eligible: true, sourceRefs: ["https://example.test/42?token=secret"], text: "private review text", baseline: "uncertain" }
const answer = (choice = "feedback", scores = { clear: 0.05, feedback: 0.9, unavailable: 0.03, uncertain: 0.02 }) => ({ ok: true, model: "jev-pinned", answers: { signal: { choice, probabilities: scores } }, latencyMs: 12, usage: { input_tokens: 10 } })
const sourceProof = (refs) => {
  const sources = refs.map((sourceRef, index) => ({ id: `source-${index}`, sourceRef, sourceHash: "a".repeat(64) }))
  return { sources, sourceSnapshotHash: sourceSnapshotHashFor(sources) }
}

describe("offline decision gateway", () => {
  it("is off by default and skips ineligible or privacy-denied cases before a provider call", async () => {
    let calls = 0
    const provider = { decide: async () => { calls += 1; return answer() } }
    assert.equal((await decideCandidate({ family, candidate, provider })).outcome, "skipped")
    assert.equal((await decideCandidate({ family, candidate: { ...candidate, eligible: false }, provider, mode: "offline", privacyApproved: true })).reason, "ineligible")
    assert.equal((await decideCandidate({ family, candidate, provider, mode: "offline" })).reason, "privacy-denied")
    assert.equal(calls, 0)
  })

  it("records a typed suggestion without performing the action or leaking input", async () => {
    const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", privacyApproved: true, modelPin: "jev-pinned", codeRevision: "abc" })
    assert.equal(trace.outcome, "decision")
    assert.equal(trace.suggestedAction, "flag-feedback")
    assert.equal(trace.baseline, "uncertain")
    assert.match(trace.sourceRefs[0], /^ref-sha256:[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(trace).includes("private review text"), false)
    assert.equal(JSON.stringify(trace).includes("token=secret"), false)
    assert.equal(trace.policyHash, family.policyHash)
  })

  it("permits a local fake on private evidence without hosted-data approval", async () => {
    const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", modelPin: "jev-pinned" })
    assert.equal(trace.outcome, "decision")
  })

  it("distinguishes valid abstention from malformed answers and provider failures", async () => {
    const args = { family, candidate, mode: "offline", privacyApproved: true, modelPin: "jev-pinned" }
    assert.equal((await decideCandidate({ ...args, provider: fakeProvider(answer("clear")) })).outcome, "abstain")
    const invalid = await decideCandidate({ ...args, provider: fakeProvider(answer("feedback", { feedback: 1 })) })
    assert.deepEqual([invalid.outcome, invalid.reason, invalid.prediction], ["failure", "invalid-answer", undefined])
    const timeout = await decideCandidate({ ...args, provider: fakeProvider({ ok: false, reason: "timeout" }) })
    assert.deepEqual([timeout.outcome, timeout.reason, timeout.prediction], ["failure", "timeout", undefined])
  })

  it("keeps malformed provider latency out of returned traces", async () => {
    const args = { family, candidate, mode: "offline", provider: fakeProvider({ ...answer(), latencyMs: { privateText: "secret latency" } }) }
    const decided = await decideCandidate(args)
    const failed = await decideCandidate({ ...args, provider: fakeProvider({ ok: false, reason: "timeout", latencyMs: "secret latency" }) })
    assert.equal(decided.latencyMs, null)
    assert.equal(failed.latencyMs, null)
    assert.equal(JSON.stringify([decided, failed]).includes("secret latency"), false)
  })

  it("fails closed when input or action policy code throws", async () => {
    const inputFailure = createDecisionFamily({ ...family, inputBuilder: () => { throw new Error("bad input") } })
    const skipped = await decideCandidate({ family: inputFailure, candidate, provider: fakeProvider(answer()), mode: "offline" })
    assert.deepEqual([skipped.outcome, skipped.reason], ["skipped", "invalid-input"])
    const actionFailure = createDecisionFamily({ ...family, actionPolicy: () => { throw new Error("bad action") } })
    const failed = await decideCandidate({ family: actionFailure, candidate, provider: fakeProvider(answer()), mode: "offline" })
    assert.deepEqual([failed.outcome, failed.reason, failed.prediction], ["failure", "invalid-answer", undefined])
  })

  it("changes the policy hash when action or threshold changes", () => {
    const changed = createDecisionFamily({ ...family, threshold: 0.9 })
    assert.notEqual(changed.policyHash, family.policyHash)
  })

  it("does not allow a family catalog to drift after hashing", () => {
    assert.throws(() => family.choices.push("secret"), TypeError)
    assert.throws(() => family.allowedActions.push("approve-pr"), TypeError)
  })

  it("persists only allowlisted trace fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-trace-"))
    try {
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", privacyApproved: true, modelPin: "jev-pinned" })
      await appendDecisionTrace(root, { ...trace, privateInput: "do not write me" }, family, sourceProof(candidate.sourceRefs))
      const raw = await fs.readFile(path.join(root, ".btrain", "jev", "decision-traces.jsonl"), "utf8")
      assert.equal(raw.includes("do not write me"), false)
      assert.equal(JSON.parse(raw).outcome, "decision")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("never returns or persists private data from a malformed baseline or trace metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-private-trace-"))
    try {
      const privateCandidate = { ...candidate, baseline: { rawPrivateText: "secret baseline" } }
      const trace = await decideCandidate({ family, candidate: privateCandidate, provider: fakeProvider(answer()), mode: "offline" })
      assert.equal(JSON.stringify(trace).includes("secret baseline"), false)
      await appendDecisionTrace(root, { ...trace, baseline: { rawPrivateText: "secret baseline" }, provider: "secret provider metadata" }, family, sourceProof(candidate.sourceRefs))
      const raw = await fs.readFile(path.join(root, ".btrain", "jev", "decision-traces.jsonl"), "utf8")
      assert.equal(raw.includes("secret baseline"), false)
      assert.equal(raw.includes("secret provider metadata"), false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("does not persist code-shaped private metadata or URL paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-coded-secret-"))
    try {
      const trace = await decideCandidate({ family, candidate: { ...candidate, sourceRefs: ["https://example.test/private-customer-name"] }, provider: { id: "tenant-private-detail", localOnly: true, decide: async () => answer() }, mode: "offline", modelPin: "credential-like-secret" })
      await appendDecisionTrace(root, { ...trace, reason: "customer-secret-123", model: "credential-like-secret" }, family, sourceProof(["https://example.test/private-customer-name"]))
      const raw = await fs.readFile(path.join(root, ".btrain", "jev", "decision-traces.jsonl"), "utf8")
      for (const secret of ["private-customer-name", "tenant-private-detail", "credential-like-secret", "customer-secret-123"]) {
        assert.equal(JSON.stringify(trace).includes(secret), false)
        assert.equal(raw.includes(secret), false)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("rejects an unverified trace source before writing a local record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-source-proof-"))
    try {
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline" })
      await assert.rejects(() => appendDecisionTrace(root, trace, family, sourceProof(["https://example.test/other"])), /source provenance/)
      await assert.rejects(() => appendDecisionTrace(root, trace, family, { ...sourceProof(candidate.sourceRefs), sourceSnapshotHash: "b".repeat(64) }), /source provenance/)
      const exists = await fs.access(path.join(root, ".btrain", "jev", "decision-traces.jsonl")).then(() => true).catch(() => false)
      assert.equal(exists, false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
