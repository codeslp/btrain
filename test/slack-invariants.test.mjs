// The eight invariants of the Slack lane publisher (spec 024 implementation
// plan, "Architecture and invariants"). WS0 adds them skipped; the workstream
// named in each skip removes it when its code makes the test pass.
//
// The tests are written against the planned interfaces: modules under
// src/brain_train/slack/, the `[features].slack` toggle, `~/.btrain/slack.json`,
// and the `btrain slack` commands. None of that exists yet, so every slack/
// module is imported inside a test body, never at module load. The plan does
// not name the WS1 exports; invariant 5 uses `prepareAgentText`,
// `classifyWorkflowEvent`, `renderCard`, and `renderReply`, and WS1 renames
// them here if it settles on other names.
//
// No test calls Slack. Every btrain run, `init` included, loads
// test/helpers/fake-slack-preload.mjs through NODE_OPTIONS (so node processes
// btrain starts load it too), and it answers Slack calls from the fake,
// refuses any other URL, and logs both.
//
// To leave entries queued, a test holds a live delivery lock while it runs
// the commands that queue them (invariant 7: a process that finds the lock
// skips delivery). A failed send would also leave them queued, but it records
// a retry time, and delivery may then hold the lane's later entries back. Every repository gets its own
// BRAIN_TRAIN_HOME in a temporary directory, so nothing registers in the real
// ~/.btrain and nothing reads the real ~/.btrain/slack.json.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import { fakeSlackProcessEnv, readFakeSlackLog, readFakeSlackRefusals } from "./helpers/fake-slack.mjs"

const exec = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(REPO_ROOT, "src/brain_train/cli.mjs")
const CORE_RELATIVE = "src/brain_train/core.mjs"
const ASSIGNMENT_RELATIVE = "specs/020-ws2-module-assignment.json"
const SLACK_DIR = path.join(REPO_ROOT, "src/brain_train/slack")
const slackModule = (name) => import(new URL(`../src/brain_train/slack/${name}`, import.meta.url))

// Fake values, built at runtime so the source holds no string that matches a
// secret pattern (`btrain review code` reports those as hardcoded secrets).
const TOKEN = ["xoxb", "0000", "fake", "invariant", "token"].join("-")
const CHANNEL = "C0000FAKE"
const OPERATOR = "U0000FAKE"
const GITHUB_PAT = ["github", "pat", "1".repeat(22), "2".repeat(59)].join("_")
const GITHUB_CLASSIC = ["ghp", "3".repeat(36)].join("_")
const WEBHOOK_PATH = ["hooks.slack.com", "services", "T0000FAKE", "B0000FAKE", "4".repeat(24)].join("/")
const WEBHOOK = `https://${WEBHOOK_PATH}`
// A secret counts as leaked when any of these survives, so a webhook that was
// defanged to `https[:]//...` but not redacted is still caught.
const SECRET_MARKERS = [GITHUB_PAT, GITHUB_CLASSIC, WEBHOOK_PATH, "4".repeat(24)]
// Plan WS4: delivery after a lane command has a 2-second budget.
const INLINE_BUDGET_MS = 2000
// A command that hangs is killed after this, so a regression fails the test
// instead of wedging the suite (node --test has no default timeout).
const COMMAND_TIMEOUT_MS = 15000
// How much longer than the same command with the publisher off a command may
// take when it must not wait.
const NO_WAIT_MARGIN_MS = 1500

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
  const logPath = path.join(root, "fake-calls.jsonl")
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

  if (slackConfig) {
    // Written before init, so an init that reached the publisher would find it.
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
      const result = await exec("node", [CLI, ...args], {
        cwd: repo,
        env: { ...baseEnv, ...fakeSlackProcessEnv({ logPath, script, expectedToken: TOKEN }), ...env },
        maxBuffer: 5 * 1024 * 1024,
        timeout: COMMAND_TIMEOUT_MS,
      })
      return { code: 0, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started, killed: false }
    } catch (error) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
        ms: Date.now() - started,
        killed: Boolean(error.killed),
      }
    }
  }

  const init = await btrain(["init", repo, "--agent", "claude", "--agent", "codex", "--tracked"])
  assert.equal(init.code, 0, init.stderr)

  const tomlPath = path.join(repo, ".btrain", "project.toml")
  const toml = await fs.readFile(tomlPath, "utf8")
  assert.doesNotMatch(toml, /^\[features\]/m, "a tracked init writes no [features] table")
  if (toggle !== "absent") {
    await fs.writeFile(tomlPath, `${toml.trimEnd()}\n\n[features]\nslack = ${toggle === "on"}\n`, "utf8")
  }

  return {
    root,
    repo,
    home,
    logPath,
    btrain,
    calls: () => readFakeSlackLog(logPath),
    refusals: () => readFakeSlackRefusals(logPath),
    slackStateDir: path.join(repo, ".btrain", "slack"),
  }
}

