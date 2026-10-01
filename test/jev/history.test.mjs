import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"
import { appendDecisionTrace } from "../../src/brain_train/jev/decision.mjs"
import { searchHistory, historyFamily } from "../../src/brain_train/jev/history.mjs"
import { evaluateHistoryPairs } from "../../experiments/jev-btrain/history-search.mjs"

function item(id, overrides = {}) {
  return { id, repository: "o/r", kind: "event", sourceRef: `https://example.test/events/${id}`,
    text: "review policy", access: { principalIds: [], roles: ["reviewer"] }, ...overrides }
}
function record(records = [item("first"), item("second")]) {
  return { query: "review policy", principal: { id: "alice", roles: ["reviewer"] },
    filters: { repositories: ["o/r"], kinds: ["event"] }, records }
}
function frozen(data) {
  const content = JSON.stringify(data)
  const source = { id: "query-1", sourceRef: "https://example.test/queries/1", content }
  const sources = [{ id: source.id, sourceRef: source.sourceRef, sourceHash: createHash("sha256").update(content).digest("hex"), repository: "o/r" }]
  return { source, sourceProof: { sources, sourceSnapshotHash: sourceSnapshotHashFor(sources) },
    mode: "offline", modelPin: "fake-v1", codeRevision: "a".repeat(40) }
}
function answer(choice, confidence = 1) {
  return { ok: true, model: "fake-v1", answers: { signal: { choice, probabilities:
    Object.fromEntries(historyFamily.choices.map((label) => [label, label === choice ? confidence : (1 - confidence) / 3])) } } }
}

test("history authorizes principal and source roles before lexical filtering, inputs or results", async () => {
  const data = record([item("secret", { text: "review policy SECRET", access: { principalIds: ["bob"], roles: [] } }),
    item("other-repo", { repository: "other/r" }), item("other-kind", { kind: "trace" }),
    item("irrelevant", { text: "unrelated astronomy" }), item("role"),
    item("principal", { access: { principalIds: ["alice"], roles: [] }, metadata: { private: "EXTRA" } })])
  const seen = []
  const result = await searchHistory({ ...frozen(data), provider: { localOnly: true, decide: async ({ state }) => {
    seen.push(structuredClone(state)); return answer("high")
  } } })
  assert.deepEqual(result.baselineIds, ["role", "principal"])
  assert.deepEqual(result.rankedIds, result.baselineIds)
  assert.deepEqual(result.results.map((row) => row.id), result.rankedIds)
  assert.equal(result.filteredCounts.unauthorized, 1)
  assert.ok(!JSON.stringify({ seen, result }).includes("SECRET"))
  assert.ok(!JSON.stringify(seen).includes("EXTRA"))
  assert.ok(seen.every((state) => !Object.hasOwn(state, "principal") && !Object.hasOwn(state.record, "access")))
})

test("history uses lexical overlap before semantic ordering, with stable ties", async () => {
  const result = await searchHistory({ ...frozen(record([item("weak", { text: "review" }), item("second"), item("third") ])),
    provider: { localOnly: true, decide: async ({ state }) => answer(state.record.id === "weak" ? "high" : "low") } })
  assert.deepEqual(result.baselineIds, ["second", "third", "weak"])
  assert.deepEqual(result.rankedIds, ["weak", "second", "third"])
  assert.ok(result.traces.every((trace) => trace.actionTaken === "none"))
})

for (const [name, reply] of [["failure", { ok: false, reason: "network-error" }], ["invented label", answer("secret-id")],
  ["abstention", answer("uncertain")], ["low confidence", answer("high", 0.4)]]) {
  test(`history retains the whole lexical baseline after partial scoring and ${name}`, async () => {
    let calls = 0
    const result = await searchHistory({ ...frozen(record()), provider: { localOnly: true, decide: async () => {
      calls += 1; return calls === 1 ? answer("low") : reply
    } } })
    assert.deepEqual(result.rankedIds, result.baselineIds)
    assert.equal(result.results.length, 2)
  })
}

test("off, hosted private providers and no authorized matches make no calls", async () => {
  for (const options of [{ mode: "off" }, { mode: "offline" }, { mode: "offline", denied: true }]) {
    let calls = 0
    const input = frozen(record(options.denied ? [item("denied", { access: { principalIds: [], roles: [] } })] : undefined))
    const result = await searchHistory({ ...input, mode: options.mode, provider: { decide: async () => { calls += 1 } } })
    assert.equal(calls, 0)
    assert.deepEqual(result.rankedIds, result.baselineIds)
    if (options.denied) assert.deepEqual(result.results, [])
  }
})

