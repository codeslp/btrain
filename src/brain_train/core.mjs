import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const MANAGED_START = "<!-- btrain:managed:start -->"
const MANAGED_END = "<!-- btrain:managed:end -->"

const DEFAULT_CURRENT = {
  task: "",
  owner: "",
  reviewer: "",
  status: "idle",
  reviewMode: "manual",
  lockedFiles: [],
  nextAction: "",
  base: "",
  lastUpdated: "",
}

const execFileAsync = promisify(execFile)
const CORE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PARALLEL_REVIEW_SCRIPT = path.resolve(CORE_DIR, "..", "..", "scripts", "option_a_review.py")
const BUNDLED_SKILLS_DIR = path.resolve(CORE_DIR, "..", "..", ".claude", "skills")
const EXCLUDED_BUNDLED_SKILLS = new Set(["create-multi-speaker-static-recordings-using-tts"])
const SUPPORTED_REVIEW_MODES = new Set(["manual", "parallel", "hybrid"])
const DEFAULT_HANDOFF_RELATIVE_PATH = ".claude/collab/HANDOFF_A.md"
const LOCKS_FILENAME = "locks.json"
const DEFAULT_COLLABORATION_AGENT_COUNT = 2
const DEFAULT_LANES_PER_AGENT = 2
const ACTIVE_LANE_STATUSES = new Set(["in-progress", "needs-review"])
const DEFAULT_LOOP_MAX_ROUNDS = 10
const DEFAULT_LOOP_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_LOOP_POLL_INTERVAL_MS = 2 * 1000
const LOOP_PROMPT = "bth"
const LOOP_TERMINAL_STATUSES = new Set(["resolved", "idle"])
const MAX_LOOP_LOG_OUTPUT_LINES = 40
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

async function readText(targetPath) {
  return fs.readFile(targetPath, "utf8")
}

async function writeText(targetPath, content) {
  await ensureDir(path.dirname(targetPath))
  await fs.writeFile(targetPath, content, "utf8")
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
    throw new Error(`Could not parse gitdir from ${gitEntryPath}`)
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

const HOOK_MARKER = "# btrain:pre-commit-hook"

function renderPreCommitHook() {
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Blocks commits when any HANDOFF is in 'needs-review' and non-handoff files are staged.",
    "# Installed by: btrain init --hooks",
    "# Bypass with: git commit --no-verify",
    "",
    'for HANDOFF in .claude/collab/HANDOFF*.md; do',
    '  if [ -f "$HANDOFF" ]; then',
    '    STATUS=$(grep -m1 "^Status:" "$HANDOFF" | sed \'s/^Status:[[:space:]]*//\' | sed \'s/[[:space:]]*$//\')',
    '    if [ "$STATUS" = "needs-review" ]; then',
    '      STAGED=$(git diff --cached --name-only)',
    '      NON_HANDOFF=$(echo "$STAGED" | grep -v "^\\.claude/collab/HANDOFF")',
    '      if [ -n "$NON_HANDOFF" ]; then',
    '        echo ""',
    "        echo \"btrain: blocked — $HANDOFF status is 'needs-review'.\"",
    '        echo "Only the peer reviewer should be committing right now."',
    '        echo ""',
    '        echo "Staged non-handoff files:"',
    '        echo "$NON_HANDOFF" | sed \'s/^/  /\'',
    '        echo ""',
    '        echo "To bypass: git commit --no-verify"',
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
    throw new Error(`Invalid lane index: ${index}`)
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

function getLaneConfigs(config) {
  const lanes = config?.lanes
  if (!lanes || lanes.enabled === false) {
    return null
  }

  // Discover lane IDs dynamically from config keys (excluding reserved keys)
  const reservedKeys = new Set(["enabled", "per_agent"])
  const configuredIds = Object.keys(lanes)
    .filter((key) => !reservedKeys.has(key))
    .sort(compareLaneIds)

  // Fall back to the configured collaborator count and lanes-per-agent setting.
  const laneIds = configuredIds.length > 0 ? configuredIds : getDerivedLaneIds(config)

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
    throw new Error(`Unknown lane: ${laneId}. Available lanes: ${laneConfigs.map((l) => l.id).join(", ")}`)
  }

  const configuredPath = lane.handoffPath
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(repoRoot, configuredPath)
}

async function readLaneState(repoRoot, config, laneId) {
  const handoffPath = getLaneHandoffPath(repoRoot, config, laneId)
  if (!handoffPath || !(await pathExists(handoffPath))) {
    return { ...DEFAULT_CURRENT, _laneId: laneId }
  }

  const content = await readText(handoffPath)
  return { ...parseCurrentSection(content), _laneId: laneId }
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

  const resolved = laneStates.find((s) => s.status === "resolved")
  if (resolved) return resolved._laneId

  return null
}

function isLaneActiveStatus(status) {
  return ACTIVE_LANE_STATUSES.has(status)
}

function normalizePathList(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).filter(Boolean))].sort()
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