/** Run `fn` while another process appears to hold a live delivery lock. */
async function withDeliveryHeld(fixture, fn) {
  await fs.mkdir(fixture.slackStateDir, { recursive: true })
  const lockPath = path.join(fixture.slackStateDir, "delivery.lock")
  await fs.writeFile(lockPath, "held-by-the-test", { flag: "wx" })
  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true })
  }
}

function claimArgs(lane = "a", task = "Publisher invariant fixture", files = "src/") {
  return ["handoff", "claim", "--lane", lane, "--task", task, "--owner", "claude", "--reviewer", "codex", "--files", files]
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

async function readAll(files) {
  return Promise.all(files.map(async (file) => ({ file, text: await fs.readFile(file, "utf8") })))
}

async function exists(target) {
  return fs.stat(target).then(() => true, () => false)
}

function assertNoSecret(text, where) {
  for (const marker of SECRET_MARKERS) {
    assert.ok(!text.includes(marker), `${where} holds a secret (${marker.slice(0, 12)}...)`)
  }
}

async function git(args) {
  try {
    const { stdout } = await exec("git", args, { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

describe("spec 024 publisher invariants", () => {
  it("1. with the toggle off or absent, nothing is written under .btrain/slack/ and fetch is never called", async () => {
    for (const toggle of ["absent", "off"]) {
      // Credentials and a channel are configured, so only the toggle keeps it off.
      const fixture = await createSlackRepo({ toggle })
      const features = await fixture.btrain(["features"])
      assert.equal(features.code, 0, features.stderr)
      assert.match(features.stdout, /^\s*\[ \] slack\b/m, `${toggle}: btrain features shows slack off`)

      for (const args of [claimArgs(), metadataUpdateArgs(), ["handoff", "--lane", "a"], ["status"], ["doctor"]]) {
        const result = await fixture.btrain(args)
        // The feature list may name slack (`doctor` prints "features off:
        // slack"); nothing else may, such as a pause warning or a thread line.
        const publisherLines = `${result.stdout}\n${result.stderr}`.split("\n")
          .filter((line) => /slack/i.test(line) && !/^\s*features off:/.test(line))
        assert.deepEqual(publisherLines, [], `${toggle}: ${args.join(" ")} prints nothing from the publisher`)
      }
      assert.equal(await exists(fixture.slackStateDir), false, `${toggle}: no .btrain/slack/ directory`)
      assert.deepEqual(fixture.calls(), [], `${toggle}: no Slack call`)
      assert.deepEqual(fixture.refusals(), [], `${toggle}: no request to any other URL`)
    }
  })

  it("2. a command's state change, event, and printed result or error are complete before any Slack call", async () => {
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
    const handoff = await fixture.btrain(["handoff", "--lane", "a"])
    assert.match(handoff.stdout, /status: in-progress/, "the state change was written")

    // Queue an entry while delivery is held (a lock change is a
    // `locks-changed` reply), then run a command that fails. The queued entry
    // is delivered only after the error is printed.
    const queued = await withDeliveryHeld(fixture, () =>
      fixture.btrain(["handoff", "update", "--lane", "a", "--files", "src/,docs/", "--actor", "claude"]))
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

  it("3. no Slack or delivery outcome throws into a lane command or changes its exit code", async () => {
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
        assert.equal(result.killed, false, `${label}: ${args.join(" ")} did not exit within ${COMMAND_TIMEOUT_MS} ms`)
        assert.equal(result.code, expected[index], `${label}: ${args.join(" ")} keeps its exit code\n${result.stderr}`)
        assert.doesNotMatch(result.stderr, /\n\s+at .+:\d+:\d+/, `${label}: no stack trace reaches the command`)
        assert.ok(result.ms < INLINE_BUDGET_MS + 5000, `${label}: ${args.join(" ")} took ${result.ms} ms`)
      }
      const state = await fixture.btrain(["handoff", "--lane", "a"], { script })
      assert.match(state.stdout, /status: in-progress/, `${label}: the lane state is the command's, not Slack's`)
      assert.ok(fixture.calls().length > 0, `${label}: delivery was attempted`)
    }
  })

  it("4. the outbox, thread map, logs, and command output never hold the token or a secret", async () => {
    const fixture = await createSlackRepo()
    const env = { BTRAIN_SLACK_BOT_TOKEN: TOKEN }
    const task = `Rotate ${GITHUB_PAT} and ${GITHUB_CLASSIC}; the alert hook is ${WEBHOOK}`
    const outputs = []
    const run = async (args, script) => {
      const result = await fixture.btrain(args, { env, script })
      outputs.push(result.stdout, result.stderr)
      return result
    }

    // Leave entries queued and read them before anything delivers them: a
    // flush removes finished entries.
    const queued = await withDeliveryHeld(fixture, async () => {
      assert.equal((await run(claimArgs("a", task))).code, 0)
      // Spec 023 FR-3: a same-lab reviewer needs a granted override.
      assert.equal((await run(["override", "grant", "--action", "same-lab-review", "--lane", "a", "--requested-by", "claude", "--confirmed-by", "human", "--reason", "fixture reassignment"])).code, 0)
      assert.equal((await run(["handoff", "update", "--lane", "a", "--reviewer", "claude-reviewer", "--actor", "claude"])).code, 0)
      return readAll(await listFiles(path.join(fixture.slackStateDir, "outbox")))
    })
    assert.ok(queued.length >= 2, "the claim and the reviewer change are queued")
    for (const { file, text } of queued) {
      assert.ok(!text.includes(TOKEN), `${file} holds the token`)
      assertNoSecret(text, file)
    }

    // Deliver them, so the thread map and any log are written too.
    const slackOutputs = []
    for (const args of [["slack", "flush"], ["slack", "status"], ["slack", "channels"], ["slack", "refresh"]]) {
      const result = await run(args)
      slackOutputs.push(result.stdout, result.stderr)
    }
    assert.ok(await exists(path.join(fixture.slackStateDir, "threads.json")), "the thread map is written")

    for (const { file, text } of await readAll(await listFiles(fixture.slackStateDir))) {
      assert.ok(!text.includes(TOKEN), `${file} holds the token`)
      assertNoSecret(text, file)
    }
    for (const { file, text } of await readAll(await listFiles(path.join(fixture.repo, ".btrain")))) {
      assert.ok(!text.includes(TOKEN), `${file} holds the token`)
    }
    for (const text of outputs) {
      assert.ok(!text.includes(TOKEN), "command output holds the token")
    }
    for (const text of slackOutputs) {
      assertNoSecret(text, "btrain slack output")
    }
    const sent = fixture.calls()
    assert.ok(sent.length > 0)
    for (const call of sent) {
      assertNoSecret(JSON.stringify(call.body), `${call.method} sent to Slack`)
    }
    assert.ok(!(await fs.readFile(fixture.logPath, "utf8")).includes(TOKEN))
  })

  it("5. agent-written text cannot produce a mention or a link", async () => {
    const text = await slackModule("text.mjs")
    const events = await slackModule("events.mjs")
    const render = await slackModule("render.mjs")
    assert.equal(typeof text.prepareAgentText, "function", "WS1: text.mjs exports the one text pipeline function")
    assert.equal(typeof events.classifyWorkflowEvent, "function", "WS1: events.mjs maps a workflow event to a kind")
    assert.equal(typeof render.renderCard, "function", "WS1: render.mjs renders the card")
    assert.equal(typeof render.renderReply, "function", "WS1: render.mjs renders a reply line")

    // Slack also links `www.` and bare domains; the plan's pipeline rewrites
    // only `://`, so those are left out here until the spec decides.
    const hostile = [
      "<!channel> <!here> <!everyone> <@U0000FAKE> <#C0000FAKE> <!subteam^S0000FAKE>",
      "<https://evil.example.invalid|click> https://evil.example.invalid/x",
      `& ${WEBHOOK} ${GITHUB_PAT} ${GITHUB_CLASSIC}`,
    ].join(" ")
    const assertInert = (output, where) => {
      assert.doesNotMatch(output, /[<>]/, `${where}: no raw angle bracket, so no mention or link markup`)
      assert.doesNotMatch(output, /:\/\//, `${where}: no scheme separator, so Slack makes no link`)
      assertNoSecret(output, where)
    }
    // Where the agent text itself is shown, it is escaped and redacted, not dropped.
    const assertEscapedAndRedacted = (output, where) => {
      assert.match(output, /&amp;/, `${where}: & is escaped`)
      assert.match(output, /\[redacted\]/, `${where}: redaction is visible`)
    }

    const prepared = text.prepareAgentText(hostile, { maxChars: 4000 })
    assertInert(prepared, "prepareAgentText")
    assertEscapedAndRedacted(prepared, "prepareAgentText")

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
    // A reply is a fixed template and may not quote the agent text at all.
    assertInert(render.renderReply(classified, context), "renderReply")
    const card = render.renderCard(lane, context)
    assertInert(card, "renderCard")
    assertEscapedAndRedacted(card, "renderCard task line")
  })

  it("6. a card and a board are functions of current lane state, and sending one twice leaves Slack unchanged", async () => {
    const fixture = await createSlackRepo()
    assert.equal((await fixture.btrain(claimArgs("a", "Task at claim time"))).code, 0)
    const cardPost = fixture.calls().find((call) => call.method === "chat.postMessage" && !call.body.thread_ts)
    assert.ok(cardPost?.result?.ts, "the claim posts a card")
    // The claim's 2-second budget leaves the first board post owed (one
    // message a second per channel); a flush posts it, so both refreshes
    // below find a board to update.
    assert.equal((await fixture.btrain(["slack", "flush"])).code, 0)

    // Card fields change while delivery is held, so those updates never reach
    // Slack. The next render must still show current state, not the claim's.
    await withDeliveryHeld(fixture, async () => {
      const task = await fixture.btrain(["handoff", "update", "--lane", "a", "--task", "Task changed while Slack was down", "--actor", "claude"])
      assert.equal(task.code, 0, task.stderr)
      // Spec 023 FR-3: a same-lab reviewer needs a granted override.
      const granted = await fixture.btrain(["override", "grant", "--action", "same-lab-review", "--lane", "a", "--requested-by", "claude", "--confirmed-by", "human", "--reason", "fixture reassignment"])
      assert.equal(granted.code, 0, granted.stderr)
      const reviewer = await fixture.btrain(["handoff", "update", "--lane", "a", "--reviewer", "claude-reviewer", "--actor", "claude"])
      assert.equal(reviewer.code, 0, reviewer.stderr)
    })

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
    assert.match(card.body.text, /Task changed while Slack was down/, "the card shows the current task")
    assert.doesNotMatch(card.body.text, /Task at claim time/, "not the task at claim time")
    assert.match(card.body.text, /owner: claude\b/)
    assert.match(card.body.text, /reviewer: claude-reviewer\b/, "the card shows the current reviewer")
  })

  it("7. a process that finds a live delivery lock skips delivery and returns", async () => {
    // The same claim with the publisher off is the time to beat; the slower
    // of two samples, so one fast sample does not make the test flaky.
    const baseline = await createSlackRepo({ toggle: "off" })
    const samples = [
      await baseline.btrain(claimArgs("a")),
      await baseline.btrain(claimArgs("b", "Second timing sample", "docs/")),
    ]
    for (const sample of samples) assert.equal(sample.code, 0, sample.stderr)
    const baselineMs = Math.max(...samples.map((sample) => sample.ms))

    const fixture = await createSlackRepo()
    await fs.mkdir(fixture.slackStateDir, { recursive: true })
    const lockPath = path.join(fixture.slackStateDir, "delivery.lock")
    const nonce = "another-process-nonce"
    await fs.writeFile(lockPath, nonce, { flag: "wx" })

    const result = await fixture.btrain(claimArgs())
    assert.equal(result.code, 0, result.stderr)
    assert.ok(
      result.ms < baselineMs + NO_WAIT_MARGIN_MS,
      `the command took ${result.ms} ms against ${baselineMs} ms with the publisher off; it must not wait for the lock`,
    )
    assert.deepEqual(fixture.calls(), [], "no Slack call while another process holds a live lock")
    assert.equal(await fs.readFile(lockPath, "utf8"), nonce, "the live lock is left alone")
    assert.ok((await listFiles(path.join(fixture.slackStateDir, "outbox"))).length > 0, "the entry stays queued for the holder")

    const flush = await fixture.btrain(["slack", "flush"])
    assert.equal(flush.code, 0, flush.stderr)
    assert.deepEqual(fixture.calls(), [], "flush also skips while the lock is live")
  })

  it("8. core.mjs gains no function, keeps its pinned line counts, and imports only the slack entry point", async (t) => {
    const inventory = await exec("node", [path.join(REPO_ROOT, "scripts/decomposition_inventory.mjs"), "--stages"], { cwd: REPO_ROOT })
      .then(() => 0, (error) => (typeof error.code === "number" ? error.code : 1))
    assert.equal(inventory, 0, "node scripts/decomposition_inventory.mjs --stages exits 0")

    const { readFunctionSpans } = await import(new URL("../scripts/decomposition_inventory.mjs", import.meta.url))
    const { spans } = readFunctionSpans(path.join(REPO_ROOT, CORE_RELATIVE))
    const linesOf = (list, name) => list.find((span) => span.name === name).lines

    // `--stages` passes when a new function is also added to the assignment
    // JSON, so compare against the branch point: no function added to
    // core.mjs, patchHandoff and runLoop the same length, and no change to
    // the JSON. This guards a branch; on main the branch point is HEAD and
    // the comparison is empty. test/decomposition_inventory.test.mjs pins
    // the two lengths themselves.
    const base = (await git(["merge-base", "HEAD", "origin/main"]))?.trim()
    if (!base) {
      t.diagnostic("origin/main is not available; skipped the comparison with the branch point")
    } else {
      const baseCore = await git(["show", `${base}:${CORE_RELATIVE}`])
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-core-base-"))
      try {
        await fs.writeFile(path.join(scratch, "core.mjs"), baseCore, "utf8")
        const baseSpans = readFunctionSpans(path.join(scratch, "core.mjs")).spans
        const baseNames = new Set(baseSpans.map((span) => span.name))
        const added = spans.map((span) => span.name).filter((name) => !baseNames.has(name))
        assert.deepEqual(added, [], "core.mjs gains no function")
        for (const name of ["patchHandoff", "runLoop"]) {
          assert.equal(linesOf(spans, name), linesOf(baseSpans, name), `${name} keeps its line count`)
        }
      } finally {
        await fs.rm(scratch, { recursive: true, force: true })
      }
      const assignmentDiff = await exec("git", ["diff", "--quiet", base, "--", ASSIGNMENT_RELATIVE], { cwd: REPO_ROOT })
        .then(() => 0, (error) => error.code)
      assert.equal(assignmentDiff, 0, `${ASSIGNMENT_RELATIVE} is unchanged`)
    }

    // core.mjs reaches the publisher through slack/index.mjs only, and no
    // slack/ module imports core.mjs (that would be an import cycle).
    const core = await fs.readFile(path.join(REPO_ROOT, CORE_RELATIVE), "utf8")
    const slackImports = [...core.matchAll(/from\s+["'](\.\/slack\/[^"']+)["']/g)].map((match) => match[1])
    assert.deepEqual([...new Set(slackImports)], ["./slack/index.mjs"])
    for (const file of await listFiles(SLACK_DIR)) {
      if (!file.endsWith(".mjs")) continue
      const source = await fs.readFile(file, "utf8")
      assert.doesNotMatch(source, /from\s+["'][^"']*core\.mjs["']|import\(\s*["'][^"']*core\.mjs["']/, `${path.relative(REPO_ROOT, file)} imports core.mjs`)
    }
  })
})
