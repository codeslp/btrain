import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { createDecisionFamily, createDecisionRun, decideCandidate as decideWithRun, fakeProvider, appendDecisionTrace } from "../../src/brain_train/jev/decision.mjs"
import { sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"

const family = createDecisionFamily({
  id: "pr-signal", questionVersion: "1", choices: ["clear", "feedback", "unavailable", "uncertain"],
  policyVersion: "1", policyConfig: {},
  privacyClass: "private", allowedActions: ["flag-feedback"], threshold: 0.8,
  inputBuilder: (candidate) => ({ reviewText: candidate.text }),
  actionPolicy: (choice) => choice === "feedback" ? "flag-feedback" : null,
  fallback: (baseline) => baseline,
})
const candidate = { eligible: true, sourceId: "1".repeat(64), sourceRefs: ["https://example.test/42?token=secret"], sourceContent: "private review text", text: "private review text", baseline: "uncertain", privacyClass: "private", callIndex: 0 }
const decideCandidate = (options) => decideWithRun({ codeRevision: "a".repeat(40), modelPin: "jev-pinned", ...options, run: options.run ?? createDecisionRun(options.family) })
const answer = (choice = "feedback", scores = { clear: 0.05, feedback: 0.9, unavailable: 0.03, uncertain: 0.02 }) => ({ ok: true, model: "jev-pinned", answers: { signal: { choice, probabilities: scores } }, latencyMs: 12, usage: { input_tokens: 10 } })
const sourceProof = (refs, content = candidate.sourceContent) => {
  const sourceHash = createHash("sha256").update(content).digest("hex")
  const sources = refs.map((sourceRef, index) => ({ id: String(index + 1).repeat(64), sourceRef, sourceHash }))
  return { sources, sourceSnapshotHash: sourceSnapshotHashFor(sources) }
}

describe("offline decision gateway", () => {
  it("rejects successful traces with no call, invalid predictions or incomplete probabilities", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-success-invariants-"))
    try {
      const proof = sourceProof(candidate.sourceRefs)
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", sourceProof: proof })
      for (const outcome of ["decision", "abstain"]) {
        for (const changed of [{ attemptedCall: false }, { prediction: "invented" }, { probabilities: { feedback: 1 } }]) {
          await assert.rejects(() => appendDecisionTrace(root, { ...trace, outcome, ...changed }, family, proof), /successful trace/i)
        }
      }
      for (const changed of [{ suggestedAction: "invented" }, { probabilities: { clear: 0.2, feedback: 0.7, unavailable: 0.05, uncertain: 0.05 } }]) {
        await assert.rejects(() => appendDecisionTrace(root, { ...trace, ...changed }, family, proof), /successful trace/i)
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it("rejects a provider response after synchronous work exceeds the timeout", async () => {
    const short = createDecisionFamily({ ...family, timeoutMs: 5 })
    let signal
    const trace = await decideCandidate({ family: short, candidate, mode: "offline", provider: { localOnly: true, decide: (input) => {
      signal = input.signal
      const started = performance.now()
      while (performance.now() - started < 15) { /* Simulate blocking provider preprocessing. */ }
      return Promise.resolve(answer())
    } } })
    assert.deepEqual([trace.outcome, trace.reason], ["failure", "timeout"])
    assert.equal(signal.aborted, true)
  })

  it("does not persist decision fields on failed or skipped traces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-trace-outcomes-"))
    try {
      const proof = sourceProof(candidate.sourceRefs)
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", sourceProof: proof })
      for (const outcome of ["failure", "skipped"]) {
        const record = await appendDecisionTrace(root, { ...trace, outcome, reason: outcome === "failure" ? "timeout" : "ineligible" }, family, proof)
        assert.equal(record.prediction, null)
        assert.equal(record.suggestedAction, null)
        assert.deepEqual(record.probabilities, {})
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it("rejects missing or malformed candidate privacy classes before a hosted provider call", async () => {
    const publicFamily = createDecisionFamily({ ...family, privacyClass: "public" })
    let calls = 0
    const provider = { decide: async () => { calls += 1; return answer() } }
    for (const privacyClass of [undefined, null, "PRIVATE", "unclassified"]) {
      const trace = await decideCandidate({ family: publicFamily, candidate: { ...candidate, privacyClass }, provider, mode: "offline" })
      assert.deepEqual([trace.outcome, trace.reason], ["skipped", "invalid-privacy-class"])
    }
    assert.equal(calls, 0)
  })

  it("binds persisted traces to the exact frozen source content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-content-proof-"))
    try {
      const original = sourceProof(candidate.sourceRefs)
      const changedSources = original.sources.map((source) => ({ ...source, sourceHash: "b".repeat(64) }))
      const changed = { sources: changedSources, sourceSnapshotHash: sourceSnapshotHashFor(changedSources) }
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", sourceProof: original })
      await assert.rejects(() => appendDecisionTrace(root, trace, family, changed), /source provenance/i)
      const record = await appendDecisionTrace(root, trace, family, original)
      assert.equal(record.sourceSnapshotHash, original.sourceSnapshotHash)
      assert.deepEqual(record.sourceBindings, [{ sourceId: original.sources[0].id, sourceHash: original.sources[0].sourceHash }])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("rejects candidate content that differs from its frozen source before a provider call", async () => {
    const proof = sourceProof(candidate.sourceRefs)
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer() } }
    for (const changed of [
      { sourceContent: "different source body", text: "different source body" },
      { text: "different provider body" },
    ]) {
      await assert.rejects(() => decideCandidate({ family, candidate: { ...candidate, ...changed }, provider, mode: "offline", sourceProof: proof }), /source provenance/i)
    }
    assert.equal(calls, 0)
  })

  it("rejects a candidate source ID that differs from its frozen proof", async () => {
    const proof = sourceProof(candidate.sourceRefs)
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer() } }
    await assert.rejects(() => decideCandidate({
      family, candidate: { ...candidate, sourceId: "2".repeat(64) }, provider, mode: "offline", sourceProof: proof,
    }), /source provenance/i)
    assert.equal(calls, 0)
  })

  it("rejects source references that would be omitted from the frozen proof", async () => {
    const proof = sourceProof(candidate.sourceRefs)
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer() } }
    for (const sourceRefs of [
      [...Array(16).fill(candidate.sourceRefs[0]), "https://example.test/unproven"],
      [candidate.sourceRefs[0], "file:///private/unproven"],
    ]) {
      await assert.rejects(() => decideCandidate({ family, candidate: { ...candidate, sourceRefs }, provider, mode: "offline", sourceProof: proof }), /source provenance/i)
    }
    assert.equal(calls, 0)
  })




  it("rejects offline calls without a code revision and model pin before invoking the provider", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return { ...answer(), model: undefined } } }
    const run = createDecisionRun(family)
    for (const pins of [
      {},
      { codeRevision: "invalid", modelPin: "jev-pinned" },
      { codeRevision: "a".repeat(40) },
      { codeRevision: "a".repeat(40), modelPin: "" },
    ]) {
      await assert.rejects(() => decideWithRun({ family, candidate, provider, mode: "offline", run, ...pins }), /revision|model pin/i)
    }
    assert.equal(calls, 0)
  })

  it("rejects successful traces without identity pins before writing a record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-identity-"))
    try {
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline" })
      await assert.rejects(() => appendDecisionTrace(root, { ...trace, codeRevision: null, modelPin: null, model: null }, family, sourceProof(candidate.sourceRefs)), /revision|model pin/i)
      const exists = await fs.access(path.join(root, ".btrain", "jev", "decision-traces.jsonl")).then(() => true).catch(() => false)
      assert.equal(exists, false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("is off by default and skips ineligible or privacy-denied cases before a provider call", async () => {
    let calls = 0
    const provider = { decide: async () => { calls += 1; return answer() } }
    assert.equal((await decideCandidate({ family, candidate, provider })).outcome, "skipped")
    assert.equal((await decideCandidate({ family, candidate: { ...candidate, eligible: false }, provider, mode: "offline", privacyApproved: true })).reason, "ineligible")
    assert.equal((await decideCandidate({ family, candidate, provider, mode: "offline" })).reason, "privacy-denied")
    for (const privacyApproved of ["false", "true", 1]) {
      assert.equal((await decideCandidate({ family, candidate, provider, mode: "offline", privacyApproved })).reason, "privacy-denied")
    }
    assert.equal(calls, 0)
  })

  it("rejects non-boolean eligibility before calling the provider", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer() } }
    for (const eligible of ["false", 1, null, undefined]) {
      const trace = await decideCandidate({ family, candidate: { ...candidate, eligible }, provider, mode: "offline" })
      assert.deepEqual([trace.outcome, trace.reason], ["skipped", "ineligible"])
    }
    assert.equal(calls, 0)
  })

  it("records a typed suggestion without performing the action or leaking input", async () => {
    const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", privacyApproved: true, modelPin: "jev-pinned", codeRevision: "a".repeat(40) })
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

  it("does not count a missing provider as an attempted call", async () => {
    const trace = await decideCandidate({ family, candidate, mode: "offline", provider: null, privacyApproved: true })
    assert.deepEqual([trace.outcome, trace.reason, trace.attemptedCall], ["failure", "provider-unavailable", false])
  })


  it("keeps malformed provider latency out of returned traces", async () => {
    const args = { family, candidate, mode: "offline", provider: fakeProvider({ ...answer(), latencyMs: { privateText: "secret latency" } }) }
    const decided = await decideCandidate(args)
    const failed = await decideCandidate({ ...args, provider: fakeProvider({ ok: false, reason: "timeout", latencyMs: "secret latency" }) })
    assert.ok(Number.isFinite(decided.latencyMs) && decided.latencyMs >= 0)
    assert.ok(Number.isFinite(failed.latencyMs) && failed.latencyMs >= 0)
    assert.equal(JSON.stringify([decided, failed]).includes("secret latency"), false)
  })

  it("measures call latency locally even when the provider lies or times out", async () => {
    const lied = await decideCandidate({ family, candidate, provider: fakeProvider({ ...answer(), latencyMs: 1_000_000 }), mode: "offline" })
    assert.ok(Number.isFinite(lied.latencyMs) && lied.latencyMs < 10_000)
    const shortTimeout = createDecisionFamily({ ...family, timeoutMs: 5 })
    const timedOut = await decideCandidate({ family: shortTimeout, candidate, provider: { localOnly: true, decide: () => new Promise(() => {}) }, mode: "offline" })
    assert.deepEqual([timedOut.outcome, timedOut.reason], ["failure", "timeout"])
    assert.ok(Number.isFinite(timedOut.latencyMs) && timedOut.latencyMs >= 0)
  })

  it("aborts a provider request when its timeout expires", async () => {
    const shortTimeout = createDecisionFamily({ ...family, timeoutMs: 5 })
    let aborted = false
    const provider = { localOnly: true, decide: ({ signal }) => new Promise(() => {
      signal?.addEventListener("abort", () => { aborted = true }, { once: true })
    }) }
    const trace = await decideCandidate({ family: shortTimeout, candidate, provider, mode: "offline" })
    assert.deepEqual([trace.outcome, trace.reason, aborted], ["failure", "timeout", true])
  })

  it("keeps sanitized billed usage when a provider response is invalid", async () => {
    const malformed = { ...answer("feedback", { feedback: 1 }), usage: { input_tokens: 10, cost: 0.25 } }
    const trace = await decideCandidate({ family, candidate, provider: fakeProvider(malformed), mode: "offline" })
    assert.deepEqual([trace.outcome, trace.reason, trace.inputTokens, trace.cost], ["failure", "invalid-answer", 10, 0.25])
  })

  it("enforces the provider call budget when callers reuse an index", async () => {
    const bounded = createDecisionFamily({ ...family, maxCalls: 2 })
    const run = createDecisionRun(bounded)
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer() } }
    const traces = []
    for (let index = 0; index < 3; index += 1) {
      traces.push(await decideCandidate({ family: bounded, candidate, provider, mode: "offline", run }))
    }
    assert.equal(calls, 2)
    assert.deepEqual(traces.map((trace) => [trace.outcome, trace.reason]), [
      ["decision", undefined], ["decision", undefined], ["skipped", "call-budget"],
    ])
  })

  it("requires an explicit run boundary for offline calls", async () => {
    const provider = fakeProvider(answer())
    await assert.rejects(() => decideWithRun({ family, candidate, provider, mode: "offline" }), /Decision run is required/)
    const first = await decideCandidate({ family, candidate, provider, mode: "offline", run: createDecisionRun(family) })
    const second = await decideCandidate({ family, candidate: { ...candidate, text: "another review" }, provider, mode: "offline", run: createDecisionRun(family) })
    assert.deepEqual([first.outcome, second.outcome], ["decision", "decision"])
  })

  it("skips malformed call indices before invoking a provider", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer() } }
    for (const callIndex of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const trace = await decideCandidate({ family, candidate: { ...candidate, callIndex }, provider, mode: "offline" })
      assert.deepEqual([trace.outcome, trace.reason, trace.attemptedCall], ["skipped", "invalid-call-index", false])
    }
    assert.equal(calls, 0)
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

  it("pins captured policy configuration independently of caller mutation", async () => {
    const policyConfig = { action: "flag-feedback" }
    const create = (config) => createDecisionFamily({
      ...family, policyVersion: "2", policyConfig: config,
      actionPolicy: (choice, _candidate, policy) => choice === "feedback" ? policy.action : null,
    })
    const first = create(policyConfig)
    const second = create({ action: "other-action" })
    assert.notEqual(first.policyHash, second.policyHash)
    policyConfig.action = "other-action"
    assert.equal(first.policyConfig.action, "flag-feedback")
    const trace = await decideCandidate({ family: first, candidate, provider: fakeProvider(answer()), mode: "offline" })
    assert.deepEqual([trace.outcome, trace.suggestedAction], ["decision", "flag-feedback"])
    assert.throws(() => createDecisionFamily({ ...family, policyConfig: undefined }), /policy configuration/)
  })

  it("validates resource budgets and honors an explicit zero-call budget", async () => {
    for (const changes of [{ maxCalls: Infinity }, { maxCalls: -1 }, { maxInputBytes: Infinity }, { timeoutMs: 0 }]) {
      assert.throws(() => createDecisionFamily({ ...family, ...changes }), /budget/)
    }
    let calls = 0
    const zero = createDecisionFamily({ ...family, maxCalls: 0 })
    const trace = await decideCandidate({ family: zero, candidate, provider: { localOnly: true, decide: async () => { calls += 1; return answer() } }, mode: "offline" })
    assert.deepEqual([trace.outcome, trace.reason, calls], ["skipped", "call-budget", 0])
  })

  it("does not allow a family catalog to drift after hashing", () => {
    assert.throws(() => family.choices.push("secret"), TypeError)
    assert.throws(() => family.allowedActions.push("approve-pr"), TypeError)
  })

  it("persists only allowlisted trace fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-jev-trace-"))
    try {
      const proof = sourceProof(candidate.sourceRefs)
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", privacyApproved: true, modelPin: "jev-pinned", sourceProof: proof })
      await appendDecisionTrace(root, { ...trace, privateInput: "do not write me" }, family, proof)
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
      const proof = sourceProof(candidate.sourceRefs)
      const trace = await decideCandidate({ family, candidate: privateCandidate, provider: fakeProvider(answer()), mode: "offline", sourceProof: proof })
      assert.equal(JSON.stringify(trace).includes("secret baseline"), false)
      await appendDecisionTrace(root, { ...trace, baseline: { rawPrivateText: "secret baseline" }, provider: "secret provider metadata" }, family, proof)
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
      const refs = ["https://example.test/private-customer-name"]
      const proof = sourceProof(refs)
      const trace = await decideCandidate({ family, candidate: { ...candidate, sourceRefs: refs }, provider: { id: "tenant-private-detail", localOnly: true, decide: async () => answer() }, mode: "offline", modelPin: "credential-like-secret", sourceProof: proof })
      await appendDecisionTrace(root, { ...trace, reason: "customer-secret-123", model: "credential-like-secret" }, family, proof)
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
      const trace = await decideCandidate({ family, candidate, provider: fakeProvider(answer()), mode: "offline", sourceProof: sourceProof(candidate.sourceRefs) })
      await assert.rejects(() => appendDecisionTrace(root, trace, family, sourceProof(["https://example.test/other"])), /source provenance/)
      await assert.rejects(() => appendDecisionTrace(root, trace, family, { ...sourceProof(candidate.sourceRefs), sourceSnapshotHash: "b".repeat(64) }), /source provenance/)
      const exists = await fs.access(path.join(root, ".btrain", "jev", "decision-traces.jsonl")).then(() => true).catch(() => false)
      assert.equal(exists, false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

it("classifies provider invalid-response as a response-shape failure", async () => {
  const trace = await decideCandidate({ family, candidate, provider: fakeProvider({ ok: false, reason: "invalid-response" }), mode: "offline" })
  assert.equal(trace.failureClass, "response-shape")
})
