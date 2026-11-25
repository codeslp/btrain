// Reviewer attack: loss of the delivery lock during a card refresh.
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

test("a superseded sender does not delete the new holder's thread after a failed card update", async () => {
  const t = await setup()
  await setThread(t.slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  await writeEntry(t.slackDir, { laneId: "a", claimKey: "claim-a", kind: "card-refresh", reply: false })
  const fake = createFakeSlack({
    expectedToken: FAKE_BOT,
    now: () => t.clock.at,
    onCall: (call) => {
      if (call.method === "chat.update") {
        writeFileSync(path.join(t.slackDir, DELIVERY_LOCK_FILENAME), "replacement-nonce", "utf8")
        writeFileSync(path.join(t.slackDir, "threads.json"), JSON.stringify({
          [threadKey("a", "claim-a")]: { channel: CHANNEL, cardTs: "9.9" },
        }), "utf8")
      }
    },
  })
  fake.queue("chat.update", { error: "message_not_found" })
  const result = await t.run(fake.fetch)
  assert.deepEqual(await getThread(t.slackDir, "a", "claim-a"), { channel: CHANNEL, cardTs: "9.9" }, "a superseded sender must preserve the replacement thread")
  assert.equal(result.status, "lost-lock")
})
