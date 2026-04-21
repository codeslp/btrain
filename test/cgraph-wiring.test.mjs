import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-cgraph-wiring-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

async function gitInit(tmpDir) {
  await exec("git", ["init", "-q", tmpDir])
  await exec("git", ["-C", tmpDir, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", tmpDir, "config", "user.name", "Test Bot"])
}

async function commitAll(tmpDir, message) {
  await exec("git", ["-C", tmpDir, "add", "-A"])
  await exec("git", ["-C", tmpDir, "commit", "-q", "-m", message])
}

async function runCli(args, cwd, envOverrides = {}) {
  try {
    const result = await exec("node", [path.resolve("src/brain_train/cli.mjs"), ...args], {
      cwd,
      env: {
        ...process.env,
        BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home"),
        ...envOverrides,
      },
      maxBuffer: 10 * 1024 * 1024,
    })
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      code: typeof error.code === "number" ? error.code : 1,
    }
  }
}

async function writeFakeKkgBinary(dir, logPath) {
  const binPath = path.join(dir, "kkg")
  const manifest = {
    ok: true,
    kind: "manifest",
    schema_version: "1.0",
    commands: [
      { name: "review-packet" },
      { name: "audit" },
      { name: "blast-radius" },
      { name: "advise" },
      { name: "drift-check" },
      { name: "sync-check" },
      { name: "health" },
    ],
    total_commands: 7,
  }

  const script = [
    "#!/usr/bin/env node",
    "const fs = require('fs')",
    "const args = process.argv.slice(2)",
    "const cmd = args[0] || ''",
    `const logPath = ${JSON.stringify(logPath)}`,
    "fs.appendFileSync(logPath, JSON.stringify({ cmd, argv: args.slice(1) }) + '\\n')",
    "const rejectIfPresent = (flag) => {",
    "  if (args.includes(flag)) {",
    "    process.stderr.write(`unsupported flag for ${cmd}: ${flag}`)",
    "    process.exit(2)",
    "  }",
    "}",
    "if (cmd === 'review-packet' || cmd === 'blast-radius' || cmd === 'health') {",
    "  rejectIfPresent('--format')",
    "}",
    "if (cmd === 'audit') {",
    "  const filesIndex = args.indexOf('--files')",
    "  if (filesIndex === -1 || !args[filesIndex + 1]) {",
    "    process.stderr.write('audit requires --files for lane-scoped review handoffs')",
    "    process.exit(2)",
    "  }",
    "}",
    `const manifest = ${JSON.stringify(manifest)}`,
    "if (cmd === 'manifest') {",
    "  process.stdout.write(JSON.stringify(manifest))",
    "} else if (cmd === 'health') {",
    "  process.stdout.write(JSON.stringify({ ok: true, kind: 'health', grade: 'A', stale_index: false }))",
    "} else if (cmd === 'blast-radius') {",
    "  process.stdout.write(JSON.stringify({",
    "    ok: true,",
    "    kind: 'blast_radius',",
    "    summary: { files_requested: 1, nodes_in_scope: 4, transitive_callers: 2, transitive_callees: 1, lock_overlaps: 1 }",
    "  }))",
    "} else if (cmd === 'advise') {",
    "  process.stdout.write(JSON.stringify({",
    "    situation: args[1],",
    "    advisory_id: `adv_${args[1]}` ,",
    "    suggestion: args[1] === 'drift' ? 'Run `kkg drift-check --lane a` to inspect upstream movement.' : 'Run `kkg blast-radius --files src/ --lane a` to inspect overlap.',",
    "    rationale: 'test rationale'",
    "  }))",
    "} else if (cmd === 'drift-check') {",
    "  process.stdout.write(JSON.stringify({",
    "    ok: true,",
    "    kind: 'drift_check',",
    "    since: args.includes('--since') ? args[args.indexOf('--since') + 1] : '',",
    "    drifted: [{ uid: 'n3', file: 'src/dependency.js' }, { uid: 'n4', file: 'src/worker.js' }],",
    "    neighbor_files: ['src/dependency.js', 'src/worker.js'],",
    "    advisories: []",
    "  }))",
    "} else if (cmd === 'sync-check') {",
    "  process.stdout.write(JSON.stringify({",
    "    upstream: 'CodeGraphContext/CodeGraphContext',",
    "    behind_by: 3,",
    "    new_commits: [{ sha: 'abc', subject: 'One' }, { sha: 'def', subject: 'Two' }, { sha: 'ghi', subject: 'Three' }]",
    "  }))",
    "} else if (cmd === 'review-packet') {",
    "  process.stdout.write(JSON.stringify({",
    "    source: 'locked_files',",
    "    touched_nodes: [{ uid: 'n1' }, { uid: 'n2' }],",
    "    advisories: [{ kind: 'no_diff_available' }],",
    "    truncated: false",
    "  }))",
    "} else if (cmd === 'audit') {",
    "  const filesArg = args[args.indexOf('--files') + 1]",
    "  process.stdout.write(JSON.stringify({",
    "    ok: true,",
    "    kind: 'audit',",
    "    counts: { warn: 1, hard: 0 },",
    "    standards_evaluated: 12,",
    "    advisories: [],",
    "    scope_source: 'explicit_files',",
    "    files_requested: filesArg.split(',').filter(Boolean).length",
    "  }))",
    "} else {",
    "  process.stdout.write(JSON.stringify({ ok: true, kind: cmd }))",
    "}",
  ].join("\n")

  await fs.writeFile(binPath, script, "utf8")
  await fs.chmod(binPath, 0o755)
  return binPath
}

async function bootstrapRepo() {
  const tmpDir = await makeTmpDir()
  await gitInit(tmpDir)
  const initResult = await runCli(["init", tmpDir, "--agent", "claude", "--agent", "codex"], tmpDir)
  assert.equal(initResult.code, 0, `btrain init failed: ${initResult.stderr}`)
  await commitAll(tmpDir, "init")
  return tmpDir
}

async function appendCgraphConfig(repoRoot, binPath) {
  const projectToml = path.join(repoRoot, ".btrain", "project.toml")
  const extra = [
    "",
    "[cgraph]",
    `bin_path = ${JSON.stringify(binPath)}`,
    `source_checkout = ${JSON.stringify(repoRoot)}`,
  ].join("\n")
  await fs.appendFile(projectToml, extra, "utf8")
}

async function readJsonLines(filePath) {
  const content = await fs.readFile(filePath, "utf8")
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe("cgraph adapter wiring", () => {
  let tmpDir
  let logPath
  let binPath

  before(async () => {
    tmpDir = await bootstrapRepo()
    logPath = path.join(tmpDir, "kkg-calls.jsonl")
    binPath = await writeFakeKkgBinary(tmpDir, logPath)
    await appendCgraphConfig(tmpDir, binPath)
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "src", "feature.js"), "export const feature = true\n", "utf8")
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("surfaces cgraph in startup/doctor and persists needs-review artifacts via the live lane flow", async () => {
    const startup = await runCli(["startup", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.equal(startup.code, 0, startup.stderr)
    assert.match(startup.stdout, /cgraph:/)
    assert.match(startup.stdout, /graph health: A/)
    assert.match(startup.stdout, /sync-check: 3 commits behind CodeGraphContext\/CodeGraphContext/)

    const doctor = await runCli(["doctor", "--repo", tmpDir], tmpDir)
    assert.equal(doctor.code, 0, doctor.stderr)
    assert.match(doctor.stdout, /cgraph: ok/)
    assert.match(doctor.stdout, /cgraph binary:/)

    const claim = await runCli(
      [
        "handoff",
        "claim",
        "--repo", tmpDir,
        "--lane", "a",
        "--task", "Integrate cgraph",
        "--owner", "codex",
        "--reviewer", "claude",
        "--files", "src/",
      ],
      tmpDir,
      { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)

    const claimHandoff = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.equal(claimHandoff.code, 0, claimHandoff.stderr)
    assert.match(claimHandoff.stdout, /blast radius:/)

    const needsReview = await runCli(
      [
        "handoff",
        "update",
        "--repo", tmpDir,
        "--lane", "a",
        "--status", "needs-review",
        "--actor", "codex",
        "--base", "HEAD",
        "--no-diff",
        "--preflight", "Checked locked files and nearby diff.",
        "--changed", "Prepared the cgraph-backed reviewer packet path.",
        "--verification", "No automated verification in this temp repo.",
        "--gap", "None.",
        "--why", "Exercise the live cgraph integration path.",
        "--review-ask", "Inspect the persisted packet and audit references.",
      ],
      tmpDir,
      { BTRAIN_AGENT: "codex" },
    )
    assert.equal(needsReview.code, 0, needsReview.stderr)

    const status = await runCli(["status", "--repo", tmpDir], tmpDir)
    assert.equal(status.code, 0, status.stderr)
    assert.match(status.stdout, /review packet:/)
    assert.match(status.stdout, /audit:/)
    assert.match(status.stdout, /drift: 2 changed nodes, 2 neighbor files/)
    assert.match(status.stdout, /advisory: drift — 2 neighbor nodes changed outside lane scope since claim\./)
    assert.match(status.stdout, /advisory: lock_overlap — 1 overlapping lane detected for the claimed lock set\./)
    assert.match(status.stdout, /graph mode: shared-working/)

    const handoff = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "claude" })
    assert.equal(handoff.code, 0, handoff.stderr)
    assert.match(handoff.stdout, /review packet:/)
    assert.match(handoff.stdout, /audit:/)
    assert.match(handoff.stdout, /drift: 2 changed nodes, 2 neighbor files/)
    assert.match(handoff.stdout, /advice: Run `kkg drift-check --lane a` to inspect upstream movement\./)
    assert.match(handoff.stdout, /\.btrain\/artifacts\/cgraph\/review-packets\/lane-a\//)

    const events = await readJsonLines(path.join(tmpDir, ".btrain", "events", "lane-a.jsonl"))
    const latestUpdate = events.filter((event) => event.type === "update").at(-1)
    assert.ok(latestUpdate?.details?.cgraph, "expected cgraph metadata on the needs-review update event")
    assert.equal(latestUpdate.details.cgraph.review_packet.source, "locked_files")
    assert.equal(latestUpdate.details.cgraph.audit.warn, 1)

    const reviewPacketPath = path.join(tmpDir, latestUpdate.details.cgraph.review_packet.path)
    const auditPath = path.join(tmpDir, latestUpdate.details.cgraph.audit.path)
    await fs.access(reviewPacketPath)
    await fs.access(auditPath)

    const resolve = await runCli(
      [
        "handoff",
        "resolve",
        "--repo", tmpDir,
        "--lane", "a",
        "--actor", "claude",
        "--summary", "Reviewed the cgraph-backed packet.",
      ],
      tmpDir,
      { BTRAIN_AGENT: "claude" },
    )
    assert.equal(resolve.code, 0, resolve.stderr)

    const resolvedStatus = await runCli(["status", "--repo", tmpDir], tmpDir)
    assert.equal(resolvedStatus.code, 0, resolvedStatus.stderr)
    assert.doesNotMatch(resolvedStatus.stdout, /review packet:/)
    assert.doesNotMatch(resolvedStatus.stdout, /audit:/)

    const resolvedHandoff = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.equal(resolvedHandoff.code, 0, resolvedHandoff.stderr)
    assert.doesNotMatch(resolvedHandoff.stdout, /review packet:/)
    assert.doesNotMatch(resolvedHandoff.stdout, /audit:/)

    const calls = await readJsonLines(logPath)
    assert.ok(calls.some((entry) => entry.cmd === "health"), "startup should probe kkg health")
    assert.ok(calls.some((entry) => entry.cmd === "sync-check"), "startup should probe sync-check")
    assert.ok(calls.some((entry) => entry.cmd === "blast-radius"), "claim should run blast-radius")
    assert.ok(calls.some((entry) => entry.cmd === "review-packet"), "needs-review should run review-packet")
    assert.ok(calls.some((entry) => entry.cmd === "audit"), "needs-review should run audit")
    assert.ok(calls.some((entry) => entry.cmd === "drift-check"), "status/handoff should run drift-check")
    assert.ok(calls.some((entry) => entry.cmd === "advise" && entry.argv[0] === "drift"), "status/handoff should run drift advice")
    assert.ok(calls.some((entry) => entry.cmd === "advise" && entry.argv[0] === "lock_overlap"), "status/handoff should run overlap advice")
    const auditCall = calls.find((entry) => entry.cmd === "audit")
    assert.ok(auditCall?.argv.includes("--files"), "needs-review audit should use the locked-file set")
    assert.ok(auditCall?.argv.includes("src/"), "needs-review audit should pass the claimed lane file scope")
  })
})
