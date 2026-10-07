// spec 015 row 19 for a same-status `--status` in the lane/lock model. These
// checks run in the default suite; the formal harness's same-status witnesses
// run the same writes against the real entry points.
//
// classifyTransitionEvent records `handoff update --status X` on a lane that is
// already in X as `handoff update --metadata`: row 19 for a lane agent, L12
// for any other agent. That reading was designated on 2026-10-06 over L4 (a
// literal reading of row 13's CLI source, which excludes `repair-needed`);
// spec 015 keeps identity updates (same status) accepted. Contract mode
// therefore routes the write through the row 19 `metadata` op: status, locks,
// and the repair records stay as they are, so a `repair-needed` re-write is no
// FR-18 entry (spec 006 FR-29). Like patchHandoff, the write still records a
// supplied reason code and PR number.

import { test } from "node:test"
import assert from "node:assert/strict"

import { LaneLockModel } from "./lane-lock-model.mjs"

function accepted(result) {
  assert.deepEqual(result, { ok: true })
}

function claimedModel(mode) {
  const model = new LaneLockModel({ lanes: ["x"], agents: ["alpha", "beta", "gamma"], mode })
  accepted(model.claim({ lane: "x", owner: "alpha", reviewer: "beta", files: ["src/a/"] }))
  return model
}

const toNeedsReview = (model) => model.update({ lane: "x", actor: "alpha", status: "needs-review" })
const approve = (model) => model.resolve({ lane: "x", actor: "beta", final: false })
const linkPr = (model) => model.update({ lane: "x", actor: "alpha", status: "pr-review", pr: "101" })
const clearBots = (model) => model.prOutcome({ lane: "x", outcome: "clear", pr: "101" })

function repair(actor, reason) {
  return (model) => model.update({ lane: "x", actor, status: "repair-needed", reason })
}

// Contract paths from the claim into each modeled update target.
const PATHS = {
  "in-progress": [],
  "needs-review": [toNeedsReview],
  "pr-review": [toNeedsReview, approve, linkPr],
  "ready-to-merge": [toNeedsReview, approve, linkPr, clearBots],
  "repair-needed": [repair("alpha", "invalid-handoff")],
}

// The write as the harness sends it: a reason code only for repair-needed,
// a PR number only for pr-review.
function sameStatusWrite(status, actor) {
  return {
    lane: "x",
    actor,
    status,
    ...(status === "repair-needed" ? { reason: "invalid-handoff" } : {}),
    ...(status === "pr-review" ? { pr: "101" } : {}),
  }
}

for (const [status, steps] of Object.entries(PATHS)) {
  for (const actor of ["alpha", "beta"]) {
    test(`row 19: --status ${status} on a lane already in ${status} only records the actor (${actor}, contract mode)`, () => {
      const model = claimedModel("contract")
      for (const step of steps) accepted(step(model))
      const before = structuredClone(model.lane("x"))
      const registry = model.registryPaths("x")
      accepted(model.update(sameStatusWrite(status, actor)))
      assert.deepEqual(model.lane("x"), { ...before, lastActor: actor })
      assert.deepEqual(model.registryPaths("x"), registry)
    })
  }

  test(`row 19 actor: --status ${status} on a lane already in ${status} is L12 for a third agent (contract mode)`, () => {
    const model = claimedModel("contract")
    for (const step of steps) accepted(step(model))
    const before = structuredClone(model.lane("x"))
    assert.deepEqual(model.update(sameStatusWrite(status, "gamma")), {
      ok: false,
      reason: "metadata-update-requires-lane-agent",
    })
    assert.deepEqual(model.lane("x"), before)
  })

  // The implementation mirror checks no actor: L12 is accepted with a record
  // during the spec 015 FR-5 window.
  test(`row 19 actor: the mirror accepts a third agent's --status ${status} on a lane already in ${status} (implementation mode)`, () => {
    const model = claimedModel("implementation")
    for (const step of steps) accepted(step(model))
    accepted(model.update(sameStatusWrite(status, "gamma")))
    assert.equal(model.lane("x").status, status)
  })
}

// patchHandoff records a --pr on any metadata update (L12 lists it), so a
// pr-review re-write with another PR number relinks the lane.
test("row 19: a pr-review re-write records a supplied PR number (contract mode)", () => {
  const model = claimedModel("contract")
  for (const step of PATHS["pr-review"]) accepted(step(model))
  accepted(model.update({ lane: "x", actor: "alpha", status: "pr-review", pr: "202" }))
  assert.equal(model.lane("x").prNumber, "202")
  assert.equal(model.lane("x").status, "pr-review")
})

// spec 006 FR-7: the reviewer or a third agent declares the repair (row 13
// allows any configured agent), so the owner, the most recent canonical actor
// before the entry, owns it. The owner's re-write with a new reason is no
// entry: the repair owner and the reason memory stay, and only the reason code
// moves. After the owner clears the repair, a lock-mismatch entry is that
// reason's first and does not escalate.
for (const entryActor of ["beta", "gamma"]) {
  test(`row 19: a new-reason repair-needed re-write keeps the repair owner and reason memory (${entryActor}'s entry, contract mode)`, () => {
    const model = claimedModel("contract")
    accepted(repair(entryActor, "invalid-handoff")(model))
    assert.equal(model.lane("x").repairOwner, "alpha")
    accepted(repair("alpha", "lock-mismatch")(model))
    const s = model.lane("x")
    assert.equal(s.reasonCode, "lock-mismatch")
    assert.equal(s.repairOwner, "alpha")
    assert.equal(s.escalationExpected, false)
    assert.deepEqual(s.repairReasonsSeen, ["invalid-handoff"])
    accepted(model.update({ lane: "x", actor: "alpha", status: "in-progress" }))
    accepted(repair("alpha", "lock-mismatch")(model))
    assert.deepEqual(model.dispose({ lane: "x" }), { ok: false, reason: "dispose-requires-escalation" })
  })
}
