// Spec 025 T023 (WS4 step 5): the profile check, runner-check.json, the check
// at listener start, and the listener findings of `btrain doctor`. Every run
// is the T002 fake `claude`. Skipped on Windows, as the fake is.

import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  RUNNER_CHECK_FILE,
  cliVersion,
  readRunnerCheck,
  runProfileCheck,
  saveVerdict,
  verdictMatches,
} from "../src/brain_train/slack/profile-check.mjs"
import { PROFILE_VERSION } from "../src/brain_train/slack/runner.mjs"
import { collectSlackDoctorFindings } from "../src/brain_train/slack/doctor.mjs"
import { setPaused } from "../src/brain_train/slack/lease.mjs"
import { createListener } from "../src/brain_train/slack/listen.mjs"
import {
  firstEventWith,
  installFakeOrchestratorRunner,
  readFakeOrchestratorRecords,
  writeFakeOrchestratorControl,
} from "./helpers/fake-orchestrator-runner.mjs"

const skip = process.platform === "win32"
const roots = []
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

const OPERATOR = "U0000OPER"
const CHANNEL = "C0000FAKE"
const TOKEN = ["xoxb", "0000", "fake", "check", "token"].join("-")

async function home() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-profile-check-")))
  roots.push(root)
  const dir = path.join(root, "home")
  await fs.mkdir(path.join(dir, "slack"), { recursive: true })
  const env = { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: os.tmpdir(), BRAIN_TRAIN_HOME: dir }
  return { root, dir, slackDir: path.join(dir, "slack"), env }
}

async function fakeRunner(where, control) {
  const runner = await installFakeOrchestratorRunner(where)
  if (control) await writeFakeOrchestratorControl(runner, control)
  return runner
}

// The fake answers `--version` like any run: its reply is the version line.
async function versionedFake(where, control = {}) {
  return fakeRunner(where, { runs: [{ raw: "9.9.9 (Claude Code)\n" }, control] })
}

