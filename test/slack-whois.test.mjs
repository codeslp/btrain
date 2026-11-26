// Spec 025 T015: `btrain slack whois` and the pr-poll predicate the listener's
// `poll-pr` verb uses. whois prints author fields only, never message text.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import { fakeSlackProcessEnv, readFakeSlackLog } from "./helpers/fake-slack.mjs"
import { enteredByPrPoll } from "../src/brain_train/slack/pr-poll.mjs"
import { runSlackCommand } from "../src/brain_train/slack/cli.mjs"
import { buildSlackReaders, readEnteredByPrPoll } from "../src/brain_train/slack-readers.mjs"
import { appendWorkflowEvent, getLaneConfigs, getRepoPaths, readProjectConfig } from "../src/brain_train/core.mjs"

const exec = promisify(execFile)
const CLI = path.resolve("src/brain_train/cli.mjs")
const TOKEN = ["xoxb", "0000", "fake", "whois", "token"].join("-")
const CHANNEL = "C0000FAKE"
const OTHER = "C0001FAKE"
const SECRET_TEXT = "never print this message text"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-whois-")))
  roots.push(root)
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  const logPath = path.join(root, "fake-calls.jsonl")
  await fs.mkdir(home, { recursive: true })
  await exec("git", ["init", "-q", repo])
  const baseEnv = { ...withoutLaneScope(), BRAIN_TRAIN_HOME: home, BTRAIN_AGENT: "claude", BTRAIN_DASHBOARD_DISABLED: "1" }
  delete baseEnv.BTRAIN_SLACK_BOT_TOKEN
  const run = (args, { script } = {}) => new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { cwd: repo, env: { ...baseEnv, ...fakeSlackProcessEnv({ logPath, script, expectedToken: TOKEN }) } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end()
  })
  assert.equal((await run(["init", repo, "--agent", "claude", "--agent", "codex", "--tracked", "--core-only", "--no-hooks"])).code, 0)
  const writeSettings = async (settings) => {
    const file = path.join(home, "slack.json")
    await fs.writeFile(file, JSON.stringify(settings), { mode: 0o600 })
    await fs.chmod(file, 0o600)
  }
  return { repo, run, writeSettings, calls: () => readFakeSlackLog(logPath) }
}

// Twelve messages, newest last, with every author shape the listener sees.
function messages() {
  const list = []
  for (let i = 0; i < 12; i += 1) {
    const ts = `1700000${String(i).padStart(3, "0")}.000100`
    const shapes = [
      { user: "U0000FAKE", client_msg_id: "00000000-0000-0000-0000-000000000000" },
      { user: "U0000FAKE", app_id: "A0000FAKE" },
      { bot_id: "B0000FAKE", app_id: "A0000FAKE", subtype: "bot_message" },
    ]
    list.push({ type: "message", ts, text: `${SECRET_TEXT} ${i}`, ...shapes[i % shapes.length] })
  }
  return list
}

describe("btrain slack whois (spec 025 T015)", () => {
  it("prints the author fields of the last ten messages, newest first, and no text", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    const result = await f.run(["slack", "whois"], { script: { history: { [CHANNEL]: messages() } } })
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stdout, new RegExp(SECRET_TEXT))
    assert.doesNotMatch(result.stderr, new RegExp(SECRET_TEXT))
    const rows = result.stdout.split("\n").filter((line) => line.startsWith("ts="))
    assert.equal(rows.length, 10)
    assert.equal(rows[0], "ts=1700000011.000100 user=- bot_id=B0000FAKE app_id=A0000FAKE client_msg_id=no subtype=bot_message")
    assert.equal(rows[1], "ts=1700000010.000100 user=U0000FAKE bot_id=- app_id=A0000FAKE client_msg_id=no subtype=-")
    assert.equal(rows[2], "ts=1700000009.000100 user=U0000FAKE bot_id=- app_id=- client_msg_id=yes subtype=-")
    const [call] = f.calls()
    assert.equal(call.method, "conversations.history")
    assert.equal(String(call.query?.limit ?? call.body?.limit), "10")
    assert.equal(call.query?.channel ?? call.body?.channel, CHANNEL)
  })

  it("reads the channel named by --channel instead of the mapped one", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    const result = await f.run(["slack", "whois", "--channel", OTHER], { script: { history: { [OTHER]: messages().slice(0, 2) } } })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("ts=")).length, 2)
    assert.equal(f.calls()[0].query?.channel ?? f.calls()[0].body?.channel, OTHER)
  })

  it("exits 1 on a Slack error, with no token, with no channel, or with a bad channel ID", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    const refused = await f.run(["slack", "whois"], { script: { queue: { "conversations.history": [{ error: "not_in_channel" }] } } })
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /not_in_channel/)
    const bad = await f.run(["slack", "whois", "--channel", "general"])
    assert.equal(bad.code, 1)

    const unmapped = await fixture()
    await unmapped.writeSettings({ botToken: TOKEN })
    assert.equal((await unmapped.run(["slack", "whois"])).code, 1)
    const noToken = await fixture()
    assert.equal((await noToken.run(["slack", "whois", "--channel", CHANNEL])).code, 1)
    assert.deepEqual(unmapped.calls(), [])
    assert.deepEqual(noToken.calls(), [])
  })
})

