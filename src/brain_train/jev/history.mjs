import { createDecisionFamily, createDecisionRun, decideCandidate } from "./decision.mjs"
import { boundedString, stringList, validRecordRef, readFrozenRecord, frozenRecordRules } from "./frozen-record.mjs"

const kinds = ["event", "trace", "handoff", "review"]
const maxRecords = 128
const maxCalls = 16
const maxInputBytes = 16 * 1024
const scores = { high: 3, medium: 2, low: 1 }

function validateHistory(record) {
  if (!boundedString(record.query) || !boundedString(record.principal?.id, 128)
    || !stringList(record.principal.roles) || !record.filters
    || !stringList(record.filters.repositories) || !stringList(record.filters.kinds)
    || record.filters.kinds.some((kind) => !kinds.includes(kind))
    || !Array.isArray(record.records) || record.records.length > maxRecords) {
    throw new Error("A bounded query, captured principal, filters and history catalog are required")
  }
  const ids = new Set()
  for (const entry of record.records) {
    if (!boundedString(entry?.id, 128) || ids.has(entry.id) || !boundedString(entry.repository, 128)
      || !kinds.includes(entry.kind) || !validRecordRef(entry.sourceRef) || !boundedString(entry.text, 8192)
      || !stringList(entry.access?.principalIds) || !stringList(entry.access?.roles)) {
      throw new Error("History records require unique IDs, sources, bounded text and explicit source ACLs")
    }
    ids.add(entry.id)
  }
}

function authorized(entry, principal) {
  return entry.access.principalIds.includes(principal.id)
    || entry.access.roles.some((role) => principal.roles.includes(role))
}

function tokens(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

function historyInput(candidate) {
  return { query: candidate.query, record: { id: candidate.entry.id, repository: candidate.entry.repository,
    kind: candidate.entry.kind, sourceRef: candidate.entry.sourceRef, text: candidate.entry.text } }
}

function shortlistHistory(record) {
  const queryTokens = tokens(record.query)
  const filteredCounts = { unauthorized: 0, structured: 0, lexical: 0, beyondShortlist: 0 }
  const matches = []
  for (const [index, entry] of record.records.entries()) {
    // Source ACLs are captured by the owning local reader; empty grants deny access.
    if (!authorized(entry, record.principal)) { filteredCounts.unauthorized += 1; continue }
    if ((record.filters.repositories.length && !record.filters.repositories.includes(entry.repository))
      || (record.filters.kinds.length && !record.filters.kinds.includes(entry.kind))) {
      filteredCounts.structured += 1; continue
    }
    const entryTokens = tokens(entry.text)
    const score = [...queryTokens].filter((token) => entryTokens.has(token)).length
    if (!score) { filteredCounts.lexical += 1; continue }
    matches.push({ entry, score, index })
  }
  matches.sort((a, b) => b.score - a.score || a.index - b.index)
  filteredCounts.beyondShortlist = Math.max(0, matches.length - maxCalls)
  return { shortlist: matches.slice(0, maxCalls).map(({ entry }) => entry), filteredCounts }
}

export const historyFamily = createDecisionFamily({
  id: "history-relevance", questionVersion: "1", policyVersion: "1",
  policyConfig: { kinds, maxRecords, maxCalls, maxInputBytes, scores, frozenRecordRules,
    historyRules: [validateHistory, authorized, tokens, historyInput, shortlistHistory, searchHistory]
      .map((rule) => rule.toString()).join("\n") },
  choices: ["high", "medium", "low", "uncertain"], privacyClass: "private",
  allowedActions: ["relevance:high", "relevance:medium", "relevance:low"], threshold: 0.8,
  maxCalls, maxInputBytes, timeoutMs: 100,
  inputBuilder: historyInput,
  actionPolicy: (choice) => choice === "uncertain" ? null : `relevance:${choice}`,
  fallback: () => "uncertain",
})

// Offline read-only ranking: captured roles are evaluation evidence, never live authorization.
export async function searchHistory({ source, sourceProof, provider, mode = "off", modelPin = null, codeRevision = null }) {
  const { record, candidateSource, proof } = readFrozenRecord({ source, sourceProof, mode })
  validateHistory(record)
  const { shortlist, filteredCounts } = shortlistHistory(record)
  const baselineIds = shortlist.map((entry) => entry.id)
  // Preflight the whole ranking; incomplete scores must not bias the lexical comparator.
  const canRank = shortlist.length > 0 && shortlist.every((entry) =>
    Buffer.byteLength(JSON.stringify(historyInput({ query: record.query, entry }))) <= maxInputBytes)
  const eligibleIds = canRank ? [...baselineIds] : []
  const run = createDecisionRun(historyFamily)
  const traces = []
  let calls = 0
  for (const entry of shortlist.length ? shortlist : [null]) {
    const trace = await decideCandidate({ family: historyFamily, run, provider, mode, modelPin, codeRevision, sourceProof: proof,
      candidate: { ...candidateSource, eligible: canRank, baseline: "uncertain", privacyClass: "private",
        callIndex: calls, query: record.query, entry } })
    traces.push(trace)
    if (trace.attemptedCall) calls += 1
  }
  const complete = canRank && traces.every((trace) => trace.outcome === "decision")
  const ordered = complete ? shortlist.map((entry, index) => ({ entry, index, score: scores[traces[index].prediction] }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(({ entry }) => entry) : shortlist
  return { baselineIds, eligibleIds, rankedIds: ordered.map((entry) => entry.id), filteredCounts,
    results: ordered.map((entry) => ({ id: entry.id, repository: entry.repository, kind: entry.kind,
      sourceRef: entry.sourceRef, text: entry.text })), traces }
}
