#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const BLOCKING_VERDICTS = new Set(["counterexample", "stale_pin", "validation_mismatch"])
const MODELED_RUNTIME_FILES = new Set([
  "src/brain_train/cli.mjs",
  "src/brain_train/core.mjs",
  "src/brain_train/pr-flow.mjs",
])
const TLC_MAX_HEAP_MB = 1024
const TLC_WORKERS = 2
const FORMAL_HARNESS_TIMEOUT_MS = 300_000
const PIN_TOOL_SELF_TEST_TIMEOUT_MS = 30_000

function parseArgs(argv) {
  const options = {
    base: "origin/main",
    head: "",
    output: "",
    impact: "auto",
    classifyOnly: false,
    selfTest: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--base") options.base = argv[++index] || ""
    else if (arg === "--head") options.head = argv[++index] || ""
    else if (arg === "--output") options.output = argv[++index] || ""
    else if (arg === "--impact") options.impact = argv[++index] || ""
    else if (arg === "--classify-only") options.classifyOnly = true
    else if (arg === "--self-test") options.selfTest = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!new Set(["auto", "no-semantic"]).has(options.impact)) {
    throw new Error("--impact must be auto or no-semantic.")
  }
  return options
}

function resolveGnuTimeBinary() {
  const configured = (process.env.BTRAIN_FORMAL_TIME_BIN || "").trim()
  const candidates = configured ? [configured] : ["time"]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" })
    const output = `${probe.stdout || ""}\n${probe.stderr || ""}`
    if (probe.status === 0 && /GNU time/i.test(output)) return candidate
  }
  return ""
}

function command(commandName, args, options = {}) {
  const startedAt = Date.now()
  const memoryTool = options.measureMemory && process.platform === "linux"
    ? resolveGnuTimeBinary()
    : ""
  const canMeasureMemory = Boolean(memoryTool)
  const measurementDirectory = canMeasureMemory
    ? fs.mkdtempSync(path.join(os.tmpdir(), "formal-advisory-memory-"))
    : ""
  const measurementPath = measurementDirectory ? path.join(measurementDirectory, "peak-rss-kb.txt") : ""
  const executable = canMeasureMemory ? memoryTool : commandName
  const executableArgs = canMeasureMemory
    ? ["-f", "%M", "-o", measurementPath, commandName, ...args]
    : args
  const result = spawnSync(executable, executableArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs,
  })
  const stdout = result.stdout || ""
  const stderr = result.stderr || ""
  if (options.echo !== false) {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  }
  let peakRssKb = null
  if (measurementPath) {
    const measured = fs.existsSync(measurementPath)
      ? Number.parseInt(fs.readFileSync(measurementPath, "utf8").trim(), 10)
      : Number.NaN
    if (Number.isInteger(measured) && measured >= 0) peakRssKb = measured
    fs.rmSync(measurementDirectory, { recursive: true, force: true })
  }
  return {
    command: [commandName, ...args].join(" "),
    status: result.status,
    signal: result.signal || "",
    errorCode: result.error?.code || "",
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    peakRssKb,
    memoryMeasurement: canMeasureMemory ? "linux-time-max-rss" : options.measureMemory ? "unavailable" : "not-requested",
  }
}

function repoRoot() {
  const result = command("git", ["rev-parse", "--show-toplevel"], { echo: false })
  if (result.status !== 0) throw new Error("Run this command inside a Git worktree.")
  return result.stdout.trim()
}

function changedFiles(root, base, head) {
  if (!base) throw new Error("--base must name the review base commit or branch.")
  const target = head || "HEAD"
  const args = ["diff", "--name-only", `${base}...${target}`, "--"]
  const result = command("git", args, { cwd: root, echo: false })
  if (result.status !== 0) {
    throw new Error(`Could not classify the diff from ${base}${head ? ` to ${head}` : ""}.\n${result.stderr}`)
  }
  return result.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)
}

