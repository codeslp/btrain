// The eight invariants of the Slack lane publisher (spec 024 implementation
// plan, "Architecture and invariants"). WS0 adds them skipped; the workstream
// named in each skip removes it when its code makes the test pass.
//
// The tests are written against the planned interfaces: modules under
// src/brain_train/slack/, the `[features].slack` toggle, `~/.btrain/slack.json`,
// and the `btrain slack` commands. None of that exists yet, so every slack/
// module is imported inside a test body, never at module load. A workstream
// that settles on a different export name or option updates the test with it.
//
// No test calls Slack. CLI tests run btrain with
// test/helpers/fake-slack-preload.mjs, which answers every Slack call from the
// fake and logs it. Every repository gets its own BRAIN_TRAIN_HOME in a
// temporary directory, so nothing registers in the real ~/.btrain and nothing
// reads the real ~/.btrain/slack.json.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import { fakeSlackProcessEnv, readFakeSlackLog } from "./helpers/fake-slack.mjs"

const exec = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(REPO_ROOT, "src/brain_train/cli.mjs")
const CORE = path.join(REPO_ROOT, "src/brain_train/core.mjs")
const SLACK_DIR = path.join(REPO_ROOT, "src/brain_train/slack")
const PRELOAD = path.join(REPO_ROOT, "test/helpers/fake-slack-preload.mjs")
const slackModule = (name) => import(new URL(`../src/brain_train/slack/${name}`, import.meta.url))

// Fake values, built at runtime so the source holds no string that matches a
// secret pattern (`btrain review code` reports those as hardcoded secrets).
const TOKEN = ["xoxb", "0000", "fake", "invariant", "token"].join("-")
const CHANNEL = "C0000FAKE"
const OPERATOR = "U0000FAKE"
const GITHUB_PAT = ["github", "pat", "1".repeat(22), "2".repeat(59)].join("_")
const GITHUB_CLASSIC = ["ghp", "3".repeat(36)].join("_")
const WEBHOOK = ["https:", "", "hooks.slack.com", "services", "T0000FAKE", "B0000FAKE", "4".repeat(24)].join("/")
// Plan WS4: delivery after a lane command has a 2-second budget.
const INLINE_BUDGET_MS = 2000

const roots = []
after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

/**
 * A temporary repository initialised by the real CLI, with its own btrain home.
 * `toggle` is "on" (`[features].slack = true`), "off" (`slack = false`), or
 * "absent" (no `[features]` table, as in a pre-022 repository).
 */
async function createSlackRepo({ toggle = "on", slackConfig = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-publisher-inv-")))
  roots.push(root)
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  const logPath = path.join(root, "slack-calls.jsonl")
  await fs.mkdir(home, { recursive: true })
  await exec("git", ["init", "-q", repo])
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", repo, "config", "user.name", "Test Bot"])

  const baseEnv = {
    ...withoutLaneScope(),
    BRAIN_TRAIN_HOME: home,
    BTRAIN_AGENT: "claude",
    BTRAIN_DASHBOARD_DISABLED: "1",
  }
  delete baseEnv.BTRAIN_SLACK_BOT_TOKEN
  const init = await exec("node", [CLI, "init", repo, "--agent", "claude", "--agent", "codex", "--tracked"], {
    cwd: repo,
    env: baseEnv,
  })
  assert.ok(init.stdout.length > 0)

  const tomlPath = path.join(repo, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  assert.doesNotMatch(toml, /^\[features\]/m, "a tracked init writes no [features] table")
  if (toggle !== "absent") {
    await fs.writeFile(tomlPath, `${toml.trimEnd()}\n\n[features]\nslack = ${toggle === "on"}\n`, "utf8")
  }
  if (slackConfig) {
    const configPath = path.join(home, "slack.json")
    await fs.writeFile(configPath, `${JSON.stringify({
      botToken: TOKEN,
      label: "test-dev",
      operator: OPERATOR,
      mention: [OPERATOR],
      channels: { [repo]: CHANNEL },
    }, null, 2)}\n`, { mode: 0o600 })
    await fs.chmod(configPath, 0o600)
  }

  /** Run btrain with the fake Slack preload. Never throws on a non-zero exit. */
  async function btrain(args, { script, env = {} } = {}) {
    const started = Date.now()
    try {
      const result = await exec("node", ["--import", PRELOAD, CLI, ...args], {
        cwd: repo,
        env: { ...baseEnv, ...fakeSlackProcessEnv({ logPath, script, expectedToken: TOKEN }), ...env },
        maxBuffer: 5 * 1024 * 1024,
      })
      return { code: 0, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started }
    } catch (error) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
        ms: Date.now() - started,
      }
    }
  }

  return {
    root,
    repo,
    home,
    logPath,
    btrain,
    calls: () => readFakeSlackLog(logPath),
    slackStateDir: path.join(repo, ".btrain", "slack"),
  }
}

