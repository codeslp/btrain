// Spec 024 FR-1, FR-14, FR-16 and the plan's WS2: the publisher's settings.
//
// - The toggle: on only when `[features].slack` is exactly `true` (FR-1). A
//   missing table or key is off, unlike the older toggles. The same rule goes
//   into repo_mode.mjs in T007; this is the check slack/ itself uses.
// - `[slack]` options in project.toml, with defaults.
// - From the developer's `slack.json` (credentials.mjs reads it): the channel
//   for a repository by its registered path, else `defaultChannel`, else none
//   (FR-16); the developer label (FR-14); the mention list (FR-15).
// - Spec 025 (T012): the `slack_listen` toggle by the same rule, the
//   listener's settings in `slack.json` (`operator`, `pollSeconds`, the
//   `orchestrator` object), `[slack.orchestrator]` in project.toml, each with
//   the spec's defaults, and the served repositories.
//
// Imports nothing from core.mjs.

import os from "node:os"
import path from "node:path"
import { realpathSync } from "node:fs"
import { stripTomlComment } from "../review/review-config.mjs"
import { DEFAULT_AUTO, normalizeAutoList } from "./verbs.mjs"

export const SLACK_DEFAULTS = Object.freeze({
  taskChars: 300,
  summaryChars: 200,
  inlineTimeoutMs: 2000,
})

// Slack IDs: a channel starts with C, G (private) or D; a user with U or W.
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/
const USER_ID = /^[UW][A-Z0-9]{2,20}$/

function tableOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

