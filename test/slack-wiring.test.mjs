// Spec 024 WS4 (T016-T021): the publisher wired into the lane commands. Each
// test drives the real CLI in a temporary repository with the fake Slack
// preload (test/helpers/slack-cli-repo.mjs). No test calls Slack or starts a
// real model.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import {
  CHANNEL,
  claimArgs,
  createSlackRepo,
  needsReviewArgs,
  OPERATOR,
  outboxFiles,
  withDeliveryHeld,
} from "./helpers/slack-cli-repo.mjs"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

const repoWith = (options = {}) => createSlackRepo({ ...options, roots })
const linesMatching = (text, pattern) => text.split("\n").filter((line) => pattern.test(line))
const THREAD_GUIDANCE = "btrain posts lane status; post in this thread only to ask the operator a question or report a blocker"

describe("spec 024 WS4: a failed reviewer dispatch (T016)", () => {
  it("prints the dispatch error before the first Slack call and posts dispatch-failed with a mention", async () => {
    const fixture = await repoWith()
    const runner = path.join(fixture.root, "fail-reviewer.sh")
    await fs.writeFile(runner, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    const tomlPath = path.join(fixture.repo, ".btrain", "project.toml")
    const toml = await fs.readFile(tomlPath, "utf8")
    await fs.writeFile(tomlPath, toml.replace(/^"codex" = .*$/m, `"codex" = "${runner}"`))

    assert.equal((await withDeliveryHeld(fixture, () => fixture.btrain(claimArgs()))).code, 0)
    const result = await fixture.btrain(needsReviewArgs("a", { dispatch: true }))
    assert.notEqual(result.code, 0, "a failed dispatch fails the command")
    assert.match(result.stderr, /Reviewer dispatch failed/)

    const calls = fixture.calls()
    assert.ok(calls.length > 0, "the queue is delivered after the error")
    assert.equal(calls[0].outputBefore.stderr, Buffer.byteLength(result.stderr), "the error is printed before the first call")
    assert.equal(calls[0].outputBefore.stdout, Buffer.byteLength(result.stdout))
    const failed = calls.find((call) => call.method === "chat.postMessage" && /reviewer dispatch failed/.test(call.body.text || ""))
    assert.ok(failed, "a dispatch-failed reply is posted")
    assert.ok(failed.body.thread_ts, "in the lane's thread")
    assert.match(failed.body.text, new RegExp(`<@${OPERATOR}>`), "it mentions the operator until spec 023 handles a failed dispatch")
  })
})

describe("spec 024 WS4: delivery never changes a command's result (T017)", () => {
  for (const [label, outcome] of [["a failing fetch", { network: true }], ["a hanging fetch", { hang: true, ignoreAbort: true }]]) {
    it(`${label} leaves the output and exit code alone and keeps the entry queued`, async () => {
      const fixture = await repoWith()
      const result = await fixture.btrain(claimArgs(), { script: { defaults: { "*": outcome } } })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.killed, false)
      assert.deepEqual(linesMatching(`${result.stdout}\n${result.stderr}`, /slack/i), [], "no publisher line")
      assert.equal(result.stderr, "", "nothing on stderr")
      assert.match(result.stdout, /status: in-progress/)
      assert.ok(result.ms < 2000 + 5000, `the claim took ${result.ms} ms`)
      assert.ok(fixture.calls().length > 0, "delivery was attempted")
      assert.ok((await outboxFiles(fixture)).length > 0, "the claim stays queued")
    })
  }

  it("prints exactly one warning line while the publisher is paused", async () => {
    const fixture = await repoWith()
    const script = { defaults: { "*": { error: "invalid_auth" } } }
    const claim = await fixture.btrain(claimArgs(), { script })
    assert.equal(claim.code, 0, claim.stderr)
    assert.equal(linesMatching(claim.stderr, /paused/).length, 1, "the run that paused warns once")

    const callsBefore = fixture.calls().length
    const show = await fixture.btrain(["handoff", "--lane", "a"])
    assert.equal(show.code, 0, show.stderr)
    const warnings = linesMatching(`${show.stdout}\n${show.stderr}`, /paused/)
    assert.equal(warnings.length, 1, `one warning line, got ${JSON.stringify(warnings)}`)
    assert.match(warnings[0], /invalid_auth/)
    assert.match(warnings[0], /btrain slack test/)
    assert.ok(show.stderr.endsWith(`${warnings[0]}\n`), "after the command's own output")
    assert.equal(fixture.calls().length, callsBefore, "a paused publisher calls nothing")
  })
})

