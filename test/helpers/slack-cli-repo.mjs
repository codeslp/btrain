// A temporary repository driven through the real btrain CLI with the fake
// Slack preload (spec 024 WS4 tests). The same fixture as
// test/slack-invariants.test.mjs, with options for a missing token, a missing
// channel, PR flow, and a GitHub remote.
//
// Every repository gets its own BRAIN_TRAIN_HOME in a temporary directory, so
// nothing registers in the real ~/.btrain and nothing reads the real
// ~/.btrain/slack.json. No call reaches Slack: the preload answers from the
// fake and refuses any other URL.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { withoutLaneScope } from "./runner-scope.mjs"
import { fakeSlackProcessEnv, readFakeSlackLog, readFakeSlackRefusals } from "./fake-slack.mjs"

const exec = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const CLI = path.join(REPO_ROOT, "src/brain_train/cli.mjs")

// Fake values, built at runtime so the source holds no string that matches a
// secret pattern.
export const TOKEN = ["xoxb", "0000", "fake", "wiring", "token"].join("-")
export const CHANNEL = "C0000FAKE"
export const OPERATOR = "U0000FAKE"
// A command that hangs is killed after this, so a regression fails the test
// instead of wedging the suite.
export const COMMAND_TIMEOUT_MS = 15000

/**
 * Create the repository. `toggle` is "on", "off", or "absent". `token: false`
 * leaves the token out of slack.json; `channel: false` maps no channel.
 * `prFlow` turns on `[pr_flow]`; `remote` adds an `origin` remote.
 * `runners` replaces lines of `[agents.runners]`, as `{ agent: command }`.
 */
export async function createSlackRepo({
  toggle = "on",
  token = true,
  channel = true,
  prFlow = false,
  remote = "",
  runners = {},
  roots,
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-slack-wiring-")))
  roots?.push(root)
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  const logPath = path.join(root, "fake-calls.jsonl")
  await fs.mkdir(home, { recursive: true })
  await exec("git", ["init", "-q", repo])
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", repo, "config", "user.name", "Test Bot"])
  if (remote) await exec("git", ["-C", repo, "remote", "add", "origin", remote])

  const baseEnv = {
    ...withoutLaneScope(),
    BRAIN_TRAIN_HOME: home,
    BTRAIN_AGENT: "claude",
    BTRAIN_DASHBOARD_DISABLED: "1",
  }
  delete baseEnv.BTRAIN_SLACK_BOT_TOKEN
  delete baseEnv.BTRAIN_NO_REVIEW_DISPATCH

  const configPath = path.join(home, "slack.json")
  await fs.writeFile(configPath, `${JSON.stringify({
    ...(token ? { botToken: TOKEN } : {}),
    label: "test-dev",
    operator: OPERATOR,
    mention: [OPERATOR],
    channels: channel ? { [repo]: CHANNEL } : {},
  }, null, 2)}\n`, { mode: 0o600 })
  await fs.chmod(configPath, 0o600)

  /** Run btrain with the fake Slack preload. Never throws on a non-zero exit. */
  async function btrain(args, { script, env = {}, agent = "claude" } = {}) {
    const started = Date.now()
    try {
      const result = await exec("node", [CLI, ...args], {
        cwd: repo,
        env: { ...baseEnv, BTRAIN_AGENT: agent, ...fakeSlackProcessEnv({ logPath, script, expectedToken: TOKEN }), ...env },
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
  let toml = await fs.readFile(tomlPath, "utf8")
  if (prFlow) toml = toml.replace("[pr_flow]\nenabled = false", "[pr_flow]\nenabled = true")
  for (const [agent, command] of Object.entries(runners)) {
    toml = toml.replace(new RegExp(`^"${agent}" = .*$`, "m"), `"${agent}" = "${command}"`)
  }
  if (toggle !== "absent") toml = `${toml.trimEnd()}\n\n[features]\nslack = ${toggle === "on"}\n`
  await fs.writeFile(tomlPath, toml, "utf8")
  await fs.mkdir(path.join(repo, "src"), { recursive: true })
  await fs.writeFile(path.join(repo, "src", "feature.txt"), "feature\n", "utf8")

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
export async function withDeliveryHeld(fixture, fn) {
  await fs.mkdir(fixture.slackStateDir, { recursive: true })
  const lockPath = path.join(fixture.slackStateDir, "delivery.lock")
  await fs.writeFile(lockPath, "held-by-the-test", { flag: "wx" })
  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true })
  }
}

export function claimArgs(lane = "a", task = "Wiring fixture", files = "src/") {
  return ["handoff", "claim", "--lane", lane, "--task", task, "--owner", "claude", "--reviewer", "codex", "--files", files]
}

/** `handoff update` to needs-review with complete reviewer context. */
export function needsReviewArgs(lane = "a", { dispatch = false } = {}) {
  return [
    "handoff", "update", "--lane", lane, "--status", "needs-review", "--actor", "claude",
    ...(dispatch ? ["--timeout", "30", "--poll-interval", "0.05"] : ["--no-dispatch"]),
    "--no-diff", "--base", "main",
    "--preflight", "Read the locked files.",
    "--changed", "src/feature.txt: the change",
    "--verification", "node --test",
    "--gap", "none",
    "--why", "The lane is ready for review.",
    "--review-ask", "Check the change.",
  ]
}

/** The outbox entry files, in name order. */
export async function outboxFiles(fixture) {
  const dir = path.join(fixture.slackStateDir, "outbox")
  const names = await fs.readdir(dir).catch(() => [])
  return names.filter((name) => name.endsWith(".json")).sort().map((name) => path.join(dir, name))
}
