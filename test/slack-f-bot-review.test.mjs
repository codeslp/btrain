// The two P2 findings of the gh-codex bot on PR #126 (lane f), as failing
// tests committed before their fix.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { deliver, DELIVERY_LOCK_FILENAME } from "../src/brain_train/slack/deliver.mjs"
import { listEntries, writeEntry } from "../src/brain_train/slack/outbox.mjs"
import { getThread, setThread, threadKey } from "../src/brain_train/slack/threads.mjs"
import { createFakeSlack } from "./helpers/fake-slack.mjs"

const FAKE_BOT = ["xoxb", "0000", "fake", "bot", "review"].join("-")
const CHANNEL = "C0000FAKE"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-bot-review-"))
  roots.push(root)
  const slackDir = path.join(root, ".btrain", "slack")
  const clock = { at: Date.now() }
  const lanes = [{ lane: "a", task: "Task A", owner: "claude", reviewer: "codex-reviewer", status: "needs-review", lockedFiles: [], lastUpdated: "claude 2026-11-23T21:00:00.000Z" }]
  const run = (fetchImpl) => deliver({
    slackDir,
    homeDir: path.join(root, "home"),
    repo: { name: "fixture-repo", path: root },
    channel: CHANNEL,
    token: FAKE_BOT,
    fetchImpl,
    readLanes: async () => lanes,
    now: () => clock.at,
    sleep: async (ms) => { clock.at += ms },
  })
  return { root, slackDir, clock, lanes, run }
}

test("a reply Slack refuses still leaves the card refresh owed (FR-6)", async () => {
  const t = await setup()
  await setThread(t.slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  t.lanes[0].status = "changes-requested"
  await writeEntry(t.slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } })
  const fake = createFakeSlack({ expectedToken: FAKE_BOT, now: () => t.clock.at })
  fake.queue("chat.postMessage", { error: "msg_too_long" })
  const first = await t.run(fake.fetch)
  assert.equal(first.dropped, 1)
  t.clock.at += 60_000
  await t.run(fake.fetch)
  const update = fake.calls.find((call) => call.method === "chat.update")
  assert.ok(update, "the card is refreshed although its reply was dropped")
  assert.match(update.body.text, /lane a · changes-requested/)
})

test("a sender that lost its delivery lock while posting a card does not save the thread", async () => {
  const t = await setup()
  await writeEntry(t.slackDir, { laneId: "a", claimKey: "claim-a", kind: "claimed", reply: true, fields: { actor: "claude", lane: "a" } })
  const lockFile = path.join(t.slackDir, DELIVERY_LOCK_FILENAME)
  const threadsFile = path.join(t.slackDir, "threads.json")
  const fake = createFakeSlack({
    expectedToken: FAKE_BOT,
    now: () => t.clock.at,
    onCall: (call) => {
      if (call.method === "chat.postMessage" && !call.body.thread_ts) {
        // While the card post is in flight, another process takes the lock
        // over and records its own card for the same lane task.
        writeFileSync(lockFile, "another-process-nonce", "utf8")
        writeFileSync(threadsFile, JSON.stringify({ [threadKey("a", "claim-a")]: { channel: CHANNEL, cardTs: "9.9" } }), "utf8")
      }
    },
  })
  const result = await t.run(fake.fetch)
  assert.equal(result.status, "lost-lock")
  assert.deepEqual(await getThread(t.slackDir, "a", "claim-a"), { channel: CHANNEL, cardTs: "9.9" }, "the replacement's thread is kept")
  assert.equal((await listEntries(t.slackDir)).length, 1, "the entry waits for the new holder")
})
