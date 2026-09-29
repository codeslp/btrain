import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
const candidate = { eligible: true, sourceRefs: ["https://example.test/42?token=secret"], text: "private review text", baseline: "uncertain", callIndex: 0 }
const decideCandidate = (options) => decideWithRun({ codeRevision: "a".repeat(40), modelPin: "jev-pinned", ...options, run: options.run ?? createDecisionRun(options.family) })
const answer = (choice = "feedback", scores = { clear: 0.05, feedback: 0.9, unavailable: 0.03, uncertain: 0.02 }) => ({ ok: true, model: "jev-pinned", answers: { signal: { choice, probabilities: scores } }, latencyMs: 12, usage: { input_tokens: 10 } })
const sourceProof = (refs) => {
  const sources = refs.map((sourceRef, index) => ({ id: `source-${index}`, sourceRef, sourceHash: "a".repeat(64) }))
  return { sources, sourceSnapshotHash: sourceSnapshotHashFor(sources) }
}

describe("offline decision gateway", () => {
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

  it("applies candidate action eligibility under one stable family policy", async () => {
    const conditional = createDecisionFamily({
      ...family,
      actionPolicy: (choice, currentCandidate) => choice === "feedback" && !currentCandidate.blocked ? "flag-feedback" : null,
    })
    const provider = fakeProvider(answer())
    const decided = await decideCandidate({ family: conditional, candidate: { ...candidate, blocked: false }, provider, mode: "offline" })
    const blocked = await decideCandidate({ family: conditional, candidate: { ...candidate, blocked: true }, provider, mode: "offline" })
    assert.equal(decided.outcome, "decision")
    assert.deepEqual([blocked.outcome, blocked.reason, blocked.suggestedAction], ["abstain", "no-permitted-action", undefined])
    assert.equal(blocked.policyHash, decided.policyHash)
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
