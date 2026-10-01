import { boundedString, stringList, validRecordRef } from "../../src/brain_train/jev/frozen-record.mjs"

const origins = ["real", "synthetic", "unknown"]
const ruleFamilies = { diff: "repository-rules", turn: "end-of-turn-rules" }

function validateCases(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error("Nonempty paired cases are required")
  const ids = new Set()
  for (const pair of pairs) {
    if (!boundedString(pair?.id, 128) || ids.has(pair.id) || !origins.includes(pair.origin)
      || (pair.origin === "real" && (!validRecordRef(pair.sourceRef) || typeof pair.sourceSnapshotHash !== "string"
        || !/^[a-f0-9]{64}$/.test(pair.sourceSnapshotHash)))) {
      throw new Error("Each case needs a unique ID, known origin and source proof for real measurements")
    }
    ids.add(pair.id)
  }
}

function rate(count, total) {
  return total ? count / total : null
}

function confusion(pairs, field) {
  const truePositive = pairs.filter((pair) => pair.violation && pair[field]).length
  const falsePositive = pairs.filter((pair) => !pair.violation && pair[field]).length
  const falseNegative = pairs.filter((pair) => pair.violation && !pair[field]).length
  const trueNegative = pairs.filter((pair) => !pair.violation && !pair[field]).length
  return { truePositive, falsePositive, falseNegative, trueNegative,
    precision: rate(truePositive, truePositive + falsePositive), recall: rate(truePositive, truePositive + falseNegative) }
}

function percentile(values, fraction) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null
}

function gatewayMetrics(pairs) {
  const attempted = pairs.filter((pair) => pair.attemptedCall)
  const latencies = attempted.map((entry) => entry.latencyMs).filter(Number.isFinite)
  const costs = attempted.map((entry) => entry.cost).filter(Number.isFinite)
  const failures = attempted.filter((pair) => pair.outcome === "failure").length
  const eligible = pairs.filter((pair) => pair.eligible).length
  const decisions = pairs.filter((pair) => pair.outcome === "decision").length
  const abstentions = pairs.filter((pair) => pair.outcome === "abstain").length
  return { eligible, attemptedCalls: attempted.length, decisions, abstentions,
    latencyMs: { observedCalls: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    cost: { observedCalls: costs.length, total: costs.length ? costs.reduce((total, value) => total + value, 0) : null },
    skipped: pairs.filter((pair) => pair.outcome === "skipped").length,
    attemptedFailures: failures,
    providerFailures: pairs.filter((pair) => pair.outcome === "failure" && pair.failureClass === "provider").length,
    responseShapeFailures: pairs.filter((pair) => pair.outcome === "failure" && pair.failureClass === "response-shape").length,
    failuresWithoutCall: pairs.filter((pair) => pair.outcome === "failure" && !pair.attemptedCall).length,
    attemptedFailureRate: rate(failures, attempted.length),
    validPredictionCoverage: rate(decisions + abstentions, attempted.length),
    actionableDecisionCoverage: rate(decisions, eligible) }
}

function validGatewayOutcome(entry) {
  return typeof entry?.eligible === "boolean" && typeof entry.attemptedCall === "boolean"
    && ["decision", "abstain", "failure", "skipped"].includes(entry.outcome)
    && (entry.outcome === "failure" ? ["provider", "response-shape"].includes(entry.failureClass) : entry.failureClass == null)
    && (entry.failureClass !== "response-shape" || entry.attemptedCall)
    && ["latencyMs", "cost"].every((field) => entry[field] == null
      || (entry.attemptedCall && Number.isFinite(entry[field]) && entry[field] >= 0))
    && (entry.eligible || entry.outcome === "skipped")
    && (entry.outcome !== "skipped" || !entry.attemptedCall)
    && (!["decision", "abstain"].includes(entry.outcome) || entry.attemptedCall)
}

function ruleMetrics(pairs) {
  return { cases: pairs.length, violations: pairs.filter((pair) => pair.violation).length,
    baseline: confusion(pairs, "baselineWarned"), semantic: confusion(pairs, "semanticWarned"),
    inventedCitations: pairs.reduce((total, pair) => total + pair.inventedCitations, 0), gateway: gatewayMetrics(pairs) }
}

// Measurements never certify independent labels, frozen splits, or promotion readiness.
export function evaluateRulePairs(kind, pairs) {
  if (!Object.hasOwn(ruleFamilies, kind)) throw new Error("A separate diff or turn family is required")
  validateCases(pairs)
  for (const pair of pairs) {
    if (pair.kind !== kind || ["violation", "baselineWarned", "semanticWarned", "eligible", "attemptedCall"].some((key) => typeof pair[key] !== "boolean")
      || !Number.isSafeInteger(pair.inventedCitations) || pair.inventedCitations < 0
      || !validGatewayOutcome(pair)
      || (pair.semanticWarned && pair.outcome !== "decision")
      || (pair.inventedCitations > 0 && !pair.semanticWarned)) {
      throw new Error("Rule measurements need consistent binary labels, warnings and gateway outcomes")
    }
  }
  return { family: ruleFamilies[kind], ...Object.fromEntries(origins.map((origin) => [origin, ruleMetrics(pairs.filter((pair) => pair.origin === origin))])),
    gateReady: false, gateReason: "requires-frozen-real-benchmark" }
}

function denseStringList(values) {
  if (!Array.isArray(values) || values.length > 64) return false
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) return false
  }
  return stringList(values, 64)
}

