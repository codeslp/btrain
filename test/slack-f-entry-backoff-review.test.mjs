// Round-14 mutation pin from the codex-reviewer review of lane f at 4bfd44c:
// passes there, fails if the fresh entry's nextTryAt guard is removed (M12).

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


// M12 survived because rate-limit tests exercise the channel hold, not entry backoff.
test("M12: a transient reply waits for its persisted retry time across runs", async () => {
  const t = await setup()
  await setThread(t.slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  await writeEntry(t.slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } })
  const fake = createFakeSlack({ expectedToken: FAKE_BOT, now: () => t.clock.at })
  fake.queue("chat.postMessage", { error: "internal_error" })
  const first = await t.run(fake.fetch)
  assert.equal(first.deferred, 1)
  const before = fake.calls.length
  // Past channel pacing, but before the 30-second entry backoff.
  t.clock.at += 2000
  const second = await t.run(fake.fetch)
  assert.equal(fake.calls.length, before, "no retry before nextTryAt, even after the channel is free")
  assert.equal(second.deferred, 1)
  assert.equal((await listEntries(t.slackDir)).length, 1)
  t.clock.at += 60000
  const third = await t.run(fake.fetch)
  assert.equal(third.sent, 1)
  assert.equal((await listEntries(t.slackDir)).length, 0)
})
