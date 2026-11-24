// Spec 024 FR-7 and the plan's kind table through src/brain_train/slack/events.mjs
// (plan WS1, T005). Each event has the shape `appendWorkflowEvent` writes:
// `type`, `actor`, `laneId`, `before` and `after` lane snapshots, `details`.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CARD_REFRESH, classifyWorkflowEvent, KIND_TABLE, KINDS } from "../src/brain_train/slack/events.mjs"

const lane = (overrides = {}) => ({
  task: "Change the feature",
  owner: "claude",
  reviewer: "codex-reviewer",
  status: "in-progress",
  reasonCode: "",
  repairOwner: "",
  repairEscalation: "",
  lockedFiles: ["src/feature.mjs"],
  nextAction: "",
  prNumber: "",
  lane: "a",
  lastUpdated: "claude 2026-11-23T21:45:00.123Z",
  ...overrides,
})

function update(before, after, { type = "update", actor = "claude", details } = {}) {
  return {
    version: 1,
    recordedAt: "2026-11-23T21:45:00.123Z",
    type,
    actor,
    laneId: "a",
    handoffPath: "/repo/.claude/collab/HANDOFF_A.md",
    before: lane(before),
    after: lane(after),
    ...(details ? { details } : {}),
  }
}

// One real event shape for every row of the kind table, in table order.
const CASES = [
  ["claimed", update({ status: "resolved", task: "old" }, { status: "in-progress" }, { type: "claim" }), false],
  ["sent-to-review", update({ status: "in-progress" }, { status: "needs-review" }), false],
  ["changes-requested", update({ status: "needs-review" }, { status: "changes-requested", reasonCode: "spec-mismatch" }, { type: "request-changes", actor: "codex-reviewer", details: { summary: "no test for the timeout path" } }), false],
  ["approved", update({ status: "needs-review" }, { status: "ready-for-pr" }, { type: "resolve", actor: "codex-reviewer", details: { summary: "Looks right" } }), false],
  ["approved", update({ status: "needs-review" }, { status: "resolved", lockedFiles: [] }, { type: "resolve", actor: "codex-reviewer" }), false],
  ["pr-linked", update({ status: "ready-for-pr" }, { status: "pr-review", prNumber: "114" }), false],
  ["pr-linked", update({ status: "in-progress" }, { prNumber: "115" }), false],
  ["returned-to-pr", update({ status: "changes-requested", prNumber: "114" }, { status: "pr-review", prNumber: "114" }), false],
  ["ready-to-merge", update({ status: "pr-review", prNumber: "114" }, { status: "ready-to-merge", prNumber: "114" }), true],
  ["merged", update({ status: "ready-to-merge", prNumber: "114" }, { status: "resolved", prNumber: "114", lockedFiles: [] }, { type: "resolve", details: { summary: "PR #114 merged" } }), false],
  ["merged", update({ status: "pr-review", prNumber: "114" }, { status: "resolved", prNumber: "114" }, { type: "resolve" }), false],
  ["merged", update({ status: "changes-requested", prNumber: "114" }, { status: "resolved", prNumber: "114" }, { type: "resolve" }), false],
  ["abandoned", update({ status: "in-progress" }, { status: "resolved", lockedFiles: [] }, { type: "resolve" }), false],
  ["abandoned", update({ status: "changes-requested" }, { status: "resolved" }, { type: "resolve" }), false],
  ["repair-needed", update({ status: "in-progress" }, { status: "repair-needed", reasonCode: "stale-state", repairOwner: "claude", repairEscalation: "" }, { type: "watchdog-repair", actor: "btrain", details: { repairType: "stale-state" } }), false],
  ["repair-needed", update({ status: "in-progress" }, { status: "repair-needed", repairEscalation: "human" }), true],
  ["repair-cleared", update({ status: "repair-needed" }, { status: "in-progress" }), false],
  ["repair-resolved", update({ status: "repair-needed" }, { status: "resolved" }, { type: "resolve" }), false],
  ["repair-disposition", { version: 1, recordedAt: "2026-11-23T21:45:00.123Z", type: "repair-disposition", actor: "brian", laneId: "a", details: { disposition: "terminate" } }, false],
  ["roles-changed", update({ reviewer: "codex-reviewer" }, { reviewer: "claude-reviewer" }), false],
  ["roles-changed", update({ owner: "codex" }, { owner: "claude" }), false],
  ["locks-changed", update({ lockedFiles: ["src/feature.mjs"] }, { lockedFiles: ["src/feature.mjs", "test/feature.test.mjs"] }), false],
  ["override", { version: 1, recordedAt: "2026-11-23T21:45:00.123Z", type: "override-granted", actor: "claude", laneId: "a", details: { overrideId: "ovr_push_x", action: "push", scope: "repo", confirmedBy: "brian", reason: "standing" } }, false],
  ["override", { version: 1, recordedAt: "2026-11-23T21:45:00.123Z", type: "override-consumed", actor: "claude", laneId: "a", details: { overrideId: "ovr_x", action: "needs-review", scope: "lane" } }, false],
  ["watchdog", update({ status: "repair-needed" }, { status: "repair-needed" }, { type: "watchdog-repair", actor: "btrain", details: { repairType: "contradictory-state", message: "no active locks" } }), false],
  ["dispatch-failed", { version: 1, recordedAt: "2026-11-23T21:45:00.123Z", type: "dispatch-failed", actor: "btrain", laneId: "a", after: lane({ status: "needs-review" }), before: lane({ status: "needs-review" }), details: { reviewer: "codex-reviewer" } }, true],
  ["status-changed", update({ status: "in-progress" }, { status: "fix-confirmation" }), false],
  ["status-changed", update({ status: "ready-for-pr" }, { status: "in-progress" }), false],
]

