// The gh-codex bot's two open P2 findings on PR #126 (lane f) at fa1ad9d, as
// failing tests committed before their fix.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deliver } from "../src/brain_train/slack/deliver.mjs"
import { DELIVERY_STATE_FILENAME, writeEntry } from "../src/brain_train/slack/outbox.mjs"
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

test("a card refresh owed by a sent reply is on disk before its outbox entry is removed", async (t) => {
  const root = await tempRoot()
  const slackDir = path.join(root, ".btrain", "slack")
  const lanes = [{ lane: "a", task: "Task A", owner: "claude", reviewer: "codex-reviewer", status: "needs-review", lockedFiles: [], lastUpdated: "claude 2026-11-23T21:00:00.000Z" }]
  await setThread(slackDir, "a", "claim-a", { channel: CHANNEL, cardTs: "1.1" })
  await writeEntry(slackDir, { laneId: "a", claimKey: "claim-a", kind: "needs-review", reply: true, fields: { actor: "claude", lane: "a" } })
  const fake = createFakeSlack({ expectedToken: FAKE_BOT })

  // The process stops for good right after the entry file is removed.
  const rm = fs.rm
  let removed
  const entryRemoved = new Promise((resolve) => { removed = resolve })
  fs.rm = async (target, ...rest) => {
    await rm(target, ...rest)
    if (String(target).includes(`${path.sep}outbox${path.sep}`)) {
      removed()
      return new Promise(() => {})
    }
  }
  t.after(() => { fs.rm = rm })

  deliver({
    slackDir,
    homeDir: path.join(root, "home"),
    repo: { name: "fixture-repo", path: root },
    channel: CHANNEL,
    token: FAKE_BOT,
    fetchImpl: fake.fetch,
    readLanes: async () => lanes,
  })
  await entryRemoved
  fs.rm = rm

  const stored = JSON.parse(await fs.readFile(path.join(slackDir, DELIVERY_STATE_FILENAME), "utf8").catch(() => "{}"))
  assert.ok(stored.cards?.[threadKey("a", "claim-a")], `the owed refresh survives the stop: ${JSON.stringify(stored)}`)
})

test("a sender whose home lock was superseded during the send keeps the new holder's channel records", async () => {
  const root = await tempRoot()
  const dir = path.join(root, "slack")
  const options = { now: Date.now, intervalMs: 1000, waitMs: 200 }
  const until = Date.now() + 120_000
  const sent = await sendOnChannel(root, "CFAKEA", options, async () => {
    // The send outlives the home-lock lease; another sender takes over and
    // records a 429 on another channel.
    const names = (await fs.readdir(dir)).filter((name) => name.startsWith("home.lock"))
    const stale = new Date(Date.now() - 60_000)
    for (const name of names) await fs.utimes(path.join(dir, name), stale, stale)
    await holdChannel(root, "CFAKEB", until, { waitMs: 200 })
    return { ok: true }
  })
  assert.equal(sent.result?.ok, true)
  const channels = JSON.parse(await fs.readFile(path.join(root, CHANNELS_RELATIVE), "utf8"))
  assert.equal(channels.CFAKEB?.retryUntil, until, `the replacement's Retry-After survives: ${JSON.stringify(channels)}`)
  assert.ok(channels.CFAKEA?.lastSentAt > 0, "the send itself is still recorded")
})