async function acquireLocks(repoRoot, laneId, owner, files) {
  if (!files || files.length === 0) return []

  const registry = await readLockRegistry(repoRoot)
  const conflicts = checkLockConflicts(registry, laneId, files)

  if (conflicts.length > 0) {
    const conflictMessages = conflicts.map(
      (c) => `  ${c.file} — locked by lane ${c.lockedBy} (${c.owner}): ${c.path}`,
    )
    throw new Error(`File lock conflict:\n${conflictMessages.join("\n")}`)
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
}

async function releaseLocks(repoRoot, laneId) {
  const registry = await readLockRegistry(repoRoot)
  const released = registry.locks.filter((lock) => lock.lane === laneId)
  registry.locks = registry.locks.filter((lock) => lock.lane !== laneId)
  await writeLockRegistry(repoRoot, registry)
  return released
}

async function listLocks(repoRoot) {
  const registry = await readLockRegistry(repoRoot)
  return registry.locks
}

async function forceReleaseLock(repoRoot, lockPath) {
  const registry = await readLockRegistry(repoRoot)
  const before = registry.locks.length
  registry.locks = registry.locks.filter((lock) => lock.path !== lockPath)
  await writeLockRegistry(repoRoot, registry)
  return before - registry.locks.length
}

function getLaneLocks(locks, laneId) {
  return (locks || []).filter((lock) => lock.lane === laneId)
}

function formatLockedPaths(paths) {
  const normalized = normalizePathList(paths)
  return normalized.length > 0 ? normalized.join(", ") : "(none)"
}

function buildLaneLockState(current, laneLocks) {
  const handoffPaths = normalizePathList(current.lockedFiles)
  const registryPaths = normalizePathList(laneLocks.map((lock) => lock.path))

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

function decorateLaneState(current, laneLocks) {
  return {
    ...current,
    ...buildLaneLockState(current, laneLocks),
  }
}

function decorateLaneStates(laneStates, locks) {
  return (laneStates || []).map((laneState) => decorateLaneState(laneState, getLaneLocks(locks, laneState._laneId)))
}

async function installPreCommitHook(repoRoot) {
  const gitHooksDir = await resolveGitHooksDir(repoRoot)
  if (!gitHooksDir) {
    return { installed: false, reason: "not-a-git-repo" }
  }

  const hookPath = path.join(gitHooksDir, "pre-commit")
  await ensureDir(gitHooksDir)

  if (await pathExists(hookPath)) {
    const existing = await readText(hookPath)
    if (existing.includes(HOOK_MARKER)) {
      await writeText(hookPath, renderPreCommitHook())
      await fs.chmod(hookPath, 0o755)
      return { installed: true, reason: "updated" }
    }
    return { installed: false, reason: "existing-hook" }
  }

  await writeText(hookPath, renderPreCommitHook())
  await fs.chmod(hookPath, 0o755)
  return { installed: true, reason: "created" }
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
    projectTomlPath: path.join(repoRoot, ".btrain", "project.toml"),
    reviewsDir: path.join(repoRoot, ".btrain", "reviews"),
    locksPath: path.join(repoRoot, ".btrain", LOCKS_FILENAME),
    handoffPath: path.resolve(repoRoot, DEFAULT_HANDOFF_RELATIVE_PATH),
    agentsPath: path.join(repoRoot, "AGENTS.md"),
    claudePath: path.join(repoRoot, "CLAUDE.md"),
    skillsPath: path.join(repoRoot, ".claude", "skills"),
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

function buildManagedBlockVariables(config) {
  const collaborators = getCollaborationAgentNames(config)
  const laneIds = (getLaneConfigs(config) || getDerivedLaneIds(config)).map((lane) => lane.id || lane)
  const laneExamples = laneIds.slice(0, Math.min(laneIds.length, 6))
  const lanesPerAgent = getLanesPerAgent(config)

  return {
    activeAgentsSummary:
      collaborators.length > 0
        ? formatInlineCodeList(collaborators)
        : 'not configured yet. Add `active = ["Agent A", "Agent B"]` under `[agents]`.',
    laneSummary: `${laneIds.length} lane(s) (${lanesPerAgent} per collaborating agent): ${formatInlineCodeList(laneIds)}`,
    laneExamples: formatInlineCodeList(laneExamples),
  }
}

const MANAGED_BLOCK_TEMPLATE = [
  MANAGED_START,
  "## Brain Train Workflow",
  "",
  "This repo uses the `btrain` collaboration workflow.",
  "",
  "- **Always use CLI commands** (`btrain handoff`, `handoff claim`, `handoff update`, `handoff resolve`) to read and update handoff state. Do not read or edit `HANDOFF_*.md` files directly.",
  "- When handing work to a reviewer, always fill the structured handoff fields: `Base`, `Pre-flight review`, `Files changed`, `Verification run`, `Remaining gaps`, `Why this was done`, and `Specific review asks`.",
  "- If the repo provides a `pre-handoff` skill, run it immediately before `btrain handoff update --status needs-review`.",
  "- Run `btrain handoff` before acting so btrain can verify the current agent and tell you whose turn it is.",
  "- Before editing, do a short pre-flight review of the locked files, nearby diff, and likely risk areas so you start from known problems.",
  "- Run `btrain status` or `btrain doctor` if the local workflow files look stale.",
  "- Repo config lives at `.btrain/project.toml`.",
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
  "- When your lane is done, hand it to a peer reviewer while you continue on other work.",
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

  "pre-commit-hook.sh": renderPreCommitHook(),
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

async function copyMissingTree(sourcePath, targetPath) {
  const sourceStats = await fs.lstat(sourcePath)
  if (sourceStats.isSymbolicLink()) {
    return copyMissingTree(await fs.realpath(sourcePath), targetPath)
  }

  if (sourceStats.isDirectory()) {
    await ensureDir(targetPath)
    const entries = await fs.readdir(sourcePath)
    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
      await copyMissingTree(path.join(sourcePath, entry), path.join(targetPath, entry))
    }
    return
  }

  if (await pathExists(targetPath)) {
    return
  }

  await ensureDir(path.dirname(targetPath))
  await fs.copyFile(sourcePath, targetPath)
  await fs.chmod(targetPath, sourceStats.mode)
}

async function syncBundledSkills(targetSkillsPath) {
  if (!(await pathExists(BUNDLED_SKILLS_DIR))) {
    return {
      copiedSkills: [],
      skippedSkills: [],
      skippedReason: "bundle-missing",
    }
  }

  if (path.resolve(BUNDLED_SKILLS_DIR) === path.resolve(targetSkillsPath)) {
    return {
      copiedSkills: [],
      skippedSkills: [],
      skippedReason: "self",
    }
  }

  await ensureDir(targetSkillsPath)

  const copiedSkills = []
  const skippedSkills = []
  const sourceEntries = await fs.readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true })

  for (const entry of sourceEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue
    }

    if (EXCLUDED_BUNDLED_SKILLS.has(entry.name)) {
      skippedSkills.push(entry.name)
      continue
    }

    const sourcePath = path.join(BUNDLED_SKILLS_DIR, entry.name)
    const targetPath = path.join(targetSkillsPath, entry.name)
    const targetExisted = await pathExists(targetPath)
    await copyMissingTree(sourcePath, targetPath)
    if (!targetExisted) {
      copiedSkills.push(entry.name)
    }
  }

  return {
    copiedSkills,
    skippedSkills,
    skippedReason: "",
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
    throw new Error(`Not a directory: ${repoRoot}`)
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
  const managedBlock = await getManagedBlockTemplate(repoRoot)
  const instructionTemplateVars = {
    roleLabel: "agent",
    ...buildManagedBlockVariables(config),
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
      : renderTemplate(instructionTemplate, { roleLabel: "Claude", ...buildManagedBlockVariables(config) }),
  )

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

  const bundledSkillsResult = shouldScaffoldBundledSkills
    ? await syncBundledSkills(repoPaths.skillsPath)
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
    hookResult = await installPreCommitHook(repoRoot)
  }

  return {
    repoName,
    repoRoot,
    homeDir,
    registryPath,
    repoPaths,
    hookResult,
    bundledSkillsResult,
  }
}

