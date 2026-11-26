// Spec 024 FR-14, FR-16 and the plan's WS2 (T010): `btrain slack setup`,
// `status`, `channels`, and `test`, through the real CLI with its own btrain
// home and the fake Slack preload. No test calls Slack.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import { fakeSlackProcessEnv, readFakeSlackLog } from "./helpers/fake-slack.mjs"
import { writeEntry, writeDeliveryState, readDeliveryState, emptyDeliveryState } from "../src/brain_train/slack/outbox.mjs"
import { updateBoard } from "../src/brain_train/slack/threads.mjs"
import { PassThrough, Readable } from "node:stream"
import { runSlackCommand } from "../src/brain_train/slack/cli.mjs"
import { loadSlackCredentials } from "../src/brain_train/slack/credentials.mjs"

const exec = promisify(execFile)
const CLI = path.resolve("src/brain_train/cli.mjs")
// Fake values, built at runtime so the source holds no secret-shaped string.
const TOKEN = ["xoxb", "0000", "fake", "cli", "token"].join("-")
const CHANNEL = "C0000FAKE"
const OTHER_CHANNEL = "C0001FAKE"
const CATCH_ALL = "C0002FAKE"
const NEW_CHANNEL = "C0003FAKE"

const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

async function fixture({ toggle = "on" } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-cli-")))
  roots.push(root)
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  const logPath = path.join(root, "fake-calls.jsonl")
  await fs.mkdir(home, { recursive: true })
  await exec("git", ["init", "-q", repo])
  const baseEnv = { ...withoutLaneScope(), BRAIN_TRAIN_HOME: home, BTRAIN_AGENT: "claude", BTRAIN_DASHBOARD_DISABLED: "1" }
  delete baseEnv.BTRAIN_SLACK_BOT_TOKEN
  const outputs = []

  // Run the CLI, optionally with standard input. Never throws on exit codes.
  function run(args, { input = "", script, env = {} } = {}) {
    return new Promise((resolve) => {
      const child = spawn("node", [CLI, ...args], {
        cwd: repo,
        env: { ...baseEnv, ...fakeSlackProcessEnv({ logPath, script, expectedToken: TOKEN }), ...env },
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.on("close", (code) => {
        outputs.push(stdout, stderr)
        resolve({ code, stdout, stderr })
      })
      child.stdin.end(input)
    })
  }

  const init = await run(["init", repo, "--agent", "claude", "--agent", "codex", "--tracked", "--core-only", "--no-hooks"])
  assert.equal(init.code, 0, init.stderr)
  if (toggle !== "absent") {
    const tomlPath = path.join(repo, ".btrain", "project.toml")
    const toml = await fs.readFile(tomlPath, "utf8")
    await fs.writeFile(tomlPath, `${toml.trimEnd()}\n\n[features]\nslack = ${toggle === "on"}\n`)
  }
  const slackFile = path.join(home, "slack.json")
  const writeSettings = async (settings, mode = 0o600) => {
    await fs.writeFile(slackFile, `${JSON.stringify(settings, null, 2)}\n`, { mode })
    await fs.chmod(slackFile, mode)
  }
  const readSettings = async () => JSON.parse(await fs.readFile(slackFile, "utf8"))
  return {
    root, repo, home, slackFile, run, writeSettings, readSettings,
    slackDir: path.join(repo, ".btrain", "slack"),
    calls: () => readFakeSlackLog(logPath),
    // No command may ever print the token.
    assertTokenNeverPrinted: () => outputs.forEach((text) => assert.ok(!text.includes(TOKEN), "the token was printed")),
  }
}

describe("btrain slack with no credentials (spec 024 T010)", () => {
  it("lets every lane command succeed with no network call, and status names the missing token", async () => {
    const f = await fixture()
    for (const args of [
      ["handoff", "claim", "--lane", "a", "--task", "fixture", "--owner", "claude", "--reviewer", "codex", "--files", "src/"],
      ["handoff", "update", "--lane", "a", "--next", "keep going", "--actor", "claude"],
      ["handoff", "--lane", "a"],
      ["status"],
    ]) {
      const result = await f.run(args)
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`)
    }
    const status = await f.run(["slack", "status"])
    assert.equal(status.code, 0)
    assert.match(status.stdout, /^publisher: on$/m)
    assert.match(status.stdout, /^token: missing: no token in BTRAIN_SLACK_BOT_TOKEN or ~\/\.btrain\/slack\.json; run btrain slack setup$/m)
    assert.match(status.stdout, /^channel: none mapped/m)
    assert.deepEqual(f.calls(), [], "no Slack call")
  })
})

describe("btrain slack setup", () => {
  it("reads the token from standard input, writes slack.json with mode 0600, and maps --channel", async () => {
    const f = await fixture()
    const result = await f.run(["slack", "setup", "--channel", CHANNEL, "--operator", "U0000FAKE"], { input: `${TOKEN}\n` })
    assert.equal(result.code, 0, result.stderr)
    const stat = await fs.stat(f.slackFile)
    assert.equal(stat.mode & 0o777, 0o600)
    const settings = await f.readSettings()
    assert.equal(settings.botToken, TOKEN)
    assert.equal(settings.operator, "U0000FAKE")
    assert.deepEqual(settings.channels, { [f.repo]: CHANNEL })
    assert.match(result.stdout, new RegExp(`publishes to ${CHANNEL}`))
    f.assertTokenNeverPrinted()
  })

  it("offers an existing project channel first, then the catch-all, then a new channel ID", async () => {
    const f = await fixture()
    await f.writeSettings({ channels: { "/work/other": OTHER_CHANNEL }, defaultChannel: CATCH_ALL })
    const result = await f.run(["slack", "setup"], { input: `${TOKEN}\n1\n` })
    assert.equal(result.code, 0, result.stderr)
    const prompt = result.stderr.split("\n").filter((line) => /^\s+\d\) /.test(line))
    assert.deepEqual(prompt, [
      `  1) ${OTHER_CHANNEL} (carries /work/other)`,
      `  2) the catch-all ${CATCH_ALL}`,
      "  3) a new channel ID for this repository",
    ])
    assert.equal((await f.readSettings()).channels[f.repo], OTHER_CHANNEL, "folded into the existing project channel")
    f.assertTokenNeverPrinted()
  })

  it("leaves the repository on the catch-all, or maps a new channel ID", async () => {
    const onCatchAll = await fixture()
    await onCatchAll.writeSettings({ defaultChannel: CATCH_ALL })
    assert.equal((await onCatchAll.run(["slack", "setup"], { input: `${TOKEN}\n1\n` })).code, 0)
    const caught = await onCatchAll.readSettings()
    assert.equal(caught.channels?.[onCatchAll.repo], undefined)
    assert.equal(caught.defaultChannel, CATCH_ALL)

    const onNew = await fixture()
    assert.equal((await onNew.run(["slack", "setup"], { input: `${TOKEN}\n2\n${NEW_CHANNEL}\n` })).code, 0)
    assert.equal((await onNew.readSettings()).channels[onNew.repo], NEW_CHANNEL)

    const newCatchAll = await fixture()
    assert.equal((await newCatchAll.run(["slack", "setup"], { input: `${TOKEN}\n1\n${CATCH_ALL}\n` })).code, 0)
    assert.equal((await newCatchAll.readSettings()).defaultChannel, CATCH_ALL, "the catch-all asks for its ID when none is set")
  })

  it("writes nothing for a token that is not a bot token, a bad channel, or an insecure file", async () => {
    const f = await fixture()
    const notBot = await f.run(["slack", "setup", "--channel", CHANNEL], { input: "not-a-token\n" })
    assert.equal(notBot.code, 1)
    await assert.rejects(fs.stat(f.slackFile))
    const badChannel = await f.run(["slack", "setup", "--channel", "general"], { input: `${TOKEN}\n` })
    assert.equal(badChannel.code, 1)
    await assert.rejects(fs.stat(f.slackFile))
    const badOperator = await f.run(["slack", "setup", "--channel", CHANNEL, "--operator", "dana"], { input: `${TOKEN}\n` })
    assert.equal(badOperator.code, 1)
    await assert.rejects(fs.stat(f.slackFile))

    await f.writeSettings({ label: "dev" }, 0o644)
    const insecure = await f.run(["slack", "setup", "--channel", CHANNEL], { input: `${TOKEN}\n` })
    assert.equal(insecure.code, 1)
    assert.match(insecure.stderr, /readable by others/)
    assert.equal((await f.readSettings()).botToken, undefined)
    f.assertTokenNeverPrinted()
  })
})

describe("btrain slack channels and status", () => {
  it("prints the path-to-channel map and the catch-all", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL, "/work/other": CHANNEL, "/work/api": OTHER_CHANNEL }, defaultChannel: CATCH_ALL })
    const result = await f.run(["slack", "channels"])
    assert.equal(result.code, 0)
    assert.equal(result.stdout, `${CHANNEL}\n  ${["/work/other", f.repo].sort().join(`\n  `)}\n${OTHER_CHANNEL}\n  /work/api\ncatch-all: ${CATCH_ALL}\n`)
    f.assertTokenNeverPrinted()
  })

  it("shows the toggle, token source, channel, pending entries, pause, and board", async () => {
    const f = await fixture({ toggle: "off" })
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    await writeEntry(f.slackDir, { laneId: "a", claimKey: "c", kind: "claimed", reply: true, fields: {} }, { now: () => Date.now() - 2 * 3600_000 })
    await writeEntry(f.slackDir, { laneId: "a", claimKey: "c", kind: "sent-to-review", reply: true, fields: {} }, { now: () => Date.now() - 60_000 })
    await writeDeliveryState(f.slackDir, { ...emptyDeliveryState(), paused: { error: "invalid_auth", at: new Date().toISOString() }, lastError: "invalid_auth" })
    const result = await f.run(["slack", "status"])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /^publisher: off/m)
    assert.match(result.stdout, /^token: from ~\/\.btrain\/slack\.json$/m)
    assert.match(result.stdout, new RegExp(`^channel: ${CHANNEL}$`, "m"))
    assert.match(result.stdout, /^pending: 2, oldest 2h old$/m)
    assert.match(result.stdout, /^paused: yes \(invalid_auth\); run btrain slack test to resume$/m)
    assert.match(result.stdout, /^board: not posted yet$/m)
    const fromEnv = await f.run(["slack", "status"], { env: { BTRAIN_SLACK_BOT_TOKEN: TOKEN } })
    assert.match(fromEnv.stdout, /^token: from BTRAIN_SLACK_BOT_TOKEN$/m)
    f.assertTokenNeverPrinted()
  })
})

describe("the board in btrain slack status (spec 024 T022)", () => {
  it("reports a failed pin, and a pinned board", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    await updateBoard(f.home, CHANNEL, { ts: "1700000000.000100", text: "board", pinned: false, pinError: "not_pinnable" })
    const failed = await f.run(["slack", "status"])
    assert.equal(failed.code, 0, "a failed pin blocks nothing")
    assert.match(failed.stdout, /^board: posted, not pinned \(not_pinnable\)$/m)
    await updateBoard(f.home, CHANNEL, { pinned: true, pinError: "" })
    assert.match((await f.run(["slack", "status"])).stdout, /^board: posted and pinned$/m)
  })
})

describe("btrain slack test", () => {
  it("calls auth.test, posts one message, and clears a pause", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, label: "dana", channels: { [f.repo]: CHANNEL } })
    await writeDeliveryState(f.slackDir, { ...emptyDeliveryState(), paused: { error: "token_revoked", at: new Date().toISOString() } })
    const result = await f.run(["slack", "test"])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(f.calls().map((call) => call.method), ["auth.test", "chat.postMessage"])
    assert.equal(f.calls()[1].body.channel, CHANNEL)
    assert.match(f.calls()[1].body.text, /dev: dana/)
    assert.equal((await readDeliveryState(f.slackDir)).paused, null)
    f.assertTokenNeverPrinted()
  })

  it("fails without changing the pause when auth.test is refused, or with no channel", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    await writeDeliveryState(f.slackDir, { ...emptyDeliveryState(), paused: { error: "token_revoked", at: new Date().toISOString() } })
    const refused = await f.run(["slack", "test"], { script: { queue: { "auth.test": [{ error: "invalid_auth" }] } } })
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /auth\.test failed \(invalid_auth\)/)
    assert.equal((await readDeliveryState(f.slackDir)).paused.error, "token_revoked")

    const unmapped = await fixture()
    await unmapped.writeSettings({ botToken: TOKEN })
    const noChannel = await unmapped.run(["slack", "test"])
    assert.equal(noChannel.code, 1)
    assert.deepEqual(unmapped.calls(), [])
    f.assertTokenNeverPrinted()
  })

  it("fails, keeping the pause, when the test message cannot be posted (codex-reviewer M12)", async () => {
    const f = await fixture()
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    await writeDeliveryState(f.slackDir, { ...emptyDeliveryState(), paused: { error: "not_in_channel", at: new Date().toISOString() } })
    const result = await f.run(["slack", "test"], { script: { queue: { "chat.postMessage": [{ error: "not_in_channel" }] } } })
    assert.equal(result.code, 1)
    assert.match(result.stderr, new RegExp(`posting to ${CHANNEL} failed \\(not_in_channel\\)`))
    assert.doesNotMatch(result.stdout, /posted a test message/)
    assert.equal((await readDeliveryState(f.slackDir)).paused.error, "not_in_channel")
    f.assertTokenNeverPrinted()
  })

  it("refuses an unknown subcommand", async () => {
    const f = await fixture()
    const result = await f.run(["slack", "nope"])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /setup, status, channels, test/)
  })
})

// codex-reviewer's repros on 9c726f6, committed before the fix.
describe("btrain slack setup and status, review repros (codex-reviewer on 9c726f6)", () => {
  it("refuses a symlinked credential file without replacing its target", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-cli-link-"))
    roots.push(home)
    const target = path.join(home, "target.json")
    const original = JSON.stringify({ label: "original" })
    await fs.writeFile(target, original, { mode: 0o600 })
    await fs.symlink(target, path.join(home, "slack.json"))
    assert.equal(await runSlackCommand("setup", { channel: CHANNEL }, {
      env: { BRAIN_TRAIN_HOME: home }, repoRoot: "/work/repo", stdin: Readable.from([`${TOKEN}\n`]), out() {}, err() {},
    }), 1)
    assert.equal(await fs.readFile(target, "utf8"), original)
  })

  it("never replaces valid settings with a file its reader refuses (over the size limit)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-cli-size-"))
    roots.push(home)
    const env = { BRAIN_TRAIN_HOME: home }
    const channels = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`/work/${"repository".repeat(10)}/${i}`, CHANNEL]))
    const original = JSON.stringify({ botToken: TOKEN, channels })
    await fs.writeFile(path.join(home, "slack.json"), original, { mode: 0o600 })
    assert.equal((await loadSlackCredentials({ env })).reason, "")
    const code = await runSlackCommand("setup", { channel: OTHER_CHANNEL }, {
      env, repoRoot: "/work/new-repository", stdin: Readable.from([`${TOKEN}\n`]), out() {}, err() {},
    })
    assert.equal(code, 0, "it fits in the compact form")
    const loaded = await loadSlackCredentials({ env })
    assert.equal(loaded.reason, "", "setup leaves loadable credentials")
    assert.equal(loaded.settings.channels["/work/new-repository"], OTHER_CHANNEL)
  })

  it("refuses, keeping the file as it was, when even the compact form is too large", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-cli-size-"))
    roots.push(home)
    const env = { BRAIN_TRAIN_HOME: home }
    // Compact settings just under the limit: one more mapping cannot fit.
    const channels = {}
    for (let i = 0; JSON.stringify({ botToken: TOKEN, channels }).length < 4000; i += 1) channels[`/work/${"r".repeat(60)}/${i}`] = CHANNEL
    const original = JSON.stringify({ botToken: TOKEN, channels })
    await fs.writeFile(path.join(home, "slack.json"), original, { mode: 0o600 })
    const errors = []
    const code = await runSlackCommand("setup", { channel: OTHER_CHANNEL }, {
      env, repoRoot: `/work/${"n".repeat(120)}`, stdin: Readable.from([`${TOKEN}\n`]), out() {}, err: (line) => errors.push(line),
    })
    assert.equal(code, 1)
    assert.match(errors.join("\n"), /would exceed 4096 bytes/)
    assert.equal(await fs.readFile(path.join(home, "slack.json"), "utf8"), original)
  })

  it("maps the registered repository, not a linked worktree's path", async () => {
    const f = await fixture()
    await exec("git", ["-C", f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "init"])
    const worktree = path.join(f.root, "worktree")
    await exec("git", ["-C", f.repo, "worktree", "add", "--detach", worktree, "HEAD"])
    await f.writeSettings({ botToken: TOKEN, channels: { [f.repo]: CHANNEL } })
    const status = await f.run(["slack", "status", "--repo", worktree])
    assert.match(status.stdout, new RegExp(`^channel: ${CHANNEL}$`, "m"))
    const fresh = await fixture()
    await exec("git", ["-C", fresh.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "init"])
    const freshWorktree = path.join(fresh.root, "worktree")
    await exec("git", ["-C", fresh.repo, "worktree", "add", "--detach", freshWorktree, "HEAD"])
    assert.equal((await fresh.run(["slack", "setup", "--channel", CHANNEL, "--repo", freshWorktree], { input: `${TOKEN}\n` })).code, 0)
    assert.deepEqual(Object.keys((await fresh.readSettings()).channels), [fresh.repo], "setup maps the registered path")
  })
})

// codex-reviewer on c888de6: at a terminal, the pasted token must not echo.
describe("btrain slack setup at a terminal (codex-reviewer on c888de6)", () => {
  // A stand-in for a TTY stdin: records raw-mode switches and whether data
  // arrived while echo was on (raw mode off).
  function fakeTty(chunks) {
    const stream = new PassThrough()
    stream.isTTY = true
    stream.rawModes = []
    stream.raw = false
    stream.echoedWhileReading = []
    let sent = false
    stream.setRawMode = (on) => {
      stream.raw = on
      stream.rawModes.push(on)
      // The person types once the prompt is reading, as at a real terminal.
      if (on && !sent) {
        sent = true
        setImmediate(() => {
          for (const chunk of chunks) {
            if (!stream.raw) stream.echoedWhileReading.push(chunk)
            stream.write(chunk)
          }
          stream.end()
        })
      }
      return stream
    }
    return stream
  }

  it("reads the token with echo off and restores the terminal, then reads the channel prompt", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-cli-tty-"))
    roots.push(home)
    const env = { BRAIN_TRAIN_HOME: home }
    await fs.writeFile(path.join(home, "slack.json"), JSON.stringify({ channels: { "/work/other": OTHER_CHANNEL } }), { mode: 0o600 })
    // A typo fixed with backspace, Enter as a carriage return, then the
    // channel choice in the same chunk.
    const stdin = fakeTty([`${TOKEN}x\u007f\r1\n`])
    let rawAtPrompt = null
    const err = (line) => { if (/Paste the bot token/.test(line)) rawAtPrompt = stdin.raw }
    const code = await runSlackCommand("setup", {}, { env, repoRoot: "/work/repo", stdin, out() {}, err })
    assert.equal(code, 0)
    assert.equal(rawAtPrompt, true, "echo is off before the prompt appears: typing may start at once")
    assert.deepEqual(stdin.rawModes, [true, false], "echo off while reading the token, then restored")
    assert.deepEqual(stdin.echoedWhileReading, [], "the token arrived with echo off")
    const settings = (await loadSlackCredentials({ env })).settings
    assert.equal((await loadSlackCredentials({ env })).token, TOKEN, "backspace removed the typo")
    assert.equal(settings.channels["/work/repo"], OTHER_CHANNEL, "the prompt after the token still reads its answer")
  })

  it("restores the terminal and writes nothing when the token read is cancelled with Ctrl-C", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-cli-tty-"))
    roots.push(home)
    const stdin = fakeTty([`${TOKEN.slice(0, 8)}\u0003`])
    const errors = []
    const code = await runSlackCommand("setup", { channel: CHANNEL }, { env: { BRAIN_TRAIN_HOME: home }, repoRoot: "/work/repo", stdin, out() {}, err: (line) => errors.push(line) })
    assert.equal(code, 1)
    assert.match(errors.join("\n"), /cancelled/, "Ctrl-C says cancelled (codex-reviewer M15)")
    assert.doesNotMatch(errors.join("\n"), /not a Slack bot token/)
    assert.deepEqual(stdin.rawModes, [true, false])
    await assert.rejects(fs.stat(path.join(home, "slack.json")))
  })
})
