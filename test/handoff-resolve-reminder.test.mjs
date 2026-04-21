import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildAssignedWorkReminderLines,
  resolveReminderActor,
} from "../src/brain_train/cli.mjs"

function makeLane({ id, status, task = "", owner = "", reviewer = "" }) {
  return {
    _laneId: id,
    status,
    task,
    owner,
    reviewer,
  }
}

function makeResult(lanes) {
  return { lanes }
}

describe("resolveReminderActor", () => {
  it("prefers an explicit --actor value when provided", () => {
    const result = { agentCheck: { status: "verified", agentName: "codex" } }
    assert.equal(resolveReminderActor({ actor: "claude" }, result), "claude")
  })

  it("trims whitespace on an explicit --actor", () => {
    const result = { agentCheck: { status: "verified", agentName: "codex" } }
    assert.equal(resolveReminderActor({ actor: "  claude  " }, result), "claude")
  })

  it("falls back to result.agentCheck.agentName when --actor is absent", () => {
    const result = { agentCheck: { status: "verified", agentName: "claude" } }
    assert.equal(resolveReminderActor({}, result), "claude")
    assert.equal(resolveReminderActor(undefined, result), "claude")
  })

  it("returns '' when neither --actor nor agentCheck can supply a name", () => {
    assert.equal(
      resolveReminderActor({}, { agentCheck: { status: "ambiguous", agentName: "" } }),
      "",
    )
    assert.equal(resolveReminderActor({}, { agentCheck: null }), "")
    assert.equal(resolveReminderActor({}, {}), "")
    assert.equal(resolveReminderActor({}, undefined), "")
  })

  it("treats an explicit --actor of whitespace-only as empty and falls back", () => {
    const result = { agentCheck: { status: "verified", agentName: "claude" } }
    assert.equal(resolveReminderActor({ actor: "   " }, result), "claude")
  })
})

