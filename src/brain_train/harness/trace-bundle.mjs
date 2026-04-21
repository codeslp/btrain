import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  buildTaskArtifactEnvelope,
  createEmptyTaskArtifactEnvelope,
} from "./task-envelope.mjs"

export const TRACE_BUNDLE_VERSION = 1

export const HARNESS_TRACE_OUTCOMES = Object.freeze([
  "pass",
  "fail",
  "error",
  "skipped",
])

export const HARNESS_TRACE_FAILURE_CATEGORIES = Object.freeze([
  "timeout",
  "review-miss",
  "routing-error",
  "workflow-violation",
  "insufficient-context",
  "delivery-failure",
  "acknowledgement-missing",
  "artifact-missing",
  "unknown",
])

const HARNESS_TRACE_OUTCOME_SET = new Set(HARNESS_TRACE_OUTCOMES)
const HARNESS_TRACE_FAILURE_CATEGORY_SET = new Set(HARNESS_TRACE_FAILURE_CATEGORIES)

const RUN_ID_PATTERN = /^run_\d{8}T\d{6}Z_[a-z0-9]{6,}$/

class BtrainError extends Error {
  constructor({ message, reason, fix, context }) {
    const parts = [`✖ ${message}`]
    if (reason) parts.push(`  ↳ Why: ${reason}`)
    if (fix) parts.push(`  ✦ Fix: ${fix}`)
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

function normalizeMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    const trimmedKey = normalizeText(key)
    if (!trimmedKey) continue
    if (typeof raw === "number" && Number.isFinite(raw)) out[trimmedKey] = raw
    else if (typeof raw === "boolean") out[trimmedKey] = raw
    else if (typeof raw === "string" && raw.trim()) out[trimmedKey] = raw.trim()
  }
  return out
}

export function isHarnessTraceOutcome(value) {
  return HARNESS_TRACE_OUTCOME_SET.has(normalizeText(value))
}

export function isHarnessTraceFailureCategory(value) {
  return HARNESS_TRACE_FAILURE_CATEGORY_SET.has(normalizeText(value))
}

export function normalizeHarnessTraceOutcome(value, fallback = "fail") {
  const normalized = normalizeText(value)
  if (HARNESS_TRACE_OUTCOME_SET.has(normalized)) return normalized
  return HARNESS_TRACE_OUTCOME_SET.has(fallback) ? fallback : "fail"
}

export function normalizeHarnessTraceFailureCategory(value, fallback = "unknown") {
  const normalized = normalizeText(value)
  if (HARNESS_TRACE_FAILURE_CATEGORY_SET.has(normalized)) return normalized
  return HARNESS_TRACE_FAILURE_CATEGORY_SET.has(fallback) ? fallback : "unknown"
}

function getHarnessDir(repoRoot) {
  if (!repoRoot) {
    throw new BtrainError({
      message: "Harness trace bundle requires a repoRoot.",
      reason: "No repoRoot was provided to the trace bundle API.",
      fix: "Pass { repoRoot } pointing at the target btrain repo root.",
    })
  }
  return path.join(repoRoot, ".btrain", "harness")
}

function getRunsDir(repoRoot) {
  return path.join(getHarnessDir(repoRoot), "runs")
}

function getIndexPath(repoRoot) {
  return path.join(getHarnessDir(repoRoot), "index.jsonl")
}

export function getTraceBundleDir(repoRoot, runId) {
  return path.join(getRunsDir(repoRoot), runId)
}

function formatRunIdTimestamp(date) {
  const iso = date.toISOString().replace(/[-:.]/g, "")
  return iso.slice(0, 15) + "Z"
}

export function generateTraceRunId({ startedAt, suffix } = {}) {
  const date = startedAt ? new Date(startedAt) : new Date()
  if (Number.isNaN(date.getTime())) {
    throw new BtrainError({
      message: "Invalid startedAt for trace run id.",
      reason: `Could not parse "${startedAt}" as a Date.`,
      fix: "Pass an ISO timestamp or a Date instance.",
    })
  }
  const stamp = formatRunIdTimestamp(date)
  const tail = normalizeText(suffix) || crypto.randomBytes(4).toString("hex")
  return `run_${stamp}_${tail}`
}

