const ACTIVE_STATUSES = [
  "in-progress",
  "needs-review",
  "changes-requested",
  "ready-for-pr",
  "pr-review",
  "ready-to-merge",
  "repair-needed",
]
const PR_FLOW_STATUSES = ["ready-for-pr", "pr-review", "ready-to-merge"]
const ALL_STATUSES = ["idle", ...ACTIVE_STATUSES, "resolved"]

const PRIMARY_STATUSES_BY_ACTION = Object.freeze({
  Claim: ["idle", "resolved"],
  ToNeedsReview: ["in-progress", "changes-requested"],
  PeerResolve: ["needs-review"],
  LinkPr: ["ready-for-pr"],
  PrRepoll: ["pr-review"],
  PrTerminal: ["ready-to-merge"],
  RepairClear: ["repair-needed"],
})

function row(id, action, event, from, to, actor, guard, locks, owner, state, kind = "contract") {
  const primary = Object.freeze([...(PRIMARY_STATUSES_BY_ACTION[action] || [])])
  return Object.freeze({ id, action, event, from, to, actor, guard, locks, owner, state, kind, primary })
}

export const TRANSITION_ROWS = Object.freeze([
  row("1", "Claim", "handoff claim", ["idle", "resolved"], "in-progress", "any-agent", "files; conflicts; distinct reviewer", "acquire", "002 Lock Enforcement and CLI Commands", "designated"),
  row("2", "ToNeedsReview", "handoff update --status", ["in-progress", "changes-requested"], "needs-review", "owner", "review context and diff", "retain", "005 Proposed Status Model and FR-7 (owner-only clause)", "designated"),
  row("3", "RequestChanges", "handoff request-changes", ["needs-review"], "changes-requested", "reviewer", "reason code", "retain", "005 FR-8 and FR-15", "designated"),
  row("4", "PeerResolve", "handoff resolve", ["needs-review"], "ready-for-pr", "reviewer", "PR flow enabled; lane covered", "retain", "002 Lock Enforcement and PR-flow row 1", "designated"),
  row("5", "TerminalResolve", "handoff resolve", ["needs-review"], "resolved", "reviewer", "PR flow disabled", "release", "002 Lock Enforcement item 2", "designated"),
  row("6", "AbandonResolve", "handoff resolve", ["in-progress", "changes-requested"], "resolved", "lane-agent", "no linked PR", "release", "002 CLI Commands, resolve authority (Q5)", "designated"),
  row("7", "LinkPr", ["pr-create", "handoff update --status"], ["ready-for-pr"], "pr-review", "owner", "PR number", "retain", "002 PR-flow row 2", "designated"),
  row("8", "PrRepoll", "pr-poll", ["pr-review", "ready-to-merge", "changes-requested"], "pr-review", "system", "linked PR; PR-flow changes-requested", "retain", "002 PR-flow states (non-terminal outcomes)", "designated"),
  row("9", "PrFeedback", "pr-poll", ["pr-review", "ready-to-merge", "changes-requested"], "changes-requested", "system", "linked PR and feedback reason; PR-flow changes-requested", "retain", "002 PR-flow row 4", "designated"),
  row("10", "PrClear", "pr-poll", ["pr-review", "ready-to-merge", "changes-requested"], "ready-to-merge", "system", "linked PR; PR-flow changes-requested", "retain", "002 PR-flow row 3 (non-terminal outcomes)", "designated"),
  row("11", "PrTerminal", "pr-poll", [...PR_FLOW_STATUSES, "changes-requested"], "resolved", "system", "linked PR", "release", "002 PR-flow rows 5 and 6", "designated"),
  row("12", "ReturnToPr", "handoff update --status", ["changes-requested"], "pr-review", "owner", "linked PR; PR-flow changes-requested", "retain", "002 PR-flow changes-requested row (Q1)", "designated"),
  row("13", "RepairEnter", ["handoff update --status", "watchdog-repair"], ACTIVE_STATUSES, "repair-needed", "any-agent or system", "reason and repair accounting", "retain", "006 FR-4, FR-20, and FR-29 entry authority (Q7)", "designated"),
  row("14", "RepairClear", "handoff update --status", ["repair-needed"], "in-progress", "repair-owner, system, or override", "none", "retain", "006 FR-15 and FR-29 exit to in-progress", "designated"),
  row("15", "RepairResolve", "handoff resolve", ["repair-needed"], "resolved", "lane-agent or override", "human disposition or override", "release", "006 FR-29 (Q3)", "designated"),
  row("16", "Rescope", "handoff update --files", ["in-progress", "changes-requested", "repair-needed"], "$same", "owner, system, or override", "non-empty and no conflict", "replace", "014 rescope designation; 006 FR-20", "designated"),
  row("17", "Resync", ["handoff update --files", "doctor repair"], ACTIVE_STATUSES, "$same", "owner or system", "no conflict; set equals record", "restore", "006 FR-2 resync authority; 014 rescope/resync split (Q2)", "designated"),
  row("18", "ForceRelease", ["locks release", "locks release-lane"], ACTIVE_STATUSES, "$same", "override", "consumed override", "suspend", "002 Force-release override", "designated"),
  row("19", "MetadataUpdate", "handoff update --metadata", "$any", "$same", "lane-agent", "none", "unchanged", "002 CLI Commands, update authority", "designated"),
  row("20", "Reassign", "handoff update --reassign", ["in-progress", "needs-review", "changes-requested"], "$same", "reassign authority", "distinct owner and reviewer; no prior author as reviewer; no linked PR", "unchanged", "005 FR-5 reassignment (Q8, swap policy A-i)", "designated"),

  row("L1", "legacy", "handoff resolve", [...PR_FLOW_STATUSES, "changes-requested"], "resolved", "any", "PR flow or linked changes-requested", "release", "forbidden by 002 Lock Enforcement", "advisory", "legacy"),
  row("L2", "legacy", "handoff resolve", ["idle"], "resolved", "any", "none", "none", "forbidden by 002 CLI Commands", "advisory", "legacy"),
  row("L3", "legacy", "handoff update --status", ACTIVE_STATUSES, "needs-review", "any", "actor unchecked", "retain", "forbidden by 005 FR-5 and FR-7", "advisory", "legacy"),
  row("L4", "legacy", "handoff update --status", "$any", "$any", "any", "valid status", "per target", "forbidden by 002 and 014", "advisory", "legacy"),
  row("L5", "legacy", "pr-poll", "$any", "$any", "system", "linked PR or stale locks", "retain", "forbidden by 002 PR-flow states", "advisory", "legacy"),
  row("L6", "legacy", ["handoff update --files", "doctor repair"], "$any", "$same", "any", "current behavior", "replace or release", "forbidden by 014 rescope and resync designations (Q2)", "advisory", "legacy"),
  row("L7", "legacy", "handoff resolve", ["repair-needed"], "resolved", "any", "row 15 guard unmet", "release", "forbidden by 006 FR-29", "advisory", "legacy"),
  row("L8", "legacy", "handoff resolve", ["needs-review"], ["ready-for-pr", "resolved"], "any", "actor is not the recorded reviewer", "retain or release", "forbidden by 002 PR-flow row 1", "advisory", "legacy"),
  row("L9", "legacy", "handoff resolve", ["needs-review"], "ready-for-pr", "reviewer", "lane uncovered", "reacquire", "forbidden by 002 Force-release override", "advisory", "legacy"),
  row("L10", "legacy", "handoff update --reassign", "$any", "$same", "any", "actor unchecked", "unchanged", "forbidden by 005 FR-5 reassignment (Q8)", "advisory", "legacy"),
  row("L11", "legacy", "handoff resolve", ["in-progress", "changes-requested"], "resolved", "any", "actor unchecked", "release", "forbidden by 002 CLI Commands resolve authority (Q5)", "advisory", "legacy"),
  row("L12", "legacy", "handoff update --metadata", "$any", "$same", "any", "actor unchecked", "unchanged", "forbidden by 002 CLI Commands update authority", "advisory", "legacy"),
  row("L13", "legacy", "handoff claim", "$any", "in-progress", "any-agent", "single-handoff overwrite", "none", "forbidden by 002 CLI Commands claim authority", "advisory", "legacy"),
  row("L14", "legacy", "handoff resolve", ["resolved"], "resolved", "any", "repeat resolve", "none", "forbidden by 002 CLI Commands resolve authority", "advisory", "legacy"),
  row("L15", "legacy", "handoff request-changes", ["needs-review"], "changes-requested", "any", "reviewer absent or unverified", "retain", "forbidden by 002 CLI Commands and 005 FR-8", "advisory", "legacy"),
  row("L16", "WatchdogLockRelease", "watchdog-lock-release", "$any", "$same", "system", "stale or expired lock", "release", "006 FR-2 safe repair", "designated", "system"),
])

