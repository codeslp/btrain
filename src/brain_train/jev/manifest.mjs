import { createHash } from "node:crypto"

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const splits = new Set(["train", "calibration", "test"])
const eventHeadSha = /^[a-f0-9]{40}$/i
export const validCodeRevision = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
const sourceFields = ["id", "repository", "prNumber", "laneId", "eventId", "sourceRef", "sourceHash", "templateGroup", "surface", "author", "eventAt", "updatedAt", "capturedAt", "reviewedCommit", "eventHead", "captureHead", "captureHeadObservedAt", "formalState", "deterministicDisposition"]

function canonicalSources(sources) {
  if (!Array.isArray(sources)) throw new Error("Source snapshots are required")
  const records = sources.map((source) => Object.fromEntries(sourceFields.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]])))
  records.sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(records.map((source) => source.id)).size !== records.length) throw new Error("Duplicate source IDs")
  return records
}

function completeSourceProvenance(source) {
  const text = (value) => typeof value === "string" && value.trim().length > 0
  const timestamp = (value) => text(value) && Number.isFinite(Date.parse(value))
  let ref
  try { ref = new URL(source?.sourceRef) } catch { return false }
  if (!source || !text(source.sourceRef) || !["https:", "http:"].includes(ref.protocol) || ref.username || ref.password || ref.search || ref.hash
    || !text(source.id) || !text(source.repository) || !/^[^/\s]+\/[^/\s]+$/.test(source.repository)
    || !Number.isSafeInteger(source.prNumber) || source.prNumber < 1
    || !text(source.eventId) || !["issue", "review", "inline"].includes(source.surface) || !text(source.author)
    || typeof source.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceHash)
    || !text(source.templateGroup) || !timestamp(source.eventAt) || !timestamp(source.capturedAt)
    || Date.parse(source.eventAt) > Date.parse(source.capturedAt)
    || (source.updatedAt != null && (!timestamp(source.updatedAt) || Date.parse(source.updatedAt) < Date.parse(source.eventAt)
      || Date.parse(source.updatedAt) > Date.parse(source.capturedAt)))
    || (source.eventHead !== "unknown" && (typeof source.eventHead !== "string" || !eventHeadSha.test(source.eventHead)))
    || !Object.hasOwn(source, "formalState") || (source.formalState !== null && !text(source.formalState))
    || !text(source.deterministicDisposition)
    || (source.reviewedCommit != null && (typeof source.reviewedCommit !== "string" || !/^[a-f0-9]{7,40}$/i.test(source.reviewedCommit)))
    || (source.captureHead != null && (typeof source.captureHead !== "string" || !eventHeadSha.test(source.captureHead)
      || !timestamp(source.captureHeadObservedAt) || Date.parse(source.captureHeadObservedAt) > Date.parse(source.capturedAt)
      || Date.parse(source.captureHeadObservedAt) < Date.parse(source.updatedAt ?? source.eventAt)))
    || (source.captureHead == null && source.captureHeadObservedAt != null)) return false
  return true
}

export function validateCaseGroups(cases, sources) {
  if (!Array.isArray(cases) || !cases.length || !Array.isArray(sources)) throw new Error("Sources and nonempty cases are required")
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  if (sourceById.size !== sources.length) throw new Error("Duplicate source IDs")
  const sourceIds = new Set()
  const prSplits = new Map()
  const templateSplits = new Map()
  for (const item of cases) {
    const source = sourceById.get(item?.sourceId)
    if (!source) throw new Error(`Unknown source: ${item?.sourceId}`)
    if (sourceIds.has(item.sourceId)) throw new Error(`Duplicate case source: ${item.sourceId}`)
    sourceIds.add(item.sourceId)
    if (typeof item.repository !== "string" || !item.repository || !Number.isSafeInteger(item.prNumber) || item.prNumber < 1
      || source.repository !== item.repository || source.prNumber !== item.prNumber) throw new Error("Case source identity mismatch")
    if (typeof item.templateGroup !== "string" || !item.templateGroup) throw new Error("Template group is required")
    if (typeof source.templateGroup !== "string" || !source.templateGroup) throw new Error("A captured template group is required")
    if (source.templateGroup !== item.templateGroup) throw new Error("Case template group mismatch")
    if (!completeSourceProvenance(source)) throw new Error("Incomplete or invalid source provenance")
    if (!splits.has(item.split)) throw new Error("Invalid split")
    if (typeof item.eligible !== "boolean" || !["public", "synthetic", "private"].includes(item.privacyClass)
      || !Number.isSafeInteger(item.callIndex) || item.callIndex < 0) throw new Error("Case evaluation inputs are required")
    const prGroup = JSON.stringify([item.repository, item.prNumber])
    for (const [groups, group, name] of [[prSplits, prGroup, "PR"], [templateSplits, item.templateGroup, "Template"]]) {
      if (groups.has(group) && groups.get(group) !== item.split) throw new Error(`${name} group crosses splits`)
      groups.set(group, item.split)
    }
  }
  return sourceById
}

export function sourceSnapshotHashFor(sources) {
  return hash(canonicalSources(sources))
}