describe("buildAssignedWorkReminderLines", () => {
  it("returns [] when actor is empty or missing", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "in-progress", task: "Work", owner: "claude", reviewer: "codex" }),
    ])
    assert.deepEqual(buildAssignedWorkReminderLines(result, ""), [])
    assert.deepEqual(buildAssignedWorkReminderLines(result, null), [])
    assert.deepEqual(buildAssignedWorkReminderLines(result, undefined), [])
  })

  it("returns [] in single-lane mode (no result.lanes)", () => {
    const result = { current: { status: "resolved", owner: "claude" } }
    assert.deepEqual(buildAssignedWorkReminderLines(result, "claude"), [])
  })

  it("returns [] when the actor has no other non-resolved lanes", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Old work", owner: "claude", reviewer: "codex" }),
      makeLane({ id: "b", status: "resolved", task: "Other", owner: "codex", reviewer: "claude" }),
    ])
    assert.deepEqual(buildAssignedWorkReminderLines(result, "claude"), [])
  })

  it("lists a lane where actor is owner and status is in-progress", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Just resolved", owner: "claude", reviewer: "codex" }),
      makeLane({ id: "b", status: "in-progress", task: "My next task", owner: "claude", reviewer: "codex" }),
    ])
    const lines = buildAssignedWorkReminderLines(result, "claude")
    assert.ok(lines.length >= 2, "expect a header and at least one bullet")
    const joined = lines.join("\n")
    assert.match(joined, /reminder.*claude.*1.*other lane/i)
    assert.match(joined, /lane b/)
    assert.match(joined, /in-progress/)
    assert.match(joined, /My next task/)
    assert.match(joined, /owner/)
  })

  it("lists a lane where actor is reviewer and status is needs-review", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Done", owner: "claude", reviewer: "codex" }),
      makeLane({
        id: "b",
        status: "needs-review",
        task: "Awaiting my review",
        owner: "codex",
        reviewer: "claude",
      }),
    ])
    const lines = buildAssignedWorkReminderLines(result, "claude")
    const joined = lines.join("\n")
    assert.match(joined, /lane b/)
    assert.match(joined, /needs-review/)
    assert.match(joined, /Awaiting my review/)
    assert.match(joined, /reviewer/)
  })

  it("ignores lanes where actor is neither owner nor reviewer", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Done", owner: "claude", reviewer: "codex" }),
      makeLane({
        id: "b",
        status: "in-progress",
        task: "Not mine",
        owner: "codex",
        reviewer: "gemini",
      }),
    ])
    assert.deepEqual(buildAssignedWorkReminderLines(result, "claude"), [])
  })

  it("flags role as 'owner+reviewer' when actor is both on the same lane", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Done", owner: "claude", reviewer: "codex" }),
      makeLane({
        id: "b",
        status: "in-progress",
        task: "Solo lane",
        owner: "claude",
        reviewer: "claude",
      }),
    ])
    const lines = buildAssignedWorkReminderLines(result, "claude")
    const joined = lines.join("\n")
    assert.match(joined, /owner\+reviewer/)
  })

  it("matches actor name case-insensitively and trims whitespace", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Done", owner: "Claude", reviewer: "codex" }),
      makeLane({
        id: "b",
        status: "needs-review",
        task: "Review due",
        owner: "codex",
        reviewer: "Claude",
      }),
    ])
    const lines = buildAssignedWorkReminderLines(result, "  claude  ")
    const joined = lines.join("\n")
    assert.match(joined, /lane b/)
    assert.match(joined, /reviewer/)
  })

  it("lists multiple matching lanes sorted by lane id", () => {
    const result = makeResult([
      makeLane({ id: "c", status: "needs-review", task: "Review", owner: "codex", reviewer: "claude" }),
      makeLane({ id: "a", status: "resolved", task: "Done", owner: "claude", reviewer: "codex" }),
      makeLane({ id: "b", status: "in-progress", task: "Writing", owner: "claude", reviewer: "codex" }),
    ])
    const lines = buildAssignedWorkReminderLines(result, "claude")
    const header = lines[0]
    assert.match(header, /2.*other lanes/i, "header should count 2 other lanes")
    // Verify order: b comes before c
    const joined = lines.join("\n")
    const indexB = joined.indexOf("lane b")
    const indexC = joined.indexOf("lane c")
    assert.ok(indexB > 0 && indexC > indexB, "lane b should appear before lane c")
  })

  it("ignores every 'resolved' lane regardless of actor role", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Old", owner: "claude", reviewer: "codex" }),
      makeLane({ id: "b", status: "resolved", task: "Older", owner: "claude", reviewer: "claude" }),
      makeLane({ id: "c", status: "resolved", task: "Oldest", owner: "codex", reviewer: "claude" }),
    ])
    assert.deepEqual(buildAssignedWorkReminderLines(result, "claude"), [])
  })

  it("includes lanes in changes-requested and repair-needed states", () => {
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Done", owner: "claude", reviewer: "codex" }),
      makeLane({
        id: "b",
        status: "changes-requested",
        task: "Fix requested",
        owner: "claude",
        reviewer: "codex",
      }),
      makeLane({
        id: "c",
        status: "repair-needed",
        task: "Repair",
        owner: "codex",
        reviewer: "claude",
      }),
    ])
    const lines = buildAssignedWorkReminderLines(result, "claude")
    const joined = lines.join("\n")
    assert.match(joined, /lane b/)
    assert.match(joined, /changes-requested/)
    assert.match(joined, /lane c/)
    assert.match(joined, /repair-needed/)
  })

  it("fires the reminder when actor is inferred from agentCheck (no --actor flag)", () => {
    // Simulating the post-resolve path: options.actor is absent, but
    // result.agentCheck.agentName was verified from BTRAIN_AGENT or runtime hints.
    const options = {}
    const result = {
      agentCheck: { status: "verified", agentName: "claude" },
      lanes: [
        makeLane({ id: "a", status: "resolved", task: "Just closed", owner: "claude", reviewer: "codex" }),
        makeLane({
          id: "b",
          status: "in-progress",
          task: "Still writing",
          owner: "claude",
          reviewer: "codex",
        }),
      ],
    }
    const inferredActor = resolveReminderActor(options, result)
    assert.equal(inferredActor, "claude")
    const lines = buildAssignedWorkReminderLines(result, inferredActor)
    assert.ok(lines.length >= 2, "reminder should fire when actor is inferred")
    assert.match(lines.join("\n"), /lane b/)
  })

  it("truncates long tasks but preserves lane metadata", () => {
    const longTask = "x".repeat(500)
    const result = makeResult([
      makeLane({ id: "a", status: "resolved", task: "Done", owner: "claude", reviewer: "codex" }),
      makeLane({
        id: "b",
        status: "in-progress",
        task: longTask,
        owner: "claude",
        reviewer: "codex",
      }),
    ])
    const lines = buildAssignedWorkReminderLines(result, "claude")
    const joined = lines.join("\n")
    assert.match(joined, /lane b/)
    assert.ok(
      joined.length < 1200,
      `reminder output should stay compact, got ${joined.length} chars`,
    )
  })
})
