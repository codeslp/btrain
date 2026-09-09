#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { tlcIdentity, readTlcCache, writeTlcCache } from "./formal_cache.mjs"

const BLOCKING_VERDICTS = new Set(["counterexample", "stale_pin", "validation_mismatch"])
const CONTRACT_MANIFEST = JSON.parse(fs.readFileSync(new URL("./formal_contracts.json", import.meta.url), "utf8"))
if (CONTRACT_MANIFEST.schemaVersion !== 1 || CONTRACT_MANIFEST.contracts.length !== 1) {
  throw new Error("The bounded pilot requires one contract in formal_contracts.json.")
}
const CONTRACT = CONTRACT_MANIFEST.contracts[0]
const modelUrl = new URL(`../${CONTRACT.model}`, import.meta.url)
const pinPaths = fs.existsSync(modelUrl)
  ? [...fs.readFileSync(modelUrl, "utf8").matchAll(/^\\\*\s*Pinned to:\s*(\S+)\s+§/gm)].map(match => match[1])
  : []
const MODELED_PROSE = new Set([...CONTRACT.prose, ...pinPaths])
// spec 016 WS3 (2026-09-08): the FR-29 decision variable grew LaneLock to
// ~15M distinct states (3 min 57 s with 10 workers). Two workers, 1 GB, and a
// five-minute cap reported state_space_exhausted, so the budget follows the
// model: 4 workers (ubuntu-latest has 4 vCPUs), 2 GB heap, 15 minutes. The
// TLC metadata goes to a temp dir, not specs/tla/states/. Spec 016 WS4 added
// reassignment, resync, and the PR-flow shortcut and moved Lanes/Agents to
// symmetric constants: ~10.8M distinct states, 5 min at 10 workers locally,
// so the cap is 20 minutes at 4 workers and the workflow job timeout is 35
// minutes (TLC 20 + harness 5 + CLI contract 5 + pin checks and setup).
const TLC_MAX_HEAP_MB = 2048
const TLC_WORKERS = 4
const TLC_TIMEOUT_MS = 1_200_000
const MAX_TLA_FILES = 1
const FORMAL_HARNESS_TIMEOUT_MS = 300_000
const PIN_TOOL_SELF_TEST_TIMEOUT_MS = 30_000
const PIN_CHECK_TIMEOUT_MS = 30_000
const ADVISORY_SELF_TEST_TIMEOUT_MS = 60_000
const CLI_CONTRACT_TIMEOUT_MS = 300_000
const EXECUTABLE_MODEL_FILES = new Set([CONTRACT.executableModel])

