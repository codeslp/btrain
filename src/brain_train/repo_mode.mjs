// Storage mode and feature toggles for `btrain init` (spec 022).
//
// This module is deliberately free of imports from core.mjs so core can
// depend on it without a cycle, and so the frozen core.mjs export surface
// (spec 020 WS2 baseline) does not grow.
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import readline from "node:readline"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Storage mode
// ---------------------------------------------------------------------------

// local:   every btrain-generated file lives under `.btrain/`, and `.btrain/`
//          is ignored by git. Nothing btrain writes is ever committed.
// tracked: the pre-spec-022 layout. Handoffs in `.claude/collab/`, managed
//          blocks in AGENTS.md / CLAUDE.md, skills in `.claude/skills/`.
//          A project.toml without a `storage` key is tracked, so every repo
//          initialized before spec 022 keeps its behavior.
export const STORAGE_LOCAL = "local"
export const STORAGE_TRACKED = "tracked"
export const LOCAL_STATE_DIRNAME = ".btrain"
export const LOCAL_IGNORE_LINE = ".btrain/"

export function getStorageMode(config) {
  const raw = typeof config?.storage === "string" ? config.storage.trim().toLowerCase() : ""
  return raw === STORAGE_LOCAL ? STORAGE_LOCAL : STORAGE_TRACKED
}

export function isLocalStorage(config) {
  return getStorageMode(config) === STORAGE_LOCAL
}

export function normalizeStorageMode(value) {
  const raw = String(value || "").trim().toLowerCase()
  if (raw === STORAGE_LOCAL) return STORAGE_LOCAL
  if (raw === STORAGE_TRACKED || raw === "shared") return STORAGE_TRACKED
  return ""
}

// The single place that knows where each mode keeps its handoff files.
export function getHandoffDirRelative(mode) {
  return mode === STORAGE_LOCAL ? ".btrain/collab" : ".claude/collab"
}

export function getDefaultLaneHandoffRelativePath(mode, laneId) {
  return `${getHandoffDirRelative(mode)}/HANDOFF_${String(laneId).toUpperCase()}.md`
}

// Mode-specific repo paths. core.mjs merges this over its base paths, so every
// reader that goes through getConfiguredRepoPaths() sees the right location.
export function getModeRepoPaths(repoRoot, mode) {
  if (mode !== STORAGE_LOCAL) {
    return {
      storageMode: STORAGE_TRACKED,
      handoffDir: path.join(repoRoot, ".claude", "collab"),
      agentsPath: path.join(repoRoot, "AGENTS.md"),
      claudePath: path.join(repoRoot, "CLAUDE.md"),
      skillsPath: path.join(repoRoot, ".claude", "skills"),
      agentSkillsPath: path.join(repoRoot, ".agents", "skills"),
      feedbackLogPath: path.join(repoRoot, ".claude", "collab", "FEEDBACK_LOG.md"),
      toolsRoot: repoRoot,
    }
  }
  const stateDir = path.join(repoRoot, LOCAL_STATE_DIRNAME)
  return {
    storageMode: STORAGE_LOCAL,
    handoffDir: path.join(stateDir, "collab"),
    // One untracked instruction file serves every agent in local mode.
    agentsPath: path.join(stateDir, "AGENTS.md"),
    claudePath: path.join(stateDir, "AGENTS.md"),
    skillsPath: path.join(stateDir, "skills"),
    agentSkillsPath: path.join(stateDir, "agent-skills"),
    feedbackLogPath: path.join(stateDir, "collab", "FEEDBACK_LOG.md"),
    toolsRoot: path.join(stateDir, "tools"),
  }
}

// ---------------------------------------------------------------------------
// Ignore handling
// ---------------------------------------------------------------------------

export const IGNORE_TARGET_GITIGNORE = "gitignore"
export const IGNORE_TARGET_EXCLUDE = "exclude"

function hasIgnoreLine(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".btrain/" || line === ".btrain" || line === "/.btrain/" || line === "/.btrain")
}

async function resolveInfoExcludePath(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot })
    const value = stdout.trim()
    if (value) return path.resolve(repoRoot, value)
  } catch {
    // not a git repo, or git unavailable
  }
  return null
}

