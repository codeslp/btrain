import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { sourceSnapshotHashFor } from "./manifest.mjs"

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const outcomes = new Set(["off", "offline"])
const failureReasons = new Set(["timeout", "authentication-error", "rate-limit", "provider-error", "http-error", "network-error", "invalid-response", "invalid-request", "disabled"])
const traceReasons = new Set(["mode-off", "ineligible", "invalid-baseline", "privacy-denied", "call-budget", "invalid-source-reference", "invalid-input", "input-budget", "provider-unavailable", "timeout", "authentication-error", "rate-limit", "provider-error", "http-error", "network-error", "invalid-response", "invalid-request", "disabled", "model-mismatch", "invalid-answer", "below-threshold", "no-permitted-action"])
const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null

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

export function createDecisionFamily(config) {
  const { id, questionVersion, choices, privacyClass, allowedActions, threshold, inputBuilder, actionPolicy, fallback } = config
  if (!id || !questionVersion || !Array.isArray(choices) || choices.length < 2 || new Set(choices).size !== choices.length) throw new Error("A versioned closed choice family is required")
  if (!["public", "synthetic", "private"].includes(privacyClass)) throw new Error("A privacy class is required")
  if (!Array.isArray(allowedActions) || typeof inputBuilder !== "function" || typeof actionPolicy !== "function" || typeof fallback !== "function") throw new Error("Family input, action, and fallback policies are required")
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Invalid decision threshold")
  const family = { id, questionVersion, choices: Object.freeze([...choices]), privacyClass, allowedActions: Object.freeze([...allowedActions]), threshold, inputBuilder, actionPolicy, fallback, questionId: config.questionId || "signal", timeoutMs: config.timeoutMs || 2000, maxInputBytes: config.maxInputBytes || 16 * 1024, maxCalls: config.maxCalls || 1 }
  family.policyHash = hash({ id, questionVersion, choices, privacyClass, allowedActions, threshold, questionId: family.questionId, timeoutMs: family.timeoutMs, maxInputBytes: family.maxInputBytes, maxCalls: family.maxCalls, inputBuilder: inputBuilder.toString(), actionPolicy: actionPolicy.toString(), fallback: fallback.toString() })
  return Object.freeze(family)
}

export function fakeProvider(result) {
  return { localOnly: true, decide: async () => structuredClone(result) }
}

