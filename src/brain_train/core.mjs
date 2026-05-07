import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  DEFAULT_HARNESS_PROFILE_ID,
  FALLBACK_LOOP_DISPATCH_PROMPT,
  loadHarnessProfile,
  normalizeHarnessProfileId,
} from "./harness/index.mjs"
import {
  TASK_ARTIFACT_ENVELOPE_VERSION,
  buildTaskArtifactEnvelope,
  createEmptyTaskArtifactEnvelope,
  normalizeTaskArtifactEnvelope,
} from "./harness/task-envelope.mjs"
import {
  createAdapter,
  failOpen,
  probeManifest,
  resolveBinary,
} from "./cgraph_adapter.mjs"
import {
  MAX_LOOP_LOG_OUTPUT_LINES,
  createClaudeStreamObserver,
  createCodexStreamObserver,
  emitLoopOutput,
  formatClaudeToolResult,
  formatClaudeToolUse,
  formatCodexCommandOutput,
  summarizeCodexCommand,
  summarizeLoopProgressText,
} from "./runners/stream-observers.mjs"
import {
  buildClaimReviewContextFields,
  collectClaimUnblockedContext,
} from "./unblocked/context.mjs"

// ---------------------------------------------------------------------------
// Atomic file locking — prevents TOCTOU races on shared state files
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FILE_LOCK_RETRY_MS = 50
const FILE_LOCK_TIMEOUT_MS = 5000
const CGRAPH_ADVISORY_LOCK_TIMEOUT_MS = 500
const CGRAPH_STATUS_CACHE_TTL_MS = 2000
const DEFAULT_CGRAPH_GRAPH_MODE = "shared-working"
const DEFAULT_CGRAPH_ADVISE_ON = ["lock_overlap", "drift", "packet_truncated"]
const cgraphProducerCache = new Map()

async function withFileLock(lockPath, fn, {
  retryMs = FILE_LOCK_RETRY_MS,
  timeoutMs = FILE_LOCK_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let fd = null
  while (Date.now() < deadline) {
    try {
      fd = await open(lockPath, "wx")
      break
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      // Check for stale lockfile (older than 30s = likely dead process)
      try {
        const stat = await fs.stat(lockPath)
        if (Date.now() - stat.mtimeMs > 30_000) {
          await fs.unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // stat failed — file was already removed, retry
        continue
      }
      await delay(retryMs)
    }
  }

  if (!fd) {
    throw new Error(`Timed out waiting for file lock: ${lockPath}`)
  }

  try {
    return await fn()
  } finally {
    await fd.close()
    await fs.unlink(lockPath).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Structured error class — gives blocked agents actionable remediation steps
// ---------------------------------------------------------------------------
class BtrainError extends Error {
  /**
   * @param {object} opts
   * @param {string} opts.message  – What went wrong (one-liner).
   * @param {string} [opts.reason] – Why this is enforced / what condition failed.
   * @param {string} [opts.fix]    – Exact command or step to resolve it.
   * @param {string} [opts.context] – Extra info (e.g. valid values, current state).
   */
  constructor({ message, reason, fix, context }) {
    const parts = [`✖ ${message}`]
    if (reason)  parts.push(`  ↳ Why: ${reason}`)
    if (fix)     parts.push(`  ✦ Fix: ${fix}`)
    if (context) parts.push(`  ℹ ${context}`)
    super(parts.join("\n"))
    this.name = "BtrainError"
  }
}

const MANAGED_START = "<!-- btrain:managed:start -->"
const MANAGED_END = "<!-- btrain:managed:end -->"

const DEFAULT_CURRENT = {
  task: "",
  owner: "",
  reviewer: "",
  status: "idle",
  reasonCode: "",
  reasonTags: [],
  repairOwner: "",
  repairEscalation: "",
  repairAttempts: 0,
  reviewMode: "manual",
  lockedFiles: [],
  nextAction: "",
  base: "",
  prNumber: "",
  lastUpdated: "",
}

// Token-efficiency knobs for `btrain handoff`: long reviewer prose in the
// `Next Action` field is spilled to .btrain/handoff-notes/ so the default
// handoff dump stays compact. Threshold 0 disables spill entirely.
const DEFAULT_SPILL_NEXT_CHARS = 400
const SPILL_PREVIEW_CHARS = 180
const HANDOFF_NOTES_DIRNAME = "handoff-notes"
const SPILL_MARKER_RE = /\[spilled:\s*([^,\]]+?)\s*,\s*(\d+)B\]/

function createEmptyDelegationPacket() {
  return {
    objective: "",
    deliverable: "",
    constraints: [],
    acceptance: [],
    budget: "",
    doneWhen: "",
  }
}

const execFileAsync = promisify(execFile)
const CORE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(CORE_DIR, "..", "..")
const DEFAULT_PARALLEL_REVIEW_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "option_a_review.py")
const BUNDLED_SKILLS_DIR = path.join(PACKAGE_ROOT, ".claude", "skills")
const BUNDLED_AGENT_SKILLS_DIR = path.join(PACKAGE_ROOT, ".agents", "skills")
const BUNDLED_AGENTCHATTR_DIR = path.join(PACKAGE_ROOT, "agentchattr")
const BUNDLED_DEV_TOOLS = [
  {
    label: "dashboard",
    sourcePath: path.join(PACKAGE_ROOT, "scripts", "serve-dashboard.js"),
    targetParts: ["scripts", "serve-dashboard.js"],
  },
  {
    label: "handoff-history-watcher",
    sourcePath: path.join(PACKAGE_ROOT, "scripts", "handoff-history-watcher.mjs"),
    targetParts: ["scripts", "handoff-history-watcher.mjs"],
  },
  {
    label: "handoff-history-install",
    sourcePath: path.join(PACKAGE_ROOT, "scripts", "install-handoff-history-launch-agent.sh"),
    targetParts: ["scripts", "install-handoff-history-launch-agent.sh"],
  },
  {
    label: "handoff-history-register",
    sourcePath: path.join(PACKAGE_ROOT, "scripts", "register-handoff-watch-path.sh"),
    targetParts: ["scripts", "register-handoff-watch-path.sh"],
  },
  {
    label: "unblocked-context-helper",
    sourcePath: path.join(PACKAGE_ROOT, ".claude", "scripts", "unblocked-context.sh"),
    targetParts: [".claude", "scripts", "unblocked-context.sh"],
  },
  {
    label: "agentchattr",
    sourcePath: BUNDLED_AGENTCHATTR_DIR,
    targetParts: ["agentchattr"],
    shouldSkip: ({ relativePath }) => shouldSkipBundledAgentchattrPath(relativePath),
  },
]
const EXCLUDED_BUNDLED_SKILLS = new Set(["create-multi-speaker-static-recordings-using-tts"])
const EXCLUDED_AGENTCHATTR_RUNTIME_NAMES = new Set([
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "data",
  "uploads",
])
const SUPPORTED_REVIEW_MODES = new Set(["manual", "parallel", "hybrid"])
const DEFAULT_HANDOFF_RELATIVE_PATH = ".claude/collab/HANDOFF_A.md"
const LOCKS_FILENAME = "locks.json"
const DEFAULT_COLLABORATION_AGENT_COUNT = 2
const DEFAULT_LANES_PER_AGENT = 2
const DEFAULT_HISTORY_KEEP = 3
const VALID_OVERRIDE_ACTIONS = new Set(["needs-review", "push"])
const RESERVED_LANE_METADATA_KEYS = new Set(["enabled", "per_agent", "ids"])
const ACTIVE_LANE_STATUSES = new Set([
  "in-progress",
  "needs-review",
  "ready-for-pr",
  "pr-review",
  "ready-to-merge",
  "changes-requested",
  "repair-needed",
])
const VALID_HANDOFF_STATUSES = new Set([
  "idle",
  "in-progress",
  "needs-review",
  "ready-for-pr",
  "pr-review",
  "ready-to-merge",
  "changes-requested",
  "repair-needed",
  "resolved",
])
const REASON_CODES_BY_STATUS = {
  "changes-requested": new Set([
    "spec-mismatch",
    "regression-risk",
    "missing-verification",
    "security-risk",
    "integration-breakage",
    "pr-review-feedback",
    "ci-failure",
    "bot-feedback",
  ]),
  "repair-needed": new Set([
    "invalid-handoff",
    "unreviewed-push",
    "lock-mismatch",
    "ownership-conflict",
    "state-conflict",
  ]),
}
const REASON_TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REVIEW_CONTEXT_PLACEHOLDER_PATTERNS = [
  "fill this in before handoff",
  "none yet",
  "pending.",
  "pending",
]
const DEFAULT_LOOP_MAX_ROUNDS = 10
const DEFAULT_LOOP_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_LOOP_POLL_INTERVAL_MS = 2 * 1000
const LOOP_PROMPT = FALLBACK_LOOP_DISPATCH_PROMPT
const LOOP_TERMINAL_STATUSES = new Set(["resolved", "idle"])
const CODEX_SUBCOMMANDS = new Set([
  "exec",
  "review",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "app-server",
  "app",
  "completion",
  "sandbox",
  "debug",
  "apply",
  "resume",
  "fork",
  "cloud",
  "features",
  "help",
])

function formatIsoTimestamp(date = new Date()) {
  return date.toISOString()
}

function formatShortDate(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

function escapeTomlString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true })
}

async function ensureSymlink(targetPath, linkPath) {
  try {
    const stat = await fs.lstat(linkPath)
    if (stat.isSymbolicLink()) {
      const existing = await fs.readlink(linkPath)
      const expectedTarget = path.relative(path.dirname(linkPath), targetPath)
      if (existing === expectedTarget || existing === targetPath) {
        return
      }
      await fs.unlink(linkPath)
    } else {
      return
    }
  } catch {
    // link does not exist yet
  }

  await ensureDir(path.dirname(linkPath))
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath)
  await fs.symlink(relativeTarget, linkPath)
}

const CORE_GITIGNORE_ENTRIES = [
  "# btrain operational state (not source code — do not track)",
  ".btrain/*",
  "!.btrain/project.toml",
  ".claude/collab/",
]

const DEV_TOOL_GITIGNORE_ENTRIES = [
  "# agentchattr runtime data (chat logs, uploads, tokens — not source)",
  "agentchattr/data/",
  "agentchattr/.venv/",
  "agentchattr/uploads/",
]

function buildBtrainGitignoreEntries({ includeDevToolIgnores = true } = {}) {
  if (!includeDevToolIgnores) {
    return CORE_GITIGNORE_ENTRIES
  }

  return [
    ...CORE_GITIGNORE_ENTRIES,
    "",
    ...DEV_TOOL_GITIGNORE_ENTRIES,
  ]
}

async function ensureBtrainGitignore(repoRoot, { includeDevToolIgnores = true } = {}) {
  const gitignorePath = path.join(repoRoot, ".gitignore")
  let content = ""
  try {
    content = await readText(gitignorePath)
  } catch {
    // no .gitignore yet
  }

  const entries = buildBtrainGitignoreEntries({ includeDevToolIgnores })
  const missing = entries.filter(
    (entry) => entry && !entry.startsWith("#") && !content.includes(entry),
  )
  if (missing.length === 0) return

  const block = "\n" + entries.join("\n") + "\n"
  await writeText(gitignorePath, content.trimEnd() + "\n" + block)
}

async function readText(targetPath) {
  return fs.readFile(targetPath, "utf8")
}

async function writeText(targetPath, content) {
  await ensureDir(path.dirname(targetPath))
  await fs.writeFile(targetPath, content, "utf8")
}

async function appendText(targetPath, content) {
  await ensureDir(path.dirname(targetPath))
  await fs.appendFile(targetPath, content, "utf8")
}

async function resolveGitHooksDir(repoRoot) {
  const gitEntryPath = path.join(repoRoot, ".git")
  if (!(await pathExists(gitEntryPath))) {
    return null
  }

  const gitEntryStats = await fs.stat(gitEntryPath)
  if (gitEntryStats.isDirectory()) {
    return path.join(gitEntryPath, "hooks")
  }

  const gitPointer = await readText(gitEntryPath)
  const gitDirMatch = /^gitdir:\s*(.+)$/m.exec(gitPointer)
  if (!gitDirMatch) {
    throw new BtrainError({
      message: `Could not parse gitdir from ${gitEntryPath}.`,
      reason: "The .git entry is not a directory and does not contain a valid gitdir pointer.",
      fix: "Verify the repo is a valid git repository. Re-clone if the .git entry is corrupted.",
    })
  }

  const gitDir = path.resolve(repoRoot, gitDirMatch[1].trim())
  const commonDirPath = path.join(gitDir, "commondir")
  const commonDir = (await pathExists(commonDirPath))
    ? path.resolve(gitDir, (await readText(commonDirPath)).trim())
    : gitDir

  return path.join(commonDir, "hooks")
}

function parseCsvList(value) {
  if (!value) {
    return []
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePrNumber(value) {
  if (value === null || value === undefined) return ""
  const raw = String(value).trim()
  if (!raw) return ""
  const stripped = raw.startsWith("#") ? raw.slice(1) : raw
  const urlMatch = /\/pulls?\/(\d+)(?:[/?#].*)?$/.exec(stripped)
  const candidate = urlMatch ? urlMatch[1] : stripped
  if (!/^\d+$/.test(candidate)) return ""
  return candidate
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return values
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
}

function findSectionBounds(content, headingMatcher) {
  const lines = content.split("\n")
  let startLine = -1
  let endLine = lines.length

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const isMatch =
      typeof headingMatcher === "string"
        ? line.trim() === `## ${headingMatcher}`
        : headingMatcher.test(line)

    if (isMatch) {
      startLine = index
      break
    }
  }

  if (startLine === -1) {
    return null
  }

  for (let index = startLine + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      endLine = index
      break
    }
  }

  const startOffset = lines.slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0)
  const endOffset = lines.slice(0, endLine).join("\n").length + (endLine > 0 ? 1 : 0)

  return {
    startOffset,
    endOffset,
    text: content.slice(startOffset, endOffset),
  }
}

function replaceOrPrependSection(content, headingMatcher, sectionText) {
  const normalizedSection = sectionText.trimEnd()

  if (!content.trim()) {
    return `${normalizedSection}\n`
  }

  const bounds = findSectionBounds(content, headingMatcher)
  if (!bounds) {
    return `${normalizedSection}\n\n${content.trimStart()}`
  }

  const before = content.slice(0, bounds.startOffset).trimEnd()
  const after = content.slice(bounds.endOffset).trimStart()

  return [before, normalizedSection, after].filter(Boolean).join("\n\n") + "\n"
}

function replaceManagedBlock(existingContent, managedBlock) {
  if (!existingContent.trim()) {
    return managedBlock
  }

  const startIndex = existingContent.indexOf(MANAGED_START)
  const endIndex = existingContent.indexOf(MANAGED_END)

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = existingContent.slice(0, startIndex)
    const after = existingContent.slice(endIndex + MANAGED_END.length)
    const prefix = before.trimEnd()
    const suffix = after.trimStart()
    return [prefix, managedBlock.trimEnd(), suffix].filter(Boolean).join("\n\n").trimEnd() + "\n"
  }

  return `${managedBlock}\n\n${existingContent.trimStart()}`.trimEnd() + "\n"
}

const PRE_COMMIT_HOOK_MARKER = "# btrain:pre-commit-hook"
const PRE_PUSH_HOOK_MARKER = "# btrain:pre-push-hook"

function renderPreCommitHook() {
  return [
    "#!/bin/sh",
    PRE_COMMIT_HOOK_MARKER,
    "# Blocks commits touching a needs-review lane's locked files unless run by the peer reviewer.",
    "# Installed by: btrain init --hooks",
    "# Bypass with: git commit --no-verify",
    "",
    'STAGED=$(git diff --cached --name-only)',
    'NON_HANDOFF=$(echo "$STAGED" | grep -v "^\\.claude/collab/HANDOFF")',
    'if [ -z "$NON_HANDOFF" ]; then',
    "  exit 0",
    "fi",
    "",
    'CURRENT_AGENT="${BTRAIN_AGENT:-$BRAIN_TRAIN_AGENT}"',
    'CURRENT_AGENT_KEY=$(printf "%s" "$CURRENT_AGENT" | tr "[:upper:]" "[:lower:]")',
    "",
    'path_matches_lock() {',
    '  staged_path="$1"',
    '  lock_path="$2"',
    "",
    '  lock_path=$(printf "%s" "$lock_path" | sed \'s/^[[:space:]]*//; s/[[:space:]]*$//\')',
    '  [ -z "$lock_path" ] && return 1',
    '  [ "$lock_path" = "(none)" ] && return 1',
    "",
    '  case "$lock_path" in',
    '    */**)',
    '      lock_prefix=${lock_path%/**}',
    '      ;;',
    '    */)',
    '      lock_prefix=${lock_path%/}',
    '      ;;',
    '    *)',
    '      lock_prefix=$lock_path',
    '      ;;',
    '  esac',
    "",
    '  [ "$staged_path" = "$lock_prefix" ] && return 0',
    '  case "$staged_path" in',
    '    "$lock_prefix"/*) return 0 ;;',
    '  esac',
    "",
    "  return 1",
    "}",
    "",
    'for HANDOFF in .claude/collab/HANDOFF*.md; do',
    '  if [ -f "$HANDOFF" ]; then',
    '    STATUS=$(grep -m1 "^Status:" "$HANDOFF" | sed \'s/^Status:[[:space:]]*//\' | sed \'s/[[:space:]]*$//\')',
    '    if [ "$STATUS" = "needs-review" ]; then',
    '      REVIEWER=$(grep -m1 "^Peer Reviewer:" "$HANDOFF" | sed \'s/^Peer Reviewer:[[:space:]]*//\' | sed \'s/[[:space:]]*$//\')',
    '      REVIEWER_KEY=$(printf "%s" "$REVIEWER" | tr "[:upper:]" "[:lower:]")',
    '      if [ -n "$CURRENT_AGENT_KEY" ] && [ "$CURRENT_AGENT_KEY" = "$REVIEWER_KEY" ]; then',
    "        continue",
    "      fi",
    "",
    '      LOCKED_FILES=$(grep -m1 "^Locked Files:" "$HANDOFF" | sed \'s/^Locked Files:[[:space:]]*//\' | sed \'s/[[:space:]]*$//\')',
    '      BLOCKED_FILES=""',
    "",
    '      if [ -z "$LOCKED_FILES" ] || [ "$LOCKED_FILES" = "(none)" ]; then',
    '        BLOCKED_FILES="$NON_HANDOFF"',
    "      else",
    '        for STAGED_FILE in $NON_HANDOFF; do',
    '          for LOCKED_FILE in $(printf "%s" "$LOCKED_FILES" | tr "," "\\n"); do',
    '            if path_matches_lock "$STAGED_FILE" "$LOCKED_FILE"; then',
    '              BLOCKED_FILES="${BLOCKED_FILES}${STAGED_FILE}\n"',
    "              break",
    "            fi",
    "          done",
    "        done",
    "      fi",
    "",
    '      if [ -n "$BLOCKED_FILES" ]; then',
    '        echo ""',
    '        echo "✖ btrain: blocked commit — $HANDOFF status is \'needs-review\'."',
    '        echo "  ↳ Why: Staged files touch locked files for a lane waiting on peer review."',
    '        echo ""',
    '        echo "  Peer reviewer: ${REVIEWER:-unknown}"',
    '        echo "  Matching staged files:"',
    '        printf "%b" "$BLOCKED_FILES" | sed \'/^$/d; s/^/    /\'',
    '        echo ""',
    '        echo "  ✦ Fix: Wait for the reviewer to resolve, or bypass with: git commit --no-verify"',
    '        echo "         To resolve the lane: btrain handoff resolve --lane <id> --summary \"...\""',
    '        exit 1',
    '      fi',
    '    fi',
    '  fi',
    "done",
    "",
    "exit 0",
    "",
  ].join("\n")
}

function renderPrePushHook() {
  return [
    "#!/bin/sh",
    PRE_PUSH_HOOK_MARKER,
    "# Blocks pushes while any HANDOFF remains unresolved.",
    "# Installed by: btrain init --hooks",
    "# Override path: btrain override grant --action push --requested-by <agent> --confirmed-by <human> --reason \"...\"",
    "",
    'ACTIVE_HANDOFFS=""',
    'for HANDOFF in .claude/collab/HANDOFF*.md; do',
    '  if [ -f "$HANDOFF" ]; then',
    '    STATUS=$(grep -m1 "^Status:" "$HANDOFF" | sed \'s/^Status:[[:space:]]*//\' | sed \'s/[[:space:]]*$//\')',
    '    case "$STATUS" in',
    '      in-progress|needs-review|repair-needed|pr-review|ready-to-merge)',
    '        ACTIVE_HANDOFFS="${ACTIVE_HANDOFFS}${HANDOFF}: ${STATUS}\n"',
    '        ;;',
    '      changes-requested)',
    '        REASON=$(grep -m1 "^Primary Reason Code:" "$HANDOFF" | sed \'s/^Primary Reason Code:[[:space:]]*//\' | sed \'s/[[:space:]]*$//\')',
    '        PR_NUMBER=$(grep -m1 "^PR:" "$HANDOFF" | sed \'s/^PR:[[:space:]]*//\' | sed \'s/[[:space:]]*$//\')',
    '        case "$REASON" in',
    '          pr-review-feedback|bot-feedback|ci-failure)',
    '            if [ -z "$PR_NUMBER" ]; then',
    '              ACTIVE_HANDOFFS="${ACTIVE_HANDOFFS}${HANDOFF}: ${STATUS}\n"',
    '            fi',
    '            ;;',
    '          *)',
    '            ACTIVE_HANDOFFS="${ACTIVE_HANDOFFS}${HANDOFF}: ${STATUS}\n"',
    '            ;;',
    '        esac',
    '        ;;',
    '    esac',
    '  fi',
    "done",
    "",
    'if [ -n "$ACTIVE_HANDOFFS" ]; then',
    '  if command -v btrain >/dev/null 2>&1 && btrain override consume --repo . --action push --actor "pre-push hook" >/dev/null 2>&1; then',
    '    echo ""',
    '    echo "btrain: allowing one push due to a human-confirmed audited override."',
    '    exit 0',
    '  fi',
    '  ',
    '  echo ""',
    '  echo "✖ btrain: blocked push — unresolved handoff state is still active."',
    '  echo "  ↳ Why: Pushing while lanes are active can overwrite in-progress work."',
    '  echo ""',
    '  echo "  Active handoffs:"',
    '  printf "%b" "$ACTIVE_HANDOFFS" | sed \'s/^/    /\'',
    '  echo ""',
    '  echo "  ✦ Fix: Resolve all active lanes first:"',
    '  echo "         btrain handoff resolve --lane <id> --summary \"...\""',
    '  echo "         Or request a one-time bypass:"',
    '  echo "         btrain override grant --action push --requested-by <agent> --confirmed-by <human> --reason \"...\""',
    '  exit 1',
    "fi",
    "",
    "exit 0",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Lane configuration
// ---------------------------------------------------------------------------

function laneIdToSequenceIndex(laneId) {
  const normalized = String(laneId || "").trim().toLowerCase()
  if (!/^[a-z]+$/.test(normalized)) {
    return Number.POSITIVE_INFINITY
  }

  let index = 0
  for (const character of normalized) {
    index = index * 26 + (character.charCodeAt(0) - 96)
  }

  return index - 1
}

function compareLaneIds(left, right) {
  const leftIndex = laneIdToSequenceIndex(left)
  const rightIndex = laneIdToSequenceIndex(right)
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex
  }
  return String(left).localeCompare(String(right))
}

function buildLaneId(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new BtrainError({
      message: `Invalid lane index: ${index}.`,
      reason: "Lane indices must be non-negative integers.",
      fix: "Check the [lanes] config in .btrain/project.toml and run \`btrain doctor\` to verify lane setup.",
    })
  }

  let remaining = index
  let laneId = ""
  do {
    laneId = String.fromCharCode(97 + (remaining % 26)) + laneId
    remaining = Math.floor(remaining / 26) - 1
  } while (remaining >= 0)

  return laneId
}

function buildLaneIds(count) {
  return Array.from({ length: count }, (_, index) => buildLaneId(index))
}

function getCollaborationAgentNames(config) {
  const explicitAgents = normalizeStringList(config?.agents?.active)
  if (explicitAgents.length > 0) {
    return [...new Set(explicitAgents)]
  }

  const defaults = []
  for (const agentName of [config?.agents?.writer_default, config?.agents?.reviewer_default]) {
    const normalized = normalizeAgentName(agentName)
    if (
      normalized
      && !isAnyOtherReviewerValue(normalized)
      && !defaults.some((value) => value.toLowerCase() === normalized.toLowerCase())
    ) {
      defaults.push(normalized)
    }
  }

  return defaults
}

function getLanesPerAgent(config, defaultValue = DEFAULT_LANES_PER_AGENT) {
  return normalizePositiveInteger(config?.lanes?.per_agent, defaultValue, "[lanes].per_agent")
}

function getDerivedLaneIds(config) {
  const configuredCollaboratorCount = getCollaborationAgentNames(config).length
  const collaboratorCount = configuredCollaboratorCount > 0
    ? configuredCollaboratorCount
    : DEFAULT_COLLABORATION_AGENT_COUNT
  return buildLaneIds(collaboratorCount * getLanesPerAgent(config))
}

function getConfiguredLaneSectionIds(lanes) {
  return Object.entries(lanes || {})
    .filter(([key, value]) => !RESERVED_LANE_METADATA_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value))
    .map(([key]) => key)
    .sort(compareLaneIds)
}

function getExplicitLaneIds(lanes) {
  return normalizeStringList(lanes?.ids)
    .map((value) => value.toLowerCase())
    .sort(compareLaneIds)
}

function getLaneConfigs(config) {
  const lanes = config?.lanes
  if (!lanes || lanes.enabled === false) {
    return null
  }

  const configuredIds = getConfiguredLaneSectionIds(lanes)
  const explicitIds = getExplicitLaneIds(lanes)
  const laneIds = explicitIds.length > 0
    ? [...new Set([...explicitIds, ...configuredIds])].sort(compareLaneIds)
    : configuredIds.length > 0
      ? configuredIds
      : getDerivedLaneIds(config)

  const laneConfigs = []
  for (const id of laneIds) {
    const laneSection = lanes[id]
    const handoffPath = laneSection?.handoff_path || `.claude/collab/HANDOFF_${id.toUpperCase()}.md`
    laneConfigs.push({ id, handoffPath })
  }

  return laneConfigs
}

function isLanesEnabled(config) {
  return getLaneConfigs(config) !== null
}

function getLaneHandoffPath(repoRoot, config, laneId) {
  const laneConfigs = getLaneConfigs(config)
  if (!laneConfigs) {
    return null
  }

  const lane = laneConfigs.find((l) => l.id === laneId)
  if (!lane) {
    throw new BtrainError({
      message: `Unknown lane: ${laneId}.`,
      reason: "The specified lane ID is not configured in this repo.",
      fix: `Use --lane with one of the available lanes.`,
      context: `Available lanes: ${laneConfigs.map((l) => l.id).join(", ")}.`,
    })
  }

  const configuredPath = lane.handoffPath
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath)
}

async function readLaneState(repoRoot, config, laneId) {
  const handoffPath = getLaneHandoffPath(repoRoot, config, laneId)
  const current = handoffPath
    ? await readCurrentState(repoRoot, { config, handoffPath, laneId })
    : { ...DEFAULT_CURRENT }
  return { ...current, _laneId: laneId }
}

async function readAllLaneStates(repoRoot, config) {
  const laneConfigs = getLaneConfigs(config)
  if (!laneConfigs) {
    return null
  }

  const states = []
  for (const lane of laneConfigs) {
    states.push(await readLaneState(repoRoot, config, lane.id))
  }
  return states
}

function findAvailableLane(laneStates) {
  // Prefer idle > resolved lanes
  const idle = laneStates.find((s) => s.status === "idle")
  if (idle) return idle._laneId

  const repurposeReady = laneStates.find((state) => classifyRepurposeReady(state).ready)
  if (repurposeReady) return repurposeReady._laneId

  const resolved = laneStates.find((s) => s.status === "resolved")
  if (resolved) return resolved._laneId

  return null
}

function isLaneActiveStatus(status) {
  return ACTIVE_LANE_STATUSES.has(status)
}

function validateHandoffStatus(status, label = "--status") {
  if (status === undefined) {
    return
  }

  if (!VALID_HANDOFF_STATUSES.has(status)) {
    throw new BtrainError({
      message: `Invalid handoff status: "${status}".`,
      reason: `${label} received an unrecognized value.`,
      fix: `Use one of the valid statuses: ${[...VALID_HANDOFF_STATUSES].join(", ")}.`,
    })
  }
}

function defaultNextActionForStatus(status, { owner = "", reviewer = "" } = {}) {
  switch (status) {
    case "in-progress":
      return "Work within the locked files, keep the lane in-progress, and hand off for review when ready."
    case "needs-review":
      return reviewer
        ? `Waiting on ${reviewer} to review the lane.`
        : "Waiting on peer review."
    case "ready-for-pr":
      return "Local peer review is approved. Create or link the GitHub PR, then enter the PR review loop."
    case "pr-review":
      return "Waiting on GitHub PR review feedback from required bots and checks."
    case "ready-to-merge":
      return "PR feedback is clear. Merge the PR, then mark the lane resolved."
    case "changes-requested":
      return reviewer
        ? `Address ${reviewer}'s review findings in the same lane and re-handoff for review.`
        : "Address the review findings in the same lane and re-handoff for review."
    case "repair-needed":
      return owner
        ? `Workflow repair needed before normal work resumes. ${owner} should inspect the lane state and repair it manually.`
        : "Workflow repair needed before normal work resumes."
    case "resolved":
      return "Await the next task."
    case "idle":
      return "Claim the next task."
    default:
      return ""
  }
}

function normalizeReasonTags(value) {
  const tags = normalizeOptionArray(value)
    ?.flatMap((item) => String(item).split(","))
    .map((tag) => tag.trim())
    .filter(Boolean)

  return tags && tags.length > 0 ? [...new Set(tags)] : []
}

function validateReasonCodeForStatus(status, reasonCode, label = "--reason-code") {
  const validCodes = REASON_CODES_BY_STATUS[status]
  if (!validCodes || !reasonCode) {
    return
  }

  if (!validCodes.has(reasonCode)) {
    throw new BtrainError({
      message: `Invalid reason code "${reasonCode}" for status "${status}".`,
      reason: `${label} must match one of the predefined codes for this status.`,
      fix: `Use --reason-code with one of: ${[...validCodes].join(", ")}.`,
    })
  }
}

function validateReasonTags(reasonTags, label = "--reason-tag") {
  for (const tag of reasonTags) {
    if (!REASON_TAG_PATTERN.test(tag)) {
      throw new BtrainError({
        message: `Invalid reason tag: "${tag}".`,
        reason: `${label} values must be lowercase slug tokens (letters, numbers, hyphens).`,
        fix: `Use a format like "smoke-check" or "locks". Example: --reason-tag smoke-check`,
      })
    }
  }
}

function resolveReasonMetadata(existingCurrent, nextStatus, options = {}, { requireReasonOnTransition = false } = {}) {
  const validCodes = REASON_CODES_BY_STATUS[nextStatus]
  const reasonCodeProvided = options["reason-code"] !== undefined
  const reasonTagsProvided = options["reason-tag"] !== undefined

  if (!validCodes) {
    if (reasonCodeProvided || reasonTagsProvided) {
      throw new BtrainError({
        message: "`--reason-code` and `--reason-tag` are not supported for this status.",
        reason: "Reason codes are only applicable to `changes-requested` and `repair-needed` transitions.",
        fix: "Remove --reason-code and --reason-tag from your command, or change --status to `changes-requested` or `repair-needed`.",
      })
    }
    return { reasonCode: "", reasonTags: [] }
  }

  const nextReasonCode = reasonCodeProvided
    ? String(options["reason-code"]).trim()
    : nextStatus === existingCurrent.status
      ? String(existingCurrent.reasonCode || "").trim()
      : ""
  const nextReasonTags = reasonTagsProvided
    ? normalizeReasonTags(options["reason-tag"])
    : nextStatus === existingCurrent.status
      ? normalizeReasonTags(existingCurrent.reasonTags)
      : []

  if (requireReasonOnTransition && nextStatus !== existingCurrent.status && !nextReasonCode) {
    throw new BtrainError({
      message: `Entering \`${nextStatus}\` requires a reason code.`,
      reason: "Transitions into this status require an audit trail so the reviewer or repair owner knows why.",
      fix: `Add --reason-code to your command. Valid codes: ${[...validCodes].join(", ")}.`,
    })
  }

  if (!nextReasonCode && nextReasonTags.length > 0) {
    throw new BtrainError({
      message: "`--reason-tag` requires `--reason-code`.",
      reason: "Tags are supplementary metadata that only make sense when a primary reason code is set.",
      fix: "Add --reason-code <code> before --reason-tag. Example: --reason-code spec-mismatch --reason-tag smoke-check",
    })
  }

  validateReasonCodeForStatus(nextStatus, nextReasonCode)
  validateReasonTags(nextReasonTags)

  return {
    reasonCode: nextReasonCode,
    reasonTags: nextReasonTags,
  }
}

function normalizePathList(paths) {
  const normalized = (Array.isArray(paths) ? paths : [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)

  return [...new Set(normalized)].sort()
}

function normalizeLockedPathList(paths, knownPaths = []) {
  const normalizedPaths = normalizePathList(paths)
  const normalizedKnownPaths = normalizePathList(knownPaths)

  if (normalizedPaths.length !== 1 || normalizedKnownPaths.length < 2) {
    return normalizedPaths
  }

  const [legacyBlob] = normalizedPaths
  if (legacyBlob.includes(",")) {
    return normalizedPaths
  }

  // Older handoff files could collapse multiple locked paths into one space-separated field.
  const legacyParts = normalizePathList(legacyBlob.split(/\s+/))
  return samePathList(legacyParts, normalizedKnownPaths) ? legacyParts : normalizedPaths
}

function samePathList(left, right) {
  const normalizedLeft = normalizePathList(left)
  const normalizedRight = normalizePathList(right)
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  )
}

// ---------------------------------------------------------------------------
// Lock registry
// ---------------------------------------------------------------------------

function getLocksPath(repoRoot) {
  return path.join(repoRoot, ".btrain", LOCKS_FILENAME)
}

async function readLockRegistry(repoRoot) {
  const locksPath = getLocksPath(repoRoot)
  return readJson(locksPath, { version: 1, locks: [] })
}

async function writeLockRegistry(repoRoot, registry) {
  const locksPath = getLocksPath(repoRoot)
  await writeJson(locksPath, registry)
}

function checkLockConflicts(registry, laneId, files) {
  const conflicts = []
  for (const lock of registry.locks) {
    if (lock.lane === laneId) continue

    for (const file of files) {
      const lockPath = lock.path.endsWith("/") ? lock.path : lock.path + "/"
      const filePath = file.endsWith("/") ? file : file + "/"

      if (
        file === lock.path ||
        lock.path === file ||
        file.startsWith(lockPath) ||
        lock.path.startsWith(filePath)
      ) {
        conflicts.push({
          file,
          lockedBy: lock.lane,
          owner: lock.owner,
          path: lock.path,
        })
      }
    }
  }
  return conflicts
}

