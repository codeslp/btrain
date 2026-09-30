import { createDecisionFamily, createDecisionRun, decideCandidate } from "./decision.mjs"
import { boundedString, stringList, readFrozenRecord, frozenRecordRules } from "./frozen-record.mjs"

const kinds = ["task", "lane", "reviewer", "runner", "skill"]
const maxCandidates = 64
const maxCalls = 16
const scores = { high: 3, medium: 2, low: 1 }

function validateRouting(record) {
  if (!kinds.includes(record.kind) || !boundedString(record.objective)
    || !stringList(record.requiredCapabilities) || !record.requiredCapabilities.length
    || !stringList(record.separateFrom ?? [])
    || (record.kind === "reviewer" && !boundedString(record.ownerId, 128))
    || !Array.isArray(record.candidates) || record.candidates.length > maxCandidates) {
    throw new Error("A bounded routing catalog and explicit requirements are required")
  }
  const ids = new Set()
  for (const candidate of record.candidates) {
    if (!boundedString(candidate?.id, 128) || ids.has(candidate.id) || !boundedString(candidate.actorId, 128)
      || !boundedString(candidate.description) || !stringList(candidate.capabilities)
      || ["authorized", "available", "lockCompatible"].some((key) => candidate[key] !== undefined && typeof candidate[key] !== "boolean")) {
      throw new Error("Routing candidates require unique IDs and bounded capability metadata")
    }
    ids.add(candidate.id)
  }
}

function exclusionReasons(candidate, record) {
  const reasons = []
  if (candidate.authorized !== true) reasons.push("unauthorized")
  if (candidate.available !== true) reasons.push("unavailable")
  if (candidate.lockCompatible !== true) reasons.push("lock-conflict")
  if ((record.kind === "reviewer" && candidate.actorId === record.ownerId)
    || (record.separateFrom ?? []).includes(candidate.actorId)) reasons.push("role-separation")
  if (record.requiredCapabilities.some((capability) => !candidate.capabilities.includes(capability))) reasons.push("incapable")
  return reasons
}

export const routingFamily = createDecisionFamily({
  id: "eligible-routing",
  questionVersion: "1",
  policyVersion: "1",
  policyConfig: {
    kinds, maxCandidates, maxCalls, scores, frozenRecordRules,
    routingRules: [validateRouting, exclusionReasons, rankEligibleRoutes].map((rule) => rule.toString()).join("\n"),
  },
  choices: ["high", "medium", "low", "uncertain"],
  privacyClass: "private",
  allowedActions: ["rank:high", "rank:medium", "rank:low"],
  threshold: 0.8,
  maxCalls,
  maxInputBytes: 16 * 1024,
  inputBuilder: (candidate) => ({ kind: candidate.kind, objective: candidate.objective,
    candidate: { id: candidate.route.id, description: candidate.route.description, capabilities: [...candidate.route.capabilities] } }),
  actionPolicy: (choice) => choice === "uncertain" ? null : `rank:${choice}`,
  fallback: () => "uncertain",
})

// Eligibility comes from a captured deterministic catalog. This proposal never dispatches work.
export async function rankEligibleRoutes({ source, sourceProof, provider, mode = "off", modelPin = null, codeRevision = null }) {
  const { record, candidateSource, proof } = readFrozenRecord({ source, sourceProof, mode })
  validateRouting(record)
  const eligible = []
  const excluded = []
  for (const candidate of record.candidates) {
    const reasons = exclusionReasons(candidate, record)
    if (reasons.length) excluded.push({ id: candidate.id, reasons })
    else eligible.push(candidate)
  }
  const baselineIds = eligible.map((candidate) => candidate.id)
  const run = createDecisionRun(routingFamily)
  const traces = []
  // An oversized catalog falls back as a whole; a partial ranking could distort the baseline.
  const canRank = eligible.length > 0 && eligible.length <= maxCalls
  const candidates = canRank ? eligible : [null]
  for (const [callIndex, route] of candidates.entries()) {
    traces.push(await decideCandidate({
      family: routingFamily, run, provider, mode, modelPin, codeRevision, sourceProof: proof,
      candidate: { ...candidateSource, eligible: canRank, baseline: "uncertain", privacyClass: "private",
        callIndex, kind: record.kind, objective: record.objective, route },
    }))
  }
  const complete = canRank && traces.every((trace) => trace.outcome === "decision")
  const rankedIds = complete ? eligible.map((candidate, index) => ({ id: candidate.id, index, score: scores[traces[index].prediction] }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map((candidate) => candidate.id) : [...baselineIds]
  return { baselineIds, rankedIds, excluded, traces }
}