// Idempotently add `.btrain/` to `.gitignore` (default) or `.git/info/exclude`.
// Returns { target, path, changed }.
export async function ensureLocalStateIgnored(repoRoot, { target = IGNORE_TARGET_GITIGNORE } = {}) {
  let ignorePath
  if (target === IGNORE_TARGET_EXCLUDE) {
    ignorePath = await resolveInfoExcludePath(repoRoot)
    if (!ignorePath) {
      const error = new Error(`--exclude-local needs a git repository: ${repoRoot} has no .git directory.`)
      error.code = "BTRAIN_NOT_GIT"
      throw error
    }
  } else {
    ignorePath = path.join(repoRoot, ".gitignore")
  }

  let content = ""
  try {
    content = await fs.readFile(ignorePath, "utf8")
  } catch {
    // missing file: created below
  }
  if (hasIgnoreLine(content)) {
    return { target, path: ignorePath, changed: false }
  }
  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? content : `${content}\n`
  await fs.mkdir(path.dirname(ignorePath), { recursive: true })
  await fs.writeFile(ignorePath, `${prefix}${LOCAL_IGNORE_LINE}\n`, "utf8")
  return { target, path: ignorePath, changed: true }
}

// Files under `.btrain/` that git tracks. Non-empty in local mode means state
// was committed before the switch (or force-added) and will leak.
export async function listTrackedLocalStateFiles(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "ls-files", "--", LOCAL_STATE_DIRNAME], { cwd: repoRoot })
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function isLocalStateIgnored(repoRoot) {
  try {
    await execFileAsync("git", ["-C", repoRoot, "check-ignore", "-q", "--no-index", `${LOCAL_STATE_DIRNAME}/project.toml`], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Feature toggles
// ---------------------------------------------------------------------------

// Every optional subsystem `btrain init` can scaffold. `localDefault` is the
// default for a new repo; a repo whose project.toml has no [features] table
// (every repo initialized before spec 022) treats every feature as enabled,
// so nothing changes for it.
export const FEATURES = [
  {
    id: "hooks",
    label: "Git guards",
    description: "pre-commit lock guard and pre-push unresolved-lane guard in .git/hooks",
    localDefault: true,
  },
  {
    id: "skills",
    label: "Workflow skills",
    description: "bundled agent skills (pre-handoff, bug-fix, test-writer, context-scout, ...)",
    localDefault: true,
  },
  {
    id: "speckit",
    label: "Spec-kit skills",
    description: "speckit-specify/plan/tasks/implement/... spec-driven skills",
    localDefault: true,
  },
  {
    id: "formal",
    label: "Formal checks (TLA+/Specula)",
    description: "tla-author, tla-run-tlc, tla-pin-sync, tla-trace-explain, speckit-formal skills",
    localDefault: false,
  },
  {
    id: "feedback",
    label: "Feedback log",
    description: "feedback-triage skill and collab/FEEDBACK_LOG.md health checks",
    localDefault: true,
  },
  {
    id: "cgraph",
    label: "cgraph code graph",
    description: "cgraph review packets, audits, and lock-overlap advisories",
    localDefault: false,
  },
  {
    id: "unblocked",
    label: "Unblocked context",
    description: "unblocked-context helper and `handoff claim --unblocked-context`",
    localDefault: false,
  },
  {
    id: "zvec",
    label: "zvec-grep context",
    description: "zvec-context helper for semantic code search",
    localDefault: false,
  },
  {
    id: "pr_flow",
    label: "PR flow",
    description: "`btrain pr create|poll|request-review` with GitHub bot reviews",
    localDefault: false,
  },
  {
    id: "loop",
    label: "Reviewer dispatch loop",
    description: "`btrain loop` automatic writer/reviewer dispatch",
    localDefault: true,
  },
  {
    id: "dashboard",
    label: "Dashboard",
    description: "`btrain dashboard` local web dashboard",
    localDefault: true,
  },
  {
    id: "agentchattr",
    label: "agentchattr sidecar",
    description: "agentchattr multi-agent chat server copied into the repo",
    localDefault: false,
  },
  {
    id: "handoff_history",
    label: "Handoff history watcher",
    description: "handoff-history watcher and launch-agent scripts",
    localDefault: false,
  },
]

export const FEATURE_IDS = FEATURES.map((feature) => feature.id)

const FEATURE_ALIASES = new Map([
  ["tla", "formal"],
  ["tla+", "formal"],
  ["specula", "formal"],
  ["spec-kit", "speckit"],
  ["pr-flow", "pr_flow"],
  ["prflow", "pr_flow"],
  ["pr", "pr_flow"],
  ["handoff-history", "handoff_history"],
  ["git-hooks", "hooks"],
  ["zvec-grep", "zvec"],
  ["code-graph", "cgraph"],
])

export function normalizeFeatureId(value) {
  const raw = String(value || "").trim().toLowerCase()
  if (!raw) return ""
  const aliased = FEATURE_ALIASES.get(raw) || raw.replaceAll("-", "_")
  return FEATURE_IDS.includes(aliased) ? aliased : ""
}

function splitList(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null || value === true ? [] : [value]
  return values
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean)
}

export function parseFeatureList(value, flagName = "--features") {
  const ids = []
  const unknown = []
  for (const item of splitList(value)) {
    const id = normalizeFeatureId(item)
    if (id) {
      if (!ids.includes(id)) ids.push(id)
    } else {
      unknown.push(item)
    }
  }
  if (unknown.length > 0) {
    const error = new Error(
      `Unknown feature${unknown.length === 1 ? "" : "s"} for ${flagName}: ${unknown.join(", ")}. Known features: ${FEATURE_IDS.join(", ")}.`,
    )
    error.code = "BTRAIN_UNKNOWN_FEATURE"
    throw error
  }
  return ids
}

export function getDefaultFeatureMap() {
  return Object.fromEntries(FEATURES.map((feature) => [feature.id, feature.localDefault]))
}

export function getAllOnFeatureMap() {
  return Object.fromEntries(FEATURE_IDS.map((id) => [id, true]))
}

// Resolve a feature map from CLI flags. `base` is the starting map (defaults
// for a new repo, or the repo's current map on re-init).
//   --features a,b    exactly these optional features on, the rest off
//   --feature x       turn x on (repeatable, comma lists allowed)
//   --no-feature x    turn x off (repeatable, comma lists allowed)
export function resolveFeatureMap({ base = getDefaultFeatureMap(), features, enable, disable } = {}) {
  const map = { ...getDefaultFeatureMap(), ...base }
  if (features !== undefined && features !== null) {
    const selected = new Set(parseFeatureList(features, "--features"))
    for (const id of FEATURE_IDS) map[id] = selected.has(id)
  }
  for (const id of parseFeatureList(enable, "--feature")) map[id] = true
  for (const id of parseFeatureList(disable, "--no-feature")) map[id] = false
  return map
}

export function hasFeaturesTable(config) {
  return Boolean(config?.features && typeof config.features === "object" && !Array.isArray(config.features))
}

// Missing table or missing key means enabled: legacy repos keep everything on.
export function isFeatureEnabled(config, featureId) {
  if (!hasFeaturesTable(config)) return true
  const value = config.features[featureId]
  return value !== false
}

export function getFeatureMapFromConfig(config) {
  return Object.fromEntries(FEATURE_IDS.map((id) => [id, isFeatureEnabled(config, id)]))
}

export function featureDisabledMessage(featureId, commandLabel = "") {
  const feature = FEATURES.find((entry) => entry.id === featureId)
  const label = feature ? feature.label : featureId
  return `${commandLabel ? `${commandLabel}: ` : ""}the "${featureId}" feature (${label}) is disabled for this repo. Enable it with: btrain features enable ${featureId}`
}

export function renderFeaturesTomlLines(featureMap) {
  return [
    "[features]",
    ...FEATURE_IDS.map((id) => `${id} = ${featureMap[id] === false ? "false" : "true"}`),
  ]
}

// Replace or append the [features] table. Keys not in the registry are kept.
export function upsertFeaturesTable(content, featureMap) {
  const lines = content.split("\n")
  const start = lines.findIndex((line) => line.trim() === "[features]")
  const rendered = renderFeaturesTomlLines(featureMap)
  if (start === -1) {
    return `${content.trimEnd()}\n\n${rendered.join("\n")}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\[.+\]$/.test(lines[index].trim())) {
      end = index
      break
    }
  }
  const extras = lines
    .slice(start + 1, end)
    .filter((line) => {
      const match = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)
      return match && !FEATURE_IDS.includes(match[1])
    })
  const body = [...rendered, ...extras]
  const after = lines.slice(end)
  while (after.length > 0 && after[0].trim() === "") after.shift()
  const before = lines.slice(0, start)
  return [...before, ...body, ...(after.length > 0 ? ["", ...after] : [])].join("\n").replace(/\n*$/, "\n")
}

// Skill-to-feature mapping. Skills not listed here belong to "skills".
const FORMAL_SKILLS = new Set(["tla-author", "tla-pin-sync", "tla-run-tlc", "tla-trace-explain", "speckit-formal"])

export function getSkillFeature(skillName) {
  if (FORMAL_SKILLS.has(skillName)) return "formal"
  if (skillName.startsWith("speckit-")) return "speckit"
  if (skillName === "feedback-triage") return "feedback"
  return "skills"
}

export function isSkillEnabled(featureMap, skillName) {
  if (!featureMap) return true
  return featureMap[getSkillFeature(skillName)] !== false
}

// Dev-tool label to feature mapping (labels match core.mjs BUNDLED_DEV_TOOLS).
const DEV_TOOL_FEATURES = new Map([
  ["dashboard", "dashboard"],
  ["handoff-history-watcher", "handoff_history"],
  ["handoff-history-install", "handoff_history"],
  ["handoff-history-register", "handoff_history"],
  ["unblocked-context-helper", "unblocked"],
  ["zvec-context-helper", "zvec"],
  ["agentchattr", "agentchattr"],
])

export function isDevToolEnabled(featureMap, label) {
  if (!featureMap) return true
  const featureId = DEV_TOOL_FEATURES.get(label)
  return !featureId || featureMap[featureId] !== false
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const SUGGESTED_AGENTS = ["claude", "codex", "gemini", "app-developer"]
export const DEFAULT_INIT_AGENTS = ["claude", "codex"]

export function parseAgentList(...values) {
  const result = []
  for (const item of values.flatMap((value) => splitList(value))) {
    if (!result.some((existing) => existing.toLowerCase() === item.toLowerCase())) {
      result.push(item)
    }
  }
  return result
}

// Order agents so writer_default (first) is not the reviewer and
// reviewer_default (second) is the requested reviewer.
export function orderAgentsForReviewer(agents, reviewer) {
  const list = parseAgentList(agents)
  const wanted = String(reviewer || "").trim()
  if (!wanted) return list
  const existing = list.find((agent) => agent.toLowerCase() === wanted.toLowerCase()) || wanted
  const others = list.filter((agent) => agent.toLowerCase() !== existing.toLowerCase())
  if (others.length === 0) return [existing]
  return [others[0], existing, ...others.slice(1)]
}

// ---------------------------------------------------------------------------
// Interactive prompt (node:readline, no dependencies)
// ---------------------------------------------------------------------------

export function shouldPromptForInit({ stdin = process.stdin, stdout = process.stdout, yes = false, env = process.env } = {}) {
  if (yes) return false
  if (env.CI && env.CI !== "false" && env.CI !== "0") return false
  return Boolean(stdin?.isTTY && stdout?.isTTY)
}

// Parse the answer to the feature checklist. Blank keeps the defaults.
// Accepts numbers or ids, e.g. "4 6", "formal,cgraph", "+formal -loop",
// "all", "none". Plain entries toggle; + forces on; - forces off.
export function applyFeatureAnswer(answer, currentMap) {
  const map = { ...currentMap }
  const text = String(answer || "").trim()
  if (!text) return map
  if (/^all$/i.test(text)) return getAllOnFeatureMap()
  if (/^none$/i.test(text)) return Object.fromEntries(FEATURE_IDS.map((id) => [id, false]))
  const unknown = []
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    let op = "toggle"
    let name = token
    if (name.startsWith("+")) { op = "on"; name = name.slice(1) }
    else if (name.startsWith("-")) { op = "off"; name = name.slice(1) }
    let id = ""
    if (/^\d+$/.test(name)) {
      const index = Number(name) - 1
      id = FEATURE_IDS[index] || ""
    } else {
      id = normalizeFeatureId(name)
    }
    if (!id) {
      unknown.push(token)
      continue
    }
    map[id] = op === "on" ? true : op === "off" ? false : !map[id]
  }
  if (unknown.length > 0) {
    const error = new Error(`Unrecognized feature selection: ${unknown.join(", ")}`)
    error.code = "BTRAIN_UNKNOWN_FEATURE"
    throw error
  }
  return map
}

function renderFeatureChecklist(map) {
  return FEATURES.map((feature, index) => {
    const mark = map[feature.id] ? "x" : " "
    const number = String(index + 1).padStart(2, " ")
    return `  ${number}. [${mark}] ${feature.id.padEnd(16)} ${feature.label} — ${feature.description}`
  }).join("\n")
}

// Ask the init questions. `ask(question)` resolves to the typed line; tests
// pass a scripted ask, the CLI passes a readline-backed one.
export async function runInitQuestions({
  ask,
  write = (text) => process.stdout.write(text),
  featureMap = getDefaultFeatureMap(),
  agents = DEFAULT_INIT_AGENTS,
  reviewer = "",
} = {}) {
  let map = { ...featureMap }
  write("\nbtrain init: choose what to spin up in this repo.\n")
  for (let attempt = 0; attempt < 3; attempt += 1) {
    write(`\nFeatures (core lanes, locks, and handoffs are always on):\n${renderFeatureChecklist(map)}\n`)
    const answer = await ask("Toggle by number or name (e.g. \"4 6\" or \"+formal -loop\"), Enter to accept: ")
    try {
      const next = applyFeatureAnswer(answer, map)
      if (!String(answer || "").trim()) {
        map = next
        break
      }
      map = next
    } catch (error) {
      write(`${error.message}\n`)
    }
  }

  write(`\nSuggested agents: ${SUGGESTED_AGENTS.join(", ")} (any other name works too).\n`)
  const agentAnswer = await ask(`Agents to start with, comma-separated [${agents.join(", ")}]: `)
  const chosenAgents = parseAgentList(String(agentAnswer || "").trim() ? agentAnswer : agents)
  const defaultReviewer = reviewer && chosenAgents.some((agent) => agent.toLowerCase() === reviewer.toLowerCase())
    ? reviewer
    : chosenAgents[1] || chosenAgents[0] || ""
  const reviewerAnswer = await ask(`Default reviewer [${defaultReviewer}]: `)
  const chosenReviewer = String(reviewerAnswer || "").trim() || defaultReviewer

  return {
    featureMap: map,
    agents: orderAgentsForReviewer(chosenAgents, chosenReviewer),
    reviewer: chosenReviewer,
  }
}

export async function promptInitChoices(options = {}) {
  const input = options.input || process.stdin
  const output = options.output || process.stdout
  const rl = readline.createInterface({ input, output })
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve))
  try {
    return await runInitQuestions({ ...options, ask, write: (text) => output.write(text) })
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------
// Local-mode agent discovery hint
// ---------------------------------------------------------------------------

export function renderLocalInstructionsHint(repoRoot) {
  const rel = path.join(LOCAL_STATE_DIRNAME, "AGENTS.md")
  return [
    `agent instructions: ${rel} (untracked). Start agents with:`,
    `  "Read ${rel} and run \`btrain startup\` before working."`,
    `  or run \`btrain startup --repo ${repoRoot}\` in the agent session.`,
  ].join("\n")
}

// Remove btrain-managed git hooks (those carrying our marker). Used by
// `btrain features disable hooks`; user-owned hooks are never touched.
const MANAGED_HOOK_MARKERS = [
  ["pre-commit", "# btrain:pre-commit-hook"],
  ["pre-push", "# btrain:pre-push-hook"],
]

export async function removeManagedGitHooks(repoRoot) {
  let hooksDir = null
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--git-path", "hooks"], { cwd: repoRoot })
    hooksDir = stdout.trim() ? path.resolve(repoRoot, stdout.trim()) : null
  } catch {
    return []
  }
  if (!hooksDir) return []
  const removed = []
  for (const [filename, marker] of MANAGED_HOOK_MARKERS) {
    const hookPath = path.join(hooksDir, filename)
    try {
      const content = await fs.readFile(hookPath, "utf8")
      if (content.includes(marker)) {
        await fs.rm(hookPath, { force: true })
        removed.push(filename)
      }
    } catch {
      // hook missing
    }
  }
  return removed
}

export const SKILL_FEATURE_IDS = new Set(["skills", "speckit", "formal", "feedback"])
export const DEV_TOOL_FEATURE_IDS = new Set(["dashboard", "agentchattr", "handoff_history", "unblocked", "zvec"])

// ---------------------------------------------------------------------------
// Init helpers kept out of core.mjs (its function inventory is frozen by the
// spec 020 WS2 module assignment).
// ---------------------------------------------------------------------------

export function getHookHandoffGlob(mode) {
  return mode === STORAGE_LOCAL ? ".btrain/collab/HANDOFF*.md" : ".claude/collab/HANDOFF*.md"
}

// A repo with committed pre-022 btrain files but no project.toml (for
// example a fresh clone of a repo that ignores project.toml) is tracked.
export async function hasLegacyTrackedArtifacts(repoRoot, managedStartMarker) {
  try {
    const entries = await fs.readdir(path.join(repoRoot, ".claude", "collab"))
    if (entries.some((name) => /^HANDOFF.*\.md$/.test(name))) return true
  } catch {
    // no .claude/collab directory
  }
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const content = await fs.readFile(path.join(repoRoot, fileName), "utf8")
      if (managedStartMarker && content.includes(managedStartMarker)) return true
    } catch {
      // file missing
    }
  }
  return false
}

