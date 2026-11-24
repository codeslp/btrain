// Spec 024 FR-7 and the plan's "Event kinds": a workflow event becomes one
// kind, a reply decision, a mention decision, and the fields its template
// needs. Pure. Imports nothing from core.mjs.
//
// The kind table is data: one row per kind, in order, and the first row whose
// `matches` holds wins. Every row posts a reply. An event no row matches (a
// change to reviewer context or the next action, a loop or history event)
// refreshes the card and posts no reply: kind `card-refresh`.
//
// Every field value is agent-writable or derived from agent-writable state
// (`--actor` takes any string), so every one goes through `prepareAgentText`
// here, once. The renderer only substitutes these prepared values.

import { prepareAgentText } from "./text.mjs"

export const DEFAULT_SUMMARY_CHARS = 200

export const PR_FLOW_STATUSES = Object.freeze(["ready-for-pr", "pr-review", "ready-to-merge"])

export const CARD_REFRESH = "card-refresh"

const isPrFlow = (status) => PR_FLOW_STATUSES.includes(status)
const statusOf = (snapshot) => (typeof snapshot?.status === "string" ? snapshot.status : "")
const keyOf = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "")

function facts(event) {
  const before = event?.before && typeof event.before === "object" ? event.before : {}
  const after = event?.after && typeof event.after === "object" ? event.after : {}
  const from = statusOf(before)
  const to = statusOf(after)
  return {
    type: String(event?.type || ""),
    before,
    after,
    from,
    to,
    statusChanged: Boolean(to) && from !== to,
    prLinked: Boolean(after.prNumber),
  }
}

function sameLocks(left, right) {
  const list = (value) => (Array.isArray(value) ? value.map(String).sort() : [])
  const a = list(left)
  const b = list(right)
  return a.length === b.length && a.every((item, index) => item === b[index])
}

const becomes = (status) => (f) => f.statusChanged && f.to === status

/**
 * The kind table (plan, "Event kinds"). `mention` is `never`, `always`, or a
 * function of the event facts. `dispatch-failed` is a synthetic event that
 * `offerDispatchFailure` builds (WS4); it mentions a person until spec 023's
 * request loop handles a failed dispatch.
 */
export const KIND_TABLE = Object.freeze([
  { kind: "claimed", trigger: "claim event", mention: "never", matches: (f) => f.type === "claim" },
  { kind: "sent-to-review", trigger: "status becomes needs-review", mention: "never", matches: becomes("needs-review") },
  { kind: "changes-requested", trigger: "status becomes changes-requested", mention: "never", matches: becomes("changes-requested") },
  {
    kind: "approved",
    trigger: "status becomes ready-for-pr, or resolved from needs-review",
    mention: "never",
    matches: (f) => becomes("ready-for-pr")(f) || (becomes("resolved")(f) && f.from === "needs-review"),
  },
  {
    kind: "pr-linked",
    trigger: "prNumber changes to a new value",
    mention: "never",
    matches: (f) => Boolean(f.after.prNumber) && String(f.after.prNumber) !== String(f.before.prNumber ?? ""),
  },
  {
    kind: "returned-to-pr",
    trigger: "status becomes pr-review from changes-requested",
    mention: "never",
    matches: (f) => becomes("pr-review")(f) && f.from === "changes-requested",
  },
  { kind: "ready-to-merge", trigger: "status becomes ready-to-merge", mention: "always", matches: becomes("ready-to-merge") },
  {
    kind: "merged",
    trigger: "status becomes resolved from a PR-flow status, or from changes-requested with a PR linked",
    mention: "never",
    matches: (f) => becomes("resolved")(f) && (isPrFlow(f.from) || (f.from === "changes-requested" && f.prLinked)),
  },
  {
    kind: "abandoned",
    trigger: "status becomes resolved from in-progress, or from changes-requested with no PR linked",
    mention: "never",
    matches: (f) => becomes("resolved")(f) && (f.from === "in-progress" || (f.from === "changes-requested" && !f.prLinked)),
  },
  {
    kind: "repair-needed",
    trigger: "status becomes repair-needed",
    mention: (f) => keyOf(f.after.repairEscalation) === "human",
    matches: becomes("repair-needed"),
  },
  {
    kind: "repair-cleared",
    trigger: "status becomes in-progress from repair-needed",
    mention: "never",
    matches: (f) => becomes("in-progress")(f) && f.from === "repair-needed",
  },
  {
    kind: "repair-resolved",
    trigger: "status becomes resolved from repair-needed",
    mention: "never",
    matches: (f) => becomes("resolved")(f) && f.from === "repair-needed",
  },
  { kind: "repair-disposition", trigger: "repair-disposition event", mention: "never", matches: (f) => f.type === "repair-disposition" },
  {
    kind: "roles-changed",
    trigger: "owner or reviewer changes",
    mention: "never",
    matches: (f) =>
      Boolean(f.after.owner || f.after.reviewer)
      && (keyOf(f.before.owner) !== keyOf(f.after.owner) || keyOf(f.before.reviewer) !== keyOf(f.after.reviewer)),
  },
  {
    kind: "locks-changed",
    trigger: "lock coverage changes",
    mention: "never",
    matches: (f) => Array.isArray(f.after.lockedFiles) && !sameLocks(f.before.lockedFiles, f.after.lockedFiles),
  },
  {
    kind: "override",
    trigger: "override-granted or override-consumed event",
    mention: "never",
    matches: (f) => f.type === "override-granted" || f.type === "override-consumed",
  },
  { kind: "watchdog", trigger: "watchdog-repair event", mention: "never", matches: (f) => f.type === "watchdog-repair" },
  { kind: "dispatch-failed", trigger: "offered by finishPatchWithReviewerDispatch", mention: "always", matches: (f) => f.type === "dispatch-failed" },
  { kind: "status-changed", trigger: "any other change of status", mention: "never", matches: (f) => f.statusChanged },
].map((row) => Object.freeze(row)))

