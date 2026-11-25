// Spec 025 FR-7, FR-16 and the plan's "The reply" through
// src/brain_train/slack/reply.mjs (plan WS1, T009).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MAX_PROSE_CHARS, renderProposalMessage, splitModelReply } from "../src/brain_train/slack/reply.mjs"

const REPO = { name: "btrain", path: "/work/btrain", laneIds: ["a", "e"], agents: ["claude", "codex"] }
const CHANNEL = { repos: [REPO] }
// Fake secrets, built at runtime so the source holds no matching string.
const SLACK_TOKEN = ["xoxb", "1234567890", "fake", "reply", "token"].join("-")
const GITHUB_PAT = ["github", "pat", "1".repeat(22), "2".repeat(59)].join("_")

describe("the prose", () => {
  it("is redacted and escaped, with no mention and no link", () => {
    const raw = `Lane e is waiting. <!channel> <@U0000FAKE> see https://evil.invalid/x and ${SLACK_TOKEN} & ${GITHUB_PAT}`
    const { prose, proposal, notes } = splitModelReply(raw, { channel: CHANNEL })
    assert.equal(proposal, null)
    assert.deepEqual(notes, [])
    assert.doesNotMatch(prose, /[<>]|:\/\//)
    assert.ok(!prose.includes(SLACK_TOKEN) && !prose.includes("1".repeat(22)))
    assert.match(prose, /&lt;!channel&gt;/)
    assert.match(prose, /https\[:\]\/\/evil\.invalid/)
    assert.match(prose, /\[redacted\]/)
    assert.match(prose, /&amp;/)
  })

  it("keeps its lines and is cut to 3,000 characters", () => {
    const { prose } = splitModelReply(`line one\nline two\n${"x".repeat(5000)}`, { channel: CHANNEL })
    assert.match(prose, /^line one\nline two\n/)
    assert.equal(Array.from(prose).length, MAX_PROSE_CHARS)
  })
})

describe("the proposal", () => {
  it("is split from the prose and rendered in canonical form", () => {
    const raw = "I can retry the review.\n\nbtrain> retry-review lane=e\n\nSay if you want something else."
    const { prose, proposal } = splitModelReply(raw, { channel: CHANNEL })
    assert.deepEqual({ verb: proposal.verb, canonical: proposal.canonical, repo: proposal.repo.path }, {
      verb: "retry-review", canonical: "btrain> retry-review lane=e", repo: "/work/btrain",
    })
    assert.equal(prose, "I can retry the review.\n\n\nSay if you want something else.")
    assert.doesNotMatch(prose, /btrain&gt;/)
  })

  it("rejects the proposal part of a reply with two btrain> lines, keeps the prose, and says so", () => {
    const raw = "Two options:\nbtrain> retry-review lane=e\n\nbtrain> poll-pr lane=e\nlane: e\n\nPick one."
    const { prose, proposal, notes } = splitModelReply(raw, { channel: CHANNEL })
    assert.equal(proposal, null)
    assert.match(notes[0], /more than one btrain&gt; command/)
    assert.doesNotMatch(prose, /btrain/)
    assert.match(prose, /Two options:/)
    assert.match(prose, /Pick one\./)
  })

  it("rejects an invalid command with its reason and keeps the prose", () => {
    const { proposal, notes, prose } = splitModelReply("Try this:\nbtrain> merge lane=e", { channel: CHANNEL })
    assert.equal(proposal, null)
    assert.match(notes[0], /not valid: unknown verb merge/)
    assert.equal(prose, "Try this:")
  })

  it("rejects a proposal for pause", () => {
    const { proposal, notes } = splitModelReply("btrain> pause", { channel: CHANNEL })
    assert.equal(proposal, null)
    assert.match(notes[0], /only be typed by the operator/)
  })

  it("rejects a proposal the scrub or the URL rewrite would change", () => {
    for (const task of [`rotate ${SLACK_TOKEN}`, "read https://example.invalid/spec"]) {
      const { proposal, notes } = splitModelReply(`btrain> start owner=codex\ntask: ${task}\nfiles: a`, { channel: CHANNEL })
      assert.equal(proposal, null, task)
      assert.match(notes[0], /secret pattern|URL/)
    }
  })

  it("rejects a proposal holding a code fence", () => {
    const { proposal, notes } = splitModelReply("btrain> start owner=codex\ntask: break ``` out\nfiles: a", { channel: CHANNEL })
    assert.equal(proposal, null)
    assert.match(notes[0], /code fence/)
  })

  it("accepts a 2,000-character task, and rejects a proposal whose message passes 3,999 characters", () => {
    const longTask = "t".repeat(2000)
    const ok = splitModelReply(`btrain> start owner=codex\ntask: ${longTask}\nfiles: a`, { channel: CHANNEL })
    assert.ok(ok.proposal, ok.notes.join())
    const fields = ["objective", "deliverable", "acceptance", "done-when"].map((key) => `${key}: ${"y".repeat(500)}`).join("\n")
    const tooLong = splitModelReply(`btrain> start owner=codex\ntask: ${longTask}\nfiles: a\n${fields}`, { channel: CHANNEL })
    assert.equal(tooLong.proposal, null)
    assert.match(tooLong.notes[0], /3999-character message/)
  })

  it("keeps a note that quotes model text inert", () => {
    const { notes } = splitModelReply("btrain> poll-pr <!channel>", { channel: CHANNEL })
    assert.doesNotMatch(notes[0], /[<>]/)
  })
})

describe("renderProposalMessage", () => {
  it("posts the canonical text in a code block with the approval line", () => {
    assert.equal(
      renderProposalMessage("btrain> start owner=codex\ntask: a & b\nfiles: a", { approvalMinutes: 15 }),
      "```\nbtrain&gt; start owner=codex\ntask: a &amp; b\nfiles: a\n```\nReply `approve` in this thread within 15 minutes to run it, or `reject`.",
    )
    assert.match(renderProposalMessage("btrain> status", { needsApproval: false }), /auto list and runs now/)
  })
})
