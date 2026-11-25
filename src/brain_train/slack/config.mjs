// Spec 024 FR-1, FR-14, FR-16 and the plan's WS2: the publisher's settings.
//
// - The toggle: on only when `[features].slack` is exactly `true` (FR-1). A
//   missing table or key is off, unlike the older toggles. The same rule goes
//   into repo_mode.mjs in T007; this is the check slack/ itself uses.
// - `[slack]` options in project.toml, with defaults.
// - From the developer's `slack.json` (credentials.mjs reads it): the channel
//   for a repository by its registered path, else `defaultChannel`, else none
//   (FR-16); the developer label (FR-14); the mention list (FR-15).
//
// Imports nothing from core.mjs.

import os from "node:os"
import path from "node:path"
import { realpathSync } from "node:fs"
import { stripTomlComment } from "../review/review-config.mjs"

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

/** FR-1: on only when `[features].slack` is exactly `true`. */
export function isSlackEnabled(projectConfig) {
  const value = stripTomlComment(tableOf(projectConfig?.features).slack)
  // The project TOML parser keeps a comment after an unquoted value:
  // `slack = true # on` arrives as the text "true # on".
  return value === true || (typeof value === "string" && /^true\s+#/.test(value))
}

function readPositive(table, key, fallback, errors) {
  if (!Object.hasOwn(table, key)) return fallback
  const raw = stripTomlComment(table[key])
  // The project TOML parser keeps a comment after an unquoted number too.
  const textValue = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.replace(/\s+#.*$/, "").trim() : ""
  if (/^\d+$/.test(textValue) && Number(textValue) > 0 && Number.isSafeInteger(Number(textValue))) {
    return Number(textValue)
  }
  errors.push({ key: `slack.${key}`, value: raw, message: `[slack].${key} = ${JSON.stringify(raw)} is not a positive whole number; using the default ${fallback}.` })
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