function getLocksLockfilePath(repoRoot) {
  return getLocksPath(repoRoot) + ".lock"
}

async function acquireLocks(repoRoot, laneId, owner, files) {
  if (!files || files.length === 0) return []

  return withFileLock(getLocksLockfilePath(repoRoot), async () => {
    const registry = await readLockRegistry(repoRoot)
    const conflicts = checkLockConflicts(registry, laneId, files)

    if (conflicts.length > 0) {
      const conflictMessages = conflicts.map(
        (c) => `  ${c.file} — locked by lane ${c.lockedBy} (${c.owner}): ${c.path}`,
      )
      throw new BtrainError({
        message: "File lock conflict.",
        reason: `Another lane already holds locks on the requested paths:\n${conflictMessages.join("\n")}`,
        fix: `Choose different files, wait for the other lane to resolve, or force-release with \`btrain locks release-lane --lane <conflicting-lane>\`.`,
        context: "Run `btrain locks` to see all active locks.",
      })
    }

    // Remove existing locks for this lane first
    registry.locks = registry.locks.filter((lock) => lock.lane !== laneId)

    // Add new locks
    const now = formatIsoTimestamp()
    for (const file of files) {
      registry.locks.push({
        path: file,
        lane: laneId,
        owner,
        acquired_at: now,
      })
    }

    await writeLockRegistry(repoRoot, registry)
    return registry.locks.filter((lock) => lock.lane === laneId)
  })
}

async function releaseLocks(repoRoot, laneId) {
  return withFileLock(getLocksLockfilePath(repoRoot), async () => {
    const registry = await readLockRegistry(repoRoot)
    const released = registry.locks.filter((lock) => lock.lane === laneId)
    registry.locks = registry.locks.filter((lock) => lock.lane !== laneId)
    await writeLockRegistry(repoRoot, registry)
    return released
  })
}

async function listLocks(repoRoot) {
  const registry = await readLockRegistry(repoRoot)
  return registry.locks
}

async function forceReleaseLock(repoRoot, lockPath) {
  return withFileLock(getLocksLockfilePath(repoRoot), async () => {
    const registry = await readLockRegistry(repoRoot)
    const before = registry.locks.length
    registry.locks = registry.locks.filter((lock) => lock.path !== lockPath)
    await writeLockRegistry(repoRoot, registry)
    return before - registry.locks.length
  })
}

function getLaneLocks(locks, laneId) {
  return (locks || []).filter((lock) => lock.lane === laneId)
}

function formatLockedPaths(paths) {
  const normalized = normalizePathList(paths)
  return normalized.length > 0 ? normalized.join(", ") : "(none)"
}

function buildLaneLockState(current, laneLocks) {
  const registryPaths = normalizePathList(laneLocks.map((lock) => lock.path))
  const handoffPaths = normalizeLockedPathList(current.lockedFiles, registryPaths)

  if (registryPaths.length === 0 && handoffPaths.length === 0) {
    return {
      lockState: isLaneActiveStatus(current.status) ? "missing" : "clear",
      lockCount: 0,
      lockPaths: [],
      handoffPaths,
    }
  }

  if (!samePathList(handoffPaths, registryPaths)) {
    return {
      lockState: "mismatch",
      lockCount: registryPaths.length,
      lockPaths: registryPaths,
      handoffPaths,
    }
  }

  return {
    lockState: isLaneActiveStatus(current.status) ? "active" : "stale",
    lockCount: registryPaths.length,
    lockPaths: registryPaths,
    handoffPaths,
  }
}

function classifyRepurposeReady(current, laneLocks = []) {
  const staleness = parseStaleness(current.lastUpdated)
  const hasLocks = Array.isArray(laneLocks) && laneLocks.length > 0
  const ready = current.status === "resolved" && !hasLocks && Boolean(staleness?.stale)
  const reason = ready ? `resolved and stale (${staleness.ageDays}d)` : ""

  return {
    ready,
    reason,
    staleness,
  }
}

function decorateLaneState(current, laneLocks) {
  const repurpose = classifyRepurposeReady(current, laneLocks)
  return {
    ...current,
    ...buildLaneLockState(current, laneLocks),
    staleness: repurpose.staleness,
    repurposeReady: repurpose.ready,
    repurposeReason: repurpose.reason,
  }
}

function decorateLaneStates(laneStates, locks) {
  return (laneStates || []).map((laneState) => decorateLaneState(laneState, getLaneLocks(locks, laneState._laneId)))
}

async function installPreCommitHook(repoRoot) {
  return installManagedHook(repoRoot, {
    filename: "pre-commit",
    marker: PRE_COMMIT_HOOK_MARKER,
    content: renderPreCommitHook(),
  })
}

async function installPrePushHook(repoRoot) {
  return installManagedHook(repoRoot, {
    filename: "pre-push",
    marker: PRE_PUSH_HOOK_MARKER,
    content: renderPrePushHook(),
  })
}

async function installManagedHook(repoRoot, { filename, marker, content }) {
  const gitHooksDir = await resolveGitHooksDir(repoRoot)
  if (!gitHooksDir) {
    return { installed: false, reason: "not-a-git-repo" }
  }

  const hookPath = path.join(gitHooksDir, filename)
  await ensureDir(gitHooksDir)

  if (await pathExists(hookPath)) {
    const existing = await readText(hookPath)
    if (existing.includes(marker)) {
      await writeText(hookPath, content)
      await fs.chmod(hookPath, 0o755)
      return { installed: true, reason: "updated" }
    }
    return { installed: false, reason: "existing-hook" }
  }

  await writeText(hookPath, content)
  await fs.chmod(hookPath, 0o755)
  return { installed: true, reason: "created" }
}

async function installGitHooks(repoRoot) {
  return {
    preCommit: await installPreCommitHook(repoRoot),
    prePush: await installPrePushHook(repoRoot),
  }
}

function renderHandoffTemplate(repoName) {
  return renderTemplate(TEMPLATE_DEFAULTS["handoff.md"], {
    repoName,
    timestamp: formatIsoTimestamp(),
  })
}

function normalizeRepoName(repoRoot) {
  return path.basename(repoRoot)
}

function getBrainTrainHome() {
  return path.resolve(process.env.BRAIN_TRAIN_HOME || path.join(os.homedir(), ".btrain"))
}

function getRepoPaths(repoRoot) {
  return {
    repoRoot,
    brainTrainDir: path.join(repoRoot, ".btrain"),
    eventsDir: path.join(repoRoot, ".btrain", "events"),
    historyDir: path.join(repoRoot, ".btrain", "history"),
    overridesDir: path.join(repoRoot, ".btrain", "overrides"),
    projectTomlPath: path.join(repoRoot, ".btrain", "project.toml"),
    reviewsDir: path.join(repoRoot, ".btrain", "reviews"),
    handoffNotesDir: path.join(repoRoot, ".btrain", HANDOFF_NOTES_DIRNAME),
    locksPath: path.join(repoRoot, ".btrain", LOCKS_FILENAME),
    handoffPath: path.resolve(repoRoot, DEFAULT_HANDOFF_RELATIVE_PATH),
    agentsPath: path.join(repoRoot, "AGENTS.md"),
    claudePath: path.join(repoRoot, "CLAUDE.md"),
    geminiPath: path.join(repoRoot, "GEMINI.md"),
    codexPromptsDir: path.join(repoRoot, ".codex", "prompts"),
    codexAgentsPath: path.join(repoRoot, ".codex", "prompts", "AGENTS.md"),
    skillsPath: path.join(repoRoot, ".claude", "skills"),
    agentSkillsPath: path.join(repoRoot, ".agents", "skills"),
    feedbackLogPath: path.join(repoRoot, ".claude", "collab", "FEEDBACK_LOG.md"),
  }
}

function getConfiguredHandoffPath(repoRoot, config) {
  const configuredPath =
    typeof config?.handoff_path === "string" && config.handoff_path.trim()
      ? config.handoff_path.trim()
      : DEFAULT_HANDOFF_RELATIVE_PATH

  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath)
}

function getConfiguredRepoPaths(repoRoot, config) {
  return {
    ...getRepoPaths(repoRoot),
    handoffPath: getConfiguredHandoffPath(repoRoot, config),
  }
}

function getWorkflowEventLogPath(repoRoot, config, laneId = "") {
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  const filename = laneId ? `lane-${laneId}.jsonl` : "repo.jsonl"
  return path.join(repoPaths.eventsDir, filename)
}

function getHandoffArchivePath(repoRoot, config, laneId = "") {
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  const filename = laneId ? `lane-${laneId}.md` : "repo.md"
  return path.join(repoPaths.historyDir, filename)
}

async function ensureGlobalLayout() {
  const homeDir = getBrainTrainHome()
  const templatesDir = path.join(homeDir, "templates")
  const historyDir = path.join(homeDir, "history")
  const registryPath = path.join(homeDir, "repos.json")

  await ensureDir(templatesDir)
  await ensureDir(historyDir)

  if (!(await pathExists(registryPath))) {
    await writeJson(registryPath, {
      version: 1,
      generated_at: formatIsoTimestamp(),
      repos: [],
    })
  }

  return {
    homeDir,
    templatesDir,
    historyDir,
    registryPath,
  }
}

// ---------------------------------------------------------------------------
// Template infrastructure (Phase 2)
// ---------------------------------------------------------------------------

function renderTemplate(templateContent, variables) {
  return templateContent.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    variables[key] !== undefined ? String(variables[key]) : match,
  )
}

function renderTomlArray(values) {
  return `[${normalizeStringList(values).map((value) => `"${escapeTomlString(value)}"`).join(", ")}]`
}

function formatInlineCodeList(values) {
  return values.map((value) => `\`${value}\``).join(", ")
}

function buildManagedBlockVariables(config, { includeFeedbackGuidance = true } = {}) {
  const collaborators = getCollaborationAgentNames(config)
  const laneIds = (getLaneConfigs(config) || getDerivedLaneIds(config)).map((lane) => lane.id || lane)
  const laneExamples = laneIds.slice(0, Math.min(laneIds.length, 6))
  const lanesPerAgent = getLanesPerAgent(config)
  const feedbackEnabled = includeFeedbackGuidance && getFeedbackConfig(config).enabled

  return {
    activeAgentsSummary:
      collaborators.length > 0
        ? formatInlineCodeList(collaborators)
        : 'not configured yet. Add `active = ["Agent A", "Agent B"]` under `[agents]`.',
    laneSummary: `${laneIds.length} lane(s) (${lanesPerAgent} per collaborating agent): ${formatInlineCodeList(laneIds)}`,
    laneExamples: formatInlineCodeList(laneExamples),
    feedbackGuidance: feedbackEnabled
      ? "- Use the `feedback-triage` skill when processing user-reported issues. It logs entries to `.claude/collab/FEEDBACK_LOG.md` and drives test-first resolution.\n- Use the `bug-fix` skill for developer-found bugs. Write a failing reproduction test before editing production code."
      : "",
  }
}

const MANAGED_BLOCK_TEMPLATE = [
  MANAGED_START,
  "## Brain Train Workflow",
  "",
  "This repo uses the `btrain` collaboration workflow.",
  "",
  "- **Always use CLI commands** (`btrain handoff`, `handoff claim`, `handoff update`, `handoff resolve`) to read and update handoff state. Do not read or edit `HANDOFF_*.md` files directly.",
  "- Keep the lane `Delegation Packet` current for active work: `Objective`, `Deliverable`, `Constraints`, `Acceptance checks`, `Budget`, and `Done when`.",
  "- When handing work to a reviewer, always fill the structured handoff fields: `Base`, `Pre-flight review`, `Files changed`, `Verification run`, `Remaining gaps`, `Why this was done`, and `Specific review asks`.",
  "- When `[pr_flow].enabled` is true, peer `handoff resolve` means local review approval and advances the lane to `ready-for-pr`; use `btrain pr create|poll|request-review` until GitHub bot feedback is clear and the PR is merged.",
  "- If the repo provides a `pre-handoff` skill, run it immediately before `btrain handoff update --status needs-review`.",
  "- Run `btrain handoff` before acting so btrain can verify the current agent and tell you whose turn it is.",
  "- Before editing, do a short pre-flight review of the locked files, nearby diff, and likely risk areas so you start from known problems.",
  "- Use `rtk` (Rust Token Killer) to execute shell commands when available to minimize token usage.",
  "- Run `btrain status` or `btrain doctor` if the local workflow files look stale.",
  "- Repo config lives at `.btrain/project.toml`.",
  "{{feedbackGuidance}}",
  "",
  "### Collaboration Setup",
  "",
  "- Active collaborating agents: {{activeAgentsSummary}}",
  "- Current lane target: {{laneSummary}}",
  "- Change `[agents].active` or `[lanes].per_agent`, then run `btrain init`, `btrain agents set`, or `btrain agents add` to scaffold missing lanes and refresh docs.",
  "",
  "### Multi-Lane Workflow",
  "",
  "When `[lanes]` is enabled in `project.toml`, agents work concurrently on separate lanes:",
  "",
  "- Use `--lane <id>` (e.g. {{laneExamples}}) with `handoff claim|update|resolve`.",
  "- Lock files with `--files \"path/\"` when claiming to prevent cross-lane collisions.",
  "- Run `btrain locks` to see active file locks.",
  "- When your lane is done locally, hand it to a peer reviewer while you continue on other work. In PR-flow repos, keep the lane locks through `ready-for-pr`, `pr-review`, and `ready-to-merge` until the PR merges or closes.",
  "",
  MANAGED_END,
].join("\n")

const TEMPLATE_DEFAULTS = {
  "managed-block.md": MANAGED_BLOCK_TEMPLATE,

  get "instruction-stub.md"() {
    return [
      MANAGED_BLOCK_TEMPLATE,
      "",
      "## Project-Specific Instructions",
      "",
      "Add repo-specific {{roleLabel}} instructions below. `btrain init` only updates the managed block above.",
      "",
    ].join("\n")
  },

  "handoff.md": [
    "## Current",
    "",
    "Lane: {{laneId}}",
    "Task: ",
    "Active Agent: ",
    "Peer Reviewer: ",
    "Status: idle",
    "Review Mode: manual",
    "Locked Files: ",
    "Next Action: Claim the next task for {{repoName}}. Use `btrain handoff claim --lane {{laneId}} --task \"...\" --owner \"...\" --reviewer \"...\" --files \"...\"`.",
    "Base: ",
    "Last Updated: btrain {{timestamp}}",
    "",
    "## Delegation Packet",
    "",
    "Objective:",
    "",
    "Fill this in when the lane is claimed or re-scoped.",
    "",
    "Deliverable:",
    "",
    "Fill this in when the lane is claimed or re-scoped.",
    "",
    "Constraints:",
    "",
    "- Stay within the current lane scope unless the lane is re-scoped.",
    "",
    "Acceptance checks:",
    "",
    "- Fill this in when the lane is claimed or re-scoped.",
    "",
    "Budget:",
    "",
    "Keep the first pass lane-scoped and explicit.",
    "",
    "Done when:",
    "",
    "The lane can move to `needs-review` or to a narrower follow-up handoff.",
    "",
    "## Context for Peer Review",
    "",
    "Pre-flight review:",
    "",
    "- [ ] Checked locked files, nearby diff, and likely risk areas before editing",
    "",
    "Files changed:",
    "",
    "- None yet",
    "",
    "Why this was done:",
    "",
    "- Bootstrap created by `btrain init`.",
    "",
    "Specific review asks:",
    "",
    "- [ ] Fill this in before handoff",
    "",
    "## Review Response",
    "",
    "Pending.",
    "",
    "## Previous Handoffs",
    "",
    "- None yet",
    "",
  ].join("\n"),

  "project.toml": [
    "# btrain project config",
    'name = "{{repoName}}"',
    'repo_path = "{{repoPath}}"',
    'handoff_path = ".claude/collab/HANDOFF_A.md"',
    'default_review_mode = "manual"',
    'created_at = "{{timestamp}}"',
    "",
    "[harness]",
    'active_profile = "default"',
    "",
    "[agents]",
    "active = {{activeAgentsToml}}",
    'writer_default = "{{writerDefault}}"',
    'reviewer_default = "{{reviewerDefault}}"',
    "",
    "[agents.runners]",
    '# "Opus 4.6" = "notify"',
    '# "GPT-5 Codex" = "codex"',
    "",
    "[reviews]",
    "parallel_enabled = true",
    "sequential_enabled = false",
    "sequential_triggers = []",
    "",
    "[pr_flow]",
    "enabled = false",
    'base = "main"',
    'required_bots = ["codex", "unblocked"]',
    "",
    "[pr_flow.bots.codex]",
    'aliases = ["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"]',
    'request_body = "@codex review"',
    "",
    "[pr_flow.bots.unblocked]",
    'aliases = ["unblocked[bot]", "unblocked"]',
    'request_body = "@unblocked review again"',
    "",
    "[instructions]",
    'project_notes = ""',
    "",
    "[lanes]",
    "enabled = true",
    "per_agent = {{lanesPerAgent}}",
    "",
    "{{laneSections}}",
    "",
  ].join("\n"),

  "feedback-log.md": [
    "# Feedback Log",
    "",
    "User-reported feedback for {{repoName}}. Single source of truth for triage and resolution.",
    "",
    "| Status | Meaning |",
    "|--------|---------|",
    "| new | Logged, awaiting user confirmation of triage |",
    "| triaged | User confirmed category, ready for test/fix |",
    "| test-written | Reproduction test exists and fails |",
    "| fixed | Code fix applied, test passes |",
    "| verified | Full test suite passes, no regressions |",
    "| blocked-spec | Requires spec change via speckit before work begins |",
    "",
    "---",
    "",
  ].join("\n"),

  "pre-commit-hook.sh": renderPreCommitHook(),
  "pre-push-hook.sh": renderPrePushHook(),
}

async function ensureTemplates() {
  const { templatesDir } = await ensureGlobalLayout()

  for (const [filename, defaultContent] of Object.entries(TEMPLATE_DEFAULTS)) {
    const filePath = path.join(templatesDir, filename)
    if (!(await pathExists(filePath))) {
      await writeText(filePath, defaultContent)
    } else if (filename === "managed-block.md" || filename === "instruction-stub.md") {
      // The managed block (between btrain:managed fences) is btrain-controlled
      // content — the same contract as repo-level AGENTS.md/CLAUDE.md. User
      // customizations go outside the fences and are preserved by
      // replaceManagedBlock().
      const existing = await readText(filePath)
      const updated = replaceManagedBlock(existing, MANAGED_BLOCK_TEMPLATE)
      if (updated !== existing) {
        await writeText(filePath, updated)
      }
    } else if (filename === "project.toml") {
      // The default project scaffold needs to stay in sync with runtime lane/
      // agent expectations so new repos don't keep generating stale config.
      const existing = await readText(filePath)
      if (existing !== defaultContent) {
        await writeText(filePath, defaultContent)
      }
    }
  }

  return templatesDir
}

async function loadTemplate(filename) {
  const templatesDir = await ensureTemplates()
  return readText(path.join(templatesDir, filename))
}

function shouldSkipBundledAgentchattrPath(relativePath = "") {
  if (!relativePath) {
    return false
  }

  const normalizedSegments = String(relativePath)
    .split(path.sep)
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (normalizedSegments.some((segment) => EXCLUDED_AGENTCHATTR_RUNTIME_NAMES.has(segment))) {
    return true
  }

  const leafName = normalizedSegments[normalizedSegments.length - 1] || ""
  return leafName.endsWith(".pyc")
}

async function copyMissingTree(sourcePath, targetPath, options = {}, relativePath = "") {
  const sourceStats = await fs.lstat(sourcePath)
  if (sourceStats.isSymbolicLink()) {
    return copyMissingTree(await fs.realpath(sourcePath), targetPath, options, relativePath)
  }

  if (options.shouldSkip?.({ relativePath, sourcePath, sourceStats, targetPath })) {
    return 0
  }

  if (sourceStats.isDirectory()) {
    await ensureDir(targetPath)
    const entries = await fs.readdir(sourcePath)
    let copiedCount = 0
    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
      const nextRelativePath = relativePath ? path.join(relativePath, entry) : entry
      copiedCount += await copyMissingTree(
        path.join(sourcePath, entry),
        path.join(targetPath, entry),
        options,
        nextRelativePath,
      )
    }
    return copiedCount
  }

  if (!options.overwrite && (await pathExists(targetPath))) {
    return 0
  }

  await ensureDir(path.dirname(targetPath))
  await fs.copyFile(sourcePath, targetPath)
  await fs.chmod(targetPath, sourceStats.mode)
  return 1
}

async function syncBundledSkills(targetSkillsPath, options = {}) {
  const sourceSkillsDir = options.sourceSkillsDir || BUNDLED_SKILLS_DIR
  if (!(await pathExists(sourceSkillsDir))) {
    return {
      copiedSkills: [],
      skippedSkills: [],
      skippedReason: "bundle-missing",
    }
  }

  if (path.resolve(sourceSkillsDir) === path.resolve(targetSkillsPath)) {
    return {
      copiedSkills: [],
      skippedSkills: [],
      skippedReason: "self",
    }
  }

  await ensureDir(targetSkillsPath)

  const copiedSkills = []
  const skippedSkills = []
  const sourceEntries = await fs.readdir(sourceSkillsDir, { withFileTypes: true })

  for (const entry of sourceEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue
    }

    if (EXCLUDED_BUNDLED_SKILLS.has(entry.name)) {
      skippedSkills.push(entry.name)
      continue
    }

    if (options.skillName && entry.name !== options.skillName) {
      continue
    }

    const sourcePath = path.join(sourceSkillsDir, entry.name)
    const targetPath = path.join(targetSkillsPath, entry.name)
    const targetExisted = await pathExists(targetPath)
    const copiedCount = await copyMissingTree(sourcePath, targetPath, {
      overwrite: options.overwrite,
    })
    if (!targetExisted || (options.overwrite && copiedCount > 0)) {
      copiedSkills.push(entry.name)
    }
  }

  return {
    copiedSkills,
    skippedSkills,
    skippedReason: "",
  }
}

async function syncBundledSkillTargets(repoPaths) {
  const claude = await syncBundledSkills(repoPaths.skillsPath, {
    sourceSkillsDir: BUNDLED_SKILLS_DIR,
  })
  const agents = await syncBundledSkills(repoPaths.agentSkillsPath, {
    sourceSkillsDir: BUNDLED_AGENT_SKILLS_DIR,
  })
  const copiedSkills = Array.from(new Set([
    ...claude.copiedSkills,
    ...agents.copiedSkills,
  ])).sort()
  const skippedSkills = Array.from(new Set([
    ...claude.skippedSkills,
    ...agents.skippedSkills,
  ])).sort()
  const skippedReason =
    claude.skippedReason === "self" && agents.skippedReason === "self"
      ? "self"
      : ""

  return {
    copiedSkills,
    skippedSkills,
    skippedReason,
    targets: {
      claude,
      agents,
    },
  }
}

async function syncBundledDevTools(repoRoot) {
  const copiedTools = []
  const missingTools = []
  const selfTools = []
  let copiedFileCount = 0

  for (const tool of BUNDLED_DEV_TOOLS) {
    if (!(await pathExists(tool.sourcePath))) {
      missingTools.push(tool.label)
      continue
    }

    const targetPath = path.join(repoRoot, ...tool.targetParts)
    if (path.resolve(tool.sourcePath) === path.resolve(targetPath)) {
      selfTools.push(tool.label)
      continue
    }

    const copiedForTool = await copyMissingTree(tool.sourcePath, targetPath, {
      shouldSkip: tool.shouldSkip,
    })
    copiedFileCount += copiedForTool

    if (copiedForTool > 0) {
      copiedTools.push(tool.label)
    }
  }

  let skippedReason = ""
  if (copiedTools.length === 0) {
    if (selfTools.length === BUNDLED_DEV_TOOLS.length) {
      skippedReason = "self"
    } else if (missingTools.length > 0) {
      skippedReason = "bundle-missing"
    } else {
      skippedReason = "no-missing-files"
    }
  }

  return {
    copiedTools,
    copiedFileCount,
    missingTools,
    selfTools,
    skippedReason,
  }
}

function buildLaneSections(laneIds) {
  return laneIds.flatMap((id) => [
    `[lanes.${id}]`,
    `handoff_path = ".claude/collab/HANDOFF_${id.toUpperCase()}.md"`,
    "",
  ]).join("\n").trimEnd()
}

function buildProjectTemplateVariables(repoRoot, agentNames = [], timestamp = formatIsoTimestamp(), options = {}) {
  const collaborators = normalizeStringList(agentNames)
  const lanesPerAgent = normalizePositiveInteger(
    options.lanesPerAgent,
    DEFAULT_LANES_PER_AGENT,
    "--lanes-per-agent",
  )
  const configSeed = {
    lanes: { per_agent: lanesPerAgent },
    ...(collaborators.length > 0 ? { agents: { active: collaborators } } : {}),
  }

  return {
    repoName: normalizeRepoName(repoRoot),
    repoPath: repoRoot,
    timestamp,
    activeAgentsToml: renderTomlArray(collaborators),
    writerDefault: collaborators[0] || "",
    reviewerDefault: collaborators[1] || "",
    lanesPerAgent,
    laneSections: buildLaneSections(getDerivedLaneIds(configSeed)),
  }
}

function findTomlSectionBounds(content, sectionName) {
  const lines = content.split("\n")
  const header = `[${sectionName}]`
  let start = -1
  let end = lines.length

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === header) {
      start = index
      break
    }
  }

  if (start === -1) {
    return null
  }

  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\[.+\]$/.test(lines[index].trim())) {
      end = index
      break
    }
  }

  return { lines, start, end }
}

function upsertTomlEntryInSection(content, sectionName, key, valueLine, { createSectionLines = [] } = {}) {
  const bounds = findTomlSectionBounds(content, sectionName)
  if (!bounds) {
    const appendix = createSectionLines.length > 0 ? createSectionLines : [`[${sectionName}]`, valueLine]
    return `${content.trimEnd()}\n\n${appendix.join("\n")}\n`
  }

  const lines = [...bounds.lines]
  const entryIndex = lines
    .slice(bounds.start + 1, bounds.end)
    .findIndex((line) => new RegExp(`^${key}\\s*=`).test(line.trim()))

  if (entryIndex >= 0) {
    lines[bounds.start + 1 + entryIndex] = valueLine
  } else {
    lines.splice(bounds.start + 1, 0, valueLine)
  }

  return lines.join("\n")
}

function syncAgentsSectionInToml(content, agentNames) {
  const collaborators = normalizeStringList(agentNames)
  const createSectionLines = [
    "[agents]",
    `active = ${renderTomlArray(collaborators)}`,
    `writer_default = "${escapeTomlString(collaborators[0] || "")}"`,
    `reviewer_default = "${escapeTomlString(collaborators[1] || "")}"`,
  ]

  let nextContent = upsertTomlEntryInSection(
    content,
    "agents",
    "active",
    `active = ${renderTomlArray(collaborators)}`,
    { createSectionLines },
  )
  nextContent = upsertTomlEntryInSection(
    nextContent,
    "agents",
    "writer_default",
    `writer_default = "${escapeTomlString(collaborators[0] || "")}"`,
  )
  nextContent = upsertTomlEntryInSection(
    nextContent,
    "agents",
    "reviewer_default",
    `reviewer_default = "${escapeTomlString(collaborators[1] || "")}"`,
  )

  return nextContent
}

function syncLaneConfigInToml(content, laneIds, options = {}) {
  const perAgent = normalizePositiveInteger(
    options.perAgent,
    DEFAULT_LANES_PER_AGENT,
    "[lanes].per_agent",
  )
  let nextContent = content
  const laneSectionBounds = findTomlSectionBounds(nextContent, "lanes")

  if (!laneSectionBounds) {
    const lanesBlock = [
      "[lanes]",
      "enabled = true",
      `per_agent = ${perAgent}`,
      `ids = ${renderTomlArray(laneIds)}`,
      "",
      buildLaneSections(laneIds),
    ].join("\n")
    return `${nextContent.trimEnd()}\n\n${lanesBlock}\n`
  }

  const laneSectionLines = laneSectionBounds.lines
    .slice(laneSectionBounds.start + 1, laneSectionBounds.end)
    .map((line) => line.trim())
  if (!laneSectionLines.some((line) => /^enabled\s*=/.test(line))) {
    nextContent = upsertTomlEntryInSection(nextContent, "lanes", "enabled", "enabled = true")
  }
  nextContent = upsertTomlEntryInSection(nextContent, "lanes", "per_agent", `per_agent = ${perAgent}`)
  nextContent = upsertTomlEntryInSection(nextContent, "lanes", "ids", `ids = ${renderTomlArray(laneIds)}`)

  for (const laneId of laneIds) {
    if (findTomlSectionBounds(nextContent, `lanes.${laneId}`)) {
      continue
    }
    nextContent = `${nextContent.trimEnd()}\n\n${buildLaneSections([laneId])}\n`
  }

  return nextContent
}

function extractManagedBlock(content) {
  const startIndex = content.indexOf(MANAGED_START)
  const endIndex = content.indexOf(MANAGED_END)
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null
  }
  return content.slice(startIndex, endIndex + MANAGED_END.length).trim()
}

async function readJson(targetPath, fallbackValue) {
  if (!(await pathExists(targetPath))) {
    return fallbackValue
  }

  try {
    const content = await readText(targetPath)
    return JSON.parse(content)
  } catch {
    return fallbackValue
  }
}

async function writeJson(targetPath, value) {
  await writeText(targetPath, `${JSON.stringify(value, null, 2)}\n`)
}

function normalizeOverrideAction(action) {
  return typeof action === "string" ? action.trim().toLowerCase() : ""
}

function validateOverrideAction(action) {
  const normalized = normalizeOverrideAction(action)
  if (!VALID_OVERRIDE_ACTIONS.has(normalized)) {
    throw new BtrainError({
      message: `Invalid override action: "${action || "(empty)"}"`,
      reason: "The --action value is not recognized.",
      fix: `Use --action with one of: ${[...VALID_OVERRIDE_ACTIONS].join(", ")}.`,
    })
  }
  return normalized
}

function buildOverrideId(action) {
  const entropy = Math.random().toString(36).slice(2, 8)
  return `ovr_${normalizeOverrideAction(action).replaceAll(/[^a-z0-9]+/g, "-")}_${Date.now().toString(36)}_${entropy}`
}

function getOverridePath(repoRoot, overrideId) {
  return path.join(getRepoPaths(repoRoot).overridesDir, `${overrideId}.json`)
}

async function readOverrideRecord(overridePath) {
  const record = await readJson(overridePath, null)
  if (!record || typeof record !== "object") {
    return null
  }
  return record
}

async function listActiveOverrides(repoRoot) {
  const { overridesDir } = getRepoPaths(repoRoot)
  if (!(await pathExists(overridesDir))) {
    return []
  }

  const entries = await fs.readdir(overridesDir, { withFileTypes: true })
  const overrides = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue
    }

    const overridePath = path.join(overridesDir, entry.name)
    const record = await readOverrideRecord(overridePath)
    if (!record) {
      continue
    }
    overrides.push({
      ...record,
      path: overridePath,
    })
  }

  return overrides.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
}

function formatOverrideSummary(record) {
  const scope = record.scope === "lane" && record.laneId ? `lane ${record.laneId}` : "repo"
  const requestedBy = record.requestedBy || "unknown"
  const confirmedBy = record.confirmedBy || "unknown"
  return `${record.action} (${scope}, requested by ${requestedBy}, confirmed by ${confirmedBy})`
}

function getLaneOverrides(overrides, laneId) {
  return (overrides || []).filter((record) => (record.laneId || "") === (laneId || ""))
}

async function grantOverride(repoRoot, options = {}) {
  const config = options.config || (await readProjectConfig(repoRoot))
  const laneConfigs = getLaneConfigs(config)
  const action = validateOverrideAction(options.action)
  const requestedBy = normalizeAgentName(options.requestedBy || options["requested-by"])
  const confirmedBy = normalizeAgentName(options.confirmedBy || options["confirmed-by"])
  const reason = typeof options.reason === "string" ? options.reason.trim() : ""
  const laneId = typeof options.lane === "string" ? options.lane.trim() : ""

  if (!requestedBy) {
    throw new BtrainError({
      message: "`btrain override grant` requires --requested-by.",
      reason: "An audited override must identify which agent requested it.",
      fix: `btrain override grant --action ${action} --requested-by <agent> --confirmed-by <human> --reason "..."`,
    })
  }
  if (!confirmedBy) {
    throw new BtrainError({
      message: "`btrain override grant` requires --confirmed-by.",
      reason: "An audited override must be confirmed by a human.",
      fix: `btrain override grant --action ${action} --requested-by ${requestedBy} --confirmed-by <human> --reason "..."`,
    })
  }
  if (!reason) {
    throw new BtrainError({
      message: "`btrain override grant` requires --reason.",
      reason: "An audited override must have a documented reason for the audit trail.",
      fix: `btrain override grant --action ${action} --requested-by ${requestedBy} --confirmed-by ${confirmedBy} --reason "..."`,
    })
  }

  if (action === "needs-review" && laneConfigs && !laneId) {
    throw new BtrainError({
      message: "`btrain override grant --action needs-review` requires --lane when [lanes] is enabled.",
      reason: "The needs-review override must target a specific lane in multi-lane repos.",
      fix: `btrain override grant --action needs-review --lane <id> --requested-by ${requestedBy} --confirmed-by ${confirmedBy} --reason "..."`,
    })
  }
  if (action === "push" && laneId) {
    throw new BtrainError({
      message: "`btrain override grant --action push` does not accept --lane.",
      reason: "Push overrides are repo-scoped (they bypass the pre-push hook for the whole repo).",
      fix: "Remove --lane from the command.",
    })
  }
  if (laneId && laneConfigs) {
    getLaneHandoffPath(repoRoot, config, laneId)
  }

  const scope = laneId ? "lane" : "repo"
  const overrides = await listActiveOverrides(repoRoot)
  const duplicate = overrides.find((record) => record.action === action && (record.laneId || "") === laneId)
  if (duplicate) {
    throw new BtrainError({
      message: `An active override already exists for \`${action}\` ${laneId ? `on lane ${laneId}` : "at repo scope"}.`,
      reason: `Override ${duplicate.id} is still pending. Only one override per action+scope is allowed.`,
      fix: `Consume or wait for the existing override first. To consume it: btrain override consume --action ${action}${laneId ? ` --lane ${laneId}` : ""} --actor <agent>`,
    })
  }

  const id = buildOverrideId(action)
  const record = {
    version: 1,
    id,
    action,
    scope,
    laneId,
    requestedBy,
    confirmedBy,
    reason,
    createdAt: formatIsoTimestamp(),
  }

  await writeJson(getOverridePath(repoRoot, id), record)
  await appendWorkflowEvent(repoRoot, config, {
    type: "override-granted",
    actor: requestedBy,
    laneId,
    details: {
      overrideId: id,
      action,
      scope,
      confirmedBy,
      reason,
    },
  })

  return record
}

