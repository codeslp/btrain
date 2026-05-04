// code-rules.mjs — `btrain review code` deterministic rule scanner.
//
// Scans the lane's diff for known anti-patterns and emits a structured
// violation list. Pure regex / heuristic — no LLM, no AST, no new deps.
//
// Rules:
//   hardcoded-secret    (hard)  — known API key formats in added lines
//   cors-wildcard       (hard)  — Access-Control-Allow-Origin: *
//   unprotected-route   (warn)  — new HTTP route handler with no
//                                 helmet/security-header import in the file
//   env-var-required    (warn)  — long literal assigned to *_KEY/*_TOKEN/
//                                 *_SECRET that isn't derived from env
//   new-dependency      (warn)  — added line in package.json deps,
//                                 requirements.txt, pyproject.toml, Cargo.toml
//
// Per-line allow markers suppress violations for that rule on that line:
//   // btrain-allow: hardcoded-secret
//   # btrain-allow: cors-wildcard
// Markers may appear at end of the violating line or on the line above.

import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"
import path from "node:path"
import {
  BtrainError,
  getLaneConfigs,
  readAllLaneStates,
  readLockRegistry,
  readProjectConfig,
} from "../core.mjs"

const execFileAsync = promisify(execFile)

const DIFF_MAX_BUFFER = 32 * 1024 * 1024

