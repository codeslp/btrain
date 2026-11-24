// Spec 024 FR-6, FR-7, FR-9, FR-13, FR-15 through src/brain_train/slack/render.mjs
// (plan WS1, T006).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  BOARD_EMPTY_LINE,
  BOARD_FIELDS,
  BOARD_HEADER,
  BOARD_LANE_LINE,
  BOARD_REPO_LINE,
  buildCardFields,
  CARD_FIELDS,
  CARD_LINES,
  kindsWithoutTemplate,
  renderBoard,
  renderCard,
  renderReply,
  REPLY_FIELDS,
  REPLY_TEMPLATES,
  templateFields,
} from "../src/brain_train/slack/render.mjs"
import { buildEventFields, classifyWorkflowEvent, KIND_TABLE } from "../src/brain_train/slack/events.mjs"

// Fake values, built at runtime so the source holds no string that matches a
// secret pattern.
const GITHUB_PAT = ["github", "pat", "1".repeat(22), "2".repeat(59)].join("_")
const WEBHOOK_PATH = ["hooks.slack.com", "services", "T0000FAKE", "B0000FAKE", "4".repeat(24)].join("/")
const HOSTILE = `<!channel> <@U0000FAKE> & <https://evil.invalid|x> https://${WEBHOOK_PATH} ${GITHUB_PAT}`