function subset(values, catalog) {
  return denseStringList(values) && values.every((value) => catalog.includes(value))
}

function validateReviewGateway(pair) {
  if (!Array.isArray(pair.gatewayAttempts) || pair.gatewayAttempts.length !== pair.baselineIds.length) {
    throw new Error("Every review candidate requires a gateway measurement")
  }
  const ids = new Set()
  for (let index = 0; index < pair.gatewayAttempts.length; index += 1) {
    const entry = pair.gatewayAttempts[index]
    if (!Object.hasOwn(pair.gatewayAttempts, index) || !entry || !pair.baselineIds.includes(entry.reviewId)
      || ids.has(entry.reviewId) || !validGatewayOutcome(entry)) {
      throw new Error("Review gateway measurements must cover unique known candidates with consistent outcomes")
    }
    ids.add(entry.reviewId)
  }
}

function reviewMetrics(pairs) {
  let severe = 0
  let baselineTopSevere = 0
  let prioritizedTopSevere = 0
  let defects = 0
  let baselineFound = 0
  let prioritizedFound = 0
  let baselineMinutes = 0
  let prioritizedMinutes = 0
  for (const pair of pairs) {
    const topCount = Math.ceil(pair.baselineIds.length * 0.3)
    severe += pair.severeIds.length
    baselineTopSevere += pair.severeIds.filter((id) => pair.baselineIds.slice(0, topCount).includes(id)).length
    prioritizedTopSevere += pair.severeIds.filter((id) => pair.prioritizedIds.slice(0, topCount).includes(id)).length
    defects += pair.defectIds.length
    baselineFound += pair.baselineFoundIds.length
    prioritizedFound += pair.prioritizedFoundIds.length
    baselineMinutes += pair.baselineMinutes
    prioritizedMinutes += pair.prioritizedMinutes
  }
  return { cases: pairs.length, severeFindings: severe, labeledDefects: defects,
    baselineSevereRecallInTopThirtyPercent: rate(baselineTopSevere, severe),
    severeRecallInTopThirtyPercent: rate(prioritizedTopSevere, severe),
    baselineDefectRecall: rate(baselineFound, defects), prioritizedDefectRecall: rate(prioritizedFound, defects),
    equalDefectRecall: defects ? baselineFound === prioritizedFound : null,
    baselineMinutes, prioritizedMinutes,
    reviewerTimeChangeFraction: baselineMinutes ? (prioritizedMinutes - baselineMinutes) / baselineMinutes : null,
    gateway: gatewayMetrics(pairs.flatMap((pair) => pair.gatewayAttempts)) }
}

export function evaluateReviewQueues(pairs) {
  validateCases(pairs)
  for (const pair of pairs) {
    if (!denseStringList(pair.baselineIds) || !pair.baselineIds.length
      || !subset(pair.prioritizedIds, pair.baselineIds) || pair.prioritizedIds.length !== pair.baselineIds.length
      || !subset(pair.defectIds, pair.baselineIds) || !subset(pair.severeIds, pair.defectIds)
      || !subset(pair.baselineFoundIds, pair.defectIds) || !subset(pair.prioritizedFoundIds, pair.defectIds)
      || !Number.isFinite(pair.baselineMinutes) || pair.baselineMinutes <= 0
      || !Number.isFinite(pair.prioritizedMinutes) || pair.prioritizedMinutes < 0) {
      throw new Error("Review measurements must preserve the complete queue, known findings and valid paired times")
    }
    validateReviewGateway(pair)
    if (pair.gatewayAttempts.some((entry) => entry.outcome !== "decision")
      && pair.prioritizedIds.some((id, index) => id !== pair.baselineIds[index])) {
      throw new Error("Incomplete review scoring must retain the baseline order")
    }
  }
  return { family: "review-risk", ...Object.fromEntries(origins.map((origin) => [origin, reviewMetrics(pairs.filter((pair) => pair.origin === origin))])),
    gateReady: false, gateReason: "requires-frozen-real-benchmark" }
}