describe("spec 024 WS4: btrain slack flush and refresh (T018)", () => {
  it("flush drains the queue and prints counts", async () => {
    const fixture = await repoWith()
    await withDeliveryHeld(fixture, () => fixture.btrain(claimArgs()))
    assert.ok((await outboxFiles(fixture)).length > 0)
    const flush = await fixture.btrain(["slack", "flush"])
    assert.equal(flush.code, 0, flush.stderr)
    assert.match(flush.stdout, /sent 1\b/)
    assert.match(flush.stdout, /dropped 0\b/)
    assert.deepEqual(await outboxFiles(fixture), [], "nothing is left queued")
    assert.ok(fixture.calls().some((call) => call.method === "chat.postMessage"))
  })

  it("flush and refresh exit 0 and call nothing with the toggle off", async () => {
    const fixture = await repoWith({ toggle: "off" })
    for (const sub of ["flush", "refresh"]) {
      const result = await fixture.btrain(["slack", sub])
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /off/)
    }
    assert.deepEqual(fixture.calls(), [])
  })
})

describe("spec 024 WS4: btrain doctor (T019)", () => {
  it("reports the toggle on with no token", async () => {
    const fixture = await repoWith({ token: false })
    const doctor = await fixture.btrain(["doctor"])
    assert.match(doctor.stdout, /slack: the publisher is on but has no token/)
  })

  it("reports the toggle on with no channel", async () => {
    const fixture = await repoWith({ channel: false })
    const doctor = await fixture.btrain(["doctor"])
    assert.match(doctor.stdout, /slack: the publisher is on but no channel is mapped/)
  })

  it("reports a paused publisher", async () => {
    const fixture = await repoWith()
    await fixture.btrain(claimArgs(), { script: { defaults: { "*": { error: "channel_not_found" } } } })
    const doctor = await fixture.btrain(["doctor"])
    assert.match(doctor.stdout, /slack: the publisher is paused \(channel_not_found\)/)
  })

  it("reports an oldest entry over an hour old", async () => {
    const fixture = await repoWith()
    await withDeliveryHeld(fixture, async () => {
      assert.equal((await fixture.btrain(claimArgs())).code, 0)
      const [file] = await outboxFiles(fixture)
      const entry = JSON.parse(await fs.readFile(file, "utf8"))
      entry.queuedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      await fs.writeFile(file, JSON.stringify(entry))
      const doctor = await fixture.btrain(["doctor"])
      assert.match(doctor.stdout, /slack: the oldest queued entry is 2h \d+m old/)
    })
  })

  it("reports nothing for a healthy publisher or with the toggle off", async () => {
    for (const toggle of ["on", "off"]) {
      const fixture = await repoWith({ toggle })
      const doctor = await fixture.btrain(["doctor"])
      assert.deepEqual(linesMatching(doctor.stdout, /^\s*.*slack: /), [], `${toggle}: no slack finding`)
    }
  })
})

describe("spec 024 WS4: the thread line of FR-12 (T020)", () => {
  it("btrain handoff shows the lane's thread; pr and status commands do not", async () => {
    const fixture = await repoWith()
    assert.equal((await fixture.btrain(claimArgs())).code, 0)
    const card = fixture.calls().find((call) => call.method === "chat.postMessage" && !call.body.thread_ts)
    assert.ok(card?.result?.ts, "the claim posted a card")

    const show = await fixture.btrain(["handoff", "--lane", "a"])
    const threadLines = linesMatching(show.stdout, /^slack thread: /)
    assert.deepEqual(threadLines, [`slack thread: ${CHANNEL} ${card.result.ts} · ${THREAD_GUIDANCE}`])

    const idle = await fixture.btrain(["handoff", "--lane", "b"])
    assert.deepEqual(linesMatching(idle.stdout, /slack thread/), [], "a lane with no thread shows none")
    for (const args of [["pr", "status", "--lane", "a"], ["status"]]) {
      const result = await fixture.btrain(args)
      assert.deepEqual(linesMatching(`${result.stdout}\n${result.stderr}`, /slack thread/), [], `${args.join(" ")} shows no thread line`)
    }
  })
})
