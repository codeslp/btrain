import { createHash } from "node:crypto"
import { createDecisionFamily, decideCandidate } from "./decision.mjs"

const optionalKind = { dispatch: "artifact", transcript: "transcript" }
const maxItems = 256
const maxCalls = 16
const revisionPattern = /^[a-f0-9]{40}$/
const hashPattern = /^[a-f0-9]{64}$/

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function contextSourceHash(item) {
  return digest({ sourceRef: item.sourceRef, content: item.content, tokens: item.tokens })
}

export function contextManifestHash(sources, objective = "") {
  if (!Array.isArray(sources)) throw new Error("Frozen context sources are required")
  return digest({ objective, sources: [...sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) })
}

function frozenSourceMap(sources, expectedHash, objective) {
  if (!Array.isArray(sources) || !hashPattern.test(expectedHash || "")) return new Map()
  if (sources.some((source) => typeof source?.id !== "string" || !source.id
    || !validSourceRef(source.sourceRef) || !hashPattern.test(source.sourceSnapshotHash || "")
    || typeof source.kind !== "string" || typeof source.evidenceClass !== "string"
    || typeof source.pinned !== "boolean")) return new Map()
  if (new Set(sources.map((source) => source.id)).size !== sources.length) return new Map()
  if (contextManifestHash(sources, objective) !== expectedHash) return new Map()
  return new Map(sources.map((source) => [source.id, source]))
}

function family(id) {
  return createDecisionFamily({
    id,
    questionVersion: "1",
    choices: ["full", "reference", "omit"],
    privacyClass: "private",
    allowedActions: ["select:full", "select:reference", "select:omit"],
    threshold: 0.8,
    maxCalls,
    maxInputBytes: 16 * 1024,
    inputBuilder: (candidate) => ({
      objective: candidate.objective,
      itemKind: candidate.itemKind,
      content: candidate.content,
      tokens: candidate.tokens,
    }),
    actionPolicy: (choice) => `select:${choice}`,
    fallback: () => "full",
  })
}

export const dispatchContextFamily = family("dispatch-context")
export const transcriptContextFamily = family("transcript-context")

function validSourceRef(value) {
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length > maxItems) throw new Error("A bounded item list is required")
  const ids = new Set()
  for (const item of items) {
    if (item && Object.hasOwn(item, "pinned") && typeof item.pinned !== "boolean") {
      throw new Error("Context pin marker must be boolean")
    }
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || typeof item.kind !== "string" || !item.kind
      || typeof item.content !== "string"
      || !Number.isSafeInteger(item.tokens) || item.tokens < 0) {
      throw new Error("Every context item needs a unique ID, kind, content, and nonnegative token estimate")
    }
    ids.add(item.id)
  }
}

// This returns an offline selection proposal. The caller retains and renders its own full packet.
export async function selectContext({ kind, items, objective = "", provider, mode = "off", modelPin = null, codeRevision = null, frozenSources, expectedManifestHash }) {
  if (!Object.hasOwn(optionalKind, kind) || !["off", "offline"].includes(mode)) throw new Error("Only offline dispatch or transcript selection is supported")
  if (typeof objective !== "string" || Buffer.byteLength(objective) > 1024) throw new Error("A bounded objective is required")
  if (mode === "offline" && (typeof modelPin !== "string" || !modelPin || !revisionPattern.test(codeRevision || ""))) {
    throw new Error("Offline selection requires a pinned model and code revision")
  }
  validateItems(items)
  const sourceMap = frozenSourceMap(frozenSources, expectedManifestHash, objective)
  const optionalClass = kind === "dispatch" ? "low-risk-artifact" : "older-transcript"
  const itemIds = new Set(items.map((item) => item.id))
  if ([...sourceMap.values()].some((source) => !itemIds.has(source.id)
    && (source.pinned || source.kind !== optionalKind[kind] || source.evidenceClass !== optionalClass))) {
    throw new Error("A required context item is missing from the frozen packet")
  }
  const decisionFamily = kind === "dispatch" ? dispatchContextFamily : transcriptContextFamily
  const selections = []
  const traces = []
  let calls = 0
  for (const item of items) {
    const frozenSource = sourceMap.get(item.id)
    const required = item.pinned === true || item.kind !== optionalKind[kind]
      || item.evidenceClass !== optionalClass || frozenSource?.kind !== item.kind
      || frozenSource?.evidenceClass !== optionalClass || frozenSource?.pinned !== false
    let selection = "full"
    const eligible = !required && frozenSource?.sourceRef === item.sourceRef
      && frozenSource?.sourceSnapshotHash === contextSourceHash(item)
    const trace = await decideCandidate({
      family: decisionFamily,
      candidate: {
        eligible,
        sourceRefs: validSourceRef(item.sourceRef) ? [item.sourceRef] : [],
        baseline: "full",
        privacyClass: "private",
        callIndex: calls,
        objective,
        itemKind: item.kind,
        content: item.content,
        tokens: item.tokens,
      },
      provider,
      mode,
      modelPin,
      codeRevision,
    })
    traces.push(trace)
    if (trace.attemptedCall) calls += 1
    if (!required && trace.outcome === "decision") selection = trace.suggestedAction.slice("select:".length)
    selections.push(selection === "full"
      ? { id: item.id, selection }
      : { id: item.id, selection, sourceSnapshotHash: sourceMap.get(item.id).sourceSnapshotHash })
  }
  return { kind, familyPolicyHash: decisionFamily.policyHash, modelPin, codeRevision, selections, traces }
}
