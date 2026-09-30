import { createHash } from "node:crypto"
import { sourceSnapshotHashFor } from "./manifest.mjs"

export function validRecordRef(value) {
  if (!boundedString(value)) return false
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

export function boundedString(value, maxBytes = 4096) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes
}

export function stringList(value, maxItems = 32) {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((entry) => boundedString(entry, 128)) && new Set(value).size === value.length
}

// Parse a serialized snapshot once; never use caller-owned record or proof objects after an await.
export function readFrozenRecord({ source, sourceProof, mode }) {
  if (!["off", "offline"].includes(mode)) throw new Error("Only off or offline records are supported")
  if (!boundedString(source?.id, 256) || !validRecordRef(source?.sourceRef)
    || !boundedString(source?.content, 128 * 1024)) throw new Error("A bounded serialized source record is required")
  const candidateSource = { sourceId: source.id, sourceContent: source.content, sourceRefs: [source.sourceRef] }
  let proof = null
  if (mode === "offline") {
    const supplied = sourceProof?.sources?.[0]
    if (!Array.isArray(sourceProof?.sources) || sourceProof.sources.length !== 1
      || supplied?.id !== source.id || supplied?.sourceRef !== source.sourceRef
      || supplied.sourceHash !== createHash("sha256").update(source.content).digest("hex")) {
      throw new Error("A matching frozen source proof is required")
    }
    const sources = [{ id: supplied.id, sourceRef: supplied.sourceRef, sourceHash: supplied.sourceHash }]
    const sourceSnapshotHash = sourceSnapshotHashFor(sources)
    if (sourceSnapshotHash !== sourceProof.sourceSnapshotHash) throw new Error("A matching frozen source proof is required")
    proof = { sources, sourceSnapshotHash }
  }
  let record
  try { record = JSON.parse(candidateSource.sourceContent) } catch { throw new Error("Source record must be JSON") }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Source record must be an object")
  return { record, candidateSource, proof }
}

export const frozenRecordRules = [validRecordRef, boundedString, stringList, readFrozenRecord]
  .map((rule) => rule.toString()).join("\n")