// On only when `[features].<key>` is exactly `true`: a missing table or key
// is off.
function isExplicitlyOn(projectConfig, key) {
  const value = stripTomlComment(tableOf(projectConfig?.features)[key])
  // The project TOML parser keeps a comment after an unquoted value:
  // `slack = true # on` arrives as the text "true # on".
  return value === true || (typeof value === "string" && /^true\s+#/.test(value))
}

/** FR-1: on only when `[features].slack` is exactly `true`. */
export function isSlackEnabled(projectConfig) {
  return isExplicitlyOn(projectConfig, "slack")
}

/** Spec 025 FR-1: on only when `[features].slack_listen` is exactly `true`. */
export function isSlackListenEnabled(projectConfig) {
  return isExplicitlyOn(projectConfig, "slack_listen")
}

// A positive whole number from project.toml, where the parser returns most
// values as text. `section` names the table in the error.
function readPositive(table, key, fallback, errors, section = "slack") {
  if (!Object.hasOwn(table, key)) return fallback
  const raw = stripTomlComment(table[key])
  // The project TOML parser keeps a comment after an unquoted number too.
  const textValue = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.replace(/\s+#.*$/, "").trim() : ""
  if (/^\d+$/.test(textValue) && Number(textValue) > 0 && Number.isSafeInteger(Number(textValue))) {
    return Number(textValue)
  }
  errors.push({ key: `${section}.${key}`, value: raw, message: `[${section}].${key} = ${JSON.stringify(raw)} is not a positive whole number; using the default ${fallback}.` })
  return fallback
}

/** `[slack]` options with defaults; a value that does not parse is an error and takes its default. */
export function getSlackOptions(projectConfig) {
  const table = tableOf(projectConfig?.slack)
  const errors = []
  return {
    taskChars: readPositive(table, "task_chars", SLACK_DEFAULTS.taskChars, errors),
    summaryChars: readPositive(table, "summary_chars", SLACK_DEFAULTS.summaryChars, errors),
    inlineTimeoutMs: readPositive(table, "inline_timeout_ms", SLACK_DEFAULTS.inlineTimeoutMs, errors),
    errors,
  }
}

function realOrResolved(target) {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * The channel for a repository (FR-16): its entry in `channels`, keyed by
 * registered path, else `defaultChannel`, else none. Returns
 * `{ channel, source }`, where `source` is `mapped`, `default`, or "" (none).
 * Two repositories with one name map to their own channels, because the key
 * is the path. A value that is not a Slack channel ID counts as unset.
 */
export function channelForRepo(settings, repoPath) {
  const channels = tableOf(settings?.channels)
  const wanted = new Set([path.resolve(String(repoPath || "")), realOrResolved(String(repoPath || ""))])
  for (const [key, value] of Object.entries(channels)) {
    // Keys are registered paths; a relative key would match against the
    // current directory, so it is ignored.
    if (!key || !path.isAbsolute(key)) continue
    if ((wanted.has(path.resolve(key)) || wanted.has(realOrResolved(key))) && CHANNEL_ID.test(String(value))) {
      return { channel: String(value), source: "mapped" }
    }
  }
  const fallback = String(settings?.defaultChannel || "")
  if (CHANNEL_ID.test(fallback)) return { channel: fallback, source: "default" }
  return { channel: "", source: "" }
}

/** The developer label on every message (FR-14): `label`, else the OS user name. */
export function developerLabel(settings) {
  const label = typeof settings?.label === "string" ? settings.label.trim() : ""
  if (label) return label
  try {
    return os.userInfo().username || "developer"
  } catch {
    return "developer"
  }
}

/** The IDs to mention (FR-15), well-formed and without repeats. */
export function mentionList(settings) {
  const list = Array.isArray(settings?.mention) ? settings.mention : []
  return [...new Set(list.map((item) => String(item).trim()).filter((item) => USER_ID.test(item)))]
}

/** The operator's user ID, or "" when it is missing or malformed. */
export function operatorId(settings) {
  const id = typeof settings?.operator === "string" ? settings.operator.trim() : ""
  return USER_ID.test(id) ? id : ""
}

/** The `channels` map as `[{ channel, repos }]`, for `btrain slack channels` and setup (FR-16). */
export function listChannels(settings) {
  const byChannel = new Map()
  for (const [repoPath, channel] of Object.entries(tableOf(settings?.channels))) {
    if (!CHANNEL_ID.test(String(channel))) continue
    if (!byChannel.has(channel)) byChannel.set(channel, [])
    byChannel.get(channel).push(repoPath)
  }
  return [...byChannel.entries()].map(([channel, repos]) => ({ channel, repos: repos.sort() }))
}

// ---- Spec 025: the listener (T012) ----

/** The `orchestrator` object of `slack.json` when a key is absent (spec 025). */
export const ORCHESTRATOR_DEFAULTS = Object.freeze({
  runner: "claude -p",
  turnSeconds: 180,
  maxTurnsPerHour: 30,
  approvalMinutes: 15,
  conversationMinutes: 30,
})

export const DEFAULT_POLL_SECONDS = 10

/** `[slack.orchestrator]` of project.toml when a key is absent (spec 025). */
export const REPO_ORCHESTRATOR_DEFAULTS = Object.freeze({
  auto: DEFAULT_AUTO,
  maxActive: 3,
  maxRounds: 4,
  maxCommandsPerHour: 20,
  retryReviewPerHour: 3,
})

// A positive whole number from slack.json, which is JSON: only a number counts.
function jsonPositive(table, key, fallback, errors, section) {
  if (!Object.hasOwn(table, key)) return fallback
  const value = table[key]
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  const name = section ? `${section}.${key}` : key
  errors.push({ key: name, value, message: `${name} = ${JSON.stringify(value)} in slack.json is not a positive whole number; using the default ${fallback}.` })
  return fallback
}

/**
 * The listener's settings from `slack.json`: `{ operator, pollSeconds,
 * orchestrator, errors }`. `operator` is "" when missing or malformed, and
 * the listener refuses to start then. An empty `runner` turns the model off
 * (`model: false`): the listener runs commands only (FR-1). A value that does
 * not parse takes its default and is reported in `errors`.
 */
export function getListenerSettings(settings) {
  const errors = []
  const pollSeconds = jsonPositive(tableOf(settings), "pollSeconds", DEFAULT_POLL_SECONDS, errors, "")
  const raw = settings?.orchestrator
  if (raw !== undefined && tableOf(raw) !== raw) {
    errors.push({ key: "orchestrator", value: raw, message: "orchestrator in slack.json is not an object; using the defaults." })
  }
  const table = tableOf(raw)
  let runner = ORCHESTRATOR_DEFAULTS.runner
  if (Object.hasOwn(table, "runner")) {
    if (typeof table.runner === "string") {
      runner = table.runner.trim()
    } else {
      errors.push({ key: "orchestrator.runner", value: table.runner, message: `orchestrator.runner in slack.json is not text; using the default "${runner}".` })
    }
  }
  const orchestrator = { runner, model: runner !== "" }
  for (const key of ["turnSeconds", "maxTurnsPerHour", "approvalMinutes", "conversationMinutes"]) {
    orchestrator[key] = jsonPositive(table, key, ORCHESTRATOR_DEFAULTS[key], errors, "orchestrator")
  }
  return { operator: operatorId(settings), pollSeconds, orchestrator, errors }
}

/**
 * `[slack.orchestrator]` of one repository: `{ auto, maxActive, maxRounds,
 * maxCommandsPerHour, retryReviewPerHour, errors }`. `auto` refuses `start`
 * and `pause` and drops unknown verbs (verbs.mjs); each is reported for
 * `btrain doctor`.
 */
export function getRepoOrchestratorOptions(projectConfig) {
  const table = tableOf(tableOf(projectConfig?.slack).orchestrator)
  const section = "slack.orchestrator"
  const errors = []
  const listed = Object.hasOwn(table, "auto") ? stripTomlComment(table.auto) : undefined
  const autoResult = normalizeAutoList(listed)
  for (const message of autoResult.errors) errors.push({ key: `${section}.auto`, value: listed, message })
  return {
    auto: autoResult.auto,
    maxActive: readPositive(table, "max_active", REPO_ORCHESTRATOR_DEFAULTS.maxActive, errors, section),
    maxRounds: readPositive(table, "max_rounds", REPO_ORCHESTRATOR_DEFAULTS.maxRounds, errors, section),
    maxCommandsPerHour: readPositive(table, "max_commands_per_hour", REPO_ORCHESTRATOR_DEFAULTS.maxCommandsPerHour, errors, section),
    retryReviewPerHour: readPositive(table, "retry_review_per_hour", REPO_ORCHESTRATOR_DEFAULTS.retryReviewPerHour, errors, section),
    errors,
  }
}

/**
 * The repositories the listener serves (spec 025 FR-1), from the registered
 * ones the caller read: `repos` is `[{ path, name, config }]`, where `config`
 * is the repository's parsed project.toml. A repository is served when both
 * toggles are on and it has a channel from the map or the catch-all. Returns
 * `[{ path, name, channel, source, options }]` in the order given.
 */
export function servedRepositories(repos, settings) {
  const served = []
  for (const repo of Array.isArray(repos) ? repos : []) {
    if (!repo || typeof repo.path !== "string" || !repo.path) continue
    if (!isSlackEnabled(repo.config) || !isSlackListenEnabled(repo.config)) continue
    const { channel, source } = channelForRepo(settings, repo.path)
    if (!channel) continue
    served.push({ path: repo.path, name: String(repo.name || path.basename(repo.path)), channel, source, options: getRepoOrchestratorOptions(repo.config) })
  }
  return served
}
