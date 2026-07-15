#!/usr/bin/env node
/**
 * Smoke test for btrain loop with vendor-harness runners.
 *
 * Creates an isolated temp repo, wires in mock Antigravity and Codex scripts,
 * then exercises btrain loop end-to-end. Nothing touches your
 * real repos. Run with:
 *
 *   node scripts/test-push.mjs
 *
 * Outputs a PASS/FAIL summary at the end.
 */

import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CLI = path.resolve("src/brain_train/cli.mjs")

// ── helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

function section(title) {
  log(`\n${"─".repeat(60)}`)
  log(`  ${title}`)
  log("─".repeat(60))
}

async function run(args, { cwd, env = {}, label = "" } = {}) {
  const tag = label ? `[${label}] ` : ""
  try {
    const result = await execFileAsync("node", [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30_000,
    })
    const out = result.stdout.trim()
    const err = result.stderr.trim()
    if (out) log(out.split("\n").map((l) => `  ${tag}${l}`).join("\n"))
    if (err) log(err.split("\n").map((l) => `  ${tag}STDERR: ${l}`).join("\n"))
    return { out, err, code: 0, ok: true }
  } catch (error) {
    const out = (error.stdout || "").trim()
    const err = (error.stderr || "").trim()
    const code = typeof error.code === "number" ? error.code : 1
    if (out) log(out.split("\n").map((l) => `  ${tag}${l}`).join("\n"))
    if (err) log(err.split("\n").map((l) => `  ${tag}STDERR: ${l}`).join("\n"))
    return { out, err, code, ok: false }
  }
}

async function writeScript(filePath, content) {
  await fs.writeFile(filePath, content, "utf8")
  await fs.chmod(filePath, 0o755)
}

async function readHandoff(repoDir, lane = "A") {
  return fs.readFile(path.join(repoDir, ".claude", "collab", `HANDOFF_${lane}.md`), "utf8")
}

