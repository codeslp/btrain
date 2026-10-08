import { createDecisionFamily, createDecisionRun, decideCandidate } from "./decision.mjs"
import { boundedString, stringList, validRecordRef, readFrozenRecord, frozenRecordRules } from "./frozen-record.mjs"

const maxReviews = 64
const maxCalls = 16
const scores = { high: 3, medium: 2, low: 1 }

function validateReviews(record) {
  if (!boundedString(record.objective) || !Array.isArray(record.reviews) || record.reviews.length > maxReviews) {
    throw new Error("A bounded review queue and objective are required")
  }
  const ids = new Set()
  for (const review of record.reviews) {
    if (!boundedString(review?.id, 128) || ids.has(review.id) || !validRecordRef(review.sourceRef)
      || !boundedString(review.text, 8192) || !stringList(review.requiredChecks) || !review.requiredChecks.length
      || (review.authorized !== undefined && typeof review.authorized !== "boolean")) {
      throw new Error("Reviews require unique IDs, bounded evidence, a source and mandatory checks")
    }
    ids.add(review.id)
  }
}

function reviewEligible(review, canRank) {
  return canRank && review?.authorized === true
}

export const reviewRiskFamily = createDecisionFamily({
  id: "review-risk",
  questionVersion: "1",
  policyVersion: "1",
  policyConfig: { maxReviews, maxCalls, scores, frozenRecordRules,
    reviewRules: [validateReviews, reviewEligible, prioritizeReviews].map((rule) => rule.toString()).join("\n") },
  choices: ["high", "medium", "low", "uncertain"],
  privacyClass: "private",
  allowedActions: ["review-priority:high", "review-priority:medium", "review-priority:low"],
  threshold: 0.8,
  maxCalls,
  maxInputBytes: 16 * 1024,
  inputBuilder: (candidate) => ({ objective: candidate.objective,
    review: { id: candidate.review.id, sourceRef: candidate.review.sourceRef, text: candidate.review.text,
      requiredChecks: [...candidate.review.requiredChecks] } }),
  actionPolicy: (choice) => choice === "uncertain" ? null : `review-priority:${choice}`,
  fallback: () => "uncertain",
})

// Every queue entry and required check survives. The offline output only proposes review order.
export async function prioritizeReviews({ source, sourceProof, provider, mode = "off", modelPin = null, codeRevision = null }) {
  const { record, candidateSource, proof } = readFrozenRecord({ source, sourceProof, mode })
  validateReviews(record)
  const baselineIds = record.reviews.map((review) => review.id)
  const requiredReviews = record.reviews.map((review) => ({ id: review.id, checks: [...review.requiredChecks] }))
  const canRank = record.reviews.length > 0 && record.reviews.length <= maxCalls
  const run = createDecisionRun(reviewRiskFamily)
  const traces = []
  let calls = 0
  for (const review of record.reviews.length ? record.reviews : [null]) {
    const trace = await decideCandidate({
      family: reviewRiskFamily, run, provider, mode, modelPin, codeRevision, sourceProof: proof,
      candidate: { ...candidateSource, objective: record.objective, review, eligible: reviewEligible(review, canRank),
        baseline: "uncertain", privacyClass: "private", callIndex: calls },
    })
    traces.push(trace)
    if (trace.attemptedCall) calls += 1
  }
  const complete = canRank && traces.every((trace) => trace.outcome === "decision")
  const prioritizedIds = complete
    ? record.reviews.map((review, index) => ({ id: review.id, index, score: scores[traces[index].prediction] }))
      .sort((a, b) => b.score - a.score || a.index - b.index).map((review) => review.id)
    : [...baselineIds]
  return { baselineIds, prioritizedIds, requiredReviews, traces }
}