export function verifyExecutionTree(root, requestedHead) {
  const currentResult = command("git", ["rev-parse", "HEAD"], { cwd: root, echo: false })
  if (currentResult.status !== 0) {
    throw new Error("Could not resolve the checked-out HEAD for formal verification.")
  }
  const head = currentResult.stdout.trim()
  if (requestedHead) {
    const requestedResult = command("git", ["rev-parse", requestedHead], { cwd: root, echo: false })
    if (requestedResult.status !== 0) {
      throw new Error(`Could not resolve the requested formal-verification head: ${requestedHead}.`)
    }
    if (requestedResult.stdout.trim() !== head) {
      throw new Error(`Requested head ${requestedHead} does not match the checked-out HEAD ${head}.`)
    }
  }

  const statusResult = command(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: root, echo: false },
  )
  if (statusResult.status !== 0) {
    throw new Error("Could not verify that the formal-verification worktree is clean.")
  }
  if (statusResult.stdout.trim()) {
    throw new Error("Formal verification requires a clean Git worktree so the evidence matches the reported head.")
  }
  return { head }
}

export function classifyPaths(files, declaredImpact = "auto") {
  const modeledProse = files.some((file) => /^specs\/(002|005|006|014)[^/]*\.md$/.test(file))
  const tlaArtifacts = files.some((file) => file.startsWith("specs/tla/"))
  const pinTool = files.includes("scripts/tla_pin.py")
  const cli = files.includes("src/brain_train/cli.mjs")
  const advisoryWorkflow = files.includes(".github/workflows/formal-advisory.yml")
  const selfTest = advisoryWorkflow || files.includes("scripts/formal_advisory.mjs")
  const pinToolTest = pinTool
  const harnessSurface = advisoryWorkflow || tlaArtifacts || files.some((file) =>
    file.startsWith("test/formal/")
    || file === "package.json"
    || file === "package-lock.json"
    || file === "scripts/formal_advisory.mjs"
    || MODELED_RUNTIME_FILES.has(file),
  )
  const codeFreeNoSemanticProse = declaredImpact === "no-semantic"
    && modeledProse
    && !harnessSurface
    && !pinTool
  const harness = !codeFreeNoSemanticProse && (modeledProse || harnessSurface)
  const pin = modeledProse || tlaArtifacts || pinTool
  const tlc = !codeFreeNoSemanticProse && (modeledProse || tlaArtifacts)
  let impact = "none"
  if (codeFreeNoSemanticProse) impact = "no-semantic"
  else if (tlc) impact = "semantic"
  else if (harness || pinTool) impact = "validation"
  return {
    impact,
    pin,
    tlc,
    harness,
    cli,
    selfTest,
    pinToolTest,
    formalSurface: pin || tlc || harness,
  }
}

export function classifyMeasuredVerdict(run, verdict) {
  if (verdict === "pass" && run.memoryMeasurement === "unavailable") {
    return "infrastructure_failure"
  }
  return verdict
}

function findTlaFiles(root) {
  const directory = path.join(root, "specs", "tla")
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory)
    .filter((entry) => entry.endsWith(".tla"))
    .sort()
    .map((entry) => path.join(directory, entry))
}

export function classifyTlcResult(run) {
  const output = `${run.stdout}\n${run.stderr}`
  if (
    run.errorCode === "ETIMEDOUT"
    || run.status === 124
    || run.signal === "SIGTERM"
    || /OutOfMemoryError|Java heap space|GC overhead limit exceeded/i.test(output)
  ) {
    return "state_space_exhausted"
  }
  if (/Invariant\s+.+\s+is violated|Error:\s+Invariant/i.test(output)) return "counterexample"
  if (/Model checking completed\. No error has been found\./.test(output)) return "pass"
  return "infrastructure_failure"
}

function buildTlcArgs(jar, configName, tlaName) {
  return [
    `-Xmx${TLC_MAX_HEAP_MB}m`,
    "-cp", jar,
    "tlc2.TLC",
    "-config", configName,
    "-workers", String(TLC_WORKERS),
    tlaName,
  ]
}

function runPinCheck(root, tlaFiles) {
  if (tlaFiles.length === 0) {
    return {
      name: "pin",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: "python3 scripts/tla_pin.py --check",
      detail: "No TLA model exists for the selected semantic surface.",
    }
  }
  const script = path.join(root, "scripts", "tla_pin.py")
  if (!fs.existsSync(script)) {
    return {
      name: "pin",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: "python3 scripts/tla_pin.py --check",
      detail: "scripts/tla_pin.py is missing.",
    }
  }
  const run = command("python3", [script, "--check"], { cwd: root, measureMemory: true })
  const verdict = classifyMeasuredVerdict(run, classifyPinResult(run))
  return { name: "pin", verdict, ...run }
}

