import { createDecisionRun, decideCandidate, validProbabilityVector } from "./decision.mjs"
import { datasetHashFor, sourceSnapshotHashFor, validCodeRevision } from "./manifest.mjs"
import { createHash } from "node:crypto"

const ratio = (numerator, denominator) => denominator ? numerator / denominator : null
// Nearest rank includes the slowest observation in p95 for small samples.
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1] : null

function verifiedCandidate(item, source, candidate) {
  const contentHash = typeof candidate.sourceContent === "string"
    ? createHash("sha256").update(candidate.sourceContent).digest("hex")
    : null
  const sourceMatches = contentHash === source.sourceHash
    && candidate.sourceHash === source.sourceHash
    && (candidate.sourceRef === undefined || candidate.sourceRef === source.sourceRef)
    && Array.isArray(candidate.sourceRefs)
    && candidate.sourceRefs.length === 1
    && candidate.sourceRefs[0] === source.sourceRef
    && (candidate.text === undefined || candidate.text === candidate.sourceContent)
  if (!sourceMatches) throw new Error(`Replay candidate source provenance mismatch: ${item.sourceId}`)
  const inputsMatch = candidate.baseline === item.baseline
    && candidate.eligible === item.eligible
    && candidate.privacyClass === item.privacyClass
    && candidate.callIndex === item.callIndex
  if (!inputsMatch) throw new Error(`Replay candidate evaluation inputs mismatch: ${item.sourceId}`)
  return {
    sourceId: item.sourceId,
    sourceContent: candidate.sourceContent,
    text: candidate.sourceContent,
    sourceRefs: [source.sourceRef],
    baseline: item.baseline,
    eligible: item.eligible,
    privacyClass: item.privacyClass,
    callIndex: item.callIndex,
  }
}

function predictionMetrics(rows, labels, pick, supportRows = rows) {
  const support = Object.fromEntries(labels.map((label) => [label, supportRows.filter((row) => row.label === label).length]))
  const confusion = Object.fromEntries(labels.map((label) => [label, Object.fromEntries(labels.map((predicted) => [predicted, 0]))]))
  const evaluated = rows.filter((row) => labels.includes(pick(row)))
  for (const row of evaluated) confusion[row.label][pick(row)] += 1
  const correct = evaluated.filter((row) => row.label === pick(row)).length
  const perClass = Object.fromEntries(labels.map((label) => {
    const tp = confusion[label][label]
    const predicted = labels.reduce((sum, actual) => sum + confusion[actual][label], 0)
    const actual = support[label]
    const precision = ratio(tp, predicted)
    const recall = ratio(tp, actual)
    return [label, { support: support[label], precision, recall, f1: ratio(2 * tp, actual + predicted) }]
  }))
  return { support, confusion, evaluated: evaluated.length, correct, accuracy: ratio(correct, evaluated.length), perClass }
}

function calibrationMetrics(rows, labels) {
  const complete = rows.filter((row) => validProbabilityVector(row.trace.probabilities, labels))
  const total = complete.reduce((sum, row) => sum + labels.reduce((score, label) => {
    const target = label === row.label ? 1 : 0
    return score + (row.trace.probabilities[label] - target) ** 2
  }, 0), 0)
  return { evaluated: complete.length, multiclassBrier: ratio(total, complete.length) }
}

export function summarizeReplay(rows, labels) {
  if (!Array.isArray(rows) || !Array.isArray(labels) || !labels.length) throw new Error("Replay rows and labels are required")
  const attempted = rows.filter((row) => row.trace.attemptedCall)
  const valid = attempted.filter((row) => ["decision", "abstain"].includes(row.trace.outcome))
  const decisions = rows.filter((row) => row.trace.outcome === "decision")
  const failures = rows.filter((row) => row.trace.outcome === "failure")
  const skipped = rows.filter((row) => row.trace.outcome === "skipped")
  const eligible = rows.filter((row) => row.eligible)
  const latencies = attempted.map((row) => row.trace.latencyMs).filter(Number.isFinite)
  const costs = attempted.map((row) => row.trace.cost).filter(Number.isFinite)
  return {
    counts: { cases: rows.length, eligible: eligible.length, attempted: attempted.length, skipped: skipped.length, validPredictions: valid.length, actionableDecisions: decisions.length, abstentions: rows.filter((row) => row.trace.outcome === "abstain").length, failures: failures.length },
    coverage: { validPrediction: ratio(valid.length, attempted.length), actionable: ratio(decisions.length, eligible.length) },
    baseline: predictionMetrics(rows, labels, (row) => row.baseline),
    model: { ...predictionMetrics(valid, labels, (row) => row.trace.prediction, rows), calibration: calibrationMetrics(valid, labels) },
    failures: failures.map((row) => ({ sourceId: row.sourceId, reason: row.trace.reason, failureClass: row.trace.failureClass })),
    skips: skipped.map((row) => ({ sourceId: row.sourceId, reason: row.trace.reason })),
    abstentions: rows.filter((row) => row.trace.outcome === "abstain").map((row) => ({ sourceId: row.sourceId, reason: row.trace.reason })),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    cost: { observedCalls: costs.length, total: costs.reduce((sum, value) => sum + value, 0) },
  }
}

