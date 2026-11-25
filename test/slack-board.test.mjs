// Spec 024 FR-9, FR-14, FR-16 and the plan's WS5 (T022, T025): the board, and
// several repositories and developers sharing one channel, through deliver()
// and the fake Slack.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deliver } from "../src/brain_train/slack/deliver.mjs"
import { boardLanes, boardStatus, boardText, repoKey, writeRepoEntry } from "../src/brain_train/slack/board.mjs"
import { writeEntry } from "../src/brain_train/slack/outbox.mjs"
import { getBoard, reserveChannelSend } from "../src/brain_train/slack/threads.mjs"
import { createFakeSlack } from "./helpers/fake-slack.mjs"

const FAKE_BOT = ["xoxb", "0000", "fake", "bot", "board"].join("-")
const CHANNEL = "C0000FAKE"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

const lane = (id, overrides = {}) => ({
  lane: id, claimKey: `claim-${id}`, task: `Task ${id}`, owner: "claude", reviewer: "codex-reviewer",
  status: "in-progress", lockedFiles: [], lastUpdated: "claude 2026-11-25T20:00:00.000Z", ...overrides,
})

// One fake Slack and one clock for the whole channel. Each repository has its
// own state directory; each developer label has its own btrain home.
async function channelFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-board-"))
  roots.push(root)
  const clock = { at: Date.now() }
  const fake = createFakeSlack({ expectedToken: FAKE_BOT, now: () => clock.at })
  const repo = (name, { label = "dev-a", lanes = [lane("a")] } = {}) => {
    const repoPath = path.join(root, label, name)
    const slackDir = path.join(repoPath, ".btrain", "slack")
    const state = { lanes, readError: null }
    return {
      name, repoPath, slackDir, state, label,
      homeDir: path.join(root, `home-${label}`),
      queue: (laneId, kind, fields = {}) => writeEntry(slackDir, { laneId, claimKey: `claim-${laneId}`, kind, reply: true, mention: false, fields: { lane: laneId, actor: "claude", ...fields } }, { now: () => clock.at }),
      run: (options = {}) => deliver({
        slackDir,
        repo: { name, path: repoPath },
        channel: CHANNEL,
        token: FAKE_BOT,
        fetchImpl: fake.fetch,
        readLanes: async () => {
          if (state.readError) throw new Error(state.readError)
          return state.lanes
        },
        context: { label, mention: [] },
        now: () => clock.at,
        sleep: async (ms) => { clock.at += ms },
        homeDir: path.join(root, `home-${label}`),
        ...options,
      }),
    }
  }
  const boardPosts = () => fake.calls.filter((call) => call.method === "chat.postMessage" && call.body.text.startsWith("board · dev:"))
  const boardUpdates = () => fake.calls.filter((call) => call.method === "chat.update" && call.body.text.startsWith("board · dev:"))
  const pins = () => fake.calls.filter((call) => call.method === "pins.add")
  return { root, clock, fake, repo, boardPosts, boardUpdates, pins }
}

describe("board records (board.mjs)", () => {
  it("keeps only active lanes, in lane order, with the board's fields", () => {
    assert.deepEqual(boardLanes([lane("c", { prNumber: "7" }), lane("a"), lane("b", { status: "resolved" }), lane("d", { status: "idle" }), null]), [
      { lane: "a", status: "in-progress", owner: "claude", reviewer: "codex-reviewer", prNumber: "" },
      { lane: "c", status: "in-progress", owner: "claude", reviewer: "codex-reviewer", prNumber: "7" },
    ])
  })

  it("renders repositories by name and marks a stale one", () => {
    const record = { repos: {
      "/z/web": { name: "web", lanes: [], stale: false },
      "/a/api": { name: "api", lanes: boardLanes([lane("b")]), stale: true },
    } }
    assert.equal(boardText(record, "dana"), [
      "board · dev: dana",
      "api (not refreshed)",
      "  lane b · in-progress · owner: claude · reviewer: codex-reviewer · pr: none",
      "web",
      "  no active lanes",
    ].join("\n"))
  })

  it("keys a repository by its resolved path", () => {
    assert.equal(repoKey("/x/y/../repo"), path.resolve("/x/repo"))
  })
})

