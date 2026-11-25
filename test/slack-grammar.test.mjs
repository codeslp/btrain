// Spec 025 FR-2 and the plan's "Command grammar" through
// src/brain_train/slack/grammar.mjs (plan WS1, T008).
//
// Step 1 (undoing Slack's encoding) follows Slack's documented formatting.
// The tests that need a real captured message (spec 025 T003, a person with
// the real app) are skipped until the fixtures exist under
// test/fixtures/slack/.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  checkCommand,
  decodeSlackText,
  findCommand,
  hasCommand,
  parseCanonical,
  parseCommandBlock,
  parseModelCommand,
  parseOperatorCommand,
  renderCanonical,
} from "../src/brain_train/slack/grammar.mjs"

const REPO = { name: "btrain", path: "/work/btrain", laneIds: ["a", "e"], agents: ["claude", "codex"] }
const CHANNEL = { repos: [REPO] }

describe("each verb parses to canonical text", () => {
  for (const [text, canonical] of [
    ["btrain> status", "btrain> status"],
    ["btrain> flush", "btrain> flush"],
    ["btrain> poll-pr lane=e", "btrain> poll-pr lane=e"],
    ["btrain> retry-review lane=e", "btrain> retry-review lane=e"],
    ["btrain> pause", "btrain> pause"],
    [
      "btrain> start owner=codex\ndone-when:  New tests pass\ntask: Add 429 retry\nfiles: src/a.mjs, test/a.test.mjs",
      "btrain> start owner=codex\ntask: Add 429 retry\nfiles: src/a.mjs, test/a.test.mjs\ndone-when: New tests pass",
    ],
  ]) {
    it(JSON.stringify(text), () => {
      const result = parseOperatorCommand(text, CHANNEL)
      assert.equal(result.ok, true, result.reason)
      assert.equal(result.canonical, canonical)
      assert.equal(result.repo, REPO)
    })
  }
})

describe("rejections, each with a reason", () => {
  for (const [text, reason] of [
    ["btrain> deploy", /unknown verb deploy/],
    ["btrain> merge lane=e", /unknown verb merge/],
    ["btrain> status colour=red", /takes no argument colour=/],
    ["btrain> start owner=codex\ntask: t\nfiles: a\ncolour: red", /takes no field colour:/],
    ["btrain> start owner=codex\ntask: t", /needs files/],
    ["btrain> retry-review", /needs lane/],
    ["btrain> status\nbtrain> flush", /more than one btrain> line/],
    ["btrain> poll-pr lane=e lane=a", /lane is given twice/],
    ["btrain> poll-pr e", /is not key=value/],
    ["btrain>", /names no verb/],
    ["btrain> start owner=codex\nthis is not a field", /not a key: value line/],
    ["btrain> poll-pr lane=-e", /may not start with "-"/],
    ["btrain> poll-pr lane=", /lane is empty/],
    ["btrain> start owner=codex\ntask: -rf\nfiles: a", /may not start with "-"/],
    ["btrain> start owner=codex\ntask: t\nfiles: ../x", /\.\./],
    ["btrain> start owner=codex\ntask: t\nfiles: /etc/passwd", /not a relative path/],
    ["btrain> start owner=codex\ntask: t\nfiles: ~/x", /not a relative path/],
    [`btrain> start owner=codex\ntask: ${"t".repeat(2001)}\nfiles: a`, /longer than 2000/],
    ["btrain> start owner=nobody\ntask: t\nfiles: a", /not an active agent/],
    ["btrain> poll-pr lane=z", /not a lane/],
    ["just chatting", /no btrain> command/],
  ]) {
    it(JSON.stringify(text.slice(0, 60)), () => {
      const result = parseOperatorCommand(text, CHANNEL)
      assert.equal(result.ok, false)
      assert.match(result.reason, reason)
    })
  }

  it("rejects a value holding a control character", () => {
    const result = checkCommand(parseCommandBlock(["btrain> start owner=codex", "task: a\u0007b", "files: a"]), CHANNEL)
    assert.equal(result.ok, false)
    assert.match(result.reason, /control character/)
  })
})