async function consumeOverride(repoRoot, options = {}) {
  const config = options.config || (await readProjectConfig(repoRoot))
  const action = validateOverrideAction(options.action)
  const laneId = typeof options.laneId === "string"
    ? options.laneId.trim()
    : typeof options.lane === "string"
      ? options.lane.trim()
      : ""
  const overrideId = typeof options.overrideId === "string"
    ? options.overrideId.trim()
    : typeof options.id === "string"
      ? options.id.trim()
      : ""
  const actorLabel = options.actorLabel || options.actor || "btrain"
  const overrides = await listActiveOverrides(repoRoot)

  let record = null
  if (overrideId) {
    record = overrides.find((candidate) => candidate.id === overrideId) || null
    if (!record) {
      throw new BtrainError({
        message: `No active override found for id "${overrideId}".`,
        reason: "The override may have already been consumed or the ID is incorrect.",
        fix: "Run `btrain override list` to see active overrides, or grant a new one with `btrain override grant`.",
      })
    }
  } else {
    record = overrides.find((candidate) => candidate.action === action && (candidate.laneId || "") === laneId) || null
    if (!record) {
      throw new BtrainError({
        message: `No active override found for \`${action}\` ${laneId ? `on lane ${laneId}` : "at repo scope"}.`,
        reason: "No matching pending override exists for this action and scope.",
        fix: `Grant one first: btrain override grant --action ${action}${laneId ? ` --lane ${laneId}` : ""} --requested-by <agent> --confirmed-by <human> --reason "..."`,
      })
    }
  }

  if (record.action !== action) {
    throw new BtrainError({
      message: `Override ${record.id} is for \`${record.action}\`, not \`${action}\`.`,
      reason: "The override's action does not match the requested action.",
      fix: `Use --action ${record.action} or grant a new override for \`${action}\`.`,
    })
  }
  if (laneId && (record.laneId || "") !== laneId) {
    throw new BtrainError({
      message: `Override ${record.id} is scoped to lane ${record.laneId || "(repo)"}, not lane ${laneId}.`,
      reason: "The override's lane scope does not match the requested lane.",
      fix: `Use --lane ${record.laneId || ""} to match the override, or grant a new override for lane ${laneId}.`,
    })
  }

  await fs.rm(record.path, { force: true })
  await appendWorkflowEvent(repoRoot, config, {
    type: "override-consumed",
    actor: actorLabel,
    laneId: record.laneId || "",
    details: {
      overrideId: record.id,
      action: record.action,
      scope: record.scope,
      requestedBy: record.requestedBy,
      confirmedBy: record.confirmedBy,
      reason: record.reason,
    },
  })

  return record
}

async function loadRegistry() {
  const { homeDir, registryPath } = await ensureGlobalLayout()
  const registry = await readJson(registryPath, {
    version: 1,
    generated_at: formatIsoTimestamp(),
    repos: [],
  })

  if (!Array.isArray(registry.repos)) {
    registry.repos = []
  }

  return {
    homeDir,
    registryPath,
    registry,
  }
}

async function saveRegistry(registryPath, registry) {
  registry.generated_at = formatIsoTimestamp()
  await writeJson(registryPath, registry)
}

function upsertRepoEntry(registry, entry) {
  const existingIndex = registry.repos.findIndex((repo) => repo.path === entry.path)
  if (existingIndex === -1) {
    registry.repos.push(entry)
  } else {
    registry.repos[existingIndex] = {
      ...registry.repos[existingIndex],
      ...entry,
      registered_at: registry.repos[existingIndex].registered_at || entry.registered_at,
      updated_at: entry.updated_at,
    }
  }
}

async function initRepo(repoPathInput, options = {}) {
  const repoRoot = path.resolve(repoPathInput)
  const stats = await fs.stat(repoRoot)
  if (!stats.isDirectory()) {
    throw new BtrainError({
      message: `Not a directory: ${repoRoot}`,
      reason: "btrain init requires a path to an existing directory.",
      fix: `Verify the path exists and is a directory: ls -la ${repoRoot}`,
    })
  }

  const repoName = normalizeRepoName(repoRoot)
  const repoPaths = getRepoPaths(repoRoot)
  const { registryPath, registry, homeDir } = await loadRegistry()

  // Seed global templates if needed
  await ensureTemplates()

  await ensureDir(repoPaths.brainTrainDir)
  await ensureDir(repoPaths.reviewsDir)
  await ensureDir(path.dirname(repoPaths.handoffPath))

  const now = formatIsoTimestamp()
  const requestedAgents = normalizeStringList(options.agent)
  const shouldScaffoldBundledSkills = options.scaffoldBundledSkills === true
  const shouldScaffoldDevTools = options.scaffoldDevTools === true
  const requestedLanesPerAgent = normalizePositiveInteger(
    options.lanesPerAgent,
    undefined,
    "--lanes-per-agent",
  )
  const templateVars = buildProjectTemplateVariables(repoRoot, requestedAgents, now, {
    lanesPerAgent: requestedLanesPerAgent,
  })
  const instructionTemplate = await loadTemplate("instruction-stub.md")

  if (!(await pathExists(repoPaths.projectTomlPath))) {
    const tomlTemplate = await loadTemplate("project.toml")
    await writeText(repoPaths.projectTomlPath, renderTemplate(tomlTemplate, templateVars))
  } else {
    let existingToml = await readText(repoPaths.projectTomlPath)
    const originalToml = existingToml
    const existingConfig = parseProjectToml(existingToml)

    if (requestedAgents.length > 0 || existingConfig?.agents?.active !== undefined) {
      const nextAgents = requestedAgents.length > 0
        ? requestedAgents
        : getCollaborationAgentNames(existingConfig)
      existingToml = syncAgentsSectionInToml(existingToml, nextAgents)
    }

    const nextConfig = parseProjectToml(existingToml)
    const nextLanesPerAgent = requestedLanesPerAgent ?? getLanesPerAgent(nextConfig)
    const desiredLaneIds = getDerivedLaneIds({
      ...nextConfig,
      lanes: {
        ...(nextConfig.lanes || {}),
        per_agent: nextLanesPerAgent,
      },
    })
    const syncedToml = syncLaneConfigInToml(existingToml, desiredLaneIds, {
      perAgent: nextLanesPerAgent,
    })

    if (syncedToml !== originalToml) {
      await writeText(repoPaths.projectTomlPath, syncedToml)
    }
  }

  const config = await readProjectConfig(repoRoot)
  const managedBlock = await getManagedBlockTemplate(repoRoot, { includeFeedbackGuidance: shouldScaffoldBundledSkills })
  const instructionTemplateVars = {
    roleLabel: "agent",
    ...buildManagedBlockVariables(config, { includeFeedbackGuidance: shouldScaffoldBundledSkills }),
  }

  const agentsExists = await pathExists(repoPaths.agentsPath)
  const agentsContent = agentsExists ? await readText(repoPaths.agentsPath) : ""
  await writeText(
    repoPaths.agentsPath,
    agentsExists
      ? replaceManagedBlock(agentsContent, managedBlock)
      : renderTemplate(instructionTemplate, instructionTemplateVars),
  )

  const claudeExists = await pathExists(repoPaths.claudePath)
  const claudeContent = claudeExists ? await readText(repoPaths.claudePath) : ""
  await writeText(
    repoPaths.claudePath,
    claudeExists
      ? replaceManagedBlock(claudeContent, managedBlock)
      : renderTemplate(instructionTemplate, { roleLabel: "Claude", ...buildManagedBlockVariables(config, { includeFeedbackGuidance: shouldScaffoldBundledSkills }) }),
  )

  // Symlink GEMINI.md → CLAUDE.md (Gemini CLI reads GEMINI.md)
  await ensureSymlink(repoPaths.claudePath, repoPaths.geminiPath)

  // Symlink .codex/prompts/AGENTS.md → ../../AGENTS.md (Codex CLI reads .codex/prompts/)
  await ensureDir(repoPaths.codexPromptsDir)
  await ensureSymlink(repoPaths.agentsPath, repoPaths.codexAgentsPath)

  // Only create the single-file handoff if lanes are NOT enabled.
  // When lanes are enabled, per-lane handoff files are created below instead.
  const laneConfigs = getLaneConfigs(config)
  if (!laneConfigs) {
    if (!(await pathExists(repoPaths.handoffPath))) {
      const handoffTemplate = await loadTemplate("handoff.md")
      await writeText(repoPaths.handoffPath, renderTemplate(handoffTemplate, { ...templateVars, laneId: "a" }))
    }
  }

  // Initialize lane handoff files if lanes are configured
  if (laneConfigs) {
    for (const lane of laneConfigs) {
      const laneHandoffPath = path.isAbsolute(lane.handoffPath)
        ? lane.handoffPath
        : path.resolve(repoRoot, lane.handoffPath)
      await ensureDir(path.dirname(laneHandoffPath))
      if (!(await pathExists(laneHandoffPath))) {
        const handoffTemplate = await loadTemplate("handoff.md")
        await writeText(laneHandoffPath, renderTemplate(handoffTemplate, { ...templateVars, laneId: lane.id, repoName: `${repoName} (lane ${lane.id})` }))
      }
    }
    // Initialize empty lock registry
    if (!(await pathExists(repoPaths.locksPath))) {
      await writeLockRegistry(repoRoot, { version: 1, locks: [] })
    }
  }

  // Scaffold FEEDBACK_LOG.md if feedback tracking is enabled and bundled skills are included.
  // --core-only skips bundled skills including feedback-triage, so the log is not useful without the skill.
  if (shouldScaffoldBundledSkills && getFeedbackConfig(config).enabled && !(await pathExists(repoPaths.feedbackLogPath))) {
    const feedbackLogTemplate = await loadTemplate("feedback-log.md")
    await writeText(repoPaths.feedbackLogPath, renderTemplate(feedbackLogTemplate, templateVars))
  }

  // Ensure .gitignore excludes btrain operational files
  await ensureBtrainGitignore(repoRoot, { includeDevToolIgnores: shouldScaffoldDevTools })

  const bundledSkillsResult = shouldScaffoldBundledSkills
    ? await syncBundledSkillTargets(repoPaths)
    : null
  const devToolsResult = shouldScaffoldDevTools
    ? await syncBundledDevTools(repoRoot)
    : null

  upsertRepoEntry(registry, {
    name: repoName,
    path: repoRoot,
    project_config_path: repoPaths.projectTomlPath,
    handoff_path: repoPaths.handoffPath,
    registered_at: now,
    updated_at: now,
  })
  await saveRegistry(registryPath, registry)

  let hookResult = null
  if (options.hooks) {
    hookResult = await installGitHooks(repoRoot)
  }

  return {
    repoName,
    repoRoot,
    homeDir,
    registryPath,
    repoPaths,
    hookResult,
    bundledSkillsResult,
    devToolsResult,
  }
}

async function syncActiveAgents(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  if (!config) {
    throw new BtrainError({
      message: "`btrain agents` requires an initialized repo.",
      reason: "No .btrain/project.toml was found at the resolved repo path.",
      fix: "Run `btrain init <repo-path>` first to bootstrap the repo.",
    })
  }

  const requestedAgents = normalizeStringList(options.agent)
  if (requestedAgents.length === 0) {
    throw new BtrainError({
      message: "`btrain agents` requires at least one agent name.",
      reason: "The --agent flag was not provided or was empty.",
      fix: "btrain agents set --repo . --agent claude --agent codex",
    })
  }

  const currentAgents = getCollaborationAgentNames(config)
  const nextAgents = options.mode === "add"
    ? [
      ...currentAgents,
      ...requestedAgents.filter(
        (candidate) => !currentAgents.some((existing) => existing.toLowerCase() === candidate.toLowerCase()),
      ),
    ]
    : requestedAgents

  return initRepo(repoRoot, {
    agent: nextAgents,
    lanesPerAgent: options.lanesPerAgent,
    scaffoldBundledSkills: false,
    scaffoldDevTools: false,
  })
}

async function findRepoRoot(startPath = process.cwd()) {
  let currentPath = path.resolve(startPath)

  while (true) {
    const currentProjectPath = path.join(currentPath, ".btrain", "project.toml")
    if (await pathExists(currentProjectPath)) {
      return currentPath
    }

    const parentPath = path.dirname(currentPath)
    if (parentPath === currentPath) {
      return null
    }

    currentPath = parentPath
  }
}

async function resolveRepoRoot(repoOverride) {
  if (repoOverride) {
    return path.resolve(repoOverride)
  }

  const repoRoot = await findRepoRoot()
  if (!repoRoot) {
    throw new BtrainError({
      message: "Could not find a bootstrapped repo.",
      reason: "No .btrain/project.toml was found in the current directory or any parent.",
      fix: "Run `btrain init /path/to/repo` first, or pass --repo /path/to/repo to specify the repo explicitly.",
    })
  }

  return repoRoot
}

function buildCurrentSection(current) {
  const merged = {
    ...DEFAULT_CURRENT,
    ...current,
  }

  const lockedFiles = Array.isArray(merged.lockedFiles) ? merged.lockedFiles.join(", ") : ""
  const laneId = merged._laneId || merged.lane || ""

  const lines = [
    "## Current",
    "",
    `Task: ${merged.task || ""}`,
    `Active Agent: ${merged.owner || ""}`,
    `Peer Reviewer: ${merged.reviewer || ""}`,
    `Status: ${merged.status || ""}`,
  ]

  if (merged.reasonCode) {
    lines.push(`Primary Reason Code: ${merged.reasonCode}`)
  }
  if (Array.isArray(merged.reasonTags) && merged.reasonTags.length > 0) {
    lines.push(`Reason Tags: ${merged.reasonTags.join(", ")}`)
  }
  if (merged.repairOwner) {
    lines.push(`Repair Owner: ${merged.repairOwner}`)
  }
  if (merged.repairEscalation) {
    lines.push(`Repair Escalation: ${merged.repairEscalation}`)
  }
  if (Number.isFinite(Number(merged.repairAttempts)) && Number(merged.repairAttempts) > 0) {
    lines.push(`Repair Attempts: ${Number(merged.repairAttempts)}`)
  }

  lines.push(
    `Review Mode: ${merged.reviewMode || ""}`,
    `Locked Files: ${lockedFiles}`,
    `Next Action: ${merged.nextAction || ""}`,
    `Base: ${merged.base || ""}`,
  )

  if (merged.prNumber) {
    lines.push(`PR: ${merged.prNumber}`)
  }

  lines.push(`Last Updated: ${merged.lastUpdated || ""}`)

  if (laneId) {
    lines.splice(2, 0, `Lane: ${laneId}`)
  }

  return lines.join("\n")
}

function normalizeParagraphValue(value, fallbackValue = "") {
  const lines = normalizeOptionArray(value)
    ?.flatMap((item) => String(item).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)

  return lines && lines.length > 0 ? lines.join("\n") : fallbackValue
}

function normalizeListValue(value, fallbackValues = []) {
  const lines = normalizeOptionArray(value)
    ?.flatMap((item) => String(item).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, "").trim())

  return lines && lines.length > 0 ? lines : fallbackValues
}

function splitParagraphValue(value, fallbackLines = []) {
  return normalizeParagraphLines(value, fallbackLines)
}

function buildDefaultDelegationPacket({ task = "", lockedFiles = [] } = {}) {
  const normalizedLocks = normalizePathList(lockedFiles)

  return {
    objective: String(task || "").trim() || "Complete the claimed lane task with reviewable progress.",
    deliverable: "Produce reviewable changes or artifacts inside the claimed lane scope.",
    constraints: [
      normalizedLocks.length > 0
        ? `Stay within locked files unless the lane is re-scoped: ${normalizedLocks.join(", ")}`
        : "Stay within the currently claimed lane scope unless the lane is re-scoped.",
      "Preserve unrelated local changes and existing workflow state.",
    ],
    acceptance: [
      "Leave the lane with concrete, reviewable progress.",
      "Capture verification and remaining gaps before handoff.",
    ],
    budget: "Keep the first pass lane-scoped. Update the packet if scope or constraints change.",
    doneWhen: "The lane is ready for `needs-review` or for a narrower follow-up handoff with explicit remaining gaps.",
  }
}

function normalizeDelegationPacket(packet = {}, defaults = createEmptyDelegationPacket()) {
  const fallback = {
    ...createEmptyDelegationPacket(),
    ...defaults,
  }

  return {
    objective: normalizeParagraphValue(packet.objective, fallback.objective),
    deliverable: normalizeParagraphValue(packet.deliverable, fallback.deliverable),
    constraints: normalizeListValue(packet.constraints, fallback.constraints || []),
    acceptance: normalizeListValue(packet.acceptance, fallback.acceptance || []),
    budget: normalizeParagraphValue(packet.budget, fallback.budget),
    doneWhen: normalizeParagraphValue(packet.doneWhen, fallback.doneWhen),
  }
}

function buildDelegationPacketValue(existingPacket = {}, options = {}, defaults = {}) {
  const defaultPacket = buildDefaultDelegationPacket(defaults)
  const existing = normalizeDelegationPacket(existingPacket, defaultPacket)

  return normalizeDelegationPacket({
    objective:
      options.objective !== undefined
        ? normalizeParagraphValue(options.objective, existing.objective || defaultPacket.objective)
        : existing.objective || defaultPacket.objective,
    deliverable:
      options.deliverable !== undefined
        ? normalizeParagraphValue(options.deliverable, existing.deliverable || defaultPacket.deliverable)
        : existing.deliverable || defaultPacket.deliverable,
    constraints:
      options.constraint !== undefined
        ? normalizeListValue(
            options.constraint,
            existing.constraints.length > 0 ? existing.constraints : defaultPacket.constraints,
          )
        : existing.constraints.length > 0
          ? existing.constraints
          : defaultPacket.constraints,
    acceptance:
      options.acceptance !== undefined
        ? normalizeListValue(
            options.acceptance,
            existing.acceptance.length > 0 ? existing.acceptance : defaultPacket.acceptance,
          )
        : existing.acceptance.length > 0
          ? existing.acceptance
          : defaultPacket.acceptance,
    budget:
      options.budget !== undefined
        ? normalizeParagraphValue(options.budget, existing.budget || defaultPacket.budget)
        : existing.budget || defaultPacket.budget,
    doneWhen:
      options["done-when"] !== undefined
        ? normalizeParagraphValue(options["done-when"], existing.doneWhen || defaultPacket.doneWhen)
        : existing.doneWhen || defaultPacket.doneWhen,
  })
}

function buildDelegationPacketSection(packet = {}, defaults = {}) {
  const normalized = normalizeDelegationPacket(packet, buildDefaultDelegationPacket(defaults))

  return [
    "## Delegation Packet",
    "",
    "Objective:",
    "",
    ...splitParagraphValue(normalized.objective),
    "",
    "Deliverable:",
    "",
    ...splitParagraphValue(normalized.deliverable),
    "",
    "Constraints:",
    "",
    ...normalized.constraints.map((line) => `- ${line}`),
    "",
    "Acceptance checks:",
    "",
    ...normalized.acceptance.map((line) => `- ${line}`),
    "",
    "Budget:",
    "",
    ...splitParagraphValue(normalized.budget),
    "",
    "Done when:",
    "",
    ...splitParagraphValue(normalized.doneWhen),
  ].join("\n")
}

function buildContextForReviewerSection(options = {}) {
  const whyLines = normalizeParagraphLines(
    options.whyLines,
    options.bootstrap ? ["- Bootstrap created by `btrain init`."] : ["- Fill this in before handoff"],
  )
  const preflightLines = normalizeBulletLines(
    options.preflightLines,
    ["- [ ] Checked locked files, nearby diff, and likely risk areas before editing"],
  )
  const changedLines = normalizeBulletLines(options.changedLines, ["- None yet"])
  const verificationLines = normalizeBulletLines(options.verificationLines, ["- [ ] Fill this in before handoff"])
  const gapLines = normalizeBulletLines(options.gapLines, ["- [ ] Fill this in before handoff"])
  const reviewAskLines = normalizeBulletLines(options.reviewAskLines, ["- [ ] Fill this in before handoff"])

  return [
    "## Context for Peer Review",
    "",
    "Pre-flight review:",
    "",
    ...preflightLines,
    "",
    "Files changed:",
    "",
    ...changedLines,
    "",
    "Verification run:",
    "",
    ...verificationLines,
    "",
    "Remaining gaps:",
    "",
    ...gapLines,
    "",
    "Why this was done:",
    "",
    ...whyLines,
    "",
    "Specific review asks:",
    "",
    ...reviewAskLines,
  ].join("\n")
}

function buildPendingReviewResponseSection() {
  return [
    "## Review Response",
    "",
    "Pending.",
  ].join("\n")
}

function normalizeOptionArray(value) {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) ? value : [value]
}

function normalizeBulletLines(value, fallbackLines) {
  const lines = normalizeOptionArray(value)
    ?.flatMap((item) => String(item).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith("- ") ? line : `- ${line}`))

  return lines && lines.length > 0 ? lines : fallbackLines
}

function normalizeParagraphLines(value, fallbackLines) {
  const lines = normalizeOptionArray(value)
    ?.flatMap((item) => String(item).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)

  return lines && lines.length > 0 ? lines : fallbackLines
}

function parseContextForReviewerSection(content) {
  const bounds = findSectionBounds(content, /^## Context for (Reviewer|Peer Review).*$/)
  if (!bounds) {
    return {
      preflightLines: [],
      changedLines: [],
      verificationLines: [],
      gapLines: [],
      whyLines: [],
      reviewAskLines: [],
    }
  }

  const result = {
    preflightLines: [],
    changedLines: [],
    verificationLines: [],
    gapLines: [],
    whyLines: [],
    reviewAskLines: [],
  }

  let activeKey = null
  const keyByHeading = {
    "pre-flight review:": "preflightLines",
    "files changed:": "changedLines",
    "verification run:": "verificationLines",
    "remaining gaps:": "gapLines",
    "why this was done:": "whyLines",
    "specific review asks:": "reviewAskLines",
  }

  for (const rawLine of bounds.text.split("\n").slice(1)) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      continue
    }

    const nextKey = keyByHeading[trimmed.toLowerCase()]
    if (nextKey) {
      activeKey = nextKey
      continue
    }

    if (!activeKey) {
      continue
    }

    result[activeKey].push(trimmed)
  }

  return result
}

function parseDelegationPacketSection(content) {
  const bounds = findSectionBounds(content, /^## Delegation Packet.*$/)
  if (!bounds) {
    return createEmptyDelegationPacket()
  }

  const result = createEmptyDelegationPacket()
  const listKeys = new Set(["constraints", "acceptance"])
  const keyByHeading = {
    "objective:": "objective",
    "deliverable:": "deliverable",
    "constraints:": "constraints",
    "acceptance checks:": "acceptance",
    "budget:": "budget",
    "done when:": "doneWhen",
  }

  let activeKey = null

  for (const rawLine of bounds.text.split("\n").slice(1)) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      continue
    }

    const nextKey = keyByHeading[trimmed.toLowerCase()]
    if (nextKey) {
      activeKey = nextKey
      continue
    }

    if (!activeKey) {
      continue
    }

    if (listKeys.has(activeKey)) {
      result[activeKey].push(trimmed.replace(/^-+\s*/, "").trim())
      continue
    }

    result[activeKey] = result[activeKey]
      ? `${result[activeKey]}\n${trimmed}`
      : trimmed
  }

  return normalizeDelegationPacket(result)
}

function mergeContextForReviewerSection(existingContent, options = {}) {
  const existing = parseContextForReviewerSection(existingContent)
  const explicitPreflight = options.preflight === true
    ? ["- [x] Checked locked files, nearby diff, and likely risk areas before editing"]
    : options.preflight
  const nextPreflightLines = explicitPreflight !== undefined
    ? normalizeBulletLines(explicitPreflight, ["- [x] Checked locked files, nearby diff, and likely risk areas before editing"])
    : existing.preflightLines
  const nextChangedLines = options.changed !== undefined
    ? normalizeBulletLines(options.changed, ["- None yet"])
    : existing.changedLines
  const nextVerificationLines = options.verification !== undefined
    ? normalizeBulletLines(options.verification, ["- [ ] Fill this in before handoff"])
    : existing.verificationLines
  const nextGapLines = options.gap !== undefined
    ? normalizeBulletLines(options.gap, ["- [ ] Fill this in before handoff"])
    : existing.gapLines
  const nextWhyLines = options.why !== undefined
    ? normalizeParagraphLines(options.why, ["- Fill this in before handoff"])
    : existing.whyLines
  const nextReviewAskLines = options["review-ask"] !== undefined
    ? normalizeBulletLines(options["review-ask"], ["- [ ] Fill this in before handoff"])
    : existing.reviewAskLines

  return buildContextForReviewerSection({
    preflightLines: nextPreflightLines,
    changedLines: nextChangedLines,
    verificationLines: nextVerificationLines,
    gapLines: nextGapLines,
    whyLines: nextWhyLines,
    reviewAskLines: nextReviewAskLines,
  })
}

function hasDelegationPacketUpdates(options = {}) {
  return [
    "objective",
    "deliverable",
    "constraint",
    "acceptance",
    "budget",
    "done-when",
  ].some((key) => options[key] !== undefined)
}

function normalizeReviewContextLine(line) {
  return String(line || "")
    .trim()
    .replace(/^-+\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .trim()
    .toLowerCase()
}

function isPlaceholderReviewContextLine(line) {
  const normalized = normalizeReviewContextLine(line)
  if (!normalized) return true
  // Short standalone placeholders must match the entire line (prevents false
  // positives from legitimate text like "pending commits" or "none yet seen").
  const exactPlaceholders = ["pending", "pending.", "none yet", "none yet."]
  if (exactPlaceholders.includes(normalized)) return true
  // Longer phrases can use substring matching safely.
  if (normalized.includes("fill this in before handoff")) return true
  return false
}

function collectNeedsReviewContextIssues({ base, contextSectionText }) {
  const issues = []
  const context = parseContextForReviewerSection(contextSectionText || "")

  if (!String(base || "").trim()) {
    issues.push("Base")
  }

  const requiredSections = [
    ["Pre-flight review", context.preflightLines],
    ["Files changed", context.changedLines],
    ["Verification run", context.verificationLines],
    ["Remaining gaps", context.gapLines],
    ["Why this was done", context.whyLines],
    ["Specific review asks", context.reviewAskLines],
  ]

  for (const [label, lines] of requiredSections) {
    if (!Array.isArray(lines) || lines.length === 0) {
      issues.push(label)
      continue
    }

    if (lines.some(isPlaceholderReviewContextLine)) {
      issues.push(label)
    }
  }

  return issues
}

function parseGitStatusPath(line) {
  const payload = line.slice(3).trim()
  if (!payload) {
    return ""
  }
  if (payload.includes(" -> ")) {
    return payload.split(" -> ").pop()?.trim() || ""
  }
  return payload
}

async function listGitStatusPaths(repoRoot, pathspecs = []) {
  const args = ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"]
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs)
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    })

    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map(parseGitStatusPath)
      .filter((filePath) => filePath && !filePath.startsWith(".claude/collab/HANDOFF") && !filePath.startsWith(".btrain/"))
  } catch {
    return []
  }
}

async function listStagedPaths(repoRoot, pathspecs = []) {
  const args = ["-C", repoRoot, "diff", "--cached", "--name-only"]
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs)
  }
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    })
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

async function listDiffPathsFromBase(repoRoot, base, pathspecs = []) {
  const resolvedBase = String(base || "").trim()
  if (!resolvedBase) {
    return []
  }

  const headRef = await resolveGitRevision(repoRoot, "HEAD")
  let baseRef = await resolveGitRevision(repoRoot, resolvedBase)

  // If the full base string doesn't resolve (e.g. it's a prose description like
  // "Branch 001-source-references forked from main at af14b47"), try to extract
  // candidate git refs from the string and resolve each one.
  if (!baseRef) {
    baseRef = await extractResolvableRef(repoRoot, resolvedBase)
  }

  if (!headRef || !baseRef) {
    return []
  }

  const args = ["-C", repoRoot, "diff", "--name-only", `${baseRef}...HEAD`]
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs)
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    })

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((filePath) => !filePath.startsWith(".claude/collab/HANDOFF") && !filePath.startsWith(".btrain/"))
  } catch {
    return []
  }
}

async function extractResolvableRef(repoRoot, proseBase) {
  // Extract candidate refs: SHA-like hex strings (7-40 chars) and branch-like
  // tokens (e.g. "main", "001-source-references") from the prose string.
  // Try each candidate in order; return the first one that resolves.
  const candidates = []

  // Match hex strings that look like short/full SHAs (7-40 hex chars, word-bounded)
  for (const match of proseBase.matchAll(/\b([0-9a-f]{7,40})\b/gi)) {
    candidates.push(match[1])
  }

  // Match branch-like tokens (e.g. "main", "001-source-references", "feat/foo")
  for (const match of proseBase.matchAll(/\b(\d{3,}-[a-z][a-z0-9-]*)\b/gi)) {
    candidates.push(match[1])
  }
  for (const match of proseBase.matchAll(/\b(main|master|develop|HEAD)\b/gi)) {
    candidates.push(match[1])
  }
  for (const match of proseBase.matchAll(/\b(origin\/[a-zA-Z0-9._-]+)\b/g)) {
    candidates.push(match[1])
  }

  for (const candidate of candidates) {
    const ref = await resolveGitRevision(repoRoot, candidate)
    if (ref) {
      return ref
    }
  }

  return null
}

async function validateNeedsReviewTransition(repoRoot, { laneId = "", base, contextSectionText, pathspecs = [], skipDiff = false } = {}) {
  const issues = collectNeedsReviewContextIssues({ base, contextSectionText })

  if (!skipDiff && pathspecs.length > 0) {
    const changedPaths = await listGitStatusPaths(repoRoot, pathspecs)
    let effectiveChangedCount = changedPaths.length

    const resolvedBase = String(base || "").trim()
    const baseRef = resolvedBase
      ? (await resolveGitRevision(repoRoot, resolvedBase)) || (await extractResolvableRef(repoRoot, resolvedBase))
      : null

    if (baseRef) {
      const baseDiffPaths = await listDiffPathsFromBase(repoRoot, base, pathspecs)
      // Use the larger of uncommitted and committed-since-base counts
      // so the simplifier gate fires when there are many committed files
      // even if only one remains uncommitted.
      effectiveChangedCount = Math.max(effectiveChangedCount, baseDiffPaths.length)
      if (changedPaths.length === 0 && baseDiffPaths.length === 0) {
        issues.push(laneId ? "reviewable diff in locked files" : "reviewable diff")
      }
    }
    // If baseRef is null we cannot verify the diff, so we skip the check
    // rather than blocking the agent in an unrecoverable loop.

    // Gate code-simplifier on actual changed files (uncommitted or committed) —
    // a single directory lock can still touch many files.
    if (effectiveChangedCount > 1) {
      const context = parseContextForReviewerSection(contextSectionText || "")
      const hasSimplification = (context.verificationLines || []).some((line) => {
        const normalized = line.toLowerCase()
        return normalized.includes("code-simplifier passed") || normalized.includes("code-simplifier skipped")
      })

      if (!hasSimplification) {
        issues.push("code-simplifier pass (required for multi-file changes)")
      }
    }
  }

  const hasDiffIssue = issues.some((issue) => issue.includes("reviewable diff"))
  const hasSimplificationIssue = issues.some((issue) => issue.includes("code-simplifier"))

  if (issues.length > 0) {
    const laneFlag = laneId ? ` --lane ${laneId}` : ""
    const baseFix = hasDiffIssue
      ? `\n         If the diff check is wrong, bypass it with: btrain handoff update${laneFlag} --status needs-review --no-diff --actor "<agent>"`
      : ""
    const simplificationFix = hasSimplificationIssue
      ? `\n         Multi-file changes require a simplification pass. Run the \`code-simplifier\` skill, then add "- [X] code-simplifier passed" to your verification lines.`
      : ""

    throw new BtrainError({
      message: "Cannot enter `needs-review` — reviewer context is incomplete.",
      reason: `Missing or placeholder fields: ${issues.join(", ")}.`,
      fix: (laneId
        ? `btrain handoff update --lane ${laneId} --preflight "..." --changed "file1" --verification "tests pass" --gap "none" --why "..." --review-ask "..."`
        : `btrain handoff update --preflight "..." --changed "file1" --verification "tests pass" --gap "none" --why "..." --review-ask "..."`) + baseFix + simplificationFix,
      context: "All six reviewer-context fields must be filled with real content (not placeholders) before moving to needs-review.",
    })
  }
}

function parseCurrentSection(content) {
  const bounds = findSectionBounds(content, "Current")
  if (!bounds) {
    return { ...DEFAULT_CURRENT }
  }

  const current = { ...DEFAULT_CURRENT }
  const keyMap = {
    task: "task",
    owner: "owner",
    "active agent": "owner",
    reviewer: "reviewer",
    "peer reviewer": "reviewer",
    status: "status",
    "primary reason code": "reasonCode",
    "reason tags": "reasonTags",
    "repair owner": "repairOwner",
    "repair escalation": "repairEscalation",
    "repair attempts": "repairAttempts",
    "review mode": "reviewMode",
    "locked files": "lockedFiles",
    "next action": "nextAction",
    base: "base",
    pr: "prNumber",
    "pr number": "prNumber",
    "last updated": "lastUpdated",
    lane: "lane",
  }

  for (const line of bounds.text.split("\n")) {
    const match = /^([^:]+):\s*(.*)$/.exec(line.trim())
    if (!match) {
      continue
    }

    const rawKey = match[1].trim().toLowerCase()
    const value = match[2].trim()
    const mappedKey = keyMap[rawKey]
    if (!mappedKey) {
      continue
    }

    if (["lockedFiles", "reasonTags"].includes(mappedKey)) {
      current[mappedKey] = parseCsvList(value)
    } else if (mappedKey === "repairAttempts") {
      current[mappedKey] = Number.parseInt(value, 10) || 0
    } else {
      current[mappedKey] = value
    }
  }

  return current
}

async function readCurrentState(repoRoot, options = {}) {
  const config = options.config || await readProjectConfig(repoRoot)
  const handoffPath = options.handoffPath || getConfiguredRepoPaths(repoRoot, config).handoffPath
  const laneId = typeof options.laneId === "string" ? options.laneId : ""
  let current = {
    ...DEFAULT_CURRENT,
    delegationPacket: createEmptyDelegationPacket(),
  }

  if (await pathExists(handoffPath)) {
    const content = await readText(handoffPath)
    current = {
      ...parseCurrentSection(content),
      delegationPacket: parseDelegationPacketSection(content),
    }
  }

  const events = await readWorkflowEvents(repoRoot, config, laneId)
  return resolveCurrentStateFromWorkflowEvents(current, events)
}

function buildReviewResponseNote(summary, actorLabel) {
  const timestamp = formatIsoTimestamp()
  return [
    "## Review Response",
    "",
    `${summary || "Resolved via btrain."}`,
    "",
    `Last Resolution: ${actorLabel} ${timestamp}`,
  ].join("\n")
}

function buildPreviousHandoffEntry(current, summary, actorLabel) {
  const taskLabel = current.task || "Untitled task"
  const outcome = summary || current.nextAction || "Resolved via btrain."
  return `- ${formatShortDate()} — ${taskLabel} (${actorLabel}): ${outcome}`
}