function claimArgs(lane = "a", task = "Publisher invariant fixture") {
  return ["handoff", "claim", "--lane", lane, "--task", task, "--owner", "claude", "--reviewer", "codex", "--files", "src/"]
}

function metadataUpdateArgs(lane = "a", next = "Keep going on the fixture") {
  return ["handoff", "update", "--lane", lane, "--next", next, "--actor", "claude"]
}

async function listFiles(dir) {
  const out = []
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(dir)
  return out.sort()
}

async function exists(target) {
  return fs.stat(target).then(() => true, () => false)
}

describe("spec 024 publisher invariants", () => {
  // btrain-allow: skipped-test
  it("1. with the toggle off or absent, nothing is written under .btrain/slack/ and fetch is never called", { skip: "enabled in WS2" }, async () => {
    for (const toggle of ["absent", "off"]) {
      // Credentials and a channel are configured, so only the toggle keeps it off.
      const fixture = await createSlackRepo({ toggle })
      const features = await fixture.btrain(["features"])
      assert.equal(features.code, 0, features.stderr)
      assert.match(features.stdout, /^\s*\[ \] slack\b/m, `${toggle}: btrain features shows slack off`)

      for (const args of [claimArgs(), metadataUpdateArgs(), ["handoff", "--lane", "a"], ["status"], ["doctor"]]) {
        const result = await fixture.btrain(args)
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /slack/i, `${toggle}: ${args.join(" ")} prints nothing about Slack`)
      }
      assert.equal(await exists(fixture.slackStateDir), false, `${toggle}: no .btrain/slack/ directory`)
      assert.deepEqual(fixture.calls(), [], `${toggle}: no fetch call`)
    }
  })

  // btrain-allow: skipped-test
  it("2. a command's state change, event, and printed result or error are complete before any Slack call", { skip: "enabled in WS4" }, async () => {
    const fixture = await createSlackRepo()

    // A command that succeeds: its whole output is written before the first call.
    const claim = await fixture.btrain(claimArgs())
    assert.equal(claim.code, 0, claim.stderr)
    const claimCalls = fixture.calls()
    assert.ok(claimCalls.length > 0, "the claim is delivered to the fake")
    const firstClaimCall = claimCalls[0]
    assert.equal(firstClaimCall.outputBefore.stdout, Buffer.byteLength(claim.stdout), "stdout complete before the first call")
    assert.equal(firstClaimCall.outputBefore.stderr, Buffer.byteLength(claim.stderr), "stderr complete before the first call")

    const events = await fs.readFile(path.join(fixture.repo, ".btrain", "events", "lane-a.jsonl"), "utf8")
    assert.match(events, /"type":"claim"/, "the claim event is in the lane's event log")
    const handoff = await fixture.btrain(["handoff", "--lane", "a"], { script: { defaults: { "*": { network: true } } } })
    assert.match(handoff.stdout, /status: in-progress/, "the state change was written")

    // Queue an entry that cannot be sent, then run a command that fails. The
    // queued entry is delivered only after the error is printed.
    const queued = await fixture.btrain(metadataUpdateArgs("a", "Queued while Slack is down"), {
      script: { defaults: { "*": { network: true } } },
    })
    assert.equal(queued.code, 0, queued.stderr)
    const before = fixture.calls().length
    const failing = await fixture.btrain(claimArgs("a", "A second claim on a busy lane"))
    assert.notEqual(failing.code, 0, "claiming a busy lane fails")
    assert.ok(failing.stderr.length > 0)
    const failingCalls = fixture.calls().slice(before)
    assert.ok(failingCalls.length > 0, "the failed command still drains the queue")
    assert.equal(failingCalls[0].outputBefore.stderr, Buffer.byteLength(failing.stderr), "the error is printed before the first call")
    assert.equal(failingCalls[0].outputBefore.stdout, Buffer.byteLength(failing.stdout))
  })

  // btrain-allow: skipped-test
  it("3. no Slack or delivery outcome throws into a lane command or changes its exit code", { skip: "enabled in WS4" }, async () => {
    const baseline = await createSlackRepo({ toggle: "off" })
    const steps = [
      claimArgs(),
      metadataUpdateArgs(),
      claimArgs("a", "A second claim on a busy lane"),
      ["handoff", "--lane", "a"],
    ]
    const expected = []
    for (const args of steps) {
      expected.push((await baseline.btrain(args)).code)
    }
    assert.deepEqual(expected, [0, 0, 1, 0], "baseline exit codes with the publisher off")

    const outcomes = {
      "network error": { network: true },
      "hang past the budget": { hang: true, ignoreAbort: true },
      "HTTP 429": { retryAfter: 120 },
      "HTTP 503": { status: 503 },
      "configuration error": { error: "invalid_auth" },
      "entry error": { error: "msg_too_long" },
      "unknown error": { error: "made_up_error_name" },
    }
    for (const [label, outcome] of Object.entries(outcomes)) {
      const fixture = await createSlackRepo()
      const script = { defaults: { "*": outcome } }
      for (const [index, args] of steps.entries()) {
        const result = await fixture.btrain(args, { script })
        assert.equal(result.code, expected[index], `${label}: ${args.join(" ")} keeps its exit code\n${result.stderr}`)
        assert.doesNotMatch(result.stderr, /\n\s+at .+:\d+:\d+/, `${label}: no stack trace reaches the command`)
        assert.ok(result.ms < INLINE_BUDGET_MS + 5000, `${label}: ${args.join(" ")} took ${result.ms} ms`)
      }
      const state = await fixture.btrain(["handoff", "--lane", "a"], { script })
      assert.match(state.stdout, /status: in-progress/, `${label}: the lane state is the command's, not Slack's`)
      assert.ok(fixture.calls().length > 0, `${label}: delivery was attempted`)
    }
  })

  // btrain-allow: skipped-test
  it("4. the outbox, thread map, logs, and command output never hold the token or a secret", { skip: "enabled in WS4" }, async () => {
    const fixture = await createSlackRepo()
    const env = { BTRAIN_SLACK_BOT_TOKEN: TOKEN }
    const task = `Rotate ${GITHUB_PAT} and ${GITHUB_CLASSIC}; the alert hook is ${WEBHOOK}`
    const outputs = []
    const run = async (args, script) => {
      const result = await fixture.btrain(args, { env, script })
      outputs.push(result.stdout, result.stderr)
      return result
    }

    // Leave entries queued, then deliver them, so both the outbox and the
    // thread map are written.
    assert.equal((await run(claimArgs("a", task), { defaults: { "*": { network: true } } })).code, 0)
    assert.ok((await listFiles(path.join(fixture.slackStateDir, "outbox"))).length > 0, "an entry is queued")
    await run(metadataUpdateArgs("a", `Summary mentions ${GITHUB_CLASSIC}`), { defaults: { "*": { network: true } } })
    const slackOutputs = []
    for (const args of [["slack", "flush"], ["slack", "status"], ["slack", "channels"], ["slack", "refresh"]]) {
      const result = await run(args)
      slackOutputs.push(result.stdout, result.stderr)
    }

    const secrets = [GITHUB_PAT, GITHUB_CLASSIC, WEBHOOK]
    for (const file of await listFiles(fixture.slackStateDir)) {
      const text = await fs.readFile(file, "utf8")
      assert.ok(!text.includes(TOKEN), `${file} holds the token`)
      for (const secret of secrets) assert.ok(!text.includes(secret), `${file} holds a secret`)
    }
    for (const file of await listFiles(path.join(fixture.repo, ".btrain"))) {
      assert.ok(!(await fs.readFile(file, "utf8")).includes(TOKEN), `${file} holds the token`)
    }
    for (const text of outputs) {
      assert.ok(!text.includes(TOKEN), "command output holds the token")
    }
    for (const text of slackOutputs) {
      for (const secret of secrets) assert.ok(!text.includes(secret), "btrain slack output holds a secret")
    }
    const sent = fixture.calls()
    assert.ok(sent.length > 0)
    for (const call of sent) {
      const body = JSON.stringify(call.body)
      for (const secret of secrets) assert.ok(!body.includes(secret), `${call.method} sent a secret to Slack`)
    }
    assert.ok(!(await fs.readFile(fixture.logPath, "utf8")).includes(TOKEN))
  })

  // btrain-allow: skipped-test
  it("5. agent-written text cannot produce a mention or a link", { skip: "enabled in WS1" }, async () => {
    const text = await slackModule("text.mjs")
    const events = await slackModule("events.mjs")
    const render = await slackModule("render.mjs")
    assert.equal(typeof text.prepareAgentText, "function", "WS1: text.mjs exports the one text pipeline function")
    assert.equal(typeof events.classifyWorkflowEvent, "function", "WS1: events.mjs maps a workflow event to a kind")
    assert.equal(typeof render.renderCard, "function", "WS1: render.mjs renders the card")
    assert.equal(typeof render.renderReply, "function", "WS1: render.mjs renders a reply line")

    const hostile = [
      "<!channel> <!here> <!everyone> <@U0000FAKE> <#C0000FAKE> <!subteam^S0000FAKE>",
      "<https://evil.example.invalid|click> https://evil.example.invalid/x www.example.invalid",
      `& ${WEBHOOK} ${GITHUB_PAT} ${GITHUB_CLASSIC}`,
    ].join(" ")
    const assertInert = (output, where) => {
      assert.doesNotMatch(output, /[<>]/, `${where}: no raw angle bracket, so no mention or link markup`)
      assert.doesNotMatch(output, /:\/\//, `${where}: no scheme separator, so Slack makes no link`)
      assert.ok(!output.includes(WEBHOOK) && !output.includes(GITHUB_PAT) && !output.includes(GITHUB_CLASSIC), `${where}: secrets redacted`)
      assert.match(output, /&amp;/, `${where}: & is escaped`)
      assert.match(output, /\[redacted\]/, `${where}: redaction is visible`)
    }

    assertInert(text.prepareAgentText(hostile, { maxChars: 4000 }), "prepareAgentText")

    const before = { task: "old", owner: "claude", reviewer: "codex", status: "in-progress", lockedFiles: ["src/"], lane: "a" }
    const lane = { ...before, task: hostile, status: "needs-review", reviewerContext: hostile }
    const event = {
      version: 1,
      recordedAt: "2026-11-23T21:45:00.123Z",
      type: "update",
      actor: "claude",
      laneId: "a",
      before,
      after: lane,
      details: { summary: hostile, reason: hostile },
    }
    const classified = events.classifyWorkflowEvent(event)
    assert.equal(classified.kind, "sent-to-review")
    assert.equal(classified.mention, false)
    // No mention IDs and no PR, so btrain itself adds no markup either.
    const context = { repoName: "fixture-repo", label: "test-dev", mention: [], channel: CHANNEL }
    assertInert(render.renderReply(classified, context), "renderReply")
    assertInert(render.renderCard(lane, context), "renderCard")
  })

  // btrain-allow: skipped-test
  it("6. a card and a board are functions of current lane state, and sending one twice leaves Slack unchanged", { skip: "enabled in WS4" }, async () => {
    const fixture = await createSlackRepo()
    assert.equal((await fixture.btrain(claimArgs())).code, 0)
    const cardPost = fixture.calls().find((call) => call.method === "chat.postMessage" && !call.body.thread_ts)
    assert.ok(cardPost, "the claim posts a card")

    // Replies and card refreshes that were never delivered do not matter: the
    // next render reads current state.
    await fixture.btrain(metadataUpdateArgs("a", "First"), { script: { defaults: { "*": { network: true } } } })
    await fixture.btrain(metadataUpdateArgs("a", "Second"), { script: { defaults: { "*": { network: true } } } })

    const refresh = async () => {
      const before = fixture.calls().length
      const result = await fixture.btrain(["slack", "refresh"])
      assert.equal(result.code, 0, result.stderr)
      return fixture.calls().slice(before)
    }
    const first = await refresh()
    const second = await refresh()
    const shape = (calls) => calls.map((call) => ({ method: call.method, channel: call.body.channel, ts: call.body.ts, text: call.body.text }))

    assert.ok(first.length > 0, "refresh updates the card")
    assert.ok(second.every((call) => call.method === "chat.update"), "a second refresh posts nothing new")
    assert.deepEqual(shape(second), shape(first.filter((call) => call.method === "chat.update")), "the same state renders the same messages")
    const card = second.find((call) => call.body.ts === cardPost.result.ts)
    assert.ok(card, "the refresh updates the card the claim posted, by its ts")
    assert.match(card.body.text, /Publisher invariant fixture/, "the card shows the current task")
    assert.match(card.body.text, /owner: claude/)
    assert.match(card.body.text, /reviewer: codex/)
  })

  // btrain-allow: skipped-test
  it("7. a process that finds a live delivery lock skips delivery and returns", { skip: "enabled in WS4" }, async () => {
    const fixture = await createSlackRepo()
    await fs.mkdir(fixture.slackStateDir, { recursive: true })
    const lockPath = path.join(fixture.slackStateDir, "delivery.lock")
    const nonce = "another-process-nonce"
    await fs.writeFile(lockPath, nonce, { flag: "wx" })

    const result = await fixture.btrain(claimArgs())
    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.ms < INLINE_BUDGET_MS + 5000, `the command returned in ${result.ms} ms; it must not wait for the lock`)
    assert.deepEqual(fixture.calls(), [], "no Slack call while another process holds a live lock")
    assert.equal(await fs.readFile(lockPath, "utf8"), nonce, "the live lock is left alone")
    assert.ok((await listFiles(path.join(fixture.slackStateDir, "outbox"))).length > 0, "the entry stays queued for the holder")

    const flush = await fixture.btrain(["slack", "flush"])
    assert.equal(flush.code, 0, flush.stderr)
    assert.deepEqual(fixture.calls(), [], "flush also skips while the lock is live")
  })

  // btrain-allow: skipped-test
  it("8. core.mjs gains no function, keeps its pinned line counts, and imports only the slack entry point", { skip: "enabled in WS4" }, async () => {
    const inventory = await exec("node", [path.join(REPO_ROOT, "scripts/decomposition_inventory.mjs"), "--stages"], { cwd: REPO_ROOT })
      .then(() => 0, (error) => (typeof error.code === "number" ? error.code : 1))
    assert.equal(inventory, 0, "node scripts/decomposition_inventory.mjs --stages exits 0")

    const { readFunctionSpans } = await import(new URL("../scripts/decomposition_inventory.mjs", import.meta.url))
    const { spans } = readFunctionSpans(CORE)
    assert.equal(spans.find((span) => span.name === "patchHandoff").lines, 585)
    assert.equal(spans.find((span) => span.name === "runLoop").lines, 422)

    // core.mjs reaches the publisher through slack/index.mjs only, and no
    // slack/ module imports core.mjs (that would be an import cycle).
    const core = await fs.readFile(CORE, "utf8")
    const slackImports = [...core.matchAll(/from\s+["'](\.\/slack\/[^"']+)["']/g)].map((match) => match[1])
    assert.deepEqual([...new Set(slackImports)], ["./slack/index.mjs"])
    for (const file of await listFiles(SLACK_DIR)) {
      if (!file.endsWith(".mjs")) continue
      const source = await fs.readFile(file, "utf8")
      assert.doesNotMatch(source, /from\s+["'][^"']*core\.mjs["']|import\(\s*["'][^"']*core\.mjs["']/, `${path.relative(REPO_ROOT, file)} imports core.mjs`)
    }
  })
})
