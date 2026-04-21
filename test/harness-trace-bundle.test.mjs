import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  HARNESS_TRACE_FAILURE_CATEGORIES,
  HARNESS_TRACE_OUTCOMES,
  TRACE_BUNDLE_VERSION,
  createTraceBundle,
  finalizeTraceBundle,
  generateTraceRunId,
  getTraceBundleDir,
  isHarnessTraceFailureCategory,
  isHarnessTraceOutcome,
  isValidTraceRunId,
  listTraceBundles,
  normalizeAgentCardRef,
  normalizeHarnessTraceFailureCategory,
  normalizeHarnessTraceOutcome,
  readTraceBundleSummary,
  recordTraceEvent,
  writeTraceArtifact,
} from "../src/brain_train/harness/trace-bundle.mjs"

async function makeTmpRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), "btrain-trace-test-"))
}

async function rmDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
}

describe("harness trace bundle constants", () => {
  it("exposes stable outcomes and failure categories", () => {
    assert.deepEqual([...HARNESS_TRACE_OUTCOMES], ["pass", "fail", "error", "skipped"])
    assert.ok(HARNESS_TRACE_FAILURE_CATEGORIES.includes("timeout"))
    assert.ok(HARNESS_TRACE_FAILURE_CATEGORIES.includes("delivery-failure"))
    assert.ok(HARNESS_TRACE_FAILURE_CATEGORIES.includes("unknown"))
  })

  it("freezes the category arrays so benchmark callers can depend on them", () => {
    assert.throws(() => {
      HARNESS_TRACE_OUTCOMES.push("new-outcome")
    })
    assert.throws(() => {
      HARNESS_TRACE_FAILURE_CATEGORIES.push("new-category")
    })
  })

  it("recognizes valid outcomes and categories", () => {
    assert.equal(isHarnessTraceOutcome("pass"), true)
    assert.equal(isHarnessTraceOutcome("bogus"), false)
    assert.equal(isHarnessTraceFailureCategory("timeout"), true)
    assert.equal(isHarnessTraceFailureCategory("not-a-category"), false)
  })

  it("normalizes unknown outcomes and categories to stable fallbacks", () => {
    assert.equal(normalizeHarnessTraceOutcome("", "fail"), "fail")
    assert.equal(normalizeHarnessTraceOutcome("unexpected", "pass"), "pass")
    assert.equal(normalizeHarnessTraceFailureCategory("", "unknown"), "unknown")
    assert.equal(normalizeHarnessTraceFailureCategory("not-real", "timeout"), "timeout")
  })
})

describe("generateTraceRunId", () => {
  it("generates deterministic prefixes for a fixed startedAt", () => {
    const startedAt = "2026-04-19T14:25:30Z"
    const runId = generateTraceRunId({ startedAt, suffix: "abc123" })
    assert.equal(runId, "run_20260419T142530Z_abc123")
    assert.equal(isValidTraceRunId(runId), true)
  })

  it("produces unique ids without a suffix", () => {
    const a = generateTraceRunId({ startedAt: "2026-04-19T14:25:30Z" })
    const b = generateTraceRunId({ startedAt: "2026-04-19T14:25:30Z" })
    assert.ok(isValidTraceRunId(a))
    assert.ok(isValidTraceRunId(b))
    assert.notEqual(a, b)
  })
})

describe("createTraceBundle", () => {
  let repoRoot = ""
  before(async () => {
    repoRoot = await makeTmpRepo()
  })
  after(async () => {
    await rmDir(repoRoot)
  })

  it("creates the bundle skeleton under .btrain/harness/runs/<id>/", async () => {
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "writer-happy-path",
      profileId: "default",
      startedAt: "2026-04-19T14:25:30Z",
      context: { lane: "b" },
    })

    assert.equal(isValidTraceRunId(bundle.runId), true)
    assert.equal(bundle.bundleDir, getTraceBundleDir(repoRoot, bundle.runId))

    const summary = JSON.parse(await fs.readFile(bundle.summaryPath, "utf8"))
    assert.equal(summary.version, TRACE_BUNDLE_VERSION)
    assert.equal(summary.runId, bundle.runId)
    assert.equal(summary.scenarioId, "writer-happy-path")
    assert.equal(summary.profileId, "default")
    assert.equal(summary.startedAt, "2026-04-19T14:25:30Z")
    assert.equal(summary.outcome, "")
    assert.deepEqual(summary.context, { lane: "b" })

    for (const sub of ["events", "artifacts", "prompts"]) {
      const stat = await fs.stat(path.join(bundle.bundleDir, sub))
      assert.ok(stat.isDirectory(), `expected ${sub}/ directory`)
    }
  })

  it("rejects creating a bundle twice for the same run id", async () => {
    const runId = generateTraceRunId({ startedAt: "2026-04-19T14:25:30Z", suffix: "dup001" })
    await createTraceBundle({ repoRoot, runId, scenarioId: "dup", profileId: "default" })
    await assert.rejects(
      () => createTraceBundle({ repoRoot, runId, scenarioId: "dup", profileId: "default" }),
      /already exists/,
    )
  })

  it("rejects malformed run ids", async () => {
    await assert.rejects(
      () => createTraceBundle({ repoRoot, runId: "not-a-run-id" }),
      /Invalid trace run id/,
    )
  })
})

