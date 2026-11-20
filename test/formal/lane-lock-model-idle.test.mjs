// spec 015 FR-5 enforcement of the idle-lane legacy paths (2026-10-13) in
// the lane/lock model. These checks run in the default suite; the formal
// harness's idle-lane witnesses run the same writes against the real entry
// points.
//
// An idle lane was never claimed: it has no owner, no reviewer, and no
// locks. Spec 002 (Resolve, update, and claim authority) rejects resolving
// it (L2); spec 014's rescope designation applies to an active lane only
// (the idle source of L6); spec 005 FR-5 reassigns only in-progress,
// needs-review, or changes-requested lanes (the idle source of L10). The
// implementation now rejects all three in the transition gate, so the mirror
// rejects them in both modes, with reasons outside the harness's candidate
// map: a reappearance is an unknown divergence, not a tally.

import { test } from "node:test"
import assert from "node:assert/strict"

import { LaneLockModel } from "./lane-lock-model.mjs"

function idleModel(mode) {
  const model = new LaneLockModel({ lanes: ["x", "y"], agents: ["alpha", "beta", "gamma"], prFlowEnabled: true, mode })
  for (const lane of ["x", "y"]) model.lane(lane).fileExists = true
  return model
}

function idleSnapshot(model, lane = "x") {
  const s = model.snapshot()[lane]
  return { status: s.status, owner: s.owner, reviewer: s.reviewer, lockedFiles: s.lockedFiles, registry: s.registry }
}

for (const mode of ["contract", "implementation"]) {
  test(`idle lane: resolve, rescope, and reassign are rejected and change nothing (${mode} mode)`, () => {
    const model = idleModel(mode)
    const before = idleSnapshot(model)
    assert.equal(before.status, "idle")

    for (const actor of ["alpha", "beta", "gamma", ""]) {
      for (const final of [false, true]) {
        assert.deepEqual(model.resolve({ lane: "x", actor, final }), { ok: false, reason: "resolve-from-idle" })
      }
      assert.deepEqual(model.rescope({ lane: "x", actor, files: ["src/a/"] }), { ok: false, reason: "rescope-from-idle" })
      assert.deepEqual(model.rescope({ lane: "x", actor, files: [] }), { ok: false, reason: "rescope-from-idle" })
      assert.deepEqual(model.reassign({ lane: "x", actor, owner: "alpha" }), { ok: false, reason: "reassign-from-idle" })
      assert.deepEqual(model.reassign({ lane: "x", actor, reviewer: "beta" }), { ok: false, reason: "reassign-from-idle" })
      assert.deepEqual(model.reassign({ lane: "x", actor, owner: "alpha", reviewer: "beta" }), { ok: false, reason: "reassign-from-idle" })
    }
    assert.deepEqual(idleSnapshot(model), before, "a rejected write leaves the idle lane untouched")
    assert.deepEqual(model.invariantViolations(new Set()), [])

    // The lane is still claimable afterwards, and the other lane is unaffected.
    assert.deepEqual(model.claim({ lane: "x", owner: "alpha", reviewer: "beta", files: ["src/a/"] }), { ok: true })
    assert.equal(idleSnapshot(model).status, "in-progress")
    assert.equal(idleSnapshot(model, "y").status, "idle")
  })

  test(`idle lane: a metadata-only update is still row 19 territory, not an idle rejection (${mode} mode)`, () => {
    const model = idleModel(mode)
    const result = model.metadata({ lane: "x", actor: "alpha" })
    if (mode === "implementation") {
      assert.deepEqual(result, { ok: true })
    } else {
      // No lane agent exists on an idle lane, so every actor is L12 in
      // contract mode (a candidate label during the FR-5 window).
      assert.deepEqual(result, { ok: false, reason: "metadata-update-requires-lane-agent" })
    }
    assert.equal(idleSnapshot(model).status, "idle")
  })
}

// The active-status slices of L6 and L10 are untouched by the idle
// retirement: contract mode keeps its existing reasons for them, and the
// implementation mirror still accepts them (they stay advisory).
test("active lanes: the non-idle L6 and L10 slices keep their existing modeling", () => {
  for (const mode of ["contract", "implementation"]) {
    const model = idleModel(mode)
    assert.deepEqual(model.claim({ lane: "x", owner: "alpha", reviewer: "beta", files: ["src/a/"] }), { ok: true })
    assert.deepEqual(model.update({ lane: "x", actor: "alpha", status: "needs-review" }), { ok: true })
    const rescope = model.rescope({ lane: "x", actor: "alpha", files: ["src/b/"] })
    const reassign = model.reassign({ lane: "x", actor: "gamma", reviewer: "gamma" })
    if (mode === "contract") {
      assert.deepEqual(rescope, { ok: false, reason: "rescope-from-invalid-status" })
      assert.deepEqual(reassign, { ok: false, reason: "reassign-requires-lane-agent" })
    } else {
      assert.deepEqual(rescope, { ok: true })
      assert.deepEqual(reassign, { ok: true })
    }
  }
})