describe("the board in a channel (T022)", () => {
  it("posts the board once, pins it once, and then updates it in place", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    await api.queue("a", "claimed")
    assert.equal((await api.run()).status, "done")
    assert.equal(c.boardPosts().length, 1)
    assert.equal(c.pins().length, 1)
    const posted = c.fake.calls.find((call) => call.method === "chat.postMessage" && call.body.text.startsWith("board"))
    assert.match(posted.body.text, /^board · dev: dev-a\napi\n {2}lane a · in-progress · owner: claude/)
    const boardTs = (await getBoard(api.homeDir, CHANNEL)).ts
    assert.ok(boardTs)
    assert.equal(c.pins()[0].body.timestamp, boardTs)
    assert.deepEqual(await boardStatus(api.homeDir, CHANNEL), { posted: true, pinned: true, pinError: "" })

    // Unchanged state: no board call at all.
    c.clock.at += 5000
    await api.queue("a", "card-refresh")
    const before = c.fake.calls.length
    await api.run()
    assert.equal(c.fake.calls.slice(before).filter((call) => String(call.body.text || "").startsWith("board") || call.method === "pins.add").length, 0)

    // A change: the same message is updated, and it is not pinned again.
    api.state.lanes = [lane("a", { status: "needs-review" })]
    await api.queue("a", "sent-to-review", { reviewer: "codex-reviewer" })
    await api.run()
    assert.equal(c.boardPosts().length, 1)
    assert.equal(c.boardUpdates().length, 1)
    assert.equal(c.boardUpdates()[0].body.ts, boardTs)
    assert.match(c.boardUpdates()[0].body.text, /lane a · needs-review/)
    assert.equal(c.pins().length, 1)

    // The lane resolves: the board stays, down to "no active lanes".
    api.state.lanes = [lane("a", { status: "resolved" })]
    await api.queue("a", "merged")
    await api.run()
    assert.match(c.boardUpdates().at(-1).body.text, /api\n {2}no active lanes$/)
  })

  it("posts no board while no repository has an active lane", async () => {
    const c = await channelFixture()
    const api = c.repo("api", { lanes: [lane("a", { status: "resolved" })] })
    await api.queue("a", "abandoned")
    await api.run()
    assert.equal(c.boardPosts().length, 0)
    assert.equal(c.pins().length, 0)
  })

  it("reports a failed pins.add and blocks nothing", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    c.fake.queue("pins.add", { error: "not_pinnable" })
    await api.queue("a", "claimed")
    const result = await api.run()
    assert.equal(result.status, "done")
    assert.equal(result.sent, 1)
    assert.deepEqual(await boardStatus(api.homeDir, CHANNEL), { posted: true, pinned: false, pinError: "not_pinnable" })
    // The board keeps working, and the pin is not tried again for it.
    api.state.lanes = [lane("a", { status: "needs-review" })]
    await api.queue("a", "sent-to-review")
    assert.equal((await api.run()).status, "done")
    assert.equal(c.boardUpdates().length, 1)
    assert.equal(c.pins().length, 1)
  })

  it("counts already_pinned as pinned", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    c.fake.queue("pins.add", { error: "already_pinned" })
    await api.queue("a", "claimed")
    assert.equal((await api.run()).status, "done")
    assert.deepEqual(await boardStatus(api.homeDir, CHANNEL), { posted: true, pinned: true, pinError: "" })
  })

  it("posts a new board and pins it when the old message is gone", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    await api.queue("a", "claimed")
    await api.run()
    const firstTs = (await getBoard(api.homeDir, CHANNEL)).ts
    // The card's refresh comes first and succeeds; the board's update finds
    // its message gone.
    c.fake.queue("chat.update", null, { error: "message_not_found" })
    api.state.lanes = [lane("a", { status: "needs-review" })]
    await api.queue("a", "sent-to-review")
    await api.run()
    const board = await getBoard(api.homeDir, CHANNEL)
    assert.notEqual(board.ts, firstTs)
    assert.equal(c.boardPosts().length, 2)
    assert.equal(c.pins().length, 2)
    assert.equal(c.pins()[1].body.timestamp, board.ts)
  })

  it("retries a failed board post on a later run with no new entry", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    await api.queue("a", "claimed")
    // The card post succeeds; the board post fails with a transient error.
    c.fake.queue("chat.postMessage", null, null, { error: "internal_error" })
    await api.run()
    assert.equal((await getBoard(api.homeDir, CHANNEL)).ts ?? "", "")
    c.clock.at += 5000
    await api.run()
    assert.ok((await getBoard(api.homeDir, CHANNEL)).ts)
    assert.equal(c.pins().length, 1)
  })

  it("keeps the last lines of a repository whose state cannot be read, marked not refreshed", async () => {
    const c = await channelFixture()
    const api = c.repo("api", { lanes: [lane("a")] })
    const web = c.repo("web", { lanes: [lane("b")] })
    await api.queue("a", "claimed")
    await api.run()
    c.clock.at += 2000
    await web.queue("b", "claimed")
    await web.run()

    api.state.readError = "handoff lock busy"
    c.clock.at += 2000
    await api.queue("a", "sent-to-review")
    assert.equal((await api.run()).status, "error")
    const stale = c.boardUpdates().at(-1).body.text
    assert.match(stale, /^board · dev: dev-a\napi \(not refreshed\)\n {2}lane a · in-progress/)
    assert.match(stale, /\nweb\n {2}lane b · in-progress/)

    // The other repository still updates the board.
    web.state.lanes = [lane("b", { status: "needs-review" })]
    c.clock.at += 2000
    await web.queue("b", "sent-to-review")
    assert.equal((await web.run()).status, "done")
    assert.match(c.boardUpdates().at(-1).body.text, /api \(not refreshed\)[\s\S]*lane b · needs-review/)

    // Once readable again, the mark goes.
    api.state.readError = null
    c.clock.at += 2000
    await api.run()
    assert.doesNotMatch(c.boardUpdates().at(-1).body.text, /not refreshed/)
  })
})

