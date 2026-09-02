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
  row("2", "ToNeedsReview", "handoff update --status", ["in-progress", "changes-requested"], "needs-review", "owner", "review context and diff", "retain", "005 Proposed Status Model and FR-7", "provisional"),
  row("3", "RequestChanges", "handoff request-changes", ["needs-review"], "changes-requested", "reviewer", "reason code", "retain", "005 FR-8 and FR-15", "designated"),
  row("4", "PeerResolve", "handoff resolve", ["needs-review"], "ready-for-pr", "reviewer", "PR flow enabled", "retain", "002 Lock Enforcement and PR-flow row 1", "designated"),
  row("5", "TerminalResolve", "handoff resolve", ["needs-review"], "resolved", "reviewer", "PR flow disabled", "release", "002 Lock Enforcement item 2", "designated"),
  row("6", "AbandonResolve", "handoff resolve", ["in-progress", "changes-requested"], "resolved", "lane-agent", "no linked PR", "release", "LaneLock.tla and 002 Lock Enforcement", "undesignated"),
  row("7", "LinkPr", ["pr-create", "handoff update --status"], ["ready-for-pr"], "pr-review", "owner", "PR number", "retain", "002 PR-flow row 2", "designated"),
  row("8", "PrRepoll", "pr-poll", ["pr-review"], "pr-review", "system", "linked PR", "retain", "002 PR-flow states", "designated"),
  row("9", "PrFeedback", "pr-poll", ["pr-review", "ready-to-merge"], "changes-requested", "system", "linked PR and feedback reason", "retain", "002 PR-flow row 4", "designated"),
  row("10", "PrClear", "pr-poll", ["pr-review"], "ready-to-merge", "system", "linked PR", "retain", "002 PR-flow row 3", "designated"),
  row("11", "PrTerminal", "pr-poll", [...PR_FLOW_STATUSES, "changes-requested"], "resolved", "system", "linked PR", "release", "002 PR-flow rows 5 and 6", "designated"),
  row("12", "ReturnToPr", "handoff update --status", ["changes-requested"], "pr-review", "owner", "linked PR and feedback reason", "retain", "none", "undesignated"),
  row("13", "RepairEnter", ["handoff update --status", "watchdog-repair"], ACTIVE_STATUSES, "repair-needed", "any-agent or system", "reason and repair accounting", "retain", "006 FR-4 and FR-20; 014 designation", "provisional"),
  row("14", "RepairClear", "handoff update --status", ["repair-needed"], "in-progress", "repair-owner, system, or override", "none", "retain", "006 FR-15; 014 designation", "provisional"),
  row("15", "RepairResolve", "handoff resolve", ["repair-needed"], "resolved", "lane-agent or override", "human disposition or override", "release", "014 designation; 006 FR-29", "provisional"),
  row("16", "Rescope", "handoff update --files", ["in-progress", "changes-requested", "repair-needed"], "$same", "owner, system, or override", "non-empty and no conflict", "replace", "014 rescope; 006 FR-20", "provisional"),
  row("17", "Resync", ["handoff update --files", "doctor repair"], ACTIVE_STATUSES, "$same", "owner or system", "no conflict", "restore", "006 FR-2", "undesignated"),
  row("18", "ForceRelease", ["locks release", "locks release-lane"], ACTIVE_STATUSES, "$same", "override", "consumed override", "suspend", "002 Force-release override", "designated"),
  row("19", "MetadataUpdate", "handoff update --metadata", "$any", "$same", "lane-agent", "none", "unchanged", "none", "undesignated"),
  row("20", "Reassign", "handoff update --reassign", ACTIVE_STATUSES, "$same", "lane-agent", "distinct owner and reviewer", "unchanged", "005 FR-5", "undesignated"),

  row("L1", "legacy", "handoff resolve", [...PR_FLOW_STATUSES, "changes-requested"], "resolved", "any", "none", "release", "forbidden by 002 Lock Enforcement", "legacy", "legacy"),
  row("L2", "legacy", "handoff resolve", ["idle"], "resolved", "any", "none", "none", "forbidden by 002 CLI Commands", "legacy", "legacy"),
  row("L3", "legacy", "handoff update --status", ACTIVE_STATUSES, "needs-review", "any", "actor unchecked", "retain", "forbidden by 005 FR-5 and FR-7", "legacy", "legacy"),
  row("L4", "legacy", "handoff update --status", "$any", "$any", "any", "valid status", "per target", "forbidden by 002 and 014", "legacy", "legacy"),
  row("L5", "legacy", "pr-poll", "$any", "$any", "system", "linked PR or stale locks", "retain", "forbidden by 002 PR-flow states", "legacy", "legacy"),
  row("L6", "legacy", "handoff update --files", "$any", "$same", "any", "current behavior", "replace or release", "forbidden by 014 rescope", "legacy", "legacy"),
  row("L7", "legacy", "handoff resolve", ["repair-needed"], "resolved", "any", "row 15 guard unmet", "release", "forbidden by 014 and 006 FR-29", "legacy", "legacy"),
  row("L8", "legacy", "handoff resolve", ["needs-review"], ["ready-for-pr", "resolved"], "any", "actor unchecked", "retain or release", "forbidden by 002 PR-flow row 1", "legacy", "legacy"),
  row("L9", "legacy", "handoff resolve", ["needs-review"], "ready-for-pr", "any", "lane uncovered", "reacquire", "forbidden by 002 Force-release override", "legacy", "legacy"),
  row("L10", "legacy", "handoff update --reassign", "$any", "$same", "any", "actor unchecked", "unchanged", "open question 8", "legacy", "legacy"),
  row("L11", "legacy", "handoff resolve", ["in-progress", "changes-requested"], "resolved", "any", "actor unchecked", "release", "open question 5", "legacy", "legacy"),
  row("L12", "legacy", "handoff update --metadata", "$any", "$same", "any", "actor unchecked", "unchanged", "row 19 fallback", "legacy", "legacy"),
  row("L13", "legacy", "handoff claim", "$any", "in-progress", "any-agent", "single-handoff overwrite", "none", "undesignated", "legacy", "legacy"),
  row("L14", "legacy", "handoff resolve", ["resolved"], "resolved", "any", "repeat resolve", "none", "undesignated", "legacy", "legacy"),
  row("L15", "legacy", "handoff request-changes", ["needs-review"], "changes-requested", "any", "reviewer absent or unverified", "retain", "005 FR-8 fallback", "legacy", "legacy"),
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