function asArray(value) {
  return Array.isArray(value) ? value : [value]
}

function matchesValue(rule, actual, current) {
  if (rule === "$any") return true
  if (rule === "$same") return actual === current
  return asArray(rule).includes(actual)
}

function matchesEvent(rule, event) {
  return asArray(rule).includes(event)
}

function actorMatches(rowValue, state, actor, input = {}) {
  const normalized = String(actor || "").toLowerCase()
  const owner = String(state.owner || "").toLowerCase()
  const reviewer = String(state.reviewer || "").toLowerCase()
  if (rowValue === "owner") return !!normalized && normalized === owner
  if (rowValue === "reviewer") return !!normalized && normalized === reviewer
  if (rowValue === "lane-agent") return !!normalized && [owner, reviewer].includes(normalized)
  if (rowValue === "lane-agent or override") {
    return (!!normalized && [owner, reviewer].includes(normalized)) || input.override === true
  }
  if (rowValue === "reassign authority") {
    // spec 005 FR-5 (Q8 Option C): the owner reassigns the owner; either lane
    // agent reassigns the reviewer.
    const isOwner = !!normalized && normalized === owner
    const isLaneAgent = !!normalized && [owner, reviewer].includes(normalized)
    if (input.ownerChanged === true) return isOwner
    return isLaneAgent
  }
  if (rowValue === "owner, system, or override") {
    // spec 014 rescope designation with spec 006 FR-20: the owner during
    // in-progress and changes-requested; only a system actor or an audited
    // override during repair-needed.
    if (state.status === "repair-needed") return input.systemEvent === true || input.override === true
    return !!normalized && normalized === owner
  }
  if (rowValue === "repair-owner, system, or override") {
    // spec 006 FR-15: the recorded repair owner clears the repair; a system
    // actor or an audited override may clear it when responsibility failed.
    const repairOwner = String(state.repairOwner || "").toLowerCase()
    return (!!normalized && normalized === repairOwner) || input.systemEvent === true || input.override === true
  }
  if (rowValue === "owner or system") {
    // spec 006 FR-2 / spec 014 resync split (Q2 Option B): the owner in any
    // active status; the doctor (an internal system event) only outside
    // review and the PR flow.
    if (input.systemEvent === true) {
      return ["in-progress", "changes-requested", "repair-needed"].includes(state.status)
    }
    return !!normalized && normalized === owner
  }
  return true
}

