import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import fs from "node:fs/promises"
import path from "node:path"
import { sourceSnapshotHashFor, validCodeRevision } from "./manifest.mjs"

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const outcomes = new Set(["off", "offline"])
const failureReasons = new Set(["timeout", "authentication-error", "rate-limit", "provider-error", "http-error", "network-error", "invalid-response", "invalid-request", "disabled"])
const traceReasons = new Set(["mode-off", "ineligible", "invalid-baseline", "invalid-call-index", "invalid-privacy-class", "privacy-denied", "call-budget", "invalid-source-reference", "invalid-input", "input-budget", "provider-unavailable", "timeout", "authentication-error", "rate-limit", "provider-error", "http-error", "network-error", "invalid-response", "invalid-request", "disabled", "model-mismatch", "invalid-answer", "below-threshold", "no-permitted-action"])
const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null
const explicitRuns = new WeakMap()

export function createDecisionRun(family) {
  const run = Object.freeze({})
  explicitRuns.set(run, { family, calls: 0 })
  return run
}

function consumeCallBudget(family, run) {
  const state = explicitRuns.get(run)
  if (state.calls >= family.maxCalls) return false
  state.calls += 1
  return true
}

function opaqueId(value) {
  if (typeof value !== "string" || !value) return null
  return /^id-sha256:[a-f0-9]{64}$/.test(value) ? value : `id-sha256:${hash(value)}`
}

function opaqueRefs(refs) {
  if (!Array.isArray(refs)) return []
  return refs.slice(0, 16).flatMap((ref) => {
    if (typeof ref === "string" && /^ref-sha256:[a-f0-9]{64}$/.test(ref)) return [ref]
    try {
      const url = new URL(ref)
      if (!["https:", "http:"].includes(url.protocol)) return []
      url.username = ""
      url.password = ""
      url.hash = ""
      return [`ref-sha256:${hash(url.toString())}`]
    } catch { return [] }
  })
}

