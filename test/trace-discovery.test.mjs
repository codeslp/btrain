import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { listTraces, showTrace } from "../src/brain_train/harness/trace-discovery.mjs"
import {
  createTraceBundle,
  finalizeTraceBundle,
} from "../src/brain_train/harness/trace-bundle.mjs"

async function makeTmpRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-trace-discovery-"))
  await fs.mkdir(path.join(root, ".btrain"), { recursive: true })
  return root
}

async function rmRepo(root) {
  await fs.rm(root, { recursive: true, force: true })
}

async function writeEventsJsonl(repoRoot, laneId, events) {
  const dir = path.join(repoRoot, ".btrain", "events")
  await fs.mkdir(dir, { recursive: true })
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  await fs.writeFile(path.join(dir, `lane-${laneId}.jsonl`), body, "utf8")
}

async function writeIndexJsonl(repoRoot, entries) {
  const dir = path.join(repoRoot, ".btrain", "traces")
  await fs.mkdir(dir, { recursive: true })
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  await fs.writeFile(path.join(dir, "index.jsonl"), body, "utf8")
}

describe("listTraces: empty repo", () => {
  let repoRoot
  before(async () => { repoRoot = await makeTmpRepo() })
  after(async () => { await rmRepo(repoRoot) })

  it("returns zero records and the source paths", async () => {
    const result = await listTraces({ repoRoot })
    assert.equal(result.total, 0)
    assert.equal(result.returned, 0)
    assert.deepEqual(result.records, [])
    assert.ok(result.sources.eventsDir.endsWith(".btrain/events"))
    assert.ok(result.sources.harnessRunsDir.endsWith(".btrain/harness/runs"))
    assert.ok(result.sources.tracesIndexPath.endsWith(".btrain/traces/index.jsonl"))
  })

  it("throws a structured error when repoRoot is missing", async () => {
    await assert.rejects(() => listTraces({}), /repoRoot/)
  })
})

describe("listTraces: multi-source merge", () => {
  let repoRoot
  before(async () => {
    repoRoot = await makeTmpRepo()

    // Handoff events — two list-worthy types and one filtered-out type.
    await writeEventsJsonl(repoRoot, "a", [
      {
        version: 1,
        recordedAt: "2026-04-20T10:00:00.000Z",
        type: "claim",
        actor: "claude",
        laneId: "a",
        after: { task: "Trace discovery library", status: "in-progress", lane: "a" },
      },
      {
        version: 1,
        recordedAt: "2026-04-20T11:00:00.000Z",
        type: "lock",
        actor: "claude",
        laneId: "a",
        details: {},
      },
      {
        version: 1,
        recordedAt: "2026-04-20T12:00:00.000Z",
        type: "resolve",
        actor: "codex",
        laneId: "a",
        before: { status: "needs-review" },
        after: { status: "resolved", task: "Trace discovery library", lane: "a" },
      },
    ])

    // Harness bundle.
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "writer-lane-discipline",
      profileId: "default",
      kind: "harness-run",
      startedAt: "2026-04-20T11:30:00.000Z",
    })
    await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "pass",
      summary: "all checks green",
      endedAt: "2026-04-20T11:35:00.000Z",
    })

    // Agentchattr index lines.
    await writeIndexJsonl(repoRoot, [
      {
        ts: "2026-04-20T09:00:00.000Z",
        kind: "agentchattr",
        id: "ac-aaa1",
        event: "routing_decision",
        lane: "",
        agent: "user",
        route: "claude",
        summary: "user @general: human-mentions → claude",
      },
      {
        ts: "2026-04-20T13:00:00.000Z",
        kind: "agentchattr",
        id: "ac-bbb2",
        event: "routing_decision",
        lane: "",
        agent: "claude",
        route: "codex",
        summary: "claude @general: agent-mentions → codex",
      },
    ])
  })
  after(async () => { await rmRepo(repoRoot) })

  it("returns records from all three sources, chronologically descending", async () => {
    const result = await listTraces({ repoRoot })
    assert.equal(result.total, 5, `expected 5 records, got ${result.total}`)
    const timestamps = result.records.map((r) => r.ts)
    const sorted = [...timestamps].sort().reverse()
    assert.deepEqual(timestamps, sorted, "records must be descending by ts")
  })

  it("excludes bulk event types (lock/unlock) from list view", async () => {
    const result = await listTraces({ repoRoot })
    const eventTypes = result.records
      .filter((r) => r.kind === "handoff")
      .map((r) => r.eventType)
    assert.ok(!eventTypes.includes("lock"), "lock events must not appear in list")
  })

  it("filters by kind", async () => {
    const onlyHarness = await listTraces({ repoRoot, kind: "harness" })
    assert.equal(onlyHarness.records.length, 1)
    assert.equal(onlyHarness.records[0].kind, "harness")
    assert.equal(onlyHarness.records[0].outcome, "pass")

    const onlyAgentchattr = await listTraces({ repoRoot, kind: "agentchattr" })
    assert.equal(onlyAgentchattr.records.length, 2)
    for (const r of onlyAgentchattr.records) {
      assert.equal(r.kind, "agentchattr")
    }
  })

  it("filters by lane", async () => {
    const laneA = await listTraces({ repoRoot, lane: "a" })
    assert.ok(laneA.records.every((r) => r.lane === "a"))
    assert.ok(laneA.records.length >= 2, "lane a should include claim + resolve")
  })

  it("filters by since", async () => {
    const recent = await listTraces({ repoRoot, since: "2026-04-20T12:00:00.000Z" })
    assert.ok(recent.records.every((r) => r.ts >= "2026-04-20T12:00:00.000Z"))
    assert.ok(recent.records.length >= 2)
  })

  it("applies limit while reporting total correctly", async () => {
    const limited = await listTraces({ repoRoot, limit: 2 })
    assert.equal(limited.records.length, 2)
    assert.equal(limited.returned, 2)
    assert.equal(limited.total, 5)
  })
})

