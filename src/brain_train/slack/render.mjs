// Spec 024 FR-6, FR-7, FR-9, FR-13, FR-15: the card, the reply line of each
// kind, and the board. Pure. Imports nothing from core.mjs.
//
// Templates are data: strings with `{field}` placeholders. A placeholder is
// filled only from a field set that this module or events.mjs built with
// `prepareAgentText`, so no agent-written text reaches a message unescaped.
// `test/slack-render.test.mjs` checks that every placeholder of every template
// names a prepared field.
//
// btrain writes two kinds of markup itself, never from agent text: a mention
// of a configured ID (`<@U…>`) and the PR link of the `ready-to-merge` reply
// (`<https://github.com/…/pull/N|PR #N>`). Each is checked against a strict
// shape before it is written.
//
// Repository name and developer label on every reply are WS5 (T025); the card
// carries both here, as FR-6 orders its fields.

import { capMessage, prepareAgentText } from "./text.mjs"
import { CARD_REFRESH, KIND_TABLE } from "./events.mjs"

export const DEFAULT_TASK_CHARS = 300

// FR-6 field order; FR-13 labels. One line per string.
export const CARD_LINES = Object.freeze([
  "{repo} · lane {lane} · {status}",
  "dev: {label}",
  "task: {task}",
  "owner: {owner}    reviewer: {reviewer}{tier}",
  "pr: {pr}    locks: {lockCount}",
  "updated: {updated}",
])

export const CARD_FIELDS = Object.freeze(["repo", "lane", "status", "label", "task", "owner", "reviewer", "tier", "pr", "lockCount", "updated"])

// One reply template per kind. A ` · ` segment whose placeholders are all
// empty is dropped, so a missing reason code leaves no empty segment.
export const REPLY_TEMPLATES = Object.freeze({
  claimed: "{actor} claimed lane {lane}",
  "sent-to-review": "sent to review · reviewer {reviewer}",
  "changes-requested": "{actor} requested changes · {reasonCode} · \"{summary}\"",
  approved: "approved · {outcome}",
  "pr-linked": "PR #{prNumber} linked",
  "returned-to-pr": "changes pushed · PR #{prNumber} back in review",
  "ready-to-merge": "PR #{prNumber} clear · ready to merge",
  merged: "merged · lane resolved",
  abandoned: "lane resolved without a PR",
  "repair-needed": "needs repair · {reasonCode} · repair owner {repairOwner}",
  "repair-cleared": "repair cleared · back in progress",
  "repair-resolved": "lane resolved from repair",
  "repair-disposition": "repair disposition · {disposition}",
  "roles-changed": "owner {owner} · reviewer {reviewer}",
  "locks-changed": "locks now {lockCount}",
  override: "{actor} {overrideVerb} override · {overrideAction}",
  watchdog: "watchdog repair · {watchdogType}",
  "dispatch-failed": "reviewer dispatch failed · {reviewer}",
  "status-changed": "status {fromStatus} → {toStatus}",
})

// The fields events.mjs prepares (buildEventFields).
export const REPLY_FIELDS = Object.freeze([
  "lane", "actor", "owner", "reviewer", "fromStatus", "toStatus", "prNumber", "reasonCode", "repairOwner",
  "summary", "lockCount", "overrideAction", "overrideVerb", "watchdogType", "disposition", "outcome",
])

export const BOARD_HEADER = "board · dev: {label}"
export const BOARD_REPO_LINE = "{repo}{stale}"
export const BOARD_LANE_LINE = "  lane {lane} · {status} · owner: {owner} · reviewer: {reviewer} · pr: {pr}"
export const BOARD_EMPTY_LINE = "  no active lanes"
export const BOARD_FIELDS = Object.freeze(["label", "repo", "stale", "lane", "status", "owner", "reviewer", "pr"])

// Statuses a board does not list.
const INACTIVE_STATUSES = new Set(["", "idle", "resolved"])

const MENTION_ID = /^[UW][A-Z0-9]{2,20}$/
const GITHUB_PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/pull\/(\d{1,9})$/

/** The `{name}` placeholders of a template, in order. */
export function templateFields(template) {
  return [...String(template).matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1])
}

function fill(template, fields) {
  return String(template).replace(/\{([A-Za-z]+)\}/g, (_, name) => (Object.hasOwn(fields, name) ? String(fields[name]) : ""))
}

// Drop the ` · ` segments whose placeholders are all empty.
function fillSegments(template, fields) {
  const kept = []
  for (const segment of String(template).split(" · ")) {
    const names = templateFields(segment)
    if (names.length > 0 && names.every((name) => !fields[name])) continue
    kept.push(fill(segment, fields))
  }
  return kept.join(" · ")
}

function formatUpdated(lastUpdated) {
  const match = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(lastUpdated || ""))
  return match ? `${match[1]} ${match[2]} UTC` : "unknown"
}