function runPinToolSelfTest(root) {
  const script = path.join(root, "scripts", "tla_pin.py")
  const commandText = "python3 scripts/tla_pin.py --check <stale-fixture> <malformed-fixture>"
  if (!fs.existsSync(script)) {
    return {
      name: "pin-tool-self-test",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: commandText,
      detail: "scripts/tla_pin.py is missing.",
    }
  }

  const fixtureParent = path.join(root, ".btrain")
  fs.mkdirSync(fixtureParent, { recursive: true })
  const fixtureDirectory = fs.mkdtempSync(path.join(fixtureParent, "formal-pin-self-test-"))
  const staleFixture = path.join(fixtureDirectory, "stale.tla")
  const malformedFixture = path.join(fixtureDirectory, "malformed.tla")
  try {
    fs.writeFileSync(
      staleFixture,
      `\\* Pinned to: specs/014-specula-formal-verification-pilot.md § Decision\n\\* Pinned-hash: ${"0".repeat(64)}\n`,
    )
    fs.writeFileSync(
      malformedFixture,
      `\\* Pinned-hash: ${"0".repeat(64)}\n`,
    )
    const run = command(
      "python3",
      [script, "--check", staleFixture, malformedFixture],
      { cwd: root, timeoutMs: PIN_TOOL_SELF_TEST_TIMEOUT_MS, measureMemory: true },
    )
    const staleLines = (run.stdout || "").match(/^STALE\s+.*$/gm) || []
    const expectedFailure = run.status === 1
      && staleLines.length === 2
      && /^2 stale pin\(s\)\. Re-pin with:/m.test(run.stdout || "")
    const verdict = classifyMeasuredVerdict(run, expectedFailure ? "pass" : "infrastructure_failure")
    return { name: "pin-tool-self-test", verdict, ...run }
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  }
}

export function classifyPinResult(run) {
  if (run.status === 0) return "pass"
  const stdout = run.stdout || ""
  const stderr = run.stderr || ""
  const reportedStalePin = /^STALE\s+specs\/tla\/.*$/m.test(stdout)
    && /^\d+ stale pin\(s\)\. Re-pin with:/m.test(stdout)
  const toolCrashed = /Traceback|SyntaxError|ImportError|ModuleNotFoundError/i.test(stderr)
  if (run.status === 1 && reportedStalePin && !toolCrashed) return "stale_pin"
  return "infrastructure_failure"
}

function runTlc(root, tlaFiles) {
  if (tlaFiles.length === 0) {
    return [{
      name: "tlc",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: "java -cp $TLC_JAR tlc2.TLC ...",
      detail: "No TLA model exists for the selected semantic surface.",
    }]
  }
  const jar = process.env.TLC_JAR || ""
  if (!jar || !fs.existsSync(jar)) {
    return [{
      name: "tlc",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: "java -cp $TLC_JAR tlc2.TLC ...",
      detail: "TLC_JAR does not name an existing tla2tools.jar.",
    }]
  }
  return tlaFiles.map((tlaFile) => {
    const parsed = path.parse(tlaFile)
    const config = path.join(parsed.dir, `${parsed.name}.cfg`)
    if (!fs.existsSync(config)) {
      return {
        name: `tlc:${parsed.name}`,
        verdict: "infrastructure_failure",
        durationMs: 0,
        command: "",
        detail: `${path.relative(root, config)} is missing.`,
      }
    }
    const run = command(
      "java",
      buildTlcArgs(jar, path.basename(config), path.basename(tlaFile)),
      { cwd: parsed.dir, timeoutMs: 300_000, measureMemory: true },
    )
    return { name: `tlc:${parsed.name}`, verdict: classifyMeasuredVerdict(run, classifyTlcResult(run)), ...run }
  })
}

