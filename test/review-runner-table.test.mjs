// Spec 023 FR-4 and FR-8 through src/brain_train/review/runner-table.mjs
// (plan WS1, T006). Every shipped signal pattern is checked against the
// captured sample it names under test/fixtures/runner-signals/.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  classifyExit,
  findRejectedRunnerArgs,
  freshSessionArgs,
  getRunnerEntry,
  labOfExecutable,
  RUNNER_TABLE,
  runnerExecutable,
  splitRunnerWords,
} from "../src/brain_train/review/runner-table.mjs"

const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "runner-signals")
const readSample = (name) => fs.readFileSync(path.join(SAMPLES, name), "utf8")

describe("the runner table", () => {
  it("names the lab of claude, codex, and gemini and of nothing else", () => {
    assert.deepEqual(Object.keys(RUNNER_TABLE).sort(), ["claude", "codex", "gemini"])
    assert.equal(labOfExecutable("claude"), "anthropic")
    assert.equal(labOfExecutable("codex"), "openai")
    assert.equal(labOfExecutable("gemini"), "google")
    for (const executable of ["agent", "cursor-agent", "npx", "env", "node", "constructor", "__proto__", ""]) {
      assert.equal(labOfExecutable(executable), "", executable)
      assert.equal(getRunnerEntry(executable), null, executable)
    }
  })

  it("probes each executable with --version", () => {
    for (const entry of Object.values(RUNNER_TABLE)) {
      assert.deepEqual([...entry.probeArgs], ["--version"])
    }
  })

  it("ships a signal pattern only with a captured sample, and the pattern matches it", () => {
    let shipped = 0
    for (const [executable, entry] of Object.entries(RUNNER_TABLE)) {
      for (const signal of entry.signals) {
        shipped += 1
        assert.ok(signal.sample, `${executable} ${signal.kind} names no sample`)
        const sample = readSample(signal.sample)
        assert.match(sample, signal.pattern, `${executable} ${signal.kind} does not match ${signal.sample}`)
        assert.equal(classifyExit({ executable, exitCode: 1, tail: `starting\n${sample}` }).outcome, signal.class)
      }
    }
    assert.equal(shipped, 2, "a new pattern needs a new sample and a row in the fixtures README")
  })

  it("classifies the codex usage-limit sample as tool_unavailable even on exit 0", () => {
    const result = classifyExit({ executable: "codex", exitCode: 0, tail: readSample("codex-usage-limit.txt") })
    assert.deepEqual(result, { outcome: "tool_unavailable", kind: "quota", source: "built-in", match: String(RUNNER_TABLE.codex.signals[0].pattern) })
  })

  it("classifies the claude not-logged-in sample as tool_unavailable", () => {
    assert.equal(classifyExit({ executable: "claude", exitCode: 1, tail: readSample("claude-not-logged-in.txt") }).kind, "authentication")
  })

  it("does not apply one executable's patterns to another", () => {
    assert.equal(classifyExit({ executable: "claude", exitCode: 1, tail: readSample("codex-usage-limit.txt") }).outcome, "failed")
  })
})

describe("classifyExit", () => {
  it("is failed for a non-zero exit with no pattern", () => {
    assert.equal(classifyExit({ executable: "codex", exitCode: 2, tail: "panic: something broke" }).outcome, "failed")
    assert.equal(classifyExit({ executable: "agent", exitCode: 1, tail: "" }).outcome, "failed")
  })

  it("is failed for a runner killed by a signal (null exit code)", () => {
    assert.equal(classifyExit({ executable: "claude", exitCode: null, tail: "" }).outcome, "failed")
  })

  it("has no failure class for exit 0 with no pattern", () => {
    assert.equal(classifyExit({ executable: "claude", exitCode: 0, tail: "done" }).outcome, null)
  })

  it("adds the [review.signals] patterns of the repository as substrings", () => {
    const extraSignals = { unavailable: ["Workspace Is Out Of Credits"], refused: ["blocked by policy"] }
    assert.equal(classifyExit({ executable: "codex", exitCode: 1, tail: "error: your workspace is out of credits", extraSignals }).outcome, "tool_unavailable")
    assert.equal(classifyExit({ executable: "agent", exitCode: 1, tail: "request blocked by policy", extraSignals }).outcome, "policy_blocked")
    assert.equal(classifyExit({ executable: "agent", exitCode: 1, tail: "request blocked by policy", extraSignals }).source, "config")
  })

  it("reads only the last lines of the output", () => {
    const early = `${readSample("codex-usage-limit.txt")}${"line\n".repeat(60)}`
    assert.equal(classifyExit({ executable: "codex", exitCode: 1, tail: early }).outcome, "failed")
    assert.equal(classifyExit({ executable: "codex", exitCode: 1, tail: ["x", readSample("codex-usage-limit.txt")] }).outcome, "tool_unavailable")
  })
})

describe("runnerExecutable", () => {
  for (const [value, expected] of [
    ["claude -p", "claude"],
    ["/opt/homebrew/bin/codex exec", "codex"],
    ["'/path with spaces/gemini' -p", "gemini"],
    ["notify", ""],
    ["", ""],
    ["   ", ""],
  ]) {
    it(`is ${JSON.stringify(expected)} for ${JSON.stringify(value)}`, () => assert.equal(runnerExecutable(value), expected))
  }

  it("splits words with quotes and escapes", () => {
    assert.deepEqual(splitRunnerWords(`a "b c" 'd e' f\\ g ""`), ["a", "b c", "d e", "f g", ""])
  })
})

describe("fresh sessions (spec 017 FR-3, spec 023 FR-8)", () => {
  it("gives the fresh-session arguments of each executable", () => {
    assert.deepEqual(freshSessionArgs("claude"), ["--no-session-persistence"])
    assert.deepEqual(freshSessionArgs("codex"), ["exec", "--ephemeral"])
    assert.deepEqual(freshSessionArgs("gemini", { sessionId: "abc" }), ["--session-id", "abc"])
    assert.throws(() => freshSessionArgs("gemini"), /new session id/)
    assert.equal(freshSessionArgs("agent"), null)
  })

  it("finds the flags and subcommands that resume or fork a session", () => {
    assert.deepEqual(findRejectedRunnerArgs("claude", ["-p", "--resume", "abc", "-c", "--fork-session"]), ["--resume", "-c", "--fork-session"])
    assert.deepEqual(findRejectedRunnerArgs("claude", ["--from-pr=12", "-p"]), ["--from-pr=12"])
    assert.deepEqual(findRejectedRunnerArgs("codex", ["resume", "--last"]), ["resume"])
    assert.deepEqual(findRejectedRunnerArgs("codex", ["exec", "--session-id", "x"]), ["--session-id"])
    assert.deepEqual(findRejectedRunnerArgs("codex", ["fork"]), ["fork"])
    assert.deepEqual(findRejectedRunnerArgs("gemini", ["-r", "latest"]), ["-r"])
    assert.deepEqual(findRejectedRunnerArgs("codex", ["exec", "--json"]), [])
    assert.deepEqual(findRejectedRunnerArgs("agent", ["--resume"]), [])
  })
})
