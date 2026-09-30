import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sourceSnapshotHashFor } from "../../src/brain_train/jev/manifest.mjs"
import { appendDecisionTrace } from "../../src/brain_train/jev/decision.mjs"
import { rankEligibleRoutes, routingFamily } from "../../src/brain_train/jev/routing.mjs"
import { inspectMemoryClaim, memoryFamily } from "../../src/brain_train/jev/memory.mjs"

function frozen(record) {
  const content = JSON.stringify(record)
  const source = { id: "case-1", sourceRef: "https://example.test/cases/1", content }
  const sources = [{ id: source.id, sourceRef: source.sourceRef, sourceHash: createHash("sha256").update(content).digest("hex") }]
  return { source, sourceProof: { sources, sourceSnapshotHash: sourceSnapshotHashFor(sources) },
    mode: "offline", modelPin: "fake-v1", codeRevision: "a".repeat(40) }
}

function response(family, choice, confidence = 1) {
  const rest = (1 - confidence) / (family.choices.length - 1)
  return { ok: true, model: "fake-v1", answers: { signal: { choice,
    probabilities: Object.fromEntries(family.choices.map((value) => [value, value === choice ? confidence : rest])) } } }
}

function route(id, overrides = {}) {
  return { id, actorId: id, authorized: true, available: true, lockCompatible: true,
    capabilities: ["review"], description: `Review candidate ${id}`, ...overrides }
}

function routingRecord(candidates = [route("first"), route("second")]) {
  return { kind: "reviewer", objective: "Review a change", ownerId: "builder", requiredCapabilities: ["review"], candidates }
}

function memoryRecord(events) {
  return { asOfSequence: 20, claim: { id: "claim-1", key: "review-policy", version: 1,
    observedSequence: 10, leaseUntilSequence: 15, sourceRef: "https://example.test/claims/1", text: "Original review policy" },
  events: events ?? [{ id: "event-2", key: "review-policy", version: 2, sequence: 12,
    authorized: true, sourceRef: "https://example.test/events/2", text: "Replacement review policy" }] }
}

test("routing filters all authority constraints before exposing candidates to the provider", async () => {
  const record = routingRecord([
    route("no-auth", { authorized: false }), route("busy", { available: false }),
    route("locked", { lockCompatible: false }), route("builder"),
    route("incapable", { capabilities: [] }), route("unknown", { authorized: undefined }), route("good"),
  ])
  const inputs = []
  const result = await rankEligibleRoutes({ ...frozen(record), provider: { localOnly: true, decide: async ({ state }) => {
    inputs.push(state); return response(routingFamily, "high")
  } } })
  assert.deepEqual(result.baselineIds, ["good"])
  assert.deepEqual(result.rankedIds, ["good"])
  assert.equal(result.excluded.length, 6)
  assert.deepEqual(inputs.map((input) => input.candidate.id), ["good"])
  for (const id of ["no-auth", "busy", "locked", "builder", "incapable", "unknown"]) {
    assert.ok(!JSON.stringify(inputs).includes(`Review candidate ${id}`))
  }
  assert.equal(result.traces[0].actionTaken, "none")
})

test("routing ranks only eligible catalog IDs and keeps deterministic order for ties", async () => {
  const result = await rankEligibleRoutes({ ...frozen(routingRecord([route("first"), route("second"), route("third")])),
    provider: { localOnly: true, decide: async ({ state }) => response(routingFamily, state.candidate.id === "first" ? "low" : "high") } })
  assert.deepEqual(result.rankedIds, ["second", "third", "first"])
  assert.deepEqual(result.baselineIds, ["first", "second", "third"])
})