function actorMatches(rowValue, state, actor) {
  const normalized = String(actor || "").toLowerCase()
  const owner = String(state.owner || "").toLowerCase()
  const reviewer = String(state.reviewer || "").toLowerCase()
  if (rowValue === "owner") return !!normalized && normalized === owner
  if (rowValue === "reviewer") return !!normalized && normalized === reviewer
  if (rowValue === "lane-agent") return !!normalized && [owner, reviewer].includes(normalized)
  return true
}

function guardMatches(rowValue, input) {
  if (rowValue === "PR flow enabled") return input.prFlowEnabled === true
  if (rowValue === "PR flow disabled") return input.prFlowEnabled !== true
  if (rowValue === "no linked PR") return !input.prLinked
  if (rowValue === "human disposition or override") return !!(input.humanDisposition || input.override)
  if (rowValue === "non-empty and no conflict") return input.filesChanged !== false
  if (rowValue === "no conflict") return input.filesChanged === false
  return true
}

function rowMatches(candidate, state, event, input) {
  const target = input.to ?? state.status
  return matchesEvent(candidate.event, event)
    && matchesValue(candidate.from, state.status, state.status)
    && matchesValue(candidate.to, target, state.status)
    && (input.structuralCompatibility === true && candidate.id === "7"
      ? true
      : actorMatches(candidate.actor, state, input.actor))
    && guardMatches(candidate.guard, input)
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
  if (from === "$any") return ["[*]"]
  return asArray(from)
}

function expandedTargets(to, source) {
  if (to === "$any") return ["[*]"]
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