describe("recordTraceEvent and writeTraceArtifact", () => {
  let repoRoot = ""
  let bundle = null
  before(async () => {
    repoRoot = await makeTmpRepo()
    bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "events-test",
      profileId: "default",
      startedAt: "2026-04-19T14:25:30Z",
    })
  })
  after(async () => {
    await rmDir(repoRoot)
  })

  it("appends trace events as jsonl", async () => {
    await recordTraceEvent(bundle.bundleDir, {
      type: "prompt",
      role: "writer",
      text: "initial prompt",
      ts: "2026-04-19T14:25:31Z",
    })
    await recordTraceEvent(bundle.bundleDir, {
      type: "tool",
      name: "handoff.claim",
    })

    const raw = await fs.readFile(bundle.eventsPath, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.type, "prompt")
    assert.equal(first.ts, "2026-04-19T14:25:31Z")
    assert.equal(first.role, "writer")
    const second = JSON.parse(lines[1])
    assert.equal(second.type, "tool")
    assert.ok(second.ts, "auto-fills ts when not provided")
  })

  it("refuses events without a type", async () => {
    await assert.rejects(
      () => recordTraceEvent(bundle.bundleDir, { name: "missing-type" }),
      /missing a type/,
    )
  })

  it("writes artifacts inside the bundle and refuses escape paths", async () => {
    const artifact = await writeTraceArtifact(bundle.bundleDir, "review/findings.json", { ok: true })
    const parsed = JSON.parse(await fs.readFile(artifact.path, "utf8"))
    assert.deepEqual(parsed, { ok: true })

    await assert.rejects(
      () => writeTraceArtifact(bundle.bundleDir, "../escape.txt", "nope"),
      /outside the bundle/,
    )
    await assert.rejects(
      () => writeTraceArtifact(bundle.bundleDir, "/absolute/escape.txt", "nope"),
      /outside the bundle/,
    )
  })
})

describe("finalizeTraceBundle", () => {
  let repoRoot = ""
  before(async () => {
    repoRoot = await makeTmpRepo()
  })
  after(async () => {
    await rmDir(repoRoot)
  })

  it("writes summary.json and appends one index.jsonl line", async () => {
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "finalize-1",
      profileId: "default",
      startedAt: "2026-04-19T14:25:30Z",
    })

    const { summary, indexPath } = await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "pass",
      summary: "wrote + acked",
      endedAt: "2026-04-19T14:25:45Z",
      metrics: { turns: 4, durationMs: 15000 },
      artifactRefs: ["review/findings.json"],
    })

    assert.equal(summary.outcome, "pass")
    assert.equal(summary.failureCategory, "")
    assert.equal(summary.endedAt, "2026-04-19T14:25:45Z")
    assert.equal(summary.summary, "wrote + acked")
    assert.equal(summary.metrics.turns, 4)
    assert.equal(summary.metrics.durationMs, 15000)
    assert.deepEqual(summary.artifactRefs, ["review/findings.json"])

    const onDisk = JSON.parse(await fs.readFile(bundle.summaryPath, "utf8"))
    assert.equal(onDisk.outcome, "pass")

    const indexRaw = await fs.readFile(indexPath, "utf8")
    const indexLines = indexRaw.split("\n").filter(Boolean)
    assert.equal(indexLines.length, 1)
    const entry = JSON.parse(indexLines[0])
    assert.equal(entry.runId, bundle.runId)
    assert.equal(entry.outcome, "pass")
    assert.equal(entry.summary, "wrote + acked")
  })

  it("normalizes unknown failure categories to 'unknown' on failure", async () => {
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "finalize-2",
      profileId: "default",
      startedAt: "2026-04-19T14:26:00Z",
    })

    const { summary } = await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "fail",
      summary: "reviewer missed seeded defect",
      failureCategory: "bogus-category",
    })

    assert.equal(summary.outcome, "fail")
    assert.equal(summary.failureCategory, "unknown")
  })

  it("clears failureCategory on pass outcomes", async () => {
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "finalize-3",
      profileId: "default",
      startedAt: "2026-04-19T14:26:10Z",
    })

    const { summary } = await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "pass",
      summary: "all good",
      failureCategory: "timeout",
    })

    assert.equal(summary.outcome, "pass")
    assert.equal(summary.failureCategory, "")
  })

  it("stays idempotent across repeat finalize calls on the same bundle", async () => {
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "finalize-idempotent",
      profileId: "default",
      startedAt: "2026-04-19T14:26:20Z",
    })

    await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "fail",
      summary: "first pass",
      failureCategory: "timeout",
    })
    await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "pass",
      summary: "second pass wins",
    })

    const listed = await listTraceBundles({ repoRoot })
    const matches = listed.runs.filter((run) => run.runId === bundle.runId)
    assert.equal(matches.length, 1, "a run id appears once regardless of how many times finalize wrote it")
    assert.equal(matches[0].outcome, "pass", "the most recent finalize wins")
    assert.equal(matches[0].failureCategory, "", "pass outcome clears the failure category")
    assert.equal(matches[0].summary, "second pass wins")
  })

  it("refuses finalize without a prior create", async () => {
    const bundleDir = getTraceBundleDir(repoRoot, generateTraceRunId({
      startedAt: "2026-04-19T14:27:00Z",
      suffix: "missing",
    }))
    await assert.rejects(
      () => finalizeTraceBundle(bundleDir, { repoRoot, outcome: "pass" }),
      /No trace bundle summary/,
    )
  })
})

