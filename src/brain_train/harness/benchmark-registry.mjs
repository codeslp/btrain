import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  HARNESS_TRACE_FAILURE_CATEGORIES,
  HARNESS_TRACE_OUTCOMES,
} from "./trace-bundle.mjs"

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_BENCHMARKS_DIR = path.join(HARNESS_DIR, "benchmarks")

export const BENCHMARK_SCENARIO_VERSION = 1

export const BENCHMARK_SCENARIO_CATEGORIES = Object.freeze([
  "writer-path",
  "reviewer-path",
  "changes-requested-loop",
  "repair-needed",
  "delegation-fidelity",
  "bootstrap-efficiency",
  "diffless-evidence",
  "cold-start-adoption",
  "delegation-delivery",
])

const BENCHMARK_CATEGORY_SET = new Set(BENCHMARK_SCENARIO_CATEGORIES)
const TRACE_OUTCOME_SET = new Set(HARNESS_TRACE_OUTCOMES)
const FAILURE_CATEGORY_SET = new Set(HARNESS_TRACE_FAILURE_CATEGORIES)

class BtrainError extends Error {
  constructor({ message, reason, fix, context }) {
    const parts = [`✖ ${message}`]
    if (reason)  parts.push(`  ↳ Why: ${reason}`)
    if (fix)     parts.push(`  ✦ Fix: ${fix}`)
    if (context) parts.push(`  ℹ ${context}`)
    super(parts.join("\n"))
    this.name = "BtrainError"
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  return [...new Set(source.map((item) => normalizeText(item)).filter(Boolean))]
}

export function normalizeBenchmarkScenarioId(value) {
  if (typeof value !== "string") return null
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || null
}

function normalizeCategory(value, fallback = "writer-path") {
  const normalized = normalizeText(value)
  if (BENCHMARK_CATEGORY_SET.has(normalized)) return normalized
  return BENCHMARK_CATEGORY_SET.has(fallback) ? fallback : "writer-path"
}

function normalizeExpectedPrimaryOutcome(value, fallback = "pass") {
  const normalized = normalizeText(value)
  if (TRACE_OUTCOME_SET.has(normalized)) return normalized
  return TRACE_OUTCOME_SET.has(fallback) ? fallback : "pass"
}

function normalizeHardFailureCategories(value) {
  const entries = normalizeStringList(value)
  const valid = entries.filter((entry) => FAILURE_CATEGORY_SET.has(entry))
  valid.sort()
  return valid
}

function normalizeArtifactRef(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return null
  const kind = normalizeText(reference.kind) || "artifact"
  const label = normalizeText(reference.label)
  const refPath = normalizeText(reference.path)
  const note = normalizeText(reference.note)
  if (!label && !refPath && !note) return null
  return { kind, label, path: refPath, note }
}

function normalizeArtifactRefs(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const entry of value) {
    const normalized = normalizeArtifactRef(entry)
    if (!normalized) continue
    const key = [normalized.kind, normalized.label, normalized.path, normalized.note].join("\u0000")
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function normalizeBenchmarkScenario(raw = {}, { sourcePath, source, fallbackId } = {}) {
  const scenario = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  const id = normalizeBenchmarkScenarioId(scenario.id) || fallbackId
  if (!id) {
    throw new BtrainError({
      message: `Benchmark scenario at ${sourcePath || "(unknown path)"} is missing an id.`,
      reason: "Every benchmark scenario requires a non-empty, slug-normalizable id.",
      fix: 'Add an "id" string field (e.g. "writer-lane-discipline") to the manifest.',
    })
  }

  return {
    version: typeof scenario.version === "number" ? scenario.version : BENCHMARK_SCENARIO_VERSION,
    id,
    category: normalizeCategory(scenario.category),
    label: normalizeText(scenario.label),
    description: normalizeText(scenario.description),
    purpose: normalizeText(scenario.purpose),
    profileRefs: normalizeStringList(scenario.profileRefs || scenario.profiles),
    tags: normalizeStringList(scenario.tags),
    expectedPrimaryOutcome: normalizeExpectedPrimaryOutcome(
      scenario.expectedPrimaryOutcome || scenario.primaryOutcome,
    ),
    hardFailureCategories: normalizeHardFailureCategories(
      scenario.hardFailureCategories || scenario.hardFailures,
    ),
    requiresDiff: scenario.requiresDiff === undefined ? true : !!scenario.requiresDiff,
    requiresDelegationAcknowledgement: !!scenario.requiresDelegationAcknowledgement,
    artifactRefs: normalizeArtifactRefs(scenario.artifactRefs || scenario.artifacts),
    source: normalizeText(scenario.source) || source || "",
    sourcePath: sourcePath || "",
  }
}

async function parseJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8")
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new BtrainError({
      message: `Malformed benchmark scenario JSON at ${filePath}.`,
      reason: error?.message || "JSON.parse failed.",
      fix: `Repair the JSON syntax in ${filePath}.`,
    })
  }
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function getRepoHarnessDir(repoRoot) {
  return path.join(repoRoot, ".btrain", "harness")
}

function getRepoBenchmarksDir(repoRoot) {
  return path.join(getRepoHarnessDir(repoRoot), "benchmarks")
}

async function discoverScenariosInDir(scenariosDir, source) {
  if (!(await pathExists(scenariosDir))) return []

  const entries = await fs.readdir(scenariosDir, { withFileTypes: true })
  const scenarios = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const filePath = path.join(scenariosDir, entry.name)
    const fallbackId = normalizeBenchmarkScenarioId(path.basename(entry.name, ".json"))
    const parsed = await parseJsonFile(filePath)
    scenarios.push(
      normalizeBenchmarkScenario(parsed, {
        sourcePath: filePath,
        source,
        fallbackId,
      }),
    )
  }
  return scenarios.sort((left, right) => left.id.localeCompare(right.id))
}

