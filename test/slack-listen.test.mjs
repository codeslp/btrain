// Spec 025 WS3 (T017-T019): the listener's poll cycle, `btrain slack listen`,
// stop, pause and resume, conversations, and the outbox drain. The listener
// runs in this process against the fake Slack of test/helpers/fake-slack.mjs,
// with an injected clock; the CLI cases start the real CLI with the fake
// preload. Every btrain home and repository is in a temporary directory. No
// test calls Slack or starts a model or a child command.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createFakeSlack, fakeSlackProcessEnv, FAKE_BOT_USER_ID } from "./helpers/fake-slack.mjs"
import { createListener, LISTEN_NOTES } from "../src/brain_train/slack/listen.mjs"
import { writeInbox, emptyInbox } from "../src/brain_train/slack/inbox.mjs"
import { requestStop, clearPaused, isPaused, leasePath } from "../src/brain_train/slack/lease.mjs"
import { writeEntry } from "../src/brain_train/slack/outbox.mjs"
import { REPLIES } from "../src/brain_train/slack/decide.mjs"
import { firstEventWith, installFakeOrchestratorRunner, readFakeOrchestratorRecords, writeFakeOrchestratorControl } from "./helpers/fake-orchestrator-runner.mjs"
import { PART_LABELS, orchestratorHeader } from "../src/brain_train/slack/snapshot.mjs"
import { RUN_REPLIES } from "../src/brain_train/slack/runner.mjs"
import { readRunnerCheck } from "../src/brain_train/slack/profile-check.mjs"

const exec = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(REPO_ROOT, "src/brain_train/cli.mjs")

const TOKEN = ["xoxb", "0000", "fake", "listen", "token"].join("-")
const OPERATOR = "U0000OPER"
const OTHER = "U0000OTHR"
const CHANNEL = "C0000FAKE"
const NOW = 1700000000 * 1000
const MINUTE = 60 * 1000
const tsAt = (ms) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`
const BOT_MENTION = `<@${FAKE_BOT_USER_ID}>`

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

function cleanEnv(home) {
  const env = { ...process.env, BRAIN_TRAIN_HOME: home, BTRAIN_DASHBOARD_DISABLED: "1" }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE", "BTRAIN_SLACK_BOT_TOKEN"]) delete env[key] // btrain-allow: env-var-required
  return env
}

// The runner every listener test names: the T002 fake `claude`, never the
// real CLI (spec 025: no test starts a real model). The listener runs its
// profile check against it when it starts.
async function fakeRunner(home) {
  const runner = await installFakeOrchestratorRunner(path.join(home, "fake-runner"))
  return `${runner.executable} -p`
}

async function writeSlackJson(home, repo, { operator = OPERATOR, orchestrator = {} } = {}) {
  await fs.mkdir(home, { recursive: true })
  const configPath = path.join(home, "slack.json")
  // pollSeconds 4: the outbox drain gets half of it, 2 seconds, enough for a
  // card and a reply at one message a second.
  const settings = { botToken: TOKEN, label: "test-dev", channels: { [repo]: CHANNEL }, pollSeconds: 4, orchestrator: { runner: await fakeRunner(home), ...orchestrator } }
  if (operator) settings.operator = operator
  await fs.writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(configPath, 0o600)
}

/** A btrain home and a repository with both toggles on, served on CHANNEL. */
async function createFixture({ operator = OPERATOR, orchestrator = {}, slackListen = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-listen-")))
  roots.push(root)
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  await fs.mkdir(home, { recursive: true })
  await exec("git", ["init", "-q", "-b", "main", repo])
  const env = cleanEnv(home)
  await exec("node", [CLI, "init", repo, "--tracked", "--core-only", "--agent", "claude", "--agent", "codex"], { cwd: repo, env })
  const tomlPath = path.join(repo, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  await fs.writeFile(tomlPath, `${toml.trimEnd()}\n\n[features]\nslack = true\nslack_listen = ${slackListen}\n`, "utf8")
  await writeSlackJson(home, repo, { operator, orchestrator })
  return { root, home, repo, env, slackDir: path.join(home, "slack") }
}

function clockAt(start = NOW) {
  const clock = { t: start, now: () => clock.t, advance: (ms) => { clock.t += ms } }
  return clock
}

async function listenerFor(fixture, fake, clock, extra = {}) {
  const lines = []
  const listener = await createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, now: clock.now, log: (line) => lines.push(line), ...extra })
  return { listener, lines }
}

const message = (user, ms, text, extra = {}) => ({ type: "message", user, ts: tsAt(ms), text, ...extra })

describe("spec 025 WS3: which messages the cycle acts on", () => {
  it("ignores other users, apps, and bots: no reply, no action, and a log line with no text", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [
      message(OTHER, NOW, "btrain> status"),
      message(OPERATOR, NOW + 1000, "btrain> status", { app_id: "A0000FAKE" }),
      message(OPERATOR, NOW + 2000, "btrain> status", { bot_id: "B0000FAKE" }),
    ])
    const { listener, lines } = await listenerFor(fixture, fake, clockAt(NOW + 3000))
    await listener.cycle()
    assert.deepEqual(fake.posts, [])
    const ignored = lines.filter((line) => /^ignored /.test(line))
    assert.equal(ignored.length, 3, JSON.stringify(lines))
    assert.ok(lines.every((line) => !line.includes("btrain> status")), "no message text in the log")
  })

  it("ignores a mention in a reply under a lane card and never reads that thread", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, `${BOT_MENTION} what is lane a doing?`, { thread_ts: tsAt(NOW - 5000) })])
    const clock = clockAt(NOW + 1000)
    const { listener } = await listenerFor(fixture, fake, clock)
    await listener.cycle()
    clock.advance(10_000)
    await listener.cycle()
    assert.deepEqual(fake.posts, [])
    assert.deepEqual(fake.callsTo("conversations.replies"), [])
  })

  it("does not act on a ts it already handled when a later read returns it again", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> status")])
    const clock = clockAt(NOW + 1000)
    const { listener } = await listenerFor(fixture, fake, clock)
    await listener.cycle()
    clock.advance(10_000)
    await listener.cycle()
    assert.equal(fake.callsTo("conversations.history").length, 2, "the overlap reads the message again")
    assert.equal(fake.posts.length, 1, "one reply")
    assert.equal(fake.posts[0].body.text, LISTEN_NOTES.commandsNotBuilt)
    assert.equal(fake.posts[0].body.thread_ts, tsAt(NOW), "in the message's thread")
  })

  it("answers a message first seen after its expiry once, also after a restart", async () => {
    const fixture = await createFixture({ orchestrator: { approvalMinutes: 15 } })
    const old = NOW - 20 * MINUTE
    writeInbox(fixture.slackDir, { ...emptyInbox(), channels: { [CHANNEL]: { cursor: tsAt(NOW - 30 * MINUTE) } } })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, old, "btrain> status")])
    const first = await listenerFor(fixture, fake, clockAt(NOW))
    await first.listener.cycle()
    assert.equal(fake.posts.length, 1)
    assert.equal(fake.posts[0].body.text, REPLIES.tooOld(15))
    const restarted = await listenerFor(fixture, fake, clockAt(NOW + 5000))
    await restarted.listener.cycle()
    assert.equal(fake.posts.length, 1, "no second reply after a restart")
  })

  it("keeps two operators with separate homes on one channel apart", async () => {
    const a = await createFixture()
    const homeB = path.join(a.root, "home-b")
    await fs.mkdir(homeB, { recursive: true })
    await fs.copyFile(path.join(a.home, "repos.json"), path.join(homeB, "repos.json"))
    await writeSlackJson(homeB, a.repo, { operator: OTHER })
    const b = { ...a, home: homeB, env: cleanEnv(homeB), slackDir: path.join(homeB, "slack") }
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> status"), message(OTHER, NOW + 1000, "btrain> status")])
    const listenerA = await listenerFor(a, fake, clockAt(NOW + 2000))
    const listenerB = await listenerFor(b, fake, clockAt(NOW + 2000))
    await listenerA.listener.cycle()
    await listenerB.listener.cycle()
    assert.deepEqual(fake.posts.map((post) => post.body.thread_ts), [tsAt(NOW), tsAt(NOW + 1000)], "each acts only on its own operator")
  })
})

describe("spec 025 WS3: conversations", () => {
  it("opens a thread on a typed mention, answers (here with the not-ready note: no profile check ran), reads it, and closes it after conversationMinutes", async () => {
    const fixture = await createFixture({ orchestrator: { conversationMinutes: 30 } })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} what is lane a doing?`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const clock = clockAt(NOW + 1000)
    const { listener } = await listenerFor(fixture, fake, clock)
    await listener.cycle()
    assert.equal(fake.posts.length, 1)
    assert.equal(fake.posts[0].body.thread_ts, tsAt(NOW))
    assert.equal(fake.posts[0].body.text, LISTEN_NOTES.profileNotReady)

    fake.replies(CHANNEL, tsAt(NOW), [parent, message(OPERATOR, NOW + 20_000, "and lane b?")])
    clock.advance(30_000)
    await listener.cycle()
    assert.ok(fake.callsTo("conversations.replies").length >= 1, "the open thread is read")
    assert.equal(fake.posts.length, 2, "the next turn gets the note too")

    clock.advance(31 * MINUTE)
    await listener.cycle()
    const repliesAfterClose = fake.callsTo("conversations.replies").length
    clock.advance(10_000)
    await listener.cycle()
    assert.equal(fake.callsTo("conversations.replies").length, repliesAfterClose, "a closed thread is not read")
  })
})