describe("listTraceBundles", () => {
  let repoRoot = ""
  before(async () => {
    repoRoot = await makeTmpRepo()
  })
  after(async () => {
    await rmDir(repoRoot)
  })

  it("returns an empty list for a fresh repo", async () => {
    const result = await listTraceBundles({ repoRoot })
    assert.equal(result.total, 0)
    assert.deepEqual(result.runs, [])
  })

  it("returns runs newest-first and respects limit", async () => {
    const first = await createTraceBundle({
      repoRoot,
      scenarioId: "list-1",
      profileId: "default",
      startedAt: "2026-04-19T10:00:00Z",
    })
    await finalizeTraceBundle(first.bundleDir, { repoRoot, outcome: "pass", summary: "first" })

    const second = await createTraceBundle({
      repoRoot,
      scenarioId: "list-2",
      profileId: "default",
      startedAt: "2026-04-19T12:00:00Z",
    })
    await finalizeTraceBundle(second.bundleDir, {
      repoRoot,
      outcome: "fail",
      summary: "second",
      failureCategory: "timeout",
    })

    const all = await listTraceBundles({ repoRoot })
    assert.equal(all.total, 2)
    assert.equal(all.runs[0].runId, second.runId)
    assert.equal(all.runs[0].outcome, "fail")
    assert.equal(all.runs[0].failureCategory, "timeout")
    assert.equal(all.runs[1].runId, first.runId)

    const limited = await listTraceBundles({ repoRoot, limit: 1 })
    assert.equal(limited.runs.length, 1)
    assert.equal(limited.runs[0].runId, second.runId)
  })

  it("reconstructs entries from summary.json when the index is missing", async () => {
    const fresh = await makeTmpRepo()
    try {
      const bundle = await createTraceBundle({
        repoRoot: fresh,
        scenarioId: "reconstruct",
        profileId: "default",
        startedAt: "2026-04-19T13:00:00Z",
      })
      await finalizeTraceBundle(bundle.bundleDir, {
        repoRoot: fresh,
        outcome: "pass",
        summary: "indexed",
      })

      await fs.rm(path.join(fresh, ".btrain", "harness", "index.jsonl"))
      const result = await listTraceBundles({ repoRoot: fresh })
      assert.equal(result.total, 1)
      assert.equal(result.runs[0].runId, bundle.runId)
      assert.equal(result.runs[0].outcome, "pass")
    } finally {
      await rmDir(fresh)
    }
  })
})

