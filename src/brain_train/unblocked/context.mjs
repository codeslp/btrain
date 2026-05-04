import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..", "..")
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 5

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function normalizeEffort(value, fallback = "low") {
  const normalized = String(value || "").trim().toLowerCase()
  return ["low", "medium", "high"].includes(normalized) ? normalized : fallback
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function sourceToLine(source) {
  const title = compactWhitespace(source?.title) || "(untitled)"
  const type = compactWhitespace(source?.sourceType) || "source"
  const url = compactWhitespace(source?.url)
  return url ? `${title} (${type}) ${url}` : `${title} (${type})`
}

function parseJsonObject(raw) {
  if (!raw || !String(raw).trim()) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function normalizeUnblockedPayload(payload, fallbackStatus = "ok") {
  if (!payload || typeof payload !== "object") {
    return {
      status: "skipped",
      summary: "",
      sources: [],
      skippedReason: "unblocked helper returned non-JSON output",
    }
  }

  const sources = Array.isArray(payload.sources) ? payload.sources : []
  if (payload._skipped) {
    return {
      status: "skipped",
      summary: compactWhitespace(payload.summary),
      sources,
      skippedReason: compactWhitespace(payload._skipped),
    }
  }

  if (payload.error) {
    return {
      status: "error",
      summary: compactWhitespace(payload.message || payload.summary),
      sources,
      error: compactWhitespace(payload.error),
    }
  }

  return {
    status: fallbackStatus,
    summary: compactWhitespace(payload.summary),
    sources,
  }
}

async function resolveUnblockedHelper(repoRoot, options = {}) {
  const candidates = [
    options.helperPath,
    path.join(repoRoot, ".claude", "scripts", "unblocked-context.sh"),
    path.join(PACKAGE_ROOT, ".claude", "scripts", "unblocked-context.sh"),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(repoRoot, candidate)
    if (await pathExists(resolved)) {
      return resolved
    }
  }

  return ""
}

async function runUnblockedHelper(repoRoot, args, options = {}) {
  const helperPath = await resolveUnblockedHelper(repoRoot, options)
  if (!helperPath) {
    return {
      status: "skipped",
      summary: "",
      sources: [],
      skippedReason: "unblocked helper not found",
      helperPath: "",
      args,
    }
  }

  try {
    const result = await execFileAsync(helperPath, args, {
      cwd: repoRoot,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    return {
      ...normalizeUnblockedPayload(parseJsonObject(result.stdout), "ok"),
      helperPath,
      args,
    }
  } catch (error) {
    const payload = parseJsonObject(error.stdout)
    if (payload) {
      return {
        ...normalizeUnblockedPayload(payload, "error"),
        helperPath,
        args,
        exitCode: typeof error.code === "number" ? error.code : 1,
      }
    }

    const reason = error.killed || error.signal === "SIGTERM"
      ? "unblocked helper timed out"
      : compactWhitespace(error.stderr || error.message) || "unblocked helper failed"
    return {
      status: "skipped",
      summary: "",
      sources: [],
      skippedReason: reason,
      helperPath,
      args,
      exitCode: typeof error.code === "number" ? error.code : 1,
    }
  }
}

function buildResearchArgs({ query, effort = "low", limit = DEFAULT_LIMIT } = {}) {
  return [
    "research",
    compactWhitespace(query),
    "--effort",
    normalizeEffort(effort),
    "--limit",
    String(normalizeLimit(limit)),
  ]
}

function buildContextQuery({ purpose, task, files = [], laneId = "" }) {
  const fileText = Array.isArray(files) ? files.filter(Boolean).join(" ") : ""
  return compactWhitespace([purpose, laneId ? `lane ${laneId}` : "", task, fileText].filter(Boolean).join(" "))
}

async function runUnblockedResearch(repoRoot, options = {}) {
  const query = compactWhitespace(options.query)
  if (!query) {
    return {
      status: "skipped",
      summary: "",
      sources: [],
      skippedReason: "no Unblocked query provided",
      args: [],
      helperPath: "",
    }
  }

  return runUnblockedHelper(repoRoot, buildResearchArgs(options), options)
}

async function collectClaimUnblockedContext(repoRoot, options = {}) {
  const query = options.query || buildContextQuery({
    purpose: "Claim-time implementation context for btrain lane",
    task: options.task,
    files: options.files,
    laneId: options.laneId,
  })

  return runUnblockedResearch(repoRoot, {
    query,
    effort: options.effort || "low",
    limit: options.limit ?? DEFAULT_LIMIT,
    helperPath: options.helperPath,
    timeoutMs: options.timeoutMs,
  })
}

function buildClaimReviewContextFields(result) {
  const preflightLines = [
    "- [ ] Checked locked files, nearby diff, and likely risk areas before editing",
    "- [ ] Reviewed claim-time Unblocked context before editing",
  ]

  if (!result || result.status === "skipped") {
    return {
      preflightLines,
      gapLines: [`- Claim-time Unblocked context skipped: ${result?.skippedReason || "unknown reason"}`],
    }
  }

  if (result.status === "error") {
    return {
      preflightLines,
      gapLines: [`- Claim-time Unblocked context errored: ${result.error || result.summary || "unknown error"}`],
    }
  }

  const sources = Array.isArray(result.sources) ? result.sources.slice(0, 3) : []
  const whyLines = [
    result.summary
      ? `Claim-time Unblocked context: ${result.summary}`
      : `Claim-time Unblocked context returned ${sources.length} source${sources.length === 1 ? "" : "s"}.`,
  ]
  const reviewAskLines = sources.length > 0
    ? sources.map((source) => `- Check related context: ${sourceToLine(source)}`)
    : ["- Confirm no relevant prior Unblocked context was missed."]

  return {
    preflightLines,
    whyLines,
    reviewAskLines,
  }
}

function formatUnblockedContextSummary(result, options = {}) {
  const label = options.label || "btrain review context"
  const lines = [`${label}: ${result.status}`]
  if (result.query) {
    lines.push(`query: ${result.query}`)
  }

  if (result.status === "skipped") {
    lines.push(`reason: ${result.skippedReason || "unknown reason"}`)
    return lines.join("\n")
  }

  if (result.status === "error") {
    lines.push(`error: ${result.error || result.summary || "unknown error"}`)
    return lines.join("\n")
  }

  if (result.summary) {
    lines.push(`summary: ${result.summary}`)
  }

  const sources = Array.isArray(result.sources) ? result.sources : []
  if (sources.length === 0) {
    lines.push("sources: none")
    return lines.join("\n")
  }

  lines.push("sources:")
  for (const source of sources.slice(0, normalizeLimit(options.limit, DEFAULT_LIMIT))) {
    lines.push(`- ${sourceToLine(source)}`)
  }
  return lines.join("\n")
}

export {
  buildClaimReviewContextFields,
  buildContextQuery,
  collectClaimUnblockedContext,
  formatUnblockedContextSummary,
  normalizeEffort,
  normalizeLimit,
  resolveUnblockedHelper,
  runUnblockedHelper,
  runUnblockedResearch,
}
