#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const BLOCKING_VERDICTS = new Set(["counterexample", "stale_pin", "validation_mismatch"])
const MODELED_RUNTIME_FILES = new Set([
  "src/brain_train/cli.mjs",
  "src/brain_train/core.mjs",
  "src/brain_train/pr-flow.mjs",
])

function parseArgs(argv) {
  const options = { base: "origin/main", head: "", output: "", classifyOnly: false, selfTest: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--base") options.base = argv[++index] || ""
    else if (arg === "--head") options.head = argv[++index] || ""
    else if (arg === "--output") options.output = argv[++index] || ""
    else if (arg === "--classify-only") options.classifyOnly = true
    else if (arg === "--self-test") options.selfTest = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function command(commandName, args, options = {}) {
  const startedAt = Date.now()
  const result = spawnSync(commandName, args, {
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
  return {
    command: [commandName, ...args].join(" "),
    status: result.status,
    signal: result.signal || "",
    errorCode: result.error?.code || "",
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
  }
}

function repoRoot() {
  const result = command("git", ["rev-parse", "--show-toplevel"], { echo: false })
  if (result.status !== 0) throw new Error("Run this command inside a Git worktree.")
  return result.stdout.trim()
}

function changedFiles(root, base, head) {
  if (!base) throw new Error("--base must name the review base commit or branch.")
  const args = ["diff", "--name-only", base]
  if (head) args.push(head)
  args.push("--")
  const result = command("git", args, { cwd: root, echo: false })
  if (result.status !== 0) {
    throw new Error(`Could not classify the diff from ${base}${head ? ` to ${head}` : ""}.\n${result.stderr}`)
  }
  return result.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)
}

export function classifyPaths(files) {
  const modeledProse = files.some((file) => /^specs\/(002|005|006|014)[^/]*\.md$/.test(file))
  const tlaArtifacts = files.some((file) => file.startsWith("specs/tla/"))
  const pinTool = files.includes("scripts/tla_pin.py")
  const harness = files.some((file) =>
    file.startsWith("test/formal/")
    || file === "package.json"
    || file === "package-lock.json"
    || file === "scripts/formal_advisory.mjs"
    || MODELED_RUNTIME_FILES.has(file),
  )
  const pin = modeledProse || tlaArtifacts || pinTool
  const tlc = modeledProse || tlaArtifacts
  const impact = tlc ? "semantic" : harness || pinTool ? "validation" : "none"
  return {
    impact,
    pin,
    tlc,
    harness,
    formalSurface: pin || tlc || harness,
  }
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
  if (run.errorCode === "ETIMEDOUT" || run.status === 124 || run.signal === "SIGTERM") {
    return "state_space_exhausted"
  }
  if (/Invariant\s+.+\s+is violated|Error:\s+Invariant/i.test(output)) return "counterexample"
  if (/Model checking completed\. No error has been found\./.test(output)) return "pass"
  return "infrastructure_failure"
}

function runPinCheck(root, tlaFiles) {
  if (tlaFiles.length === 0) {
    return { name: "pin", verdict: "no_formal_surface", durationMs: 0, command: "" }
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
  const run = command("python3", [script, "--check"], { cwd: root })
  const verdict = run.status === 0 ? "pass" : run.status === 1 ? "stale_pin" : "infrastructure_failure"
  return { name: "pin", verdict, ...run }
}

function runTlc(root, tlaFiles) {
  if (tlaFiles.length === 0) {
    return [{ name: "tlc", verdict: "no_formal_surface", durationMs: 0, command: "" }]
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
      ["-cp", jar, "tlc2.TLC", "-config", path.basename(config), "-workers", "auto", path.basename(tlaFile)],
      { cwd: parsed.dir, timeoutMs: 300_000 },
    )
    return { name: `tlc:${parsed.name}`, verdict: classifyTlcResult(run), ...run }
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
      verdict: "no_formal_surface",
      durationMs: 0,
      command: "npm run test:formal",
      detail: "package.json does not define test:formal.",
    }
  }
  const run = command("npm", ["run", "test:formal"], { cwd: root })
  const output = `${run.stdout}\n${run.stderr}`
  let verdict = "infrastructure_failure"
  if (run.status === 0) verdict = "pass"
  else if (/validation_mismatch/.test(output)) verdict = "validation_mismatch"
  return { name: "fast-check", verdict, ...run }
}

function exitCodeFor(checks) {
  const verdicts = checks.map((check) => check.verdict)
  if (verdicts.some((verdict) => BLOCKING_VERDICTS.has(verdict))) return 1
  if (verdicts.includes("state_space_exhausted")) return 124
  if (verdicts.includes("infrastructure_failure")) return 2
  return 0
}

function overallVerdict(checks) {
  const code = exitCodeFor(checks)
  if (code === 1) return "fail"
  if (code === 124) return "warn"
  if (code === 2) return "infrastructure_failure"
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

function runSelfTest() {
  assert.deepEqual(classifyPaths(["README.md"]), {
    impact: "none", pin: false, tlc: false, harness: false, formalSurface: false,
  })
  assert.equal(classifyPaths(["specs/014-specula-formal-verification-pilot.md"]).impact, "semantic")
  assert.equal(classifyPaths(["src/brain_train/core.mjs"]).harness, true)
  assert.equal(classifyPaths(["test/formal/lane-lock-harness.test.mjs"]).impact, "validation")
  assert.equal(classifyTlcResult({ stdout: "Model checking completed. No error has been found.", stderr: "" }), "pass")
  assert.equal(classifyTlcResult({ stdout: "Error: Invariant Exclusivity is violated.", stderr: "" }), "counterexample")
  assert.equal(classifyTlcResult({ stdout: "", stderr: "", errorCode: "ETIMEDOUT" }), "state_space_exhausted")
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
  const files = changedFiles(root, options.base, options.head)
  const selection = classifyPaths(files)
  const headResult = command("git", ["rev-parse", options.head || "HEAD"], { cwd: root, echo: false })
  const result = {
    schemaVersion: 1,
    advisory: true,
    base: options.base,
    head: headResult.status === 0 ? headResult.stdout.trim() : options.head || "HEAD",
    changedFiles: files,
    selection,
    checks: [],
  }

  if (options.classifyOnly || !selection.formalSurface) {
    result.checks = [{ name: "selection", verdict: "no_formal_surface", durationMs: 0, command: "" }]
  } else {
    const tlaFiles = findTlaFiles(root)
    if (selection.pin) result.checks.push(runPinCheck(root, tlaFiles))
    const pinBlocked = result.checks.some((check) => check.verdict === "stale_pin")
    if (selection.tlc && !pinBlocked) result.checks.push(...runTlc(root, tlaFiles))
    if (selection.harness) result.checks.push(runHarness(root))
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