describe("readTraceBundleSummary", () => {
  let repoRoot = ""
  let runId = ""
  before(async () => {
    repoRoot = await makeTmpRepo()
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "show-1",
      profileId: "default",
      startedAt: "2026-04-19T14:00:00Z",
    })
    runId = bundle.runId
    await recordTraceEvent(bundle.bundleDir, { type: "prompt", role: "writer" })
    await recordTraceEvent(bundle.bundleDir, { type: "tool", name: "harness.list" })
    await writeTraceArtifact(bundle.bundleDir, "review/findings.json", { ok: true })
    await writeTraceArtifact(bundle.bundleDir, "raw/transcript.txt", "line 1\nline 2\n")
    await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "pass",
      summary: "covered",
      metrics: { turns: 2 },
    })
  })
  after(async () => {
    await rmDir(repoRoot)
  })

  it("returns summary plus artifact and event counts", async () => {
    const result = await readTraceBundleSummary({ repoRoot, runId })
    assert.equal(result.runId, runId)
    assert.equal(result.summary.outcome, "pass")
    assert.equal(result.summary.metrics.turns, 2)
    assert.equal(result.eventCount, 2)
    assert.equal(result.artifactCount, 2)
  })

  it("throws when the run id is unknown", async () => {
    await assert.rejects(
      () => readTraceBundleSummary({
        repoRoot,
        runId: generateTraceRunId({ startedAt: "2026-04-19T15:00:00Z", suffix: "absent" }),
      }),
      /No trace bundle/,
    )
  })

  it("throws when the run id is malformed", async () => {
    await assert.rejects(
      () => readTraceBundleSummary({ repoRoot, runId: "nope" }),
      /Invalid trace run id/,
    )
  })
})

describe("normalizeAgentCardRef", () => {
  it("returns an empty shape when the input is missing or malformed", () => {
    assert.deepEqual(normalizeAgentCardRef(undefined), { agentName: "", role: "", summary: "" })
    assert.deepEqual(normalizeAgentCardRef(null), { agentName: "", role: "", summary: "" })
    assert.deepEqual(normalizeAgentCardRef([1, 2]), { agentName: "", role: "", summary: "" })
  })

  it("extracts and trims recognized fields", () => {
    const ref = normalizeAgentCardRef({
      agentName: "  claude  ",
      role: "reviewer ",
      summary: " meta-harness reviewer card ",
    })
    assert.deepEqual(ref, {
      agentName: "claude",
      role: "reviewer",
      summary: "meta-harness reviewer card",
    })
  })

  it("accepts 'name' and 'description' as aliases", () => {
    const ref = normalizeAgentCardRef({ name: "codex", description: "primary writer" })
    assert.deepEqual(ref, {
      agentName: "codex",
      role: "",
      summary: "primary writer",
    })
  })
})

