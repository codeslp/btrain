import { createHash, randomUUID } from "node:crypto"
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
const snapshotFilesDir = (root) => path.join(evidenceDir(root), "source-snapshots")
const outcomesPath = (root) => path.join(evidenceDir(root), "source-outcomes.jsonl")

function reviewedCommitFor(comment) {
  if (comment.surface !== "issue") return SHA.test(comment.reviewedCommit || "") ? comment.reviewedCommit : null
  if (!comment.updatedAt || Date.parse(comment.updatedAt) !== Date.parse(comment.at)) return null
  const match = /reviewed commit:\s*(?:\*\*)?\s*`?([a-f0-9]{10,40})(?![a-f0-9])/i.exec(String(comment.body || ""))
  return match?.[1] || null
}

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

async function readSourceSnapshots(root) {
  const legacy = await readJsonl(snapshotsPath(root))
  let names
  try { names = await fs.readdir(snapshotFilesDir(root)) } catch (error) {
    if (error.code !== "ENOENT") throw error
    names = []
  }
  const snapshots = [...legacy]
  const seen = new Set(legacy.map((row) => row.id))
  for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    const snapshot = JSON.parse(await fs.readFile(path.join(snapshotFilesDir(root), name), "utf8"))
    if (snapshot.id !== name.slice(0, -5)) throw new Error("Source snapshot ID does not match its file")
    if (!seen.has(snapshot.id)) snapshots.push(snapshot)
    seen.add(snapshot.id)
  }
  return snapshots
}

export function createSourceSnapshot({ repository, prNumber, laneId, comment, capturedAt, captureHead = null, captureHeadObservedAt = null, deterministicDisposition = "not-evaluated" }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository || "")) throw new Error("Source repository is required")
  if (!/^[1-9]\d*$/.test(String(prNumber))) throw new Error("A positive PR number is required")
  if (!comment?.surface || comment.id === undefined || !comment.author || !comment.at || !comment.url) throw new Error("Comment identity and source URL are required")
  if (!Number.isFinite(Date.parse(comment.at)) || !Number.isFinite(Date.parse(capturedAt))) throw new Error("Event and capture timestamps must be valid")
  if (captureHead !== null && !SHA.test(captureHead)) throw new Error("Capture head must be a commit SHA")
  const sourceRef = safeSourceRef(comment.url)
  const sourceKey = `${new URL(sourceRef).host}/${repository}/pull/${prNumber}/${comment.surface}/${comment.id}`
  const sourceHash = hash(String(comment.body || ""))
  return {
    schemaVersion: 3,
    id: hash(JSON.stringify([sourceKey, comment.updatedAt || comment.at, sourceHash])),
    repository,
    prNumber: Number(prNumber),
    laneId: String(laneId),
    surface: comment.surface,
    eventId: String(comment.id),
    sourceRef,
    author: comment.author,
    eventAt: comment.at,
    updatedAt: comment.updatedAt || null,
    capturedAt,
    reviewedCommit: reviewedCommitFor(comment),
    // Polling observes a later head. Only an event-time witness may populate eventHead.
    eventHead: "unknown",
    captureHead,
    captureHeadObservedAt: captureHead ? (captureHeadObservedAt || capturedAt) : null,
    formalState: comment.state || null,
    deterministicDisposition,
    sourceHash,
    templateGroup: hash(templateText(comment.body)),
  }
}

export async function appendSourceSnapshots(root, snapshots) {
  const captured = await readSourceSnapshots(root)
  const existing = new Set(captured.map((row) => row.id))
  const versionKey = (row) => JSON.stringify([new URL(row.sourceRef).host, row.repository, row.prNumber, row.surface, row.eventId,
    row.updatedAt || row.eventAt, row.sourceHash])
  const legacyVersions = new Set(captured.filter((row) => [1, 2].includes(row.schemaVersion)).map(versionKey))
  await fs.mkdir(snapshotFilesDir(root), { recursive: true })
  let fresh = 0
  for (const snapshot of snapshots) {
    if (!/^[a-f0-9]{64}$/.test(snapshot?.id || "")) throw new Error("Source snapshot ID is required")
    if (existing.has(snapshot.id) || legacyVersions.has(versionKey(snapshot))) continue
    existing.add(snapshot.id)
    const temporary = path.join(snapshotFilesDir(root), `.${randomUUID()}.tmp`)
    const target = path.join(snapshotFilesDir(root), `${snapshot.id}.json`)
    try {
      await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { flag: "wx" })
      try { await fs.link(temporary, target); fresh += 1 } catch (error) {
        if (error.code !== "EEXIST") throw error
      }
    } finally {
      await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error })
    }
  }
  return fresh
}

export async function appendSourceOutcome(root, { sourceId, outcome, observedAt, evidenceRef }) {
  if (!/^[a-f0-9]{64}$/.test(sourceId || "")) throw new Error("Source ID is required")
  if (!outcome || !evidenceRef || !Number.isFinite(Date.parse(observedAt))) throw new Error("Outcome, observation time, and evidence reference are required")
  const safeEvidenceRef = safeSourceRef(evidenceRef)
  const known = (await readSourceSnapshots(root)).some((row) => row.id === sourceId)
  if (!known) throw new Error("Outcome source is unknown")
  await appendJsonl(outcomesPath(root), [{ schemaVersion: 1, sourceId, outcome, observedAt, evidenceRef: safeEvidenceRef }])
}

export async function readEvidence(root) {
  const snapshots = await readSourceSnapshots(root)
  const laterOutcomes = await readJsonl(outcomesPath(root))
  const pending = snapshots.map((row) => ({ schemaVersion: 1, sourceId: row.id, outcome: "pending", observedAt: row.capturedAt, evidenceRef: row.sourceRef }))
  return { snapshots, outcomes: [...pending, ...laterOutcomes] }
}