async function syncActiveAgents(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  if (!config) {
    throw new Error("`btrain agents` requires an initialized repo. Run `btrain init <repo-path>` first.")
  }

  const requestedAgents = normalizeStringList(options.agent)
  if (requestedAgents.length === 0) {
    throw new Error("`btrain agents` requires at least one `--agent <name>`.")
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
    throw new Error("Could not find a bootstrapped repo. Run `btrain init /path/to/repo` first or pass `--repo`.")
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
    `Review Mode: ${merged.reviewMode || ""}`,
    `Locked Files: ${lockedFiles}`,
    `Next Action: ${merged.nextAction || ""}`,
    `Base: ${merged.base || ""}`,
    `Last Updated: ${merged.lastUpdated || ""}`,
  ]

  if (laneId) {
    lines.splice(2, 0, `Lane: ${laneId}`)
  }

  return lines.join("\n")
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
    "review mode": "reviewMode",
    "locked files": "lockedFiles",
    "next action": "nextAction",
    base: "base",
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

    current[mappedKey] = mappedKey === "lockedFiles" ? parseCsvList(value) : value
  }

  return current
}

async function readCurrentState(repoRoot) {
  const config = await readProjectConfig(repoRoot)
  const { handoffPath } = getConfiguredRepoPaths(repoRoot, config)
  if (!(await pathExists(handoffPath))) {
    return { ...DEFAULT_CURRENT }
  }

  const content = await readText(handoffPath)
  return parseCurrentSection(content)
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

function appendPreviousHandoffEntry(content, entry) {
  const headingMatcher = /^## Previous Handoffs.*$/
  const bounds = findSectionBounds(content, headingMatcher)

  if (!bounds) {
    return `${content.trimEnd()}\n\n## Previous Handoffs\n\n${entry}\n`
  }

  const lines = bounds.text.split("\n")
  const headingLine = lines[0] || "## Previous Handoffs"
  const existingEntries = lines
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "- None yet")

  const nextSection = [headingLine, "", entry, ...existingEntries].join("\n")
  return replaceOrPrependSection(content, headingMatcher, nextSection)
}

