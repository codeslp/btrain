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
  const env = { ...process.env }
  for (const key of ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", "BTRAIN_LANE", "BTRAIN_LANE_LOCKED"]) {
    delete env[key]
  }
  Object.assign(env, {
    BRAIN_TRAIN_HOME: path.join(cwd, ".btrain-test-home"),
    BTRAIN_NO_REVIEW_DISPATCH: "1",
    ...envOverrides,
  })

  try {
    const result = await exec("node", [path.resolve("src/brain_train/cli.mjs"), ...args], {
      cwd,
      env,
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

async function writeFakeKkgBinary(dir, logPath, opts = {}) {
  const blastSummary = opts.blastRadiusSummary
    || { files_requested: 1, nodes_in_scope: 4, transitive_callers: 2, transitive_callees: 1, lock_overlaps: 1 }
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
    `    summary: ${JSON.stringify(blastSummary)}`,
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

async function writeHardFailingKkgBinary(dir, logPath) {
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
    "if (cmd === 'manifest') {",
    `  process.stdout.write(${JSON.stringify(JSON.stringify(manifest))})`,
    "} else if (cmd === 'health') {",
    "  process.stdout.write(JSON.stringify({ ok: true, kind: 'health', schema_version: '1.0', grade: 'A', stale_index: false }))",
    "} else if (cmd === 'blast-radius') {",
    "  process.stdout.write(JSON.stringify({",
    "    ok: true, kind: 'blast_radius',",
    "    summary: { files_requested: 1, nodes_in_scope: 1, transitive_callers: 0, transitive_callees: 0, lock_overlaps: 0 }",
    "  }))",
    "} else if (cmd === 'review-packet') {",
    "  process.stdout.write(JSON.stringify({ source: 'locked_files', touched_nodes: [], advisories: [], truncated: false }))",
    "} else if (cmd === 'audit') {",
    "  process.stdout.write(JSON.stringify({",
    "    ok: true, kind: 'audit',",
    "    counts: { warn: 0, hard: 1 },",
    "    standards_evaluated: 12,",
    "    advisories: [{",
    "      severity: 'hard',",
    "      standard_id: 'C99',",
    "      kind: 'forbidden_pattern',",
    "      suggestion: 'Remove the forbidden call before requesting review.',",
    "      offenders: [{ path: 'src/feature.js' }]",
    "    }],",
    "    scope_source: 'explicit_files'",
    "  }))",
    "} else {",
    "  process.stdout.write(JSON.stringify({ ok: true, kind: cmd }))",
    "}",
  ].join("\n")
  await fs.writeFile(binPath, script, "utf8")
  await fs.chmod(binPath, 0o755)
  return binPath
}

// Spec 020 WS1 regression, corrected after review. cgraph matches entity paths
// exactly, so an answer with zero nodes proves nothing about collisions -- the
// graph may be unindexed, the lock may name a directory, or the files may hold
// no modelled constructs. btrain used to render that as a clean "0 overlaps"
// check, so a lane could take a lock on a check that never had anything to check.
describe("cgraph inconclusive blast-radius lane flow", () => {
  let tmpDir

  before(async () => {
    tmpDir = await bootstrapRepo()
    const logPath = path.join(tmpDir, "kkg-calls.jsonl")
    // Exactly what kkg returns on an unindexed repo: the file was asked for,
    // and the graph knows nothing about it.
    const binPath = await writeFakeKkgBinary(tmpDir, logPath, {
      blastRadiusSummary: {
        files_requested: 1, nodes_in_scope: 0,
        transitive_callers: 0, transitive_callees: 0, lock_overlaps: 0,
      },
    })
    await appendCgraphConfig(tmpDir, binPath)
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "src", "feature.js"), "export const feature = true\n", "utf8")
  })

  after(async () => { await rmDir(tmpDir) })

  it("reports degraded instead of a clean zero-overlap collision check", async () => {
    const claim = await runCli(
      [
        "handoff", "claim", "--repo", tmpDir, "--lane", "a",
        "--task", "Lock a file the graph has never indexed",
        "--owner", "codex", "--reviewer", "claude", "--files", "src/",
      ],
      tmpDir,
      { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)

    const handoff = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.equal(handoff.code, 0, handoff.stderr)

    // The regression: this line is btrain telling the agent the collision check
    // came back clean. On an empty graph it never ran.
    assert.doesNotMatch(
      handoff.stdout,
      /blast radius: 0 in scope/,
      "an empty graph must not render as a clean zero-overlap blast radius",
    )
    assert.match(
      handoff.stdout,
      /cgraph: degraded/,
      "an inconclusive answer must surface as degraded so the agent knows the check proved nothing",
    )
  })
})

// Review finding on PR #63: metadata is spread from the latest persisted event,
// so a blast_radius recorded when the graph was healthy survives into a later
// run whose live check matched nothing -- and cli.mjs prints that field whenever
// it exists. The degraded warning would then sit next to a stale "N in scope,
// M overlaps" line: the exact collision result the fix exists to suppress.
describe("cgraph stale blast-radius after the graph goes empty", () => {
  let tmpDir, statePath

  before(async () => {
    tmpDir = await bootstrapRepo()
    statePath = path.join(tmpDir, "kkg-phase")
    const logPath = path.join(tmpDir, "kkg-calls.jsonl")
    const binPath = path.join(tmpDir, "kkg")

    // Phase 1 reports a healthy graph; phase 2 reports zero matched nodes.
    const script = [
      "#!/usr/bin/env node",
      "const fs = require('fs')",
      "const args = process.argv.slice(2)",
      "const cmd = args[0] || ''",
      `const statePath = ${JSON.stringify(statePath)}`,
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cmd }) + "\\n")`,
      "let phase = '1'",
      "try { phase = fs.readFileSync(statePath, 'utf8').trim() } catch {}",
      `const manifest = ${JSON.stringify({
        ok: true, kind: "manifest", schema_version: "1.0",
        commands: [
          { name: "review-packet" }, { name: "audit" }, { name: "blast-radius" },
          { name: "advise" }, { name: "drift-check" }, { name: "sync-check" }, { name: "health" },
        ],
        total_commands: 7,
      })}`,
      // Phase 5 makes the manifest probe fail, which is how createAdapter reports
      // a binary that has gone missing or stopped answering.
      "if (cmd === 'manifest') { if (phase === '5') { process.exit(1) } process.stdout.write(JSON.stringify(manifest)) }",
      "else if (cmd === 'blast-radius') {",
      "  const healthy = { files_requested: 1, nodes_in_scope: 7, transitive_callers: 4, transitive_callees: 2, lock_overlaps: 3 }",
      "  const empty   = { files_requested: 1, nodes_in_scope: 0, transitive_callers: 0, transitive_callees: 0, lock_overlaps: 0 }",
      "  const clean   = { files_requested: 1, nodes_in_scope: 7, transitive_callers: 4, transitive_callees: 2, lock_overlaps: 0 }",
      "  if (phase === '3') { process.stdout.write(JSON.stringify({ ok: true, kind: 'blast_radius' })) }",
      "  else if (phase === '4') { process.stdout.write(JSON.stringify({ ok: true, kind: 'blast_radius', summary: clean })) }",
      "  else { process.stdout.write(JSON.stringify({ ok: true, kind: 'blast_radius', summary: phase === '1' ? healthy : empty })) }",
      "} else { process.stdout.write(JSON.stringify({ ok: true, kind: cmd })) }",
    ].join("\n")
    await fs.writeFile(binPath, script)
    await fs.chmod(binPath, 0o755)
    await fs.writeFile(statePath, "1", "utf8")
    await appendCgraphConfig(tmpDir, binPath)
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "src", "feature.js"), "export const feature = true\n", "utf8")
  })

  after(async () => { await rmDir(tmpDir) })

  it("does not keep printing the old overlap count once the graph stops matching", async () => {
    // Phase 1: healthy graph, so a blast_radius is persisted on the claim event.
    const claim = await runCli(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Persist a healthy blast radius",
       "--owner", "codex", "--reviewer", "claude", "--files", "src/"],
      tmpDir, { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)

    const healthy = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(healthy.stdout, /blast radius: 7 in scope/, "phase 1 should record the real figures")

    // Phase 2: same lane, but the graph now matches nothing.
    await fs.writeFile(statePath, "2", "utf8")
    const afterEmpty = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.doesNotMatch(
      afterEmpty.stdout,
      /blast radius: 7 in scope/,
      "the persisted figure must not survive a live check that matched nothing",
    )
    assert.doesNotMatch(afterEmpty.stdout, /3 overlaps/, "stale overlap count must not be reprinted")
    assert.match(afterEmpty.stdout, /cgraph: degraded/)
  })

  it("does not retire a known lock_overlap advisory on an inconclusive check", async () => {
    // Second review finding on PR #63. Reconciliation retires any active
    // advisory the current run did not surface. An inconclusive blast-radius
    // surfaces nothing, so a real collision would be recorded as resolved --
    // an empty graph cannot prove the overlap ended.
    const statePath2 = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")

    await fs.writeFile(statePath, "1", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    const withOverlap = await fs.readFile(statePath2, "utf8").catch(() => "")
    assert.match(withOverlap, /lock_overlap/, "phase 1 should record a lock_overlap advisory")

    await fs.writeFile(statePath, "2", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    const afterEmpty = await fs.readFile(statePath2, "utf8").catch(() => "")

    assert.match(
      afterEmpty,
      /lock_overlap/,
      "an inconclusive check must not retire a collision advisory it cannot disprove",
    )
  })

  it("keeps the advisory when blast-radius stops being available at all", async () => {
    // The first fix marked kinds unproven inside each failure branch, which
    // missed the paths that never reach a branch: a producer the adapter does
    // not support, and an `ok` result carrying no summary. Both surface nothing
    // and would retire a real advisory. The kinds now default to unproven.
    const statePath2 = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")

    await fs.writeFile(statePath, "1", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(
      await fs.readFile(statePath2, "utf8").catch(() => ""),
      /lock_overlap/,
      "phase 1 should record a lock_overlap advisory",
    )

    // Phase 3: blast-radius returns ok with no summary at all.
    await fs.writeFile(statePath, "3", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.match(
      await fs.readFile(statePath2, "utf8").catch(() => ""),
      /lock_overlap/,
      "a payload with no summary proves nothing and must not retire the advisory",
    )
  })

  it("degrades when blast-radius returns ok with a payload it cannot read", async () => {
    // Narrowing the failure branch from `else if (metadata.status === "ok")` to
    // `else if (!blastRadius.ok)` opened a hole: an `ok` result whose payload
    // carries no summary now matches no branch at all. Nothing degrades and no
    // blast_radius is recorded, so `cgraph: ok` prints with no collision check
    // behind it -- the same silent-clean failure this lane exists to remove,
    // reintroduced by the fix for it.
    await fs.writeFile(statePath, "3", "utf8")
    const malformed = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.doesNotMatch(
      malformed.stdout,
      /cgraph: ok/,
      "a payload btrain cannot read must not render as a healthy cgraph",
    )
    assert.match(
      malformed.stdout,
      /cgraph: degraded/,
      "an unreadable blast-radius payload must degrade, not pass silently",
    )
  })

  it("still shows a preserved collision while the check is inconclusive", async () => {
    // Preserving the advisory in the sidecar is only half the job. The CLI
    // renders `metadata.advisories`, which is built from the live run, so an
    // inconclusive check deleted the field and the agent saw only "degraded" --
    // the known collision with another lane became invisible at exactly the
    // moment it could not be re-verified. Carrying it forward silently is not
    // better than retiring it: either way the agent is not told.
    const statePath2 = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")

    await fs.writeFile(statePath, "1", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(
      await fs.readFile(statePath2, "utf8").catch(() => ""),
      /lock_overlap/,
      "phase 1 should record a lock_overlap advisory",
    )

    await fs.writeFile(statePath, "2", "utf8")
    const inconclusive = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.match(
      inconclusive.stdout,
      /lock_overlap|overlap/i,
      "a preserved collision advisory must stay visible, not just stay in the sidecar",
    )
  })

  it("retires an advisory once a conclusive run stops reporting it", async () => {
    // The over-correction. Seeding every persisted kind as unproven made
    // advisories immortal: a conclusive run that no longer reports the overlap
    // deletes the kind from the unproven set, and then the persisted-kinds loop
    // adds it straight back because it is absent from liveAdvisories. Absence
    // of evidence is not evidence of resolution, but a CONCLUSIVE run reporting
    // no overlap IS evidence, and has to be allowed to retire it.
    const statePath2 = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")

    // Phase 1: healthy graph WITH overlaps -> advisory recorded.
    await fs.writeFile(statePath, "1", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(
      await fs.readFile(statePath2, "utf8").catch(() => ""),
      /lock_overlap/,
      "phase 1 should record a lock_overlap advisory",
    )

    // Phase 4: healthy graph, real call edges, but zero overlaps. Conclusive.
    await fs.writeFile(statePath, "4", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    const after = await fs.readFile(statePath2, "utf8").catch(() => "")
    const activeOverlaps = after
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((entry) => entry?.lane === "a" && entry?.kind === "lock_overlap")

    assert.equal(
      activeOverlaps.length,
      0,
      "a conclusive run reporting no overlap must retire the advisory, not preserve it forever",
    )
  })

  it("does not reprint the old blast radius once cgraph itself goes away", async () => {
    // Third review finding on PR #63. The clearing added for the inconclusive
    // case sits after the `if (!adapter)` early return, so the one path that
    // cannot re-measure anything is the one path that still carries the old
    // measurement forward. mergeCgraphMetadata spreads the persisted block and
    // the degraded object has no blast_radius of its own to overwrite it, so
    // the CLI prints last run's overlap count directly beside the warning that
    // cgraph is unavailable.
    await fs.writeFile(statePath, "1", "utf8")
    const healthy = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(healthy.stdout, /blast radius: 7 in scope/, "phase 1 should record the real figures")

    // Phase 5: the binary stops answering the manifest probe, so there is no
    // adapter at all.
    await fs.writeFile(statePath, "5", "utf8")
    const gone = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.match(gone.stdout, /cgraph: degraded/, "a missing binary must degrade")
    assert.doesNotMatch(
      gone.stdout,
      /blast radius: 7 in scope/,
      "a run with no adapter measured nothing and must not reprint the old figures",
    )
    assert.doesNotMatch(gone.stdout, /3 overlaps/, "stale overlap count must not outlive the adapter")
  })

  it("stops reporting the old degradation once the graph comes back", async () => {
    // Fourth review finding on PR #63. status and degraded_reason are spread
    // forward from the persisted event, and every branch that sets them is
    // guarded by `status === "ok"`, so nothing ever clears them. A lane that
    // degraded on an empty graph kept printing "matched no code entities" after
    // a re-index, underneath the fresh blast radius that contradicts it.
    await fs.writeFile(statePath, "2", "utf8")
    // A path outside lane a's `src/` lock, so this claim does not collide.
    await fs.mkdir(path.join(tmpDir, "lib"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "lib", "other.js"), "export const other = true\n", "utf8")
    const claim = await runCli(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "b", "--task", "Persist a degraded reading",
       "--owner", "codex", "--reviewer", "claude", "--files", "lib/other.js"],
      tmpDir, { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)
    const degraded = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(degraded.stdout, /matched no code entities/, "phase 2 should persist the inconclusive reason")

    // Phase 4: the graph is re-indexed and answers conclusively.
    await fs.writeFile(statePath, "4", "utf8")
    const recovered = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.match(
      recovered.stdout,
      /blast radius: 7 in scope/,
      "the recovered run should print its own figures",
    )
    assert.doesNotMatch(
      recovered.stdout,
      /matched no code entities/,
      "a conclusive run must state its own verdict, not repeat the one it just disproved",
    )
  })

  it("does not retire an advisory kind btrain does not produce itself", async () => {
    // cgraph also emits `truncated`, `invalid_locks_json` and `no_graph`, and
    // normalizePayloadAdvisories preserves the kind, so any of them can become a
    // persisted entry. Seeding the unproven set from a two-element literal left
    // those kinds retired and logged as resolved on a run with no evidence.
    const statePath2 = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")
    const existing = await fs.readFile(statePath2, "utf8").catch(() => "")
    await fs.writeFile(
      statePath2,
      existing + JSON.stringify({
        lane: "a", kind: "truncated", context_hash: "deadbeef",
        detail: "seeded", first_seen: new Date().toISOString(),
      }) + "\n",
      "utf8",
    )

    await fs.writeFile(statePath, "2", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.match(
      await fs.readFile(statePath2, "utf8").catch(() => ""),
      /truncated/,
      "a kind this run produced no evidence about must survive reconciliation",
    )
  })
})

describe("cgraph audit hard-violation gate", () => {
  let tmpDir
  let logPath
  let binPath

  before(async () => {
    tmpDir = await makeTmpDir()
    await gitInit(tmpDir)
    const initResult = await runCli(["init", tmpDir, "--agent", "claude", "--agent", "codex"], tmpDir)
    assert.equal(initResult.code, 0, `btrain init failed: ${initResult.stderr}`)
    await commitAll(tmpDir, "init")
    logPath = path.join(tmpDir, "kkg-calls.jsonl")
    binPath = await writeHardFailingKkgBinary(tmpDir, logPath)
    await appendCgraphConfig(tmpDir, binPath)
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "src", "feature.js"), "export const feature = true\n", "utf8")
  })

  after(async () => {
    await rmDir(tmpDir)
  })

  it("blocks needs-review when audit reports a hard violation and surfaces the advisory", async () => {
    const claim = await runCli(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Trigger hard violation",
       "--owner", "codex", "--reviewer", "claude", "--files", "src/"],
      tmpDir, { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)

    const needsReview = await runCli(
      ["handoff", "update", "--repo", tmpDir, "--lane", "a", "--status", "needs-review",
       "--actor", "codex", "--base", "HEAD", "--no-diff",
       "--preflight", "Checked locked files.", "--changed", "Forbidden pattern present for test.",
       "--verification", "n/a", "--gap", "n/a", "--why", "Exercise the audit gate.", "--review-ask", "n/a"],
      tmpDir, { BTRAIN_AGENT: "codex" },
    )
    assert.notEqual(needsReview.code, 0, "needs-review must be blocked when audit reports hard violations")
    const combined = `${needsReview.stdout}\n${needsReview.stderr}`
    assert.match(combined, /hard violation/i)
    assert.match(combined, /C99/)
    assert.match(combined, /src\/feature\.js/)
    assert.match(combined, /Remove the forbidden call/)
    // Gate must be mandatory — no per-config opt-out should be advertised.
    assert.doesNotMatch(combined, /gate_on_hard/)
  })
})

describe("cgraph contentless drift-check", () => {
  // Third review round on PR #63. The branch fixed "an empty answer reads as
  // clean" for blast-radius and left it live in the other producer: the drift
  // gate was `driftResult.ok && driftResult.payload`, so a payload of
  // `{ok: true, kind: "drift_check"}` -- no drifted, no changed_node_ids, no
  // neighbor_files -- passed, printed "0 changed nodes, 0 neighbor files", and
  // (because this same branch added conclusiveAdvisoryKinds) licensed
  // retirement of a real drift advisory it had not disproved.
  let tmpDir, statePath

  before(async () => {
    tmpDir = await bootstrapRepo()
    statePath = path.join(tmpDir, "kkg-phase")
    const binPath = path.join(tmpDir, "kkg")

    const script = [
      "#!/usr/bin/env node",
      "const fs = require('fs')",
      "const args = process.argv.slice(2)",
      "const cmd = args[0] || ''",
      `const statePath = ${JSON.stringify(statePath)}`,
      "let phase = '1'",
      "try { phase = fs.readFileSync(statePath, 'utf8').trim() } catch {}",
      `const manifest = ${JSON.stringify({
        ok: true, kind: "manifest", schema_version: "1.0",
        commands: [
          { name: "review-packet" }, { name: "audit" }, { name: "blast-radius" },
          { name: "advise" }, { name: "drift-check" }, { name: "sync-check" }, { name: "health" },
        ],
        total_commands: 7,
      })}`,
      "if (cmd === 'manifest') { process.stdout.write(JSON.stringify(manifest)) }",
      // Blast-radius stays healthy and conclusive throughout, so anything that
      // changes between phases is the drift producer's doing alone.
      "else if (cmd === 'blast-radius') {",
      "  const healthy = { files_requested: 1, nodes_in_scope: 7, transitive_callers: 4, transitive_callees: 2, lock_overlaps: 0 }",
      "  process.stdout.write(JSON.stringify({ ok: true, kind: 'blast_radius', summary: healthy }))",
      "}",
      "else if (cmd === 'drift-check') {",
      "  if (phase === '1') {",
      "    process.stdout.write(JSON.stringify({ ok: true, kind: 'drift_check', changed_node_ids: ['n1','n2'], neighbor_files: ['src/other.js'] }))",
      "  } else if (phase === '2') {",
      // The contentless answer: ok, right kind, no evidence fields at all.
      "    process.stdout.write(JSON.stringify({ ok: true, kind: 'drift_check' }))",
      "  } else {",
      // A genuine clean answer: the field is present and empty.
      "    process.stdout.write(JSON.stringify({ ok: true, kind: 'drift_check', changed_node_ids: [], neighbor_files: [] }))",
      "  }",
      "} else { process.stdout.write(JSON.stringify({ ok: true, kind: cmd })) }",
    ].join("\n")
    await fs.writeFile(binPath, script)
    await fs.chmod(binPath, 0o755)
    await fs.writeFile(statePath, "1", "utf8")
    await appendCgraphConfig(tmpDir, binPath)
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "src", "feature.js"), "export const feature = true\n", "utf8")
  })

  after(async () => { await rmDir(tmpDir) })

  it("does not retire a drift advisory on a payload carrying no drift fields", async () => {
    const advisoryState = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")

    const claim = await runCli(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Record a real drift advisory",
       "--owner", "codex", "--reviewer", "claude", "--files", "src/"],
      tmpDir, { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)

    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    const withDrift = await fs.readFile(advisoryState, "utf8").catch(() => "")
    assert.match(withDrift, /drift/, "phase 1 should record a drift advisory")

    // Phase 2: the contentless payload. It proves nothing, so the advisory stands.
    await fs.writeFile(statePath, "2", "utf8")
    const afterEmpty = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    const stillThere = await fs.readFile(advisoryState, "utf8").catch(() => "")

    assert.match(
      stillThere,
      /drift/,
      "a drift-check with no drift fields must not retire an advisory it cannot disprove",
    )
    assert.doesNotMatch(
      afterEmpty.stdout,
      /0 changed nodes/,
      "a contentless payload must not be printed as a zero reading",
    )
    assert.match(afterEmpty.stdout, /cgraph: degraded/)
  })

  it("still retires the advisory when drift-check answers with an empty list", async () => {
    // The other half: presence, not count, is the conclusiveness test. A real
    // "nothing drifted" answer sends the field empty and must still retire, or
    // the gate degrades permanently and nobody reads it.
    const advisoryState = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")

    await fs.writeFile(statePath, "1", "utf8")
    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(await fs.readFile(advisoryState, "utf8").catch(() => ""), /drift/)

    await fs.writeFile(statePath, "3", "utf8")
    const afterClean = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    const retired = await fs.readFile(advisoryState, "utf8").catch(() => "")

    assert.doesNotMatch(
      retired,
      /"kind":"drift"/,
      "a conclusive empty answer must be allowed to retire the advisory",
    )
    assert.match(afterClean.stdout, /cgraph: ok/, "a conclusive clean run is not degraded")
  })
})

describe("cgraph claim event on an inconclusive graph", () => {
  // Third review round on PR #63. The path in the PR title -- the pre-lock
  // claim check -- had no test at all: both inconclusive handlers
  // (cgraph_adapter.mjs buildEventMetadata and core.mjs buildClaimCgraphMetadata)
  // could be deleted with 46 tests still passing. Every existing regression
  // drives the live `handoff` render path; none asserted what the claim event
  // persists.
  let tmpDir

  before(async () => {
    tmpDir = await bootstrapRepo()
    const binPath = path.join(tmpDir, "kkg")
    const script = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2)",
      "const cmd = args[0] || ''",
      `const manifest = ${JSON.stringify({
        ok: true, kind: "manifest", schema_version: "1.0",
        commands: [
          { name: "review-packet" }, { name: "audit" }, { name: "blast-radius" },
          { name: "advise" }, { name: "drift-check" }, { name: "sync-check" }, { name: "health" },
        ],
        total_commands: 7,
      })}`,
      "if (cmd === 'manifest') { process.stdout.write(JSON.stringify(manifest)) }",
      // Entities matched, but no call edges: exactly btrain's own state, and
      // the one the old nodes_in_scope test read as a clean zero-overlap check.
      "else if (cmd === 'blast-radius') {",
      "  const noEdges = { files_requested: 1, nodes_in_scope: 7, transitive_callers: 0, transitive_callees: 0, lock_overlaps: 0 }",
      "  process.stdout.write(JSON.stringify({ ok: true, kind: 'blast_radius', summary: noEdges }))",
      "}",
      "else { process.stdout.write(JSON.stringify({ ok: true, kind: cmd })) }",
    ].join("\n")
    await fs.writeFile(binPath, script)
    await fs.chmod(binPath, 0o755)
    await appendCgraphConfig(tmpDir, binPath)
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "src", "feature.js"), "export const feature = true\n", "utf8")
  })

  after(async () => { await rmDir(tmpDir) })

  it("persists degraded with no blast_radius block when the claim check is inconclusive", async () => {
    const claim = await runCli(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Claim against a graph with no call edges",
       "--owner", "codex", "--reviewer", "claude", "--files", "src/"],
      tmpDir, { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)

    const events = await readJsonLines(path.join(tmpDir, ".btrain", "events", "lane-a.jsonl"))
    const claimed = events.filter((event) => event?.details?.cgraph).pop()
    assert.ok(claimed, "the claim event should carry a cgraph block")

    assert.equal(claimed.details.cgraph.status, "degraded", "an inconclusive claim check is not healthy")
    assert.equal(
      claimed.details.cgraph.blast_radius,
      undefined,
      "a zero-overlap figure computed from no edges must not be persisted as a collision check",
    )
    assert.match(String(claimed.details.cgraph.degraded_reason || ""), /inconclusive|no call edges|not evidence/i)
  })
})

describe("cgraph preserved advisory whose producer is no longer supported", () => {
  // gh-codex P1 on PR #63, head fce5586. The producer guards are
  // `if (lockedFiles.length > 0 && adapter.supports("blast-radius"))`. When the
  // manifest stops advertising the capability the whole block is skipped, so
  // nothing sets degraded_reason -- and a carried-forward advisory on its own
  // was not substantive enough for buildCgraphSummaryLines to print anything.
  // A known collision that cannot be re-verified rendered as silence: the same
  // failure as an empty graph reading clean, reached by a third path.
  let tmpDir, statePath

  before(async () => {
    tmpDir = await bootstrapRepo()
    statePath = path.join(tmpDir, "kkg-phase")
    const binPath = path.join(tmpDir, "kkg")

    const script = [
      "#!/usr/bin/env node",
      "const fs = require('fs')",
      "const args = process.argv.slice(2)",
      "const cmd = args[0] || ''",
      `const statePath = ${JSON.stringify(statePath)}`,
      "let phase = '1'",
      "try { phase = fs.readFileSync(statePath, 'utf8').trim() } catch {}",
      "const all = [",
      "  { name: 'review-packet' }, { name: 'audit' }, { name: 'blast-radius' },",
      "  { name: 'advise' }, { name: 'drift-check' }, { name: 'sync-check' }, { name: 'health' },",
      "]",
      // Phase 2 drops blast-radius from the manifest entirely, which is how a
      // downgraded or differently-built cgraph presents itself.
      "if (cmd === 'manifest') {",
      "  const commands = phase === '1' ? all : all.filter((c) => c.name !== 'blast-radius')",
      "  process.stdout.write(JSON.stringify({ ok: true, kind: 'manifest', schema_version: '1.0', commands, total_commands: commands.length }))",
      "}",
      "else if (cmd === 'blast-radius') {",
      "  const healthy = { files_requested: 1, nodes_in_scope: 7, transitive_callers: 4, transitive_callees: 2, lock_overlaps: 3 }",
      "  process.stdout.write(JSON.stringify({ ok: true, kind: 'blast_radius', summary: healthy }))",
      "}",
      // drift-check answers conclusively and cleanly throughout, so it never
      // degrades the run on its own. Without that, its degradation masks the
      // defect under test and the assertion passes for the wrong reason.
      "else if (cmd === 'drift-check') {",
      "  process.stdout.write(JSON.stringify({ ok: true, kind: 'drift_check', changed_node_ids: [], neighbor_files: [] }))",
      "}",
      "else { process.stdout.write(JSON.stringify({ ok: true, kind: cmd })) }",
    ].join("\n")
    await fs.writeFile(binPath, script)
    await fs.chmod(binPath, 0o755)
    await fs.writeFile(statePath, "1", "utf8")
    await appendCgraphConfig(tmpDir, binPath)
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "src", "feature.js"), "export const feature = true\n", "utf8")
  })

  after(async () => { await rmDir(tmpDir) })

  it("still surfaces the collision when the capability disappears", async () => {
    const advisoryState = path.join(tmpDir, ".btrain", "cgraph-advisory-state.jsonl")

    const claim = await runCli(
      ["handoff", "claim", "--repo", tmpDir, "--lane", "a", "--task", "Record a real overlap",
       "--owner", "codex", "--reviewer", "claude", "--files", "src/"],
      tmpDir, { BTRAIN_AGENT: "codex" },
    )
    assert.equal(claim.code, 0, claim.stderr)

    await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })
    assert.match(
      await fs.readFile(advisoryState, "utf8").catch(() => ""),
      /lock_overlap/,
      "phase 1 should record a lock_overlap advisory",
    )

    // Phase 2: cgraph no longer advertises blast-radius at all.
    await fs.writeFile(statePath, "2", "utf8")
    const afterDrop = await runCli(["handoff", "--repo", tmpDir], tmpDir, { BTRAIN_AGENT: "codex" })

    assert.match(
      await fs.readFile(advisoryState, "utf8").catch(() => ""),
      /lock_overlap/,
      "an unsupported producer cannot disprove the overlap, so it must be preserved",
    )
    // The bug: this printed nothing at all.
    assert.match(afterDrop.stdout, /cgraph: degraded/, "a preserved advisory must not render as silence")
    assert.match(
      afterDrop.stdout,
      /blast-radius/,
      "the degradation should name the capability that went missing",
    )
  })
})