describe("undoing Slack's encoding", () => {
  it("ignores prose around a valid command", () => {
    const result = parseOperatorCommand("Can you do this?\nbtrain> retry-review lane=e\n\nthanks!", CHANNEL)
    assert.equal(result.canonical, "btrain> retry-review lane=e")
  })

  it("parses a command that arrives as &gt;", () => {
    assert.equal(parseOperatorCommand("btrain&gt; status", CHANNEL).canonical, "btrain> status")
  })

  it("decodes entities with &amp; last", () => {
    assert.equal(decodeSlackText("a &amp;lt; b &lt;c&gt; &amp;"), "a &lt; b <c> &")
  })

  it("turns link markup into its label, or its URL with no label", () => {
    assert.equal(decodeSlackText("files: <http://README.md|README.md>, <https://x.invalid/y>"), "files: README.md, https://x.invalid/y")
    const result = parseOperatorCommand("btrain> start owner=codex\ntask: docs\nfiles: <http://README.md|README.md>, src/x.py", CHANNEL)
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.values.files, "README.md, src/x.py")
  })

  it("parses a command inside a code fence", () => {
    assert.equal(parseOperatorCommand("```btrain> poll-pr lane=e```", CHANNEL).canonical, "btrain> poll-pr lane=e")
    assert.equal(parseOperatorCommand("```\nbtrain> start owner=codex\ntask: t\nfiles: a\n```", CHANNEL).canonical, "btrain> start owner=codex\ntask: t\nfiles: a")
  })

  it("rejects a command that still holds a user, channel, or special mention", () => {
    for (const token of ["<@U0000FAKE>", "<#C0000FAKE|general>", "<!here>", "<!subteam^S0000FAKE>"]) {
      const result = parseOperatorCommand(`btrain> start owner=codex\ntask: ping ${token}\nfiles: a`, CHANNEL)
      assert.equal(result.ok, false, token)
      assert.match(result.reason, /mention/)
    }
  })

  it("does not look at a mention outside the command block", () => {
    assert.equal(parseOperatorCommand("<@U0000FAKE> please\nbtrain> status", CHANNEL).ok, true)
  })

  it("parses the captured README.md link fixture to the plain file name", { skip: "needs the live capture of spec 025 T003 (test/fixtures/slack/)" }, () => {}) // btrain-allow: skipped-test

  it("parses the captured code-block fixture", { skip: "needs the live capture of spec 025 T003 (test/fixtures/slack/)" }, () => {}) // btrain-allow: skipped-test
})

describe("repo= in a channel with several repositories", () => {
  const shared = {
    repos: [
      { name: "web", path: "/a/web", laneIds: ["a"], agents: ["codex"] },
      { name: "web", path: "/b/web", laneIds: ["a"], agents: ["codex"] },
      { name: "api", path: "/a/api", laneIds: ["a"], agents: ["codex"] },
    ],
  }

  it("rejects repo= by a name two repositories share and accepts the registered path", () => {
    assert.match(parseOperatorCommand("btrain> poll-pr repo=web lane=a", shared).reason, /named web/)
    const byPath = parseOperatorCommand("btrain> poll-pr repo=/b/web lane=a", shared)
    assert.equal(byPath.ok, true)
    assert.equal(byPath.repo.path, "/b/web")
    assert.equal(byPath.canonical, "btrain> poll-pr repo=/b/web lane=a")
  })

  it("rejects a command with no repo=, and one naming a repository mapped to another channel", () => {
    assert.match(parseOperatorCommand("btrain> poll-pr lane=a", shared).reason, /add repo=/)
    assert.match(parseOperatorCommand("btrain> poll-pr repo=/c/other lane=a", shared).reason, /not a repository served/)
  })

  it("accepts a unique name", () => {
    assert.equal(parseOperatorCommand("btrain> status repo=api", shared).repo.path, "/a/api")
  })
})

describe("finding, rendering, and reading back", () => {
  it("finds the one command block and its line span", () => {
    const found = findCommand("hi\nbtrain> start owner=codex\ntask: t\nfiles: a\n\nbye")
    assert.deepEqual([found.found, found.start, found.end], [true, 1, 4])
    assert.equal(hasCommand("no"), false)
    assert.equal(findCommand("btrain> a\nbtrain> b").many, true)
  })

  it("renders no trailing space and one space after each colon", () => {
    assert.equal(renderCanonical({ verb: "start", values: { owner: "codex", files: "a", task: "t" } }), "btrain> start owner=codex\ntask: t\nfiles: a")
  })

  it("reads stored canonical text back to the same verb and values", () => {
    const parsed = parseOperatorCommand("btrain> start owner=codex\ntask: t\nfiles: a\nreviewer: claude", CHANNEL)
    assert.deepEqual(parseCanonical(parsed.canonical), { ok: true, reason: "", verb: "start", values: { owner: "codex", task: "t", files: "a", reviewer: "claude" }, repoGiven: undefined })
  })

  it("parses a model's command without decoding it", () => {
    // A model reply is not Slack-encoded, so &gt; stays text and is no command.
    assert.equal(parseModelCommand("btrain&gt; status", CHANNEL).ok, false)
    assert.equal(parseModelCommand("Sure.\nbtrain> status\n\nDone.", CHANNEL).canonical, "btrain> status")
  })
})
