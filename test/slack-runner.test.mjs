// Spec 025 T020 (WS4 step 1): slack/runner.mjs against the fake `claude` of
// T002. No real model runs. Skipped on Windows, as the fake is.

import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  ADDED_ARGS,
  ALLOWED_ENV_NAMES,
  OUTPUT_CAP_BYTES,
  RUN_REPLIES,
  checkFirstEvent,
  resolveProfile,
  runOnce,
  runnerEnv,
} from "../src/brain_train/slack/runner.mjs"
import {
  BUILT_IN_AGENTS,
  DEFAULT_FIRST_EVENT,
  firstEventWith,
  installFakeOrchestratorRunner,
  readFakeOrchestratorRecords,
  writeFakeOrchestratorControl,
} from "./helpers/fake-orchestrator-runner.mjs"

const skip = process.platform === "win32"
const tempDirs = []
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const BASE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: os.tmpdir(),
  TMPDIR: os.tmpdir(),
  LANG: "C",
  ANTHROPIC_API_KEY: "value-that-must-not-pass", // btrain-allow: env-var-required (a fake value the runner must drop)
  BTRAIN_AGENT: "claude",
  SLACK_THING: "x",
  GITHUB_TOKEN: "y",
  ANTHROPIC_BASE_URL: "http://example.invalid",
}

