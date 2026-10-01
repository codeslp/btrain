import { createDecisionFamily, createDecisionRun, decideCandidate } from "./decision.mjs"
import { boundedString, validRecordRef, readFrozenRecord, frozenRecordRules } from "./frozen-record.mjs"

const maxRules = 32
const maxArtifacts = 32
const maxChecks = 64
const maxCalls = 16
const choices = ["violation", "conforming", "uncertain"]

function validateRules(record) {
  if (!["diff", "turn"].includes(record.kind) || !Array.isArray(record.rules) || record.rules.length > maxRules
    || !Array.isArray(record.artifacts) || record.artifacts.length > maxArtifacts
    || !Array.isArray(record.checks) || record.checks.length > maxChecks) {
    throw new Error("A bounded explicit-rule catalog and focused diff or turn record are required")
  }
  const ruleIds = new Set()
  for (const rule of record.rules) {
    if (!boundedString(rule?.id, 128) || ruleIds.has(rule.id) || !boundedString(rule.version, 128)
      || !boundedString(rule.text) || !validRecordRef(rule.sourceRef)
      || ["explicit", "authorized"].some((key) => rule[key] !== undefined && typeof rule[key] !== "boolean")) {
      throw new Error("Rules require unique IDs, versions, bounded text and source references")
    }
    ruleIds.add(rule.id)
  }
  const artifactIds = new Set()
  for (const artifact of record.artifacts) {
    if (!boundedString(artifact?.id, 128) || artifactIds.has(artifact.id) || artifact.kind !== record.kind
      || !boundedString(artifact.text, 8192) || !validRecordRef(artifact.sourceRef)
      || (artifact.authorized !== undefined && typeof artifact.authorized !== "boolean")) {
      throw new Error("Artifacts require unique IDs, matching kind, bounded text and source references")
    }
    artifactIds.add(artifact.id)
  }
  const pairs = new Set()
  for (const check of record.checks) {
    const pair = JSON.stringify([check?.ruleId, check?.artifactId])
    if (!ruleIds.has(check?.ruleId) || !artifactIds.has(check?.artifactId) || pairs.has(pair)
      || !choices.includes(check.baseline)
      || (check.applicable !== undefined && typeof check.applicable !== "boolean")) {
      throw new Error("Every check needs a unique supplied rule/artifact pair and a closed baseline")
    }
    pairs.add(pair)
  }
}

function checkEligible(rule, artifact, check) {
  return rule?.explicit === true && rule.authorized === true && artifact?.authorized === true && check?.applicable === true
}

function ruleFamily(kind, id) {
  return createDecisionFamily({
    id, questionVersion: "1", policyVersion: "1",
    policyConfig: { kind, maxRules, maxArtifacts, maxChecks, maxCalls, frozenRecordRules,
      ruleChecks: [validateRules, checkEligible, inspectRules].map((rule) => rule.toString()).join("\n") },
    choices,
    privacyClass: "private",
    allowedActions: ["rule:warn", "rule:retain"],
    threshold: 0.85,
    maxCalls,
    maxInputBytes: 16 * 1024,
    inputBuilder: (candidate) => ({
      kind: candidate.kind,
      rule: { id: candidate.rule.id, version: candidate.rule.version, text: candidate.rule.text, sourceRef: candidate.rule.sourceRef },
      artifact: { id: candidate.artifact.id, text: candidate.artifact.text, sourceRef: candidate.artifact.sourceRef },
    }),
    actionPolicy: (choice) => {
      if (choice === "uncertain") return null
      return choice === "violation" ? "rule:warn" : "rule:retain"
    },
    fallback: (baseline) => baseline,
  })
}

export const repositoryRuleFamily = ruleFamily("diff", "repository-rules")
export const turnRuleFamily = ruleFamily("turn", "end-of-turn-rules")

// A typed finding is a reviewer candidate, never an approval, rejection or automatic repair.
export async function inspectRules({ source, sourceProof, provider, mode = "off", modelPin = null, codeRevision = null }) {
  const { record, candidateSource, proof } = readFrozenRecord({ source, sourceProof, mode })
  validateRules(record)
  const family = record.kind === "diff" ? repositoryRuleFamily : turnRuleFamily
  const rules = new Map(record.rules.map((rule) => [rule.id, rule]))
  const artifacts = new Map(record.artifacts.map((artifact) => [artifact.id, artifact]))
  const run = createDecisionRun(family)
  const warnings = []
  const assessments = []
  const traces = []
  let calls = 0
  for (const check of record.checks.length ? record.checks : [null]) {
    const rule = rules.get(check?.ruleId)
    const artifact = artifacts.get(check?.artifactId)
    const trace = await decideCandidate({
      family, run, provider, mode, modelPin, codeRevision, sourceProof: proof,
      candidate: { ...candidateSource, kind: record.kind, rule, artifact,
        eligible: checkEligible(rule, artifact, check), baseline: check?.baseline ?? "uncertain",
        privacyClass: "private", callIndex: calls },
    })
    traces.push(trace)
    if (trace.attemptedCall) calls += 1
    if (check) assessments.push({ ruleId: rule.id, artifactId: artifact.id, outcome: trace.outcome, prediction: trace.prediction ?? null })
    if (trace.outcome === "decision" && trace.suggestedAction === "rule:warn") {
      warnings.push({ kind: "possible-rule-violation", ruleId: rule.id, ruleVersion: rule.version,
        ruleSourceRef: rule.sourceRef, artifactId: artifact.id, artifactSourceRef: artifact.sourceRef })
    }
  }
  return { family: family.id, warnings, assessments, traces }
}