function extractPreviousHandoffEntries(content) {
  const bounds = findSectionBounds(content, /^## Previous Handoffs.*$/)
  if (!bounds) {
    return []
  }

  const lines = bounds.text.split("\n").slice(1)
  const entries = []
  let currentEntry = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (currentEntry !== null) {
        currentEntry += "\n"
      }
      continue
    }

    if (trimmed === "- None yet") {
      continue
    }

    if (line.startsWith("- ")) {
      if (currentEntry !== null) {
        entries.push(currentEntry.trimEnd())
      }
      currentEntry = line.trimEnd()
      continue
    }

    if (currentEntry !== null) {
      currentEntry += `\n${line.trimEnd()}`
    }
  }

  if (currentEntry !== null) {
    entries.push(currentEntry.trimEnd())
  }

  return entries
}

function buildPreviousHandoffsSection(entries) {
  const normalizedEntries = (entries || []).map((entry) => entry.trimEnd()).filter(Boolean)
  return [
    "## Previous Handoffs",
    "",
    ...(normalizedEntries.length > 0 ? normalizedEntries : ["- None yet"]),
  ].join("\n")
}

function replacePreviousHandoffsSection(content, entries) {
  return replaceOrPrependSection(content, /^## Previous Handoffs.*$/, buildPreviousHandoffsSection(entries))
}

function appendPreviousHandoffEntry(content, entry) {
  return replacePreviousHandoffsSection(content, [entry, ...extractPreviousHandoffEntries(content)])
}

function serializeWorkflowEvent(event) {
  return `${JSON.stringify({
    version: 1,
    recordedAt: formatIsoTimestamp(),
    ...event,
  })}\n`
}

async function readWorkflowEvents(repoRoot, config, laneId = "") {
  const targetPath = getWorkflowEventLogPath(repoRoot, config, laneId)
  if (!(await pathExists(targetPath))) {
    return []
  }

  const content = await readText(targetPath)
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function appendWorkflowEvent(repoRoot, config, event) {
  const targetPath = getWorkflowEventLogPath(repoRoot, config, event.laneId || "")
  await appendText(targetPath, serializeWorkflowEvent(event))
  return targetPath
}

function getLatestStateSnapshotEvent(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return null
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.after && typeof event.after === "object") {
      return event
    }
  }

  return null
}

function parseIsoDate(value) {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function getStateUpdatedDate(current, fallbackValue = "") {
  return parseLastUpdatedDate(current?.lastUpdated) || parseIsoDate(fallbackValue)
}

function resolveCurrentStateFromWorkflowEvents(current, events) {
  const latestEvent = getLatestStateSnapshotEvent(events)
  if (!latestEvent) {
    return {
      ...current,
      delegationPacket: normalizeDelegationPacket(current?.delegationPacket),
    }
  }

  const eventDate = getStateUpdatedDate(latestEvent.after, latestEvent.recordedAt)
  const currentDate = getStateUpdatedDate(current)

  if (!eventDate) {
    return {
      ...current,
      delegationPacket: normalizeDelegationPacket(current?.delegationPacket),
    }
  }
  if (currentDate && eventDate.getTime() <= currentDate.getTime()) {
    return {
      ...current,
      delegationPacket: normalizeDelegationPacket(current?.delegationPacket),
    }
  }

  return {
    ...DEFAULT_CURRENT,
    ...latestEvent.after,
    delegationPacket:
      latestEvent.after?.delegationPacket !== undefined
        ? normalizeDelegationPacket(latestEvent.after.delegationPacket)
        : normalizeDelegationPacket(current?.delegationPacket),
  }
}

function hasCgraphConfig(config) {
  return Boolean(config?.cgraph && typeof config.cgraph === "object" && Object.keys(config.cgraph).length > 0)
}

function isCgraphEnabled(config) {
  return hasCgraphConfig(config) && config?.cgraph?.enabled !== false
}

function getCgraphLaneConfig(config, laneId = "") {
  if (!laneId) {
    return {}
  }
  return config?.cgraph?.lanes?.[laneId] || {}
}

function getConfiguredCgraphAdviceKinds(config, laneId = "") {
  if (!isCgraphEnabled(config)) {
    return new Set()
  }

  const laneConfig = getCgraphLaneConfig(config, laneId)
  if (laneConfig.disable_advise) {
    return new Set()
  }

  const laneKinds = Array.isArray(laneConfig.advise_on) ? laneConfig.advise_on : null
  const globalKinds = Array.isArray(config?.cgraph?.advise_on) ? config.cgraph.advise_on : DEFAULT_CGRAPH_ADVISE_ON
  return new Set(
    (laneKinds || globalKinds)
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )
}

function createUnavailableCgraphAdapterResult(kind, reason = "") {
  return {
    ok: false,
    kind,
    payload: null,
    timed_out: false,
    unavailable: true,
    stderr_summary: reason,
    latency_ms: 0,
    source: "subprocess",
  }
}

function createDegradedCgraphMetadata(reason, graphMode = DEFAULT_CGRAPH_GRAPH_MODE) {
  return {
    status: "degraded",
    degraded_reason: reason,
    graph_mode: graphMode,
    latency_ms: {},
  }
}

function buildLaneLockMap(locks = []) {
  const byLane = {}
  for (const lock of locks) {
    if (!lock?.lane || !lock?.path) {
      continue
    }
    if (!byLane[lock.lane]) {
      byLane[lock.lane] = []
    }
    byLane[lock.lane].push(lock.path)
  }

  return Object.fromEntries(
    Object.entries(byLane).map(([laneId, paths]) => [laneId, normalizePathList(paths)]),
  )
}

function extractLatestCgraphMetadata(events) {
  if (!Array.isArray(events)) {
    return null
  }

  let merged = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.details?.cgraph && typeof event.details.cgraph === "object") {
      merged = mergeCgraphMetadata(
        event.details.cgraph,
        merged,
      ) || merged
      if (merged) {
        merged.recorded_at = merged.recorded_at || event.recordedAt || ""
        merged.event_type = merged.event_type || event.type || ""
      }
    }
  }

  return merged
}

function extractLatestClaimTimestamp(events) {
  if (!Array.isArray(events)) {
    return ""
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === "claim" && typeof event.recordedAt === "string" && event.recordedAt.trim()) {
      return event.recordedAt.trim()
    }
  }

  return ""
}

function mergeCgraphMetadata(base, next) {
  if (!base) {
    return next || null
  }
  if (!next) {
    return base
  }

  const merged = {
    ...base,
    ...next,
    latency_ms: {
      ...(base.latency_ms || {}),
      ...(next.latency_ms || {}),
    },
  }

  if (base.advisories || next.advisories) {
    merged.advisories = dedupeCgraphAdvisories([
      ...(Array.isArray(base.advisories) ? base.advisories : []),
      ...(Array.isArray(next.advisories) ? next.advisories : []),
    ])
  }

  return merged
}

function normalizeCgraphStringList(values) {
  if (!Array.isArray(values)) {
    return []
  }

  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort()
}

function buildCgraphAdvisoryEntry({
  kind = "",
  level = "",
  detail = "",
  suggestion = "",
  rationale = "",
  advisoryId = "",
  contextHash = "",
  otherLaneIds = [],
  overlappingNodeIds = [],
  changedNodeIds = [],
  staleFilePaths = [],
  truncatedNodeIds = [],
  handoffId = "",
} = {}) {
  return {
    kind: String(kind || "").trim() || "unknown",
    level: String(level || "").trim() || "warn",
    detail: String(detail || "").trim(),
    suggestion: String(suggestion || "").trim(),
    rationale: String(rationale || "").trim(),
    advisory_id: String(advisoryId || "").trim(),
    context_hash: String(contextHash || "").trim(),
    other_lane_ids: normalizeCgraphStringList(otherLaneIds),
    overlapping_node_ids: normalizeCgraphStringList(overlappingNodeIds),
    changed_node_ids: normalizeCgraphStringList(changedNodeIds),
    stale_file_paths: normalizeCgraphStringList(staleFilePaths),
    truncated_node_ids: normalizeCgraphStringList(truncatedNodeIds),
    handoff_id: String(handoffId || "").trim(),
  }
}

function dedupeCgraphAdvisories(advisories = []) {
  const deduped = []
  const seen = new Set()

  for (const advisory of advisories) {
    if (!advisory || typeof advisory !== "object") {
      continue
    }
    const normalized = buildCgraphAdvisoryEntry(advisory)
    const key = [
      normalized.kind,
      normalized.level,
      normalized.detail,
      normalized.suggestion,
      normalized.rationale,
      normalized.advisory_id,
      normalized.context_hash,
      normalized.other_lane_ids.join(","),
      normalized.overlapping_node_ids.join(","),
      normalized.changed_node_ids.join(","),
      normalized.stale_file_paths.join(","),
      normalized.truncated_node_ids.join(","),
      normalized.handoff_id,
    ].join("\u0000")
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(normalized)
  }

  return deduped
}

function getCgraphAdvisoryStatePath(repoRoot) {
  return path.join(repoRoot, ".btrain", "cgraph-advisory-state.jsonl")
}

function getCgraphAdvisoryLockPath(repoRoot) {
  return `${getCgraphAdvisoryStatePath(repoRoot)}.lock`
}

function getCgraphAdvisoryTelemetryPath(repoRoot) {
  return path.join(repoRoot, ".btrain", "logs", "cgraph-advisories.jsonl")
}

async function withCgraphAdvisoryLock(repoRoot, fn) {
  const statePath = getCgraphAdvisoryStatePath(repoRoot)
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  return withFileLock(
    getCgraphAdvisoryLockPath(repoRoot),
    fn,
    { timeoutMs: CGRAPH_ADVISORY_LOCK_TIMEOUT_MS },
  )
}

async function readJsonLinesSnapshot(filePath) {
  if (!(await pathExists(filePath))) {
    return []
  }

  const content = await readText(filePath)
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function writeJsonLinesSnapshot(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  const content = rows.length > 0
    ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    : ""
  await fs.writeFile(tmpPath, content, "utf8")
  await fs.rename(tmpPath, filePath)
}

async function appendCgraphTelemetryRows(repoRoot, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return
  }

  const telemetryPath = getCgraphAdvisoryTelemetryPath(repoRoot)
  await fs.mkdir(path.dirname(telemetryPath), { recursive: true })
  const content = rows.map((row) => JSON.stringify(row)).join("\n")
  await fs.appendFile(telemetryPath, `${content}\n`, "utf8")
}

function hashCgraphAdvisoryContext(laneId, advisory) {
  if (advisory.context_hash) {
    return advisory.context_hash
  }

  const kind = advisory.kind || "unknown"
  let raw = ""
  switch (kind) {
    case "lock_overlap":
      raw = [
        advisory.other_lane_ids.join("\n"),
        advisory.overlapping_node_ids.join("\n"),
      ].join("\n---\n")
      break
    case "drift":
      raw = advisory.changed_node_ids.join("\n")
      break
    case "stale_index":
      raw = advisory.stale_file_paths.join("\n")
      break
    case "packet_truncated":
      raw = [
        advisory.handoff_id,
        advisory.truncated_node_ids.join("\n"),
      ].join("\n---\n")
      break
    default:
      raw = [
        laneId,
        kind,
        advisory.handoff_id,
        advisory.detail,
        advisory.suggestion,
      ].join("\n---\n")
      break
  }

  return createHash("sha256").update(raw).digest("hex").slice(0, 12)
}

function buildResolvedCgraphAdvisoryEntry(activeEntry) {
  return buildCgraphAdvisoryEntry({
    kind: activeEntry.kind,
    detail: activeEntry.detail,
    suggestion: activeEntry.suggestion,
    advisoryId: activeEntry.advisory_id,
    contextHash: activeEntry.context_hash,
  })
}

async function reconcileCgraphAdvisories(repoRoot, laneId, advisories, { adviseOnResolution = false, clearLane = false } = {}) {
  const now = new Date().toISOString()
  const current = dedupeCgraphAdvisories(advisories)

  try {
    return await withCgraphAdvisoryLock(repoRoot, async () => {
      const statePath = getCgraphAdvisoryStatePath(repoRoot)
      const activeEntries = await readJsonLinesSnapshot(statePath)
      const nextActiveEntries = []
      const surfaced = []
      const resolved = []
      const telemetryRows = []
      const seenCurrentKeys = new Set()

      for (const advisory of current) {
        const contextHash = hashCgraphAdvisoryContext(laneId, advisory)
        const key = `${laneId}\u0000${advisory.kind}\u0000${contextHash}`
        seenCurrentKeys.add(key)
        const existing = activeEntries.find((entry) =>
          entry.lane === laneId
          && entry.kind === advisory.kind
          && entry.context_hash === contextHash,
        )

        if (existing) {
          nextActiveEntries.push(existing)
          continue
        }

        const activeEntry = {
          lane: laneId,
          kind: advisory.kind,
          context_hash: contextHash,
          first_seen: now,
          last_surfaced: now,
          resolved_at: null,
          detail: advisory.detail,
          suggestion: advisory.suggestion,
          advisory_id: advisory.advisory_id || "",
        }
        nextActiveEntries.push(activeEntry)
        surfaced.push(buildCgraphAdvisoryEntry({
          ...advisory,
          contextHash,
        }))
        telemetryRows.push({
          event: "surfaced",
          recorded_at: now,
          lane: laneId,
          kind: advisory.kind,
          context_hash: contextHash,
          detail: advisory.detail,
          suggestion: advisory.suggestion,
          advisory_id: advisory.advisory_id || "",
        })
      }

      for (const activeEntry of activeEntries) {
        if (activeEntry.lane !== laneId) {
          nextActiveEntries.push(activeEntry)
          continue
        }

        const key = `${activeEntry.lane}\u0000${activeEntry.kind}\u0000${activeEntry.context_hash}`
        if (!clearLane && seenCurrentKeys.has(key)) {
          continue
        }

        telemetryRows.push({
          event: "resolved",
          recorded_at: now,
          lane: activeEntry.lane,
          kind: activeEntry.kind,
          context_hash: activeEntry.context_hash,
          detail: activeEntry.detail || "",
          suggestion: activeEntry.suggestion || "",
          advisory_id: activeEntry.advisory_id || "",
        })
        if (adviseOnResolution) {
          resolved.push(buildResolvedCgraphAdvisoryEntry(activeEntry))
        }
      }

      await writeJsonLinesSnapshot(statePath, nextActiveEntries)
      await appendCgraphTelemetryRows(repoRoot, telemetryRows)
      return { surfaced, resolved }
    })
  } catch {
    return {
      surfaced: current,
      resolved: [],
    }
  }
}

function buildCgraphProducerCacheKey(kind, repoRoot, laneId, input) {
  return [
    kind,
    repoRoot,
    laneId,
    JSON.stringify(input || {}),
  ].join("\u0000")
}

async function runCachedCgraphProducer(kind, repoRoot, laneId, input, producer) {
  const key = buildCgraphProducerCacheKey(kind, repoRoot, laneId, input)
  const cached = cgraphProducerCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const value = await producer()
  cgraphProducerCache.set(key, {
    value,
    expiresAt: Date.now() + CGRAPH_STATUS_CACHE_TTL_MS,
  })
  return value
}

function normalizePayloadAdvisories(payload = {}, fallbackKind = "") {
  return dedupeCgraphAdvisories(
    (Array.isArray(payload.advisories) ? payload.advisories : []).map((advisory) =>
      buildCgraphAdvisoryEntry({
        kind: advisory.kind || fallbackKind,
        level: advisory.level || advisory.severity || "warn",
        detail: advisory.detail || advisory.summary || "",
        suggestion: advisory.suggestion || "",
        rationale: advisory.rationale || "",
        advisoryId: advisory.advisory_id || "",
        contextHash: advisory.context_hash || "",
        otherLaneIds: advisory.other_lane_ids || advisory.other_lanes || [],
        overlappingNodeIds: advisory.overlapping_node_ids || advisory.overlapping_nodes || advisory.node_ids || [],
        changedNodeIds: advisory.changed_node_ids || advisory.drifted_node_ids || [],
        staleFilePaths: advisory.stale_file_paths || [],
        truncatedNodeIds: advisory.truncated_node_ids || [],
        handoffId: advisory.handoff_id || "",
      }),
    ),
  )
}

function shouldAttachCgraphMetadata(state) {
  const status = String(state?.status || "").trim().toLowerCase()
  return status !== "idle" && status !== "resolved"
}

async function buildLiveCgraphMetadata(repoRoot, config, state, laneId = "", events = []) {
  if (!isCgraphEnabled(config) || !shouldAttachCgraphMetadata(state)) {
    return null
  }

  const persisted = extractLatestCgraphMetadata(events)
  const lockedFiles = normalizePathList(state?.lockedFiles)
  const adapter = await getCgraphAdapter(repoRoot, config)
  if (!adapter) {
    return mergeCgraphMetadata(
      persisted,
      createDegradedCgraphMetadata("cgraph unavailable", persisted?.graph_mode || DEFAULT_CGRAPH_GRAPH_MODE),
    )
  }

  const metadata = persisted
    ? {
        ...persisted,
        latency_ms: { ...(persisted.latency_ms || {}) },
      }
    : {
        status: "ok",
        graph_mode: DEFAULT_CGRAPH_GRAPH_MODE,
        latency_ms: {},
      }
  const claimTimestamp = extractLatestClaimTimestamp(events)
  const adviseKinds = getConfiguredCgraphAdviceKinds(config, laneId)
  const liveAdvisories = []

  if (lockedFiles.length > 0 && adapter.supports("blast-radius")) {
    const locks = await listLocks(repoRoot)
    const blastRadius =
      await runCachedCgraphProducer(
        "blast-radius",
        repoRoot,
        laneId,
        { files: lockedFiles, locks: buildLaneLockMap(locks) },
        async () =>
          failOpen(() => adapter.blastRadius(lockedFiles, laneId, buildLaneLockMap(locks)))
          || createUnavailableCgraphAdapterResult("blast_radius", "blast-radius unavailable"),
      )
    metadata.latency_ms.blast_radius = blastRadius.latency_ms

    if (blastRadius.ok && blastRadius.payload?.summary) {
      metadata.blast_radius = {
        nodes_in_scope: blastRadius.payload.summary.nodes_in_scope || 0,
        transitive_callers: blastRadius.payload.summary.transitive_callers || 0,
        transitive_callees: blastRadius.payload.summary.transitive_callees || 0,
        lock_overlaps: blastRadius.payload.summary.lock_overlaps || 0,
      }

      liveAdvisories.push(...normalizePayloadAdvisories(blastRadius.payload, "lock_overlap"))
      if (
        liveAdvisories.filter((entry) => entry.kind === "lock_overlap").length === 0
        && Number(blastRadius.payload.summary.lock_overlaps) > 0
      ) {
        liveAdvisories.push(buildCgraphAdvisoryEntry({
          kind: "lock_overlap",
          detail: `${Number(blastRadius.payload.summary.lock_overlaps)} overlapping lane${Number(blastRadius.payload.summary.lock_overlaps) === 1 ? "" : "s"} detected for the claimed lock set.`,
        }))
      }
    } else if (metadata.status === "ok") {
      metadata.status = "degraded"
      metadata.degraded_reason = blastRadius.timed_out ? "blast-radius timed out" : "blast-radius unavailable"
    }
  }

  if (lockedFiles.length > 0 && adapter.supports("drift-check")) {
    const driftResult =
      await runCachedCgraphProducer(
        "drift-check",
        repoRoot,
        laneId,
        { files: lockedFiles, since: claimTimestamp || "" },
        async () =>
          failOpen(() => adapter.driftCheck({ files: lockedFiles, laneId, since: claimTimestamp || "" }))
          || createUnavailableCgraphAdapterResult("drift_check", "drift-check unavailable"),
      )
    metadata.latency_ms.drift_check = driftResult.latency_ms

    if (driftResult.ok && driftResult.payload) {
      const driftedNodes =
        Array.isArray(driftResult.payload.drifted)
          ? driftResult.payload.drifted.length
          : Array.isArray(driftResult.payload.changed_node_ids)
            ? driftResult.payload.changed_node_ids.length
            : 0
      const neighborFiles = Array.isArray(driftResult.payload.neighbor_files) ? driftResult.payload.neighbor_files.length : 0
      metadata.drift = {
        since: driftResult.payload.since || claimTimestamp,
        drifted_nodes: driftedNodes,
        neighbor_files: neighborFiles,
      }

      liveAdvisories.push(...normalizePayloadAdvisories(driftResult.payload, "drift"))
      if (liveAdvisories.filter((entry) => entry.kind === "drift").length === 0 && driftedNodes > 0) {
        liveAdvisories.push(buildCgraphAdvisoryEntry({
          kind: "drift",
          detail:
            `${driftedNodes} neighbor node${driftedNodes === 1 ? "" : "s"} changed `
            + `outside lane scope${claimTimestamp ? " since claim" : ""}.`,
          changedNodeIds: driftResult.payload.changed_node_ids || driftResult.payload.drifted_node_ids || [],
        }))
      }
    } else if (metadata.status === "ok") {
      metadata.status = "degraded"
      metadata.degraded_reason = driftResult.timed_out ? "drift-check timed out" : "drift-check unavailable"
    }
  }

  let currentAdvisories = dedupeCgraphAdvisories(
    liveAdvisories.filter((advisory) => adviseKinds.has(advisory.kind)),
  )

  if (currentAdvisories.length > 0 && adapter.supports("advise")) {
    currentAdvisories = await Promise.all(currentAdvisories.map(async (advisory) => {
      const adviseResult =
        await failOpen(() => adapter.advise(advisory.kind, {
          laneId,
          context: { files: lockedFiles },
        }))
        || createUnavailableCgraphAdapterResult("advise", "advise unavailable")
      metadata.latency_ms[`advise_${advisory.kind}`] = adviseResult.latency_ms

      if (!adviseResult.ok || !adviseResult.payload) {
        return advisory
      }

      return buildCgraphAdvisoryEntry({
        ...advisory,
        suggestion: adviseResult.payload.suggestion || advisory.suggestion,
        rationale: adviseResult.payload.rationale || advisory.rationale,
        advisoryId: adviseResult.payload.advisory_id || advisory.advisory_id,
      })
    }))
  }

  const laneKey = laneId || "repo"
  const { surfaced, resolved } = await reconcileCgraphAdvisories(repoRoot, laneKey, currentAdvisories, {
    adviseOnResolution: config?.cgraph?.advise_on_resolution === true || getCgraphLaneConfig(config, laneId).advise_on_resolution === true,
  })

  if (currentAdvisories.length > 0) {
    metadata.advisories = currentAdvisories
  } else {
    delete metadata.advisories
  }
  if (surfaced.length > 0) {
    metadata.fresh_advisories = surfaced
  } else {
    delete metadata.fresh_advisories
  }
  if (resolved.length > 0) {
    metadata.resolved_advisories = resolved
  } else {
    delete metadata.resolved_advisories
  }

  return metadata
}

async function attachLatestCgraphMetadataToState(repoRoot, config, state, laneId = "") {
  if (!isCgraphEnabled(config) || !shouldAttachCgraphMetadata(state)) {
    return state
  }

  const events = await readWorkflowEvents(repoRoot, config, laneId)
  const cgraph = await buildLiveCgraphMetadata(repoRoot, config, state, laneId, events)
  return cgraph ? { ...state, cgraph } : state
}

async function attachLatestCgraphMetadataToStates(repoRoot, config, states) {
  if (!isCgraphEnabled(config)) {
    return states
  }
  return Promise.all(
    (states || []).map(async (state) => {
      const laneId = typeof state?._laneId === "string" ? state._laneId : ""
      return attachLatestCgraphMetadataToState(repoRoot, config, state, laneId)
    }),
  )
}

async function getCgraphAdapter(repoRoot, config) {
  if (!isCgraphEnabled(config)) {
    return null
  }
  return failOpen(() => createAdapter(repoRoot, config))
}

async function buildClaimCgraphMetadata(repoRoot, config, { laneId = "", files = [] } = {}) {
  if (!isCgraphEnabled(config)) {
    return null
  }
  if (!Array.isArray(files) || files.length === 0) {
    return null
  }

  const adapter = await getCgraphAdapter(repoRoot, config)
  if (!adapter || !adapter.supports("blast-radius")) {
    return hasCgraphConfig(config)
      ? createDegradedCgraphMetadata("blast-radius unavailable", DEFAULT_CGRAPH_GRAPH_MODE)
      : null
  }

  const locks = await listLocks(repoRoot)
  const blastRadius =
    await failOpen(() => adapter.blastRadius(files, laneId, buildLaneLockMap(locks)))
    || createUnavailableCgraphAdapterResult("blast_radius", "blast-radius unavailable")
  const metadata = adapter.buildEventMetadata({ blastRadius }, DEFAULT_CGRAPH_GRAPH_MODE)
  if (!blastRadius.ok) {
    metadata.status = "degraded"
    metadata.degraded_reason = blastRadius.timed_out ? "blast-radius timed out" : "blast-radius unavailable"
  }
  return metadata
}

async function buildNeedsReviewCgraphMetadata(repoRoot, config, {
  laneId = "",
  files = [],
  base = "",
} = {}) {
  if (!isCgraphEnabled(config)) {
    return null
  }
  const adapter = await getCgraphAdapter(repoRoot, config)
  if (!adapter) {
    return hasCgraphConfig(config)
      ? createDegradedCgraphMetadata("cgraph unavailable", DEFAULT_CGRAPH_GRAPH_MODE)
      : null
  }

  const artifactLaneId = laneId || "repo"
  const results = {}

  if (adapter.supports("review-packet")) {
    const reviewPacket =
      await failOpen(() => adapter.reviewPacket({ base, files }))
      || createUnavailableCgraphAdapterResult("review_packet", "review-packet unavailable")
    results.reviewPacket = reviewPacket
    if (reviewPacket.ok && reviewPacket.payload) {
      results.reviewPacketArtifact =
        await failOpen(() => adapter.persistReviewPacket(artifactLaneId, reviewPacket.payload))
    }
  }

  if (adapter.supports("audit")) {
    const auditScope = laneId ? "lane" : "all"
    const audit =
      await failOpen(() => adapter.audit({ scope: auditScope, files }))
      || createUnavailableCgraphAdapterResult("audit", "audit unavailable")
    results.audit = audit
    if (audit.ok && audit.payload) {
      results.auditArtifact =
        await failOpen(() => adapter.persistAuditSummary(artifactLaneId, audit.payload))
    }
  }

  if (Object.keys(results).length === 0) {
    return hasCgraphConfig(config)
      ? createDegradedCgraphMetadata("no supported cgraph commands detected", DEFAULT_CGRAPH_GRAPH_MODE)
      : null
  }

  return adapter.buildEventMetadata(results, DEFAULT_CGRAPH_GRAPH_MODE)
}

async function getDoctorCgraphSummary(repoRoot, config) {
  if (!isCgraphEnabled(config)) {
    return null
  }

  const binPath = await failOpen(() => resolveBinary(config))
  if (!binPath) {
    return hasCgraphConfig(config)
      ? {
          status: "unavailable",
          info: [`cgraph binary: ${config?.cgraph?.bin_path || "(not found on PATH)"}`],
          issues: ["cgraph binary is unavailable"],
        }
      : null
  }

  const manifestResult = await failOpen(() => probeManifest(binPath, config?.cgraph?.project))
  if (!manifestResult?.ok) {
    return {
      status: "unavailable",
      info: [`cgraph binary: ${binPath}`],
      issues: ["cgraph manifest probe failed"],
    }
  }

  const adapter = await getCgraphAdapter(repoRoot, config)
  if (!adapter) {
    return {
      status: "unavailable",
      info: [`cgraph binary: ${binPath}`],
      issues: ["cgraph adapter could not be created"],
    }
  }

  const summary = await failOpen(() => adapter.doctorSummary())
  return {
    status: summary?.ok === false ? "degraded" : "ok",
    info: summary?.info || [],
    issues: summary?.issues || [],
  }
}

async function getStartupCgraphSummary(repoRoot, config) {
  if (!isCgraphEnabled(config)) {
    return null
  }
  const adapter = await getCgraphAdapter(repoRoot, config)
  if (!adapter) {
    return {
      status: "unavailable",
      lines: ["cgraph unavailable"],
    }
  }

  const lines = await failOpen(() => adapter.startupSummary())
  if (Array.isArray(lines) && lines.length > 0) {
    return {
      status: "ok",
      lines,
    }
  }

  return {
    status: "ok",
    lines: ["cgraph available"],
  }
}

function getCanonicalWorkflowActor(events) {
  const workflowEvents = (events || []).filter((event) =>
    ["claim", "update", "request-changes", "resolve"].includes(event.type),
  )
  const lastEvent = workflowEvents.at(-1)
  return normalizeAgentName(lastEvent?.actor)
}

function countRepairEntries(events, reasonCode) {
  return (events || []).filter((event) => {
    if (event.type !== "update") {
      return false
    }
    return event.after?.status === "repair-needed" && event.after?.reasonCode === reasonCode
  }).length
}

async function resolveRepairAssignment(repoRoot, config, {
  laneId = "",
  existingCurrent,
  reasonCode,
  actorLabel = "btrain",
} = {}) {
  const events = await readWorkflowEvents(repoRoot, config, laneId)
  const canonicalActor = getCanonicalWorkflowActor(events) || existingCurrent.owner || ""
  const configuredAgents = getConfiguredAgentNames(config)

  let repairOwner = canonicalActor

  // If canonical actor is not in active agents, look for same-family fallback (WS4)
  if (repairOwner && !configuredAgents.includes(repairOwner)) {
    const canonicalTokens = tokenizeAgentIdentity(repairOwner)
    const fallback = configuredAgents.find((agentName) => {
      const agentTokens = tokenizeAgentIdentity(agentName)
      return agentTokens.some((token) => canonicalTokens.includes(token))
    })
    if (fallback) {
      repairOwner = fallback
    }
  }

  if (!repairOwner) {
    repairOwner = actorLabel
  }

  const priorAttempts = countRepairEntries(events, reasonCode)
  const repairAttempts = priorAttempts + 1
  const repairEscalation = priorAttempts >= 1 ? "human" : ""

  return {
    repairOwner,
    repairAttempts,
    repairEscalation,
    priorAttempts,
  }
}

async function analyzeLaneIntegrity(repoRoot, config, laneState) {
  const issues = []
  const configuredAgents = new Set(config?.agents?.active || [])
  const laneId = laneState._laneId || ""

  // 1. Invalid transition: check event history if available
  const events = await readWorkflowEvents(repoRoot, config, laneId)
  if (events.length > 0) {
    const lastEvent = events[events.length - 1]
    const currentStatus = laneState.status
    const lastEventStatus = lastEvent.after?.status

    if (currentStatus === "needs-review" && lastEventStatus === "resolved") {
      issues.push({
        type: "invalid-transition",
        message: `Lane ${laneId} jumped from \`resolved\` to \`needs-review\` without a claim or in-progress update.`,
        reasonCode: "invalid-transition",
      })
    }
  }

  // 2. Actor mismatch: owner not in active list
  if (isLaneActiveStatus(laneState.status) && laneState.owner && !configuredAgents.has(laneState.owner)) {
    issues.push({
      type: "actor-mismatch",
      message: `Lane ${laneId} is \`${laneState.status}\` but owner "${laneState.owner}" is not in the active agent list.`,
      reasonCode: "actor-mismatch",
    })
  }

  // 3. Contradictory state: active status but no locks
  if (isLaneActiveStatus(laneState.status) && laneState.lockCount === 0) {
    issues.push({
      type: "contradictory-state",
      message: `Lane ${laneId} is \`${laneState.status}\` but has no active locks.`,
      reasonCode: "contradictory-state",
    })
  }

  return issues
}

function buildRepairNextAction({ repairOwner = "", repairAttempts = 0, repairEscalation = "", reasonCode = "" } = {}) {
  const normalizedOwner = repairOwner || "the responsible actor"
  const reasonSuffix = reasonCode ? ` for \`${reasonCode}\`` : ""

  if (repairEscalation === "human") {
    return `Human escalation required after ${repairAttempts} repair-needed entries${reasonSuffix}. Last responsible actor: ${normalizedOwner}.`
  }

  return `${normalizedOwner} should repair the lane before normal work resumes${reasonSuffix}.`
}

async function appendHandoffArchive(repoRoot, config, laneId, entries) {
  const normalizedEntries = normalizeStringList(entries)
  if (normalizedEntries.length === 0) {
    return null
  }

  const archivePath = getHandoffArchivePath(repoRoot, config, laneId)
  const archiveHeading = laneId ? `# Lane ${laneId}` : "# Repo"
  let nextContent = ""

  if (!(await pathExists(archivePath))) {
    nextContent += `${archiveHeading} Archived Handoff History\n`
  }

  nextContent += `\n## Archived ${formatIsoTimestamp()}\n\n${normalizedEntries.join("\n")}\n`
  await appendText(archivePath, nextContent)
  return archivePath
}

async function compactLaneHandoffHistory(repoRoot, {
  config,
  laneId = "",
  handoffPath,
  keep = DEFAULT_HISTORY_KEEP,
  actorLabel = "btrain",
} = {}) {
  const safeKeep = Number.isFinite(Number(keep)) ? Math.max(0, Number(keep)) : DEFAULT_HISTORY_KEEP
  if (!(await pathExists(handoffPath))) {
    return {
      laneId,
      handoffPath,
      archivePath: getHandoffArchivePath(repoRoot, config, laneId),
      archivedCount: 0,
      keptCount: 0,
      keep: safeKeep,
    }
  }

  const content = await readText(handoffPath)
  const entries = extractPreviousHandoffEntries(content)
  const keptEntries = entries.slice(0, safeKeep)
  const archivedEntries = entries.slice(safeKeep)
  let archivePath = getHandoffArchivePath(repoRoot, config, laneId)

  if (archivedEntries.length > 0) {
    archivePath = await appendHandoffArchive(repoRoot, config, laneId, [...archivedEntries].reverse())
    await writeText(handoffPath, replacePreviousHandoffsSection(content, keptEntries))
    await appendWorkflowEvent(repoRoot, config, {
      type: "history-compact",
      actor: actorLabel,
      laneId,
      details: {
        keep: safeKeep,
        archivedCount: archivedEntries.length,
        keptCount: keptEntries.length,
        archivePath,
        handoffPath,
      },
    })
  }

  return {
    laneId,
    handoffPath,
    archivePath,
    archivedCount: archivedEntries.length,
    keptCount: keptEntries.length,
    keep: safeKeep,
  }
}

async function compactHandoffHistory(repoRoot, { config: providedConfig, laneId = "", keep = DEFAULT_HISTORY_KEEP, actorLabel = "btrain" } = {}) {
  const config = providedConfig || (await readProjectConfig(repoRoot))
  const laneConfigs = getLaneConfigs(config)

  if (laneConfigs) {
    if (laneId) {
      return [
        await compactLaneHandoffHistory(repoRoot, {
          config,
          laneId,
          handoffPath: getLaneHandoffPath(repoRoot, config, laneId),
          keep,
          actorLabel,
        }),
      ]
    }

    const results = []
    for (const lane of laneConfigs) {
      results.push(await compactLaneHandoffHistory(repoRoot, {
        config,
        laneId: lane.id,
        handoffPath: getLaneHandoffPath(repoRoot, config, lane.id),
        keep,
        actorLabel,
      }))
    }
    return results
  }

  return [
    await compactLaneHandoffHistory(repoRoot, {
      config,
      laneId: "",
      handoffPath: getConfiguredRepoPaths(repoRoot, config).handoffPath,
      keep,
      actorLabel,
    }),
  ]
}

