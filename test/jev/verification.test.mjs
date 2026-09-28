import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { fakeProvider } from "../../src/brain_train/jev/decision.mjs"
import { mandatoryVerificationChecks, planVerification } from "../../src/brain_train/jev/verification.mjs"

const sourceRefs = ["https://example.test/changes/42"]
const answer = (choice) => ({
  ok: true, model: "local-fixture",
  answers: { signal: { choice, probabilities: Object.fromEntries(
    ["unit", "integration", "negative-path", "migration-safety", "security-boundary", "formal-witness", "none"].map((id) => [id, id === choice ? 1 : 0]),
  ) } },
})

describe("offline verification planner", () => {
  it("retains mandatory migration, security, formal, and cross-component checks", () => {
    const checks = mandatoryVerificationChecks({
      changedPaths: ["src/brain_train/auth.mjs", "migrations/pg/042.sql", "formal/handoff.tla"],
      contractTags: ["cross-component", "negative-path"],
    })
    assert.deepEqual(checks, ["unit", "integration", "negative-path", "migration-safety", "security-boundary", "formal-witness"])
  })

  it("requires security checks for changes inside auth directories", () => {
    assert.deepEqual(mandatoryVerificationChecks({ changedPaths: ["src/api/auth/routes.mjs"] }), ["unit", "security-boundary"])
  })

  it("rejects an empty change rather than requesting a model suggestion", async () => {
    await assert.rejects(() => planVerification({ change: { changedPaths: [], sourceRefs }, provider: fakeProvider(answer("unit")), mode: "offline" }), /Changed paths are required/)
  })

  it("keeps mandatory checks when off, unavailable, or given out-of-catalog output", async () => {
    const change = { changedPaths: ["migrations/pg/042.sql"], sourceRefs }
    const off = await planVerification({ change, provider: fakeProvider(answer("integration")) })
    const unavailable = await planVerification({ change, provider: fakeProvider({ ok: false, reason: "timeout" }), mode: "offline" })
    const invalid = await planVerification({ change, provider: fakeProvider(answer("delete-required")), mode: "offline" })
    for (const plan of [off, unavailable, invalid]) {
      assert.deepEqual(plan.mandatory, ["migration-safety"])
      assert.deepEqual(plan.checks, ["migration-safety"])
      assert.deepEqual(plan.suggested, [])
    }
    assert.deepEqual([off.traces[0].outcome, unavailable.traces[0].outcome, invalid.traces[0].reason], ["skipped", "failure", "invalid-answer"])
  })

  it("accepts only additive catalog suggestions and stops on none", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => answer(["integration", "negative-path", "none"][calls++]) }
    const plan = await planVerification({ change: { changedPaths: ["src/brain_train/jev/replay.mjs"], sourceRefs }, provider, mode: "offline" })
    assert.deepEqual(plan.mandatory, ["unit"])
    assert.deepEqual(plan.suggested, ["integration", "negative-path"])
    assert.deepEqual(plan.checks, ["unit", "integration", "negative-path"])
    assert.deepEqual(plan.traces.map((trace) => trace.outcome), ["decision", "decision", "abstain"])
    assert.equal(calls, 3)
    assert.equal(JSON.stringify(plan).includes("src/brain_train/jev/replay.mjs"), false)
  })

  it("stops repeated suggestions and never suppresses a mandatory check", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer("unit") } }
    const plan = await planVerification({ change: { changedPaths: ["src/brain_train/core.mjs"], sourceRefs }, provider, mode: "offline" })
    assert.deepEqual(plan.checks, ["unit"])
    assert.deepEqual(plan.suggested, [])
    assert.equal(calls, 1)
  })

  it("keeps private change metadata local and bounds provider calls", async () => {
    let calls = 0
    const provider = { decide: async () => { calls += 1; return answer("integration") } }
    const plan = await planVerification({ change: { changedPaths: ["src/private-customer.mjs"], sourceRefs }, provider, mode: "offline" })
    assert.deepEqual(plan.mandatory, ["unit"])
    assert.equal(plan.traces[0].reason, "privacy-denied")
    assert.equal(calls, 0)
  })

  it("caps model calls and skips an oversized path list without losing mandatory checks", async () => {
    let calls = 0
    const provider = { localOnly: true, decide: async () => { calls += 1; return answer(["integration", "negative-path", "formal-witness"][calls - 1]) } }
    const change = { changedPaths: ["src/brain_train/core.mjs"], sourceRefs }
    const bounded = await planVerification({ change, provider, mode: "offline" })
    assert.equal(calls, 3)
    assert.deepEqual(bounded.suggested, ["integration", "negative-path", "formal-witness"])
    const oversized = await planVerification({ change: { ...change, changedPaths: Array(257).fill("src/brain_train/core.mjs") }, provider, mode: "offline" })
    assert.equal(calls, 3)
    assert.deepEqual(oversized.mandatory, ["unit"])
    assert.equal(oversized.traces[0].outcome, "skipped")
  })
})