test("history limits lexical shortlist and provider calls to sixteen records", async () => {
  let calls = 0
  const result = await searchHistory({ ...frozen(record(Array.from({ length: 20 }, (_, i) => item(`r${i}`)))),
    provider: { localOnly: true, decide: async () => { calls += 1; return answer("high") } } })
  assert.equal(calls, 16)
  assert.deepEqual(result.baselineIds, Array.from({ length: 16 }, (_, i) => `r${i}`))
})

test("serialized input byte limits exclude the complete rerank before any provider calls", async () => {
  const data = record([item("large", { text: "review " + "\\".repeat(8000) }), item("normal")])
  data.query = "review " + "\\".repeat(4000)
  let calls = 0
  const result = await searchHistory({ ...frozen(data), provider: { localOnly: true, decide: async () => { calls += 1 } } })
  assert.equal(calls, 0)
  assert.deepEqual(result.rankedIds, result.baselineIds)
  assert.deepEqual(result.eligibleIds, [])
  assert.ok(result.traces.every((trace) => trace.outcome === "skipped" && !trace.attemptedCall))
})

test("caller and provider mutation cannot change access, later inputs or result references", async () => {
  const options = frozen(record())
  const seen = []
  const result = await searchHistory({ ...options, provider: { localOnly: true, decide: async ({ state }) => {
    seen.push(state.record.id)
    state.record.id = "invented"
    state.record.sourceRef = "https://attacker.test/changed"
    options.source.content = JSON.stringify(record([item("secret", { access: { principalIds: ["bob"], roles: [] } })]))
    options.sourceProof.sources[0].repository = "changed/r"
    return answer("high")
  } } })
  assert.deepEqual(seen, ["first", "second"])
  assert.deepEqual(result.rankedIds, ["first", "second"])
  assert.ok(result.results.every((row) => row.sourceRef.startsWith("https://example.test/")))
})

test("history rejects invalid ACL, duplicate IDs, proof changes and live modes before calls", async () => {
  for (const data of [record([item("x", { access: null })]), record([item("x"), item("x")]),
    { ...record(), principal: { id: "alice", roles: "reviewer" } },
    record([item("x", { sourceRef: ["https://example.test/x"] })])]) {
    let calls = 0
    await assert.rejects(searchHistory({ ...frozen(data), provider: { localOnly: true, decide: async () => { calls += 1 } } }))
    assert.equal(calls, 0)
  }
  const options = frozen(record())
  await assert.rejects(searchHistory({ ...options, mode: "assist" }), /off or offline/)
  await assert.rejects(searchHistory({ ...options, sourceProof: null }), /frozen/)
})

test("history traces including empty matches persist with frozen proof and redacted text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-history-"))
  try {
    for (const data of [record(), record([item("secret", { access: { principalIds: [], roles: [] } })])]) {
      const options = frozen(data)
      const result = await searchHistory({ ...options, provider: { localOnly: true, decide: async () => answer("high") } })
      assert.ok(result.traces.length > 0)
      for (const trace of result.traces) await appendDecisionTrace(root, trace, historyFamily, options.sourceProof)
    }
    const text = await fs.readFile(path.join(root, ".btrain/jev/decision-traces.jsonl"), "utf8")
    for (const raw of ["review policy", "alice", "example.test", "secret"]) assert.ok(!text.includes(raw))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})


test("authorized shortlist, gateway traces and paired recall compose through the public adapter", async () => {
  const data = record(Array.from({ length: 6 }, (_, i) => item(`match-${i}`)))
  const options = frozen(data)
  const start = performance.now()
  const result = await searchHistory({ ...options, provider: { localOnly: true, decide: async ({ state }) =>
    answer(state.record.id === "match-5" ? "high" : "low") } })
  const report = evaluateHistoryPairs([{ id: "query-1", origin: "synthetic", principalId: data.principal.id,
    sourceAccessRoles: data.principal.roles, authorizedIds: data.records.map((entry) => entry.id), relevantIds: ["match-5"],
    baselineIds: result.baselineIds, rankedIds: result.rankedIds, elapsedMs: performance.now() - start,
    gatewayAttempts: result.traces.map((trace, index) => ({ id: result.baselineIds[index],
      eligible: result.eligibleIds.includes(result.baselineIds[index]), attemptedCall: trace.attemptedCall, outcome: trace.outcome, failureClass: trace.failureClass })) }])
  assert.equal(report.synthetic.baselineRecallAt5, 0)
  assert.equal(report.synthetic.semanticRecallAt5, 1)
  assert.equal(report.synthetic.gateway.attempted, 6)
  assert.equal(report.gateReady, false)
})
