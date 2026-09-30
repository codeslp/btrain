import { boundedString, stringList, validRecordRef } from "../../src/brain_train/jev/frozen-record.mjs"

const origins = ["real", "synthetic", "unknown"]
const outcomes = ["decision", "abstain", "failure", "skipped"]

function denseArray(value, max) {
  return Array.isArray(value) && value.length <= max
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
}
function ids(value, max) {
  return denseArray(value, max) && stringList(value, max)
}
function rate(count, total) {
  return total ? count / total : null
}
function recall(resultIds, relevantIds) {
  return resultIds.slice(0, 5).filter((id) => relevantIds.includes(id)).length / relevantIds.length
}
function metrics(pairs) {
  const baselineRecall = pairs.reduce((sum, pair) => sum + recall(pair.baselineIds, pair.relevantIds), 0)
  const semanticRecall = pairs.reduce((sum, pair) => sum + recall(pair.rankedIds, pair.relevantIds), 0)
  const attempts = pairs.flatMap((pair) => pair.gatewayAttempts)
  const eligible = attempts.filter((attempt) => attempt.eligible).length
  const failures = attempts.filter((attempt) => attempt.outcome === "failure").length
  const attempted = attempts.filter((attempt) => attempt.attemptedCall).length
  const attemptedFailures = attempts.filter((attempt) => attempt.attemptedCall && attempt.outcome === "failure").length
  const abstentions = attempts.filter((attempt) => attempt.outcome === "abstain").length
  const actionable = attempts.filter((attempt) => attempt.outcome === "decision").length
  const latencies = pairs.map((pair) => pair.elapsedMs).sort((a, b) => a - b)
  return { cases: pairs.length, baselineRecallAt5: rate(baselineRecall, pairs.length),
    semanticRecallAt5: rate(semanticRecall, pairs.length),
    recallDifferencePercentagePoints: pairs.length ? 100 * (semanticRecall - baselineRecall) / pairs.length : null,
    unauthorizedResults: pairs.reduce((sum, pair) => sum + pair.rankedIds.filter((id) => !pair.authorizedIds.includes(id)).length, 0),
    latencyMs: { observedQueries: pairs.length, p95: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null },
    gateway: { eligible, attempted, failures, attemptedFailures, failuresWithoutCall: failures - attemptedFailures,
      skipped: attempts.filter((attempt) => attempt.outcome === "skipped").length,
      abstentions, actionable,
      failureRate: rate(attemptedFailures, attempted), validPredictionCoverage: rate(actionable + abstentions, attempted),
      actionableCoverage: rate(actionable, eligible) } }
}

function validatePair(pair) {
  if (!boundedString(pair?.id, 128) || !origins.includes(pair.origin)
    || !boundedString(pair.principalId, 128) || !ids(pair.sourceAccessRoles, 32)
    || !ids(pair.authorizedIds, 128) || !ids(pair.relevantIds, 128) || !pair.relevantIds.length
    || pair.relevantIds.some((id) => !pair.authorizedIds.includes(id))
    || !ids(pair.baselineIds, 16) || pair.baselineIds.some((id) => !pair.authorizedIds.includes(id))
    || !ids(pair.rankedIds, 16) || pair.rankedIds.length !== pair.baselineIds.length
    || pair.rankedIds.some((id) => !pair.baselineIds.includes(id))
    || !Number.isFinite(pair.elapsedMs) || pair.elapsedMs < 0) {
    throw new Error("Pairs need judged authorized relevance, captured roles, a bounded shared shortlist and measured query latency")
  }
  if (pair.origin === "real" && (!validRecordRef(pair.sourceRef)
    || typeof pair.sourceSnapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(pair.sourceSnapshotHash))) {
    throw new Error("Real queries require source proof")
  }
  if (!denseArray(pair.gatewayAttempts, 16) || pair.gatewayAttempts.length !== pair.baselineIds.length) {
    throw new Error("Every shortlisted record requires one gateway outcome")
  }
  const seen = new Set()
  for (const attempt of pair.gatewayAttempts) {
    if (!attempt || !pair.baselineIds.includes(attempt.id) || seen.has(attempt.id)
      || typeof attempt.eligible !== "boolean" || typeof attempt.attemptedCall !== "boolean"
      || !outcomes.includes(attempt.outcome)
      || (!attempt.eligible && (attempt.attemptedCall || attempt.outcome !== "skipped"))
      || (attempt.outcome === "skipped" && attempt.attemptedCall)
      || (["decision", "abstain"].includes(attempt.outcome) && !attempt.attemptedCall)) {
      throw new Error("Gateway records must have unique catalog IDs and consistent eligibility, attempts and outcomes")
    }
    seen.add(attempt.id)
  }
  if (pair.gatewayAttempts.some((attempt) => attempt.outcome !== "decision")
    && pair.rankedIds.some((id, index) => id !== pair.baselineIds[index])) {
    throw new Error("Incomplete gateway scoring must preserve the complete lexical baseline")
  }
}

// Paired accounting validates supplied measurements; it does not freeze a corpus or promote search.
export function evaluateHistoryPairs(pairs) {
  pairs = structuredClone(pairs)
  if (!denseArray(pairs, 10000) || !pairs.length) throw new Error("Nonempty dense paired queries are required")
  const seen = new Set()
  for (const pair of pairs) {
    validatePair(pair)
    if (seen.has(pair.id)) throw new Error("Paired query IDs must be unique")
    seen.add(pair.id)
  }
  return { ...Object.fromEntries(origins.map((origin) => [origin, metrics(pairs.filter((pair) => pair.origin === origin))])),
    gateReady: false, gateReason: "requires-frozen-real-benchmark-and-access-policy" }
}
