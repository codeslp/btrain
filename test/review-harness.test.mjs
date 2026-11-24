// Tests for the spec 023 test harness (implementation plan, WS0):
// test/helpers/fake-runner.mjs and test/helpers/fake-clock.mjs. The fake runner
// must pick up, print, go silent, exit with any text, commit with or without
// the trailer, and run a verdict, both when a test starts it and when btrain's
// reviewer dispatch does.
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { withoutLaneScope } from "./helpers/runner-scope.mjs"
import {
  fakeRunnerEnv,
  installFakeRunner,
  readFakeRunnerLog,
  readFakeRunnerStarts,
  selectFakeRunnerPlan,
  writeFakeRunnerScenario,
} from "./helpers/fake-runner.mjs"
import { createFakeClock } from "./helpers/fake-clock.mjs"
import { resolveAgentLab } from "../src/brain_train/review/labs.mjs"

const exec = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI = path.join(REPO_ROOT, "src/brain_train/cli.mjs")

const roots = []
after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "btrain-review-harness-")))
  roots.push(root)
  return root
}

async function gitRepo(dir) {
  await exec("git", ["init", "-q", "-b", "main", dir])
  await exec("git", ["-C", dir, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", dir, "config", "user.name", "Test Bot"])
  await fs.writeFile(path.join(dir, "README.md"), "x\n", "utf8")
  await exec("git", ["-C", dir, "add", "-A"])
  await exec("git", ["-C", dir, "commit", "-q", "-m", "initial"])
}

/** Start a shim the way a runner is started. Resolves with its exit and output. */
function runShim(shim, { cwd, env, args = [] }) {
  return new Promise((resolve) => {
    const child = spawn(shim, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const lines = []
    const startedAt = Date.now()
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push({ line, ms: Date.now() - startedAt })
    })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, lines }))
  })
}

