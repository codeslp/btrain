import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"

import { LaneLockModel } from "./formal/lane-lock-model.mjs"
import {
  TRANSITION_ROWS,
  advisoryRowId,
  applyTransition,
  classifyTransitionEvent,
  formatTransitionsMermaid,
  getPrimaryTransition,
} from "../src/brain_train/transitions.mjs"

const execFileAsync = promisify(execFile)

describe("lane transition contract", () => {
  it("contains the 20 contract rows, 15 legacy rows, and one system row", () => {
    assert.equal(TRANSITION_ROWS.length, 36)
    assert.deepEqual(
      TRANSITION_ROWS.map((row) => row.id),
      [
        ...Array.from({ length: 20 }, (_, index) => String(index + 1)),
        ...Array.from({ length: 15 }, (_, index) => `L${index + 1}`),
        "L16",
      ],
    )
    assert.equal(TRANSITION_ROWS.filter((row) => row.kind === "contract").length, 20)
    assert.equal(TRANSITION_ROWS.filter((row) => row.kind === "legacy").length, 15)
    assert.equal(TRANSITION_ROWS.filter((row) => row.kind === "system").length, 1)
  })

  it("identifies one primary transition for every lane status", () => {
    for (const status of [
      "idle", "in-progress", "needs-review", "changes-requested", "ready-for-pr",
      "pr-review", "ready-to-merge", "repair-needed", "resolved",
    ]) {
      const primary = getPrimaryTransition(status)
      assert.ok(primary, `missing primary transition for ${status}`)
      assert.ok(primary.primary.includes(status), `${primary.id} is not primary for ${status}`)
    }
  })

  it("prefers a contract row over a compatible legacy fallback", () => {
    const result = applyTransition(
      { status: "needs-review", owner: "codex", reviewer: "claude" },
      "handoff resolve",
      { to: "ready-for-pr", actor: "claude", prFlowEnabled: true },
    )

    assert.equal(result.row.id, "4")
    assert.equal(result.next.status, "ready-for-pr")
  })

  it("keeps owner approval on legacy row L8 during its advisory window", () => {
    const result = applyTransition(
      { status: "needs-review", owner: "codex", reviewer: "claude" },
      "handoff resolve",
      { to: "ready-for-pr", actor: "codex", prFlowEnabled: true },
    )

    assert.equal(result.row.id, "L8")
    assert.equal(result.next.status, "ready-for-pr")
  })

  it("cross-checks every modeled action against the hand-authored table", async () => {
    const tla = await fs.readFile(path.resolve("specs/tla/LaneLock.tla"), "utf8")
    const modeledActions = [...tla.matchAll(/^([A-Z][A-Za-z]+)\([^)]*\) ==/gm)]
      .map((match) => match[1])
      // Predicates are not actions. RepairDispose and RepairOverrideGrant are
      // spec 006 FR-29 human records: they change no status, lock, owner, or
      // reviewer, so spec 015 FR-1 gives them no transition row.
      .filter((name) => ![
        "Conflicts", "IsOwner", "IsReviewer", "IsLaneAgent", "IsRepairOwner", "NoConflictWithOthers", "Authors",
        "RepairDispose", "RepairOverrideGrant",
      ].includes(name))
    const tableActions = new Set(TRANSITION_ROWS.map((entry) => entry.action))

    assert.deepEqual(modeledActions.filter((name) => !tableActions.has(name)), [])
  })

  it("cross-checks designated acceptance against the contract model", () => {
    const fixtures = [
      {
        name: "reviewer requests changes",
        state: { status: "needs-review", actor: "claude" },
        event: "handoff request-changes",
        input: { to: "changes-requested", reasonCode: "spec-mismatch" },
        runModel: (model) => model.requestChanges({ lane: "a", actor: "claude" }),
      },
      {
        name: "owner cannot request changes",
        state: { status: "needs-review", actor: "codex" },
        event: "handoff request-changes",
        input: { to: "changes-requested", reasonCode: "spec-mismatch" },
        runModel: (model) => model.requestChanges({ lane: "a", actor: "codex" }),
      },
      {
        name: "reviewer approves for PR flow",
        state: { status: "needs-review", actor: "claude" },
        event: "handoff resolve",
        input: { to: "ready-for-pr", prFlowEnabled: true },
        runModel: (model) => model.resolve({ lane: "a", actor: "claude", final: false }),
      },
      ...[false, true].map((prLinked) => ({
        name: `owner links PR with prLinked=${prLinked}`,
        state: { status: "ready-for-pr", actor: "codex" },
        event: "handoff update --status",
        input: { to: "pr-review", prLinked },
        runModel: (model) => model.update({
          lane: "a",
          actor: "codex",
          status: "pr-review",
          pr: prLinked ? "42" : "",
        }),
      })),
      {
        name: "owner hands off to needs-review (row 2)",
        state: { status: "in-progress", actor: "codex" },
        event: "handoff update --status",
        input: { to: "needs-review" },
        runModel: (model) => model.update({ lane: "a", actor: "codex", status: "needs-review" }),
      },
      {
        name: "reviewer cannot hand off to needs-review (L3 is not designated)",
        state: { status: "in-progress", actor: "claude" },
        event: "handoff update --status",
        input: { to: "needs-review" },
        runModel: (model) => model.update({ lane: "a", actor: "claude", status: "needs-review" }),
      },
      {
        name: "reviewer declares repair-needed (row 13)",
        state: { status: "in-progress", actor: "claude" },
        event: "handoff update --status",
        input: { to: "repair-needed", reasonCode: "invalid-handoff" },
        runModel: (model) => model.update({ lane: "a", actor: "claude", status: "repair-needed", reason: "invalid-handoff" }),
      },
      ...[false, true].map((disposed) => ({
        name: `lane agent resolves repair-needed with disposition=${disposed} (row 15 / L7)`,
        state: { status: "repair-needed", actor: "codex", disposed },
        event: "handoff resolve",
        input: { to: "resolved", prFlowEnabled: true, humanDisposition: disposed },
        runModel: (model) => model.resolve({ lane: "a", actor: "codex", final: false }),
      })),
      ...[false, true].map((prLinked) => ({
        name: `system clears bots with prLinked=${prLinked}`,
        state: { status: "pr-review", actor: "system", prLinked },
        event: "pr-poll",
        input: { to: "ready-to-merge", prLinked },
        runModel: (model) => model.prOutcome({
          lane: "a",
          outcome: "clear",
          pr: prLinked ? "42" : "",
        }),
      })),
    ]

    for (const fixture of fixtures) {
      const model = new LaneLockModel({
        lanes: ["a"],
        agents: ["codex", "claude"],
        prFlowEnabled: true,
        mode: "contract",
      })
      model.adoptReal("a", {
        status: fixture.state.status,
        owner: "codex",
        reviewer: "claude",
        lockedFiles: ["src/"],
        registry: ["src/"],
        prNumber: fixture.state.prLinked ? "42" : "",
      })
      if (fixture.state.prLinked) model.lane("a").prNumber = "42"
      if (fixture.state.disposed) {
        model.lane("a").escalationExpected = true
        model.lane("a").disposition = true
      }
      const modeled = fixture.runModel(model)
      let productionAccepted = false
      try {
        const production = applyTransition(
          { status: fixture.state.status, owner: "codex", reviewer: "claude" },
          fixture.event,
          { actor: fixture.state.actor, ...fixture.input },
        )
        productionAccepted = production.row.state === "designated"
      } catch {
        productionAccepted = false
      }

      assert.equal(
        productionAccepted,
        modeled.ok,
        `${fixture.name} differs`,
      )
    }
  })

  it("rejects unsatisfied data guards instead of selecting designated rows", () => {
    const unlinked = applyTransition(
      { status: "ready-for-pr", owner: "codex", reviewer: "claude" },
      "handoff update --status",
      { to: "pr-review", actor: "codex", prLinked: false },
    )
    assert.equal(unlinked.row.id, "L4")

    assert.throws(
      () => applyTransition(
        { status: "needs-review", owner: "codex", reviewer: "claude" },
        "handoff request-changes",
        { to: "changes-requested", actor: "claude", reasonCode: "" },
      ),
      /No transition row matches/,
    )

    assert.throws(
      () => applyTransition(
        { status: "in-progress", owner: "codex", reviewer: "claude" },
        "locks release-lane",
        { to: "in-progress", actor: "codex", override: null },
      ),
      /No transition row matches/,
    )
  })

  it("preserves legacy request-changes when actor detection is unavailable", () => {
    const result = applyTransition(
      { status: "needs-review", owner: "codex", reviewer: "claude" },
      "handoff request-changes",
      {
        to: "changes-requested",
        actor: "",
        reasonCode: "spec-mismatch",
      },
    )

    assert.equal(result.row.id, "L15")
    assert.equal(result.next.status, "changes-requested")
  })

  it("revalidates lane transitions inside the registry publication lock", async () => {
    const core = await fs.readFile(path.resolve("src/brain_train/core.mjs"), "utf8")
    assert.match(
      core,
      /const publishUpdate = async \(\) => \{\s+const latestCurrent = await readLaneState[\s\S]*?validateStructuralTransition\(latestCurrent\)[\s\S]*?updateHandoff/,
    )
  })

  it("keeps currently accepted undesignated status updates on a legacy row", () => {
    const result = applyTransition(
      { status: "in-progress", owner: "codex", reviewer: "claude" },
      "handoff update --status",
      { to: "ready-to-merge", actor: "codex" },
    )

    assert.equal(result.row.id, "L4")
    assert.equal(result.next.status, "ready-to-merge")
  })

  it("marks every contract row designated and every legacy row advisory after spec 016 WS3 and WS4", () => {
    const byId = new Map(TRANSITION_ROWS.map((row) => [row.id, row]))
    for (const row of TRANSITION_ROWS) {
      if (row.kind === "contract" || row.kind === "system") {
        assert.equal(row.state, "designated", `row ${row.id}`)
      } else {
        assert.equal(row.state, "advisory", `row ${row.id}`)
      }
    }
    assert.equal(byId.get("20").actor, "reassign authority")
    assert.deepEqual(byId.get("8").from, ["pr-review", "ready-to-merge", "changes-requested"])
  })

  it("classifies advisory legacy matches, including the FR-29 repair cases on L4", () => {
    const lane = { status: "in-progress", owner: "codex", reviewer: "claude" }
    const reviewerHandoff = applyTransition(lane, "handoff update --status", { to: "needs-review", actor: "claude" })
    assert.equal(reviewerHandoff.row.id, "L3")
    assert.equal(advisoryRowId(reviewerHandoff.row, lane, { to: "needs-review" }), "L3")

    const repairExit = applyTransition(
      { status: "repair-needed", owner: "codex", reviewer: "claude" },
      "handoff update --status",
      { to: "needs-review", actor: "codex" },
    )
    assert.equal(repairExit.row.kind, "legacy")
    assert.equal(advisoryRowId(repairExit.row, { status: "repair-needed" }, { to: "needs-review" }), "L4")

    const repairEntryFromResolved = applyTransition(
      { status: "resolved", owner: "codex", reviewer: "claude" },
      "handoff update --status",
      { to: "repair-needed", actor: "codex", reasonCode: "invalid-handoff" },
    )
    assert.equal(repairEntryFromResolved.row.id, "L4")
    assert.equal(advisoryRowId(repairEntryFromResolved.row, { status: "resolved" }, { to: "repair-needed" }), "L4")

    const manualReadyToMerge = applyTransition(lane, "handoff update --status", { to: "ready-to-merge", actor: "codex" })
    assert.equal(manualReadyToMerge.row.id, "L4")
    assert.equal(advisoryRowId(manualReadyToMerge.row, lane, { to: "ready-to-merge" }), "L4")

    const plainRepairResolve = applyTransition(
      { status: "repair-needed", owner: "codex", reviewer: "claude" },
      "handoff resolve",
      { to: "resolved", actor: "codex", prFlowEnabled: true },
    )
    assert.equal(plainRepairResolve.row.id, "L7")
    assert.equal(advisoryRowId(plainRepairResolve.row, { status: "repair-needed" }, { to: "resolved" }), "L7")
  })

  it("accepts the FR-29 exits on row 15 with a disposition or an override", () => {
    const repair = { status: "repair-needed", owner: "codex", reviewer: "claude" }
    const disposed = applyTransition(repair, "handoff resolve", { to: "resolved", actor: "claude", humanDisposition: true })
    assert.equal(disposed.row.id, "15")
    const overridden = applyTransition(repair, "handoff resolve", { to: "resolved", actor: "gemini", override: true })
    assert.equal(overridden.row.id, "15")
    const thirdPartyWithoutOverride = applyTransition(repair, "handoff resolve", { to: "resolved", actor: "gemini", humanDisposition: true })
    assert.equal(thirdPartyWithoutOverride.row.id, "L7")
  })

  it("designates the WS4 rows: PR-flow shortcut, non-terminal poll sources, reassignment, resync", () => {
    const linked = { status: "changes-requested", owner: "codex", reviewer: "claude", prNumber: "42" }
    const prFlow = { prLinked: true, prFlowChangesRequested: true }
    assert.equal(applyTransition(linked, "handoff update --status", { to: "pr-review", actor: "codex", ...prFlow }).row.id, "12")
    assert.equal(applyTransition(linked, "handoff update --status", { to: "pr-review", actor: "claude", ...prFlow }).row.id, "L4")
    // A local request-changes withdraws approval: the shortcut falls back to L4.
    assert.equal(applyTransition(linked, "handoff update --status", { to: "pr-review", actor: "codex", prLinked: true, prFlowChangesRequested: false }).row.id, "L4")
    assert.equal(applyTransition(linked, "pr-poll", { to: "pr-review", actor: "system", ...prFlow }).row.id, "8")
    assert.equal(applyTransition(linked, "pr-poll", { to: "ready-to-merge", actor: "system", ...prFlow }).row.id, "10")
    assert.equal(applyTransition(linked, "pr-poll", { to: "pr-review", actor: "system", prLinked: true, prFlowChangesRequested: false }).row.id, "L5")
    assert.equal(applyTransition({ status: "ready-to-merge", owner: "codex", reviewer: "claude" }, "pr-poll", { to: "pr-review", actor: "system", prLinked: true }).row.id, "8")
    assert.equal(applyTransition({ status: "in-progress", owner: "codex", reviewer: "claude" }, "pr-poll", { to: "pr-review", actor: "system", prLinked: true }).row.id, "L5")

    const lane = { status: "in-progress", owner: "codex", reviewer: "claude" }
    assert.equal(applyTransition(lane, "handoff update --reassign", { actor: "codex", ownerChanged: true, distinctReviewer: true }).row.id, "20")
    assert.equal(applyTransition(lane, "handoff update --reassign", { actor: "claude", ownerChanged: true, distinctReviewer: true }).row.id, "L10")
    assert.equal(applyTransition(lane, "handoff update --reassign", { actor: "claude", ownerChanged: false, distinctReviewer: true }).row.id, "20")
    assert.equal(applyTransition(lane, "handoff update --reassign", { actor: "codex", ownerChanged: false, reviewerIsPriorAuthor: true }).row.id, "L10")
    assert.equal(applyTransition({ ...lane, status: "pr-review" }, "handoff update --reassign", { actor: "codex", ownerChanged: false, prLinked: true }).row.id, "L10")

    const review = { status: "needs-review", owner: "codex", reviewer: "claude" }
    assert.equal(applyTransition(review, "handoff update --files", { actor: "codex", filesChanged: false }).row.id, "17")
    assert.equal(applyTransition(review, "doctor repair", { actor: "btrain doctor", systemEvent: true, filesChanged: false }).row.id, "L6")
    assert.equal(applyTransition(lane, "doctor repair", { actor: "btrain doctor", systemEvent: true, filesChanged: false }).row.id, "17")
    assert.equal(applyTransition(review, "handoff update --files", { actor: "claude", filesChanged: false }).row.id, "L6")
    assert.equal(applyTransition(lane, "handoff resolve", { to: "resolved", actor: "claude", prFlowEnabled: true }).row.id, "6")
    assert.equal(applyTransition(lane, "handoff resolve", { to: "resolved", actor: "gemini", prFlowEnabled: true }).row.id, "L11")
    assert.equal(applyTransition({ status: "idle" }, "handoff resolve", { to: "resolved", actor: "codex", prFlowEnabled: true }).row.id, "L2")
    assert.equal(applyTransition({ status: "pr-review", owner: "codex", reviewer: "claude" }, "handoff resolve", { to: "resolved", actor: "codex", prFlowEnabled: true, prLinked: true }).row.id, "L1")
  })

  it("classifies combined updates by the mutation that changes workflow state", () => {
    assert.equal(
      classifyTransitionEvent({ status: "needs-review", reviewer: "claude" }, "in-progress", "needs-review"),
      "handoff update --status",
    )
    assert.equal(
      classifyTransitionEvent({ status: "in-progress", files: "src/" }, "in-progress", "in-progress"),
      "handoff update --files",
    )
    assert.equal(
      classifyTransitionEvent({ reviewer: "claude" }, "in-progress", "in-progress"),
      "handoff update --reassign",
    )
  })

  it("renders a Mermaid graph with stable action labels", () => {
    const mermaid = formatTransitionsMermaid()
    assert.match(mermaid, /^stateDiagram-v2/m)
    assert.match(mermaid, /needs-review --> ready-for-pr: 4 PeerResolve/)
    assert.match(mermaid, /pr-review --> ready-to-merge: 10 PrClear/)
    assert.doesNotMatch(mermaid, /\[\*\] --> \[\*\]: L4 legacy/)
    assert.match(mermaid, /idle --> resolved: L4 legacy/)
  })

  it("prints the transition table through the CLI", async () => {
    const cliPath = path.resolve("src/brain_train/cli.mjs")
    const jsonRun = await execFileAsync("node", [cliPath, "transitions", "--format", "json"])
    const rows = JSON.parse(jsonRun.stdout)
    assert.equal(rows.length, 36)
    assert.equal(rows[0].action, "Claim")

    const mermaidRun = await execFileAsync("node", [cliPath, "transitions", "--format", "mermaid"])
    assert.match(mermaidRun.stdout, /^stateDiagram-v2/m)
  })
})