for (const [name, reply] of [
  ["provider failure", { ok: false, reason: "rate-limit" }],
  ["invented destination", response(routingFamily, "merge-main")],
  ["uncertainty", response(routingFamily, "uncertain")],
  ["low confidence", response(routingFamily, "high", 0.4)],
]) test(`routing preserves the complete baseline on ${name}`, async () => {
  let calls = 0
  const result = await rankEligibleRoutes({ ...frozen(routingRecord()), provider: { localOnly: true, decide: async () => {
    calls += 1; return calls === 1 ? response(routingFamily, "low") : reply
  } } })
  assert.deepEqual(result.rankedIds, result.baselineIds)
  assert.ok(result.traces.every((trace) => trace.actionTaken === "none"))
})

test("off and denied private providers preserve the routing baseline without calls", async () => {
  for (const mode of ["off", "offline"]) {
    let calls = 0
    const result = await rankEligibleRoutes({ ...frozen(routingRecord()), mode, provider: { decide: async () => { calls += 1 } } })
    assert.equal(calls, 0)
    assert.deepEqual(result.rankedIds, result.baselineIds)
  }
})

test("routing stops before calls when the eligible catalog exceeds its bounded ranking budget", async () => {
  let calls = 0
  const record = routingRecord(Array.from({ length: 17 }, (_, i) => route(`r${i}`)))
  const result = await rankEligibleRoutes({ ...frozen(record), provider: { localOnly: true, decide: async () => { calls += 1 } } })
  assert.equal(calls, 0)
  assert.deepEqual(result.rankedIds, result.baselineIds)
})

test("mutable caller data and provider state cannot re-enable filtered routes or change later ranking inputs", async () => {
  const options = frozen(routingRecord([route("first"), route("second"), route("secret", { authorized: false })]))
  const seen = []
  const result = await rankEligibleRoutes({ ...options, provider: { localOnly: true, decide: async ({ state }) => {
    seen.push(state.candidate.id)
    state.candidate.id = "secret"
    options.source.content = JSON.stringify(routingRecord([route("secret")]))
    options.sourceProof.sources[0].sourceHash = "b".repeat(64)
    return response(routingFamily, "high")
  } } })
  assert.deepEqual(seen, ["first", "second"])
  assert.deepEqual(result.rankedIds, ["first", "second"])
})

test("memory warnings cite the exact claim version and authorized newer event without rewriting inputs", async () => {
  const record = memoryRecord()
  const options = frozen(record)
  const before = structuredClone(options)
  const result = await inspectMemoryClaim({ ...options, provider: { localOnly: true, decide: async () => response(memoryFamily, "superseded") } })
  assert.deepEqual(result.warnings, [{ kind: "possibly-stale", claimId: "claim-1", claimVersion: 1,
    eventId: "event-2", eventVersion: 2, sourceRefs: [record.claim.sourceRef, record.events[0].sourceRef] }])
  assert.deepEqual(options, before)
  assert.equal(result.ageBaseline, "stale")
  assert.equal(result.traces[0].actionTaken, "none")
})

test("memory compares only authorized events for the same key that postdate the frozen claim", async () => {
  const base = memoryRecord().events[0]
  const record = memoryRecord([
    { ...base, id: "private", authorized: false }, { ...base, id: "other", key: "other" },
    { ...base, id: "old-version", version: 1 }, { ...base, id: "old-event", sequence: 10 },
    { ...base, id: "future", sequence: 21 }, base,
  ])
  const seen = []
  const result = await inspectMemoryClaim({ ...frozen(record), provider: { localOnly: true, decide: async ({ state }) => {
    seen.push(state.event.id); return response(memoryFamily, "superseded")
  } } })
  assert.deepEqual(seen, ["event-2"])
  assert.equal(result.warnings.length, 1)
})

test("memory retains canonical history for supported uncertain malformed and failed responses", async () => {
  for (const reply of [response(memoryFamily, "supported"), response(memoryFamily, "uncertain"),
    response(memoryFamily, "rewrite-history"), { ok: false, reason: "network-error" }, response(memoryFamily, "superseded", 0.4)]) {
    const result = await inspectMemoryClaim({ ...frozen(memoryRecord()), provider: { localOnly: true, decide: async () => reply } })
    assert.deepEqual(result.warnings, [])
    assert.ok(result.traces.every((trace) => trace.actionTaken === "none"))
  }
})