function mergeScenarios(...groups) {
  const merged = new Map()
  for (const group of groups) {
    for (const scenario of group || []) {
      if (!scenario?.id) continue
      merged.set(scenario.id, scenario)
    }
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export async function loadBenchmarkRegistry({ repoRoot = "" } = {}) {
  const bundled = await discoverScenariosInDir(BUNDLED_BENCHMARKS_DIR, "bundled")
  const repoLocalDir = repoRoot ? getRepoBenchmarksDir(repoRoot) : ""
  const repoLocalDirExists = repoLocalDir ? await pathExists(repoLocalDir) : false
  const repoLocal = repoLocalDirExists ? await discoverScenariosInDir(repoLocalDir, "repo-local") : []

  return {
    version: String(BENCHMARK_SCENARIO_VERSION),
    scenariosDirs: {
      bundled: BUNDLED_BENCHMARKS_DIR,
      repoLocal: repoLocalDirExists ? repoLocalDir : "",
    },
    categories: [...BENCHMARK_SCENARIO_CATEGORIES],
    hardFailureCategories: [...HARNESS_TRACE_FAILURE_CATEGORIES],
    outcomes: [...HARNESS_TRACE_OUTCOMES],
    scenarios: mergeScenarios(bundled, repoLocal),
  }
}

export async function listBenchmarkScenarios({ repoRoot = "", category } = {}) {
  const registry = await loadBenchmarkRegistry({ repoRoot })
  const filter = normalizeText(category)
  const scenarios = filter
    ? registry.scenarios.filter((scenario) => scenario.category === filter)
    : registry.scenarios
  return { ...registry, scenarios, filterCategory: filter || "" }
}

export async function inspectBenchmarkScenario({ repoRoot = "", scenarioId } = {}) {
  const normalizedId = normalizeBenchmarkScenarioId(scenarioId)
  if (!normalizedId) {
    throw new BtrainError({
      message: "Benchmark scenario id is required.",
      reason: "inspectBenchmarkScenario received an empty or invalid scenarioId.",
      fix: "btrain harness eval inspect --scenario <id> --repo .",
    })
  }

  const registry = await loadBenchmarkRegistry({ repoRoot })
  const scenario = registry.scenarios.find((entry) => entry.id === normalizedId)
  if (!scenario) {
    throw new BtrainError({
      message: `Unknown benchmark scenario "${normalizedId}".`,
      reason: "No bundled or repo-local manifest matched the requested id.",
      fix: "Run `btrain harness eval list --repo .` to see available scenarios.",
    })
  }

  return { ...registry, scenario }
}
