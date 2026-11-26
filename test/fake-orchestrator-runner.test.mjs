// Tests for the fake `claude` executable of spec 025 T002
// (test/helpers/fake-orchestrator-runner.mjs). The fake stands in for the
// orchestrator CLI in WS4 tests, so these tests pin what it records and what
// it writes. They are skipped on Windows, as every test that uses it is.

import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import {
  DEFAULT_FIRST_EVENT,
  firstEventWith,
  installFakeOrchestratorRunner,
  readFakeOrchestratorRecords,
  writeFakeOrchestratorControl,
} from "./helpers/fake-orchestrator-runner.mjs"

const skip = process.platform === "win32"
const PROBE_FIXTURE = new URL("./fixtures/claude-stream/profile-probe.json", import.meta.url)
const PROFILE_ARGS = ["-p", "--tools", "", "--output-format", "stream-json", "--verbose"]

const tempDirs = []
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

// Start the fake the way the runner will: its own process group, a fixed
// environment, input on standard input. Resolves with the output and the exit.
function startRun(executable, { cwd, env, input = "Reply with OK", args = PROFILE_ARGS } = {}) {
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  const lines = []
  const firstLine = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      const complete = stdout.split("\n").slice(0, -1)
      while (lines.length < complete.length) lines.push({ line: complete[lines.length], at: Date.now() })
      if (lines.length > 0) resolve(lines[0])
    })
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, lines }))
  })
  child.stdin.end(input)
  return { child, firstLine, exited, startedAt: Date.now() }
}