test("memory inspects at most sixteen events and preserves frozen references across provider calls", async () => {
  const base = memoryRecord().events[0]
  const options = frozen(memoryRecord(Array.from({ length: 17 }, (_, i) => ({ ...base, id: `event-${i}` }))))
  let calls = 0
  const result = await inspectMemoryClaim({ ...options, provider: { localOnly: true, decide: async ({ state }) => {
    calls += 1
    state.claim.sourceRef = "https://attacker.test/invented"
    options.source.content = "tampered"
    return response(memoryFamily, "superseded")
  } } })
  assert.equal(calls, 16)
  assert.equal(result.warnings.length, 16)
  assert.ok(result.warnings.every((warning) => warning.sourceRefs[0] === "https://example.test/claims/1"))
  assert.equal(result.traces.at(-1).reason, "call-budget")
})

test("memory sends only validated scalar fields and excludes extra nested source metadata", async () => {
  const record = memoryRecord()
  record.claim.metadata = { policy: "frozen" }
  record.events = [record.events[0], { ...record.events[0], id: "event-3" }]
  const inputs = []
  await inspectMemoryClaim({ ...frozen(record), provider: { localOnly: true, decide: async ({ state }) => {
    inputs.push(structuredClone(state))
    if (state.claim.metadata) state.claim.metadata.policy = "tampered"
    return response(memoryFamily, "superseded")
  } } })
  assert.equal(inputs.length, 2)
  assert.ok(inputs.every((input) => !Object.hasOwn(input.claim, "metadata")))
})

test("coercible source references are rejected before memory can expose or cite them", async () => {
  for (const value of [["https://example.test/claim"], { toString: "https://example.test/claim" }]) {
    for (const field of ["claim", "event"]) {
      const record = memoryRecord()
      if (field === "claim") record.claim.sourceRef = value
      else record.events[0].sourceRef = value
      let calls = 0
      await assert.rejects(inspectMemoryClaim({ ...frozen(record), provider: { localOnly: true, decide: async () => { calls += 1 } } }))
      assert.equal(calls, 0)
    }
  }
  const options = frozen(routingRecord())
  options.source.sourceRef = [options.source.sourceRef]
  await assert.rejects(rankEligibleRoutes(options), /source record/i)
})

test("both adapters reject unfrozen or mismatched content before calling a provider", async () => {
  for (const [adapter, record] of [[rankEligibleRoutes, routingRecord()], [inspectMemoryClaim, memoryRecord()]]) {
    const options = frozen(record)
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1 } }
    await assert.rejects(adapter({ ...options, sourceProof: null, provider }), /frozen/i)
    options.source.content += " "
    await assert.rejects(adapter({ ...options, provider }), /frozen/i)
    assert.equal(calls, 0)
  }
})

test("routing and memory traces compose with the shared redacted evidence writer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-routing-memory-"))
  try {
    for (const [adapter, family, record, choice] of [
      [rankEligibleRoutes, routingFamily, routingRecord(), "high"],
      [inspectMemoryClaim, memoryFamily, memoryRecord(), "superseded"],
    ]) {
      const options = frozen(record)
      const result = await adapter({ ...options, provider: { localOnly: true, decide: async () => response(family, choice) } })
      for (const trace of result.traces) await appendDecisionTrace(root, trace, family, options.sourceProof)
    }
    const text = await fs.readFile(path.join(root, ".btrain/jev/decision-traces.jsonl"), "utf8")
    assert.equal(text.trim().split("\n").length, 3)
    for (const raw of ["Original review policy", "Replacement review policy", "Review candidate", "example.test"]) assert.ok(!text.includes(raw))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