describe("enteredByPrPoll (spec 025 T015, the poll-pr check)", () => {
  const entered = (from, transitionEvent) => ({ type: "update", before: { status: from }, after: { status: "changes-requested" }, details: { transitionEvent } })
  const lane = { status: "changes-requested" }

  it("is true only when the newest entry into changes-requested came from pr-poll", () => {
    assert.equal(enteredByPrPoll([entered("pr-review", "pr-poll")], lane), true)
    assert.equal(enteredByPrPoll([entered("needs-review", "handoff request-changes")], lane), false)
    assert.equal(enteredByPrPoll([entered("pr-review", "pr-poll"), entered("needs-review", "handoff request-changes")], lane), false, "the newest entry decides")
    assert.equal(enteredByPrPoll([entered("needs-review", "handoff request-changes"), entered("pr-review", "pr-poll")], lane), true)
  })

  it("ignores events that stay in changes-requested, and is false outside it", () => {
    const stay = { type: "update", before: { status: "changes-requested" }, after: { status: "changes-requested" }, details: { transitionEvent: "handoff update" } }
    assert.equal(enteredByPrPoll([entered("pr-review", "pr-poll"), stay], lane), true)
    assert.equal(enteredByPrPoll([entered("pr-review", "pr-poll")], { status: "pr-review" }), false)
    assert.equal(enteredByPrPoll([], lane), false)
    assert.equal(enteredByPrPoll(null, lane), false)
    assert.equal(enteredByPrPoll([null, { after: null }], lane), false)
  })
})

// codex-reviewer's surviving mutants on e8205cf (M1, M5, M8, M10, M15).
describe("whois through runSlackCommand with a spy transport (codex-reviewer on e8205cf)", () => {
  async function home(settings) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-whois-unit-"))
    roots.push(dir)
    if (settings) {
      await fs.writeFile(path.join(dir, "slack.json"), JSON.stringify(settings), { mode: 0o600 })
      await fs.chmod(path.join(dir, "slack.json"), 0o600)
    }
    return dir
  }
  // A fetch that records each request and answers conversations.history.
  function spyFetch(messages) {
    const requests = []
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body })
      return { status: 200, headers: new Map(), json: async () => ({ ok: true, messages }) }
    }
    return { requests, fetchImpl }
  }
  async function whois(dir, fetchImpl, options = {}) {
    const out = []
    const err = []
    const code = await runSlackCommand("whois", options, {
      env: { BRAIN_TRAIN_HOME: dir }, repoRoot: "/work/repo", fetchImpl,
      out: (line) => out.push(line), err: (line) => err.push(line),
    })
    return { code, out, err }
  }

  it("refuses with no token before any call (M1)", async () => {
    const dir = await home(null)
    const { requests, fetchImpl } = spyFetch([])
    const result = await whois(dir, fetchImpl, { channel: CHANNEL })
    assert.equal(result.code, 1)
    assert.match(result.err.join("\n"), /token missing/)
    assert.deepEqual(requests, [])
  })

  it("reads history with a GET and the channel and limit in the query (M5)", async () => {
    const dir = await home({ botToken: TOKEN, channels: { "/work/repo": CHANNEL } })
    const { requests, fetchImpl } = spyFetch([])
    assert.equal((await whois(dir, fetchImpl)).code, 0)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, "GET")
    assert.equal(requests[0].body, undefined)
    const query = new URL(requests[0].url).searchParams
    assert.equal(query.get("channel"), CHANNEL)
    assert.equal(query.get("limit"), "10")
    assert.match(requests[0].url, /conversations\.history/)
  })

  it("prints at most ten rows even when Slack returns more (M8)", async () => {
    const dir = await home({ botToken: TOKEN, channels: { "/work/repo": CHANNEL } })
    const { fetchImpl } = spyFetch(messages())
    const result = await whois(dir, fetchImpl)
    assert.equal(result.out.filter((line) => line.startsWith("ts=")).length, 10)
  })

  it("prints a dash for a field that is not a plain ID, and no control characters (M10)", async () => {
    const dir = await home({ botToken: TOKEN, channels: { "/work/repo": CHANNEL } })
    const { fetchImpl } = spyFetch([{ ts: "1700000001.000100", user: "U0000FAKE has spaces", bot_id: "\u001b[31mB0000FAKE", app_id: 42, subtype: { nested: true }, text: SECRET_TEXT }])
    const result = await whois(dir, fetchImpl)
    const [row] = result.out.filter((line) => line.startsWith("ts="))
    assert.equal(row, "ts=1700000001.000100 user=- bot_id=- app_id=- client_msg_id=no subtype=-")
    for (const line of result.out) assert.doesNotMatch(line, /[\u0000-\u001f\u007f]/)
  })
})

