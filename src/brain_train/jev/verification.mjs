import { createDecisionFamily, decideCandidate } from "./decision.mjs"

export const VERIFICATION_CATALOG = Object.freeze([
  "unit",
  "integration",
  "negative-path",
  "migration-safety",
  "security-boundary",
  "formal-witness",
])

const contractTags = new Set(["cross-component", "negative-path", "migration", "security", "formal-impact"])
const maxPaths = 256

function changePaths(change) {
  if (!Array.isArray(change?.changedPaths) || !change.changedPaths.length
    || change.changedPaths.some((value) => typeof value !== "string" || !value)) {
    throw new Error("Changed paths are required")
  }
  return change.changedPaths
}

function tagsFor(change) {
  return Array.isArray(change?.contractTags)
    ? change.contractTags.filter((tag) => contractTags.has(tag))
    : []
}

export function mandatoryVerificationChecks(change) {
  const paths = changePaths(change)
  const tags = new Set(tagsFor(change))
  const required = new Set()
  if (paths.some((file) => file.startsWith("src/"))) required.add("unit")
  if (tags.has("cross-component")) required.add("integration")
  if (tags.has("negative-path")) required.add("negative-path")
  if (tags.has("migration") || paths.some((file) => file.startsWith("migrations/") && file.endsWith(".sql"))) required.add("migration-safety")
  if (tags.has("security") || paths.some((file) => /(^|\/)(auth|payment|entitlement)(\/|[.-])/i.test(file))) required.add("security-boundary")
  if (tags.has("formal-impact") || paths.some((file) => file.endsWith(".tla") || file.startsWith("formal/"))) required.add("formal-witness")
  return VERIFICATION_CATALOG.filter((check) => required.has(check))
}

export const verificationFamily = createDecisionFamily({
  id: "verification-planner",
  questionVersion: "1",
  questionId: "signal",
  choices: [...VERIFICATION_CATALOG, "none"],
  privacyClass: "private",
  allowedActions: VERIFICATION_CATALOG.map((check) => `check:${check}`),
  threshold: 0.8,
  maxCalls: 3,
  maxInputBytes: 16 * 1024,
  inputBuilder: (candidate) => ({
    changedPaths: candidate.changedPaths,
    contractTags: candidate.contractTags,
    selectedChecks: [...candidate.selectedChecks],
  }),
  actionPolicy: (choice, candidate) => choice === "none" || candidate.selectedChecks.includes(choice) ? null : `check:${choice}`,
  fallback: (baseline) => baseline,
})

export async function planVerification({ change, provider, mode = "off" }) {
  const paths = changePaths(change)
  const mandatory = mandatoryVerificationChecks(change)
  const suggested = []
  const traces = []
  for (let callIndex = 0; callIndex < verificationFamily.maxCalls; callIndex += 1) {
    const selectedChecks = [...mandatory, ...suggested]
    const candidate = {
      eligible: paths.length <= maxPaths && VERIFICATION_CATALOG.some((check) => !selectedChecks.includes(check)),
      sourceRefs: change.sourceRefs,
      baseline: "none",
      privacyClass: "private",
      callIndex,
      changedPaths: paths,
      contractTags: tagsFor(change),
      selectedChecks,
    }
    const trace = await decideCandidate({ family: verificationFamily, candidate, provider, mode })
    traces.push(trace)
    if (trace.outcome !== "decision") break
    const check = trace.suggestedAction?.slice("check:".length)
    if (!VERIFICATION_CATALOG.includes(check) || mandatory.includes(check) || suggested.includes(check)) break
    suggested.push(check)
  }
  return { mandatory, suggested, checks: [...mandatory, ...suggested], traces }
}
