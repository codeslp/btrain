import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const outcomes = new Set(["off", "offline"])
const failureReasons = new Set(["timeout", "authentication-error", "rate-limit", "provider-error", "http-error", "network-error", "invalid-response", "invalid-request", "disabled"])

function safeRefs(refs) {
  if (!Array.isArray(refs)) return []
  return refs.slice(0, 16).flatMap((ref) => {
    try {
      const url = new URL(ref)
      if (!["https:", "http:"].includes(url.protocol)) return []
      url.username = ""
      url.password = ""
      url.search = ""
      url.hash = ""
      return [url.toString()]
    } catch { return [] }
  })
}

export function createDecisionFamily(config) {
  const { id, questionVersion, choices, privacyClass, allowedActions, threshold, inputBuilder, actionPolicy, fallback } = config
  if (!id || !questionVersion || !Array.isArray(choices) || choices.length < 2 || new Set(choices).size !== choices.length) throw new Error("A versioned closed choice family is required")
  if (!["public", "synthetic", "private"].includes(privacyClass)) throw new Error("A privacy class is required")
  if (!Array.isArray(allowedActions) || typeof inputBuilder !== "function" || typeof actionPolicy !== "function" || typeof fallback !== "function") throw new Error("Family input, action, and fallback policies are required")
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Invalid decision threshold")
  const family = { id, questionVersion, choices: [...choices], privacyClass, allowedActions: [...allowedActions], threshold, inputBuilder, actionPolicy, fallback, questionId: config.questionId || "signal", timeoutMs: config.timeoutMs || 2000, maxInputBytes: config.maxInputBytes || 16 * 1024, maxCalls: config.maxCalls || 1 }
  family.policyHash = hash({ id, questionVersion, choices, privacyClass, allowedActions, threshold, questionId: family.questionId, timeoutMs: family.timeoutMs, maxInputBytes: family.maxInputBytes, maxCalls: family.maxCalls, inputBuilder: inputBuilder.toString(), actionPolicy: actionPolicy.toString(), fallback: fallback.toString() })
  return Object.freeze(family)
}

export function fakeProvider(result) {
  return { localOnly: true, decide: async () => structuredClone(result) }
}

export async function appendDecisionTrace(root, trace) {
  if (!trace || !["skipped", "decision", "abstain", "failure"].includes(trace.outcome)) throw new Error("A gateway trace is required")
  const allowed = ["family", "questionVersion", "policyHash", "codeRevision", "sourceRefs", "baseline", "actionTaken", "outcome", "reason", "attemptedCall", "inputHash", "provider", "modelPin", "failureClass", "latencyMs", "prediction", "probabilities", "model", "inputTokens", "cost", "suggestedAction"]
  const record = Object.fromEntries(allowed.filter((key) => Object.hasOwn(trace, key)).map((key) => [key, trace[key]]))
  record.sourceRefs = safeRefs(record.sourceRefs)
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
  const sourceRefs = safeRefs(candidate?.sourceRefs)
  const base = { family: family.id, questionVersion: family.questionVersion, policyHash: family.policyHash, codeRevision, sourceRefs, baseline: family.fallback(candidate?.baseline), actionTaken: "none" }
  const skip = (reason) => ({ ...base, outcome: "skipped", reason, attemptedCall: false })
  if (mode === "off") return skip("mode-off")
  if (!candidate?.eligible) return skip("ineligible")
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
  const attempted = { ...base, inputHash, provider: provider?.id || "injected", modelPin, attemptedCall: true }
  const fail = (reason, latencyMs = null) => ({ ...attempted, outcome: "failure", reason, failureClass: reason === "invalid-answer" ? "response-shape" : "provider", latencyMs, actionTaken: "none" })
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
  const common = { ...attempted, prediction: answer.choice, probabilities: answer.probabilities, model: response.model || null, latencyMs: response.latencyMs ?? null, inputTokens: Number.isFinite(response.usage?.input_tokens) ? response.usage.input_tokens : null, cost: Number.isFinite(response.usage?.cost) ? response.usage.cost : null }
  return proposedAction && confidence >= family.threshold
    ? { ...common, outcome: "decision", suggestedAction: proposedAction, actionTaken: "none" }
    : { ...common, outcome: "abstain", reason: proposedAction ? "below-threshold" : "no-permitted-action", actionTaken: "none" }
}