async function updateHandoff(repoRoot, updates, options = {}) {
  const config = options.config || (await readProjectConfig(repoRoot))
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)
  const repoName = normalizeRepoName(repoRoot)

  // Use override handoff path for lane-specific operations
  const handoffPath = options.overrideHandoffPath || repoPaths.handoffPath

  if (!(await pathExists(handoffPath))) {
    await ensureDir(path.dirname(handoffPath))
    await writeText(handoffPath, renderHandoffTemplate(repoName))
  }

  const existingContent = await readText(handoffPath)
  const existingCurrent = parseCurrentSection(existingContent)
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
  return nextCurrent
}

async function claimHandoff(repoRoot, options) {
  if (!options.reviewer) {
    options.reviewer = "any-other"
  }

  if (!options.task || !options.owner) {
    throw new Error("`btrain handoff claim` requires --task and --owner.")
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
      throw new Error("No available lanes. All lanes are currently in-progress or needs-review.")
    }
  }

  // Acquire file locks if lanes enabled and files specified
  const files = options.files ? parseCsvList(options.files) : []
  if (laneConfigs && laneId) {
    const existingLane = await readLaneState(repoRoot, config, laneId)
    if (!["idle", "resolved"].includes(existingLane.status)) {
      throw new Error(
        `Lane ${laneId} is already ${existingLane.status}. Use \`btrain handoff update --lane ${laneId}\` or \`btrain handoff resolve --lane ${laneId}\`.`,
      )
    }
    if (files.length === 0) {
      throw new Error(`Lane ${laneId} claims require --files so in-progress work maps cleanly to file locks.`)
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
    throw new Error(
      `Could not infer a reviewer different from "${options.owner}". Pass --reviewer <other-agent> or configure additional agents in .btrain/project.toml.`,
    )
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
    lastUpdated: `${options.owner} ${formatIsoTimestamp()}`,
  }

  if (laneId) {
    updates._laneId = laneId
    updates.lane = laneId
  }

  // If lanes enabled, write to lane-specific handoff file
  if (laneConfigs && laneId) {
    const handoffPath = getLaneHandoffPath(repoRoot, config, laneId)
    return updateHandoff(
      repoRoot,
      updates,
      {
        contextSectionText: buildContextForReviewerSection(),
        reviewResponseText: buildPendingReviewResponseSection(),
        config,
        overrideHandoffPath: handoffPath,
      },
    )
  }

  return updateHandoff(
    repoRoot,
    updates,
    {
      contextSectionText: buildContextForReviewerSection(),
      reviewResponseText: buildPendingReviewResponseSection(),
    },
  )
}