function parseArgs(argv) {
  const options = {
    base: "origin/main",
    head: "",
    output: "",
    impact: "auto",
    classifyOnly: false,
    selfTest: false,
    cacheDir: "",
    cacheKeyOnly: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--base") options.base = argv[++index] || ""
    else if (arg === "--head") options.head = argv[++index] || ""
    else if (arg === "--output") options.output = argv[++index] || ""
    else if (arg === "--impact") options.impact = argv[++index] || ""
    else if (arg === "--classify-only") options.classifyOnly = true
    else if (arg === "--self-test") options.selfTest = true
    else if (arg === "--cache-dir") options.cacheDir = argv[++index] || ""
    else if (arg === "--cache-key-only") options.cacheKeyOnly = true
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

export function buildMeasuredCommandArgs(commandName, args, measurementPath) {
  return ["-q", "-f", "%M", "-o", measurementPath, commandName, ...args]
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
    ? buildMeasuredCommandArgs(commandName, args, measurementPath)
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

export function classifyPaths(files, declaredImpact = "auto", proseChanged = true) {
  const modeledProse = files.some(file => MODELED_PROSE.has(file))
  const tlaArtifacts = files.some(file => file === CONTRACT.config
    || (file.startsWith("specs/tla/") && /\.(tla|cfg|class|jar)$/i.test(file)))
  const executableModel = files.some(file => EXECUTABLE_MODEL_FILES.has(file))
  const pinTool = files.includes("scripts/tla_pin.py")
  const cli = files.includes("src/brain_train/cli.mjs")
  const tooling = [".github/workflows/formal-advisory.yml", "scripts/formal_advisory.mjs", "scripts/formal_cache.mjs", "scripts/formal_contracts.json", "test/formal-advisory.test.mjs"]
  const selfTest = files.some(file => tooling.includes(file))
  const pinToolTest = pinTool
  const harnessSurface = selfTest || tlaArtifacts || executableModel || files.some(file =>
    CONTRACT.harness.includes(file)
    || (file.startsWith("test/formal/") && /\.[cm]?js$/.test(file))
    || file === "package.json" || file === "package-lock.json"
    || CONTRACT.runtime.includes(file)
    || CONTRACT.runtimeFallback.some(prefix => file.startsWith(prefix)),
  )
  const codeFreeNoSemanticProse = declaredImpact === "no-semantic"
    && modeledProse && !harnessSurface && !pinTool
  const semanticProse = modeledProse && proseChanged && !codeFreeNoSemanticProse
  const harness = semanticProse || harnessSurface
  const pin = modeledProse || tlaArtifacts || executableModel || pinTool || harness
  const tlc = semanticProse || tlaArtifacts || executableModel
  let impact = "none"
  if (codeFreeNoSemanticProse) impact = "no-semantic"
  else if (tlc) impact = "semantic"
  else if (harness || pinTool) impact = "validation"
  return { impact, pin, tlc, harness, cli, selfTest, pinToolTest, formalSurface: pin || tlc || harness }
}

function changedPinnedProse(root, base, files) {
  if (!files.some(file => MODELED_PROSE.has(file))) return false
  const result = command("python3", ["scripts/tla_pin.py", "--changed-pins", base, CONTRACT.model], { cwd: root, echo: false, timeoutMs: PIN_CHECK_TIMEOUT_MS })
  try {
    const data = JSON.parse(result.stdout)
    if (result.status === 0 && Array.isArray(data.affected)) return data.affected.length > 0
  } catch { /* Unknown impact selects the full checks. */ }
  return true
}

function findTlaFiles(root) {
  const directory = path.join(root, "specs", "tla")
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory)
    .filter((entry) => entry === path.basename(CONTRACT.model) || (entry.endsWith(".tla") && fs.existsSync(path.join(directory, `${path.parse(entry).name}.cfg`))))
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
  if (/Invariant\s+.+\s+is violated|Error:\s+Invariant|Temporal properties were violated|Deadlock reached|Error:.*(?:property|assertion).*violat/i.test(output)) return "counterexample"
  if ((run.status === undefined || run.status === 0) && !run.signal && !run.errorCode && /Model checking completed\. No error has been found\./.test(output)) return "pass"
  return "infrastructure_failure"
}

function buildTlcArgs(jar, configName, tlaName, metadir = "") {
  return [
    `-Xmx${TLC_MAX_HEAP_MB}m`,
    "-XX:+UseParallelGC",
    "-cp", jar,
    "tlc2.TLC",
    "-config", configName,
    "-workers", String(TLC_WORKERS),
    ...(metadir ? ["-metadir", metadir] : []),
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
  const run = command(
    "python3",
    [script, "--check", ...tlaFiles],
    { cwd: root, timeoutMs: PIN_CHECK_TIMEOUT_MS, measureMemory: true },
  )
  const verdict = classifyPinResult(run)
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
    const verdict = expectedFailure ? "pass" : "infrastructure_failure"
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

function runTlc(root, tlaFiles, cache = {}) {
  if (tlaFiles.length === 0) {
    return [{
      name: "tlc",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: "java -cp $TLC_JAR tlc2.TLC ...",
      detail: "No TLA model exists for the selected semantic surface.",
    }]
  }
  if (tlaFiles.length > MAX_TLA_FILES) {
    return [{
      name: "tlc",
      verdict: "infrastructure_failure",
      durationMs: 0,
      command: "java -cp $TLC_JAR tlc2.TLC ...",
      detail: `The bounded pilot supports exactly one TLA model; found ${tlaFiles.length}.`,
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
    const config = path.resolve(root, CONTRACT.config)
    if (!fs.existsSync(config)) {
      return {
        name: `tlc:${parsed.name}`,
        verdict: "infrastructure_failure",
        durationMs: 0,
        command: "",
        detail: `${path.relative(root, config)} is missing.`,
      }
    }
    let identity
    let cacheGap = ""
    try {
      identity = currentTlcIdentity(root, tlaFile, jar)
      const previous = cache.directory && readTlcCache(cache.directory, identity)
      if (previous && classifyTlcResult(previous.check) === "pass") {
        return {
          name: `tlc:${parsed.name}`, ...previous.check,
          durationMs: 0,
          cache: { hit: true, key: identity.key, sourceHead: previous.sourceHead, createdAt: previous.createdAt, originalDurationMs: previous.check.durationMs },
        }
      }
    } catch (error) {
      cacheGap = error.message
    }
    const metadir = fs.mkdtempSync(path.join(os.tmpdir(), "formal-advisory-tlc-"))
    let run
    try {
      run = command(
        "java",
        buildTlcArgs(jar, path.relative(parsed.dir, config), path.basename(tlaFile), metadir),
        { cwd: parsed.dir, timeoutMs: TLC_TIMEOUT_MS, measureMemory: true },
      )
    } finally {
      fs.rmSync(metadir, { recursive: true, force: true })
    }
    const check = { name: `tlc:${parsed.name}`, verdict: classifyTlcResult(run), ...run }
    if (identity && cache.directory) {
      try { writeTlcCache(cache.directory, identity, check, cache.head) }
      catch (error) { cacheGap = error.message }
    }
    return { ...check, cache: { hit: false, key: identity?.key || "", ...(cacheGap ? { gap: cacheGap } : {}) } }
  })
}

function currentTlcIdentity(root, tlaFile, jar) {
  const version = command("java", ["-version"], { cwd: root, echo: false, timeoutMs: 10000 })
  if (version.status !== 0) throw new Error("Cannot identify the Java runtime for TLC cache reuse.")
  const parsed = path.parse(tlaFile)
  return tlcIdentity(root, path.relative(root, tlaFile), CONTRACT.config, jar, `${version.stdout}${version.stderr}`,
    buildTlcArgs("<tool-sha256>", path.relative(parsed.dir, path.resolve(root, CONTRACT.config)), parsed.base))
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
  const verdict = classifyHarnessResult(run, { modeledAssertions: true })
  return { name: "fast-check", verdict, ...run }
}

function runAdvisorySelfTest(root) {
  const run = command(
    "node",
    ["scripts/formal_advisory.mjs", "--self-test"],
    { cwd: root, timeoutMs: ADVISORY_SELF_TEST_TIMEOUT_MS, measureMemory: true },
  )
  const verdict = classifyHarnessResult(run)
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
  const run = command(
    "node",
    ["--test", "test/core.test.mjs"],
    { cwd: root, timeoutMs: CLI_CONTRACT_TIMEOUT_MS, measureMemory: true },
  )
  return { name: "cli-contract", verdict: classifyHarnessResult(run), ...run }
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
  const executableModelSelection = classifyPaths(["test/formal/lane-lock-model.mjs"])
  assert.equal(executableModelSelection.impact, "semantic")
  assert.equal(executableModelSelection.pin, true)
  assert.equal(executableModelSelection.tlc, true)
  assert.equal(classifyTlcResult({ stdout: "Model checking completed. No error has been found.", stderr: "" }), "pass")
  assert.equal(classifyTlcResult({ stdout: "Error: Invariant Exclusivity is violated.", stderr: "" }), "counterexample")
  assert.equal(classifyTlcResult({ stdout: "", stderr: "", errorCode: "ETIMEDOUT" }), "state_space_exhausted")
  assert.equal(classifyTlcResult({ stdout: "", stderr: "java.lang.OutOfMemoryError: Java heap space" }), "state_space_exhausted")
  assert.deepEqual(
    buildTlcArgs("/tmp/tla2tools.jar", "LaneLock.cfg", "LaneLock.tla"),
    ["-Xmx2048m", "-XX:+UseParallelGC", "-cp", "/tmp/tla2tools.jar", "tlc2.TLC", "-config", "LaneLock.cfg", "-workers", "4", "LaneLock.tla"],
  )
  assert.deepEqual(
    buildTlcArgs("/tmp/tla2tools.jar", "LaneLock.cfg", "LaneLock.tla", "/tmp/tlc-meta"),
    ["-Xmx2048m", "-XX:+UseParallelGC", "-cp", "/tmp/tla2tools.jar", "tlc2.TLC", "-config", "LaneLock.cfg", "-workers", "4", "-metadir", "/tmp/tlc-meta", "LaneLock.tla"],
  )
  assert.deepEqual(
    buildMeasuredCommandArgs("npm", ["run", "test:formal"], "/tmp/peak-rss-kb.txt"),
    ["-q", "-f", "%M", "-o", "/tmp/peak-rss-kb.txt", "npm", "run", "test:formal"],
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
  assert.match(runTlc("/tmp/unused", ["one.tla", "two.tla"])[0].detail, /supports exactly one TLA model/)
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
  assert.match(workflow, /timeout-minutes: 35/)
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
  const selection = classifyPaths(files, options.impact, changedPinnedProse(root, options.base, files))
  const gitDirectory = command("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, echo: false }).stdout.trim()
  const cacheDirectory = options.cacheDir ? path.resolve(options.cacheDir) : path.join(gitDirectory, "btrain-tlc-cache")
  const relativeCache = path.relative(root, cacheDirectory)
  if (options.cacheDir && !relativeCache.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeCache)) {
    throw new Error("--cache-dir must be outside the worktree. Committed evidence is not an execution cache.")
  }
  const result = {
    schemaVersion: 1,
    advisory: true,
    base: options.base,
    head: executionTree.head,
    changedFiles: files,
    selection,
    checks: [],
  }

  if (options.cacheKeyOnly) {
    try {
      result.cacheKey = currentTlcIdentity(root, path.join(root, CONTRACT.model), process.env.TLC_JAR || "").key
    } catch (error) {
      result.cacheKey = ""
      result.cacheGap = error.message
    }
  }
  if (options.classifyOnly || options.cacheKeyOnly || !selection.formalSurface) {
    result.checks = [{ name: "selection", verdict: "no_formal_surface", durationMs: 0, command: "" }]
  } else {
    const tlaFiles = findTlaFiles(root)
    if (selection.pin) result.checks.push(runPinCheck(root, tlaFiles))
    if (selection.pinToolTest) result.checks.push(runPinToolSelfTest(root))
    const pinBlocked = result.checks.some(check => check.name === "pin" && check.verdict !== "pass")
    if (selection.tlc && !pinBlocked) result.checks.push(...runTlc(root, tlaFiles, { directory: cacheDirectory, head: executionTree.head }))
    if (selection.selfTest) {
      result.checks.push(runAdvisorySelfTest(root))
      const run = command("node", ["--test", "test/formal-advisory.test.mjs"], { cwd: root, timeoutMs: ADVISORY_SELF_TEST_TIMEOUT_MS, measureMemory: true })
      result.checks.push({ name: "advisory-integration", verdict: classifyHarnessResult(run), ...run })
    }
    if (selection.harness) result.checks.push(runHarness(root))
    if (selection.cli) result.checks.push(runCliContractTests(root))
  }

  result.durationMs = Date.now() - startedAt
  result.verdict = options.classifyOnly || options.cacheKeyOnly
    ? selection.formalSurface ? "classified" : "no_formal_surface"
    : overallVerdict(result.checks)
  result.exitCode = options.classifyOnly || options.cacheKeyOnly ? 0 : exitCodeFor(result.checks)
  writeResult(options.output ? path.resolve(root, options.output) : "", result)
  process.exitCode = result.exitCode
}

main().catch((error) => {
  process.stderr.write(`Formal advisory failed: ${error.message}\n`)
  process.exitCode = 2
})
