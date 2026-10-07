// spec 015 row 17 in the lane/lock model: `btrain doctor --repair` restores
// coverage only when no other lane holds a lock that overlaps the recorded
// set. These checks run in the default suite; the formal harness's doctor
// resync conflict witnesses, which are opt-in and advisory in CI, compare the
// same sequences with the real doctor.
//
// On a conflict the real doctor (applyWatchdogRepairs in core.mjs) catches the
// acquireLocks error, and its integrity check then finds an active lane with
// no locks. It writes watchdog-repair to repair-needed with reason
// lock-mismatch (row 13). From in-progress or changes-requested that is an
// FR-18 entry (resolveRepairAssignment). On a lane already repair-needed it is
// a re-write, not an entry (spec 006 FR-29): the repair owner and any
// disposition stay, and the reason code changes. The runtime also keeps the
// escalation. The contract escalates, because a failed resync is guardian
// intervention that still cannot restore a healthy state (FR-18; designated
// 2026-10-07), so the two modes differ there.

import { test } from "node:test"
import assert from "node:assert/strict"

import { LaneLockModel } from "./lane-lock-model.mjs"

function claimX(model) {
  return model.claim({ lane: "x", owner: "alpha", reviewer: "beta", files: ["src/a/"] })
}

// Lane y takes x's path while x's registry entry is gone.
function claimY(model) {
  return model.claim({ lane: "y", owner: "gamma", reviewer: "alpha", files: ["src/a/"] })
}

function update(actor, status, reason) {
  return (model) => model.update({ lane: "x", actor, status, reason })
}

function requestChanges(model) {
  return model.requestChanges({ lane: "x", actor: "beta" })
}

function dropRegistry(lane) {
  return (model) => model.dropRegistry({ lane })
}

function doctorRepair(model) {
  return model.doctorRepair()
}

function dispose(model) {
  return model.dispose({ lane: "x" })
}

// Row 6 (AbandonResolve): y's owner resolves the unlinked lane and releases
// the path.
function abandonY(model) {
  return model.resolve({ lane: "y", actor: "gamma", final: false })
}

const conflict = [dropRegistry("x"), claimY, doctorRepair]

const CASES = [
  {
    name: "an in-progress lane enters repair-needed",
    steps: conflict,
    x: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "alpha", repairReasonsSeen: ["lock-mismatch"], escalationExpected: false, registry: [] },
    disposeReason: "dispose-requires-escalation",
  },
  {
    name: "a changes-requested lane enters repair-needed",
    steps: [update("alpha", "needs-review"), requestChanges, ...conflict],
    x: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "beta", repairReasonsSeen: ["lock-mismatch"], escalationExpected: false, registry: [] },
    disposeReason: "dispose-requires-escalation",
  },
  {
    name: "the entry counts toward FR-18 like any other",
    steps: [update("alpha", "repair-needed", "lock-mismatch"), update("alpha", "in-progress"), ...conflict],
    x: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "alpha", repairReasonsSeen: ["lock-mismatch"], escalationExpected: true, registry: [] },
    disposeReason: "",
  },
  {
    name: "a repair-needed lane keeps its repair record",
    steps: [
      update("alpha", "needs-review"),
      requestChanges,
      update("alpha", "repair-needed", "invalid-handoff"),
      update("beta", "in-progress"),
      update("alpha", "repair-needed", "invalid-handoff"),
      dispose,
      ...conflict,
    ],
    x: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "beta", repairReasonsSeen: ["invalid-handoff"], escalationExpected: true, registry: [] },
    disposeReason: "dispose-already-recorded",
  },
  {
    // The re-write is no entry, so the runtime keeps the escalation unset.
    // The contract escalates: the guardian could not restore the lane (FR-18).
    name: "a failed resync of a repair-needed lane escalates in contract mode only",
    steps: [update("alpha", "repair-needed", "lock-mismatch"), ...conflict],
    x: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "alpha", repairReasonsSeen: ["lock-mismatch"], escalationExpected: false, registry: [] },
    disposeReason: "dispose-requires-escalation",
    contract: {
      x: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "alpha", repairReasonsSeen: ["lock-mismatch"], escalationExpected: true, registry: [] },
      disposeReason: "",
    },
  },
  {
    name: "a later doctor run restores coverage after the conflict clears",
    steps: [...conflict, abandonY, doctorRepair],
    x: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "alpha", repairReasonsSeen: ["lock-mismatch"], escalationExpected: false, registry: ["src/a/"] },
    y: { status: "resolved", reasonCode: "", repairOwner: "", escalationExpected: false, registry: [] },
    disposeReason: "dispose-requires-escalation",
  },
  {
    // Row 6 abandon of the uncovered lane: a resolved lane is not active, so
    // the doctor neither resyncs nor repairs it.
    name: "a resolved uncovered lane is left alone",
    steps: [dropRegistry("x"), (model) => model.resolve({ lane: "x", actor: "alpha", final: false }), doctorRepair],
    x: { status: "resolved", reasonCode: "", repairOwner: "", repairReasonsSeen: [], escalationExpected: false, registry: [] },
    y: { status: "idle", reasonCode: "", repairOwner: "", escalationExpected: false, registry: [] },
    disposeReason: "dispose-requires-repair-needed",
  },
  {
    // Lane y's FR-7 owner is its claimer, the most recent canonical actor.
    name: "the first resync in a doctor run takes the path",
    steps: [dropRegistry("x"), claimY, dropRegistry("y"), doctorRepair],
    x: { status: "in-progress", reasonCode: "", repairOwner: "", repairReasonsSeen: [], escalationExpected: false, registry: ["src/a/"] },
    y: { status: "repair-needed", reasonCode: "lock-mismatch", repairOwner: "gamma", escalationExpected: false, registry: [] },
    disposeReason: "dispose-requires-repair-needed",
  },
]

const yHoldsPath = { status: "in-progress", reasonCode: "", repairOwner: "", escalationExpected: false, registry: ["src/a/"] }

for (const { name, steps, contract, ...expected } of CASES) {
  for (const mode of ["contract", "implementation"]) {
    const { x, y = yHoldsPath, disposeReason } = mode === "contract" && contract ? { ...expected, ...contract } : expected
    test(`doctor resync conflict: ${name} (${mode} mode)`, () => {
      const model = new LaneLockModel({ lanes: ["x", "y"], agents: ["alpha", "beta", "gamma"], mode })
      for (const [i, step] of [claimX, ...steps].entries()) {
        const result = step(model)
        assert.equal(result.ok, true, `step ${i} rejected: ${result.reason}`)
      }
      const laneX = model.lane("x")
      assert.deepEqual(
        {
          status: laneX.status,
          reasonCode: laneX.reasonCode,
          repairOwner: laneX.repairOwner,
          repairReasonsSeen: laneX.repairReasonsSeen,
          escalationExpected: laneX.escalationExpected,
          registry: model.registryPaths("x"),
        },
        x,
      )
      const laneY = model.lane("y")
      assert.deepEqual(
        {
          status: laneY.status,
          reasonCode: laneY.reasonCode,
          repairOwner: laneY.repairOwner,
          escalationExpected: laneY.escalationExpected,
          registry: model.registryPaths("y"),
        },
        y,
      )
      assert.deepEqual(model.dispose({ lane: "x" }), disposeReason ? { ok: false, reason: disposeReason } : { ok: true })
    })
  }
}