function lockCountText(lockedFiles) {
  const count = Array.isArray(lockedFiles) ? lockedFiles.length : 0
  return `${count} ${count === 1 ? "file" : "files"}`
}

function displayStatus(lane) {
  return lane?.display || lane?.displayStatus || lane?.status || "unknown"
}

/** The card's fields from current lane state, each prepared once. */
export function buildCardFields(lane = {}, context = {}) {
  const tier = lane.reviewTier || context.reviewTier || ""
  const raw = {
    repo: context.repoName || "repository",
    lane: lane.lane || lane.laneId || context.laneId || "",
    status: displayStatus(lane),
    label: context.label || "",
    task: lane.task || "",
    owner: lane.owner || "none",
    reviewer: lane.reviewer || "none",
    pr: lane.prNumber ? `#${lane.prNumber}` : "none",
    lockCount: lockCountText(lane.lockedFiles),
    updated: formatUpdated(lane.lastUpdated),
  }
  const fields = {}
  for (const [name, value] of Object.entries(raw)) {
    fields[name] = prepareAgentText(value, { maxChars: name === "task" ? context.taskChars || DEFAULT_TASK_CHARS : 200, singleLine: true })
  }
  fields.tier = tier ? ` (${prepareAgentText(tier, { maxChars: 40, singleLine: true })})` : ""
  return fields
}

/** The card: the thread's top message, rendered from current lane state (FR-6). */
export function renderCard(lane, context = {}) {
  const fields = buildCardFields(lane, context)
  return capMessage(CARD_LINES.map((line) => fill(line, fields)).join("\n"))
}

function mentionPrefix(context) {
  const ids = Array.isArray(context.mention) ? context.mention.map(String).filter((id) => MENTION_ID.test(id)) : []
  return ids.length > 0 ? `${ids.map((id) => `<@${id}>`).join(" ")} ` : ""
}

function prLink(context) {
  const match = GITHUB_PR_URL.exec(String(context.prUrl || ""))
  if (!match) return ""
  return ` · <${context.prUrl}|PR #${match[1]}>`
}

/**
 * One reply line for a classified event (FR-7), or "" for `card-refresh`.
 * A mention is written only when the kind's row decided one and a configured
 * ID has the shape of a Slack user ID. The PR link is written only for
 * `ready-to-merge` and only for a GitHub pull request URL.
 */
export function renderReply(classified, context = {}) {
  const kind = classified?.kind
  if (!kind || kind === CARD_REFRESH || !Object.hasOwn(REPLY_TEMPLATES, kind)) {
    return ""
  }
  const fields = classified.fields && typeof classified.fields === "object" ? classified.fields : {}
  const line = fillSegments(REPLY_TEMPLATES[kind], fields)
  const link = kind === "ready-to-merge" ? prLink(context) : ""
  const mention = classified.mention ? mentionPrefix(context) : ""
  return capMessage(`${mention}${line}${link}`)
}

/**
 * The board for one developer in one channel (FR-9): active lanes grouped by
 * repository. `repos` is `[{ repoName, lanes, stale }]`; a repository whose
 * state could not be read keeps its last lanes with `stale: true`.
 */
export function renderBoard(repos = [], context = {}) {
  const lines = [fill(BOARD_HEADER, { label: prepareAgentText(context.label || "", { maxChars: 80, singleLine: true }) })]
  for (const repo of Array.isArray(repos) ? repos : []) {
    lines.push(fill(BOARD_REPO_LINE, {
      repo: prepareAgentText(repo?.repoName || "repository", { maxChars: 120, singleLine: true }),
      stale: repo?.stale ? " (not refreshed)" : "",
    }))
    const active = (Array.isArray(repo?.lanes) ? repo.lanes : []).filter((lane) => !INACTIVE_STATUSES.has(lane?.status || ""))
    if (active.length === 0) {
      lines.push(BOARD_EMPTY_LINE)
      continue
    }
    for (const lane of active) {
      const fields = {}
      for (const [name, value] of Object.entries({
        lane: lane.lane || lane.laneId || "",
        status: displayStatus(lane),
        owner: lane.owner || "none",
        reviewer: lane.reviewer || "none",
        pr: lane.prNumber ? `#${lane.prNumber}` : "none",
      })) {
        fields[name] = prepareAgentText(value, { maxChars: 120, singleLine: true })
      }
      lines.push(fill(BOARD_LANE_LINE, fields))
    }
  }
  return capMessage(lines.join("\n"))
}

/** Every kind of the table has a reply template; used by the tests. */
export function kindsWithoutTemplate() {
  return KIND_TABLE.map((row) => row.kind).filter((kind) => !Object.hasOwn(REPLY_TEMPLATES, kind))
}