describe("spec 025 WS3: the lease, stop, pause, and resume (T017, T018)", () => {
  it("refuses a second listener for the same home and names the holder, in process and from the CLI", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const first = await listenerFor(fixture, fake, clockAt())
    assert.equal((await first.listener.acquire()).ok, true)
    const second = await listenerFor(fixture, fake, clockAt())
    const refused = await second.listener.acquire()
    assert.equal(refused.ok, false)
    assert.equal(refused.holder?.pid, process.pid)
    const cli = await exec("node", [CLI, "slack", "listen"], { cwd: fixture.repo, env: { ...fixture.env, ...fakeSlackProcessEnv({ logPath: path.join(fixture.root, "fake.jsonl"), expectedToken: TOKEN }) } })
      .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
    assert.equal(cli.code, 1)
    assert.match(cli.stderr, new RegExp(`process ${process.pid}`))
    await first.listener.stop()
  })

  it("ends on the stop flag and releases the lease", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const { listener } = await listenerFor(fixture, fake, clockAt())
    assert.equal((await listener.acquire()).ok, true)
    await requestStop(fixture.slackDir)
    const result = await listener.cycle()
    assert.equal(result.status, "stopped")
    assert.equal(fsSync.existsSync(leasePath(fixture.slackDir)), false, "the lease is released")
    assert.equal(fsSync.existsSync(path.join(fixture.slackDir, "listen.stop")), false, "the stop flag is consumed")
  })

  it("makes no read while paused, still drains the outbox, and ignores what was sent during the pause", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hello`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const clock = clockAt(NOW + 1000)
    const { listener } = await listenerFor(fixture, fake, clock)
    await listener.cycle()

    fake.replies(CHANNEL, tsAt(NOW), [parent, message(OPERATOR, NOW + 5000, "btrain> pause")])
    clock.advance(10_000)
    await listener.cycle()
    assert.equal(await isPaused(fixture.slackDir), true, "pause writes the flag")
    assert.ok(fake.posts.some((post) => post.body.text === REPLIES.paused))

    fake.history(CHANNEL, [parent, message(OPERATOR, NOW + 20_000, "btrain> status")])
    fake.replies(CHANNEL, tsAt(NOW), [parent, message(OPERATOR, NOW + 5000, "btrain> pause"), message(OPERATOR, NOW + 25_000, "are you there?")])
    await writeEntry(path.join(fixture.repo, ".btrain", "slack"), { laneId: "a", claimKey: "", kind: "claimed", reply: true, mention: false, fields: { actor: "claude", lane: "a" } })
    const reads = fake.callsTo("conversations.history").length + fake.callsTo("conversations.replies").length
    const posts = fake.posts.length
    clock.advance(20_000)
    await listener.cycle()
    assert.equal(fake.callsTo("conversations.history").length + fake.callsTo("conversations.replies").length, reads, "no read while paused")
    assert.ok(fake.posts.length > posts, "the outbox still drains")
    assert.ok(fake.posts.slice(posts).every((post) => post.body.text !== LISTEN_NOTES.commandsNotBuilt && post.body.text !== LISTEN_NOTES.profileNotReady))

    await clearPaused(fixture.slackDir)
    const beforeResume = fake.posts.length
    clock.advance(10_000)
    await listener.cycle()
    clock.advance(10_000)
    await listener.cycle()
    assert.ok(fake.callsTo("conversations.history").length > 0)
    assert.equal(fake.posts.length, beforeResume, "nothing sent during the pause is acted on, in the channel or the thread")
  })

  it("does not run a command that follows btrain> pause in the same read", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> pause"), message(OPERATOR, NOW + 1000, "btrain> status")])
    const { listener } = await listenerFor(fixture, fake, clockAt(NOW + 2000))
    await listener.cycle()
    assert.deepEqual(fake.posts.map((post) => post.body.text), [REPLIES.paused])
  })

  it("keeps its lease through a 90-second Retry-After and does not read before it", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.queue("conversations.history", { retryAfter: 90 })
    const clock = clockAt()
    const { listener } = await listenerFor(fixture, fake, clock)
    assert.equal((await listener.acquire()).ok, true)
    await listener.cycle()
    for (const step of [30_000, 30_000]) {
      clock.advance(step)
      await listener.cycle()
    }
    assert.equal(fake.callsTo("conversations.history").length, 1, "no read before Retry-After")
    const second = await listenerFor(fixture, fake, clock)
    assert.equal((await second.listener.acquire()).ok, false, "the lease is still held")
    clock.advance(31_000)
    await listener.cycle()
    assert.equal(fake.callsTo("conversations.history").length, 2, "read again after Retry-After")
    await listener.stop()
  })

  it("starts nothing and writes no state once its lease nonce is replaced", async () => {
    for (const when of ["before the cycle", "after the read"]) {
      const fixture = await createFixture()
      const fake = createFakeSlack({ expectedToken: TOKEN })
      fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> status")])
      const replace = () => fsSync.writeFileSync(leasePath(fixture.slackDir), JSON.stringify({ nonce: "another", pid: 1, operator: OPERATOR, startedAt: "x" }))
      const fetchImpl = async (input, init) => {
        if (when === "after the read" && String(input).includes("conversations.history")) replace()
        return fake.fetch(input, init)
      }
      const { listener } = await listenerFor(fixture, { ...fake, fetch: fetchImpl }, clockAt(NOW + 1000))
      assert.equal((await listener.acquire()).ok, true)
      if (when === "before the cycle") replace()
      const result = await listener.cycle()
      assert.equal(result.status, "lost-lease", when)
      assert.deepEqual(fake.posts, [], `${when}: nothing posted`)
      assert.equal(fsSync.existsSync(path.join(fixture.slackDir, "inbox.json")), false, `${when}: no state written`)
    }
  })

  it("does not act again on a message handled before 30 hours down, and refuses approvalMinutes above 24 hours", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> status")])
    await (await listenerFor(fixture, fake, clockAt(NOW + 1000))).listener.cycle()
    assert.equal(fake.posts.length, 1)
    const later = await listenerFor(fixture, fake, clockAt(NOW + 30 * 60 * MINUTE))
    await later.listener.cycle()
    assert.equal(fake.posts.length, 1, "no second reply")

    await writeSlackJson(fixture.home, fixture.repo, { orchestrator: { approvalMinutes: 1500 } })
    await assert.rejects(createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, now: () => NOW }), /approvalMinutes/)
  })
})

describe("spec 025 WS3: the outbox drain (T018)", () => {
  it("delivers a queued spec 024 entry within one cycle", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    await writeEntry(path.join(fixture.repo, ".btrain", "slack"), { laneId: "a", claimKey: "", kind: "claimed", reply: true, mention: false, fields: { actor: "claude", lane: "a" } })
    const { listener } = await listenerFor(fixture, fake, clockAt())
    await listener.cycle()
    assert.ok(fake.posts.some((post) => !post.body.thread_ts), "the lane card")
    assert.ok(fake.posts.some((post) => post.body.thread_ts && /claimed lane a/.test(post.body.text)), "the reply")
  })
})

describe("spec 025 WS3: btrain slack listen (T017)", () => {
  const runCli = (fixture, args, extraEnv = {}) => exec("node", [CLI, "slack", "listen", ...args], { cwd: fixture.repo, env: { ...fixture.env, ...extraEnv } })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" }))

  it("refuses to start with no operator or no served repository", async () => {
    const noOperator = await createFixture({ operator: "" })
    const refused = await runCli(noOperator, [])
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /operator/)
    const notServed = await createFixture({ slackListen: false })
    const none = await runCli(notServed, [])
    assert.equal(none.code, 1)
    assert.match(none.stderr, /no repository is served/)
  })

  it("--resume removes the pause flag and --stop with no listener exits 0", async () => {
    const fixture = await createFixture()
    await fs.mkdir(fixture.slackDir, { recursive: true })
    await fs.writeFile(path.join(fixture.slackDir, "listen.paused"), "")
    const resumed = await runCli(fixture, ["--resume"])
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.equal(await isPaused(fixture.slackDir), false)
    const stop = await runCli(fixture, ["--stop"])
    assert.equal(stop.code, 0, stop.stderr)
    assert.match(stop.stdout, /no listener is running/)
    assert.equal(fsSync.existsSync(path.join(fixture.slackDir, "listen.stop")), false, "no stop flag is left for a later listener")
  })

  it("runs in the foreground, prints no message text or token, and stops on --stop", { skip: process.platform === "win32" }, async () => {
    const fixture = await createFixture()
    const logPath = path.join(fixture.root, "fake.jsonl")
    const env = { ...fixture.env, ...fakeSlackProcessEnv({ logPath, expectedToken: TOKEN, script: { history: { [CHANNEL]: [message(OPERATOR, Date.now(), "btrain> status secret-words")] } } }) }
    const child = spawn("node", [CLI, "slack", "listen"], { cwd: fixture.repo, env })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)))
    for (let i = 0; i < 100 && !/serving/.test(output); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.match(output, new RegExp(`operator: ${OPERATOR}`))
    assert.match(output, new RegExp(`serving .*repo.* in ${CHANNEL}`))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const stop = await runCli(fixture, ["--stop"])
    assert.equal(stop.code, 0, stop.stderr)
    assert.equal(await exited, 0)
    assert.doesNotMatch(output, /secret-words/, "no message text")
    assert.ok(!output.includes(TOKEN), "no token")
  })
})

// codex-reviewer on 93f8cf3: state loaded before the lease, replies accepted
// after a conversation expired, and thread cursors with no 24-hour floor.
describe("spec 025 WS3: state and thread age across takeovers and restarts", () => {
  it("reads the state again when it takes the lease, so a replacement built earlier acts once", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> status")])
    const first = await listenerFor(fixture, fake, clockAt(NOW + 1000))
    const replacement = await listenerFor(fixture, fake, clockAt(NOW + 2000))
    assert.equal((await first.listener.acquire()).ok, true)
    await first.listener.cycle()
    await first.listener.stop()
    assert.equal(fake.posts.length, 1)
    assert.equal((await replacement.listener.acquire()).ok, true)
    await replacement.listener.cycle()
    await replacement.listener.stop()
    assert.equal(fake.posts.length, 1, "the replacement does not answer the handled message again")
  })

  it("does not answer a reply sent after the conversation expired", async () => {
    const fixture = await createFixture({ orchestrator: { conversationMinutes: 30 } })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hello`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const clock = clockAt(NOW + 1000)
    const { listener } = await listenerFor(fixture, fake, clock)
    await listener.cycle()
    assert.equal(fake.posts.length, 1)
    fake.replies(CHANNEL, tsAt(NOW), [parent, message(OPERATOR, NOW + 31 * MINUTE, "still there?")])
    clock.t = NOW + 31 * MINUTE + 10_000
    await listener.cycle()
    assert.equal(fake.posts.length, 1, "no answer after the expiry")
    const inbox = JSON.parse(await fs.readFile(path.join(fixture.slackDir, "inbox.json"), "utf8"))
    assert.deepEqual(Object.keys(inbox.threads), [], "the conversation is closed, not renewed")
  })

  it("never reads a thread from more than 24 hours back and closes a turn a crash left busy", async () => {
    const fixture = await createFixture()
    const parentTs = tsAt(NOW)
    const replyTs = tsAt(NOW + 1000)
    writeInbox(fixture.slackDir, {
      ...emptyInbox(),
      channels: { [CHANNEL]: { cursor: replyTs } },
      threads: { [`${CHANNEL}:${parentTs}`]: { lastOperatorTs: replyTs, replyCursor: replyTs, busy: true, queued: [], pending: null } },
      handled: { [`${CHANNEL}:${parentTs}`]: new Date(NOW).toISOString(), [`${CHANNEL}:${replyTs}`]: new Date(NOW + 1000).toISOString() },
    })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hello`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, parentTs, [parent, message(OPERATOR, NOW + 1000, "and lane b?")])
    const clock = clockAt(NOW + 49 * 60 * MINUTE)
    const { listener } = await listenerFor(fixture, fake, clock)
    await listener.cycle()
    clock.advance(10_000)
    await listener.cycle()
    assert.equal(fake.posts.length, 0, "nothing handled before the restart is answered again")
    const inbox = JSON.parse(await fs.readFile(path.join(fixture.slackDir, "inbox.json"), "utf8"))
    assert.deepEqual(Object.keys(inbox.threads), [], "the interrupted conversation is closed")
  })
})

// codex-reviewer on c24ade8: the lease was checked only at state writes and
// through a cached flag, so a takeover between two posts, or while the
// publisher read lane state, still let posts out. Each Slack call now checks
// the lease file itself.
describe("spec 025 WS3: every Slack call checks the lease first", () => {
  async function bareFixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-listen-lease-")))
    roots.push(root)
    const home = path.join(root, "home")
    const repo = path.join(root, "repo")
    await fs.mkdir(repo, { recursive: true })
    await writeSlackJson(home, repo)
    await fs.writeFile(path.join(home, "repos.json"), JSON.stringify({ repos: [{ path: repo, name: "repo" }] }))
    const readers = {
      readConfig: async () => ({ features: { slack: true, slack_listen: true } }),
      readRoster: async () => ({ laneIds: ["a"], agents: ["claude"] }),
      readLanes: async () => [],
    }
    const slackDir = path.join(home, "slack")
    const replace = () => fsSync.writeFileSync(leasePath(slackDir), JSON.stringify({ nonce: "replacement", pid: 1, operator: OPERATOR }))
    return { home, repo, slackDir, readers, replace, env: cleanEnv(home) }
  }

  it("posts no further reply once the lease is taken over during the first", async () => {
    const fixture = await bareFixture()
    const state = emptyInbox()
    for (const back of [1000, 2000]) {
      state.proposals[`${CHANNEL}:${tsAt(NOW - back)}`] = { state: "pending", thread: tsAt(NOW - back), expiresAt: new Date(NOW - 1000).toISOString(), canonical: "btrain> status", repo: fixture.repo }
    }
    writeInbox(fixture.slackDir, state)
    const fake = createFakeSlack({ expectedToken: TOKEN })
    let replaced = false
    const fetchImpl = async (input, init) => {
      const result = await fake.fetch(input, init)
      if (String(input).includes("chat.postMessage") && !replaced) {
        replaced = true
        fixture.replace()
      }
      return result
    }
    const listener = await createListener({ home: fixture.home, env: fixture.env, fetch: fetchImpl, readers: fixture.readers, now: () => NOW })
    assert.equal((await listener.acquire()).ok, true)
    await listener.cycle()
    assert.equal(fake.posts.length, 1, "no reply after the takeover")
  })

  it("lets no publisher post out once the lease is taken over while lane state is read", async () => {
    const fixture = await bareFixture()
    await writeEntry(path.join(fixture.repo, ".btrain", "slack"), { laneId: "a", claimKey: "", kind: "claimed", reply: true, mention: false, fields: { actor: "claude", lane: "a" } })
    fixture.readers.readLanes = async () => {
      fixture.replace()
      return []
    }
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const listener = await createListener({ home: fixture.home, env: fixture.env, fetch: fake.fetch, readers: fixture.readers, now: () => NOW })
    assert.equal((await listener.acquire()).ok, true)
    await listener.cycle()
    assert.equal(fake.posts.length, 0, "nothing published after the takeover")
  })

  it("keeps a pause across a restart and ignores what was sent during it", async () => {
    const fixture = await bareFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> pause")])
    const clock = clockAt(NOW + 1000)
    const options = { home: fixture.home, env: fixture.env, fetch: fake.fetch, readers: fixture.readers, now: clock.now }
    const first = await createListener(options)
    assert.equal((await first.acquire()).ok, true)
    await first.cycle()
    await first.stop()
    fake.history(CHANNEL, [message(OPERATOR, NOW + 10_000, "btrain> status")])
    const second = await createListener(options)
    assert.equal((await second.acquire()).ok, true)
    clock.t = NOW + 20_000
    await second.cycle()
    const count = fake.posts.length
    await clearPaused(fixture.slackDir)
    clock.t = NOW + 30_000
    await second.cycle()
    assert.equal(fake.posts.length, count)
    await second.stop()
  })
})

// codex-reviewer on f5995e5: an old cursor was clamped to now minus 24 hours
// again every cycle, so a read longer than one minute of budget restarted
// from its first page each minute and never finished.
describe("spec 025 WS3: a backlog longer than one minute of read budget", () => {
  it("finishes the read across cycles after clamping an old cursor, and answers the recent command", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-listen-backlog-")))
    roots.push(root)
    const home = path.join(root, "home")
    const repo = path.join(root, "repo")
    await writeSlackJson(home, repo)
    await fs.writeFile(path.join(home, "repos.json"), JSON.stringify({ repos: [{ path: repo, name: "repo" }] }))
    writeInbox(path.join(home, "slack"), { ...emptyInbox(), channels: { [CHANNEL]: { cursor: tsAt(NOW - 2 * 24 * 60 * MINUTE) } } })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, Array.from({ length: 6201 }, (_, index) => message(index === 0 ? OPERATOR : OTHER, NOW - index * 1000, index === 0 ? "btrain> status" : "irrelevant")))
    const clock = clockAt(NOW)
    const readers = {
      readConfig: async () => ({ features: { slack: true, slack_listen: true } }),
      readRoster: async () => ({ laneIds: [], agents: [] }),
      readLanes: async () => [],
    }
    const listener = await createListener({ home, env: cleanEnv(home), fetch: fake.fetch, now: clock.now, readers })
    assert.equal((await listener.acquire()).ok, true)
    try {
      await listener.cycle()
      assert.equal(fake.posts.length, 0, "the first cycle spends its budget before the read completes")
      clock.advance(60_000)
      await listener.cycle()
      assert.equal(fake.posts.length, 1, "the second cycle finishes the saved pages and answers the command")
      const calls = fake.callsTo("conversations.history")
      assert.ok(calls.slice(1).every((call) => call.body.oldest === calls[0].body.oldest), "the read keeps one lower bound while it is unfinished")
    } finally {
      await listener.stop()
    }
  })
})

// codex-reviewer on 82d6f4e: a resume moved only the cursors already saved,
// so a channel first read after the resume picked up pause-time messages
// through the read overlap.
describe("spec 025 WS3: a resume covers every served channel", () => {
  it("ignores a command sent during the pause in a channel not yet read when the pause came", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-listen-resume-")))
    roots.push(root)
    const home = path.join(root, "home")
    const repoA = path.join(root, "repo-a")
    const repoB = path.join(root, "repo-b")
    const channelB = "C0000FAKB"
    await fs.mkdir(home, { recursive: true })
    const configPath = path.join(home, "slack.json")
    await fs.writeFile(configPath, JSON.stringify({ botToken: TOKEN, operator: OPERATOR, channels: { [repoA]: CHANNEL, [repoB]: channelB }, pollSeconds: 4, orchestrator: { runner: await fakeRunner(home) } }), { mode: 0o600 })
    await fs.chmod(configPath, 0o600)
    await fs.writeFile(path.join(home, "repos.json"), JSON.stringify({ repos: [{ path: repoA, name: "repo-a" }, { path: repoB, name: "repo-b" }] }))
    const readers = {
      readConfig: async () => ({ features: { slack: true, slack_listen: true } }),
      readRoster: async () => ({ laneIds: ["a"], agents: ["claude"] }),
      readLanes: async () => [],
    }
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> pause")])
    const clock = clockAt(NOW + 1000)
    const listener = await createListener({ home, env: cleanEnv(home), fetch: fake.fetch, now: clock.now, readers })
    assert.deepEqual(listener.served.map((repo) => repo.channel), [CHANNEL, channelB])
    await listener.cycle()
    assert.deepEqual(fake.posts.map((post) => post.body.text), [REPLIES.paused])
    assert.equal(fake.callsTo("conversations.history").filter((call) => call.body.channel === channelB).length, 0, "the pause came before channel B was read")

    fake.history(channelB, [message(OPERATOR, NOW + 5000, "btrain> status")])
    await clearPaused(path.join(home, "slack"))
    clock.t = NOW + 10_000
    await listener.cycle()
    clock.advance(10_000)
    await listener.cycle()
    assert.ok(fake.callsTo("conversations.history").some((call) => call.body.channel === channelB), "channel B is read after the resume")
    assert.deepEqual(fake.posts.map((post) => post.body.text), [REPLIES.paused], "the command sent during the pause is not acted on")
  })
})

// codex-reviewer on 5421e42. Two channels, CHANNEL (repo a) and CHANNEL_B
// (repo b), each served, with stub readers.
const CHANNEL_B = "C0000FAKB"

async function twoChannelHome({ registered = ["a", "b"] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-listen-two-")))
  roots.push(root)
  const home = path.join(root, "home")
  const repos = { a: path.join(root, "repo-a"), b: path.join(root, "repo-b") }
  await fs.mkdir(home, { recursive: true })
  const configPath = path.join(home, "slack.json")
  await fs.writeFile(configPath, JSON.stringify({ botToken: TOKEN, operator: OPERATOR, channels: { [repos.a]: CHANNEL, [repos.b]: CHANNEL_B }, pollSeconds: 4, orchestrator: { runner: await fakeRunner(home) } }), { mode: 0o600 })
  await fs.chmod(configPath, 0o600)
  const register = (names) => fs.writeFile(path.join(home, "repos.json"), JSON.stringify({ repos: names.map((name) => ({ path: repos[name], name })) }))
  await register(registered)
  const readers = {
    readConfig: async () => ({ features: { slack: true, slack_listen: true } }),
    readRoster: async () => ({ laneIds: ["a"], agents: ["claude"] }),
    readLanes: async () => [],
  }
  return { root, home, repos, register, readers, slackDir: path.join(home, "slack"), env: cleanEnv(home) }
}

const historyOf = (fake, channel) => fake.callsTo("conversations.history").filter((call) => call.body.channel === channel).length

describe("spec 025 WS3: a read error stops the reads it affects at once", () => {
  for (const [error, histories, replies] of [["invalid_auth", 1, 0], ["missing_scope", 1, 0], ["not_in_channel", 2, 0], ["internal_error", 2, 1]]) {
    it(`a ${error} on a channel read (${histories} history, ${replies} thread reads this cycle)`, async () => {
      const home = await twoChannelHome()
      const threadTs = tsAt(NOW - 1000)
      writeInbox(home.slackDir, { ...emptyInbox(), threads: { [`${CHANNEL}:${threadTs}`]: { lastOperatorTs: threadTs, replyCursor: threadTs, busy: false, queued: [], pending: null } } })
      const fake = createFakeSlack({ expectedToken: TOKEN })
      fake.queue("conversations.history", { error })
      const listener = await createListener({ home: home.home, env: home.env, fetch: fake.fetch, now: () => NOW, readers: home.readers })
      assert.equal((await listener.acquire()).ok, true)
      try {
        await listener.cycle()
        assert.equal(fake.callsTo("conversations.history").length, histories, "history reads this cycle")
        assert.equal(fake.callsTo("conversations.replies").length, replies, "thread reads this cycle")
      } finally {
        await listener.stop()
      }
    })
  }

  for (const [error, replies, channelBRead] of [["invalid_auth", 1, false], ["not_in_channel", 1, true]]) {
    it(`a ${error} on the first of three thread reads stops the rest of that batch`, async () => {
      const home = await twoChannelHome()
      const threads = {}
      for (const back of [3000, 2000, 1000]) threads[`${CHANNEL}:${tsAt(NOW - back)}`] = { lastOperatorTs: tsAt(NOW - back), replyCursor: tsAt(NOW - back), busy: false, queued: [], pending: null }
      writeInbox(home.slackDir, { ...emptyInbox(), threads })
      const fake = createFakeSlack({ expectedToken: TOKEN })
      fake.queue("conversations.replies", { error })
      const listener = await createListener({ home: home.home, env: home.env, fetch: fake.fetch, now: () => NOW, readers: home.readers })
      assert.equal((await listener.acquire()).ok, true)
      try {
        await listener.cycle()
        assert.equal(fake.callsTo("conversations.replies").length, replies, "no thread read after the error")
        assert.equal(historyOf(fake, CHANNEL_B) > 0, channelBRead, "the other channel is read only after a channel error")
      } finally {
        await listener.stop()
      }
    })
  }
})

describe("spec 025 WS3: replies whose post failed (codex-reviewer M12-M14)", () => {
  it("M12: keeps the exact reply text across a restart and posts it on the retry", async () => {
    const fixture = await createFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [message(OPERATOR, NOW, "btrain> status")])
    fake.queue("chat.postMessage", { error: "internal_error" })
    await (await listenerFor(fixture, fake, clockAt(NOW + 1000))).listener.cycle()
    assert.equal(fake.posts.length, 1, "the first post failed")
    const restarted = await listenerFor(fixture, fake, clockAt(NOW + 40_000))
    await restarted.listener.cycle()
    assert.equal(fake.posts.length, 2, "the retry posted")
    assert.equal(fake.posts[1].body.text, LISTEN_NOTES.commandsNotBuilt)
    assert.equal(fake.posts[1].body.thread_ts, tsAt(NOW))
  })

  const seedOutgoing = (fixture, { nextTryAt, attempts = 1 }) => writeInbox(fixture.slackDir, {
    ...emptyInbox(),
    channels: { [CHANNEL]: { cursor: tsAt(NOW) } },
    outgoing: [{ channel: CHANNEL, thread: tsAt(NOW), text: "a queued reply", attempts, nextTryAt: new Date(nextTryAt).toISOString(), proposal: null }],
  })

  it("M13: does not retry before nextTryAt", async () => {
    const fixture = await createFixture()
    seedOutgoing(fixture, { nextTryAt: NOW + 30_000 })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const clock = clockAt(NOW + 29_000)
    const { listener } = await listenerFor(fixture, fake, clock)
    await listener.cycle()
    assert.equal(fake.posts.length, 0, "not before its time")
    clock.t = NOW + 30_000
    await listener.cycle()
    assert.deepEqual(fake.posts.map((post) => post.body.text), ["a queued reply"])
  })

  it("M14: drops a reply after five attempts and never makes a sixth", async () => {
    const fixture = await createFixture()
    seedOutgoing(fixture, { nextTryAt: NOW })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.setDefault("chat.postMessage", { error: "internal_error" })
    const clock = clockAt(NOW)
    const { listener } = await listenerFor(fixture, fake, clock)
    for (let index = 0; index < 8; index += 1) {
      await listener.cycle()
      clock.advance(10 * MINUTE)
    }
    assert.equal(fake.posts.length, 4, "attempts 2 to 5")
    const inbox = JSON.parse(await fs.readFile(path.join(fixture.slackDir, "inbox.json"), "utf8"))
    assert.deepEqual(inbox.outgoing, [])
  })
})

describe("spec 025 WS3: the registry and toggles are read again every sixth cycle (M15)", () => {
  it("starts reading a newly registered repository's channel and stops reading an unregistered one", async () => {
    const home = await twoChannelHome({ registered: ["a"] })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const clock = clockAt(NOW)
    const listener = await createListener({ home: home.home, env: home.env, fetch: fake.fetch, now: clock.now, readers: home.readers })
    const cycle = async () => {
      await listener.cycle()
      clock.advance(10_000)
    }
    for (let index = 0; index < 5; index += 1) await cycle()
    assert.equal(historyOf(fake, CHANNEL_B), 0)
    await home.register(["a", "b"])
    await cycle() // the sixth cycle reads the registry again
    await cycle()
    assert.ok(historyOf(fake, CHANNEL_B) > 0, "the newly registered repository's channel is read")

    await home.register(["b"])
    for (let index = 0; index < 5; index += 1) await cycle() // through the twelfth
    const readsOfA = historyOf(fake, CHANNEL)
    await cycle()
    await cycle()
    assert.equal(historyOf(fake, CHANNEL), readsOfA, "the unregistered repository's channel is no longer read")
  })
})

describe("spec 025 WS4 (T022): orchestrator turns", () => {
  // The fake runner of each fixture: run 0 is `--version`, run 1 the profile
  // check at start, and runs 2 and later are turns, which follow `turn`.
  const runnerOf = (fixture) => ({
    controlPath: path.join(fixture.home, "fake-runner", "control.json"),
    recordPath: path.join(fixture.home, "fake-runner", "record.jsonl"),
  })
  const setTurns = (fixture, turn, check = {}) => writeFakeOrchestratorControl(runnerOf(fixture), { runs: [{ raw: "9.9.9 (Claude Code)\n" }, check, turn] })
  const turnRecords = async (fixture) => (await readFakeOrchestratorRecords(runnerOf(fixture))).slice(2)

  async function started(fixture, fake, clock, extra) {
    const made = await listenerFor(fixture, fake, clock, extra)
    assert.equal((await made.listener.acquire()).ok, true)
    await made.listener.profileReady
    return made
  }

  // A cycle starts the turn; the next cycle, after the run ends, posts it.
  async function cycleThroughTurn(listener) {
    await listener.cycle()
    await listener.turnsSettled()
    await listener.cycle()
  }

  it("a typed mention starts one run with the snapshot input, and its reply is posted in the thread under the orchestrator header", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "Nothing is in review." })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} what is in review?`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    assert.equal(listener.profile.ok, true, listener.profile.reason)
    await cycleThroughTurn(listener)
    const turnPosts = fake.posts.filter((post) => post.body.thread_ts === tsAt(NOW))
    assert.equal(turnPosts.length, 1)
    assert.equal(turnPosts[0].body.text, `${orchestratorHeader("test-dev")}\nNothing is in review.`)
    const [record] = await turnRecords(fixture)
    assert.ok(record, "one turn ran")
    assert.ok(record.argv.includes("--disable-slash-commands"))
    assert.deepEqual(record.cwdListing, [])
    assert.match(record.stdin, /what is in review\?/)
    assert.ok(record.stdin.indexOf(PART_LABELS.message) > record.stdin.indexOf(PART_LABELS.lanes))
    assert.match(record.stdin, /repository repo \(repo=repo\)/)
    for (const name of record.envNames) assert.doesNotMatch(name, /KEY|TOKEN|BTRAIN|SLACK/)
    assert.ok(!record.stdin.includes(TOKEN), "the token is not in the input")
    await listener.stop()
  })

  it("a typed reply in the open thread starts the next run with no mention, and the input holds the earlier btrain reply", async () => {
    const fixture = await createFixture({ orchestrator: { conversationMinutes: 30 } })
    await setTurns(fixture, { reply: "OK" })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hello`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const clock = clockAt(NOW + 1000)
    const { listener } = await started(fixture, fake, clock)
    await cycleThroughTurn(listener)
    const botReply = { type: "message", user: FAKE_BOT_USER_ID, bot_id: "B0000FAKE", ts: tsAt(NOW + 5000), text: `${orchestratorHeader("test-dev")}\nOK` }
    fake.replies(CHANNEL, tsAt(NOW), [parent, botReply, message(OPERATOR, NOW + 20_000, "and lane b?")])
    clock.advance(30_000)
    await cycleThroughTurn(listener)
    const records = await turnRecords(fixture)
    assert.equal(records.length, 2)
    assert.match(records[1].stdin, /and lane b\?/)
    assert.match(records[1].stdin, /btrain: orchestrator · dev: test-dev/)
    await listener.stop()
  })

  it("a mention before the profile check has passed gets the not-ready note and starts no run", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "should not run" }, { firstEvent: firstEventWith({ skills: ["review"] }) })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hi`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    assert.equal(listener.profile.ok, false)
    await cycleThroughTurn(listener)
    assert.deepEqual(await turnRecords(fixture), [])
    assert.deepEqual(fake.posts.filter((post) => post.body.thread_ts === tsAt(NOW)).map((post) => post.body.text), [LISTEN_NOTES.profileNotReady])
    await listener.stop()
  })

  it("an ordinary run whose first event lists a tool is stopped, its output is not posted, the failure is saved, and no later run starts", async () => {
    const fixture = await createFixture({ orchestrator: { conversationMinutes: 30 } })
    await setTurns(fixture, { firstEvent: firstEventWith({ tools: ["Bash"] }), reply: "UNSAFE OUTPUT" })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hi`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const clock = clockAt(NOW + 1000)
    const { listener } = await started(fixture, fake, clock)
    await cycleThroughTurn(listener)
    const texts = fake.posts.map((post) => post.body.text)
    assert.ok(texts.every((text) => !text.includes("UNSAFE OUTPUT")))
    assert.ok(texts.some((text) => text.includes(RUN_REPLIES.failed)))
    assert.equal(listener.profile.ok, false)
    assert.equal(readRunnerCheck(fixture.slackDir).ok, false)
    fake.replies(CHANNEL, tsAt(NOW), [parent, message(OPERATOR, NOW + 20_000, "again")])
    clock.advance(30_000)
    await cycleThroughTurn(listener)
    assert.equal((await turnRecords(fixture)).length, 1, "no later run")
    assert.ok(fake.posts.some((post) => post.body.text === LISTEN_NOTES.profileNotReady))
    await listener.stop()
  })

  it("the listener completes a cycle while a run is in progress, and stop() ends the run", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { neverExit: true })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hi`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    await listener.cycle()
    let record
    for (let i = 0; i < 100 && !record; i += 1) {
      ;[record] = await turnRecords(fixture)
      if (!record) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(record, "the run started")
    const second = await listener.cycle()
    assert.equal(second.status, "ok", "a cycle completes during the run")
    const stopping = Date.now()
    await listener.stop()
    assert.ok(Date.now() - stopping < 5000)
    assert.throws(() => process.kill(record.pid, 0), "the run is gone")
  })

  it("a run past turnSeconds gets the timeout reply", async () => {
    const fixture = await createFixture({ orchestrator: { turnSeconds: 1 } })
    await setTurns(fixture, { neverExit: true })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hi`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    await cycleThroughTurn(listener)
    assert.ok(fake.posts.some((post) => post.body.text === `${orchestratorHeader("test-dev")}\n${RUN_REPLIES.timedOut}`), JSON.stringify(fake.posts.map((p) => p.body.text)))
    await listener.stop()
  })

  it("a reply with a token pattern, a mention, and a link is posted redacted and escaped", async () => {
    const fixture = await createFixture()
    const secret = ["AKIA", "ABCDEFGHIJKLMNOP"].join("")
    await setTurns(fixture, { reply: `key ${secret} for <@U0000OTHR> at https://example.test/x` })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hi`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    await cycleThroughTurn(listener)
    const [post] = fake.posts.filter((p) => p.body.thread_ts === tsAt(NOW))
    assert.ok(!post.body.text.includes(secret))
    assert.match(post.body.text, /\[redacted\]/)
    assert.ok(!post.body.text.includes("<@U0000OTHR>"))
    assert.ok(!post.body.text.includes("https://"))
    await listener.stop()
  })

  const waitFor = async (check) => {
    for (let i = 0; i < 200; i += 1) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error("wait timed out")
  }
  const turnReaders = (readLanes) => ({
    readConfig: async () => ({ features: { slack: true, slack_listen: true } }),
    readRoster: async () => ({ laneIds: [], agents: [] }),
    readLanes,
  })

  it("a lease lost while the input is built starts no run (codex-reviewer red team)", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "OK" })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} hi`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000), {
      readers: turnReaders(async () => {
        const file = leasePath(fixture.slackDir)
        const held = JSON.parse(await fs.readFile(file, "utf8"))
        await fs.writeFile(file, JSON.stringify({ ...held, nonce: "replacement" }))
        return []
      }),
    })
    try {
      await listener.cycle()
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 0, "no run after the lease is lost")
    } finally {
      await listener.stop()
    }
  })

  it("a profile failure while another turn's input is built stops that turn from starting (codex-reviewer red team)", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { firstEvent: firstEventWith({ tools: ["Bash"] }), reply: "unsafe" })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const a = message(OPERATOR, NOW, `${BOT_MENTION} A`)
    const b = message(OPERATOR, NOW + 100, `${BOT_MENTION} B`)
    fake.history(CHANNEL, [a, b])
    fake.replies(CHANNEL, a.ts, [a])
    fake.replies(CHANNEL, b.ts, [b])
    let listener
    let reads = 0
    const made = await started(fixture, fake, clockAt(NOW + 1000), {
      readers: turnReaders(async () => {
        reads += 1
        if (reads === 2) await waitFor(() => !listener.profile.ok)
        return []
      }),
    })
    listener = made.listener
    try {
      await listener.cycle()
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 1, "only the first, failing run starts")
    } finally {
      await listener.stop()
    }
  })

  it("a queued turn does not start while the listener is paused (codex-reviewer red team)", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "OK", delayMs: 150 })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const a = message(OPERATOR, NOW, `${BOT_MENTION} A`)
    const b = message(OPERATOR, NOW + 100, "B")
    const pause = message(OPERATOR, NOW + 200, "btrain> pause")
    fake.history(CHANNEL, [a])
    fake.replies(CHANNEL, a.ts, [a, b, pause])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    try {
      await listener.cycle()
      assert.equal(await isPaused(fixture.slackDir), true)
      await listener.turnsSettled()
      await listener.cycle()
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 1, "the queued B does not run while paused")
    } finally {
      await listener.stop()
    }
  })

  it("a newest message missing from the fetched thread starts no run (codex-reviewer M9)", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "OK" })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} missing`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, parent.ts, [])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    try {
      await cycleThroughTurn(listener)
      assert.equal((await turnRecords(fixture)).length, 0)
    } finally {
      await listener.stop()
    }
  })

  it("four threads start at most three runs, and the fourth waits for one to end", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "OK", delayMs: 300 })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parents = Array.from({ length: 4 }, (_, i) => message(OPERATOR, NOW + i * 100, `${BOT_MENTION} thread ${i}`))
    fake.history(CHANNEL, parents)
    for (const parent of parents) fake.replies(CHANNEL, parent.ts, [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    try {
      await listener.cycle()
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 3)
      await listener.cycle()
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 4)
    } finally {
      await listener.stop()
    }
  })

  it("a second message in one thread waits for the first reply", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "OK", delayMs: 300 })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} first`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, parent.ts, [parent, message(OPERATOR, NOW + 100, "second")])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    try {
      await listener.cycle()
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 1)
      await listener.cycle()
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 2)
    } finally {
      await listener.stop()
    }
  })

  it("maxTurnsPerHour also refuses a queued turn", async () => {
    const fixture = await createFixture({ orchestrator: { maxTurnsPerHour: 1 } })
    await setTurns(fixture, { reply: "OK", delayMs: 300 })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} first`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, parent.ts, [parent, message(OPERATOR, NOW + 100, "second")])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    try {
      await cycleThroughTurn(listener)
      await listener.turnsSettled()
      assert.equal((await turnRecords(fixture)).length, 1)
    } finally {
      await listener.stop()
    }
  })

  it("a proposal in the reply is not run: the prose is posted with a not-built-yet note", async () => {
    const fixture = await createFixture()
    await setTurns(fixture, { reply: "Here is a plan.\nbtrain> status" })
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const parent = message(OPERATOR, NOW, `${BOT_MENTION} refresh?`)
    fake.history(CHANNEL, [parent])
    fake.replies(CHANNEL, tsAt(NOW), [parent])
    const { listener } = await started(fixture, fake, clockAt(NOW + 1000))
    await cycleThroughTurn(listener)
    const texts = fake.posts.filter((p) => p.body.thread_ts === tsAt(NOW)).map((p) => p.body.text)
    assert.equal(texts.length, 1)
    assert.match(texts[0], /Here is a plan\./)
    assert.ok(texts[0].includes(LISTEN_NOTES.proposalsNotBuilt))
    assert.ok(!texts[0].includes("btrain> status"))
    await listener.stop()
  })
})