// Decide the storage mode for init. An existing project.toml always wins;
// init never migrates. Returns { mode, detected, conflict }.
export async function resolveInitStorage({ repoRoot, projectTomlExists, existingConfig, storage, defaultStorage, managedStartMarker }) {
  const explicit = normalizeStorageMode(storage)
  if (projectTomlExists) {
    const current = getStorageMode(existingConfig)
    return {
      mode: current,
      detected: "project-toml",
      conflict: explicit && explicit !== current ? { current, requested: explicit } : null,
    }
  }
  if (explicit) return { mode: explicit, detected: "flag", conflict: null }
  if (await hasLegacyTrackedArtifacts(repoRoot, managedStartMarker)) {
    return { mode: STORAGE_TRACKED, detected: "legacy-artifacts", conflict: null }
  }
  return { mode: normalizeStorageMode(defaultStorage) || STORAGE_TRACKED, detected: "default", conflict: null }
}

// Rewrite a rendered project.toml template for local storage.
export function localizeProjectToml(renderedToml, mode) {
  if (mode !== STORAGE_LOCAL) return renderedToml
  const localHandoff = getDefaultLaneHandoffRelativePath(STORAGE_LOCAL, "a")
  const lines = renderedToml.split("\n")
  const handoffIndex = lines.findIndex((line) => /^handoff_path\s*=/.test(line.trim()))
  const storageLine = `storage = "${STORAGE_LOCAL}"`
  if (handoffIndex >= 0) {
    lines[handoffIndex] = `handoff_path = "${localHandoff}"`
    lines.splice(handoffIndex + 1, 0, storageLine)
  } else {
    const firstSection = lines.findIndex((line) => /^\[.+\]$/.test(line.trim()))
    lines.splice(firstSection === -1 ? lines.length : firstSection, 0, storageLine, `handoff_path = "${localHandoff}"`)
  }
  return lines.join("\n")
}