function resolveSpillThreshold(config) {
  const raw =
    config?.handoff?.spill_next_chars ??
    config?.handoff?.spillNextChars ??
    config?.handoff?.spill_next_action_chars
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SPILL_NEXT_CHARS
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SPILL_NEXT_CHARS
  }
  return parsed
}

function buildSpillFilename({ laneId, actorLabel }) {
  const lanePart = laneId ? `lane-${laneId}` : "repo"
  const tsSafe = formatIsoTimestamp().replace(/[:.]/g, "-")
  const actorSafe = (actorLabel || "btrain")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 32) || "btrain"
  return `${lanePart}-next-${tsSafe}-${actorSafe}.md`
}

function extractSpillPathFromNextAction(nextAction) {
  if (typeof nextAction !== "string") {
    return null
  }
  const match = SPILL_MARKER_RE.exec(nextAction)
  if (!match) {
    return null
  }
  return match[1].trim()
}

function buildSpillPointerValue({ body, relativePath }) {
  const trimmed = body.trim()
  const preview = trimmed.length > SPILL_PREVIEW_CHARS
    ? `${trimmed.slice(0, SPILL_PREVIEW_CHARS).trimEnd()}…`
    : trimmed
  const bytes = Buffer.byteLength(body, "utf8")
  // Keep pointer on a single line — parseCurrentSection splits on \n.
  const singleLinePreview = preview.replace(/\s+/g, " ").trim()
  return `${singleLinePreview} [spilled: ${relativePath}, ${bytes}B]`
}

async function maybeSpillNextAction({
  repoRoot,
  config,
  laneId,
  value,
  actorLabel,
}) {
  if (typeof value !== "string" || !value) {
    return value
  }
  if (SPILL_MARKER_RE.test(value)) {
    // Caller already handed us a pointer (e.g. replay); leave it alone.
    return value
  }
  const threshold = resolveSpillThreshold(config)
  if (threshold <= 0 || value.length <= threshold) {
    return value
  }
  const repoPaths = getRepoPaths(repoRoot)
  const filename = buildSpillFilename({ laneId, actorLabel })
  const absolutePath = path.join(repoPaths.handoffNotesDir, filename)
  const relativePath = path.posix.join(".btrain", HANDOFF_NOTES_DIRNAME, filename)

  const header = [
    "---",
    `lane: ${laneId || ""}`,
    `actor: ${actorLabel || "btrain"}`,
    `written_at: ${formatIsoTimestamp()}`,
    `source: handoff Next Action`,
    "---",
    "",
  ].join("\n")
  await writeText(absolutePath, header + value + (value.endsWith("\n") ? "" : "\n"))
  return buildSpillPointerValue({ body: value, relativePath })
}

async function readSpilledNextActionBody(repoRoot, nextAction) {
  const relativePath = extractSpillPathFromNextAction(nextAction)
  if (!relativePath) {
    return null
  }
  const normalized = relativePath.startsWith(".btrain/")
    ? relativePath
    : relativePath
  const absolute = path.resolve(repoRoot, normalized)
  if (!(await pathExists(absolute))) {
    return { path: absolute, body: null, missing: true }
  }
  const body = await readText(absolute)
  return { path: absolute, body, missing: false }
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForHash)
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort()
    const out = {}
    for (const key of keys) {
      out[key] = canonicalizeForHash(value[key])
    }
    return out
  }
  return value
}

function pickHashFieldsFromCurrent(current) {
  if (!current || typeof current !== "object") {
    return {}
  }
  return {
    task: current.task || "",
    owner: current.owner || "",
    reviewer: current.reviewer || "",
    status: current.status || "",
    reasonCode: current.reasonCode || "",
    reasonTags: Array.isArray(current.reasonTags) ? [...current.reasonTags].sort() : [],
    repairOwner: current.repairOwner || "",
    repairEscalation: current.repairEscalation || "",
    repairAttempts: Number(current.repairAttempts) || 0,
    reviewMode: current.reviewMode || "",
    lockedFiles: Array.isArray(current.lockedFiles) ? [...current.lockedFiles].sort() : [],
    nextAction: current.nextAction || "",
    base: current.base || "",
    lastUpdated: current.lastUpdated || "",
    _laneId: current._laneId || "",
    cgraph: current.cgraph && typeof current.cgraph === "object" ? current.cgraph : null,
  }
}

function computeHandoffStateHash(result) {
  if (!result || typeof result !== "object") {
    return ""
  }
  const lanes = Array.isArray(result.lanes)
    ? [...result.lanes]
        .map((lane) => pickHashFieldsFromCurrent(lane))
        .sort((a, b) => (a._laneId || "").localeCompare(b._laneId || ""))
    : null
  const locks = Array.isArray(result.locks)
    ? [...result.locks]
        .map((lock) => ({
          lane: lock.lane || "",
          path: lock.path || "",
          owner: lock.owner || "",
        }))
        .sort((a, b) =>
          (a.lane + a.path).localeCompare(b.lane + b.path),
        )
    : []
  const overrides = Array.isArray(result.overrides)
    ? [...result.overrides]
        .map((override) => ({
          id: override.id || "",
          action: override.action || "",
          scope: override.scope || "",
          laneId: override.laneId || "",
          requestedBy: override.requestedBy || "",
          confirmedBy: override.confirmedBy || "",
        }))
        .sort((a, b) => (a.id || "").localeCompare(b.id || ""))
    : []

  const canonical = canonicalizeForHash({
    v: 1,
    current: lanes ? null : pickHashFieldsFromCurrent(result.current),
    lanes,
    locks,
    overrides,
  })
  return createHash("sha1").update(JSON.stringify(canonical)).digest("hex").slice(0, 16)
}

async function updateHandoff(repoRoot, updates, options = {}) {
  const config = options.config || (await readProjectConfig(repoRoot))
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  const repoName = normalizeRepoName(repoRoot)

  // Use override handoff path for lane-specific operations
  const handoffPath = options.overrideHandoffPath || repoPaths.handoffPath
  const handoffLockPath = handoffPath + ".lock"

  return withFileLock(handoffLockPath, async () => {
    if (!(await pathExists(handoffPath))) {
      await ensureDir(path.dirname(handoffPath))
      await writeText(handoffPath, renderHandoffTemplate(repoName))
    }

    const existingContent = await readText(handoffPath)
    const existingCurrent = {
      ...parseCurrentSection(existingContent),
      delegationPacket: parseDelegationPacketSection(existingContent),
    }
    const nextCurrent = {
      ...existingCurrent,
      ...updates,
    }

    if (updates.lockedFiles === undefined) {
      nextCurrent.lockedFiles = existingCurrent.lockedFiles
    }

    if (!nextCurrent.lastUpdated) {
      nextCurrent.lastUpdated = `btrain ${formatIsoTimestamp()}`
    }

    // Spill long Next Action bodies to .btrain/handoff-notes/ so `btrain handoff`
    // output stays compact. The in-file value becomes a short preview + pointer.
    // No-op when the value is short, already a pointer, or spill is disabled.
    if (
      typeof nextCurrent.nextAction === "string" &&
      nextCurrent.nextAction !== existingCurrent.nextAction
    ) {
      nextCurrent.nextAction = await maybeSpillNextAction({
        repoRoot,
        config,
        laneId: options.laneId || nextCurrent._laneId || "",
        value: nextCurrent.nextAction,
        actorLabel: options.actorLabel || "btrain",
      })
    }

    let nextContent = replaceOrPrependSection(existingContent, "Current", buildCurrentSection(nextCurrent))

    if (options.previousHandoffEntry) {
      nextContent = appendPreviousHandoffEntry(nextContent, options.previousHandoffEntry)
    }

    if (options.contextSectionText) {
      nextContent = replaceOrPrependSection(
        nextContent,
        /^## Context for (Reviewer|Peer Review).*$/,
        options.contextSectionText,
      )
    }

    if (options.delegationPacketSectionText) {
      nextContent = replaceOrPrependSection(
        nextContent,
        /^## Delegation Packet.*$/,
        options.delegationPacketSectionText,
      )
    }

    if (options.reviewResponseText) {
      nextContent = replaceOrPrependSection(
        nextContent,
        /^## Review Response.*$/,
        options.reviewResponseText,
      )
    } else if (options.reviewResponseSummary) {
      nextContent = replaceOrPrependSection(
        nextContent,
        /^## Review Response.*$/,
        buildReviewResponseNote(options.reviewResponseSummary, options.actorLabel || "btrain"),
      )
    }

    await writeText(handoffPath, nextContent)

    if (options.eventType) {
      await appendWorkflowEvent(repoRoot, config, {
        type: options.eventType,
        actor: options.actorLabel || "btrain",
        laneId: options.laneId || nextCurrent._laneId || "",
        handoffPath,
        before: existingCurrent,
        after: nextCurrent,
        details: options.eventDetails || {},
      })
    }

    return nextCurrent
  })
}

function shouldRunClaimUnblockedContext(options = {}) {
  const value = options["unblocked-context"]
  if (value === undefined || value === false) {
    return false
  }
  return String(value).toLowerCase() !== "false"
}

async function claimHandoff(repoRoot, options) {
  if (!options.reviewer) {
    options.reviewer = "any-other"
  }

  if (!options.task || !options.owner) {
    throw new BtrainError({
      message: "`btrain handoff claim` requires --task and --owner.",
      reason: "A claim must specify what task to work on and which agent owns it.",
      fix: `btrain handoff claim --task "<describe the task>" --owner "<agent-name>" --files "src/"`,
    })
  }

  const config = await readProjectConfig(repoRoot)
  const configuredAgents = getConfiguredAgentNames(config)
  const laneConfigs = getLaneConfigs(config)
  let laneId = options.lane || null

  // If lanes are enabled, auto-select a lane if none specified
  if (laneConfigs && !laneId) {
    const laneStates = await readAllLaneStates(repoRoot, config)
    laneId = findAvailableLane(laneStates)
    if (!laneId) {
      throw new BtrainError({
        message: "No available lanes.",
        reason: "All lanes are currently in-progress or needs-review.",
        fix: "Resolve or repurpose an existing lane first with `btrain handoff resolve --lane <id> --summary \"...\"`, then re-claim.",
        context: "Run `btrain handoff` to see the status of all lanes.",
      })
    }
  }

  // Acquire file locks if lanes enabled and files specified
  const files = options.files ? parseCsvList(options.files) : []
  if (laneConfigs && laneId) {
    const existingLane = await readLaneState(repoRoot, config, laneId)
    if (!["idle", "resolved"].includes(existingLane.status)) {
      throw new BtrainError({
        message: `Lane ${laneId} is already \`${existingLane.status}\`.`,
        reason: "You can only claim a lane that is idle or resolved.",
        fix: existingLane.status === "needs-review"
          ? `Review and resolve the lane first: btrain handoff resolve --lane ${laneId} --summary "..."`
          : `Continue or update the existing work: btrain handoff update --lane ${laneId} --status needs-review --actor "${options.owner}"`,
        context: `Current task: ${existingLane.task || "(none)"}. Owner: ${existingLane.owner || "(unassigned)"}.`,
      })
    }
    if (files.length === 0) {
      throw new BtrainError({
        message: `Lane ${laneId} claims require --files.`,
        reason: "File locks map in-progress work to lanes so concurrent agents don't collide.",
        fix: `btrain handoff claim --lane ${laneId} --task "${options.task || '...'}" --owner "${options.owner}" --files "src/,docs/"`,
      })
    }
    await acquireLocks(repoRoot, laneId, options.owner, files)
  }

  const resolvedReviewer = inferPeerReviewer({
    actor: options.owner,
    reviewer: options.reviewer,
    currentReviewer: "",
    owner: options.owner,
    currentOwner: "",
    configuredAgents,
  })

  if (!resolvedReviewer) {
    throw new BtrainError({
      message: `Could not infer a reviewer different from "${options.owner}".`,
      reason: "The owner and all configured agents resolve to the same identity, so no peer reviewer can be assigned.",
      fix: `Pass --reviewer <other-agent> explicitly, or add more agents to .btrain/project.toml with \`btrain agents add --repo . --agent <name>\`.`,
    })
  }

  const updates = {
    task: options.task,
    owner: options.owner,
    reviewer: resolvedReviewer,
    status: "in-progress",
    reviewMode: options.mode || "manual",
    lockedFiles: files,
    nextAction:
      options.next || "Work within the locked files, keep the lane in-progress, and hand off for review when ready.",
    base: options.base || "",
    prNumber: normalizePrNumber(options.pr),
    lastUpdated: `${options.owner} ${formatIsoTimestamp()}`,
    delegationPacket: buildDelegationPacketValue(createEmptyDelegationPacket(), options, {
      task: options.task,
      lockedFiles: files,
    }),
  }

  if (laneId) {
    updates._laneId = laneId
    updates.lane = laneId
  }

  const cgraphMetadata = await buildClaimCgraphMetadata(repoRoot, config, {
    laneId: laneId || "",
    files,
  })
  const claimReviewContextFields = shouldRunClaimUnblockedContext(options)
    ? buildClaimReviewContextFields(await collectClaimUnblockedContext(repoRoot, {
        task: options.task,
        files,
        laneId: laneId || "",
        owner: options.owner,
        helperPath: options["unblocked-helper"],
      }))
    : {}

  // If lanes enabled, write to lane-specific handoff file
  if (laneConfigs && laneId) {
    const handoffPath = getLaneHandoffPath(repoRoot, config, laneId)
    const result = await updateHandoff(
      repoRoot,
      updates,
      {
        actorLabel: options.owner,
        delegationPacketSectionText: buildDelegationPacketSection(updates.delegationPacket, {
          task: options.task,
          lockedFiles: files,
        }),
        contextSectionText: buildContextForReviewerSection(claimReviewContextFields),
        reviewResponseText: buildPendingReviewResponseSection(),
        config,
        eventType: "claim",
        laneId,
        eventDetails: {
          task: options.task,
          lockedFiles: files,
          ...(cgraphMetadata ? { cgraph: cgraphMetadata } : {}),
        },
        overrideHandoffPath: handoffPath,
      },
    )
    await compactHandoffHistory(repoRoot, { config, laneId, actorLabel: options.owner })
    return result
  }

  const result = await updateHandoff(
    repoRoot,
    updates,
    {
      actorLabel: options.owner,
      delegationPacketSectionText: buildDelegationPacketSection(updates.delegationPacket, {
        task: options.task,
        lockedFiles: files,
      }),
      contextSectionText: buildContextForReviewerSection(claimReviewContextFields),
      reviewResponseText: buildPendingReviewResponseSection(),
      eventType: "claim",
      eventDetails: {
        task: options.task,
        lockedFiles: files,
        ...(cgraphMetadata ? { cgraph: cgraphMetadata } : {}),
      },
    },
  )
  await compactHandoffHistory(repoRoot, { config, actorLabel: options.owner })
  return result
}

async function patchHandoff(repoRoot, options) {
  const config = await readProjectConfig(repoRoot)
  const laneConfigs = getLaneConfigs(config)
  if (laneConfigs && !options.lane) {
    throw new BtrainError({
      message: "`btrain handoff update` requires --lane when [lanes] is enabled.",
      reason: "Multi-lane repos need an explicit lane target so btrain knows which lane to update.",
      fix: `btrain handoff update --lane <id> --status <status> --actor "<agent>"`,
      context: "Run `btrain handoff` to see available lanes and their current status.",
    })
  }

  validateHandoffStatus(options.status)

  const { actor: resolvedActor } = resolveVerifiedActor(config, options.actor)
  const configuredAgents = getConfiguredAgentNames(config)

  const updates = {}
  if (options.task !== undefined) {
    updates.task = options.task
  }
  if (options.owner !== undefined) {
    updates.owner = options.owner
  }
  if (options.reviewer !== undefined) {
    updates.reviewer = options.reviewer
  }
  if (options.status !== undefined) {
    updates.status = options.status
  }
  if (options.mode !== undefined) {
    updates.reviewMode = options.mode
  }
  if (options.files !== undefined) {
    updates.lockedFiles = parseCsvList(options.files)
  }
  if (options.next !== undefined) {
    updates.nextAction = options.next
  }
  if (options.base !== undefined) {
    updates.base = options.base
  }
  if (options.pr !== undefined) {
    updates.prNumber = normalizePrNumber(options.pr)
  }

  updates.lastUpdated = `${resolvedActor || "btrain"} ${formatIsoTimestamp()}`

  // Lane-aware patch
  const laneId = options.lane
  if (laneId) {
    const handoffPath = getLaneHandoffPath(repoRoot, config, laneId)
    if (handoffPath) {
      const existingCurrent = await readLaneState(repoRoot, config, laneId)
      const existingContent = await readText(handoffPath)
      const locks = await listLocks(repoRoot)
      const currentLane = decorateLaneState(existingCurrent, getLaneLocks(locks, laneId))
      const nextStatus = updates.status ?? existingCurrent.status
      const effectiveOwner = updates.owner ?? existingCurrent.owner ?? resolvedActor ?? "btrain"
      const reasonMetadata = resolveReasonMetadata(existingCurrent, nextStatus, options, {
        requireReasonOnTransition: options.status !== undefined,
      })

      if (options.status === "needs-review") {
        const inferredReviewer = inferPeerReviewer({
          actor: resolvedActor,
          reviewer: updates.reviewer,
          currentReviewer: existingCurrent.reviewer,
          owner: updates.owner,
          currentOwner: existingCurrent.owner,
          configuredAgents,
        })

        if (!inferredReviewer) {
          throw new BtrainError({
            message: `Could not infer a reviewer different from "${resolvedActor || "the actor"}".`,
            reason: "The owner and all configured agents resolve to the same identity, so no peer reviewer can be assigned.",
            fix: `Pass --reviewer <other-agent> explicitly, or add more agents with \`btrain agents add --repo . --agent <name>\`.`,
          })
        }

        updates.reviewer = inferredReviewer
      }

      if (options.status !== undefined && options.next === undefined) {
        updates.nextAction = defaultNextActionForStatus(nextStatus, {
          owner: updates.owner ?? existingCurrent.owner,
          reviewer: updates.reviewer ?? existingCurrent.reviewer,
        })
      }
      updates.reasonCode = reasonMetadata.reasonCode
      updates.reasonTags = reasonMetadata.reasonTags
      let repairMetadata = {
        repairOwner: existingCurrent.repairOwner || "",
        repairEscalation: existingCurrent.repairEscalation || "",
        repairAttempts: Number(existingCurrent.repairAttempts) || 0,
      }

      if (nextStatus === "repair-needed") {
        if (existingCurrent.status === "repair-needed") {
          repairMetadata = {
            repairOwner: existingCurrent.repairOwner || effectiveOwner,
            repairEscalation: existingCurrent.repairEscalation || "",
            repairAttempts: Number(existingCurrent.repairAttempts) || 1,
          }
        } else {
          repairMetadata = await resolveRepairAssignment(repoRoot, config, {
            laneId,
            existingCurrent,
            reasonCode: reasonMetadata.reasonCode,
            actorLabel: resolvedActor || effectiveOwner,
          })
        }
      } else {
        repairMetadata = {
          repairOwner: "",
          repairEscalation: "",
          repairAttempts: 0,
        }
      }
      updates.repairOwner = repairMetadata.repairOwner
      updates.repairEscalation = repairMetadata.repairEscalation
      updates.repairAttempts = repairMetadata.repairAttempts
      if (nextStatus === "repair-needed" && options.next === undefined) {
        updates.nextAction = buildRepairNextAction({
          ...repairMetadata,
          reasonCode: reasonMetadata.reasonCode,
        })
      }

      if (nextStatus === "resolved") {
        throw new BtrainError({
          message: `Cannot set status to \`resolved\` via \`handoff update\`.`,
          reason: "The resolve command handles lock cleanup and history archival that \`update\` does not.",
          fix: `btrain handoff resolve --lane ${laneId} --summary "..." --actor "${resolvedActor || effectiveOwner}"`,
        })
      }

      if (isLaneActiveStatus(nextStatus) && currentLane.lockState === "mismatch" && options.files === undefined) {
        throw new BtrainError({
          message: `Lane ${laneId} lock state is out of sync.`,
          reason: "The locks in .btrain/locks.json don't match the handoff file.",
          fix: `btrain handoff update --lane ${laneId} --files "..." --actor "${resolvedActor || effectiveOwner}"`,
          context: "Pass --files with the correct working set to resync the locks.",
        })
      }

      const effectiveFiles = normalizePathList(
        options.files !== undefined
          ? parseCsvList(options.files)
          : currentLane.handoffPaths.length > 0
            ? currentLane.handoffPaths
            : currentLane.lockPaths,
      )
      const baseForReview = options.base !== undefined ? options.base : existingCurrent.base
      const delegationPacketUpdated = hasDelegationPacketUpdates(options)
      const nextDelegationPacket = delegationPacketUpdated
        ? buildDelegationPacketValue(existingCurrent.delegationPacket, options, {
            task: updates.task ?? existingCurrent.task,
            lockedFiles: effectiveFiles,
          })
        : existingCurrent.delegationPacket
      const nextContextSectionText = mergeContextForReviewerSection(existingContent, options)
      const overrideId = typeof options["override-id"] === "string" ? options["override-id"].trim() : ""
      let overrideRecord = null

      if (nextStatus === "needs-review") {
        if (overrideId) {
          overrideRecord = await consumeOverride(repoRoot, {
            config,
            action: "needs-review",
            laneId,
            overrideId,
            actorLabel: resolvedActor || effectiveOwner,
          })
        } else {
          const handoffCfg = getHandoffConfig(config)
          await validateNeedsReviewTransition(repoRoot, {
            laneId,
            base: baseForReview,
            contextSectionText: nextContextSectionText,
            pathspecs: effectiveFiles,
            skipDiff: !handoffCfg.requireDiff || !!options["no-diff"],
          })
        }
      }

      if (isLaneActiveStatus(nextStatus)) {
        if (effectiveFiles.length === 0) {
          throw new BtrainError({
            message: `Lane ${laneId} cannot be \`${nextStatus}\` without locked files.`,
            reason: "Active lanes require file locks to prevent cross-lane collisions.",
            fix: `btrain handoff update --lane ${laneId} --status ${nextStatus} --files "src/,..." --actor "${effectiveOwner}"`,
          })
        }
        await acquireLocks(repoRoot, laneId, effectiveOwner, effectiveFiles)
        updates.lockedFiles = effectiveFiles
      } else if (currentLane.lockCount > 0 || currentLane.handoffPaths.length > 0 || options.files !== undefined) {
        await releaseLocks(repoRoot, laneId)
        updates.lockedFiles = []
      }

      const contextSectionText =
        options.preflight !== undefined
        || options.changed !== undefined
        || options.verification !== undefined
        || options.gap !== undefined
        || options.why !== undefined
        || options["review-ask"] !== undefined
          ? nextContextSectionText
          : undefined
      if (delegationPacketUpdated) {
        updates.delegationPacket = nextDelegationPacket
      }
      const cgraphMetadata =
        nextStatus === "needs-review"
          ? await buildNeedsReviewCgraphMetadata(repoRoot, config, {
              laneId,
              files: effectiveFiles,
              base: baseForReview || "",
            })
          : null

      return updateHandoff(repoRoot, updates, {
        actorLabel: resolvedActor || effectiveOwner,
        config,
        overrideHandoffPath: handoffPath,
        delegationPacketSectionText:
          delegationPacketUpdated
            ? buildDelegationPacketSection(nextDelegationPacket, {
                task: updates.task ?? existingCurrent.task,
                lockedFiles: effectiveFiles,
              })
            : undefined,
        contextSectionText,
        eventType: "update",
        laneId,
        eventDetails: {
          requestedStatus: options.status,
          files: updates.lockedFiles,
          overrideId: overrideRecord?.id || "",
          repairOwner: updates.repairOwner || "",
          repairEscalation: updates.repairEscalation || "",
          repairAttempts: updates.repairAttempts || 0,
          ...(cgraphMetadata ? { cgraph: cgraphMetadata } : {}),
        },
      })
    }
  }

  const existingCurrent = await readCurrentState(repoRoot)
  const { handoffPath } = getConfiguredRepoPaths(repoRoot, config)
  const existingContent = (await pathExists(handoffPath)) ? await readText(handoffPath) : renderHandoffTemplate(normalizeRepoName(repoRoot))

  if (options.status === "needs-review") {
    const inferredReviewer = inferPeerReviewer({
      actor: resolvedActor,
      reviewer: updates.reviewer,
      currentReviewer: existingCurrent.reviewer,
      owner: updates.owner,
      currentOwner: existingCurrent.owner,
      configuredAgents,
    })

    if (!inferredReviewer) {
      throw new BtrainError({
        message: `Could not infer a reviewer different from "${resolvedActor || "the actor"}".`,
        reason: "The owner and all configured agents resolve to the same identity, so no peer reviewer can be assigned.",
        fix: `Pass --reviewer <other-agent> explicitly, or add more agents with \`btrain agents add --repo . --agent <name>\`.`,
      })
    }

    updates.reviewer = inferredReviewer
  }

  if (options.status !== undefined && options.next === undefined) {
    updates.nextAction = defaultNextActionForStatus(options.status, {
      owner: updates.owner ?? existingCurrent.owner,
      reviewer: updates.reviewer ?? existingCurrent.reviewer,
    })
  }
  const nextStatus = updates.status ?? existingCurrent.status
  const reasonMetadata = resolveReasonMetadata(existingCurrent, nextStatus, options, {
    requireReasonOnTransition: options.status !== undefined,
  })
  updates.reasonCode = reasonMetadata.reasonCode
  updates.reasonTags = reasonMetadata.reasonTags
  let repairMetadata = {
    repairOwner: existingCurrent.repairOwner || "",
    repairEscalation: existingCurrent.repairEscalation || "",
    repairAttempts: Number(existingCurrent.repairAttempts) || 0,
  }

  if (nextStatus === "repair-needed") {
    if (existingCurrent.status === "repair-needed") {
      repairMetadata = {
        repairOwner: existingCurrent.repairOwner || updates.owner || existingCurrent.owner || resolvedActor || "btrain",
        repairEscalation: existingCurrent.repairEscalation || "",
        repairAttempts: Number(existingCurrent.repairAttempts) || 1,
      }
    } else {
      repairMetadata = await resolveRepairAssignment(repoRoot, config, {
        existingCurrent,
        reasonCode: reasonMetadata.reasonCode,
        actorLabel: resolvedActor || updates.owner || existingCurrent.owner || "btrain",
      })
    }
  } else {
    repairMetadata = {
      repairOwner: "",
      repairEscalation: "",
      repairAttempts: 0,
    }
  }
  updates.repairOwner = repairMetadata.repairOwner
  updates.repairEscalation = repairMetadata.repairEscalation
  updates.repairAttempts = repairMetadata.repairAttempts
  if (nextStatus === "repair-needed" && options.next === undefined) {
    updates.nextAction = buildRepairNextAction({
      ...repairMetadata,
      reasonCode: reasonMetadata.reasonCode,
    })
  }
  const nextContextSectionText = mergeContextForReviewerSection(existingContent, options)
  const delegationPacketUpdated = hasDelegationPacketUpdates(options)
  const nextDelegationPacket = delegationPacketUpdated
    ? buildDelegationPacketValue(existingCurrent.delegationPacket, options, {
        task: updates.task ?? existingCurrent.task,
        lockedFiles: updates.lockedFiles ?? existingCurrent.lockedFiles,
      })
    : existingCurrent.delegationPacket
  const overrideId = typeof options["override-id"] === "string" ? options["override-id"].trim() : ""
  let overrideRecord = null

  if (nextStatus === "needs-review") {
    if (overrideId) {
      overrideRecord = await consumeOverride(repoRoot, {
        config,
        action: "needs-review",
        overrideId,
        actorLabel: resolvedActor || updates.owner || existingCurrent.owner || "btrain",
      })
    } else {
      const handoffCfg = getHandoffConfig(config)
      await validateNeedsReviewTransition(repoRoot, {
        base: options.base !== undefined ? options.base : existingCurrent.base,
        contextSectionText: nextContextSectionText,
        skipDiff: !handoffCfg.requireDiff || !!options["no-diff"],
      })
    }
  }

  const contextSectionText =
    options.preflight !== undefined
    || options.changed !== undefined
    || options.verification !== undefined
    || options.gap !== undefined
    || options.why !== undefined
    || options["review-ask"] !== undefined
      ? nextContextSectionText
      : undefined
  if (delegationPacketUpdated) {
    updates.delegationPacket = nextDelegationPacket
  }
  const cgraphMetadata =
    nextStatus === "needs-review"
      ? await buildNeedsReviewCgraphMetadata(repoRoot, config, {
          files: updates.lockedFiles ?? existingCurrent.lockedFiles,
          base: options.base !== undefined ? options.base : existingCurrent.base,
        })
      : null

  return updateHandoff(repoRoot, updates, {
    actorLabel: resolvedActor || updates.owner || existingCurrent.owner || "btrain",
    delegationPacketSectionText:
      delegationPacketUpdated
        ? buildDelegationPacketSection(nextDelegationPacket, {
            task: updates.task ?? existingCurrent.task,
            lockedFiles: updates.lockedFiles ?? existingCurrent.lockedFiles,
          })
        : undefined,
    contextSectionText,
    config,
    eventType: "update",
    eventDetails: {
      requestedStatus: options.status,
      files: updates.lockedFiles,
      overrideId: overrideRecord?.id || "",
      repairOwner: updates.repairOwner || "",
      repairEscalation: updates.repairEscalation || "",
      repairAttempts: updates.repairAttempts || 0,
      ...(cgraphMetadata ? { cgraph: cgraphMetadata } : {}),
    },
  })
}

async function requestChangesHandoff(repoRoot, options) {
  const config = await readProjectConfig(repoRoot)
  const { actor: resolvedActor } = resolveVerifiedActor(config, options.actor)
  const actorLabel = resolvedActor || options.actor || "btrain"
  const laneConfigs = getLaneConfigs(config)
  const laneId = options.lane

  if (!options.summary) {
    throw new BtrainError({
      message: "`btrain handoff request-changes` requires --summary.",
      reason: "The reviewer must provide a summary of the changes they're requesting.",
      fix: `btrain handoff request-changes --lane <id> --summary "Describe the issues found" --reason-code spec-mismatch --actor "<reviewer>"`,
    })
  }

  if (laneConfigs && !laneId) {
    throw new BtrainError({
      message: "`btrain handoff request-changes` requires --lane when [lanes] is enabled.",
      reason: "Multi-lane repos need an explicit lane target.",
      fix: `btrain handoff request-changes --lane <id> --summary "..." --reason-code <code> --actor "${actorLabel}"`,
      context: "Run `btrain handoff` to see available lanes and their current status.",
    })
  }

  const overrideHandoffPath = laneId ? getLaneHandoffPath(repoRoot, config, laneId) : null
  const existingCurrent =
    overrideHandoffPath && (await pathExists(overrideHandoffPath))
      ? parseCurrentSection(await readText(overrideHandoffPath))
      : await readCurrentState(repoRoot)

  if (existingCurrent.status !== "needs-review") {
    throw new BtrainError({
      message: `Cannot request changes — lane status is \`${existingCurrent.status || "unknown"}\`, not \`needs-review\`.`,
      reason: "Changes can only be requested when a lane is waiting for peer review.",
      fix: laneId
        ? `Run \`btrain handoff\` to check the lane status. The owner must first move to needs-review with: btrain handoff update --lane ${laneId} --status needs-review --actor "${existingCurrent.owner || 'owner'}"`
        : "Run `btrain handoff` to check the current handoff status.",
    })
  }

  if (existingCurrent.reviewer && resolvedActor && existingCurrent.reviewer !== resolvedActor) {
    throw new BtrainError({
      message: `Only the peer reviewer "${existingCurrent.reviewer}" can request changes.`,
      reason: `You are identified as "${resolvedActor}", but the assigned reviewer is "${existingCurrent.reviewer}".`,
      fix: `Either log in as the correct reviewer, or set BTRAIN_AGENT=${existingCurrent.reviewer} if the runtime detection is wrong.`,
    })
  }
  const reasonMetadata = resolveReasonMetadata(existingCurrent, "changes-requested", options, {
    requireReasonOnTransition: true,
  })

  if (laneId) {
    const locks = await listLocks(repoRoot)
    const currentLane = decorateLaneState(existingCurrent, getLaneLocks(locks, laneId))
    const effectiveFiles =
      currentLane.handoffPaths.length > 0 ? currentLane.handoffPaths : currentLane.lockPaths

    if (effectiveFiles.length === 0) {
      throw new BtrainError({
        message: `Lane ${laneId} cannot move to \`changes-requested\` without locked files.`,
        reason: "The lane has no active file locks, which indicates a corrupted or manually cleared state.",
        fix: `Repair the lane locks first: btrain handoff update --lane ${laneId} --files "..." --actor "${existingCurrent.owner || actorLabel}"`,
      })
    }

    if (currentLane.lockState !== "active") {
      await acquireLocks(repoRoot, laneId, existingCurrent.owner || actorLabel, effectiveFiles)
    }
  }

  return updateHandoff(
    repoRoot,
    {
      status: "changes-requested",
      reasonCode: reasonMetadata.reasonCode,
      reasonTags: reasonMetadata.reasonTags,
      nextAction:
        options.next
        || defaultNextActionForStatus("changes-requested", {
          owner: existingCurrent.owner,
          reviewer: existingCurrent.reviewer,
        }),
      lastUpdated: `${actorLabel} ${formatIsoTimestamp()}`,
    },
    {
      actorLabel,
      reviewResponseSummary: options.summary,
      config,
      eventType: "request-changes",
      laneId,
      eventDetails: {
        summary: options.summary,
      },
      overrideHandoffPath,
    },
  )
}

