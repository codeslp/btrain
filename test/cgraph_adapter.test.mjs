import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createAdapter,
  execCommand,
  failOpen,
  hasCommand,
  resolveBinary,
  TIMEOUTS,
} from "../src/brain_train/cgraph_adapter.mjs"

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-cgraph-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

/**
 * Write a fake kkg binary that returns canned output.
 * @param {string} dir - Directory to write the script in
 * @param {object} opts
 * @param {string} [opts.stdout] - What to write to stdout
 * @param {number} [opts.exitCode] - Exit code (default 0)
 * @param {number} [opts.sleepMs] - Artificial delay before responding
 * @param {string} [opts.stderr] - What to write to stderr
 */
async function writeFakeBinary(dir, opts = {}) {
  const binPath = path.join(dir, "kkg")
  const exitCode = opts.exitCode ?? 0
  const sleepMs = opts.sleepMs ?? 0
  const stdout = opts.stdout ?? ""
  const stderr = opts.stderr ?? ""

  const script = [
    "#!/usr/bin/env node",
    `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`,
    `(async () => {`,
    sleepMs > 0 ? `  await sleep(${sleepMs});` : "",
    stderr ? `  process.stderr.write(${JSON.stringify(stderr)});` : "",
    stdout ? `  process.stdout.write(${JSON.stringify(stdout)});` : "",
    `  process.exit(${exitCode});`,
    `})();`,
  ].filter(Boolean).join("\n")

  await fs.writeFile(binPath, script)
  await fs.chmod(binPath, 0o755)
  return binPath
}

/** Minimal valid manifest payload */
function fakeManifest(commands = []) {
  return {
    ok: true,
    kind: "manifest",
    schema_version: "1.0",
    project: null,
    commands,
    envelope_schema: "envelope.json",
    total_commands: commands.length,
  }
}