// ---- secret patterns ----
// Each entry: { id, regex, label }. The regex matches a key inside a longer
// line; we only flag added (`+`) diff lines.
const SECRET_PATTERNS = [
  { id: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key ID" },
  { id: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/, label: "GitHub token" },
  { id: "stripe-key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/, label: "Stripe key" },
  { id: "openai-key", regex: /\bsk-[A-Za-z0-9]{40,}\b/, label: "OpenAI-style key" },
  { id: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/, label: "Anthropic key" },
  { id: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  { id: "bearer-token", regex: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/, label: "Bearer token" },
]

const CORS_WILDCARD_PATTERNS = [
  // Header literal: Access-Control-Allow-Origin: *
  /Access-Control-Allow-Origin\s*:\s*['"`]?\*['"`]?/i,
  // setHeader / set call: ('Access-Control-Allow-Origin', '*')
  /['"`]Access-Control-Allow-Origin['"`]\s*,\s*['"`]\*['"`]/i,
  // JS object form: { origin: "*" } or origin:'*'
  /\borigin\s*:\s*['"`]\*['"`]/i,
]

// HTTP route handler patterns (Express/Koa/Fastify-ish). Excludes `.use` and
// `.all` which are middleware mounts, not endpoints — those are matched by
// downstream middleware checks (e.g., the helmet import marker).
const ROUTE_PATTERNS = [
  /\b(?:app|router|server)\.(?:get|post|put|patch|delete|options)\s*\(/,
  /\b(?:fastify|app)\.route\s*\(/,
]

const SECURITY_IMPORT_PATTERNS = [
  /\brequire\s*\(\s*['"`]helmet['"`]/,
  /\bfrom\s+['"`]helmet['"`]/,
  /\bimport\s+['"`]helmet['"`]/,
  /\b(?:setHeader|set)\s*\(\s*['"`](?:Strict-Transport-Security|Content-Security-Policy|X-Frame-Options|X-Content-Type-Options)['"`]/i,
]

// env-var-required: name suggests secret, value is a long literal not from env.
const SECRET_VAR_NAME = /\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_API_KEY))\b/
const ENV_DERIVATIONS = [
  /process\.env\b/,
  /os\.environ\b/,
  /os\.getenv\b/,
  /Deno\.env\b/,
  /import\.meta\.env\b/,
  /env\.var\b/,
]

// new-dependency: dependency manifest files and whether every added line counts.
const DEPENDENCY_FILES = [
  { name: "package.json", everyAddedLine: false },
  { name: "requirements.txt", everyAddedLine: true },
  { name: "pyproject.toml", everyAddedLine: false },
  { name: "Cargo.toml", everyAddedLine: false },
  { name: "go.mod", everyAddedLine: false },
]

// ---- diff parsing ----

// Parse a unified diff into per-file blocks of hunk lines with line numbers.
// Returns: [{ file: "src/foo.ts", added: [{ line: 42, text: "..." }, ...], lines: [...] }]
export function parseUnifiedDiff(diff) {
  const files = []
  let currentFile = null
  let newLineNum = 0
  let inHunk = false

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // start a new file
      const match = /\sb\/(.+)$/.exec(raw)
      currentFile = { file: match ? match[1] : "", added: [], lines: [] }
      files.push(currentFile)
      newLineNum = 0
      inHunk = false
      continue
    }
    if (!currentFile) continue
    if (raw.startsWith("@@")) {
      // @@ -a,b +c,d @@  →  pull c
      const match = /\+(\d+)(?:,\d+)?/.exec(raw)
      if (match) newLineNum = Number.parseInt(match[1], 10)
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith("\\ No newline at end of file")) continue
    if (raw.startsWith("+")) {
      const entry = { line: newLineNum, text: raw.slice(1), kind: "added" }
      currentFile.lines.push(entry)
      currentFile.added.push({ line: entry.line, text: entry.text })
      newLineNum++
    } else if (raw.startsWith("-")) {
      // removed; line numbers in the new file don't advance
    } else if (raw.startsWith(" ")) {
      currentFile.lines.push({ line: newLineNum, text: raw.slice(1), kind: "context" })
      newLineNum++
    }
  }
  return files.filter((f) => f.file)
}

// ---- allow markers ----

const ALLOW_RE = /(?:\/\/|#|--|\/\*)\s*btrain-allow\s*:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/i

export function lineHasAllow(text, ruleId) {
  const match = ALLOW_RE.exec(text)
  if (!match) return false
  return match[1]
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .includes(ruleId.toLowerCase())
}

// Whether the immediately previous line carries an allow marker.
function prevLineAllows(addedLines, indexInAdded, ruleId) {
  if (indexInAdded === 0) return false
  const prev = addedLines[indexInAdded - 1]
  return prev && lineHasAllow(prev.text, ruleId)
}

// ---- per-rule scanners ----

function scanHardcodedSecret(file, addedLines) {
  const out = []
  for (let i = 0; i < addedLines.length; i++) {
    const { line, text } = addedLines[i]
    for (const pattern of SECRET_PATTERNS) {
      if (!pattern.regex.test(text)) continue
      if (lineHasAllow(text, "hardcoded-secret") || prevLineAllows(addedLines, i, "hardcoded-secret")) continue
      out.push({
        rule: "hardcoded-secret",
        severity: "hard",
        file,
        line,
        preview: text.trim().slice(0, 200),
        detail: `Matched ${pattern.label} (${pattern.id}).`,
      })
      break // one violation per line is enough
    }
  }
  return out
}

function scanCorsWildcard(file, addedLines) {
  const out = []
  for (let i = 0; i < addedLines.length; i++) {
    const { line, text } = addedLines[i]
    if (!CORS_WILDCARD_PATTERNS.some((re) => re.test(text))) continue
    if (lineHasAllow(text, "cors-wildcard") || prevLineAllows(addedLines, i, "cors-wildcard")) continue
    out.push({
      rule: "cors-wildcard",
      severity: "hard",
      file,
      line,
      preview: text.trim().slice(0, 200),
      detail: "Wildcard CORS origin (`*`) detected.",
    })
  }
  return out
}

function scanEnvVarRequired(file, addedLines) {
  const out = []
  for (let i = 0; i < addedLines.length; i++) {
    const { line, text } = addedLines[i]
    const nameMatch = SECRET_VAR_NAME.exec(text)
    if (!nameMatch) continue

    // Look for a string literal of length >= 20 on this line
    const literalMatch = /['"`]([^'"`]{20,})['"`]/.exec(text)
    if (!literalMatch) continue

    // If the literal looks env-derived on this line, skip
    if (ENV_DERIVATIONS.some((re) => re.test(text))) continue

    // Don't double-fire if hardcoded-secret already matches a known pattern
    if (SECRET_PATTERNS.some((p) => p.regex.test(text))) continue

    if (lineHasAllow(text, "env-var-required") || prevLineAllows(addedLines, i, "env-var-required")) continue

    out.push({
      rule: "env-var-required",
      severity: "warn",
      file,
      line,
      preview: text.trim().slice(0, 200),
      detail: `Variable \`${nameMatch[1]}\` assigned a literal; expected to be loaded from env (process.env / os.environ / ...).`,
    })
  }
  return out
}

// Per-file: if added lines introduce any route handler and the WHOLE file
// (added lines viewed, since we don't read the on-disk file) has no helmet
// or security-header import, flag once.
function scanUnprotectedRoute(file, addedLines) {
  const out = []
  const hasRoute = addedLines.some(({ text }) => ROUTE_PATTERNS.some((re) => re.test(text)))
  if (!hasRoute) return out
  const hasSecurity = addedLines.some(({ text }) => SECURITY_IMPORT_PATTERNS.some((re) => re.test(text)))
  if (hasSecurity) return out
  // Allow marker may appear on the route line.
  const routeIndex = addedLines.findIndex(({ text }) => ROUTE_PATTERNS.some((re) => re.test(text)))
  if (routeIndex >= 0) {
    const { text } = addedLines[routeIndex]
    if (lineHasAllow(text, "unprotected-route") || prevLineAllows(addedLines, routeIndex, "unprotected-route")) {
      return out
    }
  }
  out.push({
    rule: "unprotected-route",
    severity: "warn",
    file,
    line: routeIndex >= 0 ? addedLines[routeIndex].line : 0,
    preview: routeIndex >= 0 ? addedLines[routeIndex].text.trim().slice(0, 200) : "",
    detail: "New HTTP route added without helmet/security-header import in the same file.",
  })
  return out
}

function countJsonBraceDelta(text) {
  let delta = 0
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") delta++
    if (ch === "}") delta--
  }
  return delta
}

const PACKAGE_DEPENDENCY_SECTION = /^\s*"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/
const PACKAGE_ENTRY = /^\s*"([^"]+)"\s*:\s*"[^"]*"\s*,?\s*(?:\/\/.*)?$/

function collectPackageJsonDependencyLinesFromText(content) {
  const lineNumbers = new Set()
  let inDependencySection = false
  let dependencyDepth = 0
  const lines = String(content || "").split("\n")

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineNumber = index + 1
    if (!inDependencySection && PACKAGE_DEPENDENCY_SECTION.test(line)) {
      inDependencySection = true
      dependencyDepth = Math.max(0, countJsonBraceDelta(line))
      if (dependencyDepth <= 0) {
        inDependencySection = false
      }
      continue
    }

    if (!inDependencySection) continue
    if (dependencyDepth > 0 && PACKAGE_ENTRY.test(line)) {
      lineNumbers.add(lineNumber)
    }
    dependencyDepth += countJsonBraceDelta(line)
    if (dependencyDepth <= 0) {
      inDependencySection = false
      dependencyDepth = 0
    }
  }

  return lineNumbers
}

function collectPackageJsonDependencyLinesFromDiff(lines) {
  const lineNumbers = new Set()
  let inDependencySection = false
  let dependencyDepth = 0

  for (const entry of lines || []) {
    const text = entry.text || ""
    if (!inDependencySection && PACKAGE_DEPENDENCY_SECTION.test(text)) {
      inDependencySection = true
      dependencyDepth = Math.max(0, countJsonBraceDelta(text))
      if (dependencyDepth <= 0) {
        inDependencySection = false
      }
      continue
    }

    if (!inDependencySection) continue
    if (dependencyDepth > 0 && entry.kind === "added" && PACKAGE_ENTRY.test(text)) {
      lineNumbers.add(entry.line)
    }
    dependencyDepth += countJsonBraceDelta(text)
    if (dependencyDepth <= 0) {
      inDependencySection = false
      dependencyDepth = 0
    }
  }

  return lineNumbers
}

function getPackageJsonDependencyLines(file, lines, fileContentsByPath) {
  const content = fileContentsByPath?.[file]
  if (typeof content === "string") {
    return collectPackageJsonDependencyLinesFromText(content)
  }
  return collectPackageJsonDependencyLinesFromDiff(lines)
}

function scanNewDependency(file, addedLines, lines, options = {}) {
  const out = []
  const base = path.basename(file)
  const config = DEPENDENCY_FILES.find((d) => d.name === base)
  if (!config) return out
  const packageJsonDependencyLines =
    base === "package.json"
      ? getPackageJsonDependencyLines(file, lines, options.fileContentsByPath)
      : null

  // For files where every added line counts as a dep (requirements.txt), flag
  // every non-comment, non-empty added line.
  if (config.everyAddedLine) {
    for (const { line, text } of addedLines) {
      const trimmed = text.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      if (lineHasAllow(text, "new-dependency")) continue
      out.push({
        rule: "new-dependency",
        severity: "warn",
        file,
        line,
        preview: trimmed.slice(0, 200),
        detail: `New dependency line in ${base}.`,
      })
    }
    return out
  }

  // For block-scoped files, we need to know whether each added line is
  // inside a deps block. We don't have full file context here; approximate by
  // checking whether the added line itself looks like a dependency entry
  // (key-value form for json/toml).
  for (const { line, text } of addedLines) {
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) continue
    if (lineHasAllow(text, "new-dependency")) continue

    if (base === "package.json") {
      if (!PACKAGE_ENTRY.test(text) || !packageJsonDependencyLines.has(line)) continue
    } else if (base === "Cargo.toml" || base === "pyproject.toml") {
      // name = "version"
      if (!/^[A-Za-z0-9_.-]+\s*=\s*['"`{]/.test(trimmed)) continue
    } else if (base === "go.mod") {
      if (!/^(?:require\s+)?[A-Za-z0-9./_-]+\s+v\d/.test(trimmed)) continue
    } else {
      continue
    }

    out.push({
      rule: "new-dependency",
      severity: "warn",
      file,
      line,
      preview: trimmed.slice(0, 200),
      detail: `New dependency entry in ${base}.`,
    })
  }
  return out
}

// ---- public scan entry ----

export function scanDiff(diff, options = {}) {
  const files = parseUnifiedDiff(diff)
  const violations = []
  for (const { file, added, lines } of files) {
    if (added.length === 0) continue
    violations.push(...scanHardcodedSecret(file, added))
    violations.push(...scanCorsWildcard(file, added))
    violations.push(...scanEnvVarRequired(file, added))
    violations.push(...scanUnprotectedRoute(file, added))
    violations.push(...scanNewDependency(file, added, lines, options))
  }
  // Stable sort: by file, then line, then rule.
  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.rule.localeCompare(b.rule)
  })
  return {
    violations,
    summary: {
      hard: violations.filter((v) => v.severity === "hard").length,
      warn: violations.filter((v) => v.severity === "warn").length,
    },
  }
}

// ---- diff fetching ----

function normalizePathspecList(paths) {
  return [...new Set(
    (paths || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )].sort()
}

async function getLanePathspecs(repoRoot, laneId) {
  if (!laneId) return []
  const normalizedLaneId = String(laneId).trim().toLowerCase()
  const config = await readProjectConfig(repoRoot)
  const laneConfigs = getLaneConfigs(config)
  if (!laneConfigs) {
    throw new BtrainError({
      message: "`btrain review code --lane` requires lanes to be enabled.",
      reason: "The repo does not have [lanes] enabled in .btrain/project.toml.",
      fix: "Run without --lane, or enable lanes with `btrain init`.",
    })
  }
  if (!laneConfigs.some((lane) => lane.id === normalizedLaneId)) {
    throw new BtrainError({
      message: `Unknown lane "${laneId}".`,
      reason: "No configured lane has that id.",
      fix: `Pick one of: ${laneConfigs.map((lane) => lane.id).join(", ")}`,
    })
  }

  const registry = await readLockRegistry(repoRoot)
  const lockPaths = normalizePathspecList(
    registry.locks
      ?.filter((lock) => lock.lane === normalizedLaneId)
      .map((lock) => lock.path),
  )
  if (lockPaths.length > 0) return lockPaths

  const laneStates = await readAllLaneStates(repoRoot, config)
  const laneState = laneStates?.find((entry) => entry._laneId === normalizedLaneId)
  const statePaths = normalizePathspecList(laneState?.lockedFiles)
  if (statePaths.length > 0) return statePaths

  throw new BtrainError({
    message: `Lane "${laneId}" has no locked files to review.`,
    reason: "Lane-scoped review needs the lane's file locks so unrelated lane diffs are excluded.",
    fix: `Run \`btrain handoff update --lane ${normalizedLaneId} --files "path/" --actor "<owner>"\`, then retry.`,
  })
}

async function getLaneDiff(repoRoot, { base, head, lane }) {
  // If both base and head are provided, diff between them.
  // Otherwise, diff the working tree (uncommitted changes) for fast feedback
  // during local development.
  const args = ["diff", "--unified=3"]
  if (base) {
    args.push(`${base}${head ? `..${head}` : ""}`)
  }
  const pathspecs = await getLanePathspecs(repoRoot, lane)
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs)
  }
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: DIFF_MAX_BUFFER })
  return stdout
}

async function readFileForReview(repoRoot, file, head) {
  if (head) {
    try {
      const { stdout } = await execFileAsync("git", ["show", `${head}:${file}`], {
        cwd: repoRoot,
        maxBuffer: DIFF_MAX_BUFFER,
      })
      return stdout
    } catch {
      return null
    }
  }

  try {
    return await fs.readFile(path.join(repoRoot, file), "utf8")
  } catch {
    return null
  }
}

async function readDependencyFileContents(repoRoot, diff, head) {
  const files = parseUnifiedDiff(diff)
  const contents = {}
  for (const { file } of files) {
    if (!DEPENDENCY_FILES.some((entry) => entry.name === path.basename(file))) continue
    const content = await readFileForReview(repoRoot, file, head)
    if (typeof content === "string") {
      contents[file] = content
    }
  }
  return contents
}

// ---- formatting ----

export function formatSummary(result) {
  const { violations, summary } = result
  const lines = []
  lines.push(`btrain review code: ${summary.hard} hard, ${summary.warn} warn (${violations.length} total)`)
  if (violations.length === 0) {
    lines.push("  ✓ no violations")
    return lines.join("\n")
  }
  for (const v of violations) {
    const sev = v.severity === "hard" ? "✖" : "⚠"
    lines.push(`  ${sev} [${v.rule}] ${v.file}:${v.line}`)
    if (v.detail) lines.push(`      ${v.detail}`)
    if (v.preview) lines.push(`      > ${v.preview}`)
  }
  return lines.join("\n")
}

// ---- entry ----

export async function reviewCode(repoRoot, options = {}) {
  const diff = await getLaneDiff(repoRoot, {
    base: options.base,
    head: options.head,
    lane: options.lane,
  })
  const fileContentsByPath = await readDependencyFileContents(repoRoot, diff, options.head)
  const result = scanDiff(diff, { fileContentsByPath })
  return result
}
