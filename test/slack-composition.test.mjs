// Spec 024 WS4 (T021): one lane task from claim to merge through the real CLI
// in a temporary repository, with the fake Slack preload. The lane gets one
// card, every step a reply in its thread, the ready-to-merge reply a mention
// and the PR link, and the developer's board is posted and pinned once. No
// test calls Slack or GitHub.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { CHANNEL, claimArgs, createSlackRepo, needsReviewArgs, OPERATOR, outboxFiles } from "./helpers/slack-cli-repo.mjs"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("spec 024 composition: claim to merge", () => {
  it("posts one card, a reply per step in its thread, and one pinned board", async () => {
    const fixture = await createSlackRepo({ prFlow: true, remote: "https://github.com/example-owner/example-repo.git", roots })
    // Each command's 2-second budget sends about two messages (one a second
    // per channel); a flush sends what it leaves. The board is first posted
    // only while a lane is active, so one flush runs right after the claim.
    const steps = [
      { args: claimArgs() },
      { args: ["slack", "flush"] },
      { args: needsReviewArgs() },
      { args: ["handoff", "request-changes", "--lane", "a", "--summary", "Add a test", "--reason-code", "spec-mismatch", "--actor", "codex"], agent: "codex" },
      { args: needsReviewArgs() },
      { args: ["handoff", "resolve", "--lane", "a", "--summary", "Looks good", "--actor", "codex"], agent: "codex" },
      { args: ["handoff", "update", "--lane", "a", "--pr", "7", "--actor", "claude"] },
      { args: ["handoff", "update", "--lane", "a", "--status", "pr-review", "--actor", "claude"] },
      { args: ["handoff", "update", "--lane", "a", "--status", "ready-to-merge", "--actor", "claude"] },
      { args: ["handoff", "resolve", "--lane", "a", "--summary", "Merged", "--actor", "claude"] },
    ]
    for (const { args, agent } of steps) {
      const result = await fixture.btrain(args, { agent })
      assert.equal(result.code, 0, `${args.join(" ")}\n${result.stderr}`)
    }
    const flush = await fixture.btrain(["slack", "flush"])
    assert.equal(flush.code, 0, flush.stderr)

    const calls = fixture.calls()
    assert.deepEqual(fixture.refusals(), [], "no request went anywhere but the fake")
    assert.ok(calls.every((call) => call.result?.ok !== false), "every call succeeded")
    assert.ok(calls.every((call) => call.body.channel === CHANNEL), "every call goes to the mapped channel")
    assert.deepEqual(await outboxFiles(fixture), [], "nothing is left queued")

    const topLevel = calls.filter((call) => call.method === "chat.postMessage" && !call.body.thread_ts)
    const board = topLevel.filter((call) => /^board · dev: test-dev/.test(call.body.text))
    const cards = topLevel.filter((call) => !board.includes(call))
    assert.equal(cards.length, 1, "one card for the lane task")
    assert.equal(board.length, 1, "one board for the developer")
    assert.equal(calls.filter((call) => call.method === "pins.add").length, 1, "the board is pinned once")
    const lastBoard = calls.filter((call) => call.method === "chat.update" && call.body.ts === board[0].result.ts).at(-1)
    assert.match(lastBoard?.body.text || "", /no active lanes/, "the board ends with no active lane")

    const cardTs = cards[0].result.ts
    const replies = calls.filter((call) => call.method === "chat.postMessage" && call.body.thread_ts)
    assert.ok(replies.every((call) => call.body.thread_ts === cardTs), "every reply is in the card's thread")
    const lines = replies.map((call) => call.body.text.replace(/^.*?· dev: test-dev · /, ""))
    const expected = [
      /^claude claimed lane a$/,
      /^sent to review · reviewer codex$/,
      /^codex requested changes · spec-mismatch · "Add a test"$/,
      /^sent to review · reviewer codex$/,
      /^approved · ready for PR$/,
      /^PR #7 linked$/,
      /^status ready-for-pr → pr-review$/,
      /PR #7 clear · ready to merge · <https:\/\/github\.com\/example-owner\/example-repo\/pull\/7\|PR #7>$/,
      /^merged · lane resolved$/,
    ]
    assert.equal(lines.length, expected.length, JSON.stringify(lines, null, 2))
    expected.forEach((pattern, index) => assert.match(lines[index], pattern, `reply ${index + 1}`))

    const mentions = replies.filter((call) => call.body.text.includes(`<@${OPERATOR}>`))
    assert.equal(mentions.length, 1, "only ready-to-merge mentions the operator")
    assert.match(mentions[0].body.text, /ready to merge/)
    assert.ok(replies.every((call) => call.body.unfurl_links === false && call.body.link_names === undefined))

    const lastCard = calls.filter((call) => call.method === "chat.update" && call.body.ts === cardTs).at(-1)
    assert.ok(lastCard, "the card is updated in place")
    assert.match(lastCard.body.text, /resolved/, "the card ends at the lane's current status")
  })
})