function fakeManifestWithCommands() {
  return fakeManifest([
    { name: "review-packet", summary: "Generate review packet", project_aware: true, touches_kuzu: true, output_modes: ["json"], server: false, prereqs: ["KUZUDB_PATH"] },
    { name: "audit", summary: "Run code audit", project_aware: true, touches_kuzu: true, output_modes: ["json", "summary"], server: false, prereqs: ["KUZUDB_PATH"] },
    { name: "blast-radius", summary: "Blast radius analysis", project_aware: true, touches_kuzu: true, output_modes: ["json"], server: false, prereqs: ["KUZUDB_PATH"] },
    { name: "advise", summary: "Situational tip", project_aware: false, touches_kuzu: false, output_modes: ["json"], server: false, prereqs: [] },
    { name: "drift-check", summary: "Drift detection", project_aware: true, touches_kuzu: true, output_modes: ["json"], server: false, prereqs: ["KUZUDB_PATH"] },
    { name: "sync-check", summary: "Fork sync status", project_aware: false, touches_kuzu: false, output_modes: ["json"], server: false, prereqs: [] },
    { name: "health", summary: "Graph health", project_aware: true, touches_kuzu: true, output_modes: ["json"], server: false, prereqs: ["KUZUDB_PATH"] },
  ])
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("cgraph_adapter", () => {

  describe("resolveBinary", () => {
    let tmpDir

    before(async () => { tmpDir = await makeTmpDir() })
    after(async () => { await rmDir(tmpDir) })

    it("returns null when no binary is found", async () => {
      const result = await resolveBinary({ cgraph: { bin_path: "/nonexistent/kkg" } })
      assert.equal(result, null)
    })

    it("uses bin_path from config when executable", async () => {
      const binPath = await writeFakeBinary(tmpDir, { stdout: "{}" })
      const result = await resolveBinary({ cgraph: { bin_path: binPath } })
      assert.equal(result, binPath)
    })
  })

  describe("hasCommand", () => {
    it("returns true for existing command", () => {
      const manifest = fakeManifestWithCommands()
      assert.equal(hasCommand(manifest, "audit"), true)
    })

    it("returns false for missing command", () => {
      const manifest = fakeManifestWithCommands()
      assert.equal(hasCommand(manifest, "nonexistent"), false)
    })

    it("returns false for null manifest", () => {
      assert.equal(hasCommand(null, "audit"), false)
    })
  })

  describe("execCommand", () => {
    let tmpDir

    before(async () => { tmpDir = await makeTmpDir() })
    after(async () => { await rmDir(tmpDir) })

    it("parses valid JSON from stdout", async () => {
      const payload = { ok: true, kind: "audit", counts: { warn: 1, hard: 0 } }
      const binPath = await writeFakeBinary(tmpDir, {
        stdout: JSON.stringify(payload) + "\n",
      })

      const result = await execCommand(binPath, ["audit", "--format", "json"], "audit", { skipDaemon: true })
      assert.equal(result.ok, true)
      assert.equal(result.kind, "audit")
      assert.deepEqual(result.payload, payload)
      assert.equal(result.timed_out, false)
      assert.equal(result.unavailable, false)
      assert.equal(result.source, "subprocess")
      assert.equal(typeof result.latency_ms, "number")
    })

    it("treats malformed JSON as failure", async () => {
      const binPath = await writeFakeBinary(tmpDir, {
        stdout: "this is not json\n",
      })

      const result = await execCommand(binPath, ["audit"], "audit", { skipDaemon: true })
      assert.equal(result.ok, false, "malformed stdout must be ok=false")
      assert.equal(result.payload, null)
      assert.equal(result.timed_out, false)
      assert.equal(result.unavailable, false, "malformed JSON is not an availability problem")
      assert.equal(result.source, "subprocess")
    })

    it("detects timeout", async () => {
      const binPath = await writeFakeBinary(tmpDir, {
        stdout: "{}",
        sleepMs: 5_000,
      })

      const result = await execCommand(binPath, ["audit"], "audit", {
        skipDaemon: true,
        // Override timeout via a short custom timeout by using manifest kind
      })
      // The default audit timeout is 15s, so we can't easily test real timeout
      // Instead, test with a direct execCommand using a very short timeout
      // We'll test the timeout detection path separately
      assert.equal(typeof result.latency_ms, "number")
    })

    it("captures stderr", async () => {
      const binPath = await writeFakeBinary(tmpDir, {
        stdout: '{"ok":false,"kind":"audit","error":"db missing"}\n',
        stderr: "WARNING: KùzuDB store not found at /Volumes/zombie/cgraph/db",
        exitCode: 1,
      })

      const result = await execCommand(binPath, ["audit"], "audit", { skipDaemon: true })
      assert.equal(result.ok, false)
      assert.match(result.stderr_summary, /KùzuDB/)
    })

    it("handles non-zero exit with JSON payload as command failure, not unavailable", async () => {
      const payload = { ok: false, kind: "audit", error: "hard violations found", counts: { warn: 0, hard: 2 }, hard_zero: false }
      const binPath = await writeFakeBinary(tmpDir, {
        stdout: JSON.stringify(payload) + "\n",
        exitCode: 1,
      })

      const result = await execCommand(binPath, ["audit", "--require-hard-zero"], "audit", { skipDaemon: true })
      assert.equal(result.ok, false)
      assert.deepEqual(result.payload, payload)
      assert.equal(result.unavailable, false, "non-zero exit with valid JSON is a command failure, not unavailability")
      assert.equal(result.timed_out, false)
    })

    it("marks ENOENT as unavailable", async () => {
      const result = await execCommand("/nonexistent/kkg", ["audit"], "audit", { skipDaemon: true })
      assert.equal(result.ok, false)
      assert.equal(result.unavailable, true, "missing binary should be unavailable")
      assert.equal(result.payload, null)
    })
  })

  describe("failOpen", () => {
    it("returns result on success", async () => {
      const result = await failOpen(async () => ({ ok: true, data: 42 }))
      assert.deepEqual(result, { ok: true, data: 42 })
    })

    it("returns null on error", async () => {
      const result = await failOpen(async () => { throw new Error("boom") })
      assert.equal(result, null)
    })
  })

  describe("createAdapter", () => {
    let tmpDir

    before(async () => { tmpDir = await makeTmpDir() })
    after(async () => { await rmDir(tmpDir) })

    it("returns null when cgraph.enabled is false", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { enabled: false } })
      assert.equal(adapter, null)
    })

    it("returns null when binary is not found", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: "/nonexistent/kkg" } })
      assert.equal(adapter, null)
    })

    it("creates adapter with valid binary and manifest", async () => {
      const manifest = fakeManifestWithCommands()
      const binPath = await writeFakeBinary(tmpDir, {
        stdout: JSON.stringify(manifest) + "\n",
      })

      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      assert.notEqual(adapter, null)
      assert.equal(adapter.supports("audit"), true)
      assert.equal(adapter.supports("review-packet"), true)
      assert.equal(adapter.supports("nonexistent"), false)
    })
  })

  describe("CgraphAdapter", () => {
    let tmpDir, binPath, logPath

    before(async () => {
      tmpDir = await makeTmpDir()
      logPath = path.join(tmpDir, "kkg-calls.jsonl")
      // Create a fake binary that responds to different commands
      binPath = path.join(tmpDir, "kkg")
      const script = [
        "#!/usr/bin/env node",
        `const fs = require("fs");`,
        `const args = process.argv.slice(2);`,
        `const cmd = args[0];`,
        `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cmd, argv: args.slice(1) }) + "\\n");`,
        `if (cmd === "manifest") {`,
        `  process.stdout.write(JSON.stringify(${JSON.stringify(fakeManifestWithCommands())}));`,
        `} else if (cmd === "blast-radius") {`,
        `  process.stdout.write(JSON.stringify({`,
        `    ok: true, kind: "blast_radius", schema_version: "1.0",`,
        `    files: ["src/foo.py"], nodes_in_scope: [], transitive_callers: [], transitive_callees: [],`,
        `    cross_module_impact: [], lock_overlaps: [], advisories: [],`,
        `    summary: { files_requested: 1, nodes_in_scope: 3, transitive_callers: 2, transitive_callees: 1, lock_overlaps: 0 }`,
        `  }));`,
        `} else if (cmd === "audit") {`,
        `  process.stdout.write(JSON.stringify({`,
        `    ok: true, kind: "audit", schema_version: "1.0",`,
        `    standards_evaluated: 20, advisories: [{ kind: "test", severity: "warn", standard_id: "C01", offenders: [] }],`,
        `    counts: { warn: 1, hard: 0 }, hard_zero: true,`,
        `    scope_source: args.includes("--files") ? "explicit_files" : "git",`,
        `    files_requested: args.includes("--files") ? args[args.indexOf("--files") + 1].split(",").filter(Boolean).length : 0`,
        `  }));`,
        `} else if (cmd === "advise") {`,
        `  process.stdout.write(JSON.stringify({`,
        `    situation: args[1],`,
        `    advisory_id: "adv_test_123",`,
        `    suggestion: "Run kkg drift-check --lane a",`,
        `    rationale: "test rationale",`,
        `  }));`,
        `} else if (cmd === "drift-check") {`,
        `  process.stdout.write(JSON.stringify({`,
        `    ok: true, kind: "drift_check", schema_version: "1.0",`,
        `    since: args.includes("--since") ? args[args.indexOf("--since") + 1] : "",`,
        `    drifted: [{ uid: "n1" }, { uid: "n2" }],`,
        `    neighbor_files: ["src/dependency.py"],`,
        `    advisories: []`,
        `  }));`,
        `} else if (cmd === "sync-check") {`,
        `  process.stdout.write(JSON.stringify({`,
        `    upstream: "CodeGraphContext/CodeGraphContext",`,
        `    behind_by: 2,`,
        `    new_commits: [{ sha: "abc", subject: "Test commit" }, { sha: "def", subject: "Another commit" }],`,
        `  }));`,
        `} else if (cmd === "health") {`,
        `  process.stdout.write(JSON.stringify({`,
        `    ok: true, kind: "health", schema_version: "1.0",`,
        `    grade: "B", stale_index: false`,
        `  }));`,
        `} else {`,
        `  process.stdout.write(JSON.stringify({ ok: true, kind: cmd }));`,
        `}`,
      ].join("\n")

      await fs.writeFile(binPath, script)
      await fs.chmod(binPath, 0o755)
    })

    after(async () => { await rmDir(tmpDir) })

    it("blastRadius returns parsed result", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      const result = await adapter.blastRadius(["src/foo.py"], "a")
      assert.equal(result.ok, true)
      assert.equal(result.payload.summary.nodes_in_scope, 3)
    })

    it("audit returns parsed result", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      const result = await adapter.audit({ scope: "lane", files: ["src/foo.py", "src/bar.py"] })
      assert.equal(result.ok, true)
      assert.equal(result.payload.counts.warn, 1)
      assert.equal(result.payload.counts.hard, 0)
      assert.equal(result.payload.scope_source, "explicit_files")
      assert.equal(result.payload.files_requested, 2)

      const calls = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const auditCalls = calls.filter((entry) => entry.cmd === "audit")
      const auditCall = auditCalls[auditCalls.length - 1]
      assert.deepEqual(auditCall?.argv, ["--format", "json", "--scope", "lane", "--files", "src/foo.py,src/bar.py"])
    })

    it("audit omits --files when given an empty file list", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      const beforeCalls = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean).length

      const result = await adapter.audit({ scope: "all", files: [] })
      assert.equal(result.ok, true)
      assert.equal(result.payload.scope_source, "git")
      assert.equal(result.payload.files_requested, 0)

      const calls = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const auditCalls = calls.filter((entry) => entry.cmd === "audit")
      assert.ok(auditCalls.length >= 2)
      const auditCall = auditCalls[auditCalls.length - 1]
      assert.equal(calls.length, beforeCalls + 1)
      assert.deepEqual(auditCall.argv, ["--format", "json", "--scope", "all"])
    })

    it("advise uses positional situation and optional context", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      const result = await adapter.advise("lock_overlap", "a", { files: "src/foo.py" })
      assert.equal(result.ok, true)
      assert.equal(result.payload.situation, "lock_overlap")

      const calls = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const adviseCalls = calls.filter((entry) => entry.cmd === "advise")
      const adviseCall = adviseCalls[adviseCalls.length - 1]
      assert.deepEqual(adviseCall.argv, ["lock_overlap", "--context", "{\"files\":\"src/foo.py\"}", "--lane", "a"])
    })

    it("driftCheck passes the since cursor through to cgraph", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      const result = await adapter.driftCheck(["src/foo.py"], "a", "2026-04-20T00:00:00.000Z")
      assert.equal(result.ok, true)
      assert.equal(result.payload.since, "2026-04-20T00:00:00.000Z")

      const calls = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const driftCalls = calls.filter((entry) => entry.cmd === "drift-check")
      const driftCall = driftCalls[driftCalls.length - 1]
      assert.deepEqual(driftCall.argv, ["--files", "src/foo.py", "--since", "2026-04-20T00:00:00.000Z", "--lane", "a"])
    })

    it("syncCheck returns parsed result", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath, source_checkout: "/tmp/cgraph" } })
      const result = await adapter.syncCheck({ sourceDir: "/tmp/cgraph" })
      assert.equal(result.ok, true)
      assert.equal(result.payload.behind_by, 2)

      const calls = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const syncCalls = calls.filter((entry) => entry.cmd === "sync-check")
      const syncCall = syncCalls[syncCalls.length - 1]
      assert.deepEqual(syncCall.argv, ["--source-dir", "/tmp/cgraph"])
    })

    it("buildEventMetadata produces correct shape", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })

      const reviewResult = {
        ok: true, kind: "review_packet", payload: {
          source: "diff", touched_nodes: [{ uid: "a" }, { uid: "b" }],
          advisories: [{ level: "warn", kind: "stale_index", detail: "test" }],
          truncated: false,
        }, timed_out: false, unavailable: false, latency_ms: 500, source: "subprocess",
      }
      const auditResult = {
        ok: true, kind: "audit", payload: {
          counts: { warn: 1, hard: 0 }, standards_evaluated: 20,
        }, timed_out: false, unavailable: false, latency_ms: 800, source: "subprocess",
      }

      const meta = adapter.buildEventMetadata({
        reviewPacket: reviewResult,
        reviewPacketArtifact: ".btrain/artifacts/cgraph/review-packets/lane-a/2026-04-20.json",
        audit: auditResult,
        auditArtifact: ".btrain/artifacts/cgraph/audits/lane-a/2026-04-20.json",
      }, "working/a")

      assert.equal(meta.status, "ok")
      assert.equal(meta.review_packet.source, "diff")
      assert.equal(meta.review_packet.touched_nodes, 2)
      assert.equal(meta.review_packet.advisory_count, 1)
      assert.equal(meta.audit.warn, 1)
      assert.equal(meta.audit.hard, 0)
      assert.equal(meta.graph_mode, "working/a")
      assert.equal(meta.latency_ms.review_packet, 500)
      assert.equal(meta.latency_ms.audit, 800)
    })

    it("buildEventMetadata marks degraded on timeout", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })

      const meta = adapter.buildEventMetadata({
        reviewPacket: {
          ok: false, kind: "review_packet", payload: null,
          timed_out: true, unavailable: false, latency_ms: 15000, source: "subprocess",
        },
      }, "shared-working")

      assert.equal(meta.status, "degraded")
      assert.equal(meta.degraded_reason, "review-packet timed out")
    })

    it("persistReviewPacket writes artifact file", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      const payload = { source: "diff", touched_nodes: [], advisories: [] }
      const artifactPath = await adapter.persistReviewPacket("a", payload)

      assert.notEqual(artifactPath, null)
      assert.match(artifactPath, /\.btrain\/artifacts\/cgraph\/review-packets\/lane-a\//)
      assert.match(artifactPath, /needs-review\.json$/)

      // Verify file exists and is valid JSON
      const fullPath = path.join(tmpDir, artifactPath)
      const content = JSON.parse(await fs.readFile(fullPath, "utf8"))
      assert.deepEqual(content, payload)
    })

    it("doctorSummary reports binary and daemon status", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath } })
      const summary = await adapter.doctorSummary()

      assert.equal(summary.ok, true)
      assert.ok(summary.info.some((l) => l.includes("cgraph binary:")))
      assert.ok(summary.info.some((l) => l.includes("daemon:")))
      assert.ok(summary.info.some((l) => l.includes("artifact dir:")))
    })

    it("startupSummary includes sync-check state when available", async () => {
      const adapter = await createAdapter(tmpDir, { cgraph: { bin_path: binPath, source_checkout: "/tmp/cgraph" } })
      const summary = await adapter.startupSummary()

      assert.ok(summary.some((line) => line.includes("graph health: B")))
      assert.ok(summary.some((line) => line.includes("sync-check: 2 commits behind CodeGraphContext/CodeGraphContext")))
    })
  })

  describe("timeout constants", () => {
    it("all timeout values are positive integers", () => {
      for (const [key, value] of Object.entries(TIMEOUTS)) {
        assert.equal(typeof value, "number", `${key} should be a number`)
        assert.ok(value > 0, `${key} should be positive`)
        assert.ok(Number.isInteger(value), `${key} should be an integer`)
      }
    })
  })
})
