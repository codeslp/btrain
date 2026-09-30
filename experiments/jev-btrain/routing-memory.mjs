import { boundedString, stringList, validRecordRef } from "../../src/brain_train/jev/frozen-record.mjs"

const kinds = ["task", "lane", "reviewer", "runner", "skill"]
const origins = ["real", "synthetic", "unknown"]

function validateCases(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error("Nonempty paired cases are required")
  const ids = new Set()
  for (const pair of pairs) {
    if (!boundedString(pair?.id, 128) || ids.has(pair.id) || !origins.includes(pair.origin)
      || (pair.origin === "real" && (!validRecordRef(pair.sourceRef) || typeof pair.sourceSnapshotHash !== "string"
        || !/^[a-f0-9]{64}$/.test(pair.sourceSnapshotHash)))) {
      throw new Error("Every pair needs a unique ID, known origin and source proof for real cases")
    }
    ids.add(pair.id)
  }
}

function rate(count, total) {
  return total ? count / total : null
}

function routingMetrics(pairs) {
  const baselineSuccesses = pairs.filter((pair) => pair.baselineSucceeded).length
  const suggestedSuccesses = pairs.filter((pair) => pair.suggestedSucceeded).length
  return {
    cases: pairs.length,
    baselineSuccessRate: rate(baselineSuccesses, pairs.length),
    suggestedSuccessRate: rate(suggestedSuccesses, pairs.length),
    successDifferencePercentagePoints: pairs.length ? 100 * (suggestedSuccesses - baselineSuccesses) / pairs.length : null,
    ineligibleRoutes: pairs.filter((pair) => pair.suggestedId !== null && !pair.eligibleIds.includes(pair.suggestedId)).length,
  }
}

function confusion(pairs, field) {
  const truePositive = pairs.filter((pair) => pair.superseded && pair[field]).length
  const falsePositive = pairs.filter((pair) => !pair.superseded && pair[field]).length
  const falseNegative = pairs.filter((pair) => pair.superseded && !pair[field]).length
  const trueNegative = pairs.filter((pair) => !pair.superseded && !pair[field]).length
  return { truePositive, falsePositive, falseNegative, trueNegative,
    precision: rate(truePositive, truePositive + falsePositive), recall: rate(truePositive, truePositive + falseNegative) }
}

function memoryMetrics(pairs) {
  return { cases: pairs.length, supersededClaims: pairs.filter((pair) => pair.superseded).length,
    semantic: confusion(pairs, "warned"), age: confusion(pairs, "ageBaselineStale") }
}

// These are paired measurements, not a frozen benchmark or a promotion decision.
export function evaluateRoutingPairs(kind, pairs) {
  if (!kinds.includes(kind)) throw new Error("A catalog routing kind is required")
  validateCases(pairs)
  for (const pair of pairs) {
    if (pair.kind !== kind || !stringList(pair.eligibleIds, 64)
      || pair.baselineId !== (pair.eligibleIds[0] ?? null)
      || (pair.suggestedId !== null && !boundedString(pair.suggestedId, 128))
      || typeof pair.baselineSucceeded !== "boolean" || typeof pair.suggestedSucceeded !== "boolean"
      || (pair.baselineId === null && pair.baselineSucceeded) || (pair.suggestedId === null && pair.suggestedSucceeded)) {
      throw new Error("Every routing pair needs the same kind, eligible baseline and boolean outcomes")
    }
  }
  return { kind, ...Object.fromEntries(origins.map((origin) => [origin, routingMetrics(pairs.filter((pair) => pair.origin === origin))])),
    gateReady: false, gateReason: "requires-frozen-real-benchmark" }
}

export function evaluateMemoryPairs(pairs) {
  validateCases(pairs)
  if (pairs.some((pair) => ["superseded", "ageBaselineStale", "warned"].some((field) => typeof pair[field] !== "boolean"))) {
    throw new Error("Every memory pair needs boolean adjudicated and paired outcomes")
  }
  return { ...Object.fromEntries(origins.map((origin) => [origin, memoryMetrics(pairs.filter((pair) => pair.origin === origin))])),
    gateReady: false, gateReason: "requires-frozen-real-benchmark" }
}