async function resolveHandoff(repoRoot, options) {
  const config = await readProjectConfig(repoRoot)
  const prFlow = getPrFlowConfig(config)
  const { actor: resolvedActor } = resolveVerifiedActor(config, options.actor)
  const actorLabel = resolvedActor || options.owner || "btrain"
  const laneConfigs = getLaneConfigs(config)
  const laneId = options.lane
  let overrideHandoffPath = null

  // Lane-aware resolve: read state from lane-specific file
  if (laneConfigs && !laneId) {
    throw new BtrainError({
      message: "`btrain handoff resolve` requires --lane when [lanes] is enabled.",
      reason: "Multi-lane repos need an explicit lane target so btrain can clear the correct locks.",
      fix: `btrain handoff resolve --lane <id> --summary "..." --actor "${actorLabel}"`,
      context: "Run `btrain handoff` to see available lanes and their current status.",
    })
  }

  if (laneId) {
    overrideHandoffPath = getLaneHandoffPath(repoRoot, config, laneId)
  }

  let existingCurrent
  if (overrideHandoffPath && (await pathExists(overrideHandoffPath))) {
    const content = await readText(overrideHandoffPath)
    existingCurrent = parseCurrentSection(content)
  } else {
    existingCurrent = await readCurrentState(repoRoot)
  }

  const previousHandoffEntry =
    existingCurrent.task || options.summary
      ? buildPreviousHandoffEntry(existingCurrent, options.summary, actorLabel)
      : null

  const finalResolve = !!options.final || !!options["final"]
  if (prFlow.enabled && existingCurrent.status === "needs-review" && !finalResolve) {
    const retainedFiles = normalizePathList(existingCurrent.lockedFiles)
    if (laneId && retainedFiles.length > 0) {
      await acquireLocks(repoRoot, laneId, existingCurrent.owner || actorLabel, retainedFiles)
    }

    return updateHandoff(
      repoRoot,
      {
        status: "ready-for-pr",
        lockedFiles: retainedFiles,
        nextAction:
          options.next
          || `Local review approved. ${existingCurrent.owner || "Owner"}: run \`btrain pr create --lane ${laneId || "<id>"} --base ${prFlow.base} --bots all\`, or link an existing PR with \`btrain handoff update --lane ${laneId || "<id>"} --pr <number> --status pr-review --actor "${existingCurrent.owner || "owner"}"\`.`,
        lastUpdated: `${actorLabel} ${formatIsoTimestamp()}`,
        reasonCode: "",
        reasonTags: [],
      },
      {
        actorLabel,
        reviewResponseSummary: options.summary,
        config,
        eventType: "resolve",
        laneId,
        eventDetails: {
          summary: options.summary || "",
          localReviewApproved: true,
          nextStatus: "ready-for-pr",
        },
        overrideHandoffPath,
      },
    )
  }

  // Release locks for this lane
  if (laneId) {
    await releaseLocks(repoRoot, laneId)
  }
  if (isCgraphEnabled(config)) {
    await reconcileCgraphAdvisories(repoRoot, laneId || "repo", [], {
      adviseOnResolution: false,
      clearLane: true,
    })
  }

  const result = await updateHandoff(
    repoRoot,
    {
      status: "resolved",
      lockedFiles: laneId ? [] : existingCurrent.lockedFiles,
      nextAction: options.next || options.summary || defaultNextActionForStatus("resolved"),
      lastUpdated: `${actorLabel} ${formatIsoTimestamp()}`,
      reasonCode: "",
      reasonTags: [],
    },
    {
      actorLabel,
      previousHandoffEntry,
      reviewResponseSummary: options.summary,
      config,
      eventType: "resolve",
      laneId,
      eventDetails: {
        summary: options.summary || "",
      },
      overrideHandoffPath,
    },
  )
  await compactHandoffHistory(repoRoot, { config, laneId, actorLabel })
  return result
}

function buildLaneGuidance(laneId, current) {
  const prefix = `[Lane ${laneId}] `
  const lockLine =
    current.lockState === "missing"
      ? `Lock state: missing. Re-run \`btrain handoff update --lane ${laneId} --status in-progress --files "..." --actor "${current.owner || "owner"}"\`.`
      : current.lockState === "mismatch"
        ? `Lock state: mismatch between the handoff and \`.btrain/locks.json\`. Re-run \`btrain handoff update --lane ${laneId} --files "..." --actor "${current.owner || "owner"}"\`.`
        : current.lockCount > 0
          ? `Locked files: ${formatLockedPaths(current.lockPaths)}.`
          : "Locked files: (none)."

  switch (current.status) {
    case "needs-review": {
      const reviewer = current.reviewer || "the peer reviewer"
      const owner = current.owner || "the active agent"
      const reviewMode = normalizeReviewMode(current.reviewMode) || "manual"
      const prLine = current.prNumber
        ? `Review the PR — the diff lives there, not in the local working tree: \`gh pr view ${current.prNumber}\` / \`gh pr diff ${current.prNumber}\`.`
        : `No PR linked. If a PR exists for this lane, run \`btrain handoff update --lane ${laneId} --pr <number> --actor "${owner}"\` so the reviewer can find it.`
      const reviewerInstruction =
        reviewMode === "parallel" || reviewMode === "hybrid"
          ? `${reviewer}: run \`btrain review run\`, then \`btrain handoff resolve --lane ${laneId} --summary "..."\`.`
          : `${reviewer}: review, then \`btrain handoff resolve --lane ${laneId} --summary "..."\`.`
      return [
        `${prefix}Waiting on peer review from ${reviewer}.`,
        lockLine,
        prLine,
        reviewerInstruction,
        `${owner}: work on your other lane while waiting.`,
      ].join("\n")
    }
    case "ready-for-pr": {
      const owner = current.owner || "the active agent"
      return [
        `${prefix}Local peer review is approved; PR creation is next.`,
        lockLine,
        current.prNumber
          ? `Linked PR: \`gh pr view ${current.prNumber}\`. Move into PR review with \`btrain handoff update --lane ${laneId} --status pr-review --actor "${owner}"\`.`
          : `${owner}: create the PR with \`btrain pr create --lane ${laneId} --bots all\`, or link an existing PR with \`btrain handoff update --lane ${laneId} --status pr-review --pr <number> --actor "${owner}"\`.`,
        "Keep the lane locks until the PR is merged or intentionally closed.",
      ].join("\n")
    }
    case "pr-review": {
      const owner = current.owner || "the active agent"
      return [
        `${prefix}Waiting on GitHub PR review feedback.`,
        lockLine,
        current.prNumber
          ? `Poll the PR loop with \`btrain pr poll --lane ${laneId} --apply\` and inspect with \`gh pr view ${current.prNumber}\`.`
          : `No PR linked. Link one with \`btrain handoff update --lane ${laneId} --status pr-review --pr <number> --actor "${owner}"\`.`,
        `${owner}: if bot feedback appears, address it in this lane, push, then run \`btrain pr request-review --lane ${laneId} --bots all\`.`,
      ].join("\n")
    }
    case "ready-to-merge": {
      return [
        `${prefix}PR review is clear and ready to merge.`,
        lockLine,
        current.prNumber
          ? `Merge PR #${current.prNumber}, then run \`btrain pr poll --lane ${laneId} --apply\` so btrain releases locks and resolves the lane.`
          : "No PR linked; link or merge the PR before resolving.",
      ].join("\n")
    }
    case "changes-requested": {
      const reviewer = current.reviewer || "the peer reviewer"
      const owner = current.owner || "the active agent"
      const prLine = current.prNumber
        ? `Linked PR: \`gh pr view ${current.prNumber}\` / \`gh pr diff ${current.prNumber}\`. Reviewer should evaluate the PR diff, not the local working tree.`
        : `No PR linked. If a PR exists for this lane, run \`btrain handoff update --lane ${laneId} --pr <number> --actor "${owner}"\` so the next reviewer pass can find it.`
      if (["pr-review-feedback", "bot-feedback", "ci-failure"].includes(current.reasonCode)) {
        return [
          `${prefix}GitHub PR feedback requested changes.`,
          lockLine,
          prLine,
          current.reasonCode ? `Primary reason code: ${current.reasonCode}.` : "",
          current.reasonTags?.length ? `Reason tags: ${current.reasonTags.join(", ")}.` : "",
          `${owner}: address the PR feedback in this lane, commit and push, then \`btrain pr request-review --lane ${laneId} --bots all\` and \`btrain handoff update --lane ${laneId} --status pr-review --actor "${owner}"\`.`,
        ].join("\n")
      }
      return [
        `${prefix}Changes requested by ${reviewer}.`,
        lockLine,
        prLine,
        current.reasonCode ? `Primary reason code: ${current.reasonCode}.` : "",
        current.reasonTags?.length ? `Reason tags: ${current.reasonTags.join(", ")}.` : "",
        `${owner}: address the reviewer findings in the same lane, then \`btrain handoff update --lane ${laneId} --status needs-review --actor "${owner}"\`.`,
        `${reviewer}: wait for the writer to re-handoff the lane.`,
      ].join("\n")
    }
    case "repair-needed": {
      const owner = current.owner || "the active agent"
      const repairOwner = current.repairOwner || current.owner || "the responsible actor"
      const escalationLine =
        current.repairEscalation === "human"
          ? `Escalation: human intervention required after ${Number(current.repairAttempts) || 1} repair attempt${Number(current.repairAttempts) === 1 ? "" : "s"}.`
          : Number(current.repairAttempts) > 0
            ? `Repair attempts: ${Number(current.repairAttempts)}.`
            : ""
      return [
        `${prefix}Workflow repair needed before normal work can resume.`,
        lockLine,
        current.reasonCode ? `Primary reason code: ${current.reasonCode}.` : "",
        current.reasonTags?.length ? `Reason tags: ${current.reasonTags.join(", ")}.` : "",
        `Repair owner: ${repairOwner}.`,
        escalationLine,
        current.nextAction || `${owner}: inspect the handoff, lock state, and \`btrain doctor\` output before making more transitions.`,
      ].join("\n")
    }
    case "in-progress": {
      const owner = current.owner || "the active agent"
      return [
        `${prefix}Active agent: ${owner}.`,
        lockLine,
        `${owner}: start with a short pre-flight review of the locked files, nearby diff, and likely risk areas before editing.`,
        `When done: \`btrain handoff update --lane ${laneId} --status needs-review --actor "${owner}"\`.`,
      ].join("\n")
    }
    case "resolved":
      return [
        `${prefix}Resolved. Ready for a new task: \`btrain handoff claim --lane ${laneId} --task "..." --owner "..." --reviewer "..."\`.`,
        lockLine,
        current.repurposeReady ? `Repurpose ready: ${current.repurposeReason}.` : "",
      ].join("\n")
    case "idle":
      return [
        `${prefix}Idle. Claim: \`btrain handoff claim --lane ${laneId} --task "..." --owner "..." --reviewer "..."\`.`,
        lockLine,
      ].join("\n")
    default:
      return `${prefix}Status: ${current.status}\n${lockLine}`
  }
}

async function checkHandoff(repoRoot) {
  const config = await readProjectConfig(repoRoot)
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  const repoName = config?.name || normalizeRepoName(repoRoot)
  const laneConfigs = getLaneConfigs(config)
  const agentCheck = detectCurrentAgent(config)

  // Multi-lane mode
  if (laneConfigs) {
    const locks = await listLocks(repoRoot)
    const laneStates = await attachLatestCgraphMetadataToStates(
      repoRoot,
      config,
      decorateLaneStates(await readAllLaneStates(repoRoot, config), locks),
    )
    const overrides = await listActiveOverrides(repoRoot)
    const laneGuidances = laneStates.map((state) => buildLaneGuidance(state._laneId, state))

    let guidance = laneGuidances.join("\n\n")

    if (locks.length > 0) {
      const lockLines = locks.map((l) => `  ${l.lane}: ${l.path} (${l.owner})`)
      guidance += `\n\nActive locks:\n${lockLines.join("\n")}`
    }

    if (overrides.length > 0) {
      guidance += `\n\nActive overrides:\n${overrides.map((record) => `  ${record.id}: ${formatOverrideSummary(record)}`).join("\n")}`
    }

    const multiResult = {
      repoName,
      repoRoot,
      handoffPath: repoPaths.handoffPath,
      current: laneStates[0] || { ...DEFAULT_CURRENT },
      lanes: laneStates,
      locks,
      overrides,
      agentCheck,
      guidance,
    }
    multiResult.stateHash = computeHandoffStateHash(multiResult)
    return multiResult
  }

  // Single-lane mode (backward compatible)
  const current = await attachLatestCgraphMetadataToState(repoRoot, config, await readCurrentState(repoRoot))
  const overrides = await listActiveOverrides(repoRoot)

  let guidance

  switch (current.status) {
    case "needs-review": {
      const reviewer = current.reviewer || "the peer reviewer"
      const owner = current.owner || "the active agent"
      const reviewMode = normalizeReviewMode(current.reviewMode) || "manual"
      const reviewerInstruction =
        reviewMode === "parallel" || reviewMode === "hybrid"
          ? `If you are ${reviewer}: run \`btrain review run\` to generate the automated report, inspect \`.btrain/reviews/\`, then run \`btrain handoff resolve --summary "..."\`.`
          : `If you are ${reviewer}: do the review, then run \`btrain handoff resolve --summary "..."\`.`
      guidance = [
        `Waiting on peer review from ${reviewer}.`,
        reviewerInstruction,
        `If you are ${owner}: it's not your turn. Wait for the review.`,
      ].join("\n")
      break
    }
    case "ready-for-pr": {
      const owner = current.owner || "the active agent"
      guidance = [
        "Local peer review is approved; PR creation is next.",
        current.prNumber
          ? `Linked PR: \`gh pr view ${current.prNumber}\`. Move into PR review with \`btrain handoff update --status pr-review --actor "${owner}"\`.`
          : `If you are ${owner}: create the PR with \`btrain pr create --bots all\`, or link an existing PR with \`btrain handoff update --status pr-review --pr <number> --actor "${owner}"\`.`,
        "Keep the lane active until the PR is merged or intentionally closed.",
      ].join("\n")
      break
    }
    case "pr-review": {
      const owner = current.owner || "the active agent"
      guidance = [
        "Waiting on GitHub PR review feedback.",
        current.prNumber
          ? `Poll the PR loop with \`btrain pr poll --apply\` and inspect with \`gh pr view ${current.prNumber}\`.`
          : `No PR linked. Link one with \`btrain handoff update --status pr-review --pr <number> --actor "${owner}"\`.`,
        `If you are ${owner}: if bot feedback appears, address it, push, then run \`btrain pr request-review --bots all\`.`,
      ].join("\n")
      break
    }
    case "ready-to-merge": {
      guidance = [
        "PR review is clear and ready to merge.",
        current.prNumber
          ? `Merge PR #${current.prNumber}, then run \`btrain pr poll --apply\` so btrain resolves the lane.`
          : "No PR linked; link or merge the PR before resolving.",
      ].join("\n")
      break
    }
    case "changes-requested": {
      const owner = current.owner || "the active agent"
      const reviewer = current.reviewer || "the peer reviewer"
      if (["pr-review-feedback", "bot-feedback", "ci-failure"].includes(current.reasonCode)) {
        guidance = [
          "GitHub PR feedback requested changes.",
          current.reasonCode ? `Primary reason code: ${current.reasonCode}.` : "",
          current.reasonTags?.length ? `Reason tags: ${current.reasonTags.join(", ")}.` : "",
          `If you are ${owner}: address the PR feedback, commit and push, then \`btrain pr request-review --bots all\` and \`btrain handoff update --status pr-review --actor "${owner}"\`.`,
        ].join("\n")
        break
      }
      guidance = [
        `Changes requested by ${reviewer}.`,
        current.reasonCode ? `Primary reason code: ${current.reasonCode}.` : "",
        current.reasonTags?.length ? `Reason tags: ${current.reasonTags.join(", ")}.` : "",
        `If you are ${owner}: address the reviewer findings, then run \`btrain handoff update --status needs-review --actor "${owner}"\`.`,
        `If you are ${reviewer}: wait for the writer to re-handoff the task.`,
      ].join("\n")
      break
    }
    case "repair-needed": {
      const repairOwner = current.repairOwner || current.owner || "the responsible actor"
      const escalationLine =
        current.repairEscalation === "human"
          ? `Human escalation required after ${Number(current.repairAttempts) || 1} repair attempt${Number(current.repairAttempts) === 1 ? "" : "s"}.`
          : Number(current.repairAttempts) > 0
            ? `Repair attempts: ${Number(current.repairAttempts)}.`
            : ""
      guidance = [
        "Workflow repair needed before normal work can resume.",
        current.reasonCode ? `Primary reason code: ${current.reasonCode}.` : "",
        current.reasonTags?.length ? `Reason tags: ${current.reasonTags.join(", ")}.` : "",
        `Repair owner: ${repairOwner}.`,
        escalationLine,
        current.nextAction || `${repairOwner} should inspect the handoff state, lock state, and \`btrain doctor\` output before making more transitions.`,
      ].join("\n")
      break
    }
    case "in-progress": {
      const owner = current.owner || "the active agent"
      const reviewer = current.reviewer || "the peer reviewer"
      guidance = [
        `Active agent: ${owner}.`,
        `If you are ${owner}: start with a short pre-flight review of the locked files, nearby diff, and likely risk areas, then continue the task. When done, fill in the Context for Peer Review section and run \`btrain handoff update --status needs-review --actor "${owner}"\`.`,
        `If you are ${reviewer}: it's not your turn yet.`,
      ].join("\n")
      break
    }
    case "resolved": {
      const repurpose = classifyRepurposeReady(current)
      guidance = [
        "No active task. The previous handoff is resolved.",
        current.nextAction ? `Next action: ${current.nextAction}` : "Ready for someone to claim the next task.",
        repurpose.ready ? `Repurpose ready: ${repurpose.reason}.` : "",
        'To start: run `btrain handoff claim --task "..." --owner "..." --reviewer "..."`.',
      ].join("\n")
      break
    }
    case "idle": {
      guidance = [
        "No task has been claimed yet.",
        'To start: run `btrain handoff claim --task "..." --owner "..." --reviewer "..."`.',
      ].join("\n")
      break
    }
    default: {
      guidance = [
        `Status is "${current.status}". Run \`btrain handoff\` to understand the current state.`,
        "Use `btrain handoff update` to move the workflow forward.",
      ].join("\n")
      break
    }
  }

  const singleResult = {
    repoName,
    repoRoot,
    handoffPath: repoPaths.handoffPath,
    current,
    overrides,
    agentCheck,
    guidance,
  }
  singleResult.stateHash = computeHandoffStateHash(singleResult)
  return singleResult
}

function parseTomlString(rawValue) {
  return rawValue.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
}

function parseTomlArray(rawValue) {
  const body = rawValue.slice(1, -1).trim()
  if (!body) {
    return []
  }

  return body
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.startsWith("\"") && item.endsWith("\"")) {
        return parseTomlString(item)
      }
      if (item === "true") {
        return true
      }
      if (item === "false") {
        return false
      }
      return item
    })
}

// This stays intentionally narrow: it only parses the scalar forms that btrain
// emits today, and preserves unknown unquoted values verbatim instead of trying
// to be a fully compliant TOML parser.
function parseTomlValue(rawValue) {
  const trimmed = rawValue.trim()

  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return parseTomlString(trimmed)
  }

  if (trimmed === "true") {
    return true
  }

  if (trimmed === "false") {
    return false
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseTomlArray(trimmed)
  }

  return trimmed
}

function ensureTomlSection(root, sectionPath) {
  let current = root
  for (const segment of sectionPath) {
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) {
      current[segment] = {}
    }
    current = current[segment]
  }
  return current
}

function parseTomlKey(rawKey) {
  const trimmed = rawKey.trim()
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return parseTomlString(trimmed)
  }
  return trimmed
}

function parseProjectToml(content) {
  const result = {}
  let currentSection = null

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const sectionMatch = /^\[([A-Za-z0-9_.]+)\]$/.exec(trimmed)
    if (sectionMatch) {
      currentSection = sectionMatch[1].split(".").filter(Boolean)
      ensureTomlSection(result, currentSection)
      continue
    }

    const entryMatch = /^("(?:[^"\\]|\\.)+"|[A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed)
    if (!entryMatch) {
      continue
    }

    const key = parseTomlKey(entryMatch[1])
    const value = parseTomlValue(entryMatch[2])
    if (currentSection) {
      ensureTomlSection(result, currentSection)[key] = value
    } else {
      result[key] = value
    }
  }

  return result
}

async function readProjectConfig(repoRoot) {
  const { projectTomlPath } = getRepoPaths(repoRoot)
  if (!(await pathExists(projectTomlPath))) {
    return null
  }

  return parseProjectToml(await readText(projectTomlPath))
}

function normalizeReviewMode(mode) {
  if (typeof mode !== "string") {
    return null
  }

  const normalized = mode.trim().toLowerCase()
  return normalized || null
}

function getReviewConfig(config) {
  const reviews = config?.reviews && typeof config.reviews === "object" ? config.reviews : {}

  return {
    defaultMode: normalizeReviewMode(config?.default_review_mode) || "manual",
    parallelEnabled: reviews.parallel_enabled !== false,
    sequentialEnabled: reviews.sequential_enabled === true,
    sequentialTriggers: Array.isArray(reviews.sequential_triggers) ? reviews.sequential_triggers : [],
    parallelScript:
      typeof reviews.parallel_script === "string" && reviews.parallel_script.trim()
        ? reviews.parallel_script.trim()
        : DEFAULT_PARALLEL_REVIEW_SCRIPT,
    hybridPathTriggers: Array.isArray(reviews.hybrid_path_triggers) ? reviews.hybrid_path_triggers : [],
    hybridContentTriggers: Array.isArray(reviews.hybrid_content_triggers) ? reviews.hybrid_content_triggers : [],
  }
}

function normalizePrBotConfig(id, value = {}) {
  const bot = value && typeof value === "object" ? value : {}
  const defaultAliases =
    id === "codex"
      ? ["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"]
      : id === "unblocked"
        ? ["unblocked[bot]", "unblocked"]
        : [id]
  const aliases = Array.isArray(bot.aliases)
    ? bot.aliases.map((item) => String(item).trim()).filter(Boolean)
    : defaultAliases
  const requestBody =
    typeof bot.request_body === "string" && bot.request_body.trim()
      ? bot.request_body.trim()
      : id === "codex"
        ? "@codex review"
        : id === "unblocked"
          ? "@unblocked review again"
          : `@${id} review`

  return {
    id,
    aliases,
    requestBody,
  }
}

function getPrFlowConfig(config) {
  const prFlow = config?.pr_flow && typeof config.pr_flow === "object" ? config.pr_flow : {}
  const rawBots = prFlow.bots && typeof prFlow.bots === "object" ? prFlow.bots : {}
  const requiredBots = Array.isArray(prFlow.required_bots) && prFlow.required_bots.length > 0
    ? prFlow.required_bots.map((item) => String(item).trim()).filter(Boolean)
    : ["codex", "unblocked"]
  const botConfigs = {}
  for (const botId of requiredBots) {
    botConfigs[botId] = normalizePrBotConfig(botId, rawBots[botId])
  }

  return {
    enabled: prFlow.enabled === true,
    base:
      typeof prFlow.base === "string" && prFlow.base.trim()
        ? prFlow.base.trim()
        : "main",
    requiredBots,
    bots: botConfigs,
  }
}

function getHarnessConfig(config) {
  const harness = config?.harness && typeof config.harness === "object" ? config.harness : {}
  return {
    activeProfile:
      normalizeHarnessProfileId(harness.active_profile || harness.activeProfile || harness.profile)
      || DEFAULT_HARNESS_PROFILE_ID,
  }
}

async function resolveActiveHarnessProfile(repoRoot, config) {
  const harnessConfig = getHarnessConfig(config)

  try {
    const profile = await loadHarnessProfile({
      repoRoot,
      profileId: harnessConfig.activeProfile,
    })

    if (!profile) {
      throw new BtrainError({
        message: `Unknown harness profile "${harnessConfig.activeProfile}".`,
        reason: "No repo-local or bundled harness profile matched the configured active profile.",
        fix: `Set [harness].active_profile to "${DEFAULT_HARNESS_PROFILE_ID}" in .btrain/project.toml, or add .btrain/harness/profiles/${harnessConfig.activeProfile}.json.`,
      })
    }

    return {
      ...profile,
      configuredId: harnessConfig.activeProfile,
    }
  } catch (error) {
    if (error instanceof BtrainError) {
      throw error
    }

    throw new BtrainError({
      message: `Failed to load harness profile "${harnessConfig.activeProfile}".`,
      reason: error?.message || "The configured harness profile could not be parsed.",
      fix: `Fix [harness].active_profile in .btrain/project.toml or repair .btrain/harness/profiles/${harnessConfig.activeProfile}.json.`,
    })
  }
}

function getHandoffConfig(config) {
  const handoff = config?.handoff && typeof config.handoff === "object" ? config.handoff : {}
  const ttl = typeof handoff.lock_ttl_hours === "number" && handoff.lock_ttl_hours > 0
    ? handoff.lock_ttl_hours * 60 * 60 * 1000
    : DEFAULT_LOCK_TTL_MS
  return {
    requireDiff: handoff.require_diff !== false,
    lockTtlMs: ttl,
  }
}

function isLockExpired(lock, ttlMs) {
  if (!lock.acquired_at) return false
  return Date.now() - new Date(lock.acquired_at).getTime() > ttlMs
}

function getFeedbackConfig(config) {
  const feedback = config?.feedback && typeof config.feedback === "object" ? config.feedback : {}
  return {
    enabled: feedback.enabled !== false,
  }
}

function getAgentRunnerMap(config) {
  const runners =
    config?.agents?.runners && typeof config.agents.runners === "object"
      ? config.agents.runners
      : {}

  return Object.fromEntries(
    Object.entries(runners).filter(([, value]) => typeof value === "string" && value.trim()),
  )
}

function normalizeAgentName(value) {
  return typeof value === "string" ? value.trim() : ""
}

function isAnyOtherReviewerValue(value) {
  const normalized = normalizeAgentName(value)
    .toLowerCase()
    .replaceAll(/[\s_]+/g, "-")
  return normalized === "any-other"
}

function getConfiguredAgentNames(config) {
  const agentNames = []
  const seen = new Set()

  const addAgent = (value) => {
    const agentName = normalizeAgentName(value)
    if (!agentName || isAnyOtherReviewerValue(agentName)) {
      return
    }

    const key = agentName.toLowerCase()
    if (seen.has(key)) {
      return
    }

    seen.add(key)
    agentNames.push(agentName)
  }

  for (const agentName of getCollaborationAgentNames(config)) {
    addAgent(agentName)
  }

  addAgent(config?.agents?.writer_default)
  addAgent(config?.agents?.reviewer_default)

  for (const agentName of Object.keys(getAgentRunnerMap(config))) {
    addAgent(agentName)
  }

  return agentNames
}

function canonicalizeAgentName(agentNames, value) {
  const requestedName = normalizeAgentName(value)
  if (!requestedName) {
    return ""
  }

  return agentNames.find((agentName) => agentName.toLowerCase() === requestedName.toLowerCase()) || requestedName
}

function tokenizeAgentIdentity(value) {
  return Array.from(
    new Set(
      normalizeAgentName(value)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3)
        .filter((token) => !["agent", "manual", "mode", "notify", "permission", "review"].includes(token)),
    ),
  )
}

function collectRuntimeAgentHints(env = process.env) {
  const hints = new Set()

  const addHintsFromText = (value) => {
    const text = String(value || "").toLowerCase()
    if (!text) {
      return
    }

    if (text.includes("codex")) {
      hints.add("codex")
    }
    if (text.includes("claude")) {
      hints.add("claude")
    }
    if (text.includes("gemini")) {
      hints.add("gemini")
    }
    if (text.includes("opus")) {
      hints.add("opus")
    }
  }

  for (const [key, value] of Object.entries(env || {})) {
    addHintsFromText(key)
    addHintsFromText(value)
  }

  return [...hints]
}

function detectCurrentAgent(config, env = process.env) {
  const configuredAgents = getConfiguredAgentNames(config)
  if (configuredAgents.length === 0) {
    return {
      status: "unconfigured",
      agentName: "",
      candidates: [],
      configuredAgents,
      sourceLabel: "no agents configured",
    }
  }

  const explicitAgent = normalizeAgentName(env.BTRAIN_AGENT || env.BRAIN_TRAIN_AGENT)
  if (explicitAgent) {
    const matchedAgent = configuredAgents.find((agentName) => agentName.toLowerCase() === explicitAgent.toLowerCase())
    if (matchedAgent) {
      return {
        status: "verified",
        agentName: matchedAgent,
        candidates: [matchedAgent],
        configuredAgents,
        sourceLabel: `env override (${explicitAgent})`,
      }
    }

    return {
      status: "unknown",
      agentName: "",
      candidates: [],
      configuredAgents,
      sourceLabel: `env override (${explicitAgent})`,
    }
  }

  const runnerMap = getAgentRunnerMap(config)
  const runtimeHints = collectRuntimeAgentHints(env)

  if (runtimeHints.length === 0) {
    return {
      status: "unknown",
      agentName: "",
      candidates: [],
      configuredAgents,
      sourceLabel: "no runtime hints",
    }
  }

  const matches = configuredAgents.filter((agentName) => {
    const identityTokens = new Set([
      ...tokenizeAgentIdentity(agentName),
      ...tokenizeAgentIdentity(runnerMap[agentName] || ""),
    ])
    return runtimeHints.some((hint) => identityTokens.has(hint))
  })

  if (matches.length === 1) {
    return {
      status: "verified",
      agentName: matches[0],
      candidates: matches,
      configuredAgents,
      sourceLabel: `runtime hints (${runtimeHints.join(", ")})`,
    }
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      agentName: "",
      candidates: matches,
      configuredAgents,
      sourceLabel: `runtime hints (${runtimeHints.join(", ")})`,
    }
  }

  return {
    status: "unknown",
    agentName: "",
    candidates: [],
    configuredAgents,
    sourceLabel: `runtime hints (${runtimeHints.join(", ")})`,
  }
}

function resolveVerifiedActor(config, actor, env = process.env) {
  const configuredAgents = getConfiguredAgentNames(config)
  const requestedActor = canonicalizeAgentName(configuredAgents, actor)
  const agentCheck = detectCurrentAgent(config, env)

  if (agentCheck.status === "verified") {
    if (requestedActor && requestedActor.toLowerCase() !== agentCheck.agentName.toLowerCase()) {
      throw new BtrainError({
        message: `Actor "${requestedActor}" does not match the detected agent "${agentCheck.agentName}".`,
        reason: "The --actor flag value conflicts with the runtime-detected agent identity.",
        fix: `Use --actor "${agentCheck.agentName}" to match the detected identity, or set BTRAIN_AGENT=${requestedActor} to override detection.`,
      })
    }

    return {
      actor: agentCheck.agentName,
      agentCheck,
    }
  }

  return {
    actor: requestedActor,
    agentCheck,
  }
}

function inferPeerReviewer({ actor, reviewer, currentReviewer, owner, currentOwner, configuredAgents }) {
  const actorKey = normalizeAgentName(actor).toLowerCase()
  const candidates = []
  const seen = new Set()
  const prefersAnyOther = isAnyOtherReviewerValue(reviewer)

  const addCandidate = (value) => {
    if (isAnyOtherReviewerValue(value)) {
      return
    }

    const candidate = canonicalizeAgentName(configuredAgents, value)
    if (!candidate) {
      return
    }

    const key = candidate.toLowerCase()
    if (key === actorKey || seen.has(key)) {
      return
    }

    seen.add(key)
    candidates.push(candidate)
  }

  if (!prefersAnyOther) {
    addCandidate(reviewer)
  }
  addCandidate(currentReviewer)
  addCandidate(owner)
  addCandidate(currentOwner)

  for (const agentName of configuredAgents) {
    addCandidate(agentName)
  }

  return candidates[0] || ""
}

function resolveReviewMode({ config, handoffMode, overrideMode } = {}) {
  // Priority: CLI > explicit handoff mode (non-manual) > project config > handoff fallback > default
  const fromCli = normalizeReviewMode(overrideMode)
  if (fromCli) {
    return { mode: fromCli, source: "cli" }
  }

  // Explicit handoff mode (set via `handoff claim --mode parallel`) overrides
  // project config. But the default "manual" yields to project config because
  // every handoff starts with reviewMode: "manual" even when no --mode was given.
  const fromHandoff = normalizeReviewMode(handoffMode)
  if (fromHandoff && fromHandoff !== "manual") {
    return { mode: fromHandoff, source: "handoff" }
  }

  const fromConfig = normalizeReviewMode(config?.default_review_mode)
  if (fromConfig) {
    return { mode: fromConfig, source: "project-config" }
  }

  if (fromHandoff) {
    return { mode: fromHandoff, source: "handoff" }
  }

  return { mode: "manual", source: "default" }
}

function resolveReviewScriptPath(scriptPath, repoRoot) {
  return path.isAbsolute(scriptPath) ? scriptPath : path.resolve(repoRoot, scriptPath)
}

function buildReviewArtifactId(mode, date = new Date()) {
  const compactTimestamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-")

  return `review-${compactTimestamp}-${mode}`
}

async function resolveGitRevision(repoRoot, ref) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", ref], {
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function listReviewArtifacts(repoRoot) {
  const { reviewsDir } = getRepoPaths(repoRoot)
  if (!(await pathExists(reviewsDir))) {
    return []
  }

  const entries = await fs.readdir(reviewsDir)
  const artifacts = []

  for (const entry of entries) {
    if (!entry.startsWith("review-") || !entry.endsWith(".json")) {
      continue
    }

    const metadata = await readJson(path.join(reviewsDir, entry), null)
    if (!metadata || metadata.kind !== "btrain-review") {
      continue
    }

    artifacts.push(metadata)
  }

  return artifacts.sort((left, right) => {
    const leftTime = new Date(left.completedAt || left.startedAt || 0).getTime()
    const rightTime = new Date(right.completedAt || right.startedAt || 0).getTime()
    return rightTime - leftTime
  })
}