describe("fake runner", () => {
  it("takes the lab of the executable it is named for, through the runner table", async () => {
    const root = await tempRoot()
    const codex = await installFakeRunner(path.join(root, "bin", "a"), "codex")
    const agent = await installFakeRunner(path.join(root, "bin", "b"), "agent")
    const config = { agents: { runners: { "claude-gpt": `${codex} exec`, cursor: `${agent} -p` } } }
    assert.equal(resolveAgentLab(config, "claude-gpt"), "openai")
    assert.equal(resolveAgentLab(config, "cursor"), "")
  })

  it("prints lines at given times, exits with a code and text, and logs its start", async () => {
    const root = await tempRoot()
    const shim = await installFakeRunner(path.join(root, "bin"), "codex")
    const scenarioPath = await writeFakeRunnerScenario(path.join(root, "scenario.json"), {
      agents: {
        "codex-reviewer": [
          { do: "print", text: "first" },
          { do: "print", text: "second", at: 300 },
          { do: "exit", code: 3, text: "You’ve hit your usage limit." },
        ],
      },
    })
    const logPath = path.join(root, "log.jsonl")
    const env = { ...withoutLaneScope(), ...fakeRunnerEnv({ scenarioPath, logPath, envKeys: ["EXTRA_VAR"] }), BTRAIN_AGENT: "codex-reviewer", BTRAIN_LANE: "a", EXTRA_VAR: "x" }
    const result = await runShim(shim, { cwd: root, env, args: ["exec", "--json", "-C", root, "the prompt"] })
    assert.equal(result.code, 3)
    assert.deepEqual(result.lines.map((item) => item.line), ["first", "second"])
    assert.ok(result.lines[1].ms >= 250, `the second line waited for its time (${result.lines[1].ms} ms)`)
    assert.match(result.stderr, /hit your usage limit/)

    const [start] = await readFakeRunnerStarts(logPath)
    assert.equal(start.agent, "codex-reviewer")
    assert.equal(start.lane, "a")
    assert.equal(start.executable, "codex")
    assert.deepEqual(start.argv, ["exec", "--json", "-C", root, "the prompt"])
    assert.equal(start.env.EXTRA_VAR, "x")
    assert.equal(start.env.BTRAIN_AGENT, "codex-reviewer")
    assert.ok(start.envKeys.includes("PATH"))
    const exit = (await readFakeRunnerLog(logPath)).find((entry) => entry.kind === "exit")
    assert.deepEqual([exit.code, exit.reason], [3, "scenario"])
  })

  it("stays silent until killed, and can ignore SIGTERM", async () => {
    const root = await tempRoot()
    const shim = await installFakeRunner(path.join(root, "bin"), "claude")
    const logPath = path.join(root, "log.jsonl")
    const scenarioPath = await writeFakeRunnerScenario(path.join(root, "scenario.json"), {
      agents: {
        quiet: [{ do: "silent" }],
        stubborn: { ignoreTerm: true, steps: [{ do: "silent" }] },
      },
    })
    const baseEnv = { ...withoutLaneScope(), ...fakeRunnerEnv({ scenarioPath, logPath }) }

    const waitForStart = async (agent) => {
      for (let tries = 0; tries < 200; tries += 1) {
        const entries = await readFakeRunnerLog(logPath)
        if (entries.some((entry) => entry.agent === agent && entry.kind === "step" && entry.do === "silent")) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`${agent} never started`)
    }

    const quiet = spawn(shim, [], { cwd: root, env: { ...baseEnv, BTRAIN_AGENT: "quiet" }, stdio: "ignore" })
    const quietExit = new Promise((resolve) => quiet.on("close", (code, signal) => resolve({ code, signal })))
    await waitForStart("quiet")
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(quiet.exitCode, null, "still running while silent")
    quiet.kill("SIGTERM")
    assert.equal((await quietExit).code, 143)

    const stubborn = spawn(shim, [], { cwd: root, env: { ...baseEnv, BTRAIN_AGENT: "stubborn" }, stdio: "ignore" })
    const stubbornExit = new Promise((resolve) => stubborn.on("close", (code, signal) => resolve({ code, signal })))
    await waitForStart("stubborn")
    stubborn.kill("SIGTERM")
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(stubborn.exitCode, null, "SIGTERM was ignored")
    stubborn.kill("SIGKILL")
    assert.equal((await stubbornExit).signal, "SIGKILL")
    const entries = await readFakeRunnerLog(logPath)
    assert.ok(entries.some((entry) => entry.agent === "stubborn" && entry.do === "signal" && entry.ignored))
  })

  it("commits with the Btrain-Agent trailer, or without it", async () => {
    const root = await tempRoot()
    const repo = path.join(root, "repo")
    await gitRepo(repo)
    const shim = await installFakeRunner(path.join(root, "bin"), "codex")
    const logPath = path.join(root, "log.jsonl")
    const scenarioPath = await writeFakeRunnerScenario(path.join(root, "scenario.json"), {
      default: [
        { do: "commit", file: "src/a.mjs", content: "export const a = 1\n", message: "Fix a" },
        { do: "commit", file: "src/b.mjs", content: "export const b = 1\n", message: "Fix b", trailer: false, noVerify: true },
      ],
    })
    const result = await runShim(shim, { cwd: repo, env: { ...withoutLaneScope(), ...fakeRunnerEnv({ scenarioPath, logPath }), BTRAIN_AGENT: "codex-reviewer" } })
    assert.equal(result.code, 0, result.stderr)
    const messages = (await exec("git", ["-C", repo, "log", "-2", "--format=%B%x00"])).stdout.split("\0").map((text) => text.trim()).filter(Boolean)
    assert.equal(messages[0], "Fix b")
    assert.equal(messages[1], "Fix a\n\nBtrain-Agent: codex-reviewer")
    const commits = (await readFakeRunnerLog(logPath)).filter((entry) => entry.do === "commit")
    assert.deepEqual(commits.map((entry) => [entry.file, entry.trailer, entry.noVerify]), [["src/a.mjs", true, false], ["src/b.mjs", false, true]])
    assert.match(commits[1].head, /^[0-9a-f]{40}$/)
  })

  it("follows the Nth plan on the Nth start of an agent", async () => {
    const root = await tempRoot()
    const shim = await installFakeRunner(path.join(root, "bin"), "gemini")
    const logPath = path.join(root, "log.jsonl")
    const scenarioPath = await writeFakeRunnerScenario(path.join(root, "scenario.json"), {
      agents: { gem: { invocations: [[{ do: "exit", code: 1 }], [{ do: "exit", code: 2 }]] } },
    })
    const env = { ...withoutLaneScope(), ...fakeRunnerEnv({ scenarioPath, logPath }), BTRAIN_AGENT: "gem" }
    const codes = []
    for (let index = 0; index < 3; index += 1) codes.push((await runShim(shim, { cwd: root, env })).code)
    assert.deepEqual(codes, [1, 2, 2])
    assert.deepEqual((await readFakeRunnerStarts(logPath, "gem")).map((entry) => entry.invocation), [0, 1, 2])
  })

  it("selects the default plan for an agent the scenario does not name", () => {
    assert.deepEqual(selectFakeRunnerPlan({ default: [{ do: "exit", code: 4 }] }, "x", 0).steps, [{ do: "exit", code: 4 }])
    assert.deepEqual(selectFakeRunnerPlan({}, "x", 0).steps, [])
  })

  it("is dispatched by btrain as the reviewer, picks the lane up, and approves it", async () => {
    const root = await tempRoot()
    const repo = path.join(root, "repo")
    const home = path.join(root, "home")
    await fs.mkdir(home)
    await exec("git", ["init", "-q", "-b", "main", repo])
    await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
    await exec("git", ["-C", repo, "config", "user.name", "Test Bot"])
    const shim = await installFakeRunner(path.join(root, "bin"), "codex")
    const logPath = path.join(root, "log.jsonl")
    const scenarioPath = await writeFakeRunnerScenario(path.join(root, "scenario.json"), {
      agents: { "codex-reviewer": [{ do: "handoff" }, { do: "print", text: "reviewing" }, { do: "resolve", summary: "Looks right" }] },
    })
    const env = {
      ...withoutLaneScope(),
      BRAIN_TRAIN_HOME: home,
      BTRAIN_DASHBOARD_DISABLED: "1",
      BTRAIN_AGENT: "claude",
      ...fakeRunnerEnv({ scenarioPath, logPath, cliPath: CLI }),
    }
    const btrain = (args, extra = {}) => exec("node", [CLI, ...args], { cwd: repo, env: { ...env, ...extra }, maxBuffer: 5 * 1024 * 1024, timeout: 60_000 })

    await btrain(["init", repo, "--tracked", "--core-only", "--agent", "claude", "--agent", "codex-reviewer"])
    const tomlPath = path.join(repo, ".btrain", "project.toml")
    const toml = await fs.readFile(tomlPath, "utf8")
    await fs.writeFile(tomlPath, toml.replace(/\[agents\.runners\][\s\S]*?\n\[reviews\]/, `[agents.runners]\n"claude" = "notify"\n"codex-reviewer" = "${shim}"\n\n[reviews]`), "utf8")
    await fs.mkdir(path.join(repo, "src"))
    await fs.writeFile(path.join(repo, "src", "feature.mjs"), "export const feature = 1\n")
    await exec("git", ["-C", repo, "add", "-A"])
    await exec("git", ["-C", repo, "commit", "-q", "-m", "initial"])

    await btrain(["handoff", "claim", "--lane", "a", "--task", "Change the feature", "--owner", "claude", "--reviewer", "codex-reviewer", "--files", "src/feature.mjs"])
    const update = await btrain([
      "handoff", "update", "--lane", "a", "--status", "needs-review", "--actor", "claude",
      "--base", "main", "--no-diff", "--preflight",
      "--changed", "src/feature.mjs - change", "--verification", "node --test", "--gap", "None",
      "--why", "Ready.", "--review-ask", "Check it.", "--timeout", "30", "--poll-interval", "0.05",
    ], { BTRAIN_NO_REVIEW_DISPATCH: "0" })
    assert.match(update.stdout, /dispatch codex-reviewer/)
    assert.match(update.stdout, /status: resolved/)

    const entries = await readFakeRunnerLog(logPath)
    const start = entries.find((entry) => entry.kind === "start")
    assert.equal(start.agent, "codex-reviewer")
    assert.equal(start.lane, "a")
    assert.equal(start.executable, "codex")
    assert.ok(start.argv.includes("exec"), `btrain normalized a codex runner: ${JSON.stringify(start.argv)}`)
    const steps = entries.filter((entry) => entry.kind === "step")
    assert.deepEqual(steps.map((entry) => [entry.do, entry.code ?? 0]), [["handoff", 0], ["print", 0], ["resolve", 0]])
    assert.match(await fs.readFile(path.join(repo, ".claude", "collab", "HANDOFF_A.md"), "utf8"), /^Status: resolved$/m)
  })
})