function sourceBindingFor(sourceProof, traceRefs, candidate = null) {
  const invalid = () => { throw new Error("Trace source provenance does not match frozen evidence") }
  if (!Array.isArray(sourceProof?.sources) || !sourceProof.sources.length || sourceProof.sources.length > 16) invalid()
  let snapshotHash
  try { snapshotHash = sourceSnapshotHashFor(sourceProof.sources) } catch { invalid() }
  if (sourceProof.sourceSnapshotHash !== snapshotHash) invalid()
  const sourceBindings = sourceProof.sources.map((source) => {
    if (!source || typeof source !== "object") invalid()
    const refs = opaqueRefs([source.sourceRef])
    if (!opaqueId(source.id) || !/^[a-f0-9]{64}$/.test(source.sourceHash || "") || refs.length !== 1) invalid()
    const sourceId = /^[a-f0-9]{64}$/.test(source.id) ? source.id : opaqueId(source.id)
    return { sourceId, sourceHash: source.sourceHash, sourceRef: refs[0] }
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  const expectedRefs = new Set(sourceBindings.map((source) => source.sourceRef))
  const actualRefs = new Set(traceRefs)
  if (!actualRefs.size || actualRefs.size !== expectedRefs.size || [...actualRefs].some((ref) => !expectedRefs.has(ref))) invalid()
  if (candidate) {
    const proofIds = new Set(sourceProof.sources.map((source) => source.id))
    const candidateIds = sourceProof.sources.length === 1 ? [candidate.sourceId] : candidate.sourceIds
    if (!Array.isArray(candidateIds) || candidateIds.length !== proofIds.size || new Set(candidateIds).size !== proofIds.size
      || candidateIds.some((id) => !proofIds.has(id))) invalid()
    const contents = sourceProof.sources.map((source) => sourceProof.sources.length === 1
      ? candidate.sourceContent
      : candidate.sourceContents?.[source.id])
    if (contents.some((content, index) => typeof content !== "string"
      || createHash("sha256").update(content).digest("hex") !== sourceProof.sources[index].sourceHash)) invalid()
    if (candidate.text !== undefined && !contents.includes(candidate.text)) invalid()
  }
  return {
    sourceSnapshotHash: snapshotHash,
    sourceBindings: sourceBindings.map(({ sourceId, sourceHash }) => ({ sourceId, sourceHash })),
  }
}

function frozenPolicyConfig(value) {
  const valid = (entry) => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true
    if (typeof entry === "number") return Number.isFinite(entry)
    if (Array.isArray(entry)) return entry.every(valid)
    if (!entry || typeof entry !== "object" || Object.getPrototypeOf(entry) !== Object.prototype) return false
    return Object.values(entry).every(valid)
  }
  if (!value || Array.isArray(value) || !valid(value)) throw new Error("A serializable policy configuration is required")
  let copy
  try { copy = JSON.parse(JSON.stringify(value)) } catch { throw new Error("A serializable policy configuration is required") }
  const freeze = (entry) => {
    if (entry && typeof entry === "object") {
      for (const child of Object.values(entry)) freeze(child)
      Object.freeze(entry)
    }
  }
  freeze(copy)
  return copy
}

function resourceBudget(value, fallback, min, max) {
  const budget = value ?? fallback
  if (!Number.isSafeInteger(budget) || budget < min || budget > max) throw new Error("Invalid family resource budget")
  return budget
}

export function createDecisionFamily(config) {
  const { id, questionVersion, choices, privacyClass, allowedActions, threshold, inputBuilder, actionPolicy, fallback } = config
  if (!id || !questionVersion || !Array.isArray(choices) || choices.length < 2 || new Set(choices).size !== choices.length) throw new Error("A versioned closed choice family is required")
  if (!["public", "synthetic", "private"].includes(privacyClass)) throw new Error("A privacy class is required")
  if (!Array.isArray(allowedActions) || typeof inputBuilder !== "function" || typeof actionPolicy !== "function" || typeof fallback !== "function") throw new Error("Family input, action, and fallback policies are required")
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Invalid decision threshold")
  if (typeof config.policyVersion !== "string" || !config.policyVersion) throw new Error("A policy version is required")
  const policyConfig = frozenPolicyConfig(config.policyConfig)
  const family = { id, questionVersion, policyVersion: config.policyVersion, policyConfig, choices: Object.freeze([...choices]), privacyClass, allowedActions: Object.freeze([...allowedActions]), threshold, inputBuilder, actionPolicy, fallback, questionId: config.questionId || "signal", timeoutMs: resourceBudget(config.timeoutMs, 2000, 1, 60000), maxInputBytes: resourceBudget(config.maxInputBytes, 16 * 1024, 0, 1024 * 1024), maxCalls: resourceBudget(config.maxCalls, 1, 0, 256) }
  family.policyHash = hash({ id, questionVersion, policyVersion: family.policyVersion, policyConfig, choices, privacyClass, allowedActions, threshold, questionId: family.questionId, timeoutMs: family.timeoutMs, maxInputBytes: family.maxInputBytes, maxCalls: family.maxCalls, inputBuilder: inputBuilder.toString(), actionPolicy: actionPolicy.toString(), fallback: fallback.toString() })
  return Object.freeze(family)
}

export function fakeProvider(result) {
  return { localOnly: true, decide: async () => structuredClone(result) }
}

export async function appendDecisionTrace(root, trace, family, sourceProof) {
  if (!trace || !["skipped", "decision", "abstain", "failure"].includes(trace.outcome)) throw new Error("A gateway trace is required")
  if (!family || trace.family !== family.id || trace.policyHash !== family.policyHash) throw new Error("A matching decision family is required")
  if (trace.outcome !== "skipped" && (!validCodeRevision(trace.codeRevision) || !opaqueId(trace.modelPin))) {
    throw new Error("Offline traces require a code revision and model pin")
  }
  if (["decision", "abstain"].includes(trace.outcome) && opaqueId(trace.model) !== opaqueId(trace.modelPin)) {
    throw new Error("Decision model must match the model pin")
  }
  const traceRefs = opaqueRefs(trace.sourceRefs)
  const binding = sourceBindingFor(sourceProof, traceRefs)
  if (trace.sourceSnapshotHash !== binding.sourceSnapshotHash
    || !Array.isArray(trace.sourceBindings)
    || trace.sourceBindings.length !== binding.sourceBindings.length
    || trace.sourceBindings.some((source, index) => !source || source.sourceId !== binding.sourceBindings[index].sourceId
      || source.sourceHash !== binding.sourceBindings[index].sourceHash)) {
    throw new Error("Trace source provenance does not match frozen evidence")
  }
  const record = {
    family: family.id,
    questionVersion: family.questionVersion,
    policyHash: family.policyHash,
    codeRevision: validCodeRevision(trace.codeRevision) ? trace.codeRevision : null,
    sourceSnapshotHash: binding.sourceSnapshotHash,
    sourceBindings: binding.sourceBindings,
    sourceRefs: traceRefs,
    baseline: family.choices.includes(trace.baseline) ? trace.baseline : null,
    actionTaken: trace.actionTaken === "none" || family.allowedActions.includes(trace.actionTaken) ? trace.actionTaken : "none",
    outcome: trace.outcome,
    reason: traceReasons.has(trace.reason) ? trace.reason : "unclassified",
    attemptedCall: trace.attemptedCall === true,
    inputHash: /^[a-f0-9]{64}$/.test(trace.inputHash || "") ? trace.inputHash : null,
    provider: opaqueId(trace.provider),
    modelPin: opaqueId(trace.modelPin),
    model: opaqueId(trace.model),
    failureClass: ["provider", "response-shape"].includes(trace.failureClass) ? trace.failureClass : null,
    prediction: family.choices.includes(trace.prediction) ? trace.prediction : null,
    suggestedAction: family.allowedActions.includes(trace.suggestedAction) ? trace.suggestedAction : null,
    probabilities: Object.fromEntries(Object.entries(trace.probabilities || {}).filter(([key, value]) => family.choices.includes(key) && Number.isFinite(value) && value >= 0 && value <= 1)),
    latencyMs: nonnegative(trace.latencyMs),
    inputTokens: nonnegative(trace.inputTokens),
    cost: nonnegative(trace.cost),
  }
  const file = path.join(root, ".btrain", "jev", "decision-traces.jsonl")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8")
  return record
}

export function validProbabilityVector(probabilities, choices) {
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return false
  const keys = Object.keys(probabilities)
  if (keys.length !== choices.length || keys.some((key) => !choices.includes(key))) return false
  const values = choices.map((choice) => probabilities[choice])
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return false
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 0.02
}

function validAnswer(response, family) {
  const answer = response?.answers?.[family.questionId]
  if (!answer || !family.choices.includes(answer.choice) || !validProbabilityVector(answer.probabilities, family.choices)) return null
  return { choice: answer.choice, probabilities: Object.fromEntries(family.choices.map((choice) => [choice, answer.probabilities[choice]])) }
}

export async function decideCandidate({ family, candidate, provider, mode = "off", privacyApproved = false, modelPin = null, codeRevision = null, sourceProof = null, run }) {
  if (!outcomes.has(mode)) throw new Error("Decision gateway supports only off or offline mode")
  if (mode === "offline" && (!explicitRuns.has(run) || explicitRuns.get(run).family !== family)) throw new Error("Decision run is required and must match the family")
  if (mode === "offline" && !validCodeRevision(codeRevision)) throw new Error("Offline calls require a code revision pin")
  if (mode === "offline" && !opaqueId(modelPin)) throw new Error("Offline calls require a model pin")
  const sourceRefs = opaqueRefs(candidate?.sourceRefs)
  if (sourceProof !== null && (!Array.isArray(candidate?.sourceRefs)
    || candidate.sourceRefs.length > 16 || sourceRefs.length !== candidate.sourceRefs.length)) {
    throw new Error("Trace source provenance does not match frozen evidence")
  }
  const binding = sourceProof === null ? null : sourceBindingFor(sourceProof, sourceRefs, candidate)
  let baseline
  try {
    const result = family.fallback(candidate?.baseline, family.policyConfig)
    baseline = family.choices.includes(result) ? result : null
  } catch { baseline = null }
  const base = { family: family.id, questionVersion: family.questionVersion, policyHash: family.policyHash, codeRevision: validCodeRevision(codeRevision) ? codeRevision : null, sourceRefs, ...(binding || {}), baseline, actionTaken: "none" }
  const skip = (reason) => ({ ...base, outcome: "skipped", reason, attemptedCall: false })
  if (mode === "off") return skip("mode-off")
  if (candidate?.eligible !== true) return skip("ineligible")
  if (!baseline) return skip("invalid-baseline")
  if (!Number.isSafeInteger(candidate.callIndex) || candidate.callIndex < 0) return skip("invalid-call-index")
  if (!["public", "synthetic", "private"].includes(candidate.privacyClass)) return skip("invalid-privacy-class")
  if ((family.privacyClass === "private" || candidate.privacyClass === "private") && privacyApproved !== true && provider?.localOnly !== true) return skip("privacy-denied")
  if (candidate.callIndex >= family.maxCalls) return skip("call-budget")
  if (!sourceRefs.length) return skip("invalid-source-reference")
  let boundedState
  let encoded
  try {
    boundedState = family.inputBuilder(candidate, family.policyConfig)
    encoded = JSON.stringify(boundedState)
  } catch { return skip("invalid-input") }
  if (!encoded || Buffer.byteLength(encoded) > family.maxInputBytes) return skip("input-budget")
  if (typeof provider?.decide === "function" && !consumeCallBudget(family, run)) return skip("call-budget")
  const inputHash = hash(boundedState)
  const attempted = { ...base, inputHash, provider: opaqueId(provider?.id || "injected"), modelPin: opaqueId(modelPin), attemptedCall: true }
  let startedAt
  const elapsed = () => startedAt === undefined ? null : nonnegative(performance.now() - startedAt)
  const fail = (reason, providerResponse) => ({ ...attempted,
    ...(providerResponse ? { model: opaqueId(providerResponse.model), inputTokens: nonnegative(providerResponse.usage?.input_tokens), cost: nonnegative(providerResponse.usage?.cost) } : {}),
    outcome: "failure", reason, failureClass: reason === "invalid-answer" ? "response-shape" : "provider", latencyMs: elapsed(), actionTaken: "none" })
  if (typeof provider?.decide !== "function") return fail("provider-unavailable")
  let response
  let timer
  let timedOut = false
  const controller = new AbortController()
  try {
    startedAt = performance.now()
    response = await Promise.race([
      provider.decide({ state: boundedState, signal: controller.signal, questions: { [family.questionId]: { type: "choice", instructions: `Classify ${family.id} evidence.`, criteria: Object.fromEntries(family.choices.map((choice) => [choice, choice])) } } }),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("timeout")) }, family.timeoutMs) }),
    ])
  } catch (error) { return fail(timedOut || error?.message === "timeout" ? "timeout" : "provider-error") }
  finally { clearTimeout(timer) }
  if (timedOut) return fail("timeout")
  if (!response?.ok) return fail(failureReasons.has(response?.reason) ? response.reason : "provider-error", response)
  if (modelPin && response.model !== modelPin) return fail("model-mismatch", response)
  const answer = validAnswer(response, family)
  if (!answer) return fail("invalid-answer", response)
  let proposedAction
  try { proposedAction = family.actionPolicy(answer.choice, candidate, family.policyConfig) } catch { return fail("invalid-answer", response) }
  if (proposedAction !== null && !family.allowedActions.includes(proposedAction)) return fail("invalid-answer", response)
  const confidence = answer.probabilities[answer.choice]
  const common = { ...attempted, prediction: answer.choice, probabilities: answer.probabilities, model: opaqueId(response.model), latencyMs: elapsed(), inputTokens: nonnegative(response.usage?.input_tokens), cost: nonnegative(response.usage?.cost) }
  return proposedAction && confidence >= family.threshold
    ? { ...common, outcome: "decision", suggestedAction: proposedAction, actionTaken: "none" }
    : { ...common, outcome: "abstain", reason: proposedAction ? "below-threshold" : "no-permitted-action", actionTaken: "none" }
}
