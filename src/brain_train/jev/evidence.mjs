import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const SHA = /^[a-f0-9]{40}$/i
const hash = (value) => createHash("sha256").update(value).digest("hex")
const templateText = (value) => String(value || "")
  .replace(/<!--\s*btrain-pr-review\b[\s\S]*?-->/gi, "")
  .replace(/\b[a-f0-9]{7,40}\b/gi, "<commit>")
  .replace(/https?:\/\/[^\s)]+/g, "<url>")
  .replace(/\s+/g, " ")
  .trim()
function safeSourceRef(value) {
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Source reference must be an HTTP URL")
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.toString()
}
const evidenceDir = (root) => path.join(root, ".btrain", "jev", "evidence")
const snapshotsPath = (root) => path.join(evidenceDir(root), "source-snapshots.jsonl")
const outcomesPath = (root) => path.join(evidenceDir(root), "source-outcomes.jsonl")

async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, "utf8")
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

async function appendJsonl(file, rows) {
  if (!rows.length) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")
}

export function createSourceSnapshot({ repository, prNumber, laneId, comment, capturedAt, captureHead = null, captureHeadObservedAt = null, deterministicDisposition = "not-evaluated" }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository || "")) throw new Error("Source repository is required")
  if (!/^[1-9]\d*$/.test(String(prNumber))) throw new Error("A positive PR number is required")
  if (!comment?.surface || comment.id === undefined || !comment.author || !comment.at || !comment.url) throw new Error("Comment identity and source URL are required")
  if (!Number.isFinite(Date.parse(comment.at)) || !Number.isFinite(Date.parse(capturedAt))) throw new Error("Event and capture timestamps must be valid")
  if (captureHead !== null && !SHA.test(captureHead)) throw new Error("Capture head must be a commit SHA")
  const sourceKey = `${repository}/pull/${prNumber}/${comment.surface}/${comment.id}`
  return {
    schemaVersion: 1,
    id: hash(sourceKey),
    repository,
    prNumber: Number(prNumber),
    laneId: String(laneId),
    surface: comment.surface,
    eventId: String(comment.id),
    sourceRef: safeSourceRef(comment.url),
    author: comment.author,
    eventAt: comment.at,
    capturedAt,
    reviewedCommit: SHA.test(comment.reviewedCommit || "") ? comment.reviewedCommit : null,
    // Polling observes a later head. Only an event-time witness may populate eventHead.
    eventHead: "unknown",
    captureHead,
    captureHeadObservedAt: captureHead ? (captureHeadObservedAt || capturedAt) : null,
    formalState: comment.state || null,
    deterministicDisposition,
    sourceHash: hash(String(comment.body || "")),
    templateGroup: hash(templateText(comment.body)),
  }
}

export async function appendSourceSnapshots(root, snapshots) {
  const existing = new Set((await readJsonl(snapshotsPath(root))).map((row) => row.id))
  const fresh = []
  for (const snapshot of snapshots) {
    if (existing.has(snapshot.id)) continue
    existing.add(snapshot.id)
    fresh.push(snapshot)
  }
  await appendJsonl(snapshotsPath(root), fresh)
  return fresh.length
}

export async function appendSourceOutcome(root, { sourceId, outcome, observedAt, evidenceRef }) {
  if (!/^[a-f0-9]{64}$/.test(sourceId || "")) throw new Error("Source ID is required")
  if (!outcome || !evidenceRef || !Number.isFinite(Date.parse(observedAt))) throw new Error("Outcome, observation time, and evidence reference are required")
  const known = (await readJsonl(snapshotsPath(root))).some((row) => row.id === sourceId)
  if (!known) throw new Error("Outcome source is unknown")
  await appendJsonl(outcomesPath(root), [{ schemaVersion: 1, sourceId, outcome, observedAt, evidenceRef }])
}

export async function readEvidence(root) {
  const snapshots = await readJsonl(snapshotsPath(root))
  const laterOutcomes = await readJsonl(outcomesPath(root))
  const pending = snapshots.map((row) => ({ schemaVersion: 1, sourceId: row.id, outcome: "pending", observedAt: row.capturedAt, evidenceRef: row.sourceRef }))
  return { snapshots, outcomes: [...pending, ...laterOutcomes] }
}
