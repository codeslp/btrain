import fs from "node:fs/promises"
import path from "node:path"

import { readTraceBundleSummary } from "./trace-bundle.mjs"

// ---------------------------------------------------------------------------
// Unified trace discovery — aggregates decision records across the scattered
// btrain sources (handoff events, harness bundles, agentchattr traces) into a
// single list/show surface. Read-only; no writes, no migration. See spec 013.
// ---------------------------------------------------------------------------

export const TRACE_DISCOVERY_VERSION = 1

const HANDOFF_LIST_TYPES = new Set(["claim", "update", "resolve"])

class BtrainError extends Error {
  constructor({ message, reason, fix, context }) {
    const parts = [`✖ ${message}`]
    if (reason) parts.push(`  ↳ Why: ${reason}`)
    if (fix) parts.push(`  ✦ Fix: ${fix}`)
    if (context) parts.push(`  ℹ ${context}`)
    super(parts.join("\n"))
    this.name = "BtrainError"
  }
}

function getPaths(repoRoot) {
  if (!repoRoot) {
    throw new BtrainError({
      message: "Trace discovery requires a repoRoot.",
      reason: "No repoRoot was provided.",
      fix: "Pass { repoRoot } pointing at the target btrain repo root.",
    })
  }
  const root = path.join(repoRoot, ".btrain")
  return {
    repoRoot,
    eventsDir: path.join(root, "events"),
    harnessRunsDir: path.join(root, "harness", "runs"),
    tracesDir: path.join(root, "traces"),
    tracesIndexPath: path.join(root, "traces", "index.jsonl"),
  }
}

async function readJsonlLines(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (err) {
    if (err.code === "ENOENT") return []
    throw err
  }
}

async function readDirSafe(dirPath, { withFileTypes = false } = {}) {
  try {
    return await fs.readdir(dirPath, { withFileTypes })
  } catch (err) {
    if (err.code === "ENOENT") return []
    throw err
  }
}

function summarizeHandoffEvent(event) {
  const before = event.before || {}
  const after = event.after || {}
  const lane = event.laneId || before.lane || after.lane || ""
  const actor = event.actor || ""
  const type = event.type || "event"
  const rawTask = after.task || before.task || ""
  const task = typeof rawTask === "string" ? rawTask : ""
  const taskSnippet = task ? task.slice(0, 80) : ""
  switch (type) {
    case "claim":
      return taskSnippet ? `claim lane ${lane} — ${taskSnippet}` : `claim lane ${lane}`
    case "update": {
      const fromStatus = before.status || ""
      const toStatus = after.status || ""
      if (fromStatus && toStatus && fromStatus !== toStatus) {
        return `${fromStatus} → ${toStatus} on lane ${lane}`
      }
      return `update lane ${lane}${taskSnippet ? ` — ${taskSnippet}` : ""}`
    }
    case "resolve":
      return `resolve lane ${lane}${actor ? ` by ${actor}` : ""}`
    default:
      return `${type} on lane ${lane}`
  }
}

function buildHandoffRecord(event, sourcePath, lineIndex) {
  const lane = event.laneId || (event.after && event.after.lane) || (event.before && event.before.lane) || ""
  const after = event.after || {}
  const stamp = event.recordedAt || ""
  const stampSafe = stamp ? stamp.replace(/[:.]/g, "-") : `line-${lineIndex}`
  return {
    kind: "handoff",
    id: lane ? `lane-${lane}-${stampSafe}` : `event-${stampSafe}`,
    lane: lane || "",
    actor: event.actor || "",
    ts: stamp,
    outcome: after.status || "",
    summary: summarizeHandoffEvent(event),
    sourcePath,
    sourceLine: lineIndex,
    eventType: event.type || "",
  }
}

async function listHandoffRecords(paths) {
  const entries = await readDirSafe(paths.eventsDir, { withFileTypes: true })
  const records = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    const filePath = path.join(paths.eventsDir, entry.name)
    const lines = await readJsonlLines(filePath)
    lines.forEach((event, idx) => {
      const type = event && event.type
      if (!HANDOFF_LIST_TYPES.has(type)) return
      records.push(buildHandoffRecord(event, filePath, idx))
    })
  }
  return records
}

async function listHarnessRecords(paths) {
  const entries = await readDirSafe(paths.harnessRunsDir, { withFileTypes: true })
  const records = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const summaryPath = path.join(paths.harnessRunsDir, entry.name, "summary.json")
    try {
      const raw = await fs.readFile(summaryPath, "utf8")
      const summary = JSON.parse(raw)
      const taskEnv = summary.taskEnvelope || {}
      const card = summary.agentCardRef || {}
      records.push({
        kind: "harness",
        id: summary.runId || entry.name,
        lane: taskEnv.laneId || "",
        actor: card.agentName || taskEnv.actor || "",
        ts: summary.endedAt || summary.startedAt || "",
        outcome: summary.outcome || "",
        summary: summary.summary || `${summary.kind || "harness-run"} ${summary.scenarioId || ""}`.trim(),
        sourcePath: summaryPath,
        scenarioId: summary.scenarioId || "",
        profileId: summary.profileId || "",
      })
    } catch (err) {
      if (err.code !== "ENOENT") throw err
    }
  }
  return records
}

