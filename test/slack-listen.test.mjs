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

async function writeSlackJson(home, repo, { operator = OPERATOR, orchestrator = {} } = {}) {
  await fs.mkdir(home, { recursive: true })
  const configPath = path.join(home, "slack.json")
  // pollSeconds 4: the outbox drain gets half of it, 2 seconds, enough for a
  // card and a reply at one message a second.
  const settings = { botToken: TOKEN, label: "test-dev", channels: { [repo]: CHANNEL }, pollSeconds: 4, orchestrator: { runner: "claude -p", ...orchestrator } }
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
  it("opens a thread on a typed mention, answers with the model note, reads it, and closes it after conversationMinutes", async () => {
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
    assert.equal(fake.posts[0].body.text, LISTEN_NOTES.modelNotBuilt)

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
    assert.ok(fake.posts.slice(posts).every((post) => post.body.text !== LISTEN_NOTES.commandsNotBuilt && post.body.text !== LISTEN_NOTES.modelNotBuilt))

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