export const KINDS = Object.freeze([...KIND_TABLE.map((row) => row.kind), CARD_REFRESH])

function pickSummary(event) {
  const details = event?.details && typeof event.details === "object" ? event.details : {}
  return details.summary ?? details.message ?? ""
}

/**
 * The fields a reply template may use, each prepared once. A template that
 * names a field not listed here renders nothing for it (see render.mjs).
 */
export function buildEventFields(event, { summaryChars = DEFAULT_SUMMARY_CHARS } = {}) {
  const f = facts(event)
  const details = event?.details && typeof event.details === "object" ? event.details : {}
  const lockCount = Array.isArray(f.after.lockedFiles) ? f.after.lockedFiles.length : 0
  const raw = {
    lane: event?.laneId || f.after.lane || "",
    actor: event?.actor || "",
    owner: f.after.owner || "",
    reviewer: f.after.reviewer || "",
    fromStatus: f.from,
    toStatus: f.to,
    prNumber: f.after.prNumber || "",
    reasonCode: f.after.reasonCode || details.reasonCode || "",
    repairOwner: f.after.repairOwner || "",
    summary: pickSummary(event),
    lockCount: `${lockCount} ${lockCount === 1 ? "file" : "files"}`,
    overrideAction: details.action || "",
    overrideVerb: f.type === "override-consumed" ? "used" : f.type === "override-granted" ? "granted" : "",
    watchdogType: details.repairType || "",
    disposition: details.disposition || "",
    outcome: f.to === "ready-for-pr" ? "ready for PR" : f.to === "resolved" ? "lane resolved" : f.to,
  }
  const fields = {}
  for (const [name, value] of Object.entries(raw)) {
    fields[name] = prepareAgentText(value, name === "summary" ? { maxChars: summaryChars } : { maxChars: 200 })
  }
  return fields
}

/**
 * A workflow event to `{ kind, reply, mention, fields }`. `reply` is false only
 * for `card-refresh`. `mention` is a decision; the renderer adds the
 * configured IDs.
 */
export function classifyWorkflowEvent(event, options = {}) {
  const f = facts(event)
  const row = KIND_TABLE.find((candidate) => candidate.matches(f))
  const fields = buildEventFields(event, options)
  if (!row) {
    return { kind: CARD_REFRESH, reply: false, mention: false, fields }
  }
  const mention = row.mention === "always" ? true : typeof row.mention === "function" ? Boolean(row.mention(f)) : false
  return { kind: row.kind, reply: true, mention, fields }
}