describe("fake clock", () => {
  it("moves time forward on sleep and runs a 15-minute window at once", async () => {
    const clock = createFakeClock({ start: 1_000 })
    const realStart = Date.now()
    let passes = 0
    while (clock.elapsed() < 15 * 60_000) {
      passes += 1
      await clock.sleep(5_000)
    }
    assert.equal(passes, 180)
    assert.equal(clock.now(), 1_000 + 15 * 60_000)
    assert.ok(Date.now() - realStart < 2_000, "a 15-minute window ran in real milliseconds")
    assert.deepEqual(clock.stats(), { sleepCalls: 180, slept: 15 * 60_000 })
    assert.equal(clock.iso(), new Date(1_000 + 15 * 60_000).toISOString())
  })

  it("runs scheduled callbacks at their time, in order, before the sleep returns", async () => {
    const clock = createFakeClock({ start: 0 })
    const seen = []
    clock.at(14 * 60_000, () => seen.push(["progress", clock.now()]))
    clock.at(60_000, async () => {
      await new Promise((resolve) => setImmediate(resolve))
      seen.push(["pickup", clock.now()])
    })
    clock.at(60_000, () => seen.push(["second at the same time", clock.now()]))
    await clock.sleep(10 * 60_000)
    assert.deepEqual(seen, [["pickup", 60_000], ["second at the same time", 60_000]])
    await clock.sleep(5 * 60_000)
    assert.deepEqual(seen.at(-1), ["progress", 14 * 60_000])
    assert.equal(clock.now(), 15 * 60_000)
  })

  it("in manual mode, waits for the test to advance time", async () => {
    const clock = createFakeClock({ start: 0, auto: false })
    let woke = false
    const sleeping = clock.sleep(1_000).then(() => { woke = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(woke, false)
    assert.equal(clock.pendingSleepers(), 1)
    await clock.advance(999)
    assert.equal(woke, false)
    await clock.advance(1)
    await sleeping
    assert.equal(woke, true)
    await assert.rejects(clock.advanceTo(0), /cannot go back/)
  })
})