function runHarness(root) {
  const packagePath = path.join(root, "package.json")
  if (!fs.existsSync(packagePath)) {
    return { name: "fast-check", verdict: "infrastructure_failure", durationMs: 0, command: "npm run test:formal" }
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"))
  if (!packageJson.scripts?.["test:formal"]) {
    return {
      name: "fast-check",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: "npm run test:formal",
      detail: "package.json does not define test:formal.",
    }
  }
  const run = command(
    "npm",
    ["run", "test:formal"],
    { cwd: root, timeoutMs: FORMAL_HARNESS_TIMEOUT_MS, measureMemory: true },
  )
  const verdict = classifyMeasuredVerdict(run, classifyHarnessResult(run, { modeledAssertions: true }))
  return { name: "fast-check", verdict, ...run }
}

function runAdvisorySelfTest(root) {
  const run = command(
    "node",
    ["scripts/formal_advisory.mjs", "--self-test"],
    { cwd: root, measureMemory: true },
  )
  const verdict = classifyMeasuredVerdict(run, classifyHarnessResult(run))
  return { name: "advisory-self-test", verdict, ...run }
}

export function classifyHarnessResult(run, { modeledAssertions = false } = {}) {
  if (run.status === 0) return "pass"
  const output = `${run.stdout || ""}\n${run.stderr || ""}`
  const explicitMismatch = /validation_mismatch/.test(output)
  const modeledAssertion = modeledAssertions && /ERR_ASSERTION|AssertionError/.test(output)
  if (run.status === 1 && (explicitMismatch || modeledAssertion)) {
    return "validation_mismatch"
  }
  return "infrastructure_failure"
}

function runCliContractTests(root) {
  const run = command("node", ["--test", "test/core.test.mjs"], { cwd: root, measureMemory: true })
  return { name: "cli-contract", verdict: classifyMeasuredVerdict(run, classifyHarnessResult(run)), ...run }
}

function exitCodeFor(checks) {
  const verdicts = checks.map((check) => check.verdict)
  if (verdicts.some((verdict) => BLOCKING_VERDICTS.has(verdict))) return 1
  if (verdicts.includes("infrastructure_failure")) return 2
  if (verdicts.includes("state_space_exhausted")) return 124
  return 0
}

function overallVerdict(checks) {
  const code = exitCodeFor(checks)
  if (code === 1) return "fail"
  if (code === 2) return "infrastructure_failure"
  if (code === 124) return "warn"
  if (checks.every((check) => check.verdict === "no_formal_surface")) return "no_formal_surface"
  return "pass"
}

function writeResult(outputPath, result) {
  if (!outputPath) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`Formal advisory result: ${outputPath}\n`)
}