export function evaluationPinsFor(pins) {
  const fields = ["family", "questionVersion", "policyHash", "model", "codeRevision", "baseline", "thresholds"]
  if (!pins || Object.keys(pins).some((key) => !fields.includes(key))) throw new Error("Invalid evaluation pins")
  for (const key of fields.slice(0, -1)) {
    if (typeof pins[key] !== "string" || !pins[key]) throw new Error(`Missing evaluation pin: ${key}`)
  }
  if (!validCodeRevision(pins.codeRevision)) throw new Error("Invalid code revision pin")
  const thresholds = pins.thresholds
  if (!thresholds || Object.getPrototypeOf(thresholds) !== Object.prototype || !Object.keys(thresholds).length
    || Object.entries(thresholds).some(([key, value]) => !key || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Invalid threshold pins")
  }
  return { family: pins.family, questionVersion: pins.questionVersion, policyHash: pins.policyHash,
    model: pins.model, codeRevision: pins.codeRevision, baseline: pins.baseline,
    thresholds: Object.fromEntries(Object.entries(thresholds).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }
}

export function datasetHashFor(cases, labels, sourceSnapshotHash, pins) {
  if (!sourceSnapshotHash) throw new Error("Source snapshot hash is required")
  return hash({ cases: [...cases].sort((a, b) => a.sourceId.localeCompare(b.sourceId)), labels, sourceSnapshotHash, pins: evaluationPinsFor(pins) })
}

export function annotationCandidates(sources, { requireEventHead = false } = {}) {
  const eligible = []
  const excluded = []
  for (const source of sources) {
    if (requireEventHead && !eventHeadSha.test(source.eventHead || "")) {
      const reason = !source.eventHead || source.eventHead === "unknown" ? "unknown-event-head" : "invalid-event-head"
      excluded.push({ sourceId: source.id, reason })
      continue
    }
    if (!completeSourceProvenance(source)) {
      excluded.push({ sourceId: source.id || null, reason: "incomplete-provenance" })
      continue
    }
    eligible.push({ sourceId: source.id, sourceRef: source.sourceRef, repository: source.repository, prNumber: source.prNumber, surface: source.surface, author: source.author, sourceHash: source.sourceHash, templateGroup: source.templateGroup })
  }
  return { eligible, excluded }
}

export function freezeLabeledManifest({ sources, cases, pins, labels, requireEventHead = false }) {
  if (!Array.isArray(sources) || !Array.isArray(cases) || !cases.length) throw new Error("Sources and nonempty cases are required")
  if (!Array.isArray(labels) || !labels.length || new Set(labels).size !== labels.length) throw new Error("A closed label set is required")
  const frozenPins = evaluationPinsFor(pins)
  const sourceById = validateCaseGroups(cases, sources)
  const sourceIds = new Set()
  const frozenCases = []
  for (const item of cases) {
    const source = sourceById.get(item.sourceId)
    sourceIds.add(item.sourceId)
    if (requireEventHead && !eventHeadSha.test(source.eventHead || "")) throw new Error("Invalid event-time head cannot enter exact-head evaluation")
    if (!source.sourceHash || !source.sourceRef || !source.repository) throw new Error("Incomplete source provenance")
    if (!labels.includes(item.label)) throw new Error("Out-of-catalog label")
    if (!labels.includes(item.baseline)) throw new Error("Baseline is outside the label catalog")
    if (!Array.isArray(item.annotations) || item.annotations.length < 2 || new Set(item.annotations.map((a) => a.by)).size < 2) throw new Error("Two independent annotators are required")
    if (item.annotations.some((a) => !a.by || !labels.includes(a.label))) throw new Error("Invalid annotation")
    if (!item.adjudication?.by || item.adjudication.label !== item.label || !item.adjudication.reason) throw new Error("Explicit adjudication is required")
    frozenCases.push({ sourceId: item.sourceId, repository: item.repository, prNumber: item.prNumber, templateGroup: item.templateGroup, split: item.split, label: item.label, baseline: item.baseline, eligible: item.eligible, privacyClass: item.privacyClass, callIndex: item.callIndex, annotations: item.annotations.map((a) => ({ by: a.by, label: a.label })), adjudication: { by: item.adjudication.by, label: item.adjudication.label, reason: item.adjudication.reason }, sourceHash: source.sourceHash })
  }
  frozenCases.sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  const selectedSources = canonicalSources([...sourceIds].map((id) => {
    const s = sourceById.get(id)
    return { id, repository: s.repository, prNumber: s.prNumber, laneId: s.laneId, eventId: s.eventId, sourceRef: s.sourceRef, sourceHash: s.sourceHash, templateGroup: s.templateGroup, surface: s.surface, author: s.author, eventAt: s.eventAt, updatedAt: s.updatedAt, capturedAt: s.capturedAt, reviewedCommit: s.reviewedCommit, eventHead: s.eventHead || "unknown", captureHead: s.captureHead, captureHeadObservedAt: s.captureHeadObservedAt, formalState: s.formalState, deterministicDisposition: s.deterministicDisposition }
  }))
  const sourceSnapshotHash = sourceSnapshotHashFor(selectedSources)
  const datasetHash = datasetHashFor(frozenCases, labels, sourceSnapshotHash, frozenPins)
  return { schemaVersion: 1, pins: frozenPins, labels: [...labels], sourceSnapshotHash, datasetHash, sources: selectedSources, cases: frozenCases }
}