export async function appendDecisionTrace(root, trace, family, sourceProof) {
  if (!trace || !["skipped", "decision", "abstain", "failure"].includes(trace.outcome)) throw new Error("A gateway trace is required")
  if (!family || trace.family !== family.id || trace.policyHash !== family.policyHash) throw new Error("A matching decision family is required")
  const traceRefs = opaqueRefs(trace.sourceRefs)
  let validProof = false
  try {
    validProof = Array.isArray(sourceProof?.sources)
      && sourceProof.sourceSnapshotHash === sourceSnapshotHashFor(sourceProof.sources)
  } catch { validProof = false }
  const verifiedRefs = validProof ? new Set(opaqueRefs(sourceProof.sources.map((source) => source.sourceRef))) : new Set()
  if (!validProof || (trace.outcome !== "skipped" && !traceRefs.length)
    || traceRefs.some((ref) => !verifiedRefs.has(ref))) {
    throw new Error("Trace source provenance does not match frozen evidence")
  }
  const record = {
    family: family.id,
    questionVersion: family.questionVersion,
    policyHash: family.policyHash,
    codeRevision: /^[a-f0-9]{40}$/.test(trace.codeRevision || "") ? trace.codeRevision : null,
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

function validAnswer(response, family) {
  const answer = response?.answers?.[family.questionId]
  if (!answer || !family.choices.includes(answer.choice) || !answer.probabilities || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) return null
  const keys = Object.keys(answer.probabilities)
  if (keys.length !== family.choices.length || keys.some((key) => !family.choices.includes(key))) return null
  const values = family.choices.map((choice) => answer.probabilities[choice])
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return null
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02) return null
  return { choice: answer.choice, probabilities: Object.fromEntries(family.choices.map((choice) => [choice, answer.probabilities[choice]])) }
}

export async function decideCandidate({ family, candidate, provider, mode = "off", privacyApproved = false, modelPin = null, codeRevision = null }) {
  if (!outcomes.has(mode)) throw new Error("Decision gateway supports only off or offline mode")
  const sourceRefs = opaqueRefs(candidate?.sourceRefs)
  let baseline
  try {
    const result = family.fallback(candidate?.baseline)
    baseline = family.choices.includes(result) ? result : null
  } catch { baseline = null }
  const base = { family: family.id, questionVersion: family.questionVersion, policyHash: family.policyHash, codeRevision: /^[a-f0-9]{40}$/.test(codeRevision || "") ? codeRevision : null, sourceRefs, baseline, actionTaken: "none" }
  const skip = (reason) => ({ ...base, outcome: "skipped", reason, attemptedCall: false })
  if (mode === "off") return skip("mode-off")
  if (!candidate?.eligible) return skip("ineligible")
  if (!baseline) return skip("invalid-baseline")
  if ((family.privacyClass === "private" || candidate.privacyClass === "private") && !privacyApproved && provider?.localOnly !== true) return skip("privacy-denied")
  if (candidate.callIndex >= family.maxCalls) return skip("call-budget")
  if (!sourceRefs.length) return skip("invalid-source-reference")
  let boundedState
  let encoded
  try {
    boundedState = family.inputBuilder(candidate)
    encoded = JSON.stringify(boundedState)
  } catch { return skip("invalid-input") }
  if (!encoded || Buffer.byteLength(encoded) > family.maxInputBytes) return skip("input-budget")
  const inputHash = hash(boundedState)
  const attempted = { ...base, inputHash, provider: opaqueId(provider?.id || "injected"), modelPin: opaqueId(modelPin), attemptedCall: true }
  const fail = (reason, latencyMs = null) => ({ ...attempted, outcome: "failure", reason, failureClass: reason === "invalid-answer" ? "response-shape" : "provider", latencyMs: nonnegative(latencyMs), actionTaken: "none" })
  if (typeof provider?.decide !== "function") return fail("provider-unavailable")
  let response
  let timer
  try {
    response = await Promise.race([
      provider.decide({ state: boundedState, questions: { [family.questionId]: { type: "choice", instructions: `Classify ${family.id} evidence.`, criteria: Object.fromEntries(family.choices.map((choice) => [choice, choice])) } } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), family.timeoutMs) }),
    ])
  } catch (error) { return fail(error?.message === "timeout" ? "timeout" : "provider-error") }
  finally { clearTimeout(timer) }
  if (!response?.ok) return fail(failureReasons.has(response?.reason) ? response.reason : "provider-error", response?.latencyMs ?? null)
  if (modelPin && response.model !== modelPin) return fail("model-mismatch", response.latencyMs ?? null)
  const answer = validAnswer(response, family)
  if (!answer) return fail("invalid-answer", response.latencyMs ?? null)
  let proposedAction
  try { proposedAction = family.actionPolicy(answer.choice) } catch { return fail("invalid-answer", response.latencyMs ?? null) }
  if (proposedAction !== null && !family.allowedActions.includes(proposedAction)) return fail("invalid-answer", response.latencyMs ?? null)
  const confidence = answer.probabilities[answer.choice]
  const common = { ...attempted, prediction: answer.choice, probabilities: answer.probabilities, model: opaqueId(response.model), latencyMs: nonnegative(response.latencyMs), inputTokens: nonnegative(response.usage?.input_tokens), cost: nonnegative(response.usage?.cost) }
  return proposedAction && confidence >= family.threshold
    ? { ...common, outcome: "decision", suggestedAction: proposedAction, actionTaken: "none" }
    : { ...common, outcome: "abstain", reason: proposedAction ? "below-threshold" : "no-permitted-action", actionTaken: "none" }
}