describe("the enteredByPrPoll reader the CLI passes (codex-reviewer M15)", () => {
  async function laneRepo({ lanes = true } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-whois-reader-")))
    roots.push(root)
    const repo = path.join(root, "repo")
    const home = path.join(root, "home")
    await exec("git", ["init", "-q", repo])
    const env = { ...withoutLaneScope(), BRAIN_TRAIN_HOME: home, BTRAIN_AGENT: "claude" }
    await exec("node", [CLI, "init", repo, "--agent", "claude", "--agent", "codex", "--tracked", "--core-only", "--no-hooks"], { cwd: repo, env })
    if (!lanes) {
      const tomlPath = path.join(repo, ".btrain", "project.toml")
      const toml = await fs.readFile(tomlPath, "utf8")
      await fs.writeFile(tomlPath, toml.replace("[lanes]\nenabled = true", "[lanes]\nenabled = false"))
    }
    const config = await readProjectConfig(repo)
    const setStatus = async (laneId, status) => {
      const handoffPath = laneId
        ? path.resolve(repo, getLaneConfigs(config).find((lane) => lane.id === laneId).handoffPath)
        : getRepoPaths(repo).handoffPath
      const text = await fs.readFile(handoffPath, "utf8")
      await fs.writeFile(handoffPath, text.replace(/^Status: .*$/m, `Status: ${status}`))
    }
    const entered = (laneId, transitionEvent) => appendWorkflowEvent(repo, config, { laneId, type: "update", actor: "claude", before: { status: "pr-review" }, after: { status: "changes-requested" }, details: { transitionEvent } })
    return { repo, setStatus, entered }
  }

  it("is true for a lane pr-poll moved to changes-requested, false for a local request", async () => {
    const r = await laneRepo()
    await r.setStatus("a", "changes-requested")
    await r.entered("a", "pr-poll")
    assert.equal(await buildSlackReaders({ cliPath: CLI }).enteredByPrPoll(r.repo, "a"), true)
    await r.entered("a", "handoff request-changes")
    assert.equal(await readEnteredByPrPoll(r.repo, "a"), false, "the newest entry decides")
  })

  it("reads only the named lane: another lane's pr-poll event does not count", async () => {
    const r = await laneRepo()
    await r.setStatus("a", "changes-requested")
    await r.entered("a", "handoff request-changes")
    await r.setStatus("b", "changes-requested")
    await r.entered("b", "pr-poll")
    assert.equal(await readEnteredByPrPoll(r.repo, "a"), false)
    assert.equal(await readEnteredByPrPoll(r.repo, "b"), true)
    assert.equal(await readEnteredByPrPoll(r.repo, "zz"), false, "an unknown lane")
  })

  it("falls back to the single handoff in a repository without lanes", async () => {
    const r = await laneRepo({ lanes: false })
    await r.setStatus("", "changes-requested")
    await r.entered("", "pr-poll")
    assert.equal(await readEnteredByPrPoll(r.repo, ""), true)
  })
})