// codex-reviewer's repros on 02a50aa, committed before the fix.
describe("board work left by the budget or by another repository (codex-reviewer on 02a50aa)", () => {
  it("resumes a pin that the delivery budget deferred", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    await api.queue("a", "claimed")
    assert.equal((await api.run({ budgetMs: 2750 })).status, "budget")
    assert.equal(c.boardPosts().length, 1)
    assert.equal(c.pins().length, 0)
    c.clock.at += 5000
    await api.run()
    assert.equal(c.pins().length, 1, "the next run owes the unsent pin")
    // A pin that failed is not owed again.
    c.fake.queue("pins.add", { error: "not_pinnable" })
    c.fake.queue("chat.update", null, { error: "message_not_found" })
    api.state.lanes = [lane("a", { status: "needs-review" })]
    await api.queue("a", "sent-to-review")
    await api.run()
    assert.equal(c.pins().length, 2)
    c.clock.at += 5000
    await api.run()
    assert.equal(c.pins().length, 2, "a failed pin is reported, not retried")
  })

  it("retries board creation deferred by a short delivery budget", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    await api.queue("a", "claimed")
    assert.equal((await api.run({ budgetMs: 2000 })).status, "budget")
    c.clock.at += 5000
    await api.run()
    assert.equal(c.boardPosts().length, 1)
    assert.equal(c.pins().length, 1)
  })

  it("lets simultaneous first publishers create exactly one board", async () => {
    const c = await channelFixture()
    const api = c.repo("api")
    const web = c.repo("web")
    for (const repo of [api, web]) {
      await writeRepoEntry(repo.homeDir, CHANNEL, { repoPath: repo.repoPath, name: repo.name, lanes: repo.state.lanes })
    }
    await reserveChannelSend(api.homeDir, CHANNEL, { now: c.clock.at, intervalMs: 1000, waitMs: 5000 })
    // Both runs wait at once; the second wait releases them together.
    let waiting = 0
    let release
    const ready = new Promise((resolve) => { release = resolve })
    const sleep = async (ms) => {
      waiting += 1
      if (waiting <= 2) {
        if (waiting === 2) {
          c.clock.at += 2000
          release()
        }
        await ready
      } else c.clock.at += ms
    }
    const results = await Promise.all([api.run({ sleep }), web.run({ sleep })])
    assert.deepEqual(results.map((result) => result.status), ["done", "done"])
    assert.equal(c.boardPosts().length, 1, "one message per developer and channel")
    assert.match(c.boardPosts()[0].body.text, /api[\s\S]*web/, "the one board shows both repositories")
  })
})

describe("shared channels (T025)", () => {
  it("gives two repositories of one developer one board and separate threads", async () => {
    const c = await channelFixture()
    const api = c.repo("api", { lanes: [lane("a")] })
    const web = c.repo("web", { lanes: [lane("a")] })
    await api.queue("a", "claimed")
    await api.run()
    c.clock.at += 2000
    await web.queue("a", "claimed")
    await web.run()

    assert.equal(c.boardPosts().length, 1, "one board for the developer in the channel")
    assert.match(c.boardUpdates().at(-1).body.text, /^board · dev: dev-a\napi\n {2}lane a[^\n]*\nweb\n {2}lane a/)
    const cards = c.fake.calls.filter((call) => call.method === "chat.postMessage" && !call.body.thread_ts && !call.body.text.startsWith("board"))
    assert.equal(cards.length, 2, "each repository posts its own card for its lane a")
    const replies = c.fake.calls.filter((call) => call.method === "chat.postMessage" && call.body.thread_ts)
    assert.deepEqual(replies.map((call) => call.body.text), ["api · dev: dev-a · claude claimed lane a", "web · dev: dev-a · claude claimed lane a"])
    assert.notEqual(replies[0].body.thread_ts, replies[1].body.thread_ts, "separate threads")
  })

  it("gives two developer labels in one channel separate boards and threads", async () => {
    const c = await channelFixture()
    const dana = c.repo("api", { label: "dana", lanes: [lane("e")] })
    const lee = c.repo("api", { label: "lee", lanes: [lane("e")] })
    await dana.queue("e", "claimed")
    await dana.run()
    c.clock.at += 2000
    await lee.queue("e", "claimed")
    await lee.run()

    const boards = c.boardPosts().map((call) => call.body.text.split("\n")[0])
    assert.deepEqual(boards, ["board · dev: dana", "board · dev: lee"])
    assert.equal(c.pins().length, 2)
    assert.notEqual((await getBoard(dana.homeDir, CHANNEL)).ts, (await getBoard(lee.homeDir, CHANNEL)).ts)
    const replies = c.fake.calls.filter((call) => call.method === "chat.postMessage" && call.body.thread_ts)
    assert.deepEqual(replies.map((call) => call.body.text), ["api · dev: dana · claude claimed lane e", "api · dev: lee · claude claimed lane e"])
    assert.notEqual(replies[0].body.thread_ts, replies[1].body.thread_ts)
  })
})
