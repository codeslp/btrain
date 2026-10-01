import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"
import { appendDecisionTrace } from "../../src/brain_train/jev/decision.mjs"
import { inspectRules, repositoryRuleFamily, turnRuleFamily } from "../../src/brain_train/jev/rules.mjs"
import { prioritizeReviews, reviewRiskFamily } from "../../src/brain_train/jev/review-risk.mjs"
import { evaluateReviewQueues } from "../../experiments/jev-btrain/rules-risk.mjs"

function frozen(record) {
  const source = { id: "case-1", sourceRef: "https://example.test/cases/1", content: JSON.stringify(record) }
  const sources = [{ id: source.id, sourceRef: source.sourceRef,
    sourceHash: createHash("sha256").update(source.content).digest("hex") }]
  return { source, sourceProof: { sources, sourceSnapshotHash: sourceSnapshotHashFor(sources) },
    mode: "offline", modelPin: "fake-v1", codeRevision: "a".repeat(40) }
}

function reply(family, choice, probability = 1, extra = {}) {
  return { ok: true, model: "fake-v1", answers: { signal: { choice,
    probabilities: Object.fromEntries(family.choices.map((value) => [value, value === choice ? probability : (1 - probability) / (family.choices.length - 1)])),
    ...extra } } }
}

function ruleRecord(kind = "diff") {
  return { kind, rules: [{ id: "negative-path", version: "1", explicit: true, authorized: true,
    sourceRef: "https://example.test/AGENTS", text: "Test failed verification paths before handoff" }],
  artifacts: [{ id: "change", kind, authorized: true, sourceRef: "https://example.test/changes/1",
    text: "Only the success path was tested" }],
  checks: [{ ruleId: "negative-path", artifactId: "change", applicable: true, baseline: "conforming" }] }
}

function review(id, extra = {}) {
  return { id, authorized: true, sourceRef: `https://example.test/reviews/${id}`, text: `Review evidence ${id}`,
    requiredChecks: ["peer-review", "negative-path"], ...extra }
}

function riskRecord(reviews = [review("first"), review("second")]) {
  return { objective: "Prioritize review depth", reviews }
}

test("risk gateway traces compose with per-review G6-V accounting", async () => {
  const record = riskRecord([review("first"), review("second"), review("excluded", { authorized: false })])
  const result = await prioritizeReviews({ ...frozen(record), provider: { localOnly: true, decide: async ({ state }) =>
    state.review.id === "first" ? reply(reviewRiskFamily, "high") : { ok: false, reason: "timeout" } } })
  const report = evaluateReviewQueues([{ id: "composed", origin: "synthetic",
    baselineIds: result.baselineIds, prioritizedIds: result.prioritizedIds,
    defectIds: [], severeIds: [], baselineFoundIds: [], prioritizedFoundIds: [], baselineMinutes: 10, prioritizedMinutes: 10,
    gatewayAttempts: result.traces.map((trace, index) => ({ reviewId: record.reviews[index].id,
      eligible: record.reviews[index].authorized, attemptedCall: trace.attemptedCall, outcome: trace.outcome, failureClass: trace.failureClass })),
  }])
  assert.equal(report.synthetic.gateway.eligible, 2)
  assert.equal(report.synthetic.gateway.attemptedCalls, 2)
  assert.equal(report.synthetic.gateway.attemptedFailureRate, 0.5)
  assert.equal(report.synthetic.gateway.actionableDecisionCoverage, 0.5)
  assert.equal(report.synthetic.gateway.skipped, 1)
  assert.equal(report.gateReady, false)
})

test("repository and turn rules use independent policies and cite only supplied rule/evidence versions", async () => {
  assert.notEqual(repositoryRuleFamily.id, turnRuleFamily.id)
  assert.notEqual(repositoryRuleFamily.policyHash, turnRuleFamily.policyHash)
  for (const [kind, family] of [["diff", repositoryRuleFamily], ["turn", turnRuleFamily]]) {
    const record = ruleRecord(kind)
    const result = await inspectRules({ ...frozen(record), provider: { localOnly: true,
      decide: async () => reply(family, "violation", 1, { ruleId: "invented", citations: ["https://attacker.test/fake"] }) } })
    assert.equal(result.family, family.id)
    assert.deepEqual(result.warnings, [{ kind: "possible-rule-violation", ruleId: "negative-path", ruleVersion: "1",
      ruleSourceRef: record.rules[0].sourceRef, artifactId: "change", artifactSourceRef: record.artifacts[0].sourceRef }])
    assert.equal(result.traces[0].actionTaken, "none")
    assert.equal(result.traces[0].baseline, "conforming")
  }
})

