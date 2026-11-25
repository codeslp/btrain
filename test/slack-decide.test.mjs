// Spec 025 FR-3, FR-5, FR-6, FR-7, FR-10, FR-13 through
// src/brain_train/slack/decide.mjs (plan WS1, T010): every policy rule, with
// no file, no network, and no process.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { compareTs, decide, REPLIES, slackTsToMs } from "../src/brain_train/slack/decide.mjs"
import { parseOperatorCommand } from "../src/brain_train/slack/grammar.mjs"
import { classifyInbound } from "../src/brain_train/slack/inbound.mjs"
import { emptyInbox } from "../src/brain_train/slack/inbox.mjs"

const OPERATOR = "U0000OPER"
const BOT = "U0000FAKE"
const CH = "C0000FAKE"
const REPO = { name: "btrain", path: "/work/btrain", laneIds: ["a", "e"], agents: ["claude", "codex"] }
const CHANNEL = { repos: [REPO] }
const START = 1700000000 * 1000
const MIN = 60_000

const tsAt = (ms) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`

function messageInput({ text, ts, thread = "", source = "history", user = OPERATOR, extra = {} }) {
  const message = { type: "message", user, ts, text, ...(thread ? { thread_ts: thread } : {}), ...extra }
  const heard = classifyInbound(message, { operator: OPERATOR, botUserId: BOT, source, parentTs: thread })
  return {
    kind: "message",
    channel: CH,
    ts,
    threadTs: source === "replies" ? thread : "",
    heard,
    command: heard.heard === "command" ? parseOperatorCommand(text, CHANNEL) : undefined,
  }
}

// Drive a sequence of inputs, each at its own time; returns the final state and every action.
function run(inputs, { config = {}, state = emptyInbox() } = {}) {
  let current = state
  const all = []
  for (const [input, now] of inputs) {
    const result = decide(current, input, config, now)
    current = result.state
    all.push(...result.actions.map((action) => ({ ...action, at: now })))
  }
  return { state: current, actions: all }
}

const types = (actions) => actions.map((action) => action.type)

describe("typed messages", () => {
  it("runs a typed command at once, recorded in the handled set first", () => {
    const ts = tsAt(START)
    const { state, actions } = decide(emptyInbox(), messageInput({ text: "btrain> retry-review lane=e", ts }), {}, START + 1000)
    assert.deepEqual(actions, [{
      type: "command", channel: CH, thread: ts, ts, verb: "retry-review",
      canonical: "btrain> retry-review lane=e", repo: "/work/btrain", source: "operator",
    }])
    assert.ok(state.handled[`${CH}:${ts}`])
  })

  it("runs a typed start with no approval", () => {
    const { actions } = decide(emptyInbox(), messageInput({ text: "btrain> start owner=codex\ntask: t\nfiles: a", ts: tsAt(START) }), {}, START)
    assert.deepEqual(types(actions), ["command"])
  })

  it("never acts twice on one ts", () => {
    const input = messageInput({ text: "btrain> status", ts: tsAt(START) })
    const { actions } = run([[input, START], [input, START + 1000]])
    assert.deepEqual(types(actions), ["command"])
  })

  it("replies with the reason for an invalid command and runs nothing", () => {
    const { actions } = decide(emptyInbox(), messageInput({ text: "btrain> merge lane=e", ts: tsAt(START) }), {}, START)
    assert.deepEqual(types(actions), ["reply"])
    assert.match(actions[0].text, /Rejected: unknown verb merge/)
  })

  it("logs an ignored message without its text and does nothing else", () => {
    const { actions } = decide(emptyInbox(), messageInput({ text: "btrain> status", ts: tsAt(START), user: "U0000OTHR" }), {}, START)
    assert.deepEqual(types(actions), ["ignored"])
    assert.ok(!JSON.stringify(actions).includes("btrain> status"))
  })

  it("pauses on a typed pause and says how to resume", () => {
    const { actions } = decide(emptyInbox(), messageInput({ text: "btrain> pause", ts: tsAt(START) }), {}, START)
    assert.deepEqual(types(actions), ["pause", "reply"])
    assert.equal(actions[1].text, REPLIES.paused)
  })

  it("skips a message first seen after approvalMinutes with exactly one reply", () => {
    const old = messageInput({ text: "btrain> retry-review lane=e", ts: tsAt(START) })
    const { actions } = run([[old, START + 16 * MIN], [old, START + 17 * MIN]])
    assert.deepEqual(types(actions), ["reply"])
    assert.equal(actions[0].text, REPLIES.tooOld(15))
  })
})

describe("conversations and turns (FR-13)", () => {
  it("opens a conversation on a mention and starts one run", () => {
    const ts = tsAt(START)
    const { state, actions } = decide(emptyInbox(), messageInput({ text: `<@${BOT}> what is stuck?`, ts }), {}, START)
    assert.deepEqual(actions, [{ type: "turn", channel: CH, thread: ts, ts }])
    assert.equal(state.threads[`${CH}:${ts}`].busy, true)
    assert.equal(state.windows.turns.length, 1)
  })

  it("answers a mention with the one-line note when the model is off", () => {
    const { state, actions } = decide(emptyInbox(), messageInput({ text: `<@${BOT}> hi`, ts: tsAt(START) }), { runner: "" }, START)
    assert.deepEqual(actions.map((action) => action.text), [REPLIES.modelOff])
    assert.deepEqual(state.windows.turns, [])
  })

  it("queues a second message while a run is busy and starts it when the run is done", () => {
    const parent = tsAt(START)
    const second = tsAt(START + 10_000)
    const { state, actions } = run([
      [messageInput({ text: `<@${BOT}> hi`, ts: parent }), START],
      [messageInput({ text: "and lane e?", ts: second, thread: parent, source: "replies" }), START + 10_000],
      [{ kind: "turn-done", channel: CH, thread: parent }, START + 20_000],
    ])
    assert.deepEqual(actions.map((action) => [action.type, action.ts]), [["turn", parent], ["turn", second]])
    assert.deepEqual(state.threads[`${CH}:${parent}`].queued, [])
  })

  it("refuses the thirty-first run in an hour with a reason", () => {
    const inputs = []
    for (let index = 0; index < 31; index += 1) {
      const ts = tsAt(START + index * 1000)
      inputs.push([messageInput({ text: `<@${BOT}> q${index}`, ts }), START + index * 1000])
      // Each run finishes, so only the hourly limit can refuse one.
      inputs.push([{ kind: "turn-done", channel: CH, thread: ts }, START + index * 1000 + 500])
    }
    const { actions } = run(inputs)
    assert.equal(actions.filter((action) => action.type === "turn").length, 30)
    assert.match(actions.at(-1).text, /30 orchestrator runs an hour/)
  })

  it("keeps at most three runs alive, queues the rest, and starts them as runs finish", () => {
    const parents = [0, 1, 2, 3].map((index) => tsAt(START + index * 1000))
    const inputs = parents.map((ts, index) => [messageInput({ text: `<@${BOT}> q${index}`, ts }), START + index * 1000])
    const opened = run(inputs)
    assert.equal(opened.actions.filter((action) => action.type === "turn").length, 3, "a fourth live run waits")
    assert.equal(Object.values(opened.state.threads).filter((thread) => thread.busy).length, 3)
    assert.deepEqual(opened.state.threads[`${CH}:${parents[3]}`].queued, [parents[3]], "the fourth conversation is queued, not dropped")

    // A reply in an open, idle thread also waits while three runs are alive.
    const reply = tsAt(START + 5000)
    const replied = run([
      [{ kind: "turn-done", channel: CH, thread: parents[0] }, START + 4000],
      [messageInput({ text: "more", ts: reply, thread: parents[1], source: "replies" }), START + 5000],
    ], { state: opened.state })
    assert.deepEqual(replied.actions.map((action) => [action.type, action.ts]), [["turn", parents[3]]], "capacity goes to the queued conversation first")
    assert.deepEqual(replied.state.threads[`${CH}:${parents[1]}`].queued, [reply], "the reply waits in its busy thread")

    // Each finished run releases capacity to the next queued message.
    const released = decide(replied.state, { kind: "turn-done", channel: CH, thread: parents[1] }, {}, START + 6000)
    assert.deepEqual(released.actions.map((action) => [action.type, action.thread, action.ts]), [["turn", parents[1], reply]])
    assert.equal(Object.values(released.state.threads).filter((thread) => thread.busy).length, 3)
  })

  it("does not start a run for an approve, a reject, or a command in the thread", () => {
    const parent = tsAt(START)
    const { actions } = run([
      [messageInput({ text: `<@${BOT}> hi`, ts: parent }), START],
      [{ kind: "turn-done", channel: CH, thread: parent }, START + 1000],
      [messageInput({ text: "approve", ts: tsAt(START + 2000), thread: parent, source: "replies" }), START + 2000],
      [messageInput({ text: "btrain> status", ts: tsAt(START + 3000), thread: parent, source: "replies" }), START + 3000],
    ])
    assert.deepEqual(types(actions), ["turn", "reply", "command"])
    assert.equal(actions[1].text, REPLIES.nothingToApprove)
    assert.equal(actions[2].thread, parent, "a command in a thread replies in that thread")
  })

  it("acts on a reply also sent to the channel when its history copy was read first", () => {
    const parent = tsAt(START)
    const reply = tsAt(START + 5000)
    const fields = { text: "and what about lane e?", ts: reply, thread: parent, extra: { subtype: "thread_broadcast" } }
    const { actions } = run([
      [messageInput({ text: `<@${BOT}> hi`, ts: parent }), START],
      [{ kind: "turn-done", channel: CH, thread: parent }, START + 1000],
      [messageInput({ ...fields, source: "history" }), START + 5000],
      [messageInput({ ...fields, source: "replies" }), START + 5000],
      [messageInput({ ...fields, source: "history" }), START + 6000],
    ])
    assert.deepEqual(actions.map((action) => [action.type, action.ts]), [["turn", parent], ["ignored", reply], ["turn", reply]])
  })

  it("closes a conversation conversationMinutes after the operator's last message", () => {
    const parent = tsAt(START)
    const { state } = run([
      [messageInput({ text: `<@${BOT}> hi`, ts: parent }), START],
      [{ kind: "turn-done", channel: CH, thread: parent }, START + 1000],
      [{ kind: "tick" }, START + 29 * MIN],
    ])
    assert.ok(state.threads[`${CH}:${parent}`])
    const later = decide(state, { kind: "tick" }, {}, START + 31 * MIN)
    assert.equal(later.state.threads[`${CH}:${parent}`], undefined)
  })
})

describe("proposals and approval (FR-6, FR-7)", () => {
  const parent = tsAt(START)
  const opened = () => run([
    [messageInput({ text: `<@${BOT}> start something`, ts: parent }), START],
    [{ kind: "turn-done", channel: CH, thread: parent }, START + 1000],
  ]).state
  const proposal = (canonical, verb, values = {}) => ({ verb, repo: REPO, values, canonical })
  const startProposal = proposal("btrain> start owner=codex\ntask: t\nfiles: a", "start", { owner: "codex", task: "t", files: "a" })

  it("runs a proposal for an auto-list verb at once", () => {
    const { actions, state } = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: proposal("btrain> retry-review lane=e", "retry-review", { lane: "e" }) }, {}, START + 5000)
    assert.deepEqual(types(actions), ["command"])
    assert.equal(actions[0].source, "orchestrator")
    assert.equal(state.proposals[`${CH}:1700000005.000100`].state, "approved")
  })

  it("makes a start proposal wait, and runs the stored text after the operator's typed approve", () => {
    const posted = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: startProposal }, {}, START + 5000)
    assert.deepEqual(posted.actions, [])
    assert.equal(posted.state.threads[`${CH}:${parent}`].pending, "1700000005.000100")
    const approved = decide(posted.state, messageInput({ text: "approve", ts: tsAt(START + 60_000), thread: parent, source: "replies" }), {}, START + 60_000)
    assert.deepEqual(types(approved.actions), ["command"])
    assert.equal(approved.actions[0].canonical, startProposal.canonical)
    assert.equal(approved.actions[0].verb, "start")
    assert.equal(approved.actions[0].proposalTs, "1700000005.000100")
    assert.equal(approved.state.proposals[`${CH}:1700000005.000100`].state, "approved")
  })

  it("does not run a start proposal for an app-posted approve or an approve in another thread", () => {
    const posted = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: startProposal }, {}, START + 5000)
    const byApp = decide(posted.state, messageInput({ text: "approve", ts: tsAt(START + 6000), thread: parent, source: "replies", extra: { app_id: "A0000FAKE" } }), {}, START + 6000)
    assert.deepEqual(types(byApp.actions), ["ignored"])
    const elsewhere = decide(posted.state, messageInput({ text: "approve", ts: tsAt(START + 7000), thread: "1699999999.000100", source: "replies" }), {}, START + 7000)
    assert.deepEqual(elsewhere.actions.map((action) => action.text), [REPLIES.nothingToApprove])
  })

  it("does not apply an approve or reject sent before the pending proposal was posted", () => {
    const first = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: startProposal }, {}, START + 5000)
    // A newer proposal replaces the first one after the operator typed approve,
    // but before that approve was read.
    const replacement = proposal("btrain> start owner=claude\ntask: other\nfiles: b", "start", {})
    const second = decide(first.state, { kind: "proposal", channel: CH, thread: parent, ts: "1700000009.000000", proposal: replacement }, {}, START + 9000)
    for (const text of ["approve", "reject"]) {
      const early = decide(second.state, messageInput({ text, ts: "1700000008.000000", thread: parent, source: "replies" }), {}, START + 10_000)
      assert.ok(!early.actions.some((action) => action.type === "command"), `${text} sent before the proposal runs nothing`)
      assert.equal(early.state.proposals[`${CH}:1700000009.000000`].state, "pending", `${text} leaves the newer proposal pending`)
    }
    const later = decide(second.state, messageInput({ text: "approve", ts: "1700000010.000000", thread: parent, source: "replies" }), {}, START + 10_000)
    assert.deepEqual(later.actions.filter((action) => action.type === "command").map((action) => action.canonical), [replacement.canonical])
  })

  it("rejects a pending proposal on reject and runs nothing", () => {
    const posted = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: startProposal }, {}, START + 5000)
    const rejected = decide(posted.state, messageInput({ text: "reject", ts: tsAt(START + 6000), thread: parent, source: "replies" }), {}, START + 6000)
    assert.deepEqual(rejected.actions.map((action) => action.text), [REPLIES.rejected])
    assert.equal(rejected.state.proposals[`${CH}:1700000005.000100`].state, "rejected")
    const again = decide(rejected.state, messageInput({ text: "approve", ts: tsAt(START + 7000), thread: parent, source: "replies" }), {}, START + 7000)
    assert.deepEqual(again.actions.map((action) => action.text), [REPLIES.nothingToApprove])
  })

  it("cancels the earlier proposal when a second one arrives, and approve runs the second", () => {
    const second = proposal("btrain> start owner=claude\ntask: other\nfiles: b", "start", {})
    const { state, actions } = run([
      [{ kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: startProposal }, START + 5000],
      [{ kind: "proposal", channel: CH, thread: parent, ts: "1700000006.000100", proposal: second }, START + 6000],
      [messageInput({ text: "approve", ts: tsAt(START + 7000), thread: parent, source: "replies" }), START + 7000],
    ], { state: opened() })
    assert.deepEqual(actions.map((action) => action.type), ["reply", "command"])
    assert.equal(actions[0].text, REPLIES.cancelled)
    assert.equal(actions[1].canonical, second.canonical)
    assert.equal(state.proposals[`${CH}:1700000005.000100`].state, "cancelled")
  })

  it("cannot approve an expired proposal, also when the approve comes before the tick marks it", () => {
    const posted = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: startProposal }, {}, START + 5000)
    const late = decide(posted.state, messageInput({ text: "approve", ts: tsAt(START + 5000 + 15 * MIN), thread: parent, source: "replies" }), {}, START + 5000 + 15 * MIN)
    assert.deepEqual(late.actions.map((action) => action.text), [REPLIES.expired(15)])
    assert.equal(late.state.proposals[`${CH}:1700000005.000100`].state, "expired")
  })

  it("expires a pending proposal on the tick, once", () => {
    const posted = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: startProposal }, {}, START + 5000)
    const ticked = decide(posted.state, { kind: "tick" }, {}, START + 5000 + 16 * MIN)
    assert.deepEqual(ticked.actions.map((action) => action.text), [REPLIES.expired(15)])
    assert.equal(ticked.state.threads[`${CH}:${parent}`]?.pending ?? null, null)
    assert.deepEqual(decide(ticked.state, { kind: "tick" }, {}, START + 5000 + 17 * MIN).actions, [])
  })

  it("rejects a proposal for pause", () => {
    const { actions, state } = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: proposal("btrain> pause", "pause") }, {}, START + 5000)
    assert.deepEqual(types(actions), ["reply"])
    assert.match(actions[0].text, /only the operator can type it/)
    assert.deepEqual(state.proposals, {})
  })

  it("waits for approval for a retry-review that is not on the repository's auto list", () => {
    const config = { repos: { "/work/btrain": { auto: ["status"] } } }
    const { actions, state } = decide(opened(), { kind: "proposal", channel: CH, thread: parent, ts: "1700000005.000100", proposal: proposal("btrain> retry-review lane=e", "retry-review", { lane: "e" }) }, config, START + 5000)
    assert.deepEqual(actions, [])
    assert.equal(state.proposals[`${CH}:1700000005.000100`].state, "pending")
  })
})

describe("limits (FR-10)", () => {
  it("refuses the twenty-first command in an hour for one repository", () => {
    const inputs = Array.from({ length: 21 }, (_, index) => [messageInput({ text: "btrain> status", ts: tsAt(START + index * 1000) }), START + index * 1000])
    const { actions } = run(inputs)
    assert.equal(actions.filter((action) => action.type === "command").length, 20)
    assert.match(actions.at(-1).text, /20 commands an hour/)
  })

  it("refuses a loop verb when max_active loops are running", () => {
    const state = { ...emptyInbox(), loops: [1, 2, 3].map((pid) => ({ repo: "/work/btrain", lane: "a", pid })) }
    const { actions } = decide(state, messageInput({ text: "btrain> retry-review lane=e", ts: tsAt(START) }), {}, START)
    assert.match(actions[0].text, /3 loops started from Slack/)
    const status = decide(state, messageInput({ text: "btrain> status", ts: tsAt(START + 1) }), {}, START)
    assert.deepEqual(types(status.actions), ["command"], "a verb that starts no loop is not counted")
  })

  it("refuses the fourth unapproved retry-review for one lane in an hour", () => {
    const parent = tsAt(START)
    const base = run([[messageInput({ text: `<@${BOT}> hi`, ts: parent }), START]]).state
    const inputs = [1, 2, 3, 4].map((index) => [{
      kind: "proposal", channel: CH, thread: parent, ts: `170000000${index}.000200`,
      proposal: { verb: "retry-review", repo: REPO, values: { lane: "e" }, canonical: "btrain> retry-review lane=e" },
    }, START + index * 1000])
    const { actions } = run(inputs, { state: base })
    assert.equal(actions.filter((action) => action.type === "command").length, 3)
    assert.match(actions.at(-1).text, /3 unapproved retry-review runs an hour for lane e/)
  })
})

describe("compareTs", () => {
  it("orders Slack ts strings exactly", () => {
    assert.equal(compareTs("1700000000.000101", "1700000000.000100"), 1)
    assert.equal(compareTs("1700000000.0001", "1700000000.000100"), 0)
    assert.equal(compareTs("999.999999", "1000.000000"), -1)
  })
})

describe("slackTsToMs", () => {
  it("reads a Slack ts as milliseconds", () => {
    assert.equal(slackTsToMs("1700000000.250000"), 1700000000250)
    assert.equal(slackTsToMs("5"), 5000)
  })
})
