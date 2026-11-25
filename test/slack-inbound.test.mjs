// Spec 025 FR-5, FR-6, FR-13 and the plan's "Which messages are heard"
// through src/brain_train/slack/inbound.mjs (plan WS1, T006).
//
// The messages are synthetic, built from the field rules the plan gives
// ("Slack contract": a typed message has `user` and `client_msg_id`, one an
// app posted for the operator has `user` and `app_id`, a bot's has `bot_id`
// and `app_id`). The cases built on real captured bodies (spec 025 T003) are
// skipped until those fixtures exist.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { classifyInbound, HEARD } from "../src/brain_train/slack/inbound.mjs"

const OPERATOR = "U0000OPER"
const OTHER = "U0000OTHR"
const BOT = "U0000FAKE"
const typed = (extra = {}) => ({ type: "message", user: OPERATOR, client_msg_id: "fake-client-id", ts: "1700000100.000100", text: "hello", ...extra })
const history = (message) => classifyInbound(message, { operator: OPERATOR, botUserId: BOT, source: "history" })
const replies = (message, parentTs = "1700000000.000100") => classifyInbound(message, { operator: OPERATOR, botUserId: BOT, source: "replies", parentTs })

describe("only the operator's typed messages are heard (FR-5)", () => {
  it("ignores another user's message, even with a command or a mention", () => {
    for (const text of ["btrain> status", `<@${BOT}> hi`]) {
      const result = history(typed({ user: OTHER, text }))
      assert.equal(result.heard, HEARD.IGNORED)
      assert.equal(result.reason, "not the operator")
    }
  })

  it("ignores a message an app posted as the operator (user and app_id)", () => {
    const result = history({ type: "message", user: OPERATOR, app_id: "A0000FAKE", ts: "1.000001", text: "btrain> status" })
    assert.equal(result.heard, HEARD.IGNORED)
    assert.equal(result.reason, "posted by an app or a bot")
    assert.equal(replies({ type: "message", user: OPERATOR, app_id: "A0000FAKE", ts: "2.000001", text: "approve" }).heard, HEARD.IGNORED)
  })

  it("ignores a bot's message (bot_id and app_id), the btrain app's own included", () => {
    const result = history({ type: "message", bot_id: "B0000FAKE", app_id: "A0000FAKE", user: BOT, ts: "1.000001", text: "btrain> status" })
    assert.equal(result.heard, HEARD.IGNORED)
    assert.equal(history(typed({ bot_id: "B0000FAKE" })).heard, HEARD.IGNORED)
  })

  it("does not require client_msg_id", () => {
    const { client_msg_id: _ignored, ...noClientId } = typed({ text: "btrain> status" })
    assert.equal(history(noClientId).heard, HEARD.COMMAND)
  })

  it("returns the author fields and never the text for an ignored message", () => {
    const result = history(typed({ user: OTHER, text: "secret plans" }))
    assert.deepEqual(result.authors, { user: OTHER, app_id: null, bot_id: null, subtype: null })
    assert.ok(!JSON.stringify(result).includes("secret plans"))
  })

  it("ignores everything when no operator is configured", () => {
    assert.equal(classifyInbound(typed({ text: "btrain> status" }), { source: "history" }).heard, HEARD.IGNORED)
  })
})

describe("channel history", () => {
  it("hears a top-level command and a top-level mention", () => {
    assert.equal(history(typed({ text: "please\nbtrain> retry-review lane=e" })).heard, HEARD.COMMAND)
    assert.equal(history(typed({ text: "btrain&gt; status" })).heard, HEARD.COMMAND, "an encoded command")
    assert.equal(history(typed({ text: `<@${BOT}> what is stuck?` })).heard, HEARD.CONVERSATION)
    assert.equal(history(typed({ text: `<@${BOT}|btrain> what is stuck?` })).heard, HEARD.CONVERSATION)
  })

  it("ignores a top-level message with neither, and a mention of someone else", () => {
    assert.equal(history(typed({ text: "just chatting" })).heard, HEARD.IGNORED)
    assert.equal(history(typed({ text: `<@${OTHER}> hi` })).heard, HEARD.IGNORED)
  })

  it("ignores a thread reply shown in the channel, as under a lane card", () => {
    const broadcast = typed({ subtype: "thread_broadcast", thread_ts: "1700000000.000100", text: `<@${BOT}> btrain> status` })
    assert.equal(history(broadcast).heard, HEARD.IGNORED)
    assert.equal(history(broadcast).reason, "a thread reply shown in the channel")
  })

  it("hears a thread's parent, whose thread_ts is its own ts", () => {
    assert.equal(history(typed({ thread_ts: "1700000100.000100", text: `<@${BOT}> hi` })).heard, HEARD.CONVERSATION)
  })

  it("ignores any subtype but thread_broadcast", () => {
    for (const subtype of ["message_changed", "message_deleted", "channel_join", "bot_message", "file_share"]) {
      assert.equal(history(typed({ subtype, text: "btrain> status" })).heard, HEARD.IGNORED, subtype)
    }
  })

  it("ignores something that is not a message, or has no ts", () => {
    assert.equal(history(typed({ type: "reaction_added" })).heard, HEARD.IGNORED)
    assert.equal(history(typed({ ts: "" })).heard, HEARD.IGNORED)
    assert.equal(history(null).heard, HEARD.IGNORED)
  })
})

describe("replies in an open thread", () => {
  it("skips the parent message by its ts", () => {
    assert.equal(replies(typed({ ts: "1700000000.000100", text: `<@${BOT}> hi` })).heard, HEARD.IGNORED)
  })

  it("hears a whole-text approve or reject as an approval", () => {
    assert.deepEqual([replies(typed({ text: "approve" })).heard, replies(typed({ text: "approve" })).approval], [HEARD.APPROVAL, "approve"])
    assert.equal(replies(typed({ text: "  reject\n" })).approval, "reject")
    assert.equal(replies(typed({ text: "approve it" })).heard, HEARD.TURN, "not the whole text")
    assert.equal(replies(typed({ text: "Approve" })).heard, HEARD.TURN, "exact, not case-folded")
  })

  it("hears a command, and anything else as the next turn, with no mention needed", () => {
    assert.equal(replies(typed({ text: "btrain> poll-pr lane=e" })).heard, HEARD.COMMAND)
    assert.equal(replies(typed({ text: "and what about lane e?" })).heard, HEARD.TURN)
  })

  it("hears a reply also sent to the channel as a reply of the thread", () => {
    assert.equal(replies(typed({ subtype: "thread_broadcast", thread_ts: "1700000000.000100", text: "go on" })).heard, HEARD.TURN)
  })
})

describe("captured message bodies (spec 025 T003)", () => {
  for (const name of [
    "a typed mention",
    "a typed command whose files field names README.md and a .py file",
    "a typed approve reply",
    "a message an app posted as the operator",
    "a thread reply also sent to the channel",
    "a command typed in a code block",
  ]) {
    it(`classifies ${name}`, { skip: "needs the live capture of spec 025 T003 (test/fixtures/slack/)" }, () => {}) // btrain-allow: skipped-test
  }
})