function check(label, condition, detail = "") {
  if (condition) {
    log(`  ✅ ${label}`)
  } else {
    log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`)
    failures.push(label)
  }
}

const failures = []

// ── setup isolated test repo ───────────────────────────────────────────────

section("Setup: isolated temp repo")

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-smoke-"))
const btHome = path.join(tmpDir, ".btrain-home") // isolated btrain home — never touches ~/.btrain

log(`  temp repo: ${tmpDir}`)
log(`  btrain home: ${btHome}`)

const env = { BRAIN_TRAIN_HOME: btHome }

await execFileAsync("git", ["init", tmpDir])
await execFileAsync("git", ["-C", tmpDir, "config", "user.email", "test@btrain"])
await execFileAsync("git", ["-C", tmpDir, "config", "user.name", "btrain test"])

const initResult = await run(["init", tmpDir], { cwd: tmpDir, env, label: "init" })
check("btrain init succeeded", initResult.ok)
check("output mentions Initialized", initResult.out.includes("Initialized"), initResult.out)

// ── write mock runners ─────────────────────────────────────────────────────
//
// These scripts simulate what the real Antigravity / Codex agents would do:
//   1. Log the args they received (so we can verify btrain called them right)
//   2. Sleep briefly (simulates work)
//   3. Update the handoff status to the expected next state
//
section("Setup: mock Antigravity + Codex runners")

const antigravityMock = path.join(tmpDir, "mock-antigravity.js")
const codexMock = path.join(tmpDir, "mock-codex.js")

// Mock Antigravity: validates chat args + moves in-progress → needs-review
await writeScript(
  antigravityMock,
  `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
console.log("[mock-antigravity] called with args:", JSON.stringify(args))

const hasChat   = args.includes("chat")
const hasMode   = args.includes("--mode") && args[args.indexOf("--mode") + 1] === "agent"
const hasReuse  = args.includes("--reuse-window")
const hasPrompt = args[args.length - 1] === "bth --lane a"

if (!hasChat)   { console.error("[mock-antigravity] MISSING: chat subcommand"); process.exit(1) }
if (!hasMode)   { console.error("[mock-antigravity] MISSING: --mode agent"); process.exit(1) }
if (!hasReuse)  { console.error("[mock-antigravity] MISSING: --reuse-window"); process.exit(1) }
if (!hasPrompt) { console.error("[mock-antigravity] MISSING: lane-scoped bth prompt"); process.exit(1) }
console.log("[mock-antigravity] ✅ all expected args present")

const collab = ".claude/collab"
let targetFile = null
for (const f of fs.readdirSync(collab)) {
  if (!f.startsWith("HANDOFF_")) continue
  const p = path.join(collab, f)
  if (fs.readFileSync(p, "utf8").includes("Status: in-progress")) { targetFile = p; break }
}
if (!targetFile) { console.error("[mock-antigravity] no in-progress handoff found"); process.exit(1) }

const content = fs.readFileSync(targetFile, "utf8")
const updated = content
  .replace("Status: in-progress", "Status: needs-review")
  .replace(/Last Updated: .*$/, "Last Updated: Antigravity 2026-01-01T12:00:00.000Z")
fs.writeFileSync(targetFile, updated)
console.log("[mock-antigravity] ✅ handoff moved to needs-review:", targetFile)
`,
)

// Mock Codex: validates exec args + resolves the needs-review handoff
await writeScript(
  codexMock,
  `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
console.log("[mock-codex] called with args:", JSON.stringify(args))

const hasExec = args.includes("exec")
if (!hasExec) { console.error("[mock-codex] MISSING: exec subcommand"); process.exit(1) }
console.log("[mock-codex] ✅ exec subcommand present")

const collab = ".claude/collab"
let targetFile = null
for (const f of fs.readdirSync(collab)) {
  if (!f.startsWith("HANDOFF_")) continue
  const p = path.join(collab, f)
  if (fs.readFileSync(p, "utf8").includes("Status: needs-review")) { targetFile = p; break }
}
if (!targetFile) { console.error("[mock-codex] no needs-review handoff found"); process.exit(1) }

const content = fs.readFileSync(targetFile, "utf8")
const updated = content
  .replace("Status: needs-review", "Status: resolved")
  .replace(/Last Updated: .*$/, "Last Updated: GPT-5 Codex 2026-01-01T12:01:00.000Z")
fs.writeFileSync(targetFile, updated)
console.log("[mock-codex] ✅ handoff resolved:", targetFile)
`,
)

log(`  mock-antigravity: ${antigravityMock}`)
log(`  mock-codex:       ${codexMock}`)

// Configure runners in project.toml to use the mock scripts
const tomlPath = path.join(tmpDir, ".btrain", "project.toml")
let toml = await fs.readFile(tomlPath, "utf8")
toml = toml.replace(
  /\[agents\.runners\][\s\S]*?\n\[reviews\]/,
  `[agents.runners]\n"Antigravity" = "${antigravityMock} chat --mode agent --reuse-window"\n"GPT-5 Codex" = "${codexMock} exec --dangerously-bypass-approvals-and-sandbox"\n\n[reviews]`,
)
await fs.writeFile(tomlPath, toml, "utf8")
log(`  project.toml updated with mock runners`)

// ── test: btrain loop (full relay) ────────────────────────────────────────

section("Test 1: btrain loop (full relay: Antigravity → Codex → resolved)")

// Claim lane a for the full loop cycle (in-progress → needs-review → resolved)
await run(
  [
    "handoff", "claim",
    "--repo", tmpDir,
    "--task", "Implement feature X",
    "--owner", "Antigravity",
    "--reviewer", "GPT-5 Codex",
    "--lane", "a",
    "--files", "src/engine/",
  ],
  { cwd: tmpDir, env, label: "claim-for-loop" },
)

const handoffBeforeLoop = await readHandoff(tmpDir, "A")
check("handoff is in-progress before loop", handoffBeforeLoop.includes("Status: in-progress"))

log("")
log("  Running: btrain loop --repo <test-repo> --lane a --max-rounds 4 --timeout 10 --poll-interval 0.1")
const loopResult = await run(
  ["loop", "--repo", tmpDir, "--lane", "a", "--max-rounds", "4", "--timeout", "10", "--poll-interval", "0.1"],
  { cwd: tmpDir, env, label: "loop" },
)

check("loop exited 0", loopResult.ok, `exit code: ${loopResult.code}\n${loopResult.err}`)
check("loop dispatched Antigravity", loopResult.out.includes("dispatch Antigravity"))
check("loop dispatched GPT-5 Codex", loopResult.out.includes("dispatch GPT-5 Codex"))
check("mock-antigravity ran", loopResult.out.includes("[mock-antigravity]"))
check("mock-codex ran", loopResult.out.includes("[mock-codex]"))
check("handoff transitioned in-progress → needs-review", loopResult.out.includes("before: status=in-progress"))
check("handoff transitioned needs-review → resolved", loopResult.out.includes("before: status=needs-review"))
check("loop completed as resolved", loopResult.out.includes("final handoff: resolved"))

const handoffAfterLoop = await readHandoff(tmpDir, "A")
check("handoff file shows resolved", handoffAfterLoop.includes("Status: resolved"))
check("last-updated shows GPT-5 Codex", handoffAfterLoop.includes("GPT-5 Codex"))

// ── test: dry-run shows correct runner commands ────────────────────────────

section("Test 2: btrain loop --dry-run shows correct command for Antigravity")

// Need a fresh in-progress handoff for dry-run
// Lane a is resolved after loop test; re-claim it for dry-run
await run(
  [
    "handoff", "claim",
    "--repo", tmpDir,
    "--task", "Dry run test",
    "--owner", "Antigravity",
    "--reviewer", "GPT-5 Codex",
    "--lane", "a",
    "--files", "docs/",
  ],
  { cwd: tmpDir, env, label: "claim-dry-run" },
)

const dryRunResult = await run(
  ["loop", "--repo", tmpDir, "--lane", "a", "--dry-run"],
  { cwd: tmpDir, env, label: "dry-run" },
)

check("dry-run exited 0", dryRunResult.ok)
check("dry-run shows antigravity mock command", dryRunResult.out.includes("mock-antigravity"))
check("dry-run shows chat --mode agent --reuse-window", dryRunResult.out.includes("--reuse-window"))
check("dry-run shows lane-scoped bth prompt", dryRunResult.out.includes("prompt: bth --lane a"))

// ── cleanup ────────────────────────────────────────────────────────────────

await fs.rm(tmpDir, { recursive: true, force: true })
log(`\n  cleaned up: ${tmpDir}`)

// ── summary ────────────────────────────────────────────────────────────────

section("Results")

if (failures.length === 0) {
  log(`  ✅ All checks passed`)
  log(``)
  log(`  btrain loop is working correctly with lane-scoped mock runners.`)
  log(`  When you're ready, update ai_sales/.btrain/project.toml runners to:`)
  log(``)
  log(`    "Antigravity" = "antigravity chat --mode agent --reuse-window"`)
  log(`    "GPT-5 Codex" = "codex exec --dangerously-bypass-approvals-and-sandbox"`)
} else {
  log(`  ❌ ${failures.length} check(s) failed:`)
  for (const f of failures) {
    log(`     - ${f}`)
  }
  process.exitCode = 1
}