function assertInert(text, where) {
  assert.doesNotMatch(text, /[<>]/, `${where}: no raw angle bracket`)
  assert.doesNotMatch(text, /:\/\//, `${where}: no scheme separator`)
  assert.ok(!text.includes(WEBHOOK_PATH), `${where}: the webhook is redacted`)
  assert.ok(!text.includes("1".repeat(22)), `${where}: the token is redacted`)
}

const LANE = {
  lane: "e",
  task: "Draft spec 023: cross-lab review routing with a 15-minute fallback",
  owner: "claude",
  reviewer: "codex-reviewer",
  status: "needs-review",
  prNumber: "",
  lockedFiles: ["specs/023.md", "specs/024.md"],
  lastUpdated: "claude 2026-11-23T18:42:07.000Z",
}
const CONTEXT = { repoName: "btrain", label: "brian", mention: [], channel: "C0000FAKE" }

describe("templates are data and use only prepared fields", () => {
  it("names only card fields in the card", () => {
    for (const line of CARD_LINES) {
      for (const name of templateFields(line)) assert.ok(CARD_FIELDS.includes(name), `${line}: {${name}}`)
    }
    assert.deepEqual(Object.keys(buildCardFields(LANE, CONTEXT)).sort(), [...CARD_FIELDS].sort())
  })

  it("names only fields events.mjs prepares in every reply template", () => {
    const prepared = Object.keys(buildEventFields({ type: "update", before: {}, after: {} })).sort()
    assert.deepEqual([...REPLY_FIELDS].sort(), prepared)
    for (const [kind, template] of Object.entries(REPLY_TEMPLATES)) {
      for (const name of templateFields(template)) assert.ok(REPLY_FIELDS.includes(name), `${kind}: {${name}}`)
    }
  })

  it("names only board fields in the board", () => {
    for (const line of [BOARD_HEADER, BOARD_REPO_LINE, BOARD_LANE_LINE, BOARD_EMPTY_LINE]) {
      for (const name of templateFields(line)) assert.ok(BOARD_FIELDS.includes(name), `${line}: {${name}}`)
    }
  })

  it("has one reply template for every kind and none for a kind that does not exist", () => {
    assert.deepEqual(kindsWithoutTemplate(), [])
    assert.deepEqual(Object.keys(REPLY_TEMPLATES).sort(), KIND_TABLE.map((row) => row.kind).sort())
  })

  it("writes no markup of its own in any template", () => {
    for (const template of [...CARD_LINES, ...Object.values(REPLY_TEMPLATES), BOARD_HEADER, BOARD_REPO_LINE, BOARD_LANE_LINE]) {
      assert.doesNotMatch(template, /[<>&]|:\/\//, template)
    }
  })
})

describe("renderCard", () => {
  it("renders the fields in the FR-6 order with the FR-13 labels", () => {
    assert.equal(renderCard({ ...LANE, display: "in-review", reviewTier: "other-lab" }, CONTEXT), [
      "btrain · lane e · in-review",
      "dev: brian",
      "task: Draft spec 023: cross-lab review routing with a 15-minute fallback",
      "owner: claude    reviewer: codex-reviewer (other-lab)",
      "pr: none    locks: 2 files",
      "updated: 2026-11-23 18:42 UTC",
    ].join("\n"))
  })

  it("shows the stored status when there is no display state, and a PR number", () => {
    const card = renderCard({ ...LANE, prNumber: "114", lockedFiles: ["a"] }, CONTEXT)
    assert.match(card, /^btrain · lane e · needs-review$/m)
    assert.match(card, /^pr: #114 {4}locks: 1 file$/m)
  })

  it("cuts the task to task_chars", () => {
    const card = renderCard({ ...LANE, task: "t".repeat(1000) }, { ...CONTEXT, taskChars: 20 })
    assert.match(card, /^task: t{19}…$/m)
  })

  it("is inert and redacted for hostile text in every lane field and in the context", () => {
    const hostileLane = { lane: HOSTILE, task: HOSTILE, owner: HOSTILE, reviewer: HOSTILE, status: HOSTILE, prNumber: HOSTILE, lastUpdated: HOSTILE, reviewTier: HOSTILE, lockedFiles: [] }
    const card = renderCard(hostileLane, { repoName: HOSTILE, label: HOSTILE, mention: ["U0000FAKE"] })
    assertInert(card, "card")
    assert.match(card, /&amp;/)
    assert.match(card, /\[redacted\]/)
  })

  it("stays at most 3,999 characters with maximum-length fields", () => {
    const big = "<&>".repeat(5000)
    const card = renderCard({ lane: big, task: big, owner: big, reviewer: big, status: big, prNumber: big }, { repoName: big, label: big, taskChars: 5000 })
    assert.ok(Array.from(card).length <= 3999)
    assertInert(card, "card")
  })
})

describe("renderReply", () => {
  const event = (before, after, extra = {}) => ({ type: "update", actor: "claude", laneId: "e", before: { ...LANE, ...before }, after: { ...LANE, ...after }, ...extra })

  it("renders the spec's reply lines", () => {
    const cases = [
      [{ ...event({}, {}), type: "claim" }, "claude claimed lane e"],
      [event({ status: "in-progress" }, { status: "needs-review" }), "sent to review · reviewer codex-reviewer"],
      [event({ status: "needs-review" }, { status: "changes-requested", reasonCode: "missing-verification" }, { type: "request-changes", actor: "codex-reviewer", details: { summary: "no test for the timeout path" } }),
        "codex-reviewer requested changes · missing-verification · \"no test for the timeout path\""],
      [event({ status: "needs-review" }, { status: "ready-for-pr" }), "approved · ready for PR"],
      [event({ status: "ready-for-pr" }, { status: "pr-review", prNumber: "114" }), "PR #114 linked"],
      [event({ status: "pr-review", prNumber: "114" }, { status: "ready-to-merge", prNumber: "114" }), "PR #114 clear · ready to merge"],
      [event({ status: "ready-to-merge", prNumber: "114" }, { status: "resolved", prNumber: "114" }), "merged · lane resolved"],
      [event({ status: "in-progress" }, { status: "x-new" }), "status in-progress → x-new"],
    ]
    for (const [input, expected] of cases) {
      assert.equal(renderReply(classifyWorkflowEvent(input), CONTEXT), expected)
    }
  })

  it("drops a segment whose fields are all empty", () => {
    const classified = classifyWorkflowEvent(event({ status: "needs-review" }, { status: "changes-requested", reasonCode: "" }, { type: "request-changes", details: {} }))
    assert.equal(renderReply(classified, CONTEXT), "claude requested changes")
  })

  it("renders nothing for a card refresh", () => {
    assert.equal(renderReply(classifyWorkflowEvent(event({ nextAction: "a" }, { nextAction: "b" })), CONTEXT), "")
    assert.equal(renderReply(null, CONTEXT), "")
    assert.equal(renderReply({ kind: "no-such-kind", fields: {} }, CONTEXT), "")
  })

  it("mentions the configured IDs only when the kind decided a mention, and only well-formed IDs", () => {
    const ready = classifyWorkflowEvent(event({ status: "pr-review", prNumber: "114" }, { status: "ready-to-merge", prNumber: "114" }))
    const prUrl = "https://github.com/example-owner/example-repo/pull/114"
    assert.equal(
      renderReply(ready, { ...CONTEXT, mention: ["U0000FAKE", "<!channel>", "not-an-id"], prUrl }),
      "<@U0000FAKE> PR #114 clear · ready to merge · <https://github.com/example-owner/example-repo/pull/114|PR #114>",
    )
    const merged = classifyWorkflowEvent(event({ status: "ready-to-merge", prNumber: "114" }, { status: "resolved", prNumber: "114" }))
    assert.equal(renderReply(merged, { ...CONTEXT, mention: ["U0000FAKE"], prUrl }), "merged · lane resolved", "merged has neither a mention nor a link")
  })

  it("writes the PR link only for a GitHub pull request URL", () => {
    const ready = classifyWorkflowEvent(event({ status: "pr-review", prNumber: "1" }, { status: "ready-to-merge", prNumber: "1" }))
    for (const prUrl of [
      "https://evil.invalid/x/y/pull/1",
      "https://github.com/a/b/pull/1|click",
      "https://github.com/a/b/pull/1>",
      "http://github.com/a/b/pull/1",
      "javascript:alert(1)",
    ]) {
      assert.equal(renderReply(ready, { ...CONTEXT, prUrl }), "PR #1 clear · ready to merge", prUrl)
    }
  })

  it("is inert for hostile text in every reply of every kind", () => {
    const hostileLane = { ...LANE, owner: HOSTILE, reviewer: HOSTILE, reasonCode: HOSTILE, repairOwner: HOSTILE, prNumber: HOSTILE }
    const shapes = [
      { type: "claim", before: { status: "resolved" }, after: { status: "in-progress" } },
      ...["needs-review", "changes-requested", "ready-for-pr", "pr-review", "ready-to-merge", "resolved", "repair-needed", "in-progress", "zzz"].flatMap((to) =>
        ["in-progress", "needs-review", "changes-requested", "pr-review", "ready-to-merge", "repair-needed"].map((from) => ({ type: "update", before: { status: from }, after: { status: to } }))),
      { type: "repair-disposition", details: { disposition: HOSTILE } },
      { type: "override-granted", details: { action: HOSTILE } },
      { type: "watchdog-repair", details: { repairType: HOSTILE } },
      { type: "dispatch-failed" },
    ]
    const seen = new Set()
    for (const shape of shapes) {
      const classified = classifyWorkflowEvent({
        type: shape.type,
        actor: HOSTILE,
        laneId: HOSTILE,
        before: { ...hostileLane, ...shape.before },
        after: { ...hostileLane, ...shape.after },
        details: { summary: HOSTILE, ...shape.details },
      })
      seen.add(classified.kind)
      assertInert(renderReply(classified, { ...CONTEXT, mention: [], prUrl: "" }), classified.kind)
    }
    assert.ok(seen.size >= 15, `covered ${[...seen].join(", ")}`)
  })
})

describe("renderBoard", () => {
  it("groups active lanes by repository and skips idle and resolved lanes", () => {
    const board = renderBoard([
      { repoName: "btrain", lanes: [{ ...LANE, display: "in-review", prNumber: "114" }, { lane: "f", status: "resolved" }, { lane: "g", status: "idle" }] },
      { repoName: "shop-web", lanes: [{ lane: "a", status: "in-progress", owner: "codex", reviewer: "" }] },
      { repoName: "shop-api", lanes: [], stale: true },
    ], { label: "brian" })
    assert.equal(board, [
      "board · dev: brian",
      "btrain",
      "  lane e · in-review · owner: claude · reviewer: codex-reviewer · pr: #114",
      "shop-web",
      "  lane a · in-progress · owner: codex · reviewer: none · pr: none",
      "shop-api (not refreshed)",
      "  no active lanes",
    ].join("\n"))
  })

  it("is inert for hostile repository names and lane fields", () => {
    const board = renderBoard([{ repoName: HOSTILE, lanes: [{ lane: HOSTILE, status: HOSTILE, owner: HOSTILE, reviewer: HOSTILE, prNumber: HOSTILE }] }], { label: HOSTILE })
    assertInert(board, "board")
  })
})