describe("slack/profile-check.mjs (spec 025 T023)", { skip }, () => {
  describe("runProfileCheck", () => {
    it("runs the profile once with 'Reply with OK', passes it, and saves the verdict with the runner, profile version, and CLI version", async () => {
      const h = await home()
      const runner = await versionedFake(path.join(h.root, "bin"))
      const verdict = await runProfileCheck({ runner: `${runner.executable} -p`, env: h.env, slackDir: h.slackDir, turnSeconds: 20 })
      assert.equal(verdict.ok, true, verdict.reason)
      const records = await readFakeOrchestratorRecords(runner)
      assert.deepEqual(records[0].argv, ["--version"])
      assert.equal(records[1].stdin, "Reply with OK")
      assert.ok(records[1].argv.includes("--disable-slash-commands"))
      const saved = readRunnerCheck(h.slackDir)
      assert.equal(saved.ok, true)
      assert.equal(saved.runner, `${runner.executable} -p`)
      assert.equal(saved.profileVersion, PROFILE_VERSION)
      assert.match(saved.cliVersion, /9\.9\.9/)
      assert.ok(Date.parse(saved.checkedAt))
      const stat = await fs.stat(path.join(h.slackDir, RUNNER_CHECK_FILE))
      assert.equal(stat.mode & 0o777, 0o600)
    })

    it("fails the profile for a first event with a tool, an MCP server, an API key, a skill, a slash command, or a fifth agent, and saves the failure", async () => {
      const failing = [
        { tools: ["Bash"] },
        { mcp_servers: [{ name: "x" }] },
        { apiKeySource: "ANTHROPIC_API_KEY" },
        { skills: ["review"] },
        { slash_commands: ["review"] },
        { agents: ["claude", "Explore", "general-purpose", "Plan", "web-fetch"] },
      ]
      for (const overrides of failing) {
        const h = await home()
        const runner = await versionedFake(path.join(h.root, "bin"), { firstEvent: firstEventWith(overrides) })
        const verdict = await runProfileCheck({ runner: `${runner.executable} -p`, env: h.env, slackDir: h.slackDir, turnSeconds: 20 })
        assert.equal(verdict.ok, false, JSON.stringify(overrides))
        assert.ok(verdict.reason)
        assert.equal(readRunnerCheck(h.slackDir).ok, false)
      }
    })

    it("saves nothing when the run cannot judge the profile (missing, timed out, out of usage)", async () => {
      const h = await home()
      const missing = await runProfileCheck({ runner: `${path.join(h.root, "nowhere", "claude")} -p`, env: h.env, slackDir: h.slackDir, turnSeconds: 5 })
      assert.equal(missing.ok, false)
      assert.equal(missing.saved, false)
      const runner = await versionedFake(path.join(h.root, "bin"), { reply: "Failed to authenticate: OAuth session expired", exitCode: 1 })
      const usage = await runProfileCheck({ runner: `${runner.executable} -p`, env: h.env, slackDir: h.slackDir, turnSeconds: 20 })
      assert.equal(usage.ok, false)
      assert.equal(usage.saved, false)
      assert.equal(readRunnerCheck(h.slackDir), null)
    })

    it("a runner string with no profile is not started and not saved", async () => {
      const h = await home()
      const runner = await fakeRunner(path.join(h.root, "bin"))
      const verdict = await runProfileCheck({ runner: `${runner.executable} -p --dangerously-skip-permissions`, env: h.env, slackDir: h.slackDir, turnSeconds: 5 })
      assert.equal(verdict.ok, false)
      assert.deepEqual(await readFakeOrchestratorRecords(runner), [])
      assert.equal(readRunnerCheck(h.slackDir), null)
    })
  })

  describe("the saved verdict", () => {
    it("matches only the same runner string, profile version, and CLI version", () => {
      const verdict = { runner: "claude -p", profileVersion: PROFILE_VERSION, cliVersion: "2.1.274", ok: true }
      assert.equal(verdictMatches(verdict, { runner: "claude -p", cliVersion: "2.1.274" }), true)
      assert.equal(verdictMatches(verdict, { runner: "claude -p --model opus", cliVersion: "2.1.274" }), false)
      assert.equal(verdictMatches(verdict, { runner: "claude -p", cliVersion: "2.1.275" }), false)
      assert.equal(verdictMatches({ ...verdict, profileVersion: PROFILE_VERSION + 1 }, { runner: "claude -p", cliVersion: "2.1.274" }), false)
      assert.equal(verdictMatches(null, { runner: "claude -p", cliVersion: "2.1.274" }), false)
    })

    it("a saved verdict whose ok is not a boolean reads as no verdict (M4)", async () => {
      const h = await home()
      for (const ok of ["false", 0, null, undefined]) {
        await fs.writeFile(path.join(h.slackDir, RUNNER_CHECK_FILE), JSON.stringify({ runner: "claude -p", profileVersion: PROFILE_VERSION, cliVersion: "2.0", ok }))
        assert.equal(readRunnerCheck(h.slackDir), null, JSON.stringify(ok))
      }
    })

    it("saveVerdict records a failed ordinary run, and an unreadable file reads as no verdict", async () => {
      const h = await home()
      saveVerdict(h.slackDir, { runner: "claude -p", cliVersion: "1", ok: false, reason: "the run reports tools" })
      assert.equal(readRunnerCheck(h.slackDir).reason, "the run reports tools")
      await fs.writeFile(path.join(h.slackDir, RUNNER_CHECK_FILE), "{not json")
      assert.equal(readRunnerCheck(h.slackDir), null)
    })

    it("cliVersion reads the first line of '<runner> --version' and is empty when the runner is missing", async () => {
      const h = await home()
      const runner = await fakeRunner(path.join(h.root, "bin"), { raw: "2.1.274 (Claude Code)\nmore\n" })
      assert.match(await cliVersion(`${runner.executable} -p`, { env: h.env }), /2\.1\.274/)
      assert.equal(await cliVersion(`${path.join(h.root, "none", "claude")} -p`, { env: h.env }), "")
    })
  })

  describe("the check at listener start", () => {
    async function listenerHome(runnerControl, { runner } = {}) {
      const h = await home()
      const fakeRun = runnerControl === undefined ? null : await versionedFake(path.join(h.root, "bin"), runnerControl)
      const settings = { botToken: TOKEN, operator: OPERATOR, channels: {}, orchestrator: { runner: runner ?? `${fakeRun.executable} -p` } }
      const file = path.join(h.dir, "slack.json")
      await fs.writeFile(file, JSON.stringify(settings), { mode: 0o600 })
      await fs.chmod(file, 0o600)
      const fetch = async () => new Response(JSON.stringify({ ok: true, user_id: "U0FAKEBOT1" }), { status: 200, headers: { "content-type": "application/json" } })
      const listener = await createListener({ home: h.dir, env: h.env, fetch, readers: { readConfig: async () => ({}), readRoster: async () => null }, now: () => 1700000000000 })
      return { h, fakeRun, listener }
    }

    it("runs the profile check when the listener takes its lease, and keeps the verdict", async () => {
      const { h, fakeRun, listener } = await listenerHome({})
      const taken = await listener.acquire()
      await listener.profileReady
      assert.equal(taken.ok, true)
      assert.equal(listener.profile.ok, true, listener.profile.reason)
      assert.equal(readRunnerCheck(h.slackDir).ok, true)
      assert.equal((await readFakeOrchestratorRecords(fakeRun)).filter((rec) => rec.argv[0] !== "--version").length, 1)
      await listener.stop()
    })

    it("a failed check at start leaves the model off with the reason", async () => {
      const { listener } = await listenerHome({ firstEvent: firstEventWith({ skills: ["review"] }) })
      await listener.acquire()
      await listener.profileReady
      assert.equal(listener.profile.ok, false)
      assert.match(listener.profile.reason, /skills/)
      await listener.stop()
    })

    // FR-15: the check runs whenever the listener starts; only btrain doctor
    // reuses a saved verdict. A saved failure therefore recovers once the
    // configuration is fixed, and a saved pass is checked again.
    for (const savedOk of [false, true]) {
      it(`runs a fresh check at start despite a saved ${savedOk ? "pass" : "failure"} for the same runner and version`, async () => {
        const { h, fakeRun, listener } = await listenerHome(savedOk ? { firstEvent: firstEventWith({ tools: ["Bash"] }) } : {})
        saveVerdict(h.slackDir, { runner: `${fakeRun.executable} -p`, cliVersion: "9.9.9 (Claude Code)", ok: savedOk, reason: savedOk ? "" : "an earlier configuration reported tools" })
        await listener.acquire()
        await listener.profileReady
      await listener.profileReady
        assert.equal((await readFakeOrchestratorRecords(fakeRun)).filter((rec) => rec.argv[0] !== "--version").length, 1)
        assert.equal(listener.profile.ok, !savedOk)
        assert.equal(readRunnerCheck(h.slackDir).ok, !savedOk, "the fresh verdict is saved")
        await listener.stop()
      })
    }

    it("acquire returns while the check runs, and stop cancels a stalled check at once without saving a verdict (PR #158 review)", async () => {
      const { h, fakeRun, listener } = await listenerHome({ neverExit: true })
      const started = Date.now()
      assert.equal((await listener.acquire()).ok, true)
      assert.ok(Date.now() - started < 5000, "acquire did not wait for the check")
      assert.equal(listener.profile.ok, false)
      assert.match(listener.profile.reason, /running/)
      const records = async () => (await readFakeOrchestratorRecords(fakeRun)).filter((rec) => rec.argv[0] !== "--version")
      for (let i = 0; i < 100 && (await records()).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
      const [check] = await records()
      assert.ok(check, "the check started")
      const stopping = Date.now()
      await listener.stop()
      assert.ok(Date.now() - stopping < 5000, "stop did not wait for turnSeconds")
      assert.throws(() => process.kill(check.pid, 0), "the check's process is gone")
      assert.equal(readRunnerCheck(h.slackDir), null)
      await listener.profileReady
      assert.equal(listener.profile.ok, false)
    })

    it("with the model off (empty runner) no check runs", async () => {
      const { listener } = await listenerHome(undefined, { runner: "" })
      await listener.acquire()
      await listener.profileReady
      assert.equal(listener.profile.ok, false)
      assert.match(listener.profile.reason, /model is off/)
      await listener.stop()
    })
  })

  describe("btrain doctor listener findings", () => {
    async function repo(h, { slack = true, slackListen = true, auto } = {}) {
      const dir = path.join(h.root, "repo")
      await fs.mkdir(dir, { recursive: true })
      const config = { features: { slack, slack_listen: slackListen } }
      if (auto) config.slack = { orchestrator: { auto } }
      return { dir, config }
    }

    async function slackJson(h, { operator = OPERATOR, runner } = {}) {
      const settings = { botToken: TOKEN, channels: { [path.join(h.root, "repo")]: CHANNEL }, orchestrator: { runner } }
      if (operator) settings.operator = operator
      const file = path.join(h.dir, "slack.json")
      await fs.writeFile(file, JSON.stringify(settings), { mode: 0o600 })
      await fs.chmod(file, 0o600)
    }

    const doctor = (r, h, extra = {}) => collectSlackDoctorFindings(r.dir, r.config, { env: { ...h.env, ...extra } })

    it("with slack_listen off reads nothing and starts nothing", async () => {
      const h = await home()
      const runner = await versionedFake(path.join(h.root, "bin"))
      await slackJson(h, { runner: `${runner.executable} -p` })
      const r = await repo(h, { slackListen: false })
      const { warnings } = await doctor(r, h)
      assert.ok(!warnings.some((w) => w.includes("listener")), warnings.join("\n"))
      assert.deepEqual(await readFakeOrchestratorRecords(runner), [])
    })

    it("reports slack_listen on with slack off", async () => {
      const h = await home()
      const r = await repo(h, { slack: false })
      const { warnings } = await doctor(r, h)
      assert.ok(warnings.some((w) => /slack_listen is on but \[features\]\.slack is off/.test(w)), warnings.join("\n"))
    })

    it("reports no operator, start or pause in auto, a runner with no profile, and a paused listener", async () => {
      const h = await home()
      await slackJson(h, { operator: "", runner: "claude -p --dangerously-skip-permissions" })
      await setPaused(h.slackDir)
      const r = await repo(h, { auto: ["status", "start", "pause"] })
      const { warnings } = await doctor(r, h)
      const text = warnings.join("\n")
      assert.match(text, /no operator/)
      assert.match(text, /auto/)
      assert.match(text, /start/)
      assert.match(text, /pause/)
      assert.match(text, /no profile/)
      assert.match(text, /listener is paused/)
    })

    it("runs the check when no verdict is saved, reports a failure, and does not run it again for the same runner and version", async () => {
      const h = await home()
      const runner = await versionedFake(path.join(h.root, "bin"), { firstEvent: firstEventWith({ tools: ["Bash"] }) })
      await slackJson(h, { runner: `${runner.executable} -p` })
      const r = await repo(h)
      const first = await doctor(r, h)
      assert.ok(first.warnings.some((w) => /profile check failed/.test(w)), first.warnings.join("\n"))
      const startsAfterFirst = (await readFakeOrchestratorRecords(runner)).filter((rec) => rec.argv[0] !== "--version").length
      assert.equal(startsAfterFirst, 1)
      await writeFakeOrchestratorControl(runner, { raw: "9.9.9 (Claude Code)\n" })
      const second = await doctor(r, h)
      assert.ok(second.warnings.some((w) => /profile check failed/.test(w)), "the saved verdict is reported")
      const startsAfterSecond = (await readFakeOrchestratorRecords(runner)).filter((rec) => rec.argv[0] !== "--version").length
      assert.equal(startsAfterSecond, 1, "no second model run")
    })

    it("reports a check that could not run (a missing runner), without saving a verdict", async () => {
      const h = await home()
      await slackJson(h, { runner: `${path.join(h.root, "missing", "claude")} -p` })
      const r = await repo(h)
      const { warnings } = await doctor(r, h)
      assert.ok(warnings.some((w) => /profile check could not judge the profile .*not found/.test(w)), warnings.join("\n"))
      assert.equal(readRunnerCheck(h.slackDir), null)
    })

    it("never runs the check in a lane-pinned session", async () => {
      const h = await home()
      const runner = await versionedFake(path.join(h.root, "bin"))
      await slackJson(h, { runner: `${runner.executable} -p` })
      const r = await repo(h)
      await doctor(r, h, { BTRAIN_LANE_LOCKED: "1", BTRAIN_LANE: "a" })
      const starts = (await readFakeOrchestratorRecords(runner)).filter((rec) => rec.argv[0] !== "--version")
      assert.deepEqual(starts, [])
      assert.equal(readRunnerCheck(h.slackDir), null)
    })

    it("an empty runner (model off) runs no check and reports no runner finding", async () => {
      const h = await home()
      await slackJson(h, { runner: "" })
      const r = await repo(h)
      const { warnings } = await doctor(r, h)
      assert.ok(!warnings.some((w) => /profile/.test(w)), warnings.join("\n"))
    })
  })
})