function runExecutionTreeSelfTest() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "formal-advisory-self-test-"))
  try {
    assert.equal(command("git", ["init", "-q"], { cwd: root, echo: false }).status, 0)
    fs.writeFileSync(path.join(root, "fixture.txt"), "first\n")
    assert.equal(command("git", ["add", "fixture.txt"], { cwd: root, echo: false }).status, 0)
    assert.equal(command(
      "git",
      ["-c", "user.name=Formal Test", "-c", "user.email=formal@example.invalid", "commit", "-qm", "first"],
      { cwd: root, echo: false },
    ).status, 0)
    const firstHead = command("git", ["rev-parse", "HEAD"], { cwd: root, echo: false }).stdout.trim()

    assert.equal(verifyExecutionTree(root, "").head, firstHead)
    fs.writeFileSync(path.join(root, "fixture.txt"), "dirty\n")
    assert.throws(() => verifyExecutionTree(root, ""), /clean Git worktree/)

    assert.equal(command("git", ["add", "fixture.txt"], { cwd: root, echo: false }).status, 0)
    assert.equal(command(
      "git",
      ["-c", "user.name=Formal Test", "-c", "user.email=formal@example.invalid", "commit", "-qm", "second"],
      { cwd: root, echo: false },
    ).status, 0)
    assert.throws(() => verifyExecutionTree(root, firstHead), /does not match the checked-out HEAD/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function runMergeBaseSelfTest() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "formal-advisory-merge-base-test-"))
  try {
    assert.equal(command("git", ["init", "-q", "-b", "main"], { cwd: root, echo: false }).status, 0)
    fs.writeFileSync(path.join(root, "shared.txt"), "shared\n")
    assert.equal(command("git", ["add", "shared.txt"], { cwd: root, echo: false }).status, 0)
    assert.equal(command(
      "git",
      ["-c", "user.name=Formal Test", "-c", "user.email=formal@example.invalid", "commit", "-qm", "shared"],
      { cwd: root, echo: false },
    ).status, 0)

    assert.equal(command("git", ["checkout", "-qb", "feature"], { cwd: root, echo: false }).status, 0)
    fs.writeFileSync(path.join(root, "feature.txt"), "feature\n")
    assert.equal(command("git", ["add", "feature.txt"], { cwd: root, echo: false }).status, 0)
    assert.equal(command(
      "git",
      ["-c", "user.name=Formal Test", "-c", "user.email=formal@example.invalid", "commit", "-qm", "feature"],
      { cwd: root, echo: false },
    ).status, 0)

    assert.equal(command("git", ["checkout", "-q", "main"], { cwd: root, echo: false }).status, 0)
    fs.mkdirSync(path.join(root, "specs"))
    fs.writeFileSync(path.join(root, "specs", "014-base-only.md"), "base only\n")
    assert.equal(command("git", ["add", "specs/014-base-only.md"], { cwd: root, echo: false }).status, 0)
    assert.equal(command(
      "git",
      ["-c", "user.name=Formal Test", "-c", "user.email=formal@example.invalid", "commit", "-qm", "base"],
      { cwd: root, echo: false },
    ).status, 0)

    assert.equal(command("git", ["checkout", "-q", "feature"], { cwd: root, echo: false }).status, 0)
    assert.deepEqual(changedFiles(root, "main", "HEAD"), ["feature.txt"])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function runSelfTest() {
  assert.deepEqual(classifyPaths(["README.md"]), {
    impact: "none", pin: false, tlc: false, harness: false, cli: false, selfTest: false, pinToolTest: false, formalSurface: false,
  })
  const semanticSelection = classifyPaths(["specs/014-specula-formal-verification-pilot.md"])
  assert.equal(semanticSelection.impact, "semantic")
  assert.equal(semanticSelection.harness, true)
  assert.deepEqual(
    classifyPaths(["specs/014-specula-formal-verification-pilot.md"], "no-semantic"),
    { impact: "no-semantic", pin: true, tlc: false, harness: false, cli: false, selfTest: false, pinToolTest: false, formalSurface: true },
  )
  assert.equal(
    classifyPaths(["specs/014-specula-formal-verification-pilot.md", "src/brain_train/core.mjs"], "no-semantic").impact,
    "semantic",
  )
  assert.equal(classifyPaths(["scripts/tla_pin.py"]).harness, false)
  assert.equal(classifyPaths(["src/brain_train/core.mjs"]).harness, true)
  assert.equal(classifyPaths(["src/brain_train/cli.mjs"]).cli, true)
  assert.equal(classifyPaths([".github/workflows/formal-advisory.yml"]).impact, "validation")
  assert.equal(classifyPaths(["test/formal/lane-lock-harness.test.mjs"]).impact, "validation")
  assert.equal(classifyPaths(["scripts/formal_advisory.mjs"]).selfTest, true)
  assert.equal(classifyPaths(["src/brain_train/core.mjs"]).selfTest, false)
  assert.equal(classifyPaths(["scripts/tla_pin.py"]).pinToolTest, true)
  assert.equal(classifyMeasuredVerdict({ memoryMeasurement: "unavailable" }, "pass"), "infrastructure_failure")
  assert.equal(classifyMeasuredVerdict({ memoryMeasurement: "linux-time-max-rss" }, "pass"), "pass")
  assert.equal(classifyTlcResult({ stdout: "Model checking completed. No error has been found.", stderr: "" }), "pass")
  assert.equal(classifyTlcResult({ stdout: "Error: Invariant Exclusivity is violated.", stderr: "" }), "counterexample")
  assert.equal(classifyTlcResult({ stdout: "", stderr: "", errorCode: "ETIMEDOUT" }), "state_space_exhausted")
  assert.equal(classifyTlcResult({ stdout: "", stderr: "java.lang.OutOfMemoryError: Java heap space" }), "state_space_exhausted")
  assert.deepEqual(
    buildTlcArgs("/tmp/tla2tools.jar", "LaneLock.cfg", "LaneLock.tla"),
    ["-Xmx1024m", "-cp", "/tmp/tla2tools.jar", "tlc2.TLC", "-config", "LaneLock.cfg", "-workers", "2", "LaneLock.tla"],
  )
  assert.equal(classifyHarnessResult({ status: 1, stdout: "not ok 1 - canonical finding", stderr: "AssertionError" }, { modeledAssertions: true }), "validation_mismatch")
  assert.equal(classifyHarnessResult({ status: 1, stdout: "not ok 1 - unrelated CLI assertion", stderr: "AssertionError" }), "infrastructure_failure")
  assert.equal(classifyHarnessResult({ status: 1, stdout: "", stderr: "Error [ERR_MODULE_NOT_FOUND]" }), "infrastructure_failure")
  assert.equal(
    classifyPinResult({
      status: 1,
      stdout: "STALE specs/tla/LaneLock.tla: hash mismatch\n1 stale pin(s). Re-pin with: scripts/tla_pin.py --repin <file.tla>",
      stderr: "",
    }),
    "stale_pin",
  )
  assert.equal(
    classifyPinResult({ status: 1, stdout: "", stderr: "Traceback (most recent call last):\nSyntaxError" }),
    "infrastructure_failure",
  )
  const exhaustedWithInfrastructure = [
    { verdict: "state_space_exhausted" },
    { verdict: "infrastructure_failure" },
  ]
  assert.equal(exitCodeFor(exhaustedWithInfrastructure), 2)
  assert.equal(overallVerdict(exhaustedWithInfrastructure), "infrastructure_failure")
  assert.equal(runPinCheck("/tmp/unused", []).verdict, "infrastructure_failure")
  assert.equal(runPinToolSelfTest("/tmp/unused").verdict, "infrastructure_failure")
  assert.equal(runTlc("/tmp/unused", [])[0].verdict, "infrastructure_failure")
  const missingScriptRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "formal-advisory-package-test-"))
  try {
    fs.writeFileSync(path.join(missingScriptRoot, "package.json"), "{}\n")
    assert.equal(runHarness(missingScriptRoot).verdict, "infrastructure_failure")
  } finally {
    fs.rmSync(missingScriptRoot, { recursive: true, force: true })
  }
  runExecutionTreeSelfTest()
  runMergeBaseSelfTest()
  if (process.platform === "linux") {
    const measured = command("node", ["-e", "process.exit(0)"], { echo: false, measureMemory: true })
    if (resolveGnuTimeBinary()) {
      assert.ok(Number.isInteger(measured.peakRssKb) && measured.peakRssKb > 0)
    } else {
      assert.equal(measured.peakRssKb, null)
      assert.equal(measured.memoryMeasurement, "unavailable")
    }
  }
  const workflow = fs.readFileSync(path.join(repoRoot(), ".github", "workflows", "formal-advisory.yml"), "utf8")
  assert.match(workflow, /Peak RSS \(KiB\)/)
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/)
  assert.match(workflow, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/)
  assert.match(workflow, /FORMAL_IMPACT: \$\{\{ steps\.select\.outputs\.formal_impact \}\}/)
  assert.match(workflow, /jq -r '\.verdict'.*== "no_formal_surface"/)
  assert.match(workflow, /timeout-minutes: 10/)
  const source = fs.readFileSync(new URL(import.meta.url), "utf8")
  assert.match(source, /timeoutMs: FORMAL_HARNESS_TIMEOUT_MS/)
  process.stdout.write("formal_advisory self-test passed\n")
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selfTest) {
    runSelfTest()
    return
  }
  const root = repoRoot()
  const startedAt = Date.now()
  const executionTree = verifyExecutionTree(root, options.head)
  const files = changedFiles(root, options.base, options.head)
  const selection = classifyPaths(files, options.impact)
  const result = {
    schemaVersion: 1,
    advisory: true,
    base: options.base,
    head: executionTree.head,
    changedFiles: files,
    selection,
    checks: [],
  }

  if (options.classifyOnly || !selection.formalSurface) {
    result.checks = [{ name: "selection", verdict: "no_formal_surface", durationMs: 0, command: "" }]
  } else {
    const tlaFiles = findTlaFiles(root)
    if (selection.pin) result.checks.push(runPinCheck(root, tlaFiles))
    if (selection.pinToolTest) result.checks.push(runPinToolSelfTest(root))
    const pinBlocked = result.checks.some((check) => check.verdict === "stale_pin")
    if (selection.tlc && !pinBlocked) result.checks.push(...runTlc(root, tlaFiles))
    if (selection.selfTest) result.checks.push(runAdvisorySelfTest(root))
    if (selection.harness) result.checks.push(runHarness(root))
    if (selection.cli) result.checks.push(runCliContractTests(root))
  }

  result.durationMs = Date.now() - startedAt
  result.verdict = options.classifyOnly
    ? selection.formalSurface ? "classified" : "no_formal_surface"
    : overallVerdict(result.checks)
  result.exitCode = options.classifyOnly ? 0 : exitCodeFor(result.checks)
  writeResult(options.output ? path.resolve(root, options.output) : "", result)
  process.exitCode = result.exitCode
}

main().catch((error) => {
  process.stderr.write(`Formal advisory failed: ${error.message}\n`)
  process.exitCode = 2
})