function events(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

async function setup(control) {
  const binDir = await tempDir("fake-orch-bin-")
  const cwd = await tempDir("fake-orch-cwd-")
  const runner = await installFakeOrchestratorRunner(binDir)
  if (control !== undefined) await writeFakeOrchestratorControl(runner, control)
  const env = { PATH: "/usr/bin:/bin", HOME: cwd }
  return { runner, cwd, env }
}

describe("fake orchestrator runner (spec 025 T002)", { skip }, () => {
  it("installs an executable named claude with the control and record files beside it", async () => {
    const { runner } = await setup()
    assert.equal(path.basename(runner.executable), "claude")
    assert.equal(path.dirname(runner.controlPath), path.dirname(runner.executable))
    assert.equal(path.dirname(runner.recordPath), path.dirname(runner.executable))
    const stat = await fs.stat(runner.executable)
    assert.ok(stat.mode & 0o111, "the executable bit is set")
  })

  it("with no control file writes the default stream and records the run", async () => {
    const { runner, cwd, env } = await setup()
    const run = startRun(runner.executable, { cwd, env, input: "Reply with OK" })
    const { code, stdout, stderr } = await run.exited
    assert.equal(code, 0)
    assert.equal(stderr, "")

    const stream = events(stdout)
    assert.deepEqual(stream[0], { ...DEFAULT_FIRST_EVENT, cwd: await fs.realpath(cwd) })
    assert.equal(stream.at(-1).type, "result")
    assert.equal(stream.at(-1).subtype, "success")
    assert.equal(stream.at(-1).is_error, false)
    assert.equal(stream.at(-1).result, "OK")
    const assistant = stream.find((event) => event.type === "assistant")
    assert.deepEqual(assistant.message.content, [{ type: "text", text: "OK" }])

    const [record] = await readFakeOrchestratorRecords(runner)
    assert.deepEqual(record.argv, PROFILE_ARGS)
    assert.equal(record.cwd, await fs.realpath(cwd))
    assert.deepEqual(record.cwdListing, [])
    assert.equal(record.stdin, "Reply with OK")
    assert.equal(typeof record.pid, "number")
  })

  it("the default first event reports no tools, no MCP server, and no API key", () => {
    assert.equal(DEFAULT_FIRST_EVENT.type, "system")
    assert.equal(DEFAULT_FIRST_EVENT.subtype, "init")
    assert.deepEqual(DEFAULT_FIRST_EVENT.tools, [])
    assert.deepEqual(DEFAULT_FIRST_EVENT.mcp_servers, [])
    assert.equal(DEFAULT_FIRST_EVENT.apiKeySource, "none")
  })

  it("records environment names only, exactly the ones it was given", async () => {
    const { runner, cwd } = await setup()
    const env = { PATH: "/usr/bin:/bin", HOME: cwd, LANG: "C", SECRET_VALUE_NAME: "value-that-must-not-be-recorded" }
    const { code } = await startRun(runner.executable, { cwd, env }).exited
    assert.equal(code, 0)
    const [record] = await readFakeOrchestratorRecords(runner)
    assert.deepEqual(record.envNames, ["HOME", "LANG", "PATH", "SECRET_VALUE_NAME"])
    const raw = await fs.readFile(runner.recordPath, "utf8")
    assert.ok(!raw.includes("value-that-must-not-be-recorded"), "no environment value is recorded")
  })

  it("records the listing of its working directory", async () => {
    const { runner, cwd, env } = await setup()
    await fs.writeFile(path.join(cwd, "b.txt"), "x")
    await fs.mkdir(path.join(cwd, "a-dir"))
    await startRun(runner.executable, { cwd, env }).exited
    const [record] = await readFakeOrchestratorRecords(runner)
    assert.deepEqual(record.cwdListing, ["a-dir", "b.txt"])
  })

  it("takes the first event, reply, exit code, and error output from the control file", async () => {
    const firstEvent = firstEventWith({ tools: ["Bash"], apiKeySource: "ANTHROPIC_API_KEY" })
    const { runner, cwd, env } = await setup({ firstEvent, reply: "Lane a is in review.", exitCode: 0, stderr: "a warning\n" })
    const { code, stdout, stderr } = await startRun(runner.executable, { cwd, env }).exited
    assert.equal(code, 0)
    assert.equal(stderr, "a warning\n")
    const stream = events(stdout)
    assert.deepEqual(stream[0].tools, ["Bash"])
    assert.equal(stream[0].apiKeySource, "ANTHROPIC_API_KEY")
    assert.deepEqual(stream[0].mcp_servers, [])
    assert.equal(stream.at(-1).result, "Lane a is in review.")
  })

  it("writes a first event given as an object as it is, with no default fields added", async () => {
    const { runner, cwd, env } = await setup({ firstEvent: { type: "system", subtype: "init" } })
    const { stdout } = await startRun(runner.executable, { cwd, env }).exited
    assert.deepEqual(events(stdout)[0], { type: "system", subtype: "init" })
  })

  it("writes a first event given as a string as a raw line, for an unreadable event", async () => {
    const { runner, cwd, env } = await setup({ firstEvent: "not json {" })
    const { stdout } = await startRun(runner.executable, { cwd, env }).exited
    assert.equal(stdout.split("\n")[0], "not json {")
  })

  it("writes no first event when it is null", async () => {
    const { runner, cwd, env } = await setup({ firstEvent: null, reply: "hi" })
    const { stdout } = await startRun(runner.executable, { cwd, env }).exited
    const stream = events(stdout)
    assert.notEqual(stream[0].type, "system")
    assert.equal(stream.at(-1).result, "hi")
  })

  it("a null reply writes no assistant or result event; a non-zero exit code is returned", async () => {
    const { runner, cwd, env } = await setup({ reply: null, exitCode: 1, stderr: "usage limit reached\n" })
    const { code, stdout, stderr } = await startRun(runner.executable, { cwd, env }).exited
    assert.equal(code, 1)
    assert.equal(stderr, "usage limit reached\n")
    const stream = events(stdout)
    assert.equal(stream.length, 1)
    assert.equal(stream[0].type, "system")
  })

  it("an empty output run writes nothing at all", async () => {
    const { runner, cwd, env } = await setup({ firstEvent: null, reply: null, exitCode: 2 })
    const { code, stdout } = await startRun(runner.executable, { cwd, env }).exited
    assert.equal(code, 2)
    assert.equal(stdout, "")
  })

  it("waits delayMs after the first event before the rest", async () => {
    const { runner, cwd, env } = await setup({ delayMs: 400 })
    const run = startRun(runner.executable, { cwd, env })
    const { lines, code } = await run.exited
    assert.equal(code, 0)
    assert.equal(JSON.parse(lines[0].line).type, "system")
    const gap = lines.at(-1).at - lines[0].at
    assert.ok(gap >= 350, `the result came ${gap} ms after the first event`)
  })

  it("neverExit keeps the run alive after the first event until it is signalled", async () => {
    const { runner, cwd, env } = await setup({ neverExit: true })
    const run = startRun(runner.executable, { cwd, env })
    const first = await run.firstLine
    assert.equal(JSON.parse(first.line).type, "system")
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(run.child.exitCode, null)
    process.kill(-run.child.pid, "SIGTERM")
    const { signal, stdout } = await run.exited
    assert.equal(signal, "SIGTERM")
    assert.ok(!events(stdout).some((event) => event.type === "result"))
  })

  it("ignoreTerm survives SIGTERM to its group and dies on SIGKILL", async () => {
    const { runner, cwd, env } = await setup({ neverExit: true, ignoreTerm: true })
    const run = startRun(runner.executable, { cwd, env })
    await run.firstLine
    process.kill(-run.child.pid, "SIGTERM")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(run.child.exitCode, null)
    assert.equal(run.child.signalCode, null)
    process.kill(-run.child.pid, "SIGKILL")
    const { signal } = await run.exited
    assert.equal(signal, "SIGKILL")
  })

  it("a runs list gives the Nth run the Nth control and later runs the last", async () => {
    const { runner, cwd, env } = await setup({
      runs: [{ reply: "first" }, { reply: "second", exitCode: 3 }],
    })
    const results = []
    for (let i = 0; i < 3; i += 1) {
      results.push(await startRun(runner.executable, { cwd, env, input: `run ${i}` }).exited)
    }
    assert.deepEqual(results.map((r) => r.code), [0, 3, 3])
    assert.deepEqual(results.map((r) => events(r.stdout).at(-1).result), ["first", "second", "second"])
    const records = await readFakeOrchestratorRecords(runner)
    assert.deepEqual(records.map((r) => r.stdin), ["run 0", "run 1", "run 2"])
  })

  it("a control file written after install applies to the next run", async () => {
    const { runner, cwd, env } = await setup()
    await startRun(runner.executable, { cwd, env }).exited
    await writeFakeOrchestratorControl(runner, { reply: "changed" })
    const { stdout } = await startRun(runner.executable, { cwd, env }).exited
    assert.equal(events(stdout).at(-1).result, "changed")
  })

  it("rejects a control file with an unknown key", async () => {
    const { runner } = await setup()
    await assert.rejects(writeFakeOrchestratorControl(runner, { replyText: "x" }), /unknown control key: replyText/)
  })

  it("readFakeOrchestratorRecords returns an empty list before any run", async () => {
    const { runner } = await setup()
    assert.deepEqual(await readFakeOrchestratorRecords(runner), [])
  })

  it("writes the stream the T004 probe captured: event order and every field name", async () => {
    const probe = JSON.parse(await fs.readFile(PROBE_FIXTURE, "utf8"))
    const { runner, cwd, env } = await setup()
    const { stdout } = await startRun(runner.executable, { cwd, env }).exited
    const stream = events(stdout)
    assert.deepEqual(stream.map((event) => event.type), probe.streamOrder)
    const [init, assistant, rateLimit, result] = stream
    const keys = (object) => Object.keys(object).sort()
    assert.deepEqual(keys(init), probe.fields["system.init"])
    assert.deepEqual(keys(assistant), probe.fields.assistant)
    assert.deepEqual(keys(assistant.message), probe.fields["assistant.message"])
    assert.deepEqual(keys(assistant.message.content[0]), probe.fields["assistant.message.content[0]"])
    assert.deepEqual(keys(rateLimit), probe.fields.rate_limit_event)
    assert.deepEqual(keys(rateLimit.rate_limit_info), probe.fields["rate_limit_event.rate_limit_info"])
    assert.deepEqual(keys(result), probe.fields.result)
    for (const [field, value] of Object.entries(probe.firstEventReports)) {
      assert.deepEqual(init[field], value, `first event ${field}`)
    }
    assert.equal(result.subtype, probe.values["result.subtype"])
    assert.equal(result.is_error, probe.values["result.is_error"])
  })

  it("a null reply still writes no assistant, rate limit, or result event", async () => {
    const { runner, cwd, env } = await setup({ reply: null, exitCode: 1 })
    const { stdout } = await startRun(runner.executable, { cwd, env }).exited
    assert.deepEqual(events(stdout).map((event) => event.type), ["system"])
  })
})

describe("T004 profile probe fixture", () => {
  it("records the subscription login and a first event that passes the FR-15 check", async () => {
    const probe = JSON.parse(await fs.readFile(PROBE_FIXTURE, "utf8"))
    assert.equal(probe.subscriptionLogin.used, true)
    assert.deepEqual(probe.firstEventReports.tools, [])
    assert.deepEqual(probe.firstEventReports.mcp_servers, [])
    assert.equal(probe.firstEventReports.apiKeySource, "none")
    for (const field of ["tools", "mcp_servers", "apiKeySource"]) {
      assert.ok(probe.fields["system.init"].includes(field), `the first event reports ${field}`)
    }
  })

  it("stores field names and facts, not run values that identify a session or a path", async () => {
    const text = await fs.readFile(PROBE_FIXTURE, "utf8")
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no UUID")
    assert.doesNotMatch(text, /\/Users\/|\/home\/|\/private\/|\/var\/folders\//, "no local path")
    assert.doesNotMatch(text, /@[a-z0-9-]+\.[a-z]/i, "no email address")
  })
})
