import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"

import {
  TRANSITION_ROWS,
  applyTransition,
  classifyTransitionEvent,
  formatTransitionsMermaid,
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

  it("prefers a contract row over a compatible legacy fallback", () => {
    const result = applyTransition(
      { status: "needs-review", owner: "codex", reviewer: "claude" },
      "handoff resolve",
      { to: "ready-for-pr", actor: "claude", prFlowEnabled: true },
    )

    assert.equal(result.row.id, "4")
    assert.equal(result.next.status, "ready-for-pr")
  })

  it("cross-checks every modeled action against the hand-authored table", async () => {
    const tla = await fs.readFile(path.resolve("specs/tla/LaneLock.tla"), "utf8")
    const modeledActions = [...tla.matchAll(/^([A-Z][A-Za-z]+)\([^)]*\) ==/gm)]
      .map((match) => match[1])
      .filter((name) => !["Conflicts", "IsOwner", "IsReviewer", "IsLaneAgent", "IsRepairOwner", "NoConflictWithOthers"].includes(name))
    const tableActions = new Set(TRANSITION_ROWS.map((entry) => entry.action))

    assert.deepEqual(modeledActions.filter((name) => !tableActions.has(name)), [])
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
