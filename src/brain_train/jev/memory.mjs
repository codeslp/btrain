import { createDecisionFamily, createDecisionRun, decideCandidate } from "./decision.mjs"
import { boundedString, validRecordRef, readFrozenRecord, frozenRecordRules } from "./frozen-record.mjs"

const maxEvents = 64
const maxCalls = 16
function sequence(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validateMemory(record) {
  const claim = record.claim
  if (!boundedString(claim?.id, 128) || !boundedString(claim.key, 128)
    || !Number.isSafeInteger(claim.version) || claim.version < 1
    || !sequence(claim.observedSequence) || !sequence(claim.leaseUntilSequence)
    || claim.leaseUntilSequence < claim.observedSequence
    || !sequence(record.asOfSequence) || record.asOfSequence < claim.observedSequence
    || !validRecordRef(claim.sourceRef) || !boundedString(claim.text)
    || !Array.isArray(record.events) || record.events.length > maxEvents) {
    throw new Error("A bounded versioned memory claim with a source and lease is required")
  }
  const ids = new Set()
  for (const event of record.events) {
    if (!boundedString(event?.id, 128) || ids.has(event.id) || !boundedString(event.key, 128)
      || !Number.isSafeInteger(event.version) || event.version < 1 || !sequence(event.sequence)
      || !validRecordRef(event.sourceRef) || !boundedString(event.text)
      || (event.authorized !== undefined && typeof event.authorized !== "boolean")) {
      throw new Error("Memory events require unique IDs, versions, source references and bounded text")
    }
    ids.add(event.id)
  }
}

function eligibleEvent(event, record) {
  return event.authorized === true && event.key === record.claim.key
    && event.version > record.claim.version && event.sequence > record.claim.observedSequence
    && event.sequence <= record.asOfSequence
}

export const memoryFamily = createDecisionFamily({
  id: "memory-invalidation",
  questionVersion: "1",
  policyVersion: "1",
  policyConfig: { maxEvents, maxCalls, frozenRecordRules,
    memoryRules: [sequence, validateMemory, eligibleEvent, inspectMemoryClaim].map((rule) => rule.toString()).join("\n") },
  choices: ["superseded", "supported", "unrelated", "uncertain"],
  privacyClass: "private",
  allowedActions: ["memory:warn", "memory:retain"],
  threshold: 0.85,
  maxCalls,
  maxInputBytes: 16 * 1024,
  inputBuilder: (candidate) => ({
    claim: { id: candidate.claim.id, key: candidate.claim.key, version: candidate.claim.version,
      observedSequence: candidate.claim.observedSequence, sourceRef: candidate.claim.sourceRef, text: candidate.claim.text },
    event: { id: candidate.event.id, key: candidate.event.key, version: candidate.event.version,
      sequence: candidate.event.sequence, sourceRef: candidate.event.sourceRef, text: candidate.event.text },
  }),
  actionPolicy: (choice) => {
    if (choice === "uncertain") return null
    return choice === "superseded" ? "memory:warn" : "memory:retain"
  },
  fallback: (baseline) => baseline,
})

// Warnings are returned to the offline caller. Canonical events and memory are never written.
export async function inspectMemoryClaim({ source, sourceProof, provider, mode = "off", modelPin = null, codeRevision = null }) {
  const { record, candidateSource, proof } = readFrozenRecord({ source, sourceProof, mode })
  validateMemory(record)
  const { claim } = record
  const ageBaseline = record.asOfSequence > claim.leaseUntilSequence ? "stale" : "current"
  const eligible = record.events.filter((event) => eligibleEvent(event, record))
  const run = createDecisionRun(memoryFamily)
  const warnings = []
  const traces = []
  for (const [callIndex, event] of (eligible.length ? eligible : [null]).entries()) {
    const trace = await decideCandidate({
      family: memoryFamily, run, provider, mode, modelPin, codeRevision, sourceProof: proof,
      candidate: { ...candidateSource, eligible: event !== null, privacyClass: "private", callIndex,
        baseline: ageBaseline === "stale" ? "superseded" : "supported", claim, event },
    })
    traces.push(trace)
    if (trace.outcome === "decision" && trace.suggestedAction === "memory:warn") {
      warnings.push({ kind: "possibly-stale", claimId: claim.id, claimVersion: claim.version,
        eventId: event.id, eventVersion: event.version, sourceRefs: [claim.sourceRef, event.sourceRef] })
    }
  }
  return { ageBaseline, warnings, traces }
}