test("rules require explicit authorized applicable evidence before exposing any text to the provider", async () => {
  for (const mutate of [
    (record) => { record.rules[0].explicit = false },
    (record) => { delete record.rules[0].explicit },
    (record) => { record.rules[0].authorized = false },
    (record) => { record.artifacts[0].authorized = false },
    (record) => { record.checks[0].applicable = false },
  ]) {
    const record = ruleRecord()
    mutate(record)
    let calls = 0
    const result = await inspectRules({ ...frozen(record), provider: { localOnly: true, decide: async () => { calls += 1 } } })
    assert.equal(calls, 0)
    assert.deepEqual(result.warnings, [])
    assert.equal(result.traces[0].outcome, "skipped")
  }
})

test("invented check references duplicate checks and mixed turn/diff artifacts are rejected before calls", async () => {
  for (const mutate of [
    (record) => { record.checks[0].ruleId = "invented" },
    (record) => { record.checks[0].artifactId = "invented" },
    (record) => { record.checks.push(record.checks[0]) },
    (record) => { record.artifacts[0].kind = "turn" },
    (record) => { record.rules[0].sourceRef = [record.rules[0].sourceRef] },
    (record) => { record.checks[0].baseline = "approve" },
  ]) {
    const record = ruleRecord()
    mutate(record)
    let calls = 0
    await assert.rejects(inspectRules({ ...frozen(record), provider: { localOnly: true, decide: async () => { calls += 1 } } }))
    assert.equal(calls, 0)
  }
})

for (const [name, value] of [
  ["conforming", reply(repositoryRuleFamily, "conforming")],
  ["uncertain", reply(repositoryRuleFamily, "uncertain")],
  ["low-confidence", reply(repositoryRuleFamily, "violation", 0.4)],
  ["out-of-catalog", reply(repositoryRuleFamily, "approve")],
  ["provider failure", { ok: false, reason: "network-error" }],
]) test(`rules never emit a warning or alter workflow state on ${name}`, async () => {
  const result = await inspectRules({ ...frozen(ruleRecord()), provider: { localOnly: true, decide: async () => value } })
  assert.deepEqual(result.warnings, [])
  assert.ok(result.traces.every((trace) => trace.actionTaken === "none"))
})

test("provider mutations cannot change later rule evidence or supplied citations", async () => {
  const record = ruleRecord()
  record.rules[0].extra = { instruction: "private metadata" }
  record.artifacts.push({ ...record.artifacts[0], id: "second", sourceRef: "https://example.test/changes/2" })
  record.checks.push({ ...record.checks[0], artifactId: "second" })
  const options = frozen(record)
  const seen = []
  const result = await inspectRules({ ...options, provider: { localOnly: true, decide: async ({ state }) => {
    seen.push(structuredClone(state))
    state.rule.sourceRef = "https://attacker.test/fake"
    state.rule.text = "tampered"
    state.artifact.sourceRef = "https://attacker.test/fake"
    options.source.content = "tampered"
    options.sourceProof.sources[0].sourceHash = "b".repeat(64)
    return reply(repositoryRuleFamily, "violation")
  } } })
  assert.equal(seen.length, 2)
  assert.ok(seen.every((state) => state.rule.text === record.rules[0].text && !Object.hasOwn(state.rule, "extra")))
  assert.deepEqual(result.warnings.map((warning) => warning.artifactSourceRef), record.artifacts.map((artifact) => artifact.sourceRef))
})

test("rule call budget is shared across checks and skips excess eligible candidates", async () => {
  const record = ruleRecord()
  record.artifacts = Array.from({ length: 17 }, (_, index) => ({ ...record.artifacts[0], id: `a${index}` }))
  record.checks = record.artifacts.map((artifact) => ({ ...record.checks[0], artifactId: artifact.id }))
  let calls = 0
  const result = await inspectRules({ ...frozen(record), provider: { localOnly: true, decide: async () => {
    calls += 1; return reply(repositoryRuleFamily, "violation")
  } } })
  assert.equal(calls, 16)
  assert.equal(result.warnings.length, 16)
  assert.equal(result.traces.at(-1).reason, "call-budget")
})