function optionalFlag(input, name) {
  return input[name] === undefined || input[name] === true
}

function guardMatches(rowValue, state, input) {
  const guards = {
    "none": () => true,
    "files; conflicts; distinct reviewer": () =>
      optionalFlag(input, "filesNonEmpty")
      && optionalFlag(input, "noConflict")
      && optionalFlag(input, "distinctReviewer"),
    "review context and diff": () =>
      optionalFlag(input, "reviewContextComplete") && optionalFlag(input, "diffPresent"),
    "reason code": () => input.reasonCode === undefined || !!input.reasonCode,
    "PR flow enabled": () => input.prFlowEnabled === true,
    // spec 002 Force-release override: local approval does not re-acquire
    // suspended coverage; an uncovered lane falls to L9 until claim or rescope.
    "PR flow enabled; lane covered": () => input.prFlowEnabled === true && input.laneCovered !== false,
    "PR flow disabled": () => input.prFlowEnabled !== true,
    "no linked PR": () => !input.prLinked,
    "PR number": () => input.prLinked === true,
    "linked PR": () => input.prLinked === true,
    // spec 002 PR-flow states: "PR-flow changes-requested" is the
    // changes-requested entered by pr-poll feedback (reason
    // `pr-review-feedback`) while local approval still stands. Callers pass
    // prFlowChangesRequested from the source lane's reason code; a local
    // request-changes withdraws it.
    "linked PR; PR-flow changes-requested": () =>
      input.prLinked === true
      && (state.status !== "changes-requested" || input.prFlowChangesRequested === true),
    "linked PR and feedback reason": () =>
      input.prLinked === true && (input.feedbackReason === undefined || !!input.feedbackReason),
    "linked PR and feedback reason; PR-flow changes-requested": () =>
      input.prLinked === true
      && (input.feedbackReason === undefined || !!input.feedbackReason)
      && (state.status !== "changes-requested" || input.prFlowChangesRequested === true),
    "reason and repair accounting": () =>
      optionalFlag(input, "reasonPresent") && optionalFlag(input, "repairAccountingValid"),
    "human disposition or override": () => !!(input.humanDisposition || input.override),
    "non-empty and no conflict": () =>
      input.filesChanged !== false
      && optionalFlag(input, "filesNonEmpty")
      && optionalFlag(input, "noConflict"),
    "no conflict": () => optionalFlag(input, "noConflict"),
    // spec 014 rescope/resync split: a resync keeps the recorded set; a
    // different set is a rescope (row 16) or, outside its statuses, L6.
    "no conflict; set equals record": () => input.filesChanged !== true && optionalFlag(input, "noConflict"),
    "PR flow or linked changes-requested": () => state.status !== "changes-requested" || input.prLinked === true,
    "consumed override": () => !!input.override,
    "distinct owner and reviewer": () => optionalFlag(input, "distinctReviewer"),
    "distinct owner and reviewer; no prior author as reviewer; no linked PR": () =>
      optionalFlag(input, "distinctReviewer")
      && input.reviewerIsPriorAuthor !== true
      && !input.prLinked,
    "actor unchecked": () => true,
    // L8 covers approval by anyone other than the recorded reviewer. When the
    // reviewer acts and row 4 still rejected, the cause is suspended coverage,
    // which is L9's case.
    "actor is not the recorded reviewer": () =>
      String(input.actor || "").toLowerCase() !== String(state.reviewer || "").toLowerCase()
      || !input.actor,
    "valid status": () => ALL_STATUSES.includes(input.to ?? state.status),
    "linked PR or stale locks": () =>
      input.prLinked === true
      || input.staleLocks === true
      || (input.prLinked === undefined && input.staleLocks === undefined),
    "current behavior": () => true,
    // L7 is the fallback for every repair-needed resolve that row 15 did not
    // accept: no human decision, or a decision presented by an actor row 15
    // does not authorize (a non-lane agent with a disposition). Rows are
    // evaluated in order, so reaching L7 already means row 15 rejected.
    "row 15 guard unmet": () => true,
    "lane uncovered": () => input.laneCovered !== true,
    "single-handoff overwrite": () => true,
    "repeat resolve": () => state.status === "resolved",
    "reviewer absent or unverified": () =>
      !state.reviewer || !input.actor || input.reviewerVerified === false,
    "stale or expired lock": () =>
      input.staleLocks === true
      || input.expiredLocks === true
      || (input.staleLocks === undefined && input.expiredLocks === undefined),
  }
  return guards[rowValue]?.() ?? false
}

