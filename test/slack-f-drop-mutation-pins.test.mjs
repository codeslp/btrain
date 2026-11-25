// Reviewer attack: loss of the delivery lock during a card refresh.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { deliver, DELIVERY_LOCK_FILENAME } from "../src/brain_train/slack/deliver.mjs"
import { listEntries, writeEntry, emptyDeliveryState, writeDeliveryState } from "../src/brain_train/slack/outbox.mjs"
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

// M4 survived because the existing unknown-error test checked removal only.
test("M4: an exhausted unknown reply still refreshes the existing card", async () => {
  const t = await setup()
  await setThread(t.slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  const { entry } = await writeEntry(t.slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } })
  const state = emptyDeliveryState()
  state.entries[entry.id] = { attempts: 4, unknownAttempts: 4 }
  await writeDeliveryState(t.slackDir, state)
  const fake = createFakeSlack({ expectedToken: FAKE_BOT, now: () => t.clock.at })
  fake.queue("chat.postMessage", { error: "new_unknown_error" })
  const result = await t.run(fake.fetch)
  assert.equal(result.dropped, 1)
  assert.ok(fake.calls.some(call => call.method === "chat.update"), "the dropped reply must leave a card update")
})

// M5 survived because collapsed-reply tests did not drop their reply.
test("M5: a refused collapsed reply still refreshes the existing card", async () => {
  const t = await setup()
  await setThread(t.slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  await writeEntry(t.slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } }, { now: () => t.clock.at - 25 * 60 * 60 * 1000 })
  const fake = createFakeSlack({ expectedToken: FAKE_BOT, now: () => t.clock.at })
  fake.queue("chat.postMessage", { error: "msg_too_long" })
  const result = await t.run(fake.fetch)
  assert.equal(result.dropped, 1)
  assert.ok(fake.calls.some(call => call.method === "chat.update"), "the dropped collapse must leave a card update")
})