describe("createTraceBundle taskEnvelope + agentCardRef persistence", () => {
  let repoRoot

  before(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-trace-envelope-"))
  })

  after(async () => {
    await rmDir(repoRoot)
  })

  it("defaults to an empty envelope and empty card ref when omitted", async () => {
    const handle = await createTraceBundle({ repoRoot, scenarioId: "writer-lane-discipline" })
    const bundle = await readTraceBundleSummary({ repoRoot, runId: handle.runId })
    assert.equal(bundle.summary.taskEnvelope.task, "")
    assert.equal(bundle.summary.taskEnvelope.laneId, "")
    assert.deepEqual(bundle.summary.taskEnvelope.artifactRefs, [])
    assert.deepEqual(bundle.summary.agentCardRef, {
      agentName: "",
      role: "",
      summary: "",
    })
  })

  it("round-trips a provided taskEnvelope through summary.json", async () => {
    const handle = await createTraceBundle({
      repoRoot,
      scenarioId: "reviewer-seeded-defects",
      taskEnvelope: {
        kind: "review",
        laneId: "b",
        task: "Review benchmark registry slice",
        status: "needs-review",
        actor: "codex",
        owner: "claude",
        reviewer: "codex",
        summary: "Inspect benchmark-registry.mjs + fixtures",
        artifactRefs: [
          { kind: "spec", label: "plan", path: "specs/010-...md", note: "WS6" },
        ],
      },
    })

    const bundle = await readTraceBundleSummary({ repoRoot, runId: handle.runId })
    const envelope = bundle.summary.taskEnvelope
    assert.equal(envelope.kind, "review")
    assert.equal(envelope.laneId, "b")
    assert.equal(envelope.task, "Review benchmark registry slice")
    assert.equal(envelope.status, "needs-review")
    assert.equal(envelope.actor, "codex")
    assert.equal(envelope.owner, "claude")
    assert.equal(envelope.reviewer, "codex")
    assert.equal(envelope.summary, "Inspect benchmark-registry.mjs + fixtures")
    assert.equal(envelope.artifactRefs.length, 1)
    assert.equal(envelope.artifactRefs[0].label, "plan")
  })

  it("round-trips an agentCardRef through summary.json", async () => {
    const handle = await createTraceBundle({
      repoRoot,
      scenarioId: "writer-lane-discipline",
      agentCardRef: {
        agentName: "claude",
        role: "writer",
        summary: "Primary writer for the current workstream",
      },
    })

    const bundle = await readTraceBundleSummary({ repoRoot, runId: handle.runId })
    assert.deepEqual(bundle.summary.agentCardRef, {
      agentName: "claude",
      role: "writer",
      summary: "Primary writer for the current workstream",
    })
  })

  it("preserves envelope + card across finalizeTraceBundle", async () => {
    const handle = await createTraceBundle({
      repoRoot,
      scenarioId: "diffless-research-evidence",
      taskEnvelope: {
        kind: "diffless-output",
        task: "Research: harness benchmarks",
        actor: "claude",
      },
      agentCardRef: { agentName: "claude", role: "researcher" },
    })

    await finalizeTraceBundle(handle.bundleDir, {
      repoRoot,
      outcome: "pass",
      summary: "Research completed",
    })

    const bundle = await readTraceBundleSummary({ repoRoot, runId: handle.runId })
    assert.equal(bundle.summary.outcome, "pass")
    assert.equal(bundle.summary.taskEnvelope.kind, "diffless-output")
    assert.equal(bundle.summary.taskEnvelope.task, "Research: harness benchmarks")
    assert.equal(bundle.summary.agentCardRef.agentName, "claude")
    assert.equal(bundle.summary.agentCardRef.role, "researcher")
  })

  it("normalizes a messy card ref to the stable shape", async () => {
    const handle = await createTraceBundle({
      repoRoot,
      agentCardRef: { agentName: "  codex  ", role: null, summary: 42 },
    })
    const bundle = await readTraceBundleSummary({ repoRoot, runId: handle.runId })
    assert.deepEqual(bundle.summary.agentCardRef, {
      agentName: "codex",
      role: "",
      summary: "",
    })
  })

  it("derives envelope fields from lane-style input via buildTaskArtifactEnvelope", async () => {
    const handle = await createTraceBundle({
      repoRoot,
      scenarioId: "reviewer-seeded-defects",
      taskEnvelope: {
        _laneId: "b",
        task: "Review benchmark slice",
        status: "needs-review",
        "active agent": "claude",
        "peer reviewer": "codex",
      },
    })
    const bundle = await readTraceBundleSummary({ repoRoot, runId: handle.runId })
    const envelope = bundle.summary.taskEnvelope
    assert.equal(envelope.laneId, "b", "laneId should derive from _laneId")
    assert.equal(envelope.task, "Review benchmark slice")
    assert.equal(envelope.status, "needs-review")
    assert.equal(envelope.owner, "claude", "owner should derive from 'active agent'")
    assert.equal(envelope.reviewer, "codex", "reviewer should derive from 'peer reviewer'")
  })

  it("normalizes legacy bundles that predate the envelope + card fields on read", async () => {
    const runId = generateTraceRunId()
    const bundleDir = getTraceBundleDir(repoRoot, runId)
    await fs.mkdir(path.join(bundleDir, "events"), { recursive: true })
    await fs.mkdir(path.join(bundleDir, "artifacts"), { recursive: true })
    const legacyRaw = {
      version: TRACE_BUNDLE_VERSION,
      runId,
      scenarioId: "writer-lane-discipline",
      profileId: "default",
      kind: "harness-run",
      startedAt: "2026-04-19T00:00:00.000Z",
      endedAt: "",
      outcome: "",
      failureCategory: "",
      summary: "",
      metrics: {},
      artifactRefs: [],
      context: {},
      // Intentionally no taskEnvelope or agentCardRef — simulates a bundle
      // written by code before this lane.
    }
    await fs.writeFile(
      path.join(bundleDir, "summary.json"),
      `${JSON.stringify(legacyRaw, null, 2)}\n`,
      "utf8",
    )

    const bundle = await readTraceBundleSummary({ repoRoot, runId })
    assert.ok(bundle.summary.taskEnvelope, "taskEnvelope should be present after read")
    assert.equal(bundle.summary.taskEnvelope.task, "")
    assert.equal(bundle.summary.taskEnvelope.laneId, "")
    assert.deepEqual(bundle.summary.taskEnvelope.artifactRefs, [])
    assert.deepEqual(bundle.summary.agentCardRef, {
      agentName: "",
      role: "",
      summary: "",
    })
    // Pre-existing fields must not be stripped by the normalization layer.
    assert.equal(bundle.summary.scenarioId, "writer-lane-discipline")
    assert.equal(bundle.summary.profileId, "default")
  })
})