export function isValidTraceRunId(value) {
  return typeof value === "string" && RUN_ID_PATTERN.test(value)
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp.${crypto.randomBytes(4).toString("hex")}`
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await fs.rename(tmpPath, filePath)
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8")
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === "ENOENT") return null
    throw err
  }
}

export function normalizeAgentCardRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { agentName: "", role: "", summary: "" }
  }
  const agentName = normalizeText(value.agentName || value.name)
  const role = normalizeText(value.role)
  const summary = normalizeText(value.summary || value.description)
  return { agentName, role, summary }
}

function hasAgentCardRefContent(ref) {
  return !!(ref && (ref.agentName || ref.role || ref.summary))
}

function buildBundleSkeleton({
  runId,
  scenarioId,
  profileId,
  kind,
  startedAt,
  context,
  taskEnvelope,
  agentCardRef,
}) {
  return {
    version: TRACE_BUNDLE_VERSION,
    runId,
    scenarioId: normalizeText(scenarioId),
    profileId: normalizeText(profileId),
    kind: normalizeText(kind) || "harness-run",
    startedAt,
    endedAt: "",
    outcome: "",
    failureCategory: "",
    summary: "",
    metrics: {},
    artifactRefs: [],
    context: context && typeof context === "object" && !Array.isArray(context) ? { ...context } : {},
    taskEnvelope: taskEnvelope
      ? buildTaskArtifactEnvelope(taskEnvelope)
      : createEmptyTaskArtifactEnvelope(),
    agentCardRef: normalizeAgentCardRef(agentCardRef),
  }
}

export async function createTraceBundle({
  repoRoot,
  runId,
  scenarioId = "",
  profileId = "",
  kind = "harness-run",
  startedAt,
  context,
  taskEnvelope,
  agentCardRef,
} = {}) {
  const harnessDir = getHarnessDir(repoRoot)
  const runsDir = getRunsDir(repoRoot)
  await ensureDir(harnessDir)
  await ensureDir(runsDir)

  const resolvedStartedAt = startedAt || new Date().toISOString()
  const resolvedRunId = normalizeText(runId) || generateTraceRunId({ startedAt: resolvedStartedAt })
  if (!isValidTraceRunId(resolvedRunId)) {
    throw new BtrainError({
      message: `Invalid trace run id "${resolvedRunId}".`,
      reason: "Run ids must match run_<YYYYMMDDTHHMMSSZ>_<hex>.",
      fix: "Omit runId to auto-generate, or pass generateTraceRunId() output.",
    })
  }

  const bundleDir = getTraceBundleDir(repoRoot, resolvedRunId)
  const existingMarker = path.join(bundleDir, "summary.json")
  if (await readJsonIfExists(existingMarker)) {
    throw new BtrainError({
      message: `Trace bundle "${resolvedRunId}" already exists.`,
      reason: `A summary.json already lives under ${bundleDir}.`,
      fix: "Generate a new run id or remove the existing bundle directory.",
    })
  }

  await ensureDir(path.join(bundleDir, "events"))
  await ensureDir(path.join(bundleDir, "artifacts"))
  await ensureDir(path.join(bundleDir, "prompts"))

  const skeleton = buildBundleSkeleton({
    runId: resolvedRunId,
    scenarioId,
    profileId,
    kind,
    startedAt: resolvedStartedAt,
    context,
    taskEnvelope,
    agentCardRef,
  })
  await writeJsonAtomic(path.join(bundleDir, "summary.json"), skeleton)

  return {
    runId: resolvedRunId,
    bundleDir,
    harnessDir,
    summaryPath: path.join(bundleDir, "summary.json"),
    eventsPath: path.join(bundleDir, "events", "events.jsonl"),
    artifactsDir: path.join(bundleDir, "artifacts"),
    promptsDir: path.join(bundleDir, "prompts"),
    indexPath: getIndexPath(repoRoot),
    startedAt: resolvedStartedAt,
  }
}

function normalizeEventForAppend(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new BtrainError({
      message: "Trace event must be an object.",
      reason: "recordTraceEvent received a non-object payload.",
      fix: "Pass { type, ...fields } to recordTraceEvent.",
    })
  }
  const type = normalizeText(event.type)
  if (!type) {
    throw new BtrainError({
      message: "Trace event is missing a type.",
      reason: "Every trace event needs a non-empty type field.",
      fix: "Set event.type (e.g. \"prompt\", \"tool\", \"review\", \"outcome\").",
    })
  }
  const ts = event.ts || event.timestamp || new Date().toISOString()
  return {
    ts,
    type,
    ...Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== "ts" && key !== "timestamp" && key !== "type"),
    ),
  }
}

export async function recordTraceEvent(bundleDir, event) {
  if (!bundleDir) {
    throw new BtrainError({
      message: "recordTraceEvent requires a bundleDir.",
      reason: "No bundleDir was provided.",
      fix: "Pass the bundleDir returned from createTraceBundle().",
    })
  }
  const normalized = normalizeEventForAppend(event)
  const eventsDir = path.join(bundleDir, "events")
  await ensureDir(eventsDir)
  const line = `${JSON.stringify(normalized)}\n`
  await fs.appendFile(path.join(eventsDir, "events.jsonl"), line, "utf8")
  return normalized
}

function normalizeArtifactRelPath(relPath) {
  const cleaned = normalizeText(relPath)
  if (!cleaned) {
    throw new BtrainError({
      message: "writeTraceArtifact requires a relative path.",
      reason: "Empty relPath would write nothing useful.",
      fix: "Pass a relative filename under the bundle's artifacts/ directory.",
    })
  }
  const normalized = path.posix.normalize(cleaned.replace(/\\/g, "/"))
  if (normalized.startsWith("/") || normalized.startsWith("..") || normalized.includes("/../")) {
    throw new BtrainError({
      message: `Refusing to write artifact outside the bundle: "${relPath}".`,
      reason: "Artifact paths must stay inside artifacts/.",
      fix: "Use a relative path with no leading / or parent-dir segments.",
    })
  }
  return normalized
}

export async function writeTraceArtifact(bundleDir, relPath, content) {
  const safeRel = normalizeArtifactRelPath(relPath)
  const artifactsDir = path.join(bundleDir, "artifacts")
  const targetPath = path.join(artifactsDir, safeRel)
  await ensureDir(path.dirname(targetPath))
  const body = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2)
  await fs.writeFile(targetPath, body, typeof body === "string" ? "utf8" : undefined)
  return {
    relPath: safeRel,
    path: targetPath,
  }
}

function buildIndexLine(summary) {
  return {
    version: TRACE_BUNDLE_VERSION,
    runId: summary.runId,
    scenarioId: summary.scenarioId || "",
    profileId: summary.profileId || "",
    kind: summary.kind || "harness-run",
    outcome: summary.outcome || "",
    failureCategory: summary.failureCategory || "",
    startedAt: summary.startedAt || "",
    endedAt: summary.endedAt || "",
    summary: summary.summary || "",
  }
}

async function appendIndexLine(repoRoot, summary) {
  const indexPath = getIndexPath(repoRoot)
  await ensureDir(path.dirname(indexPath))
  const line = `${JSON.stringify(buildIndexLine(summary))}\n`
  await fs.appendFile(indexPath, line, "utf8")
  return indexPath
}

export async function finalizeTraceBundle(bundleDir, {
  repoRoot,
  outcome,
  failureCategory,
  summary,
  endedAt,
  metrics,
  artifactRefs,
} = {}) {
  if (!bundleDir) {
    throw new BtrainError({
      message: "finalizeTraceBundle requires a bundleDir.",
      reason: "No bundleDir was provided.",
      fix: "Pass the bundleDir returned from createTraceBundle().",
    })
  }

  const summaryPath = path.join(bundleDir, "summary.json")
  const current = await readJsonIfExists(summaryPath)
  if (!current) {
    throw new BtrainError({
      message: `No trace bundle summary at ${summaryPath}.`,
      reason: "finalizeTraceBundle can only close a bundle that was created by createTraceBundle.",
      fix: "Call createTraceBundle() before finalizing.",
    })
  }

  const resolvedOutcome = normalizeHarnessTraceOutcome(outcome, current.outcome || "fail")
  const isFailure = resolvedOutcome === "fail" || resolvedOutcome === "error"
  const resolvedFailureCategory = isFailure
    ? normalizeHarnessTraceFailureCategory(failureCategory, current.failureCategory || "unknown")
    : ""

  const finalized = {
    ...current,
    outcome: resolvedOutcome,
    failureCategory: resolvedFailureCategory,
    summary: normalizeText(summary) || current.summary || "",
    endedAt: endedAt || current.endedAt || new Date().toISOString(),
    metrics: {
      ...(current.metrics || {}),
      ...normalizeMetrics(metrics),
    },
    artifactRefs: normalizeStringList([
      ...(Array.isArray(current.artifactRefs) ? current.artifactRefs : []),
      ...(Array.isArray(artifactRefs) ? artifactRefs : []),
    ]),
  }

  await writeJsonAtomic(summaryPath, finalized)

  const resolvedRepoRoot = repoRoot || inferRepoRootFromBundleDir(bundleDir)
  let indexPath = ""
  if (resolvedRepoRoot) {
    indexPath = await appendIndexLine(resolvedRepoRoot, finalized)
  }

  return {
    summary: finalized,
    summaryPath,
    indexPath,
  }
}

function inferRepoRootFromBundleDir(bundleDir) {
  const runsDir = path.dirname(bundleDir)
  const harnessDir = path.dirname(runsDir)
  const dotBtrain = path.dirname(harnessDir)
  return path.dirname(dotBtrain)
}

function parseIndexLines(raw) {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean)
  const byRunId = new Map()
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === "object" && typeof parsed.runId === "string") {
        // Repeated finalize calls append duplicate lines; the last write wins.
        byRunId.set(parsed.runId, parsed)
      }
    } catch {
      // skip malformed lines — the primary source of truth is the bundle's summary.json
    }
  }
  return [...byRunId.values()]
}

export async function listTraceBundles({ repoRoot, limit } = {}) {
  const indexPath = getIndexPath(repoRoot)
  const runsDir = getRunsDir(repoRoot)

  let entries = []
  try {
    const raw = await fs.readFile(indexPath, "utf8")
    entries = parseIndexLines(raw)
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }

  const seen = new Set(entries.map((entry) => entry.runId))
  let discoveredRuns = []
  try {
    discoveredRuns = (await fs.readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }

  for (const runId of discoveredRuns) {
    if (seen.has(runId)) continue
    const summary = await readJsonIfExists(path.join(runsDir, runId, "summary.json"))
    if (!summary) continue
    entries.push(buildIndexLine(summary))
    seen.add(runId)
  }

  entries.sort((left, right) => {
    const leftStamp = left.startedAt || left.runId
    const rightStamp = right.startedAt || right.runId
    return rightStamp.localeCompare(leftStamp)
  })

  const bounded = typeof limit === "number" && limit > 0 ? entries.slice(0, limit) : entries

  return {
    repoRoot,
    harnessDir: getHarnessDir(repoRoot),
    runsDir,
    indexPath,
    total: entries.length,
    runs: bounded,
  }
}

export async function readTraceBundleSummary({ repoRoot, runId } = {}) {
  if (!isValidTraceRunId(runId)) {
    throw new BtrainError({
      message: `Invalid trace run id "${runId}".`,
      reason: "Run ids must match run_<YYYYMMDDTHHMMSSZ>_<hex>.",
      fix: "Pick a run id from `btrain harness trace list`.",
    })
  }
  const bundleDir = getTraceBundleDir(repoRoot, runId)
  const rawSummary = await readJsonIfExists(path.join(bundleDir, "summary.json"))
  if (!rawSummary) {
    throw new BtrainError({
      message: `No trace bundle for run id "${runId}".`,
      reason: `Expected summary.json under ${bundleDir}.`,
      fix: "Run `btrain harness trace list` to see known runs.",
    })
  }

  const summary = {
    ...rawSummary,
    taskEnvelope: rawSummary.taskEnvelope
      ? buildTaskArtifactEnvelope(rawSummary.taskEnvelope)
      : createEmptyTaskArtifactEnvelope(),
    agentCardRef: normalizeAgentCardRef(rawSummary.agentCardRef),
  }

  let eventCount = 0
  try {
    const raw = await fs.readFile(path.join(bundleDir, "events", "events.jsonl"), "utf8")
    eventCount = raw.split("\n").filter((line) => line.trim()).length
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }

  let artifactEntries = []
  try {
    artifactEntries = await fs.readdir(path.join(bundleDir, "artifacts"), {
      withFileTypes: true,
      recursive: true,
    })
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }

  return {
    repoRoot,
    runId,
    bundleDir,
    summary,
    eventCount,
    artifactCount: artifactEntries.filter((entry) => entry.isFile()).length,
    artifactDirCount: artifactEntries.filter((entry) => entry.isDirectory()).length,
  }
}