async function patchHandoff(repoRoot, options) {
  const config = await readProjectConfig(repoRoot)
  const laneConfigs = getLaneConfigs(config)
  if (laneConfigs && !options.lane) {
    throw new Error("`btrain handoff update` requires --lane when [lanes] is enabled.")
  }

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
          throw new Error(
            `Could not infer a reviewer different from "${resolvedActor || "the actor"}". Pass --reviewer <other-agent> or configure additional agents in .btrain/project.toml.`,
          )
        }

        updates.reviewer = inferredReviewer
      }

      if (nextStatus === "resolved") {
        throw new Error(`Use \`btrain handoff resolve --lane ${laneId}\` so btrain can clear the lane locks.`)
      }

      if (isLaneActiveStatus(nextStatus) && currentLane.lockState === "mismatch" && options.files === undefined) {
        throw new Error(
          `Lane ${laneId} lock state is out of sync. Re-run \`btrain handoff update --lane ${laneId} --files "..." --actor "${resolvedActor || effectiveOwner}"\` to resync it.`,
        )
      }

      const effectiveFiles = normalizePathList(
        options.files !== undefined
          ? parseCsvList(options.files)
          : currentLane.handoffPaths.length > 0
            ? currentLane.handoffPaths
            : currentLane.lockPaths,
      )

      if (isLaneActiveStatus(nextStatus)) {
        if (effectiveFiles.length === 0) {
          throw new Error(
            `Lane ${laneId} cannot be ${nextStatus} without locked files. Pass --files to declare the working set.`,
          )
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
          ? mergeContextForReviewerSection(existingContent, options)
          : undefined

      return updateHandoff(repoRoot, updates, {
        config,
        overrideHandoffPath: handoffPath,
        contextSectionText,
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
      throw new Error(
        `Could not infer a reviewer different from "${resolvedActor || "the actor"}". Pass --reviewer <other-agent> or configure additional agents in .btrain/project.toml.`,
      )
    }

    updates.reviewer = inferredReviewer
  }

  const contextSectionText =
    options.preflight !== undefined
    || options.changed !== undefined
    || options.verification !== undefined
    || options.gap !== undefined
    || options.why !== undefined
    || options["review-ask"] !== undefined
      ? mergeContextForReviewerSection(existingContent, options)
      : undefined

  return updateHandoff(repoRoot, updates, { contextSectionText })
}

async function resolveHandoff(repoRoot, options) {
  const config = await readProjectConfig(repoRoot)
  const { actor: resolvedActor } = resolveVerifiedActor(config, options.actor)
  const actorLabel = resolvedActor || options.owner || "btrain"
  const laneConfigs = getLaneConfigs(config)
  const laneId = options.lane
  let overrideHandoffPath = null

  // Lane-aware resolve: read state from lane-specific file
  if (laneConfigs && !laneId) {
    throw new Error("`btrain handoff resolve` requires --lane when [lanes] is enabled.")
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

  // Release locks for this lane
  if (laneId) {
    await releaseLocks(repoRoot, laneId)
  }

  return updateHandoff(
    repoRoot,
    {
      status: "resolved",
      lockedFiles: laneId ? [] : existingCurrent.lockedFiles,
      nextAction: options.next || options.summary || "Await the next task.",
      lastUpdated: `${actorLabel} ${formatIsoTimestamp()}`,
    },
    {
      actorLabel,
      previousHandoffEntry,
      reviewResponseSummary: options.summary,
      config,
      overrideHandoffPath,
    },
  )
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
      const reviewerInstruction =
        reviewMode === "parallel" || reviewMode === "hybrid"
          ? `${reviewer}: run \`btrain review run\`, then \`btrain handoff resolve --lane ${laneId} --summary "..."\`.`
          : `${reviewer}: review, then \`btrain handoff resolve --lane ${laneId} --summary "..."\`.`
      return [
        `${prefix}Waiting on peer review from ${reviewer}.`,
        lockLine,
        reviewerInstruction,
        `${owner}: work on your other lane while waiting.`,
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
    const laneStates = decorateLaneStates(await readAllLaneStates(repoRoot, config), locks)
    const laneGuidances = laneStates.map((state) => buildLaneGuidance(state._laneId, state))

    let guidance = laneGuidances.join("\n\n")

    if (locks.length > 0) {
      const lockLines = locks.map((l) => `  ${l.lane}: ${l.path} (${l.owner})`)
      guidance += `\n\nActive locks:\n${lockLines.join("\n")}`
    }

    return {
      repoName,
      repoRoot,
      handoffPath: repoPaths.handoffPath,
      current: laneStates[0] || { ...DEFAULT_CURRENT },
      lanes: laneStates,
      locks,
      agentCheck,
      guidance,
    }
  }

  // Single-lane mode (backward compatible)
  const current = await readCurrentState(repoRoot)

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
      guidance = [
        "No active task. The previous handoff is resolved.",
        current.nextAction ? `Next action: ${current.nextAction}` : "Ready for someone to claim the next task.",
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

  return {
    repoName,
    repoRoot,
    handoffPath: repoPaths.handoffPath,
    current,
    agentCheck,
    guidance,
  }
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
      throw new Error(
        `Actor "${requestedActor}" does not match the detected agent "${agentCheck.agentName}". Update --actor or set BTRAIN_AGENT if the runtime check is wrong.`,
      )
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
    throw new Error("Missing `.btrain/project.toml`. Run `btrain init` first.")
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
    throw new Error(
      `Review mode "${resolvedMode.mode}" is not implemented yet. Supported modes: manual, parallel, hybrid.`,
    )
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
    throw new Error("Parallel review is disabled in `.btrain/project.toml`.")
  }

  await ensureDir(repoPaths.reviewsDir)

  const startedAt = formatIsoTimestamp()
  const artifactId = buildReviewArtifactId(resolvedMode.mode)
  const reportPath = path.join(repoPaths.reviewsDir, `${artifactId}.md`)
  const metadataPath = path.join(repoPaths.reviewsDir, `${artifactId}.json`)
  const scriptPath = resolveReviewScriptPath(reviewConfig.parallelScript, repoRoot)

  if (!(await pathExists(scriptPath))) {
    throw new Error(`Parallel review script not found: ${scriptPath}`)
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
    throw new Error("Missing `.btrain/project.toml`. Run `btrain init` first.")
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
  if (current.status === "needs-review") {
    return current.reviewer || ""
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
    throw new Error(`Unterminated quote in runner command: ${commandText}`)
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

function summarizeLoopProgressText(text, maxLength = 240) {
  const compact = String(text || "").replace(/\s+/g, " ").trim()
  if (!compact) {
    return ""
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`
}

function formatClaudeToolUse(block) {
  const summarySource =
    typeof block?.input?.command === "string" && block.input.command.trim()
      ? block.input.command
      : JSON.stringify(block?.input || {})

  const summary = summarizeLoopProgressText(summarySource)
  return summary ? `tool ${block.name}: ${summary}` : `tool ${block.name}`
}

function formatClaudeToolResult(toolResult) {
  const primaryOutput =
    typeof toolResult?.stdout === "string" && toolResult.stdout.trim()
      ? toolResult.stdout
      : typeof toolResult?.stderr === "string" && toolResult.stderr.trim()
        ? toolResult.stderr
        : ""

  if (primaryOutput) {
    return `tool result: ${summarizeLoopProgressText(primaryOutput)}`
  }
  if (toolResult?.interrupted) {
    return "tool result: interrupted"
  }
  return "tool result: completed"
}

function createClaudeStreamObserver(onEvent) {
  let stdoutBuffer = ""
  let stderrBuffer = ""
  const rawStdoutLines = []
  let streamedStdout = false
  let lastAssistantText = ""

  function emitProgressLine(line) {
    const text = summarizeLoopProgressText(line)
    if (!text) {
      return
    }
    streamedStdout = true
    emitLoopOutput(onEvent, "agent progress:", text)
  }

  function handleStdoutLine(line) {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch {
      rawStdoutLines.push(trimmed)
      return
    }

    if (payload.type === "assistant") {
      for (const block of payload.message?.content || []) {
        if (block?.type === "tool_use" && block?.name) {
          emitProgressLine(formatClaudeToolUse(block))
        } else if (block?.type === "text" && block?.text?.trim()) {
          lastAssistantText = summarizeLoopProgressText(block.text)
          emitProgressLine(lastAssistantText)
        }
      }
      return
    }

    if (payload.type === "user" && payload.tool_use_result) {
      emitProgressLine(formatClaudeToolResult(payload.tool_use_result))
      return
    }

    if (
      payload.type === "result" &&
      payload.subtype === "success" &&
      typeof payload.result === "string" &&
      payload.result.trim()
    ) {
      const resultSummary = summarizeLoopProgressText(payload.result)
      if (resultSummary && resultSummary !== lastAssistantText) {
        emitProgressLine(`result: ${resultSummary}`)
      }
      return
    }

    if (
      payload.type === "result" &&
      payload.is_error &&
      typeof payload.result === "string" &&
      payload.result.trim()
    ) {
      emitProgressLine(`error: ${payload.result}`)
    }
  }

  function consumeStdoutChunk(chunk) {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleStdoutLine(line)
      newlineIndex = stdoutBuffer.indexOf("\n")
    }
  }

  function consumeStderrChunk(chunk) {
    stderrBuffer += chunk
  }

  function flush() {
    if (stdoutBuffer.trim()) {
      handleStdoutLine(stdoutBuffer)
      stdoutBuffer = ""
    }
  }

  return {
    consumeStdoutChunk,
    consumeStderrChunk,
    flush,
    get streamedStdout() {
      return streamedStdout
    },
    get bufferedStdout() {
      return rawStdoutLines.join("\n")
    },
    get bufferedStderr() {
      return stderrBuffer.trim()
    },
  }
}

function summarizeCodexCommand(commandText) {
  const raw = String(commandText || "").trim()
  if (!raw) {
    return ""
  }

  const shellMatch = /^\S+\s+-lc\s+'([\s\S]+)'$/.exec(raw)
  if (shellMatch?.[1]) {
    return summarizeLoopProgressText(shellMatch[1].replace(/\\'/g, "'"))
  }

  return summarizeLoopProgressText(raw)
}

function formatCodexCommandOutput(item) {
  const output =
    typeof item?.aggregated_output === "string" && item.aggregated_output.trim()
      ? item.aggregated_output
      : ""

  if (!output) {
    return item?.exit_code === 0 ? "command completed" : `command exited ${item?.exit_code ?? 1}`
  }

  return summarizeLoopProgressText(output)
}

function createCodexStreamObserver(onEvent) {
  let stdoutBuffer = ""
  let stderrBuffer = ""
  const rawStdoutLines = []
  let streamedStdout = false

  function emitProgressLine(line) {
    const text = summarizeLoopProgressText(line)
    if (!text) {
      return
    }
    streamedStdout = true
    emitLoopOutput(onEvent, "agent progress:", text)
  }

  function handleStdoutLine(line) {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch {
      rawStdoutLines.push(trimmed)
      return
    }

    if (payload.type === "item.started" && payload.item?.type === "command_execution") {
      const command = summarizeCodexCommand(payload.item.command)
      emitProgressLine(command ? `command: ${command}` : "command started")
      return
    }

    if (payload.type === "item.completed" && payload.item?.type === "command_execution") {
      const command = summarizeCodexCommand(payload.item.command)
      const output = formatCodexCommandOutput(payload.item)
      emitProgressLine(command ? `command finished: ${command}` : "command finished")
      if (output) {
        emitProgressLine(`command result: ${output}`)
      }
      return
    }

    if (payload.type === "item.completed" && payload.item?.type === "agent_message" && payload.item?.text?.trim()) {
      emitProgressLine(payload.item.text)
      return
    }

    if (payload.type === "error" && payload.message) {
      emitProgressLine(`error: ${payload.message}`)
    }
  }

  function consumeStdoutChunk(chunk) {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleStdoutLine(line)
      newlineIndex = stdoutBuffer.indexOf("\n")
    }
  }

  function consumeStderrChunk(chunk) {
    stderrBuffer += chunk
  }

  function flush() {
    if (stdoutBuffer.trim()) {
      handleStdoutLine(stdoutBuffer)
      stdoutBuffer = ""
    }
  }

  return {
    consumeStdoutChunk,
    consumeStderrChunk,
    flush,
    get streamedStdout() {
      return streamedStdout
    },
    get bufferedStdout() {
      return rawStdoutLines.join("\n")
    },
    get bufferedStderr() {
      return stderrBuffer.trim()
    },
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
    throw new Error(`Runner command not found on PATH for ${agentName}: ${runner.command}`)
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
    throw new Error(`${label} must be a positive integer.`)
  }
  return parsed
}

function normalizePositiveDuration(value, defaultMs, label) {
  if (value === undefined || value === null || value === "") {
    return defaultMs
  }

  const parsed = Number.parseFloat(String(value))
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`)
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

function emitLoopBlock(onEvent, title, lines) {
  onEvent(title)
  for (const line of lines.filter(Boolean)) {
    onEvent(`  ${line}`)
  }
}

function emitLoopOutput(onEvent, label, text) {
  if (!text) {
    return
  }

  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) {
    return
  }

  onEvent(label)
  for (const line of lines.slice(0, MAX_LOOP_LOG_OUTPUT_LINES)) {
    onEvent(`  ${line}`)
  }
  if (lines.length > MAX_LOOP_LOG_OUTPUT_LINES) {
    onEvent(`  ... truncated ${lines.length - MAX_LOOP_LOG_OUTPUT_LINES} more lines`)
  }
}

function describeLoopAgentReason(current) {
  if (current.status === "in-progress") {
    return "handoff status is in-progress, so the active agent acts next"
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
async function runPush(agentName, { repoRoot, prompt = LOOP_PROMPT, onEvent = () => {} } = {}) {
  if (repoRoot) {
    const config = await readProjectConfig(repoRoot)
    if (config) {
      const runner = resolveLoopRunner(agentName, config, repoRoot, { prompt })
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
  const pushResult = await pushAgentPrompt(agentName, { prompt })
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
    throw new Error("Missing `.btrain/project.toml`. Run `btrain init` first.")
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
  let current = await readCurrentState(repoRoot)

  onEvent(`loop start: ${repoName}`)
  emitLoopBlock(onEvent, "loop context:", [
    `repo root: ${repoRoot}`,
    `handoff file: ${handoffPath}`,
    `task: ${current.task || "(none)"}`,
    `next action: ${current.nextAction || "(none)"}`,
  ])
  emitLoopBlock(onEvent, "loop config:", [
    `max rounds: ${resolvedMaxRounds}`,
    `timeout per round: ${formatLoopSeconds(timeoutMs)}`,
    `poll interval: ${formatLoopSeconds(pollIntervalMs)}`,
    `dispatch prompt: ${LOOP_PROMPT}`,
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
    const runner = resolveLoopRunner(agentName, config, repoRoot, { prompt: LOOP_PROMPT })
    const roundStartedAt = Date.now()
    emitLoopBlock(onEvent, "selected agent:", [
      `${agentName}`,
      `reason: ${describeLoopAgentReason(before)}`,
      `handoff snapshot: ${formatLoopState(before)}`,
    ])
    emitLoopBlock(onEvent, "runner selection:", [
      `mode: ${runner.type}${runner.fallback ? " (fallback)" : ""}`,
      `configured value: ${runner.configuredValue || "(none)"}`,
      `prompt: ${LOOP_PROMPT}`,
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
          prompt: LOOP_PROMPT,
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

async function getManagedBlockTemplate(repoRoot = null) {
  const templateContent = await loadTemplate("managed-block.md")
  const config = repoRoot ? await readProjectConfig(repoRoot) : null
  const rendered = renderTemplate(templateContent, buildManagedBlockVariables(config))
  return extractManagedBlock(rendered) || rendered.trim()
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
    throw new Error(`Not a directory: ${repoRoot}`)
  }

  const repoPaths = getRepoPaths(repoRoot)
  const hasProjectToml = await pathExists(repoPaths.projectTomlPath)
  const config = hasProjectToml ? await readProjectConfig(repoRoot) : null
  const configuredRepoPaths = getConfiguredRepoPaths(repoRoot, config)
  const hasHandoff = await pathExists(configuredRepoPaths.handoffPath)

  if (!hasProjectToml && !hasHandoff) {
    throw new Error("Repo is not bootstrapped enough to register. Create `.btrain/project.toml` or `.claude/collab/HANDOFF_A.md`, or run `btrain init` instead.")
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
  const current = await readCurrentState(repoRoot)
  const repoName = config?.name || normalizeRepoName(repoRoot)
  const handoffContent = (await pathExists(repoPaths.handoffPath))
    ? await readText(repoPaths.handoffPath)
    : ""
  const staleness = parseStaleness(current.lastUpdated)
  const previousHandoffs = countPreviousHandoffs(handoffContent)
  const templateDrift = await detectTemplateDrift(repoRoot)

  const status = {
    name: repoName,
    path: repoRoot,
    current,
    staleness,
    previousHandoffs,
    templateDrift,
  }

  // Add lane info if enabled
  const laneConfigs = getLaneConfigs(config)
  if (laneConfigs) {
    status.locks = await listLocks(repoRoot)
    status.lanes = decorateLaneStates(await readAllLaneStates(repoRoot, config), status.locks)
  }

  return status
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

async function doctorRepo(repoRoot) {
  const issues = []
  const warnings = []
  const managedTemplate = await getManagedBlockTemplate(repoRoot)
  const config = await readProjectConfig(repoRoot)
  const repoPaths = getConfiguredRepoPaths(repoRoot, config)

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
  }

  return {
    repoRoot,
    healthy: issues.length === 0,
    issues,
    warnings,
  }
}

async function doctor({ repoRoot } = {}) {
  if (repoRoot) {
    return [await doctorRepo(repoRoot)]
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

    results.push(await doctorRepo(repo.path))
  }

  return results
}

export {
  acquireLocks,
  checkHandoff,
  pushAgentPrompt,
  checkLockConflicts,
  claimHandoff,
  doctor,
  findAvailableLane,
  findRepoRoot,
  forceReleaseLock,
  getBrainTrainHome,
  getLaneConfigs,
  getRepoPaths,
  getReviewStatus,
  getStatus,
  initRepo,
  installPreCommitHook,
  isLanesEnabled,
  listLocks,
  listRepos,
  parseCsvList,
  readAllLaneStates,
  readLockRegistry,
  readProjectConfig,
  registerRepo,
  releaseLocks,
  runPush,
  patchHandoff,
  resolveHandoff,
  resolveRepoRoot,
  runReview,
  runLoop,
  syncActiveAgents,
  syncTemplates,
}