async function listAgentchattrRecords(paths) {
  const lines = await readJsonlLines(paths.tracesIndexPath)
  return lines
    .filter((line) => line && typeof line === "object" && line.kind === "agentchattr")
    .map((line, idx) => ({
      kind: "agentchattr",
      id: line.id || `ac-${(line.ts || "").replace(/[:.]/g, "-") || `line-${idx}`}`,
      lane: line.lane || "",
      actor: line.agent || "",
      ts: line.ts || "",
      outcome: line.outcome || "",
      summary: line.summary || `${line.event || "event"}${line.route ? ` → ${line.route}` : ""}`,
      sourcePath: paths.tracesIndexPath,
      sourceLine: idx,
      event: line.event || "",
    }))
}

function sortRecordsDesc(records) {
  return records.sort((a, b) => {
    const ta = a.ts || ""
    const tb = b.ts || ""
    if (tb === ta) return (b.id || "").localeCompare(a.id || "")
    return tb.localeCompare(ta)
  })
}

export async function listTraces({ repoRoot, kind, lane, since, limit } = {}) {
  const paths = getPaths(repoRoot)
  const [handoff, harness, agentchattr] = await Promise.all([
    listHandoffRecords(paths),
    listHarnessRecords(paths),
    listAgentchattrRecords(paths),
  ])
  let records = [...handoff, ...harness, ...agentchattr]

  if (kind) {
    const kinds = Array.isArray(kind) ? new Set(kind) : new Set([kind])
    records = records.filter((r) => kinds.has(r.kind))
  }
  if (lane) {
    records = records.filter((r) => r.lane === lane)
  }
  if (since) {
    records = records.filter((r) => r.ts && r.ts >= since)
  }

  records = sortRecordsDesc(records)

  const total = records.length
  const bounded = typeof limit === "number" && limit > 0 ? records.slice(0, limit) : records

  return {
    repoRoot,
    total,
    returned: bounded.length,
    records: bounded,
    sources: {
      eventsDir: paths.eventsDir,
      harnessRunsDir: paths.harnessRunsDir,
      tracesIndexPath: paths.tracesIndexPath,
    },
  }
}

function dispatchShowKind(id) {
  if (!id || typeof id !== "string") return "unknown"
  if (id.startsWith("run_")) return "harness"
  if (id.startsWith("ac-")) return "agentchattr"
  if (id.startsWith("lane-") || id.startsWith("event-")) return "handoff"
  return "unknown"
}

export async function showTrace({ repoRoot, id } = {}) {
  if (!id) {
    throw new BtrainError({
      message: "showTrace requires a trace id.",
      reason: "No id was provided.",
      fix: "Pass { repoRoot, id } where id comes from listTraces().records[].id.",
    })
  }
  const paths = getPaths(repoRoot)
  const kind = dispatchShowKind(id)

  if (kind === "harness") {
    return { kind, detail: await readTraceBundleSummary({ repoRoot, runId: id }) }
  }

  if (kind === "handoff") {
    const all = await listHandoffRecords(paths)
    const match = all.find((r) => r.id === id)
    if (!match) {
      throw new BtrainError({
        message: `No handoff trace found for id "${id}".`,
        reason: `Looked in ${paths.eventsDir}.`,
        fix: "Run listTraces({ kind: 'handoff' }) to see available ids.",
      })
    }
    const rawLines = await readJsonlLines(match.sourcePath)
    const raw = rawLines[match.sourceLine] || null
    return { kind, detail: { record: match, raw } }
  }

  if (kind === "agentchattr") {
    const all = await listAgentchattrRecords(paths)
    const match = all.find((r) => r.id === id)
    if (!match) {
      throw new BtrainError({
        message: `No agentchattr trace found for id "${id}".`,
        reason: `Looked in ${paths.tracesIndexPath}.`,
        fix: "Run listTraces({ kind: 'agentchattr' }) to see available ids.",
      })
    }
    const rawLines = await readJsonlLines(match.sourcePath)
    const raw = rawLines[match.sourceLine] || null
    return { kind, detail: { record: match, raw } }
  }

  throw new BtrainError({
    message: `Could not dispatch trace id "${id}".`,
    reason: "Id did not match any known trace kind prefix.",
    fix: "Ids start with run_ (harness), lane- or event- (handoff), or ac- (agentchattr).",
  })
}