async function runReview({ repoRoot, mode, base, head } = {}) {
  const config = await readProjectConfig(repoRoot)
  if (!config) {
    throw new BtrainError({
      message: "Missing `.btrain/project.toml`.",
      reason: "This command requires a btrain-initialized repo.",
      fix: "Run `btrain init .` or `btrain init <repo-path>` to bootstrap the repo first.",
    })
  }

  const current = await readCurrentState(repoRoot)
  const repoName = config?.name || normalizeRepoName(repoRoot)
  const repoPaths = getRepoPaths(repoRoot)
  const reviewConfig = getReviewConfig(config)
  const resolvedMode = resolveReviewMode({
    config,
    handoffMode: current.reviewMode,
    overrideMode: mode,
  })
  const resolvedBase = base || current.base || "HEAD~1"
  const resolvedHead = head || "HEAD"

  if (!SUPPORTED_REVIEW_MODES.has(resolvedMode.mode)) {
    throw new BtrainError({
      message: `Review mode "${resolvedMode.mode}" is not supported.`,
      reason: "Only manual, parallel, and hybrid review modes are implemented.",
      fix: "Set the review mode to one of: manual, parallel, hybrid. Update review.mode in .btrain/project.toml or pass --mode.",
    })
  }

  if (resolvedMode.mode === "manual") {
    return {
      repoName,
      repoRoot,
      mode: resolvedMode.mode,
      modeSource: resolvedMode.source,
      status: "skipped",
      reason: "manual-mode",
      base: resolvedBase,
      head: resolvedHead,
      artifact: null,
      reviewConfig,
    }
  }

  if (!reviewConfig.parallelEnabled) {
    throw new BtrainError({
      message: "Parallel review is disabled.",
      reason: "The [review] section in .btrain/project.toml has parallel_enabled = false or it is not configured.",
      fix: "Set `parallel_enabled = true` under [review] in .btrain/project.toml, or use `--mode manual` for manual reviews.",
    })
  }

  await ensureDir(repoPaths.reviewsDir)

  const startedAt = formatIsoTimestamp()
  const artifactId = buildReviewArtifactId(resolvedMode.mode)
  const reportPath = path.join(repoPaths.reviewsDir, `${artifactId}.md`)
  const metadataPath = path.join(repoPaths.reviewsDir, `${artifactId}.json`)
  const scriptPath = resolveReviewScriptPath(reviewConfig.parallelScript, repoRoot)

  if (!(await pathExists(scriptPath))) {
    throw new BtrainError({
      message: `Parallel review script not found: ${scriptPath}`,
      reason: "The configured review script path does not exist on disk.",
      fix: "Check [review].parallel_script in .btrain/project.toml and verify the script path is correct.",
    })
  }

  let stdout = ""
  let stderr = ""
  let errorMessage = ""
  let exitCode = 0

  try {
    const scriptArgs = [
      scriptPath,
      "--repo", repoRoot,
      "--base", resolvedBase,
      "--head", resolvedHead,
      "--output", reportPath,
      "--mode", resolvedMode.mode === "hybrid" ? "hybrid" : "parallel",
    ]

    // Pass hybrid triggers from project.toml to the review script
    if (resolvedMode.mode === "hybrid" && reviewConfig.hybridPathTriggers.length > 0) {
      scriptArgs.push("--path-triggers", reviewConfig.hybridPathTriggers.join(","))
    }
    if (resolvedMode.mode === "hybrid" && reviewConfig.hybridContentTriggers.length > 0) {
      scriptArgs.push("--content-triggers", reviewConfig.hybridContentTriggers.join(","))
    }

    const result = await execFileAsync(
      "python3",
      scriptArgs,
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    stdout = result.stdout.trim()
    stderr = result.stderr.trim()
  } catch (error) {
    stdout = error.stdout?.trim() || ""
    stderr = error.stderr?.trim() || ""
    errorMessage = error.message
    exitCode = typeof error.status === "number" ? error.status : 1
  }

  const completedAt = formatIsoTimestamp()
  const reportExists = await pathExists(reportPath)

  if (!errorMessage && !reportExists) {
    errorMessage = "Parallel review runner exited without writing a report."
    exitCode = exitCode || 1
  }

  const artifact = {
    kind: "btrain-review",
    id: artifactId,
    repoName,
    repoRoot,
    status: errorMessage ? "failed" : "completed",
    mode: resolvedMode.mode,
    modeSource: resolvedMode.source,
    base: resolvedBase,
    head: resolvedHead,
    baseRevision: await resolveGitRevision(repoRoot, resolvedBase),
    headRevision: await resolveGitRevision(repoRoot, resolvedHead),
    reportPath,
    metadataPath,
    reportExists,
    startedAt,
    completedAt,
    task: current.task || "",
    owner: current.owner || "",
    reviewer: current.reviewer || "",
    runner: {
      command: "python3",
      scriptPath,
      exitCode,
    },
    stdout,
    stderr,
    error: errorMessage,
  }

  await writeJson(metadataPath, artifact)

  return {
    repoName,
    repoRoot,
    mode: resolvedMode.mode,
    modeSource: resolvedMode.source,
    status: artifact.status,
    reason: artifact.error || "",
    base: resolvedBase,
    head: resolvedHead,
    artifact,
    reviewConfig,
  }
}

async function getReviewStatus(repoRoot) {
  const config = await readProjectConfig(repoRoot)
  if (!config) {
    throw new BtrainError({
      message: "Missing `.btrain/project.toml`.",
      reason: "This command requires a btrain-initialized repo.",
      fix: "Run `btrain init .` or `btrain init <repo-path>` to bootstrap the repo first.",
    })
  }

  const current = await readCurrentState(repoRoot)
  const repoName = config?.name || normalizeRepoName(repoRoot)
  const reviewConfig = getReviewConfig(config)
  const resolvedMode = resolveReviewMode({
    config,
    handoffMode: current.reviewMode,
  })
  const artifacts = await listReviewArtifacts(repoRoot)

  return {
    repoName,
    repoRoot,
    handoffMode: normalizeReviewMode(current.reviewMode) || "manual",
    mode: resolvedMode.mode,
    modeSource: resolvedMode.source,
    reviewConfig,
    runCount: artifacts.length,
    latest: artifacts[0] || null,
  }
}

function getLoopActorForState(current) {
  if (current.status === "in-progress") {
    return current.owner || ""
  }
  if (current.status === "changes-requested") {
    return current.owner || ""
  }
  if (current.status === "needs-review") {
    return current.reviewer || ""
  }
  if (
    current.status === "ready-for-pr"
    || current.status === "pr-review"
    || current.status === "ready-to-merge"
  ) {
    return current.owner || ""
  }
  return ""
}

function parseShellWords(commandText) {
  const tokens = []
  let current = ""
  let quote = null
  let escaping = false

  for (const character of commandText) {
    if (escaping) {
      current += character
      escaping = false
      continue
    }

    if (character === "\\") {
      escaping = true
      continue
    }

    if (quote) {
      if (character === quote) {
        quote = null
      } else {
        current += character
      }
      continue
    }

    if (character === "\"" || character === "'") {
      quote = character
      continue
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += character
  }

  if (escaping) {
    current += "\\"
  }

  if (quote) {
    throw new BtrainError({
      message: `Unterminated quote in runner command.`,
      reason: `The command string has an unmatched quote character.`,
      fix: `Fix the quoting in the runner command in .btrain/project.toml: ${commandText}`,
    })
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function replaceRunnerPlaceholders(value, substitutions) {
  return value
    .replaceAll("{repo}", substitutions.repoRoot)
    .replaceAll("{prompt}", substitutions.prompt)
    .replaceAll("{agent}", substitutions.agentName)
}

function formatCommandForDisplay(command, args, repoRoot) {
  const displayParts = [command, ...args].map((value) =>
    /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value),
  )
  return `${displayParts.join(" ")} (cwd: ${repoRoot})`
}

function hasPromptPlaceholder(tokens) {
  return tokens.some((token) => token.includes("{prompt}"))
}

function hasRepoPlaceholder(tokens) {
  return tokens.some((token) => token.includes("{repo}"))
}

function isClaudeRunnerCommand(command) {
  return path.basename(command) === "claude"
}

function isCodexRunnerCommand(command, args) {
  const basename = path.basename(command)
  return basename === "codex" || (basename === "npx" && args[0] === "@openai/codex")
}

function hasCodexRepoArg(args) {
  return args.some((token) => token === "-C" || token === "--cd" || token.startsWith("--cd="))
}

function hasRunnerArg(args, ...names) {
  return args.some((token) => names.some((name) => token === name || token.startsWith(`${name}=`)))
}

function getRunnerOptionValue(args, ...names) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    for (const name of names) {
      if (token === name) {
        return args[index + 1] || ""
      }
      if (token.startsWith(`${name}=`)) {
        return token.slice(name.length + 1)
      }
    }
  }
  return ""
}

function hasClaudeStreamJsonOutput(args) {
  return getRunnerOptionValue(args, "--output-format") === "stream-json"
}

function hasCodexJsonOutput(args) {
  return hasRunnerArg(args, "--json")
}

function findCodexSubcommandIndex(args) {
  return args.findIndex((token) => CODEX_SUBCOMMANDS.has(token))
}

function stripRunnerFlag(args, ...names) {
  const stripped = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    const matchedName = names.find((name) => token === name || token.startsWith(`${name}=`))
    if (!matchedName) {
      stripped.push(token)
      continue
    }
    if (token === matchedName) {
      continue
    }
  }
  return stripped
}

function normalizeLoopCliRunner(runnerValue, { repoRoot, prompt, agentName }) {
  const tokens = parseShellWords(runnerValue)
  if (tokens.length === 0) {
    return null
  }

  const placeholderPrompt = hasPromptPlaceholder(tokens)
  const placeholderRepo = hasRepoPlaceholder(tokens)
  const command = replaceRunnerPlaceholders(tokens[0], { repoRoot, prompt, agentName })
  let args = tokens.slice(1).map((token) => replaceRunnerPlaceholders(token, { repoRoot, prompt, agentName }))

  if (isCodexRunnerCommand(command, args)) {
    if (path.basename(command) === "npx") {
      const packageToken = args[0]
      const packageArgs = stripRunnerFlag(
        args.slice(1).filter((token) => token !== "--quiet"),
        "--json",
      )
      let subcommandIndex = findCodexSubcommandIndex(packageArgs)
      if (subcommandIndex === -1) {
        packageArgs.unshift("exec")
        subcommandIndex = 0
      }
      if (packageArgs[subcommandIndex] === "exec" && !hasCodexJsonOutput(packageArgs.slice(subcommandIndex + 1))) {
        packageArgs.splice(subcommandIndex + 1, 0, "--json")
      }
      if (!placeholderRepo && !hasCodexRepoArg(packageArgs.slice(subcommandIndex + 1))) {
        packageArgs.push("-C", repoRoot)
      }
      if (!placeholderPrompt) {
        packageArgs.push(prompt)
      }
      args = [packageToken, ...packageArgs]
    } else {
      args = stripRunnerFlag(
        args.filter((token) => token !== "--quiet"),
        "--json",
      )
      let subcommandIndex = findCodexSubcommandIndex(args)
      if (subcommandIndex === -1) {
        args.push("exec")
        subcommandIndex = args.length - 1
      }
      if (args[subcommandIndex] === "exec" && !hasCodexJsonOutput(args.slice(subcommandIndex + 1))) {
        args.splice(subcommandIndex + 1, 0, "--json")
      }
      if (!placeholderRepo && !hasCodexRepoArg(args.slice(subcommandIndex + 1))) {
        args.push("-C", repoRoot)
      }
      if (!placeholderPrompt) {
        args.push(prompt)
      }
    }
  } else if (isClaudeRunnerCommand(command)) {
    if (!hasRunnerArg(args, "-p", "--print")) {
      args.unshift("-p")
    }
    if (!hasRunnerArg(args, "--verbose")) {
      args.push("--verbose")
    }
    if (!hasRunnerArg(args, "--output-format")) {
      args.push("--output-format", "stream-json")
    }
    if (!hasRunnerArg(args, "--include-partial-messages")) {
      args.push("--include-partial-messages")
    }
    if (!placeholderPrompt) {
      args.push(prompt)
    }
  } else if (!placeholderPrompt) {
    args.push(prompt)
  }

  return {
    type: "cli",
    command,
    args,
    displayCommand: formatCommandForDisplay(command, args, repoRoot),
    streamMode:
      isClaudeRunnerCommand(command) && hasClaudeStreamJsonOutput(args)
        ? "claude-stream-json"
        : isCodexRunnerCommand(command, args) && hasCodexJsonOutput(args)
          ? "codex-json"
          : null,
  }
}

function resolveLoopRunner(agentName, config, repoRoot, { prompt = LOOP_PROMPT } = {}) {
  const runnerMap = getAgentRunnerMap(config)
  const configuredValue = runnerMap[agentName]

  if (!configuredValue) {
    return {
      type: "notify",
      displayCommand: "",
      configuredValue: "",
      fallback: true,
    }
  }

  if (configuredValue.trim().toLowerCase() === "notify") {
    return {
      type: "notify",
      displayCommand: "",
      configuredValue,
      fallback: false,
    }
  }

  const cliRunner = normalizeLoopCliRunner(configuredValue, {
    repoRoot,
    prompt,
    agentName,
  })

  if (!cliRunner) {
    return {
      type: "notify",
      displayCommand: "",
      configuredValue,
      fallback: true,
    }
  }

  return {
    ...cliRunner,
    configuredValue,
    fallback: false,
  }
}

async function isExecutableAvailable(command) {
  const candidatePaths = []

  if (path.isAbsolute(command)) {
    candidatePaths.push(command)
  } else if (command.includes(path.sep)) {
    candidatePaths.push(path.resolve(command))
  } else {
    for (const pathEntry of (process.env.PATH || "").split(path.delimiter)) {
      if (!pathEntry) {
        continue
      }
      candidatePaths.push(path.join(pathEntry, command))
    }
  }

  for (const candidatePath of candidatePaths) {
    if (await pathExists(candidatePath)) {
      return true
    }
  }

  return false
}

function serializeCurrentState(current) {
  return JSON.stringify({
    ...current,
    lockedFiles: Array.isArray(current.lockedFiles) ? [...current.lockedFiles] : [],
  })
}

async function waitForHandoffChange(repoRoot, previousFingerprint, { timeoutMs, pollIntervalMs }) {
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    const current = await readCurrentState(repoRoot)
    if (serializeCurrentState(current) !== previousFingerprint) {
      return { changed: true, current }
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      break
    }

    await delay(Math.min(pollIntervalMs, remainingMs))
  }

  return {
    changed: false,
    current: await readCurrentState(repoRoot),
  }
}


async function executeLoopCliRunnerWithStreaming(agentName, runner, { repoRoot, timeoutMs, onEvent }) {
  const startedAt = formatIsoTimestamp()
  onEvent(`[${startedAt}] dispatch ${agentName}: ${runner.displayCommand}`)

  const observer =
    runner.streamMode === "codex-json" ? createCodexStreamObserver(onEvent) : createClaudeStreamObserver(onEvent)
  const child = spawn(runner.command, runner.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let timedOut = false
  let spawnError = null
  let stdout = ""
  let stderr = ""
  let timeoutHandle = null

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")

  child.stdout.on("data", (chunk) => {
    stdout += chunk
    observer.consumeStdoutChunk(chunk)
  })

  child.stderr.on("data", (chunk) => {
    stderr += chunk
    observer.consumeStderrChunk(chunk)
  })

  child.on("error", (error) => {
    spawnError = error
  })

  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL")
        }
      }, 1000)
    }, timeoutMs)
  }

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1))
  })

  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
  }

  observer.flush()
  const completedAt = formatIsoTimestamp()

  if (spawnError) {
    onEvent(`[${completedAt}] exit ${agentName}: 1`)
    return {
      status: "failed",
      exitCode: 1,
      startedAt,
      completedAt,
      error: spawnError.message || "",
      stdout: observer.bufferedStdout || (observer.streamedStdout ? "" : stdout.trim()),
      stderr: observer.bufferedStderr || stderr.trim(),
      streamedStdout: observer.streamedStdout,
      streamedStderr: false,
    }
  }

  if (timedOut) {
    onEvent(`[${completedAt}] timeout ${agentName}: timeout`)
    return {
      status: "timed-out",
      exitCode,
      startedAt,
      completedAt,
      stdout: observer.bufferedStdout || (observer.streamedStdout ? "" : stdout.trim()),
      stderr: observer.bufferedStderr || stderr.trim(),
      streamedStdout: observer.streamedStdout,
      streamedStderr: false,
    }
  }

  onEvent(`[${completedAt}] exit ${agentName}: ${exitCode}`)
  return {
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    startedAt,
    completedAt,
    stdout: observer.bufferedStdout || (observer.streamedStdout ? "" : stdout.trim()),
    stderr: observer.bufferedStderr || stderr.trim(),
    streamedStdout: observer.streamedStdout,
    streamedStderr: false,
  }
}

async function executeLoopCliRunner(agentName, runner, { repoRoot, timeoutMs, onEvent }) {
  if (!(await isExecutableAvailable(runner.command))) {
    throw new BtrainError({
      message: `Runner command not found on PATH for ${agentName}: ${runner.command}`,
      reason: "The configured runner executable is not available in the current shell PATH.",
      fix: `Install ${runner.command} or update [agents.runners.${agentName}] in .btrain/project.toml to the correct command.`,
    })
  }

  if (runner.streamMode === "claude-stream-json" || runner.streamMode === "codex-json") {
    return executeLoopCliRunnerWithStreaming(agentName, runner, {
      repoRoot,
      timeoutMs,
      onEvent,
    })
  }

  const startedAt = formatIsoTimestamp()
  onEvent(`[${startedAt}] dispatch ${agentName}: ${runner.displayCommand}`)

  try {
    const result = await execFileAsync(runner.command, runner.args, {
      cwd: repoRoot,
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    })

    const completedAt = formatIsoTimestamp()
    onEvent(`[${completedAt}] exit ${agentName}: 0`)
    return {
      status: "completed",
      exitCode: 0,
      startedAt,
      completedAt,
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr?.trim() || "",
      streamedStdout: false,
      streamedStderr: false,
    }
  } catch (error) {
    const completedAt = formatIsoTimestamp()
    const timedOut = error.killed || /timed out/i.test(error.message || "")
    const exitCode = typeof error.status === "number" ? error.status : 1
    onEvent(
      `[${completedAt}] ${timedOut ? "timeout" : "exit"} ${agentName}: ${timedOut ? "timeout" : exitCode}`,
    )
    return {
      status: timedOut ? "timed-out" : "failed",
      exitCode,
      startedAt,
      completedAt,
      error: error.message || "",
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || "",
      streamedStdout: false,
      streamedStderr: false,
    }
  }
}

function normalizePositiveInteger(value, defaultValue, label) {
  if (value === undefined || value === null || value === "") {
    return defaultValue
  }

  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BtrainError({
      message: `${label} must be a positive integer.`,
      reason: `Received "${value}" which is not a valid positive integer.`,
      fix: `Provide a positive integer value for ${label}. Example: --${label.replace(/[\[\].]/g, "").toLowerCase().replace(/\s+/g, "-")} 3`,
    })
  }
  return parsed
}

function normalizePositiveDuration(value, defaultMs, label) {
  if (value === undefined || value === null || value === "") {
    return defaultMs
  }

  const parsed = Number.parseFloat(String(value))
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BtrainError({
      message: `${label} must be a positive number.`,
      reason: `Received "${value}" which is not a valid positive number.`,
      fix: `Provide a positive number for ${label}. Example: --timeout 60`,
    })
  }
  return Math.round(parsed * 1000)
}

function formatLoopSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(Number.isInteger(milliseconds / 1000) ? 0 : 1)}s`
}

function formatLoopState(current) {
  return [
    `status=${current.status}`,
    `owner=${current.owner || "(unassigned)"}`,
    `reviewer=${current.reviewer || "(unassigned)"}`,
    `review-mode=${current.reviewMode || "manual"}`,
    `last-updated=${current.lastUpdated || "(none)"}`,
  ].join(" | ")
}

function hasMeaningfulDelegationPacket(packet = {}) {
  const normalized = normalizeDelegationPacket(packet)
  return Boolean(
    normalized.objective ||
      normalized.deliverable ||
      normalized.constraints.length > 0 ||
      normalized.acceptance.length > 0 ||
      normalized.budget ||
      normalized.doneWhen,
  )
}

function formatLoopDelegationPacketValue(value, maxLength = 160) {
  const compact = normalizeParagraphLines(value, []).join(" ")
  return summarizeLoopProgressText(compact, maxLength)
}

function formatLoopDelegationPacketList(values = []) {
  const normalized = normalizeListValue(values, [])
  if (normalized.length === 0) {
    return ""
  }

  const firstItem = summarizeLoopProgressText(normalized[0], 120)
  if (normalized.length === 1) {
    return firstItem
  }
  return `${firstItem} (+${normalized.length - 1} more)`
}

function buildLoopDelegationPacketSummaryLines(current = {}) {
  const packet = normalizeDelegationPacket(current?.delegationPacket)
  if (!hasMeaningfulDelegationPacket(packet)) {
    return []
  }

  return [
    packet.objective ? `objective: ${formatLoopDelegationPacketValue(packet.objective)}` : "",
    packet.deliverable ? `deliverable: ${formatLoopDelegationPacketValue(packet.deliverable)}` : "",
    packet.constraints.length > 0 ? `constraints: ${formatLoopDelegationPacketList(packet.constraints)}` : "",
    packet.acceptance.length > 0 ? `acceptance: ${formatLoopDelegationPacketList(packet.acceptance)}` : "",
    packet.budget ? `budget: ${formatLoopDelegationPacketValue(packet.budget)}` : "",
    packet.doneWhen ? `done when: ${formatLoopDelegationPacketValue(packet.doneWhen)}` : "",
  ].filter(Boolean)
}

function emitLoopBlock(onEvent, title, lines) {
  onEvent(title)
  for (const line of lines.filter(Boolean)) {
    onEvent(`  ${line}`)
  }
}

function describeLoopAgentReason(current) {
  if (current.status === "in-progress") {
    return "handoff status is in-progress, so the active agent acts next"
  }
  if (current.status === "changes-requested") {
    return "handoff status is changes-requested, so the writer acts next"
  }
  if (current.status === "needs-review") {
    return "handoff status is needs-review, so the peer reviewer acts next"
  }
  return `handoff status is ${current.status}`
}

function emitLoopTransition(onEvent, before, after) {
  onEvent("handoff transition:")
  onEvent(`  before: ${formatLoopState(before)}`)
  onEvent(`  after:  ${formatLoopState(after)}`)
}

/**
 * One-shot push to an agent.
 * - If the agent has a CLI runner configured: executes it directly (injects into
 *   the running app via its IPC, e.g. `antigravity chat --reuse-window bth`).
 * - If the runner is "notify" or unset: falls back to inbox file + macOS notification.
 */
async function runPush(agentName, { repoRoot, prompt, onEvent = () => {} } = {}) {
  let dispatchPrompt = prompt || LOOP_PROMPT

  if (repoRoot) {
    const config = await readProjectConfig(repoRoot)
    if (config) {
      const harnessProfile = await resolveActiveHarnessProfile(repoRoot, config)
      dispatchPrompt = prompt || harnessProfile.loop.dispatchPrompt || LOOP_PROMPT
      const runner = resolveLoopRunner(agentName, config, repoRoot, { prompt: dispatchPrompt })
      if (runner.type === "cli") {
        onEvent(`push: dispatching ${agentName} via CLI runner: ${runner.displayCommand}`)
        const result = await executeLoopCliRunner(agentName, runner, {
          repoRoot,
          timeoutMs: 15 * 1000, // short timeout for a one-shot push
          onEvent,
        })
        // Forward agent stdout so callers (and tests) can see it
        if (result.stdout) {
          for (const line of result.stdout.split("\n")) {
            if (line.trim()) onEvent(line)
          }
        }
        return result
      }
    }
  }
  // Fallback: inbox file + notification
  const pushResult = await pushAgentPrompt(agentName, { prompt: dispatchPrompt })
  return { type: "notify", ...pushResult }
}

function sanitizeAgentNameForFile(agentName) {
  return (
    String(agentName || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown-agent"
  )
}

/**
 * Write a pending prompt to ~/.btrain/pending/<agent>.md and send a macOS
 * notification so the user knows to open the vendor harness for that agent.
 * Silent no-op on non-macOS or when osascript is unavailable.
 */
async function pushAgentPrompt(agentName, { repoName = "", taskDescription = "", prompt = LOOP_PROMPT } = {}) {
  const pendingDir = path.join(getBrainTrainHome(), "pending")
  await ensureDir(pendingDir)

  const sanitized = sanitizeAgentNameForFile(agentName)
  const inboxPath = path.join(pendingDir, `${sanitized}.md`)
  await writeText(inboxPath, prompt)

  // macOS notification — best-effort, silent failure everywhere else
  let notified = false
  try {
    const title = "btrain: your turn"
    const subtitle = repoName || ""
    const body = taskDescription ? `Task: ${taskDescription}` : `Pending prompt ready for ${agentName}`
    const script = subtitle
      ? `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(subtitle)}`
      : `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
    await execFileAsync("osascript", ["-e", script], { timeout: 3000 })
    notified = true
  } catch {
    // Notifications not available — not a critical error
  }

  return { inboxPath, notified }
}

async function runLoop({
  repoRoot,
  maxRounds,
  timeout,
  pollInterval,
  dryRun = false,
  onEvent = () => {},
} = {}) {
  const config = await readProjectConfig(repoRoot)
  if (!config) {
    throw new BtrainError({
      message: "Missing `.btrain/project.toml`.",
      reason: "This command requires a btrain-initialized repo.",
      fix: "Run `btrain init .` or `btrain init <repo-path>` to bootstrap the repo first.",
    })
  }

  const repoName = config?.name || normalizeRepoName(repoRoot)
  const resolvedMaxRounds = normalizePositiveInteger(maxRounds, DEFAULT_LOOP_MAX_ROUNDS, "--max-rounds")
  const timeoutMs = normalizePositiveDuration(timeout, DEFAULT_LOOP_TIMEOUT_MS, "--timeout")
  const pollIntervalMs = normalizePositiveDuration(
    pollInterval,
    DEFAULT_LOOP_POLL_INTERVAL_MS,
    "--poll-interval",
  )
  const history = []
  const { handoffPath } = getConfiguredRepoPaths(repoRoot, config)
  const harnessProfile = await resolveActiveHarnessProfile(repoRoot, config)
  const loopPrompt = harnessProfile.loop.dispatchPrompt || LOOP_PROMPT
  let current = await readCurrentState(repoRoot)

  onEvent(`loop start: ${repoName}`)
  emitLoopBlock(onEvent, "loop context:", [
    `repo root: ${repoRoot}`,
    `handoff file: ${handoffPath}`,
    `task: ${current.task || "(none)"}`,
    `next action: ${current.nextAction || "(none)"}`,
  ])
  emitLoopBlock(onEvent, "loop config:", [
    `harness profile: ${harnessProfile.configuredId}`,
    `max rounds: ${resolvedMaxRounds}`,
    `timeout per round: ${formatLoopSeconds(timeoutMs)}`,
    `poll interval: ${formatLoopSeconds(pollIntervalMs)}`,
    `dispatch prompt: ${loopPrompt}`,
  ])
  onEvent(`current handoff: ${formatLoopState(current)}`)

  if (LOOP_TERMINAL_STATUSES.has(current.status)) {
    onEvent(`loop exit: handoff already ${current.status}`)
    return {
      repoName,
      repoRoot,
      status: "noop",
      stopReason: `Handoff already ${current.status}.`,
      initialCurrent: current,
      finalCurrent: current,
      history,
      roundsCompleted: 0,
      maxRounds: resolvedMaxRounds,
      dryRun,
    }
  }

  for (let round = 1; round <= resolvedMaxRounds; round += 1) {
    const agentName = getLoopActorForState(current)
    onEvent(`round ${round}/${resolvedMaxRounds}`)
    if (!agentName) {
      onEvent(`loop exit: no agent is mapped to handoff status "${current.status}"`)
      return {
        repoName,
        repoRoot,
        status: "failed",
        stopReason: `No agent mapped to handoff status "${current.status}".`,
        initialCurrent: history[0]?.before || current,
        finalCurrent: current,
        history,
        roundsCompleted: history.length,
        maxRounds: resolvedMaxRounds,
        dryRun,
      }
    }

    const before = current
    const beforeFingerprint = serializeCurrentState(before)
    const runner = resolveLoopRunner(agentName, config, repoRoot, { prompt: loopPrompt })
    const roundStartedAt = Date.now()
    emitLoopBlock(onEvent, "selected agent:", [
      `${agentName}`,
      `reason: ${describeLoopAgentReason(before)}`,
      `handoff snapshot: ${formatLoopState(before)}`,
    ])
    const delegationPacketSummaryLines = buildLoopDelegationPacketSummaryLines(before)
    if (delegationPacketSummaryLines.length > 0) {
      emitLoopBlock(onEvent, "delegation packet:", delegationPacketSummaryLines)
    }
    emitLoopBlock(onEvent, "runner selection:", [
      `mode: ${runner.type}${runner.fallback ? " (fallback)" : ""}`,
      `configured value: ${runner.configuredValue || "(none)"}`,
      `prompt: ${loopPrompt}`,
      runner.type === "cli" ? `command: ${runner.displayCommand}` : "",
    ])

    if (dryRun) {
      const eventLine =
        runner.type === "notify"
          ? `dry-run round ${round}: wait for ${agentName} (${runner.fallback ? "fallback notify" : "notify"} mode)`
          : `dry-run round ${round}: dispatch ${agentName}: ${runner.displayCommand}`
      onEvent(eventLine)
      history.push({
        round,
        agentName,
        runnerType: runner.type,
        command: runner.displayCommand,
        status: "dry-run",
        exitCode: null,
        before,
        after: before,
      })
      return {
        repoName,
        repoRoot,
        status: "dry-run",
        stopReason: "Dry run completed after the next dispatch decision.",
        initialCurrent: before,
        finalCurrent: before,
        history,
        roundsCompleted: history.length,
        maxRounds: resolvedMaxRounds,
        dryRun,
      }
    }

    if (runner.type === "notify") {
      const startedAt = formatIsoTimestamp()
      onEvent(
        `[${startedAt}] waiting for ${agentName} (${runner.fallback ? "fallback notify" : "notify"} mode)...`,
      )
      onEvent(`waiting budget: ${formatLoopSeconds(timeoutMs)}`)
      if (!dryRun) {
        const pushResult = await pushAgentPrompt(agentName, {
          repoName,
          taskDescription: current.task || "",
          prompt: loopPrompt,
        })
        onEvent(
          `inbox: wrote pending prompt → ${pushResult.inboxPath}${pushResult.notified ? " (notification sent)" : ""}`,
        )
      }
      const waitResult = await waitForHandoffChange(repoRoot, beforeFingerprint, {
        timeoutMs,
        pollIntervalMs,
      })
      const completedAt = formatIsoTimestamp()

      history.push({
        round,
        agentName,
        runnerType: "notify",
        command: "",
        status: waitResult.changed ? "completed" : "timed-out",
        exitCode: null,
        startedAt,
        completedAt,
        before,
        after: waitResult.current,
      })

      if (!waitResult.changed) {
        onEvent(`[${completedAt}] timeout waiting for ${agentName}`)
        onEvent(`final observed handoff: ${formatLoopState(waitResult.current)}`)
        return {
          repoName,
          repoRoot,
          status: "timed-out",
          stopReason: `Timed out waiting for ${agentName}.`,
          initialCurrent: history[0]?.before || before,
          finalCurrent: waitResult.current,
          history,
          roundsCompleted: history.length,
          maxRounds: resolvedMaxRounds,
          dryRun,
        }
      }

      onEvent(`[${completedAt}] detected handoff change from ${agentName}`)
      emitLoopTransition(onEvent, before, waitResult.current)
      current = waitResult.current
    } else {
      let dispatchResult
      try {
        dispatchResult = await executeLoopCliRunner(agentName, runner, {
          repoRoot,
          timeoutMs,
          onEvent,
        })
      } catch (error) {
        onEvent(`loop error: ${error.message}`)
        return {
          repoName,
          repoRoot,
          status: "failed",
          stopReason: error.message,
          initialCurrent: history[0]?.before || before,
          finalCurrent: before,
          history,
          roundsCompleted: history.length,
          maxRounds: resolvedMaxRounds,
          dryRun,
        }
      }

      emitLoopOutput(
        onEvent,
        dispatchResult.streamedStdout ? "agent stdout (unparsed):" : "agent stdout:",
        dispatchResult.stdout,
      )
      emitLoopOutput(
        onEvent,
        dispatchResult.streamedStderr ? "agent stderr (unparsed):" : "agent stderr:",
        dispatchResult.stderr,
      )

      if (dispatchResult.status !== "completed") {
        const failedCurrent = await readCurrentState(repoRoot)
        onEvent(`post-dispatch handoff: ${formatLoopState(failedCurrent)}`)
        history.push({
          round,
          agentName,
          runnerType: "cli",
          command: runner.displayCommand,
          status: dispatchResult.status,
          exitCode: dispatchResult.exitCode,
          startedAt: dispatchResult.startedAt,
          completedAt: dispatchResult.completedAt,
          before,
          after: failedCurrent,
        })
        return {
          repoName,
          repoRoot,
          status: dispatchResult.status,
          stopReason:
            dispatchResult.status === "timed-out"
              ? `Timed out running ${agentName}.`
              : `Runner failed for ${agentName}.`,
          initialCurrent: history[0]?.before || before,
          finalCurrent: failedCurrent,
          history,
          roundsCompleted: history.length,
          maxRounds: resolvedMaxRounds,
          dryRun,
        }
      }

      let nextCurrent = await readCurrentState(repoRoot)
      if (serializeCurrentState(nextCurrent) === beforeFingerprint) {
        const elapsedMs = Date.now() - roundStartedAt
        const remainingMs = Math.max(0, timeoutMs - elapsedMs)
        onEvent(
          `handoff unchanged after process exit; waiting up to ${formatLoopSeconds(remainingMs)} for an external update...`,
        )
        const waitResult = await waitForHandoffChange(repoRoot, beforeFingerprint, {
          timeoutMs: remainingMs,
          pollIntervalMs,
        })
        nextCurrent = waitResult.current
        if (!waitResult.changed) {
          onEvent(`no handoff change detected before timeout`)
          onEvent(`final observed handoff: ${formatLoopState(nextCurrent)}`)
          history.push({
            round,
            agentName,
            runnerType: "cli",
            command: runner.displayCommand,
            status: "timed-out",
            exitCode: dispatchResult.exitCode,
            startedAt: dispatchResult.startedAt,
            completedAt: formatIsoTimestamp(),
            before,
            after: nextCurrent,
          })
          return {
            repoName,
            repoRoot,
            status: "timed-out",
            stopReason: `Timed out waiting for ${agentName} to update the handoff.`,
            initialCurrent: history[0]?.before || before,
            finalCurrent: nextCurrent,
            history,
            roundsCompleted: history.length,
            maxRounds: resolvedMaxRounds,
            dryRun,
          }
        }
      }

      emitLoopTransition(onEvent, before, nextCurrent)
      history.push({
        round,
        agentName,
        runnerType: "cli",
        command: runner.displayCommand,
        status: "completed",
        exitCode: dispatchResult.exitCode,
        startedAt: dispatchResult.startedAt,
        completedAt: dispatchResult.completedAt,
        before,
        after: nextCurrent,
      })
      current = nextCurrent
    }

    if (LOOP_TERMINAL_STATUSES.has(current.status)) {
      onEvent(`loop exit: handoff reached ${current.status}`)
      return {
        repoName,
        repoRoot,
        status: "completed",
        stopReason: `Handoff reached ${current.status}.`,
        initialCurrent: history[0]?.before || current,
        finalCurrent: current,
        history,
        roundsCompleted: history.length,
        maxRounds: resolvedMaxRounds,
        dryRun,
      }
    }
  }

  onEvent(`loop exit: reached max rounds (${resolvedMaxRounds}) before the handoff resolved`)
  return {
    repoName,
    repoRoot,
    status: "max-rounds-exceeded",
    stopReason: `Reached max rounds (${resolvedMaxRounds}) before the handoff resolved.`,
    initialCurrent: history[0]?.before || current,
    finalCurrent: await readCurrentState(repoRoot),
    history,
    roundsCompleted: history.length,
    maxRounds: resolvedMaxRounds,
    dryRun,
  }
}

async function getRegisteredRepos() {
  const { registry } = await loadRegistry()
  return registry.repos
}

function parseLastUpdatedDate(lastUpdated) {
  if (!lastUpdated) {
    return null
  }

  const match = /(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?))?\s*$/.exec(lastUpdated)
  if (!match) {
    return null
  }

  const value = match[2] ? `${match[1]}T${match[2]}` : `${match[1]}T00:00:00.000Z`
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseStaleness(lastUpdated, now = new Date()) {
  const parsed = parseLastUpdatedDate(lastUpdated)
  if (!parsed) {
    return null
  }

  const msPerDay = 24 * 60 * 60 * 1000
  const ageDays = Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / msPerDay))

  return {
    ageDays,
    label: ageDays >= 3 ? `(stale: ${ageDays}d)` : "(fresh)",
    stale: ageDays >= 3,
  }
}