function rowMatches(candidate, state, event, input) {
  const target = input.to ?? state.status
  return matchesEvent(candidate.event, event)
    && matchesValue(candidate.from, state.status, state.status)
    && matchesValue(candidate.to, target, state.status)
    && (input.structuralCompatibility === true && candidate.action === "LinkPr"
      ? true
      : actorMatches(candidate.actor, state, input.actor, input))
    && guardMatches(candidate.guard, state, input)
}

export function applyTransition(state, event, input = {}) {
  const current = state && typeof state === "object" ? state : {}
  const target = input.to ?? current.status
  const candidate = TRANSITION_ROWS.find((entry) => rowMatches(entry, current, event, input))
  if (!candidate) {
    throw new Error(`No transition row matches ${event}: ${current.status || "(unknown)"} -> ${target || "(unknown)"}`)
  }
  return {
    row: candidate,
    next: {
      ...current,
      ...(input.changes || {}),
      status: target,
    },
  }
}

// spec 015 FR-5: a legacy row in advisory mode is still accepted, but the
// caller records `transition-advisory: <row id>` on the workflow event and
// warns. Since spec 016 WS4 every remaining legacy row is in advisory (L8 was
// first, WS3 added L3 and L7).
export function advisoryRowId(row, state = {}, input = {}) {
  if (!row || row.kind !== "legacy") return ""
  const target = input.to ?? state.status
  // spec 006 FR-29: the only exits from repair-needed are RepairClear (row
  // 14) and RepairResolve (row 15). Any legacy status change leaving
  // repair-needed is the L4 exit case, even when an earlier legacy row (L3)
  // matched first.
  if (state.status === "repair-needed" && target !== state.status && row.event === "handoff update --status") return "L4"
  if (row.state === "advisory") return row.id
  return ""
}