export async function replayManifest({ manifest, family, candidates, provider }) {
  if (!manifest?.datasetHash || !Array.isArray(manifest.cases) || !Array.isArray(manifest.labels)) throw new Error("Frozen manifest is required")
  if (manifest.sourceSnapshotHash !== sourceSnapshotHashFor(manifest.sources)) throw new Error("Manifest source snapshot hash does not match provenance")
  if (manifest.pins?.policyHash !== family.policyHash) throw new Error("Manifest policy hash does not match family")
  if (manifest.pins?.family !== family.id || manifest.pins?.questionVersion !== family.questionVersion) throw new Error("Manifest family version does not match")
  if (!manifest.pins?.model || !manifest.pins?.codeRevision) throw new Error("Manifest model and code revision pins are required")
  if (!validCodeRevision(manifest.pins.codeRevision)) throw new Error("Invalid code revision pin")
  const evaluation = family.policyConfig?.evaluation
  if (!evaluation?.baselineId || manifest.pins.baseline !== evaluation.baselineId) throw new Error("Manifest evaluation baseline pin does not match family")
  const expectedThresholds = evaluation.thresholds
  const pinnedThresholds = manifest.pins.thresholds
  if (!expectedThresholds || !pinnedThresholds
    || Object.keys(expectedThresholds).length !== Object.keys(pinnedThresholds).length
    || Object.entries(expectedThresholds).some(([choice, value]) => !family.choices.includes(choice)
      || value !== family.threshold || pinnedThresholds[choice] !== value)) {
    throw new Error("Manifest evaluation threshold pins do not match family")
  }
  if (manifest.labels.length !== family.choices.length || new Set(manifest.labels).size !== family.choices.length
    || manifest.labels.some((label) => !family.choices.includes(label))) throw new Error("Manifest label catalog does not match family choices")
  if (manifest.datasetHash !== datasetHashFor(manifest.cases, manifest.labels, manifest.sourceSnapshotHash, manifest.pins)) throw new Error("Manifest dataset hash does not match frozen cases and pins")
  const sources = new Map(manifest.sources.map((source) => [source.id, source]))
  for (const item of manifest.cases) {
    const source = sources.get(item.sourceId)
    if (!source || (item.sourceHash && item.sourceHash !== source.sourceHash)) throw new Error(`Case source provenance mismatch: ${item.sourceId}`)
  }
  const rows = []
  for (const item of manifest.cases) {
    const candidate = candidates[item.sourceId]
    if (!candidate) throw new Error(`Missing replay candidate: ${item.sourceId}`)
    const source = sources.get(item.sourceId)
    const trace = await decideCandidate({ family, candidate: verifiedCandidate(item, source, candidate), provider, mode: "offline", modelPin: manifest.pins.model, codeRevision: manifest.pins.codeRevision, run: createDecisionRun(family) })
    rows.push({ sourceId: item.sourceId, split: item.split, label: item.label, baseline: trace.baseline, eligible: item.eligible, privacyClass: item.privacyClass, trace })
  }
  const splits = {}
  const syntheticControls = {}
  for (const split of ["train", "calibration", "test", "all"]) {
    const selected = split === "all" ? rows : rows.filter((row) => row.split === split)
    splits[split] = summarizeReplay(selected.filter((row) => row.privacyClass !== "synthetic"), manifest.labels)
    syntheticControls[split] = summarizeReplay(selected.filter((row) => row.privacyClass === "synthetic"), manifest.labels)
  }
  return { schemaVersion: 1, datasetHash: manifest.datasetHash, pins: manifest.pins, splits, syntheticControls, rows }
}
