import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"

import { LaneLockModel } from "./formal/lane-lock-model.mjs"
import {
  TRANSITION_ROWS,
  applyTransition,
  classifyTransitionEvent,
  formatTransitionsMermaid,
  getPrimaryTransition,
} from "../src/brain_train/transitions.mjs"

const execFileAsync = promisify(execFile)

describe("lane transition contract", () => {
  it("contains the 20 contract rows, 14 remaining legacy rows, and one system row", () => {
    assert.equal(TRANSITION_ROWS.length, 35)
    assert.deepEqual(
      TRANSITION_ROWS.map((row) => row.id),
      [
        ...Array.from({ length: 20 }, (_, index) => String(index + 1)),
        ...Array.from({ length: 15 }, (_, index) => `L${index + 1}`).filter((id) => id !== "L8"),
        "L16",
      ],
    )
    assert.equal(TRANSITION_ROWS.filter((row) => row.kind === "contract").length, 20)
    assert.equal(TRANSITION_ROWS.filter((row) => row.kind === "legacy").length, 14)
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

  it("rejects owner approval from needs-review", () => {
    assert.throws(
      () => applyTransition(
        { status: "needs-review", owner: "codex", reviewer: "claude" },
        "handoff resolve",
        { to: "ready-for-pr", actor: "codex", prFlowEnabled: true },
      ),
      /No transition row matches/,
    )
  })

  it("cross-checks every modeled action against the hand-authored table", async () => {
    const tla = await fs.readFile(path.resolve("specs/tla/LaneLock.tla"), "utf8")
    const modeledActions = [...tla.matchAll(/^([A-Z][A-Za-z]+)\([^)]*\) ==/gm)]
      .map((match) => match[1])
      .filter((name) => !["Conflicts", "IsOwner", "IsReviewer", "IsLaneAgent", "IsRepairOwner", "NoConflictWithOthers"].includes(name))
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
    assert.equal(rows.length, 35)
    assert.equal(rows[0].action, "Claim")

    const mermaidRun = await execFileAsync("node", [cliPath, "transitions", "--format", "mermaid"])
    assert.match(mermaidRun.stdout, /^stateDiagram-v2/m)
  })
})