async function fake(control) {
  const runner = await installFakeOrchestratorRunner(await tempDir("runner-bin-"))
  if (control !== undefined) await writeFakeOrchestratorControl(runner, control)
  return runner
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("slack/runner.mjs (spec 025 T020)", { skip }, () => {
  describe("resolveProfile", () => {
    it("accepts the claude profile with its allowed extra words", () => {
      for (const runner of ["claude -p", "claude --print", "/opt/bin/claude -p --model opus", "claude -p --effort high --model sonnet-5"]) {
        const result = resolveProfile(runner, { platform: "darwin" })
        assert.equal(result.ok, true, `${runner}: ${result.reason}`)
        assert.equal(result.profile.name, "claude")
      }
      assert.deepEqual(resolveProfile("claude -p --model opus", { platform: "linux" }).words, ["-p", "--model", "opus"])
    })

    it("refuses a word the profile does not allow, an unknown basename, and Windows", () => {
      const refused = [
        "claude -p --dangerously-skip-permissions",
        "claude -p --tools Bash",
        "claude -p --model",
        "claude -p --model -x",
        "claude -p --effort extreme",
        "claude -p extra",
        "codex exec",
        "my-claude -p",
      ]
      for (const runner of refused) {
        assert.equal(resolveProfile(runner, { platform: "darwin" }).ok, false, runner)
      }
      assert.match(resolveProfile("claude -p", { platform: "win32" }).reason, /macOS and Linux/)
      assert.equal(resolveProfile("", { platform: "darwin" }).ok, false)
    })
  })

  describe("runnerEnv", () => {
    it("passes only the allowed names, none holding KEY, TOKEN, BTRAIN, or SLACK", () => {
      const env = runnerEnv({ ...BASE_ENV, http_proxy: "p", CLAUDE_CONFIG_DIR: "/c", TERM: "xterm" })
      assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "TERM", "TMPDIR", "http_proxy"])
      for (const name of ALLOWED_ENV_NAMES) assert.doesNotMatch(name, /KEY|TOKEN|BTRAIN|SLACK/)
    })
  })

  describe("checkFirstEvent (amended FR-15)", () => {
    const line = (event) => JSON.stringify(event)

    it("passes the profile probe's first event, with the messaging socket path set", () => {
      assert.deepEqual(checkFirstEvent(line({ ...DEFAULT_FIRST_EVENT, messaging_socket_path: "/tmp/sock" })), { ok: true, reason: "" })
    })

    it("fails a tool, an MCP server, an API key, a skill, a slash command, a fifth agent, a missing agent, and an unreadable event", () => {
      const failing = {
        tool: firstEventWith({ tools: ["Bash"] }),
        mcp: firstEventWith({ mcp_servers: [{ name: "x", status: "connected" }] }),
        apiKey: firstEventWith({ apiKeySource: "ANTHROPIC_API_KEY" }),
        skill: firstEventWith({ skills: ["review"] }),
        slash: firstEventWith({ slash_commands: ["review"] }),
        fifthAgent: firstEventWith({ agents: [...BUILT_IN_AGENTS, "web-fetch"] }),
        missingAgent: firstEventWith({ agents: BUILT_IN_AGENTS.slice(0, 3) }),
        noAgents: firstEventWith({ agents: undefined }),
        noTools: firstEventWith({ tools: undefined }),
        notInit: { ...DEFAULT_FIRST_EVENT, type: "assistant" },
      }
      for (const [name, event] of Object.entries(failing)) {
        const result = checkFirstEvent(line(event))
        assert.equal(result.ok, false, name)
        assert.ok(result.reason, name)
      }
      assert.equal(checkFirstEvent("not json {").ok, false)
      assert.equal(checkFirstEvent("").ok, false)
    })
  })

  describe("runOnce", () => {
    it("runs the profile's exact arguments in an empty directory with the input on standard input, and returns the reply", async () => {
      const runner = await fake({ reply: "Lane e is in review." })
      const result = await runOnce({ runner: `${runner.executable} -p`, input: "what is in review?", turnSeconds: 20, env: BASE_ENV })
      assert.equal(result.outcome, "reply", result.reason)
      assert.equal(result.reply, "Lane e is in review.")
      const [record] = await readFakeOrchestratorRecords(runner)
      assert.deepEqual(record.argv, ["-p", ...ADDED_ARGS])
      assert.deepEqual(record.cwdListing, [])
      assert.equal(record.stdin, "what is in review?")
      for (const name of record.envNames) {
        assert.ok(ALLOWED_ENV_NAMES.includes(name), name)
        assert.doesNotMatch(name, /KEY|TOKEN|BTRAIN|SLACK/)
      }
      await assert.rejects(fs.stat(record.cwd), "the run directory is removed")
    })

    it("adds --disable-slash-commands and the stream flags", () => {
      assert.ok(ADDED_ARGS.includes("--disable-slash-commands"))
      assert.deepEqual(ADDED_ARGS.slice(-3), ["--output-format", "stream-json", "--verbose"])
    })

    it("reads the reply from the result event wherever it falls", async () => {
      const runner = await fake({ reply: "OK", rateLimitFirst: true })
      const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 20, env: BASE_ENV })
      assert.equal(result.outcome, "reply")
      assert.equal(result.reply, "OK")
    })

    it("stops a run whose first event fails the check, discards its output, and marks the profile failed", async () => {
      const runner = await fake({ firstEvent: firstEventWith({ tools: ["Bash"] }), neverExit: true })
      const started = Date.now()
      const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 30, env: BASE_ENV })
      assert.equal(result.outcome, "failed")
      assert.equal(result.profileFailed, true)
      assert.equal(result.reply, RUN_REPLIES.failed)
      assert.ok(Date.now() - started < 10_000, "stopped at the first event, not at the timer")
      const [record] = await readFakeOrchestratorRecords(runner)
      assert.equal(alive(record.pid), false)
    })

    it("an unreadable first event fails the profile too", async () => {
      const runner = await fake({ firstEvent: "garbage" })
      const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 20, env: BASE_ENV })
      assert.equal(result.outcome, "failed")
      assert.equal(result.profileFailed, true)
    })

    it("stops a run at turnSeconds; its process group is gone and the timeout reply is given", async () => {
      const runner = await fake({ neverExit: true })
      const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 0.5, env: BASE_ENV })
      assert.equal(result.outcome, "timedOut")
      assert.equal(result.reply, RUN_REPLIES.timedOut)
      const [record] = await readFakeOrchestratorRecords(runner)
      assert.equal(alive(record.pid), false)
    })

    it("sends SIGKILL one second after SIGTERM to a run that ignores SIGTERM", async () => {
      const runner = await fake({ neverExit: true, ignoreTerm: true })
      const started = Date.now()
      const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 0.5, env: BASE_ENV })
      assert.equal(result.outcome, "timedOut")
      assert.ok(Date.now() - started >= 1400, "waited for the SIGKILL")
      const [record] = await readFakeOrchestratorRecords(runner)
      assert.equal(alive(record.pid), false)
    })

    it("a missing executable gets the not-installed reply", async () => {
      const dir = await tempDir("runner-missing-")
      const result = await runOnce({ runner: `${path.join(dir, "claude")} -p`, input: "x", turnSeconds: 5, env: BASE_ENV })
      assert.equal(result.outcome, "missing")
      assert.equal(result.reply, RUN_REPLIES.missing)
    })

    it("a non-zero exit with the usage or sign-in pattern gets the out-of-usage reply", async () => {
      for (const control of [
        { reply: "Failed to authenticate: OAuth session expired and could not be refreshed", exitCode: 1 },
        { reply: null, exitCode: 1, stderr: "Claude usage limit reached. Your limit will reset at 5pm.\n" },
      ]) {
        const runner = await fake(control)
        const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 20, env: BASE_ENV })
        assert.equal(result.outcome, "outOfUsage", JSON.stringify(control))
        assert.equal(result.reply, RUN_REPLIES.outOfUsage)
      }
    })

    it("any other non-zero exit, an exit 0 with no result event, and empty output get the failed reply", async () => {
      for (const control of [
        { exitCode: 3, stderr: "something broke\n" },
        { reply: null, exitCode: 0 },
        { firstEvent: null, reply: null, exitCode: 0 },
      ]) {
        const runner = await fake(control)
        const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 20, env: BASE_ENV })
        assert.equal(result.outcome, "failed", JSON.stringify(control))
        assert.equal(result.reply, RUN_REPLIES.failed)
        assert.ok(!result.reply.includes("something broke"), "error output is never in the reply")
      }
    })

    it("output past the 64 KB cap is not kept, and a result lost to the cap is a failed run", async () => {
      assert.equal(OUTPUT_CAP_BYTES, 64 * 1024)
      const runner = await fake({ reply: "x".repeat(70 * 1024) })
      const result = await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 20, env: BASE_ENV })
      assert.equal(result.outcome, "failed")
      assert.match(result.reason, /64 KB/)
    })

    it("a runner string with no profile starts no process", async () => {
      const runner = await fake()
      const result = await runOnce({ runner: `${runner.executable} -p --dangerously-skip-permissions`, input: "x", turnSeconds: 5, env: BASE_ENV })
      assert.equal(result.outcome, "noProfile")
      assert.deepEqual(await readFakeOrchestratorRecords(runner), [])
    })

    it("error output goes to the log only, scrubbed", async () => {
      const lines = []
      const secret = ["AKIA", "ABCDEFGHIJKLMNOP"].join("")
      const runner = await fake({ exitCode: 3, stderr: `boom ${secret}\n` })
      await runOnce({ runner: `${runner.executable} -p`, input: "x", turnSeconds: 20, env: BASE_ENV, log: (line) => lines.push(line) })
      const joined = lines.join("\n")
      assert.match(joined, /boom/)
      assert.ok(!joined.includes(secret))
    })
  })
})