// spec 015 FR-5: one warning shape for every advisory legacy row without a
// bespoke message. `detail` names the designated rule the request missed.
export function formatAdvisoryWarning(rowId, { event, from, to, actor, detail }) {
  const move = to && to !== from ? `\`${from} -> ${to}\`` : `\`${from}\``
  return `warning: transition-advisory ${rowId}: ${event} ${move} by \`${actor || "unknown"}\` is outside the designated contract${detail ? ` (${detail})` : ""}. Enforcement lands after the spec 015 FR-5 advisory window.`
}

export function getPrimaryTransition(status) {
  return TRANSITION_ROWS.find((entry) => entry.primary.includes(status)) || null
}

export function classifyTransitionEvent(options, currentStatus, nextStatus) {
  if (options.transitionEvent) return options.transitionEvent
  if (options.status !== undefined && nextStatus !== currentStatus) return "handoff update --status"
  if (options.files !== undefined) return "handoff update --files"
  if (options.owner !== undefined || options.reviewer !== undefined) return "handoff update --reassign"
  return "handoff update --metadata"
}

function expandedSources(from) {
  if (from === "$any") return ALL_STATUSES
  return asArray(from)
}

function expandedTargets(to, source) {
  if (to === "$any") return ALL_STATUSES
  if (to === "$same") return [source]
  return asArray(to)
}

export function formatTransitionsMermaid(rows = TRANSITION_ROWS) {
  const lines = ["stateDiagram-v2"]
  for (const entry of rows) {
    for (const source of expandedSources(entry.from)) {
      for (const target of expandedTargets(entry.to, source)) {
        lines.push(`  ${source} --> ${target}: ${entry.id} ${entry.action}`)
      }
    }
  }
  return `${lines.join("\n")}\n`
}