function countPreviousHandoffs(content) {
  const bounds = findSectionBounds(content, /^## Previous Handoffs.*$/)
  if (!bounds) {
    return 0
  }

  return bounds.text.split("\n").filter((line) => /^-\s+\d{4}-\d{2}-\d{2}\b/.test(line.trim())).length
}

function getMostRecentlyUpdatedState(states, fallback = { ...DEFAULT_CURRENT }) {
  let latestState = fallback
  let latestDate = getStateUpdatedDate(fallback)

  for (const state of states || []) {
    const stateDate = getStateUpdatedDate(state)
    if (!stateDate) {
      continue
    }
    if (!latestDate || stateDate.getTime() > latestDate.getTime()) {
      latestState = state
      latestDate = stateDate
    }
  }

  return latestState
}

function summarizeWatchdogRepair(repair) {
  if (!repair) {
    return ""
  }

  if (repair.type === "history-compact") {
    const laneLabel = repair.laneId ? `lane ${repair.laneId}` : "current handoff"
    return `${laneLabel}: archived ${repair.archivedCount}, kept ${repair.keptCount}`
  }

  if (repair.type === "release-stale-locks") {
    return `lane ${repair.laneId}: released ${repair.releasedCount} stale lock${repair.releasedCount === 1 ? "" : "s"}`
  }

  if (repair.type === "release-expired-locks") {
    return `lane ${repair.laneId}: released ${repair.releasedCount} expired lock${repair.releasedCount === 1 ? "" : "s"}`
  }

  return repair.summary || repair.type || "watchdog repair"
}

async function applyWatchdogRepairs(repoRoot, {
  config: providedConfig,
  keep = DEFAULT_HISTORY_KEEP,
  actorLabel = "btrain doctor",
} = {}) {
  const config = providedConfig || (await readProjectConfig(repoRoot))
  const repairs = []

  const compactionResults = await compactHandoffHistory(repoRoot, {
    config,
    keep,
    actorLabel,
  })
  for (const result of compactionResults) {
    if (result.archivedCount <= 0) {
      continue
    }
    repairs.push({
      type: "history-compact",
      laneId: result.laneId || "",
      archivedCount: result.archivedCount,
      keptCount: result.keptCount,
      archivePath: result.archivePath,
      handoffPath: result.handoffPath,
      summary: summarizeWatchdogRepair({
        type: "history-compact",
        laneId: result.laneId || "",
        archivedCount: result.archivedCount,
        keptCount: result.keptCount,
      }),
    })
  }

  const laneConfigs = getLaneConfigs(config)
  if (!laneConfigs) {
    return repairs
  }

  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  if (!(await pathExists(repoPaths.locksPath))) {
    return repairs
  }

  let registry = null
  try {
    registry = await readLockRegistry(repoRoot)
  } catch {
    return repairs
  }

  if (!Array.isArray(registry?.locks)) {
    return repairs
  }

  const laneStates = decorateLaneStates(await readAllLaneStates(repoRoot, config), registry.locks)
  for (const laneState of laneStates) {
    // 1. Stale lock release
    if (laneState.lockState === "stale" && laneState.lockPaths.length > 0) {
      const releasedPaths = [...laneState.lockPaths]
      await releaseLocks(repoRoot, laneState._laneId)
      await appendWorkflowEvent(repoRoot, config, {
        type: "watchdog-repair",
        actor: actorLabel,
        laneId: laneState._laneId,
        details: {
          repairType: "release-stale-locks",
          releasedCount: releasedPaths.length,
          releasedPaths,
          previousStatus: laneState.status,
        },
      })
      repairs.push({
        type: "release-stale-locks",
        laneId: laneState._laneId,
        releasedCount: releasedPaths.length,
        releasedPaths,
        previousStatus: laneState.status,
        summary: summarizeWatchdogRepair({
          type: "release-stale-locks",
          laneId: laneState._laneId,
          releasedCount: releasedPaths.length,
        }),
      })
    }

    // 2. TTL-based expired lock release
    const handoffCfg = getHandoffConfig(config)
    const laneLocks = registry.locks.filter((l) => l.lane === laneState._laneId)
    const expiredLocks = laneLocks.filter((l) => isLockExpired(l, handoffCfg.lockTtlMs))
    if (expiredLocks.length > 0 && laneState.lockState !== "stale") {
      const expiredPaths = expiredLocks.map((l) => l.path)
      await releaseLocks(repoRoot, laneState._laneId)
      await appendWorkflowEvent(repoRoot, config, {
        type: "watchdog-repair",
        actor: actorLabel,
        laneId: laneState._laneId,
        details: {
          repairType: "release-expired-locks",
          releasedCount: expiredLocks.length,
          releasedPaths: expiredPaths,
          ttlMs: handoffCfg.lockTtlMs,
          previousStatus: laneState.status,
        },
      })
      repairs.push({
        type: "release-expired-locks",
        laneId: laneState._laneId,
        releasedCount: expiredLocks.length,
        releasedPaths: expiredPaths,
        summary: `lane ${laneState._laneId}: released ${expiredLocks.length} expired lock${expiredLocks.length === 1 ? "" : "s"} (TTL ${Math.round(handoffCfg.lockTtlMs / 3600000)}h)`,
      })
    }

    // 3. Integrity checks (WS4)
    const integrityIssues = await analyzeLaneIntegrity(repoRoot, config, laneState)
    if (integrityIssues.length > 0) {
      // Use the first integrity issue as the primary repair reason
      const issue = integrityIssues[0]
      const repairMetadata = await resolveRepairAssignment(repoRoot, config, {
        laneId: laneState._laneId,
        existingCurrent: laneState,
        reasonCode: issue.reasonCode,
        actorLabel,
      })

      const laneHandoffPath = getLaneHandoffPath(repoRoot, config, laneState._laneId)
      await updateHandoff(repoRoot, {
        status: "repair-needed",
        ...repairMetadata,
        reasonCode: issue.reasonCode,
      }, {
        laneId: laneState._laneId,
        overrideHandoffPath: laneHandoffPath,
        config,
        actorLabel,
        eventType: "watchdog-repair",
        eventDetails: {
          repairType: issue.type,
          message: issue.message,
          allIssues: integrityIssues.map((i) => i.type),
        },
      })

      repairs.push({
        type: issue.type,
        laneId: laneState._laneId,
        summary: `lane ${laneState._laneId}: ${issue.type} repair (${issue.message})`,
      })
    }
  }

  return repairs
}

async function getManagedBlockTemplate(repoRoot = null, { includeFeedbackGuidance } = {}) {
  const templateContent = await loadTemplate("managed-block.md")
  const config = repoRoot ? await readProjectConfig(repoRoot) : null
  // If includeFeedbackGuidance is not explicitly passed, auto-detect from the repo
  let feedbackGuidance = includeFeedbackGuidance
  if (feedbackGuidance === undefined && repoRoot) {
    const repoPaths = getRepoPaths(repoRoot)
    feedbackGuidance = await pathExists(path.join(repoPaths.skillsPath, "feedback-triage"))
  }
  if (feedbackGuidance === undefined) {
    feedbackGuidance = true
  }
  const rendered = renderTemplate(
    templateContent,
    buildManagedBlockVariables(config, { includeFeedbackGuidance: feedbackGuidance }),
  )
  // Clean up consecutive blank lines from conditional template variables
  const cleaned = rendered.replace(/\n{3,}/g, "\n\n")
  return extractManagedBlock(cleaned) || cleaned.trim()
}

function hasTemplateDrift(content, managedTemplate) {
  const managedBlock = extractManagedBlock(content)
  if (!managedBlock) {
    return true
  }

  return managedBlock !== managedTemplate
}

async function detectTemplateDrift(repoRoot) {
  const repoPaths = getRepoPaths(repoRoot)
  const managedTemplate = await getManagedBlockTemplate(repoRoot)
  const drift = {
    agents: false,
    claude: false,
  }

  if (await pathExists(repoPaths.agentsPath)) {
    drift.agents = hasTemplateDrift(await readText(repoPaths.agentsPath), managedTemplate)
  } else {
    drift.agents = true
  }

  if (await pathExists(repoPaths.claudePath)) {
    drift.claude = hasTemplateDrift(await readText(repoPaths.claudePath), managedTemplate)
  } else {
    drift.claude = true
  }

  return {
    ...drift,
    any: drift.agents || drift.claude,
  }
}

async function registerRepo(repoPathInput) {
  const repoRoot = path.resolve(repoPathInput)
  const stats = await fs.stat(repoRoot)
  if (!stats.isDirectory()) {
    throw new BtrainError({
      message: `Not a directory: ${repoRoot}`,
      reason: "btrain register requires a path to an existing directory.",
      fix: `Verify the path exists and is a directory: ls -la ${repoRoot}`,
    })
  }

  const repoPaths = getRepoPaths(repoRoot)
  const hasProjectToml = await pathExists(repoPaths.projectTomlPath)
  const config = hasProjectToml ? await readProjectConfig(repoRoot) : null
  const configuredRepoPaths = getConfiguredRepoPaths(repoRoot, config)
  const hasHandoff = await pathExists(configuredRepoPaths.handoffPath)

  if (!hasProjectToml && !hasHandoff) {
    throw new BtrainError({
      message: "Repo is not bootstrapped enough to register.",
      reason: "Neither .btrain/project.toml nor a handoff file exists at this path.",
      fix: "Run `btrain init <repo-path>` to fully bootstrap the repo, or create `.btrain/project.toml` manually.",
    })
  }

  const repoName = config?.name || normalizeRepoName(repoRoot)
  const warnings = []

  if (!hasProjectToml) {
    warnings.push("Missing `.btrain/project.toml`.")
  }
  if (!hasHandoff) {
    warnings.push(`Missing handoff file: ${configuredRepoPaths.handoffPath}`)
  }
  if (!(await pathExists(repoPaths.agentsPath))) {
    warnings.push("Missing `AGENTS.md`.")
  }
  if (!(await pathExists(repoPaths.claudePath))) {
    warnings.push("Missing `CLAUDE.md`.")
  }

  const { registryPath, registry, homeDir } = await loadRegistry()
  const now = formatIsoTimestamp()
  upsertRepoEntry(registry, {
    name: repoName,
    path: repoRoot,
    project_config_path: repoPaths.projectTomlPath,
    handoff_path: configuredRepoPaths.handoffPath,
    registered_at: now,
    updated_at: now,
  })
  await saveRegistry(registryPath, registry)

  return {
    repoName,
    repoRoot,
    homeDir,
    registryPath,
    warnings,
  }
}

async function syncManagedFile(filePath, managedTemplate, { dryRun }) {
  if (!(await pathExists(filePath))) {
    return { path: filePath, status: "skipped", reason: "missing-file" }
  }

  const existingContent = await readText(filePath)
  const nextContent = replaceManagedBlock(existingContent, managedTemplate)

  if (nextContent === existingContent) {
    return { path: filePath, status: "unchanged" }
  }

  if (!dryRun) {
    await writeText(filePath, nextContent)
  }

  return { path: filePath, status: dryRun ? "would-update" : "updated" }
}

async function syncSkills({ repoRoot, skillName, overwrite = false } = {}) {
  const targetRepos = []

  if (repoRoot) {
    targetRepos.push({ name: normalizeRepoName(repoRoot), path: repoRoot })
  } else {
    targetRepos.push(...(await getRegisteredRepos()))
  }

  const results = []
  for (const repo of targetRepos) {
    const absoluteRepoRoot = path.resolve(repo.path)
    if (!(await pathExists(absoluteRepoRoot))) {
      results.push({
        name: repo.name,
        path: absoluteRepoRoot,
        status: "skipped",
        reason: "missing-repo",
      })
      continue
    }

    const repoPaths = getRepoPaths(absoluteRepoRoot)
    const [claude, agents] = await Promise.all([
      syncBundledSkills(repoPaths.skillsPath, {
        sourceSkillsDir: BUNDLED_SKILLS_DIR,
        skillName,
        overwrite,
      }),
      syncBundledSkills(repoPaths.agentSkillsPath, {
        sourceSkillsDir: BUNDLED_AGENT_SKILLS_DIR,
        skillName,
        overwrite,
      }),
    ])

    const copiedSkills = Array.from(new Set([
      ...claude.copiedSkills,
      ...agents.copiedSkills,
    ])).sort()

    results.push({
      name: repo.name,
      path: absoluteRepoRoot,
      copiedSkills,
      status: copiedSkills.length > 0 ? "updated" : "unchanged",
    })
  }

  return {
    results,
  }
}

async function syncTemplates({ repoRoot, dryRun = false } = {}) {
  const targetRepos = []

  if (repoRoot) {
    targetRepos.push({ name: normalizeRepoName(repoRoot), path: repoRoot })
  } else {
    targetRepos.push(...(await getRegisteredRepos()))
  }

  const results = []
  for (const repo of targetRepos) {
    const absoluteRepoRoot = path.resolve(repo.path)
    if (!(await pathExists(absoluteRepoRoot))) {
      results.push({
        name: repo.name,
        path: absoluteRepoRoot,
        files: [],
        status: "skipped",
        reason: "missing-repo",
      })
      continue
    }

    const repoPaths = getRepoPaths(absoluteRepoRoot)
    const managedTemplate = await getManagedBlockTemplate(absoluteRepoRoot)
    const fileResults = []
    for (const filePath of [repoPaths.agentsPath, repoPaths.claudePath]) {
      fileResults.push(await syncManagedFile(filePath, managedTemplate, { dryRun }))
    }

    results.push({
      name: repo.name || normalizeRepoName(absoluteRepoRoot),
      path: absoluteRepoRoot,
      files: fileResults,
      status: fileResults.some((result) => result.status === "updated" || result.status === "would-update")
        ? (dryRun ? "would-update" : "updated")
        : fileResults.some((result) => result.status === "skipped")
          ? "partial"
          : "unchanged",
    })
  }

  return {
    dryRun,
    results,
  }
}

async function listRepos() {
  return getRegisteredRepos()
}

async function getRepoStatus(repoRoot) {
  const config = await readProjectConfig(repoRoot)
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  const currentState = await readCurrentState(repoRoot)
  const repoName = config?.name || normalizeRepoName(repoRoot)
  const handoffContent = (await pathExists(repoPaths.handoffPath))
    ? await readText(repoPaths.handoffPath)
    : ""
  const staleness = parseStaleness(currentState.lastUpdated)
  const previousHandoffs = countPreviousHandoffs(handoffContent)
  const templateDrift = await detectTemplateDrift(repoRoot)
  const overrides = await listActiveOverrides(repoRoot)

  const status = {
    name: repoName,
    path: repoRoot,
    current: currentState,
    staleness,
    previousHandoffs,
    templateDrift,
    repurposeReady: [],
    overrides,
  }

  // Add lane info if enabled
  const laneConfigs = getLaneConfigs(config)
  if (laneConfigs) {
    status.locks = await listLocks(repoRoot)
    status.lanes = await attachLatestCgraphMetadataToStates(
      repoRoot,
      config,
      decorateLaneStates(await readAllLaneStates(repoRoot, config), status.locks),
    )
    status.current = getMostRecentlyUpdatedState(status.lanes, status.current)
    status.staleness = parseStaleness(status.current.lastUpdated)
    status.repurposeReady = status.lanes
      .filter((lane) => lane.repurposeReady)
      .map((lane) => ({
        laneId: lane._laneId,
        reason: lane.repurposeReason,
      }))
  } else {
    status.current = await attachLatestCgraphMetadataToState(repoRoot, config, currentState)
    const repurpose = classifyRepurposeReady(status.current)
    if (repurpose.ready) {
      status.repurposeReady.push({
        laneId: null,
        reason: repurpose.reason,
      })
    }
  }

  return status
}

async function getGitBranchName(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return ""
  }
}

async function collectStartupReadFirstPaths(repoRoot) {
  const results = []
  const candidates = [
    "AGENTS.md",
    "CLAUDE.md",
    ".btrain/project.toml",
    "README.md",
    "docs/architecture.md",
    "research/implementation_plan.md",
  ]

  for (const relativePath of candidates) {
    if (results.length >= 5) {
      break
    }

    if (await pathExists(path.join(repoRoot, relativePath))) {
      results.push(relativePath)
    }
  }

  const memoryDir = path.join(repoRoot, ".claude", "projects")
  if (results.length < 5 && (await pathExists(memoryDir))) {
    try {
      const entries = (await fs.readdir(memoryDir)).filter(Boolean).sort()
      for (const entry of entries) {
        const memoryPath = path.join(memoryDir, entry, "memory", "MEMORY.md")
        if (await pathExists(memoryPath)) {
          results.push(path.relative(repoRoot, memoryPath))
          break
        }
      }
    } catch {
      // Ignore missing or unreadable project memory directories.
    }
  }

  return results
}

function getStartupLaneRole(lane, agentName) {
  const normalizedAgent = String(agentName || "").trim().toLowerCase()
  if (!normalizedAgent) {
    return ""
  }

  const owner = String(lane?.owner || "").trim().toLowerCase()
  const reviewer = String(lane?.reviewer || "").trim().toLowerCase()
  const status = String(lane?.status || "").trim().toLowerCase()
  const activeOwnerStatuses = new Set(["in-progress", "changes-requested", "repair-needed"])

  if (owner === normalizedAgent && activeOwnerStatuses.has(status)) {
    return "writer"
  }
  if (reviewer === normalizedAgent && status === "needs-review") {
    return "reviewer"
  }
  if (owner === normalizedAgent && status === "needs-review") {
    return "writer-waiting"
  }

  return ""
}

function summarizeStartupLane(lane, role = "") {
  const lockPaths = Array.isArray(lane?.lockPaths)
    ? lane.lockPaths
    : Array.isArray(lane?.lockedFiles)
      ? lane.lockedFiles
      : []

  return {
    laneId: lane?._laneId || "",
    task: lane?.task || "(none)",
    status: lane?.status || "unknown",
    owner: lane?.owner || "",
    reviewer: lane?.reviewer || "",
    role: role || "",
    nextAction: lane?.nextAction || "",
    lockPaths: lockPaths.filter(Boolean),
  }
}

function buildStartupFocusLanes(handoff) {
  const lanes = Array.isArray(handoff?.lanes)
    ? handoff.lanes
    : handoff?.current
      ? [{ ...handoff.current, _laneId: handoff.current._laneId || "" }]
      : []

  const agentName = handoff?.agentCheck?.status === "verified" ? handoff.agentCheck.agentName : ""
  const roleMatched = lanes
    .map((lane) => {
      const role = getStartupLaneRole(lane, agentName)
      return role ? summarizeStartupLane(lane, role) : null
    })
    .filter(Boolean)

  if (roleMatched.length > 0) {
    return roleMatched.slice(0, 3)
  }

  const activeStatuses = new Set(["in-progress", "needs-review", "changes-requested", "repair-needed"])
  const activeLanes = lanes
    .filter((lane) => activeStatuses.has(String(lane?.status || "").trim().toLowerCase()))
    .map((lane) => summarizeStartupLane(lane, "shared"))

  return activeLanes.slice(0, 3)
}

function buildStartupCommands(handoff, focusLanes) {
  const commands = []
  const primaryLane = focusLanes[0]

  if (primaryLane?.role === "writer" && primaryLane.laneId && primaryLane.owner) {
    commands.push(
      `btrain handoff update --lane ${primaryLane.laneId} --status needs-review --actor "${primaryLane.owner}"`,
    )
  } else if (primaryLane?.role === "reviewer" && primaryLane.laneId) {
    const reviewer = primaryLane.reviewer || "<reviewer>"
    commands.push(`btrain handoff resolve --lane ${primaryLane.laneId} --summary "..." --actor "${reviewer}"`)
  } else if (focusLanes.length === 0) {
    if (Array.isArray(handoff?.lanes) && handoff.lanes.length > 0) {
      commands.push('btrain handoff claim --lane <id> --task "..." --owner "..." --reviewer "..." --files "..."')
    } else {
      commands.push('btrain handoff claim --task "..." --owner "..." --reviewer "..."')
    }
  }

  commands.push(
    "btrain handoff",
    "btrain locks",
    "btrain harness list",
    "btrain go",
    "btrain doctor",
  )

  return commands
}

async function resolveStartupHarnessSummary(repoRoot, config) {
  const harnessConfig = getHarnessConfig(config)

  try {
    const profile = await resolveActiveHarnessProfile(repoRoot, config)
    return {
      activeProfile: harnessConfig.activeProfile,
      dispatchPrompt: profile.loop?.dispatchPrompt || FALLBACK_LOOP_DISPATCH_PROMPT,
      error: "",
    }
  } catch (error) {
    return {
      activeProfile: harnessConfig.activeProfile,
      dispatchPrompt: "",
      error: error?.message || "Harness profile could not be loaded.",
    }
  }
}

async function getStartupSnapshot(repoRoot) {
  const config = await readProjectConfig(repoRoot)
  if (!config) {
    throw new BtrainError({
      message: "Repo is not bootstrapped enough for `btrain startup`.",
      reason: "Missing `.btrain/project.toml`.",
      fix: "Run `btrain init .` or pass --repo to a bootstrapped repo.",
    })
  }

  const handoff = await checkHandoff(repoRoot)
  const laneConfigs = getLaneConfigs(config)
  const activeAgents = Array.isArray(config?.agents?.active) ? config.agents.active : []
  const dirtyPaths = await listGitStatusPaths(repoRoot)
  const harness = await resolveStartupHarnessSummary(repoRoot, config)
  const cgraph = await getStartupCgraphSummary(repoRoot, config)
  const focusLanes = buildStartupFocusLanes(handoff)

  return {
    repoName: handoff.repoName,
    repoRoot,
    agentCheck: handoff.agentCheck,
    activeAgents,
    laneIds: laneConfigs ? laneConfigs.map((lane) => lane.id) : [],
    branch: await getGitBranchName(repoRoot),
    dirtyPaths,
    harness,
    cgraph,
    readFirstPaths: await collectStartupReadFirstPaths(repoRoot),
    focusLanes,
    commands: buildStartupCommands(handoff, focusLanes),
    note: "Do not read .claude/collab/HANDOFF_*.md directly — always use the CLI.",
  }
}

async function getStatus({ repoRoot } = {}) {
  if (repoRoot) {
    return [await getRepoStatus(repoRoot)]
  }

  const repos = await getRegisteredRepos()
  const statuses = []
  for (const repo of repos) {
    if (!(await pathExists(repo.path))) {
      statuses.push({
        name: repo.name,
        path: repo.path,
        current: {
          ...DEFAULT_CURRENT,
          status: "missing",
          nextAction: "Run `btrain doctor` to inspect this stale registry entry.",
        },
        staleness: null,
        previousHandoffs: 0,
        templateDrift: { agents: true, claude: true, any: true },
      })
      continue
    }

    statuses.push(await getRepoStatus(repo.path))
  }

  return statuses
}

function checkFeedbackLogHealth(content) {
  const warnings = []
  const entries = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = /^## (FB-\w+-\d+):/.exec(lines[i])
    if (headerMatch) {
      entries.push({ id: headerMatch[1], startLine: i })
    }
  }

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx]
    const endLine = idx + 1 < entries.length ? entries[idx + 1].startLine : lines.length
    const entryText = lines.slice(entry.startLine, endLine).join("\n")

    if (!entryText.includes("**Category:**")) {
      warnings.push(`Feedback ${entry.id}: missing Category field.`)
    }

    const statusMatch = entryText.match(/\*\*Status:\*\*\s*(\S+)/)
    if (!statusMatch) {
      warnings.push(`Feedback ${entry.id}: missing Status field.`)
      continue
    }

    const status = statusMatch[1]
    if (status === "new" || status === "triaged") {
      const reportedMatch = entryText.match(/\*\*Reported:\*\*\s*(\d{4}-\d{2}-\d{2})/)
      if (reportedMatch) {
        const daysSince = (Date.now() - new Date(reportedMatch[1]).getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince > 7) {
          warnings.push(`Feedback ${entry.id} has been \`${status}\` for ${Math.floor(daysSince)} days.`)
        }
      }
    }
  }

  return warnings
}

async function doctorRepo(repoRoot, { repair = false, skipFeedback = false } = {}) {
  const issues = []
  const warnings = []
  const repurposeReady = []
  const managedTemplate = await getManagedBlockTemplate(repoRoot)
  const config = await readProjectConfig(repoRoot)
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  const overrides = await listActiveOverrides(repoRoot)
  const repairs = repair ? await applyWatchdogRepairs(repoRoot, { config, actorLabel: "btrain doctor" }) : []
  const cgraph = await getDoctorCgraphSummary(repoRoot, config)

  if (!(await pathExists(repoRoot))) {
    issues.push(`Repo path is missing: ${repoRoot}`)
    return {
      repoRoot,
      healthy: false,
      issues,
      warnings,
    }
  }

  if (!(await pathExists(repoPaths.projectTomlPath))) {
    issues.push("Missing `.btrain/project.toml`.")
  } else {
    const mode = normalizeReviewMode(config?.default_review_mode) || "manual"
    if (!SUPPORTED_REVIEW_MODES.has(mode)) {
      warnings.push(`\`.btrain/project.toml\` sets unsupported review mode "${mode}".`)
    }
  }

  if (!(await pathExists(repoPaths.handoffPath))) {
    issues.push(`Missing handoff file: ${repoPaths.handoffPath}`)
  }

  if (!(await pathExists(repoPaths.agentsPath))) {
    issues.push("Missing `AGENTS.md`.")
  } else {
    const content = await readText(repoPaths.agentsPath)
    if (!content.includes(MANAGED_START)) {
      warnings.push("`AGENTS.md` is missing the managed btrain block.")
    } else if (hasTemplateDrift(content, managedTemplate)) {
      warnings.push("`AGENTS.md` managed block differs from template. Run `btrain sync-templates`.")
    }
  }

  if (!(await pathExists(repoPaths.claudePath))) {
    issues.push("Missing `CLAUDE.md`.")
  } else {
    const content = await readText(repoPaths.claudePath)
    if (!content.includes(MANAGED_START)) {
      warnings.push("`CLAUDE.md` is missing the managed btrain block.")
    } else if (hasTemplateDrift(content, managedTemplate)) {
      warnings.push("`CLAUDE.md` managed block differs from template. Run `btrain sync-templates`.")
    }
  }

  if (await pathExists(repoPaths.handoffPath)) {
    const handoffContent = await readText(repoPaths.handoffPath)
    if (!findSectionBounds(handoffContent, "Current")) {
      warnings.push("`" + path.basename(repoPaths.handoffPath) + "` is missing a `## Current` section.")
    }
  }

  if (overrides.length > 0) {
    warnings.push(`Active audited overrides: ${overrides.map((record) => formatOverrideSummary(record)).join(", ")}`)
  }

  // Feedback log monitoring
  const feedbackCfg = getFeedbackConfig(config)
  if (feedbackCfg.enabled && !skipFeedback) {
    if (await pathExists(repoPaths.feedbackLogPath)) {
      const feedbackContent = await readText(repoPaths.feedbackLogPath)
      for (const issue of checkFeedbackLogHealth(feedbackContent)) {
        warnings.push(issue)
      }
    } else if (await pathExists(repoPaths.projectTomlPath)) {
      warnings.push("Missing `.claude/collab/FEEDBACK_LOG.md`. Run `btrain init .` to create it.")
    }
  }

  // Lane-specific checks
  const laneConfigs = getLaneConfigs(config)
  if (laneConfigs) {
    for (const lane of laneConfigs) {
      const laneHandoffPath = path.isAbsolute(lane.handoffPath)
        ? lane.handoffPath
        : path.resolve(repoRoot, lane.handoffPath)

      if (!(await pathExists(laneHandoffPath))) {
        issues.push(`Missing lane ${lane.id} handoff file: ${laneHandoffPath}. Run \`btrain init .\`.`)
      } else {
        const content = await readText(laneHandoffPath)
        if (!findSectionBounds(content, "Current")) {
          warnings.push(`Lane ${lane.id} handoff is missing a \`## Current\` section.`)
        }
      }
    }

    // Check locks.json
    if (!(await pathExists(repoPaths.locksPath))) {
      warnings.push("Missing `locks.json`. Run `btrain init .` to create it.")
    } else {
      try {
        const registry = await readLockRegistry(repoRoot)
        if (!Array.isArray(registry.locks)) {
          issues.push("`locks.json` is malformed: `locks` is not an array.")
        } else {
          const laneStates = decorateLaneStates(await readAllLaneStates(repoRoot, config), registry.locks)
          for (const laneState of laneStates) {
            // Integrity issues (WS4)
            const integrityIssues = await analyzeLaneIntegrity(repoRoot, config, laneState)
            for (const issue of integrityIssues) {
              issues.push(issue.message)
            }

            if (laneState.repurposeReady) {
              repurposeReady.push({
                laneId: laneState._laneId,
                reason: laneState.repurposeReason,
              })
            }
          }
          for (const laneState of laneStates) {
            if (laneState.status === "repair-needed") {
              const repairOwner = laneState.repairOwner || laneState.owner || "the responsible actor"
              if (laneState.repairEscalation === "human") {
                warnings.push(
                  `Lane ${laneState._laneId} is \`repair-needed\` and now requires human escalation after ${Number(laneState.repairAttempts) || 1} repair attempt${Number(laneState.repairAttempts) === 1 ? "" : "s"}. Last responsible actor: ${repairOwner}.`,
                )
              } else {
                warnings.push(`Lane ${laneState._laneId} is \`repair-needed\` and assigned to ${repairOwner}.`)
              }
            }

            if (laneState.lockState === "missing") {
              warnings.push(
                `Lane ${laneState._laneId} is \`${laneState.status}\` but has no active locks. Run \`btrain handoff update --lane ${laneState._laneId} --files "..." --actor "${laneState.owner || "owner"}"\`.`,
              )
            }

            if (laneState.lockState === "mismatch") {
              warnings.push(
                `Lane ${laneState._laneId} handoff files (\`${formatLockedPaths(laneState.handoffPaths)}\`) do not match locks.json (\`${formatLockedPaths(laneState.lockPaths)}\`). Run \`btrain handoff update --lane ${laneState._laneId} --files "..." --actor "${laneState.owner || "owner"}"\`.`,
              )
            }

            if (laneState.lockState === "stale") {
              warnings.push(
                `Stale lock: lane ${laneState._laneId} has \`${formatLockedPaths(laneState.lockPaths)}\` locked while status is \`${laneState.status}\`. Run \`btrain locks release-lane --lane ${laneState._laneId}\` or claim the lane again.`,
              )
            }

            // TTL-expired lock warning
            const handoffCfg = getHandoffConfig(config)
            const laneLocks = registry.locks.filter((l) => l.lane === laneState._laneId)
            const expiredLocks = laneLocks.filter((l) => isLockExpired(l, handoffCfg.lockTtlMs))
            if (expiredLocks.length > 0) {
              const ttlHours = Math.round(handoffCfg.lockTtlMs / 3600000)
              warnings.push(
                `Lane ${laneState._laneId} has ${expiredLocks.length} lock${expiredLocks.length === 1 ? "" : "s"} older than ${ttlHours}h TTL. Run \`btrain doctor --repair\` to auto-release.`,
              )
            }
          }

          // Check for cross-lane overlapping locks
          const laneIds = [...new Set(registry.locks.map((l) => l.lane))]
          for (const laneId of laneIds) {
            const otherLocks = registry.locks.filter((l) => l.lane !== laneId)
            const thisLaneLocks = registry.locks.filter((l) => l.lane === laneId)
            for (const lock of thisLaneLocks) {
              const conflicts = checkLockConflicts(
                { locks: otherLocks },
                "__check__",
                [lock.path],
              )
              if (conflicts.length > 0) {
                warnings.push(
                  `Lock overlap: lane ${lock.lane} (\`${lock.path}\`) conflicts with lane ${conflicts[0].lockedBy} (\`${conflicts[0].path}\`).`,
                )
              }
            }
          }
        }
      } catch {
        issues.push("`locks.json` is not valid JSON.")
      }
    }
  } else {
    const current = await readCurrentState(repoRoot)
    if (current.status === "repair-needed") {
      const repairOwner = current.repairOwner || current.owner || "the responsible actor"
      if (current.repairEscalation === "human") {
        warnings.push(
          `Current handoff is \`repair-needed\` and now requires human escalation after ${Number(current.repairAttempts) || 1} repair attempt${Number(current.repairAttempts) === 1 ? "" : "s"}. Last responsible actor: ${repairOwner}.`,
        )
      } else {
        warnings.push(`Current handoff is \`repair-needed\` and assigned to ${repairOwner}.`)
      }
    }

    const repurpose = classifyRepurposeReady(current)
    if (repurpose.ready) {
      repurposeReady.push({
        laneId: null,
        reason: repurpose.reason,
      })
    }
  }

  return {
    repoRoot,
    healthy: issues.length === 0,
    issues,
    warnings,
    cgraph,
    repurposeReady,
    overrides,
    repairs,
  }
}

async function doctor({ repoRoot, repair = false, skipFeedback = false } = {}) {
  if (repoRoot) {
    return [await doctorRepo(repoRoot, { repair, skipFeedback })]
  }

  const repos = await getRegisteredRepos()
  const results = []

  for (const repo of repos) {
    if (!(await pathExists(repo.path))) {
      results.push({
        repoRoot: repo.path,
        healthy: false,
        issues: [`Stale registry entry: repo path is missing (${repo.path}).`],
        warnings: [],
      })
      continue
    }

    results.push(await doctorRepo(repo.path, { repair, skipFeedback }))
  }

  return results
}

export {
  BtrainError,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_SPILL_NEXT_CHARS,
  HANDOFF_NOTES_DIRNAME,
  TASK_ARTIFACT_ENVELOPE_VERSION,
  acquireLocks,
  buildCurrentSection,
  buildLaneGuidance,
  buildTaskArtifactEnvelope,
  normalizePrNumber,
  parseCurrentSection,
  checkHandoff,
  computeHandoffStateHash,
  extractSpillPathFromNextAction,
  readSpilledNextActionBody,
  resolveSpillThreshold,
  pushAgentPrompt,
  checkLockConflicts,
  claimHandoff,
  compactHandoffHistory,
  consumeOverride,
  createEmptyTaskArtifactEnvelope,
  doctor,
  findAvailableLane,
  findRepoRoot,
  forceReleaseLock,
  getBrainTrainHome,
  getLaneConfigs,
  getRepoPaths,
  getReviewStatus,
  getPrFlowConfig,
  getStartupSnapshot,
  getStatus,
  grantOverride,
  initRepo,
  installGitHooks,
  installPreCommitHook,
  installPrePushHook,
  isLanesEnabled,
  isLockExpired,
  listActiveOverrides,
  listLocks,
  listRepos,
  normalizeTaskArtifactEnvelope,
  parseCsvList,
  readAllLaneStates,
  readLockRegistry,
  readProjectConfig,
  registerRepo,
  releaseLocks,
  requestChangesHandoff,
  runPush,
  patchHandoff,
  resolveHandoff,
  resolveRepoRoot,
  runReview,
  runLoop,
  syncActiveAgents,
  syncSkills,
  syncTemplates,
  withFileLock,
}