describe("classifyWorkflowEvent: the kind table", () => {
  for (const [kind, event, mention] of CASES) {
    it(`${event.type} ${event.before?.status ?? ""} -> ${event.after?.status ?? ""} is ${kind}`, () => {
      const result = classifyWorkflowEvent(event)
      assert.equal(result.kind, kind)
      assert.equal(result.reply, true, "every named row posts a reply")
      assert.equal(result.mention, mention)
    })
  }

  it("has a case for every row of the table", () => {
    const covered = new Set(CASES.map(([kind]) => kind))
    assert.deepEqual(KIND_TABLE.map((row) => row.kind).filter((kind) => !covered.has(kind)), [])
    assert.deepEqual(KINDS.at(-1), CARD_REFRESH)
  })

  it("lets the first matching row win: a status change with a new reviewer is sent-to-review", () => {
    const result = classifyWorkflowEvent(update({ status: "in-progress", reviewer: "a" }, { status: "needs-review", reviewer: "b" }))
    assert.equal(result.kind, "sent-to-review")
  })

  it("refreshes the card and posts no reply for a metadata-only update", () => {
    for (const event of [
      update({ nextAction: "old" }, { nextAction: "new next action" }),
      update({ task: "old task" }, { task: "new task" }),
      { version: 1, recordedAt: "2026-11-23T21:45:00.123Z", type: "loop-dispatch", actor: "btrain", laneId: "a", details: {} },
      { version: 1, recordedAt: "2026-11-23T21:45:00.123Z", type: "history-compact", actor: "claude", laneId: "a", details: { keep: 3 } },
    ]) {
      const result = classifyWorkflowEvent(event)
      assert.equal(result.kind, CARD_REFRESH, event.type)
      assert.equal(result.reply, false)
      assert.equal(result.mention, false)
    }
  })

  it("names a status the table does not cover as status-changed, so it is never silent", () => {
    const result = classifyWorkflowEvent(update({ status: "needs-review" }, { status: "some-future-status" }))
    assert.equal(result.kind, "status-changed")
    assert.equal(result.fields.fromStatus, "needs-review")
    assert.equal(result.fields.toStatus, "some-future-status")
  })

  it("does not throw on an event with no snapshots or details", () => {
    assert.equal(classifyWorkflowEvent({}).kind, CARD_REFRESH)
    assert.equal(classifyWorkflowEvent(null).kind, CARD_REFRESH)
  })
})

describe("classifyWorkflowEvent: fields", () => {
  it("carries the fields a template needs, from the event", () => {
    const [, event] = CASES[2]
    const { fields } = classifyWorkflowEvent(event)
    assert.equal(fields.actor, "codex-reviewer")
    assert.equal(fields.reasonCode, "spec-mismatch")
    assert.equal(fields.summary, "no test for the timeout path")
    assert.equal(fields.lane, "a")
    assert.equal(fields.lockCount, "1 file")
  })

  it("prepares every field: agent text is escaped, defanged, scrubbed, and the summary is cut", () => {
    const hostile = "<!channel> & https://evil.invalid"
    const event = update({ status: "needs-review" }, { status: "changes-requested", owner: hostile, reviewer: hostile, reasonCode: hostile }, {
      type: "request-changes",
      actor: hostile,
      details: { summary: `${hostile} ${"s".repeat(500)}` },
    })
    const { fields } = classifyWorkflowEvent(event, { summaryChars: 50 })
    for (const [name, value] of Object.entries(fields)) {
      assert.doesNotMatch(value, /[<>]|:\/\//, `${name} is inert: ${value}`)
    }
    assert.equal(fields.actor, "&lt;!channel&gt; &amp; https[:]//evil.invalid")
    assert.ok(Array.from(fields.summary).length < 80, "the summary is cut to summary_chars before escaping")
    assert.ok(fields.summary.endsWith("…"))
  })
})