test("risk scores prioritize review depth while preserving every required check and queue entry", async () => {
  const record = riskRecord([review("first"), review("second"), review("third")])
  const result = await prioritizeReviews({ ...frozen(record), provider: { localOnly: true,
    decide: async ({ state }) => reply(reviewRiskFamily, state.review.id === "first" ? "low" : "high") } })
  assert.deepEqual(result.prioritizedIds, ["second", "third", "first"])
  assert.deepEqual(result.baselineIds, ["first", "second", "third"])
  assert.deepEqual(result.requiredReviews, record.reviews.map((item) => ({ id: item.id, checks: item.requiredChecks })))
  assert.ok(result.traces.every((trace) => trace.actionTaken === "none"))
})

test("unauthorized review text never reaches provider and an incomplete risk queue preserves its baseline", async () => {
  const record = riskRecord([review("first"), review("secret", { authorized: false }), review("third")])
  const seen = []
  const result = await prioritizeReviews({ ...frozen(record), provider: { localOnly: true, decide: async ({ state }) => {
    seen.push(state.review.id); return reply(reviewRiskFamily, "high")
  } } })
  assert.deepEqual(seen, ["first", "third"])
  assert.deepEqual(result.prioritizedIds, result.baselineIds)
  assert.equal(result.requiredReviews.length, 3)
})

test("risk failures uncertainty and malicious skip answers cannot suppress required reviews", async () => {
  for (const value of [reply(reviewRiskFamily, "uncertain"), reply(reviewRiskFamily, "skip-review"),
    reply(reviewRiskFamily, "high", 0.4), { ok: false, reason: "rate-limit" }]) {
    let calls = 0
    const result = await prioritizeReviews({ ...frozen(riskRecord()), provider: { localOnly: true, decide: async () => {
      calls += 1; return calls === 1 ? reply(reviewRiskFamily, "low") : value
    } } })
    assert.deepEqual(result.prioritizedIds, result.baselineIds)
    assert.equal(result.requiredReviews.length, 2)
    assert.ok(result.traces.every((trace) => trace.actionTaken === "none"))
  }
})

test("oversized risk queues and denied hosted/off providers retain deterministic obligations without calls", async () => {
  for (const [record, mode, localOnly] of [
    [riskRecord(Array.from({ length: 17 }, (_, i) => review(`r${i}`))), "offline", true],
    [riskRecord(), "off", true], [riskRecord(), "offline", false],
  ]) {
    let calls = 0
    const result = await prioritizeReviews({ ...frozen(record), mode, provider: { localOnly, decide: async () => { calls += 1 } } })
    assert.equal(calls, 0)
    assert.deepEqual(result.prioritizedIds, result.baselineIds)
    assert.equal(result.requiredReviews.length, record.reviews.length)
  }
})

test("risk provider mutation cannot change later evidence or delete mandatory review checks", async () => {
  const record = riskRecord()
  const options = frozen(record)
  const seen = []
  const result = await prioritizeReviews({ ...options, provider: { localOnly: true, decide: async ({ state }) => {
    seen.push(structuredClone(state))
    state.review.requiredChecks.length = 0
    state.review.text = "tampered"
    options.source.content = "tampered"
    return reply(reviewRiskFamily, "low")
  } } })
  assert.deepEqual(seen.map((state) => state.review.text), record.reviews.map((item) => item.text))
  assert.deepEqual(result.requiredReviews.map((item) => item.checks), record.reviews.map((item) => item.requiredChecks))
})

test("all three families require frozen provenance and compose with redacted trace persistence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-rules-risk-"))
  try {
    for (const [adapter, family, record, choice] of [
      [inspectRules, repositoryRuleFamily, ruleRecord(), "violation"],
      [inspectRules, turnRuleFamily, ruleRecord("turn"), "violation"],
      [prioritizeReviews, reviewRiskFamily, riskRecord(), "high"],
    ]) {
      const options = frozen(record)
      const provider = { localOnly: true, decide: async () => reply(family, choice) }
      await assert.rejects(adapter({ ...options, sourceProof: null, provider }), /frozen/i)
      const result = await adapter({ ...options, provider })
      for (const trace of result.traces) await appendDecisionTrace(root, trace, family, options.sourceProof)
    }
    const text = await fs.readFile(path.join(root, ".btrain/jev/decision-traces.jsonl"), "utf8")
    assert.equal(text.trim().split("\n").length, 4)
    for (const raw of ["example.test", "Test failed verification", "Only the success", "Review evidence"]) assert.ok(!text.includes(raw))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
