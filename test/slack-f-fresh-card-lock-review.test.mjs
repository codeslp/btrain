// The gh-codex bot's two open P2 findings on PR #126 (lane f) at fa1ad9d, as
// failing tests committed before their fix.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { deliver, DELIVERY_LOCK_FILENAME } from "../src/brain_train/slack/deliver.mjs"
import { DELIVERY_STATE_FILENAME, listEntries, writeEntry } from "../src/brain_train/slack/outbox.mjs"
import { holdChannel, sendOnChannel, setThread, threadKey, CHANNELS_RELATIVE } from "../src/brain_train/slack/threads.mjs"
import { createFakeSlack } from "./helpers/fake-slack.mjs"

const FAKE_BOT = ["xoxb", "0000", "fake", "bot", "review"].join("-")
const CHANNEL = "C0000FAKE"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-bot-review-2-"))
  roots.push(root)
  return root
}

test("fresh-card reply keeps its entry when the delivery lock is lost", async () => {
  const root = await tempRoot()
  const slackDir = path.join(root, ".btrain", "slack")
  const lanes = [{ lane: "a", task: "Task A", owner: "claude", reviewer: "codex-reviewer", status: "needs-review", lockedFiles: [], lastUpdated: "claude 2026-11-23T21:00:00.000Z" }]
  await writeEntry(slackDir, { laneId: "a", claimKey: "claim-a", kind: "changes-requested", reply: true, fields: { actor: "claude", lane: "a" } })
  const stateFile = path.join(slackDir, DELIVERY_STATE_FILENAME)
  const replacement = JSON.stringify({ entries: {}, cards: {}, counters: { sent: 7, dropped: 0, collapsed: 0 }, paused: null, lastError: "" })
  const fake = createFakeSlack({
    expectedToken: FAKE_BOT,
    onCall: (call) => {
      if (call.method === "chat.postMessage" && call.body.thread_ts) {
        // While the reply is in flight, another process takes the lock over
        // and writes its own delivery state.
        writeFileSync(path.join(slackDir, DELIVERY_LOCK_FILENAME), "another-process-nonce", "utf8")
        writeFileSync(stateFile, replacement, "utf8")
      }
    },
  })
  const result = await deliver({
    slackDir,
    homeDir: path.join(root, "home"),
    repo: { name: "fixture-repo", path: root },
    channel: CHANNEL,
    token: FAKE_BOT,
    fetchImpl: fake.fetch,
    readLanes: async () => lanes,
  })
  assert.equal(await fs.readFile(stateFile, "utf8"), replacement, "the replacement's state is kept")
  assert.equal((await listEntries(slackDir)).length, 1, "the entry waits for the new holder")
  assert.equal(result.status, "lost-lock")
})

