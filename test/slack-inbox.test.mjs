// Spec 025 FR-11 and the plan's "Data model" through
// src/brain_train/slack/inbox.mjs (plan WS2, T013). Every file lives in a
// temporary directory standing in for `<BRAIN_TRAIN_HOME>/slack`.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  checkApprovalMinutes,
  emptyInbox,
  inboxPath,
  loadInbox,
  pruneInbox,
  recordResult,
  RESULTS_KEEP,
  writeInbox,
} from "../src/brain_train/slack/inbox.mjs"

const roots = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function slackDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "btrain-inbox-"))
  roots.push(root)
  return path.join(root, "slack")
}

const NOW = Date.parse("2026-11-24T12:00:00.000Z")
const ago = (ms) => new Date(NOW - ms).toISOString()
const HOUR = 60 * 60 * 1000

describe("loadInbox and writeInbox", () => {
  it("round-trips the state with mode 0600 and leaves no temporary file", () => {
    const dir = slackDir()
    const state = {
      ...emptyInbox(),
      channels: { C0000FAKE: { cursor: "1700000000.000100" } },
      handled: { "C0000FAKE:1700000050.000200": ago(1000) },
      proposals: { "C0000FAKE:1700000060.000300": { thread: "1700000000.000100", repo: "/work/btrain", canonical: "btrain> status", state: "pending", expiresAt: ago(-HOUR) } },
    }
    assert.equal(writeInbox(dir, state), true)
    assert.deepEqual(loadInbox(dir), { state, error: "" })
    if (process.platform !== "win32") assert.equal(fs.statSync(inboxPath(dir)).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(dir), ["inbox.json"])
  })

  it("reads a missing file as an empty state", () => {
    assert.deepEqual(loadInbox(slackDir()), { state: emptyInbox(), error: "" })
  })

  it("never reads a half-written temporary file", () => {
    const dir = slackDir()
    writeInbox(dir, { ...emptyInbox(), channels: { C0000FAKE: { cursor: "1.000001" } } })
    fs.writeFileSync(path.join(dir, ".inbox.json.999.abcdef.tmp"), '{"version": 1, "channels": {"C0000FA')
    assert.deepEqual(loadInbox(dir).state.channels, { C0000FAKE: { cursor: "1.000001" } })
  })

  it("reports a file that does not parse or has another version, and returns an empty state", () => {
    const dir = slackDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(inboxPath(dir), "{not json")
    assert.match(loadInbox(dir).error, /does not parse/)
    fs.writeFileSync(inboxPath(dir), JSON.stringify({ version: 2 }))
    assert.match(loadInbox(dir).error, /version 2/)
    assert.deepEqual(loadInbox(dir).state, emptyInbox())
  })

  it("renames nothing when beforeRename returns false, and removes the temporary file", () => {
    const dir = slackDir()
    writeInbox(dir, { ...emptyInbox(), channels: { C0000FAKE: { cursor: "1.000001" } } })
    let called = false
    const replaced = writeInbox(dir, { ...emptyInbox(), channels: { C0000FAKE: { cursor: "9.000001" } } }, {
      beforeRename() {
        called = true
        return false
      },
    })
    assert.equal(called, true)
    assert.equal(replaced, false)
    assert.equal(loadInbox(dir).state.channels.C0000FAKE.cursor, "1.000001")
    assert.deepEqual(fs.readdirSync(dir), ["inbox.json"])
  })

  it("calls beforeRename after the data is on disk, synchronously", () => {
    const dir = slackDir()
    let sawTemp = false
    writeInbox(dir, emptyInbox(), {
      beforeRename() {
        sawTemp = fs.readdirSync(dir).some((name) => name.endsWith(".tmp") && fs.readFileSync(path.join(dir, name), "utf8").includes('"version": 1'))
        return true
      },
    })
    assert.equal(sawTemp, true)
  })
})

describe("pruneInbox", () => {
  it("drops handled entries after 48 hours and window times after an hour", () => {
    const state = {
      ...emptyInbox(),
      handled: { "C:1": ago(47 * HOUR), "C:2": ago(49 * HOUR) },
      windows: {
        commands: { "/work/btrain": [ago(10 * 60 * 1000), ago(2 * HOUR)], "/old": [ago(3 * HOUR)] },
        retryReview: { "/work/btrain#e": [ago(61 * 60 * 1000)] },
        turns: [ago(1000), ago(HOUR + 1)],
      },
    }
    const pruned = pruneInbox(state, NOW)
    assert.deepEqual(Object.keys(pruned.handled), ["C:1"])
    assert.deepEqual(pruned.windows.commands, { "/work/btrain": [ago(10 * 60 * 1000)] })
    assert.deepEqual(pruned.windows.retryReview, {})
    assert.deepEqual(pruned.windows.turns, [ago(1000)])
    assert.equal(Object.keys(state.handled).length, 2, "the input is not changed")
  })

  it("keeps a pending proposal and drops a finished one 48 hours after it expired", () => {
    const state = {
      ...emptyInbox(),
      proposals: {
        "C:1": { state: "pending", expiresAt: ago(50 * HOUR) },
        "C:2": { state: "approved", expiresAt: ago(50 * HOUR) },
        "C:3": { state: "expired", expiresAt: ago(HOUR) },
      },
    }
    assert.deepEqual(Object.keys(pruneInbox(state, NOW).proposals).sort(), ["C:1", "C:3"])
  })
})

describe("recordResult", () => {
  it("keeps the last 20 results for each repository", () => {
    let state = emptyInbox()
    for (let index = 0; index < 25; index += 1) state = recordResult(state, "/work/btrain", { verb: "status", detail: `exit ${index}` })
    state = recordResult(state, "/work/other", { verb: "flush" })
    assert.equal(state.results["/work/btrain"].length, RESULTS_KEEP)
    assert.equal(state.results["/work/btrain"][0].detail, "exit 5")
    assert.equal(state.results["/work/other"].length, 1)
  })
})

describe("checkApprovalMinutes", () => {
  it("refuses approvalMinutes above 24 hours, and anything not a positive number", () => {
    assert.equal(checkApprovalMinutes(15), "")
    assert.equal(checkApprovalMinutes(1440), "")
    assert.match(checkApprovalMinutes(1500), /above 1440/)
    assert.match(checkApprovalMinutes(0), /positive/)
    assert.match(checkApprovalMinutes("soon"), /positive/)
  })
})