describe("showTrace: dispatch by id prefix", () => {
  let repoRoot
  let harnessRunId
  before(async () => {
    repoRoot = await makeTmpRepo()
    await writeEventsJsonl(repoRoot, "c", [
      {
        version: 1,
        recordedAt: "2026-04-20T10:00:00.000Z",
        type: "claim",
        actor: "claude",
        laneId: "c",
        after: { task: "Show dispatch test", status: "in-progress", lane: "c" },
      },
    ])
    const bundle = await createTraceBundle({
      repoRoot,
      scenarioId: "show-dispatch",
      kind: "harness-run",
      startedAt: "2026-04-20T11:00:00.000Z",
    })
    harnessRunId = bundle.runId
    await finalizeTraceBundle(bundle.bundleDir, {
      repoRoot,
      outcome: "pass",
      summary: "show dispatch",
      endedAt: "2026-04-20T11:05:00.000Z",
    })
    await writeIndexJsonl(repoRoot, [
      {
        ts: "2026-04-20T12:00:00.000Z",
        kind: "agentchattr",
        id: "ac-show1",
        event: "routing_decision",
        agent: "user",
        route: "claude",
        summary: "dispatch test",
      },
    ])
  })
  after(async () => { await rmRepo(repoRoot) })

  it("resolves a harness id to a bundle summary", async () => {
    const out = await showTrace({ repoRoot, id: harnessRunId })
    assert.equal(out.kind, "harness")
    assert.equal(out.detail.summary.outcome, "pass")
    assert.equal(out.detail.summary.scenarioId, "show-dispatch")
  })

  it("resolves an agentchattr id to its raw index line", async () => {
    const out = await showTrace({ repoRoot, id: "ac-show1" })
    assert.equal(out.kind, "agentchattr")
    assert.equal(out.detail.record.id, "ac-show1")
    assert.equal(out.detail.raw.event, "routing_decision")
  })

  it("resolves a handoff id to the raw event record", async () => {
    // List to discover the generated handoff id, then show it.
    const listed = await listTraces({ repoRoot, kind: "handoff" })
    const hit = listed.records.find((r) => r.eventType === "claim")
    assert.ok(hit, "claim record must be discoverable via list")
    const out = await showTrace({ repoRoot, id: hit.id })
    assert.equal(out.kind, "handoff")
    assert.equal(out.detail.raw.type, "claim")
  })

  it("throws a structured error for an unknown id prefix", async () => {
    await assert.rejects(
      () => showTrace({ repoRoot, id: "xyz-nope" }),
      /Could not dispatch/,
    )
  })

  it("throws a structured error for a missing harness id", async () => {
    await assert.rejects(
      () => showTrace({ repoRoot, id: "run_29991231T000000Z_deadbeef" }),
      /No trace bundle/,
    )
  })

  it("throws a structured error for a missing agentchattr id", async () => {
    await assert.rejects(
      () => showTrace({ repoRoot, id: "ac-notthere" }),
      /No agentchattr trace/,
    )
  })

  it("throws when id is missing", async () => {
    await assert.rejects(() => showTrace({ repoRoot }), /requires a trace id/)
  })
})
