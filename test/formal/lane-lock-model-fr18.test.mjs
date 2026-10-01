// spec 006 FR-18 repair memory in the lane/lock model. These checks run in
// the default suite; the formal harness, which compares the same sequences
// with the real entry points, is opt-in and advisory in CI.
//
// The implementation counts `repair-needed` entries since the most recent
// claim (resolveRepairAssignment and countRepairEntries in core.mjs; spec 015
// Q4 Option A). An entry comes from another status (spec 006 FR-29). It
// escalates to a human when an earlier entry of the same task had the same
// reason. A write while the lane is already `repair-needed` keeps the
// recorded escalation. `btrain repair dispose` accepts only an escalated
// repair, so the model's dispose answer shows the escalation it expects.

import { test } from "node:test"
import assert from "node:assert/strict"

import { LaneLockModel } from "./lane-lock-model.mjs"

function claim(model) {
  return model.claim({ lane: "x", owner: "alpha", reviewer: "beta", files: ["src/a/"] })
}

function repair(reason) {
  return (model) => model.update({ lane: "x", actor: "alpha", status: "repair-needed", reason })
}

function clear(model) {
  return model.update({ lane: "x", actor: "alpha", status: "in-progress" })
}

function resolve(model) {
  return model.resolve({ lane: "x", actor: "alpha", final: false })
}

function needsReview(model) {
  return model.update({ lane: "x", actor: "alpha", status: "needs-review" })
}

function dropRegistry(model) {
  return model.dropRegistry({ lane: "x" })
}

function doctorRepair(model) {
  return model.doctorRepair()
}

// The doctor enters repair-needed (reason lock-mismatch) for a needs-review
// lane whose registry entry is gone.
const doctorEntry = [needsReview, dropRegistry, doctorRepair]

const BOTH = ["contract", "implementation"]
const CASES = [
  {
    name: "a same-reason re-entry escalates",
    modes: BOTH,
    disposes: true,
    steps: [repair("invalid-handoff"), clear, repair("invalid-handoff")],
  },
  {
    name: "a different reason starts its own count",
    modes: BOTH,
    disposes: false,
    steps: [repair("invalid-handoff"), clear, repair("lock-mismatch")],
  },
  {
    name: "a fresh claim resets the count",
    modes: BOTH,
    disposes: false,
    steps: [repair("invalid-handoff"), clear, resolve, claim, repair("invalid-handoff")],
  },
  {
    name: "a doctor entry counts an earlier update entry",
    modes: BOTH,
    disposes: true,
    steps: [repair("lock-mismatch"), clear, ...doctorEntry],
  },
  // Contract mode still counts this write as a re-entry; spec 006 FR-29 does
  // not (see the Known gaps in README.md).
  {
    name: "a write while repair-needed is not an entry",
    modes: ["implementation"],
    disposes: false,
    steps: [repair("invalid-handoff"), repair("invalid-handoff")],
  },
  // Contract mode has no update from repair-needed to needs-review (L3).
  {
    name: "a doctor entry recomputes the escalation",
    modes: ["implementation"],
    disposes: false,
    steps: [repair("invalid-handoff"), clear, repair("invalid-handoff"), ...doctorEntry],
  },
]

for (const { name, modes, disposes, steps } of CASES) {
  for (const mode of modes) {
    test(`FR-18 repair memory: ${name} (${mode} mode)`, () => {
      const model = new LaneLockModel({ lanes: ["x"], agents: ["alpha", "beta", "gamma"], mode })
      for (const [i, step] of [claim, ...steps].entries()) {
        const result = step(model)
        assert.equal(result.ok, true, `step ${i} rejected: ${result.reason}`)
      }
      assert.equal(model.lane("x").status, "repair-needed")
      assert.deepEqual(
        model.dispose({ lane: "x" }),
        disposes ? { ok: true } : { ok: false, reason: "dispose-requires-escalation" },
      )
    })
  }
}
