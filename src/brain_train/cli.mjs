#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import {
  BtrainError,
  checkHandoff,
  claimHandoff,
  compactHandoffHistory,
  consumeOverride,
  doctor,
  extractSpillPathFromNextAction,
  forceReleaseLock,
  getBrainTrainHome,
  getLaneConfigs,
  getReviewStatus,
  getStartupSnapshot,
  getStatus,
  grantOverride,
  initRepo,
  installGitHooks,
  listActiveOverrides,
  listLocks,
  listRepos,
  patchHandoff,
  readProjectConfig,
  readSpilledNextActionBody,
  registerRepo,
  releaseLocks,
  requestChangesHandoff,
  resolveHandoff,
  resolveRepoRoot,
  runReview,
  runLoop,
  syncActiveAgents,
  syncTemplates,
} from "./core.mjs"
import {
  getConfiguredHarnessProfileId,
  inspectHarnessProfile,
  listHarnessProfiles,
} from "./harness/index.mjs"
import {
  HARNESS_TRACE_FAILURE_CATEGORIES,
  HARNESS_TRACE_OUTCOMES,
  listTraceBundles,
  readTraceBundleSummary,
} from "./harness/trace-bundle.mjs"
import {
  inspectBenchmarkScenario,
  listBenchmarkScenarios,
} from "./harness/benchmark-registry.mjs"
import {
  listTraces,
  showTrace,
} from "./harness/trace-discovery.mjs"
import { pullPrComments } from "./handoff/pr-comments.mjs"

function printHelp() {
  console.log(`btrain

Usage:
  btrain init <repo-path> [--hooks] [--agent <name>]... [--lanes-per-agent <n>] [--core-only]
                                                                              Bootstrap a repo, local dashboard, and agentchattr (--hooks installs managed git guards)
  btrain agents set --repo <path> --agent <name>... [--lanes-per-agent <n>]     Replace the active agent list and refresh docs/lanes
  btrain agents add --repo <path> --agent <name>... [--lanes-per-agent <n>]     Add agent(s) and scaffold any newly required lanes
  btrain handoff [--repo <path>] [--since <hash>]                               Check whose turn it is and what to do (--since short-circuits when state is unchanged)
  btrain handoff show-next [--lane <id>] [--repo <path>]                         Print the full Next Action body, expanding any .btrain/handoff-notes/ pointer
  btrain handoff claim --task <text> --owner <name> [--reviewer <name|any-other>] [options]
                                                                              Claim a new task
  btrain handoff update [options]                                                Update the current handoff state
  btrain handoff request-changes [--summary <text>] [--next <text>] [--actor <name>]
                                                                              Return review findings to the writer
  btrain handoff resolve [--summary <text>] [--next <text>] [--actor <name>]    Resolve the current handoff
  btrain handoff pull-pr --lane <id> --pr <number> [--show] [--acknowledge]     Fetch GH PR comments (issue, review, inline) into .btrain/pr-comments/ JSONL log
  btrain harness list [--repo <path>]                                            List bundled and repo-local harness profiles
  btrain harness inspect [--repo <path>] [--profile <name>]                      Inspect one harness profile (defaults to active)
  btrain harness trace list [--repo <path>] [--limit <n>]                        List harness trace bundles under .btrain/harness/runs
  btrain harness trace show --run-id <id> [--repo <path>]                        Show one harness trace bundle summary
  btrain harness eval list [--repo <path>] [--category <name>]                   List bundled and repo-local benchmark scenarios
  btrain harness eval inspect --scenario <id> [--repo <path>]                    Inspect one benchmark scenario manifest
  btrain loop [--repo <path>] [--dry-run] [--max-rounds <n>] [--timeout <sec>]  Relay handoffs between configured agent runners
  btrain review run [--repo <path>] [--mode <manual|parallel|hybrid>] [--base <ref>]   Run the configured review workflow
  btrain review status [--repo <path>]                                           Show review mode and latest review artifact
  btrain locks [--repo <path>]                                                   List all active file locks
  btrain locks release --path <path> [--repo <path>]                             Force-release a file lock
  btrain locks release-lane --lane <id> [--repo <path>]                          Release all locks for a lane
  btrain register <repo-path>                                                    Register an existing repo without bootstrapping it
  btrain sync-templates [--repo <path>] [--dry-run]                              Sync managed AGENTS/CLAUDE blocks from templates
  btrain status [--repo <path>]                                                  Show handoff state across repos
  btrain doctor [--repo <path>] [--repair]                                       Check registry and repo health
  btrain hooks [--repo <path>]                                                   Install the managed pre-commit and pre-push hooks
  btrain override grant --action <push|needs-review> [--lane <id>] --requested-by <agent> --confirmed-by <human> --reason <text>
                                                                              Create a human-confirmed audited override
  btrain repos                                                                   List registered repos
  btrain startup [--repo <path>]                                                Print a compact repo/bootstrap snapshot for a newly launched agent
  btrain go [--repo <path>]                                                      Bootstrap context: files an agent must read to work correctly
  btrain hcleanup [--repo <path>] [--keep <n>]                                   Trim handoff history, archive old entries

Handoff/Lane Options:
  --lane <id>       Target a specific lane (e.g. a, b, c, d). Auto-selects if omitted.
  --files <list>    Comma-separated list of files/dirs to lock for this lane.
                    Required when a lane is active or claimed.
                    \`handoff update\` and \`handoff resolve\` require --lane when [lanes] is enabled.
  --reviewer <name|any-other>
                    Optional peer reviewer for \`handoff claim\`. Defaults to \`any-other\` (any configured agent except the owner).
  --agent <name>    Repeatable for \`init\`, \`agents set\`, and \`agents add\`. Updates \`[agents].active\`.
  --lanes-per-agent <n>
                    Sets \`[lanes].per_agent\` when used with \`init\`, \`agents set\`, or \`agents add\`.
  --core-only       Init only the btrain core files/docs. Skips bundled project skills and local dev tools.
  --base <ref>      Branch or commit for the work under review.
  --preflight [text]
                    Mark or describe the pre-flight review that was completed.
  --changed <text>  Repeatable. One changed-file bullet for Context for Peer Review.
  --verification <text>
                    Repeatable. One verification bullet for Context for Peer Review.
  --gap <text>      Repeatable. One remaining gap / unverified path bullet.
  --why <text>      Why the change was made.
  --review-ask <text>
                    Repeatable. One specific review ask for the reviewer.
  --objective <text>
                    Delegation packet objective for the lane.
  --deliverable <text>
                    Expected reviewable output or artifact for the lane.
  --constraint <text>
                    Repeatable. Constraint or boundary for the lane.
  --acceptance <text>
                    Repeatable. Acceptance check for the lane.
  --budget <text>   Effort or scope budget for the lane.
  --done-when <text>
                    Concrete completion condition for the lane.
  --reason-code <code>
                    Required when entering \`changes-requested\` or \`repair-needed\`.
  --reason-tag <tag>
                    Repeatable. Optional secondary tags for reason-code metadata.
  --no-diff           Skip the reviewable-diff gate for this handoff (e.g. docs-only or config changes).
  --override-id <id>
                    Consume a previously granted audited override when re-running a blocked action.
  --requested-by <agent>
                    Agent or guardian requesting an audited override.
  --confirmed-by <human>
                    Human confirming the audited override.
  --reason <text>   Required audit reason for \`override grant\`.
  --skip-feedback   Skip feedback log checks in \`doctor\` output.

Environment:
  BRAIN_TRAIN_HOME overrides the default global directory (~/.brain_train).
  BTRAIN_AGENT or BRAIN_TRAIN_AGENT can pin the current agent identity for handoff verification.

Notes:
  - \`init\`, \`agents set\`, and \`agents add\` are safe to re-run. They refresh the managed docs and scaffold any missing lane sections/files.
  - \`init\` also scaffolds the bundled \`.claude/skills/\` pack plus repo-local dashboard, handoff-history helpers, and \`agentchattr/\` unless you pass \`--core-only\`.
  - \`handoff claim\` resets the peer-review context and review response sections for a new task.
  - \`loop\` reads the active harness profile from \`[harness].active_profile\` in \`.btrain/project.toml\`; new repos default to the bundled \`default\` profile.
  - Use \`handoff claim|update|request-changes|resolve\` to keep handoff headers consistent.
  - \`loop\` uses \`[agents.runners]\` in \`.btrain/project.toml\` and dispatches \`bth\`; the lane delegation packet is surfaced via \`btrain handoff\`, not embedded in the prompt.
  - \`review run\` automates \`parallel\` and \`hybrid\` modes. \`manual\` mode reports a no-op.
  - \`sync-templates\` only updates the managed blocks in \`AGENTS.md\` and \`CLAUDE.md\`.
  - When \`[lanes]\` is configured in project.toml, agents can work concurrently on separate lanes.
  - \`override grant\` writes a pending audited override under \`.btrain/overrides/\`; push overrides are consumed automatically by the managed pre-push hook.
  - \`doctor --repair\` applies only safe mechanical fixes such as stale-lock release and backstop handoff-history compaction.
`)
}

function parseOptions(args) {
  const options = { _: [] }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith("--")) {
      options._.push(token)
      continue
    }

    const key = token.slice(2)
    const nextToken = args[index + 1]
    if (!nextToken || nextToken.startsWith("--")) {
      if (options[key] === undefined) {
        options[key] = true
      } else if (Array.isArray(options[key])) {
        options[key].push(true)
      } else {
        options[key] = [options[key], true]
      }
      continue
    }

    if (options[key] === undefined) {
      options[key] = nextToken
    } else if (Array.isArray(options[key])) {
      options[key].push(nextToken)
    } else {
      options[key] = [options[key], nextToken]
    }
    index += 1
  }

  return options
}

function formatPacketValue(value) {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.join(" ") || ""
}

function formatPacketList(values) {
  const source = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values]
  return source
    .flatMap((item) => String(item).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-+\s*/, "").trim())
}

function buildDelegationPacketSummaryLines(packet) {
  const lines = []
  if (packet?.objective) {
    lines.push(`objective: ${formatPacketValue(packet.objective)}`)
  }

  if (packet?.deliverable) {
    lines.push(`deliverable: ${formatPacketValue(packet.deliverable)}`)
  }

  const constraints = formatPacketList(packet?.constraints)
  if (constraints.length > 0) {
    lines.push("constraints:")
    lines.push(...constraints.map((constraint) => `  - ${constraint}`))
  }

  const acceptance = formatPacketList(packet?.acceptance)
  if (acceptance.length > 0) {
    lines.push("acceptance:")
    lines.push(...acceptance.map((item) => `  - ${item}`))
  }

  if (packet?.budget) {
    lines.push(`budget: ${formatPacketValue(packet.budget)}`)
  }

  if (packet?.doneWhen) {
    lines.push(`done when: ${formatPacketValue(packet.doneWhen)}`)
  }

  return lines
}

function buildCgraphSummaryLines(cgraph, indent = "") {
  if (!cgraph || typeof cgraph !== "object") {
    return []
  }

  const hasSubstantiveContent =
    cgraph.blast_radius
    || cgraph.review_packet
    || cgraph.audit
    || cgraph.degraded_reason
    || (Array.isArray(cgraph.fresh_advisories) && cgraph.fresh_advisories.length > 0)
    || (Array.isArray(cgraph.resolved_advisories) && cgraph.resolved_advisories.length > 0)

  if (!hasSubstantiveContent) {
    return []
  }

  const lines = [`${indent}cgraph: ${cgraph.status || "ok"}`]

  if (cgraph.blast_radius) {
    lines.push(
      `${indent}blast radius: ${cgraph.blast_radius.nodes_in_scope || 0} in scope, `
        + `${cgraph.blast_radius.transitive_callers || 0} callers, `
        + `${cgraph.blast_radius.transitive_callees || 0} callees, `
        + `${cgraph.blast_radius.lock_overlaps || 0} overlaps`,
    )
  }

  if (cgraph.review_packet) {
    lines.push(
      `${indent}review packet: ${cgraph.review_packet.source || "unknown"}, `
        + `${cgraph.review_packet.touched_nodes || 0} touched nodes, `
        + `${cgraph.review_packet.advisory_count || 0} advisories`,
    )
    if (cgraph.review_packet.path) {
      lines.push(`${indent}review packet path: ${cgraph.review_packet.path}`)
    }
  }

  if (cgraph.audit) {
    lines.push(
      `${indent}audit: ${cgraph.audit.warn || 0} warn, `
        + `${cgraph.audit.hard || 0} hard, `
        + `${cgraph.audit.standards_evaluated || 0} rules`,
    )
    if (cgraph.audit.path) {
      lines.push(`${indent}audit path: ${cgraph.audit.path}`)
    }
  }

  if (cgraph.drift) {
    lines.push(
      `${indent}drift: ${cgraph.drift.drifted_nodes || 0} changed node${cgraph.drift.drifted_nodes === 1 ? "" : "s"}, `
        + `${cgraph.drift.neighbor_files || 0} neighbor file${cgraph.drift.neighbor_files === 1 ? "" : "s"}`,
    )
  }

  const advisories = Array.isArray(cgraph.advisories) ? cgraph.advisories : []
  for (const advisory of advisories.slice(0, 2)) {
    const detail = advisory.detail ? ` — ${advisory.detail}` : ""
    lines.push(`${indent}advisory: ${advisory.kind || "unknown"}${detail}`)
    if (advisory.suggestion) {
      lines.push(`${indent}advice: ${advisory.suggestion}`)
    }
  }
  if (advisories.length > 2) {
    lines.push(`${indent}advisories: +${advisories.length - 2} more`)
  }

  if (cgraph.graph_mode) {
    lines.push(`${indent}graph mode: ${cgraph.graph_mode}`)
  }

  if (cgraph.degraded_reason) {
    lines.push(`${indent}degraded: ${cgraph.degraded_reason}`)
  }

  for (const advisory of cgraph.fresh_advisories || []) {
    const message = advisory.suggestion || advisory.detail || advisory.kind || "advisory"
    lines.push(`${indent}tip: ${message}`)
  }

  for (const advisory of cgraph.resolved_advisories || []) {
    const message = advisory.detail || advisory.kind || "advisory"
    lines.push(`${indent}resolved: ${message}`)
  }

  return lines
}

function formatRepoStatus(status) {
  const updatedLine = status.staleness
    ? `${status.current.lastUpdated || "(unknown)"} ${status.staleness.label}`
    : `${status.current.lastUpdated || "(unknown)"}`

  const lines = [
    `- ${status.name}`,
    `  path: ${status.path}`,
  ]

  if (status.lanes) {
    for (const lane of status.lanes) {
      const lockSuffix =
        lane.lockState === "active"
          ? ` [${lane.lockCount} lock${lane.lockCount === 1 ? "" : "s"}]`
          : lane.lockState && lane.lockState !== "clear"
            ? ` [${lane.lockState}]`
            : ""
      const repurposeSuffix = lane.repurposeReady ? ` [repurpose-ready: ${lane.repurposeReason}]` : ""
      const reasonSuffix = lane.reasonCode ? ` [reason: ${lane.reasonCode}]` : ""
      lines.push(
        `  lane ${lane._laneId}: ${lane.status} — ${lane.task || "(no task)"}${lane.owner ? ` (${lane.owner})` : ""}${lockSuffix}${repurposeSuffix}${reasonSuffix}`,
      )
      if (lane.delegationPacket?.objective) {
        lines.push(`    objective: ${formatPacketValue(lane.delegationPacket.objective)}`)
      }
      if (lane.repairOwner) {
        lines.push(`    repair owner: ${lane.repairOwner}`)
      }
      if (lane.repairAttempts) {
        lines.push(`    repair attempts: ${lane.repairAttempts}`)
      }
      if (lane.repairEscalation) {
        lines.push(`    repair escalation: ${lane.repairEscalation}`)
      }
      lines.push(...buildCgraphSummaryLines(lane.cgraph, "    "))
    }
    if (status.locks && status.locks.length > 0) {
      lines.push(`  locks: ${status.locks.map((l) => `${l.lane}:${l.path}`).join(", ")}`)
    }
  } else {
    lines.push(`  task: ${status.current.task || "(none)"}`)
    lines.push(`  active agent: ${status.current.owner || "(unassigned)"}`)
    lines.push(`  peer reviewer: ${status.current.reviewer || "(unassigned)"}`)
    lines.push(`  review mode: ${status.current.reviewMode || "manual"}`)
    lines.push(`  status: ${status.current.status || "(unknown)"}`)
    if (status.current.delegationPacket?.objective) {
      lines.push(`  objective: ${formatPacketValue(status.current.delegationPacket.objective)}`)
    }
    lines.push(`  next: ${status.current.nextAction || "(none)"}`)
    if (status.current.reasonCode) {
      lines.push(`  reason code: ${status.current.reasonCode}`)
    }
    if (status.current.reasonTags?.length) {
      lines.push(`  reason tags: ${status.current.reasonTags.join(", ")}`)
    }
    if (status.current.repairOwner) {
      lines.push(`  repair owner: ${status.current.repairOwner}`)
    }
    if (status.current.repairAttempts) {
      lines.push(`  repair attempts: ${status.current.repairAttempts}`)
    }
    if (status.current.repairEscalation) {
      lines.push(`  repair escalation: ${status.current.repairEscalation}`)
    }
    lines.push(...buildCgraphSummaryLines(status.current.cgraph, "  "))
  }

  lines.push(`  updated: ${updatedLine}`)
  lines.push(`  handoffs: ${status.previousHandoffs ?? 0}`)
  lines.push(`  drift: ${status.templateDrift ? (status.templateDrift.any ? "yes" : "no") : "unknown"}`)
  if (status.repurposeReady && status.repurposeReady.length > 0) {
    lines.push(
      `  repurpose-ready: ${status.repurposeReady
        .map((entry) => (entry.laneId ? `${entry.laneId} (${entry.reason})` : `current handoff (${entry.reason})`))
        .join(", ")}`,
    )
  }
  if (status.overrides && status.overrides.length > 0) {
    lines.push(`  overrides: ${status.overrides.map((record) => record.id).join(", ")}`)
  }

  return lines.join("\n")
}

function formatDoctorResult(result) {
  const lines = [
    `- ${result.repoRoot}`,
    `  healthy: ${result.healthy ? "yes" : "no"}`,
  ]

  if (result.issues.length > 0) {
    lines.push(`  issues: ${result.issues.join(" | ")}`)
  }

  if (result.warnings.length > 0) {
    lines.push(`  warnings: ${result.warnings.join(" | ")}`)
  }

  if (result.repurposeReady?.length > 0) {
    lines.push(
      `  repurpose-ready: ${result.repurposeReady
        .map((entry) => (entry.laneId ? `${entry.laneId} (${entry.reason})` : `current handoff (${entry.reason})`))
        .join(", ")}`,
    )
  }
  if (result.overrides?.length > 0) {
    lines.push(`  overrides: ${result.overrides.map((record) => record.id).join(", ")}`)
  }
  if (result.repairs?.length > 0) {
    lines.push(`  repairs: ${result.repairs.map((repair) => repair.summary || repair.type).join(" | ")}`)
  }
  if (result.cgraph) {
    lines.push(`  cgraph: ${result.cgraph.status}`)
    for (const info of result.cgraph.info || []) {
      lines.push(`    ${info}`)
    }
    for (const issue of result.cgraph.issues || []) {
      lines.push(`    issue: ${issue}`)
    }
  }

  if (result.issues.length === 0 && result.warnings.length === 0) {
    lines.push("  notes: no issues detected")
  }

  return lines.join("\n")
}

function formatSyncResult(result) {
  const lines = [
    `- ${result.name}`,
    `  path: ${result.path}`,
    `  status: ${result.status}`,
  ]

  if (result.reason) {
    lines.push(`  reason: ${result.reason}`)
  }

  for (const fileResult of result.files) {
    lines.push(`  ${path.basename(fileResult.path)}: ${fileResult.status}`)
    if (fileResult.reason) {
      lines.push(`  ${path.basename(fileResult.path)} reason: ${fileResult.reason}`)
    }
  }

  return lines.join("\n")
}

function summarizeError(errorText) {
  if (!errorText) {
    return ""
  }

  return errorText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || ""
}

function formatReviewRunResult(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `mode: ${result.mode} (${result.modeSource})`,
    `status: ${result.status}`,
    `base: ${result.base}`,
    `head: ${result.head}`,
  ]

  if (result.status === "skipped") {
    lines.push("reason: manual review mode does not launch automation")
    return lines.join("\n")
  }

  if (result.artifact) {
    lines.push(`report: ${result.artifact.reportPath}`)
    lines.push(`metadata: ${result.artifact.metadataPath}`)
    lines.push(`started: ${result.artifact.startedAt}`)
    lines.push(`completed: ${result.artifact.completedAt}`)
    if (result.artifact.error) {
      lines.push(`error: ${summarizeError(result.artifact.error)}`)
    }
  }

  return lines.join("\n")
}

function formatReviewStatus(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `handoff mode: ${result.handoffMode}`,
    `effective mode: ${result.mode} (${result.modeSource})`,
    `parallel enabled: ${result.reviewConfig.parallelEnabled ? "yes" : "no"}`,
    `sequential enabled: ${result.reviewConfig.sequentialEnabled ? "yes" : "no"}`,
    `sequential triggers: ${
      result.reviewConfig.sequentialTriggers.length > 0
        ? result.reviewConfig.sequentialTriggers.join(", ")
        : "(none)"
    }`,
    `review runs: ${result.runCount}`,
  ]

  if (!result.latest) {
    lines.push("latest run: none")
    return lines.join("\n")
  }

  lines.push(`latest run: ${result.latest.status}`)
  lines.push(`latest report: ${result.latest.reportPath}`)
  lines.push(`latest metadata: ${result.latest.metadataPath}`)
  lines.push(`latest started: ${result.latest.startedAt}`)
  lines.push(`latest completed: ${result.latest.completedAt}`)
  lines.push(`latest base: ${result.latest.base}`)
  lines.push(`latest head: ${result.latest.head}`)
  if (result.latest.error) {
    lines.push(`latest error: ${summarizeError(result.latest.error)}`)
  }

  return lines.join("\n")
}

function formatLoopResult(result) {
  return [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `status: ${result.status}`,
    `initial handoff: ${result.initialCurrent.status}`,
    `final handoff: ${result.finalCurrent.status}`,
    `rounds: ${result.roundsCompleted}/${result.maxRounds}`,
    `dispatches: ${result.history.length}`,
    `reason: ${result.stopReason}`,
  ].join("\n")
}

function formatPathForDisplay(repoRoot, targetPath) {
  if (!targetPath) {
    return "(none)"
  }

  if (!path.isAbsolute(targetPath)) {
    return targetPath
  }

  if (!repoRoot) {
    return targetPath
  }

  const relativePath = path.relative(repoRoot, targetPath)
  if (!relativePath) {
    return "."
  }

  return relativePath.startsWith("..") ? targetPath : relativePath
}

function formatCompactPathList(values, repoRoot, limit = 5) {
  const normalized = (values || []).filter(Boolean).map((value) => formatPathForDisplay(repoRoot, value))
  if (normalized.length === 0) {
    return "(none)"
  }

  if (normalized.length <= limit) {
    return normalized.join(", ")
  }

  return `${normalized.slice(0, limit).join(", ")} (+${normalized.length - limit} more)`
}

function appendHarnessRegistryMetadata(lines, result, { expandedCommands = false, expandedDocs = false } = {}) {
  lines.push("registry sources:")
  lines.push(`  bundled: ${formatPathForDisplay(result.repoRoot, result.registryPaths?.bundled)}`)
  lines.push(`  repo-local: ${formatPathForDisplay(result.repoRoot, result.registryPaths?.repoLocal)}`)

  if (result.commands?.length > 0) {
    if (expandedCommands) {
      lines.push("supported commands:")
      for (const command of result.commands) {
        lines.push(`  - ${command}`)
      }
    } else {
      lines.push(`commands: ${result.commands.join(" | ")}`)
    }
  }

  if (Object.keys(result.schemas || {}).length > 0) {
    lines.push("schemas:")
    for (const [name, schema] of Object.entries(result.schemas)) {
      lines.push(`  ${name}: ${schema}`)
    }
  }

  if (result.authoringDocs?.length > 0) {
    if (expandedDocs) {
      lines.push("authoring docs:")
      for (const doc of result.authoringDocs) {
        lines.push(`  - ${doc}`)
      }
    } else {
      lines.push(`authoring docs: ${result.authoringDocs.join(" | ")}`)
    }
  }
}

function formatHarnessProfileTagText(profile) {
  const tags = []
  if (profile.active) {
    tags.push("active")
  }
  if (profile.source) {
    tags.push(profile.source)
  }
  if (!profile.exists) {
    tags.push("missing")
  }
  if (profile.error) {
    tags.push("invalid")
  }

  return tags.length > 0 ? ` [${tags.join(", ")}]` : ""
}

function formatHarnessListResult(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `active profile: ${result.activeProfileId}`,
    `registry version: ${result.version}`,
  ]

  appendHarnessRegistryMetadata(lines, result)

  lines.push("profiles:")
  if (result.profiles.length === 0) {
    lines.push("  (none)")
    return lines.join("\n")
  }

  for (const profile of result.profiles) {
    const labelText = profile.label ? ` — ${profile.label}` : ""
    lines.push(`  - ${profile.id}${formatHarnessProfileTagText(profile)}${labelText}`)
    if (profile.description) {
      lines.push(`    ${profile.description}`)
    }
    if (profile.purpose) {
      lines.push(`    purpose: ${profile.purpose}`)
    }
    lines.push(`    path: ${formatPathForDisplay(result.repoRoot, profile.profilePath)}`)
    lines.push(`    dispatch: ${profile.loop?.dispatchPrompt || "(none)"}`)
    if (profile.error) {
      lines.push(`    error: ${profile.error}`)
    }
  }

  return lines.join("\n")
}

function formatHarnessInspectResult(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `active profile: ${result.activeProfileId}`,
    `profile: ${result.profile.id}`,
    `state: ${result.profile.active ? "active" : "inactive"}`,
    `source: ${result.profile.source || "unknown"}`,
    `path: ${formatPathForDisplay(result.repoRoot, result.profile.sourcePath || result.profile.profilePath)}`,
    `label: ${result.profile.label || "(none)"}`,
  ]

  if (result.profile.description) {
    lines.push(`description: ${result.profile.description}`)
  }
  if (result.profile.purpose) {
    lines.push(`purpose: ${result.profile.purpose}`)
  }
  if (result.profile.surfaces?.length > 0) {
    lines.push(`surfaces: ${result.profile.surfaces.join(", ")}`)
  }

  lines.push(`dispatch prompt: ${result.profile.loop?.dispatchPrompt || "(none)"}`)
  lines.push(`registered: ${result.profile.registered ? "yes" : "discovered-by-convention"}`)

  appendHarnessRegistryMetadata(lines, result, { expandedCommands: true, expandedDocs: true })

  return lines.join("\n")
}

function formatHarnessTraceListResult(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `harness dir: ${formatPathForDisplay(result.repoRoot, result.harnessDir)}`,
    `index: ${formatPathForDisplay(result.repoRoot, result.indexPath)}`,
    `total runs: ${result.total}`,
    `outcomes: ${HARNESS_TRACE_OUTCOMES.join(" | ")}`,
    `failure categories: ${HARNESS_TRACE_FAILURE_CATEGORIES.join(" | ")}`,
  ]

  lines.push("runs:")
  if (!result.runs || result.runs.length === 0) {
    lines.push("  (none)")
    return lines.join("\n")
  }

  for (const run of result.runs) {
    const tagParts = [run.outcome || "(pending)"]
    if (run.failureCategory) tagParts.push(run.failureCategory)
    const tag = tagParts.filter(Boolean).join(", ")
    const scenarioText = run.scenarioId ? ` scenario=${run.scenarioId}` : ""
    const profileText = run.profileId ? ` profile=${run.profileId}` : ""
    lines.push(`  - ${run.runId} [${tag}]${profileText}${scenarioText}`)
    if (run.startedAt || run.endedAt) {
      lines.push(`    started: ${run.startedAt || "(unknown)"}  ended: ${run.endedAt || "(open)"}`)
    }
    if (run.summary) {
      lines.push(`    ${run.summary}`)
    }
  }

  return lines.join("\n")
}

function formatHarnessTraceShowResult(result) {
  const summary = result.summary || {}
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `run id: ${result.runId}`,
    `bundle dir: ${formatPathForDisplay(result.repoRoot, result.bundleDir)}`,
    `kind: ${summary.kind || "harness-run"}`,
    `profile: ${summary.profileId || "(none)"}`,
    `scenario: ${summary.scenarioId || "(none)"}`,
    `outcome: ${summary.outcome || "(pending)"}`,
  ]

  if (summary.failureCategory) {
    lines.push(`failure category: ${summary.failureCategory}`)
  }
  lines.push(`started: ${summary.startedAt || "(unknown)"}`)
  lines.push(`ended: ${summary.endedAt || "(open)"}`)
  lines.push(`events: ${result.eventCount}`)
  lines.push(`artifacts: ${result.artifactCount} file(s), ${result.artifactDirCount} subdir(s)`)

  if (summary.summary) {
    lines.push("summary:")
    lines.push(`  ${summary.summary}`)
  }

  const metricEntries = Object.entries(summary.metrics || {})
  if (metricEntries.length > 0) {
    lines.push("metrics:")
    for (const [name, value] of metricEntries) {
      lines.push(`  ${name}: ${value}`)
    }
  }

  if (Array.isArray(summary.artifactRefs) && summary.artifactRefs.length > 0) {
    lines.push("artifact refs:")
    for (const ref of summary.artifactRefs) {
      lines.push(`  - ${ref}`)
    }
  }

  const contextEntries = Object.entries(summary.context || {})
  if (contextEntries.length > 0) {
    lines.push("context:")
    for (const [name, value] of contextEntries) {
      lines.push(`  ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    }
  }

  return lines.join("\n")
}

function formatTracesListResult(result) {
  const { total, returned, records, sources } = result
  const lines = [
    `traces: ${total} total, showing ${returned}`,
    `  handoff events: ${sources.eventsDir}`,
    `  harness bundles: ${sources.harnessRunsDir}`,
    `  agentchattr index: ${sources.tracesIndexPath}`,
  ]

  if (records.length === 0) {
    lines.push("(no records match)")
    return lines.join("\n")
  }

  lines.push("")
  for (const r of records) {
    const when = r.ts ? r.ts.slice(0, 19).replace("T", " ") : "(no ts)"
    const lane = r.lane ? ` [${r.lane}]` : ""
    const actor = r.actor ? ` ${r.actor}` : ""
    const outcome = r.outcome ? ` (${r.outcome})` : ""
    lines.push(`${when}  ${r.kind}${lane}${actor}${outcome}`)
    lines.push(`  id: ${r.id}`)
    lines.push(`  ${r.summary}`)
  }
  return lines.join("\n")
}

function formatTracesShowResult(result) {
  const { kind, detail } = result
  if (kind === "harness") {
    return formatHarnessTraceShowResult({
      repoName: "(resolved)",
      repoRoot: "",
      runId: detail.runId,
      bundleDir: detail.bundleDir,
      summary: detail.summary,
      eventCount: detail.eventCount,
      artifactCount: detail.artifactCount,
      artifactDirCount: detail.artifactDirCount,
    })
  }

  const rec = detail.record
  const lines = [
    `kind: ${kind}`,
    `id: ${rec.id}`,
    `ts: ${rec.ts || "(no ts)"}`,
  ]
  if (rec.lane) lines.push(`lane: ${rec.lane}`)
  if (rec.actor) lines.push(`actor: ${rec.actor}`)
  if (rec.outcome) lines.push(`outcome: ${rec.outcome}`)
  lines.push(`summary: ${rec.summary}`)
  lines.push(`source: ${rec.sourcePath}`)
  if (detail.raw) {
    lines.push("")
    lines.push("raw:")
    lines.push(JSON.stringify(detail.raw, null, 2))
  }
  return lines.join("\n")
}

function formatHarnessEvalListResult(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `benchmark version: ${result.version}`,
  ]
  lines.push(`bundled dir: ${formatPathForDisplay(result.repoRoot, result.scenariosDirs.bundled)}`)
  lines.push(
    `repo-local dir: ${
      result.scenariosDirs.repoLocal
        ? formatPathForDisplay(result.repoRoot, result.scenariosDirs.repoLocal)
        : "(none)"
    }`,
  )
  lines.push(`categories: ${result.categories.join(" | ")}`)
  if (result.filterCategory) {
    lines.push(`filter: category=${result.filterCategory}`)
  }
  lines.push(`total scenarios: ${result.scenarios.length}`)

  lines.push("scenarios:")
  if (result.scenarios.length === 0) {
    lines.push("  (none)")
    return lines.join("\n")
  }

  for (const scenario of result.scenarios) {
    const tagParts = [scenario.source || "unknown"]
    if (scenario.category) tagParts.push(scenario.category)
    if (!scenario.requiresDiff) tagParts.push("diffless")
    const tag = tagParts.filter(Boolean).join(", ")
    const labelText = scenario.label ? ` — ${scenario.label}` : ""
    lines.push(`  - ${scenario.id} [${tag}]${labelText}`)
    if (scenario.description) lines.push(`    ${scenario.description}`)
    if (scenario.profileRefs.length > 0) {
      lines.push(`    profiles: ${scenario.profileRefs.join(", ")}`)
    }
    if (scenario.hardFailureCategories.length > 0) {
      lines.push(`    hard failures: ${scenario.hardFailureCategories.join(", ")}`)
    }
    lines.push(`    path: ${formatPathForDisplay(result.repoRoot, scenario.sourcePath)}`)
  }

  return lines.join("\n")
}

function formatHarnessEvalInspectResult(result) {
  const scenario = result.scenario
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
    `scenario: ${scenario.id}`,
    `source: ${scenario.source || "unknown"}`,
    `path: ${formatPathForDisplay(result.repoRoot, scenario.sourcePath)}`,
    `category: ${scenario.category}`,
    `label: ${scenario.label || "(none)"}`,
  ]
  if (scenario.description) lines.push(`description: ${scenario.description}`)
  if (scenario.purpose) lines.push(`purpose: ${scenario.purpose}`)
  lines.push(`expected primary outcome: ${scenario.expectedPrimaryOutcome}`)
  lines.push(`requires diff: ${scenario.requiresDiff ? "yes" : "no"}`)
  lines.push(
    `requires delegation acknowledgement: ${scenario.requiresDelegationAcknowledgement ? "yes" : "no"}`,
  )
  lines.push(
    `profiles: ${scenario.profileRefs.length > 0 ? scenario.profileRefs.join(", ") : "(none)"}`,
  )
  lines.push(
    `hard failures: ${
      scenario.hardFailureCategories.length > 0 ? scenario.hardFailureCategories.join(", ") : "(none)"
    }`,
  )
  if (scenario.tags.length > 0) lines.push(`tags: ${scenario.tags.join(", ")}`)

  if (scenario.artifactRefs.length > 0) {
    lines.push("artifact refs:")
    for (const ref of scenario.artifactRefs) {
      const headParts = [ref.kind || "artifact"]
      if (ref.label) headParts.push(ref.label)
      lines.push(`  - ${headParts.join(": ")}`)
      if (ref.path) lines.push(`    path: ${ref.path}`)
      if (ref.note) lines.push(`    note: ${ref.note}`)
    }
  }

  lines.push(`categories: ${result.categories.join(" | ")}`)
  lines.push(`outcomes: ${result.outcomes.join(" | ")}`)
  lines.push(`hard failure vocabulary: ${result.hardFailureCategories.join(" | ")}`)
  return lines.join("\n")
}

function formatStartupResult(result) {
  const lines = [
    `repo: ${result.repoName}`,
    `path: ${result.repoRoot}`,
  ]

  const agentCheckLine = formatAgentCheck(result.agentCheck)
  if (agentCheckLine) {
    lines.push(agentCheckLine)
  }

  lines.push(`branch: ${result.branch || "(unknown)"}`)
  lines.push(`dirty files: ${formatCompactPathList(result.dirtyPaths, result.repoRoot)}`)
  lines.push(`agents: ${result.activeAgents?.length ? result.activeAgents.join(", ") : "(none)"}`)
  if (result.laneIds?.length > 0) {
    lines.push(`lanes: ${result.laneIds.join(", ")}`)
  }

  lines.push(`active profile: ${result.harness?.activeProfile || "(none)"}`)
  if (result.harness?.dispatchPrompt) {
    lines.push(`dispatch prompt: ${result.harness.dispatchPrompt}`)
  }
  if (result.harness?.error) {
    lines.push(`harness warning: ${summarizeError(result.harness.error)}`)
  }
  if (result.cgraph) {
    lines.push(`cgraph: ${result.cgraph.status}`)
    for (const line of result.cgraph.lines || []) {
      lines.push(`  - ${line}`)
    }
  }

  lines.push("read first:")
  if (result.readFirstPaths?.length > 0) {
    for (const relativePath of result.readFirstPaths) {
      lines.push(`  - ${relativePath}`)
    }
  } else {
    lines.push("  - (no repo guidance files found)")
  }

  lines.push("focus:")
  if (result.focusLanes?.length > 0) {
    for (const lane of result.focusLanes) {
      const roleText = lane.role ? ` [${lane.role}]` : ""
      lines.push(`  - lane ${lane.laneId || "?"}${roleText}: ${lane.status} — ${lane.task || "(none)"}`)
      lines.push(`    owner=${lane.owner || "(unassigned)"} reviewer=${lane.reviewer || "(unassigned)"}`)
      lines.push(`    locks: ${formatCompactPathList(lane.lockPaths, result.repoRoot, 3)}`)
      if (lane.nextAction) {
        lines.push(`    next: ${lane.nextAction}`)
      }
    }
  } else {
    lines.push("  - board is clear; no active in-progress or review lanes")
  }

  lines.push("commands:")
  for (const command of result.commands || []) {
    lines.push(`  - ${command}`)
  }

  if (result.note) {
    lines.push(`note: ${result.note}`)
  }

  return lines.join("\n")
}

function formatAgentCheck(agentCheck) {
  if (!agentCheck) {
    return ""
  }

  switch (agentCheck.status) {
    case "verified":
      return `agent check: ${agentCheck.agentName} (${agentCheck.sourceLabel})`
    case "ambiguous":
      return `agent check: ambiguous (${agentCheck.candidates.join(", ")}; ${agentCheck.sourceLabel}; set BTRAIN_AGENT to pin it)`
    case "unknown":
      return `agent check: unknown (${agentCheck.sourceLabel}; set BTRAIN_AGENT to pin it if needed)`
    case "unconfigured":
      return "agent check: unconfigured (add agent names to .btrain/project.toml to enable verification)"
    default:
      return ""
  }
}

function normalizeActorName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function computeActorRoleOnLane(lane, normalizedActor) {
  const ownerMatch = normalizeActorName(lane?.owner) === normalizedActor
  const reviewerMatch = normalizeActorName(lane?.reviewer) === normalizedActor
  if (ownerMatch && reviewerMatch) return "owner+reviewer"
  if (ownerMatch) return "owner"
  if (reviewerMatch) return "reviewer"
  return ""
}

function truncateTaskText(task, limit = 120) {
  const text = typeof task === "string" ? task.trim() : ""
  if (!text) return ""
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function resolveReminderActor(options, result) {
  const explicit = typeof options?.actor === "string" ? options.actor.trim() : ""
  if (explicit) return explicit
  const detected = result?.agentCheck?.agentName
  return typeof detected === "string" ? detected.trim() : ""
}

export function buildAssignedWorkReminderLines(result, actor) {
  const normalizedActor = normalizeActorName(actor)
  if (!normalizedActor) return []
  if (!Array.isArray(result?.lanes)) return []

  const matches = []
  for (const lane of result.lanes) {
    if (!lane || lane.status === "resolved") continue
    const role = computeActorRoleOnLane(lane, normalizedActor)
    if (!role) continue
    matches.push({ lane, role })
  }

  if (matches.length === 0) return []

  matches.sort((left, right) => {
    const leftId = String(left.lane._laneId || "")
    const rightId = String(right.lane._laneId || "")
    return leftId.localeCompare(rightId)
  })

  const actorDisplay = typeof actor === "string" ? actor.trim() : ""
  const countLabel = matches.length === 1 ? "1 other lane" : `${matches.length} other lanes`
  const header = `reminder (${actorDisplay || normalizedActor}): ${countLabel} still assigned to you`
  const lines = [header]
  for (const { lane, role } of matches) {
    const laneId = lane._laneId || "(unknown)"
    const task = truncateTaskText(lane.task) || "(no task)"
    lines.push(`  - lane ${laneId}: ${lane.status} — ${task} (${role})`)
  }
  return lines
}

function printHandoffState(result) {
  console.log(`repo: ${result.repoName}`)
  const agentCheckLine = formatAgentCheck(result.agentCheck)
  if (agentCheckLine) {
    console.log(agentCheckLine)
  }

  if (result.lanes) {
    // Multi-lane output
    for (const lane of result.lanes) {
      console.log("")
      console.log(`--- lane ${lane._laneId} ---`)
      console.log(`task: ${lane.task || "(none)"}`)
      console.log(`status: ${lane.status}`)
      console.log(`active agent: ${lane.owner || "(unassigned)"}`)
      console.log(`peer reviewer: ${lane.reviewer || "(unassigned)"}`)
      console.log(`mode: ${lane.reviewMode || "manual"}`)
      for (const line of buildDelegationPacketSummaryLines(lane.delegationPacket)) {
        console.log(line)
      }
      console.log(`locked files: ${lane.lockPaths?.length ? lane.lockPaths.join(", ") : "(none)"}`)
      console.log(`lock state: ${lane.lockState || "clear"}`)
      console.log(`next: ${lane.nextAction || "(none)"}`)
      if (lane.reasonCode) {
        console.log(`reason code: ${lane.reasonCode}`)
      }
      if (lane.reasonTags?.length) {
        console.log(`reason tags: ${lane.reasonTags.join(", ")}`)
      }
      if (lane.repairOwner) {
        console.log(`repair owner: ${lane.repairOwner}`)
      }
      if (lane.repairAttempts) {
        console.log(`repair attempts: ${lane.repairAttempts}`)
      }
      if (lane.repairEscalation) {
        console.log(`repair escalation: ${lane.repairEscalation}`)
      }
      for (const line of buildCgraphSummaryLines(lane.cgraph)) {
        console.log(line)
      }
    }
    if (result.locks && result.locks.length > 0) {
      console.log("")
      console.log("active locks:")
      for (const lock of result.locks) {
        console.log(`  lane ${lock.lane}: ${lock.path} (${lock.owner})`)
      }
    }
  } else {
    // Single-lane output
    console.log(`task: ${result.current.task || "(none)"}`)
    console.log(`status: ${result.current.status}`)
    console.log(`active agent: ${result.current.owner || "(unassigned)"}`)
    console.log(`peer reviewer: ${result.current.reviewer || "(unassigned)"}`)
    console.log(`mode: ${result.current.reviewMode || "manual"}`)
    for (const line of buildDelegationPacketSummaryLines(result.current.delegationPacket)) {
      console.log(line)
    }
    console.log(`next: ${result.current.nextAction || "(none)"}`)
    if (result.current.reasonCode) {
      console.log(`reason code: ${result.current.reasonCode}`)
    }
    if (result.current.reasonTags?.length) {
      console.log(`reason tags: ${result.current.reasonTags.join(", ")}`)
    }
    if (result.current.repairOwner) {
      console.log(`repair owner: ${result.current.repairOwner}`)
    }
    if (result.current.repairAttempts) {
      console.log(`repair attempts: ${result.current.repairAttempts}`)
    }
    if (result.current.repairEscalation) {
      console.log(`repair escalation: ${result.current.repairEscalation}`)
    }
    for (const line of buildCgraphSummaryLines(result.current.cgraph)) {
      console.log(line)
    }
  }

  console.log("")
  console.log(result.guidance)
  console.log("")
  console.log("ACT NOW — do not ask permission, do not summarize the next step and stop.")
  console.log("  needs-review (you are reviewer): do the review now, then `btrain handoff resolve --lane <id> --summary \"...\"`.")
  console.log("  in-progress (you are owner): keep working the task; only flip to needs-review after real completed work + filled reviewer context + `pre-handoff` skill.")
  console.log("  resolved/idle: `btrain handoff claim --lane <id> --task \"...\" --owner \"...\" --reviewer \"...\"` and start immediately.")
  if (result.overrides?.length > 0) {
    console.log("")
    console.log("active overrides:")
    for (const record of result.overrides) {
      const scope = record.scope === "lane" && record.laneId ? `lane ${record.laneId}` : "repo"
      console.log(`  ${record.id}: ${record.action} (${scope}; requested by ${record.requestedBy}; confirmed by ${record.confirmedBy})`)
    }
  }
  console.log("")
  console.log(`handoff file: ${result.handoffPath}`)
  if (result.stateHash) {
    console.log(`state hash: ${result.stateHash}`)
  }
}

function printHookInstallResult(label, result) {
  if (!result) {
    return
  }
  if (result.installed) {
    console.log(`${label}: ${result.reason}`)
    return
  }
  if (result.reason === "existing-hook") {
    console.log(`${label}: skipped (existing hook found — install or merge it manually)`)
    return
  }
  if (result.reason === "not-a-git-repo") {
    console.log(`${label}: skipped (not a git repo)`)
  }
}

async function runHandoffShowNext(repoRoot, options) {
  const result = await checkHandoff(repoRoot)
  let nextAction = ""
  let laneLabel = ""
  if (result.lanes) {
    const requestedLane = typeof options.lane === "string" ? options.lane.trim() : ""
    if (!requestedLane) {
      throw new BtrainError({
        message: "`btrain handoff show-next` requires --lane when [lanes] is enabled.",
        reason: "Multi-lane repos need an explicit lane so btrain knows which Next Action to expand.",
        fix: `btrain handoff show-next --lane <id>`,
        context: `Available lanes: ${result.lanes.map((lane) => lane._laneId).join(", ")}`,
      })
    }
    const lane = result.lanes.find((entry) => entry._laneId === requestedLane)
    if (!lane) {
      throw new BtrainError({
        message: `Unknown lane "${requestedLane}".`,
        reason: "No lane with that id is configured.",
        fix: `Pick one of: ${result.lanes.map((entry) => entry._laneId).join(", ")}`,
      })
    }
    nextAction = lane.nextAction || ""
    laneLabel = `lane ${requestedLane}`
  } else {
    nextAction = result.current?.nextAction || ""
    laneLabel = "current"
  }

  if (!nextAction) {
    console.log(`${laneLabel}: no next action set.`)
    return
  }

  const spillPath = extractSpillPathFromNextAction(nextAction)
  if (!spillPath) {
    console.log(`${laneLabel} (inline):`)
    console.log(nextAction)
    return
  }

  const spill = await readSpilledNextActionBody(repoRoot, nextAction)
  if (!spill || spill.missing) {
    console.log(`${laneLabel} (pointer, spill file missing):`)
    console.log(nextAction)
    if (spill?.path) {
      console.log(`expected: ${spill.path}`)
    }
    return
  }

  console.log(`${laneLabel} (spilled from ${spillPath}):`)
  console.log(spill.body)
}

async function runHcleanup(repoRoot, keep) {
  const config = await readProjectConfig(repoRoot)
  const results = await compactHandoffHistory(repoRoot, { config, keep, actorLabel: "btrain hcleanup" })
  const laneConfigs = getLaneConfigs(config) || []
  let totalArchived = 0
  let totalKept = 0

  for (const result of results) {
    const label = result.laneId || (laneConfigs.length > 0 ? "repo" : "default")
    if (result.archivedCount > 0) {
      console.log(`lane ${label}: archived ${result.archivedCount} entries, kept ${result.keptCount}`)
      console.log(`  archive: ${path.relative(repoRoot, result.archivePath) || result.archivePath}`)
    } else {
      console.log(`lane ${label}: ${result.keptCount} entries, nothing to trim (keep=${result.keep})`)
    }
    totalArchived += result.archivedCount
    totalKept += result.keptCount
  }

  console.log("")
  console.log(`archived: ${totalArchived} entries`)
  console.log(`kept: ${totalKept} warm entries`)
}

async function run() {
  const [, , command, ...rest] = process.argv

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "init") {
    const options = parseOptions(rest)
    const targetPath = options._[0]
    if (!targetPath) {
      throw new BtrainError({
        message: "`btrain init` requires a repo path.",
        reason: "No positional argument was provided.",
        fix: "btrain init /path/to/repo",
      })
    }

    const result = await initRepo(targetPath, {
      hooks: !!options.hooks,
      agent: options.agent,
      lanesPerAgent: options["lanes-per-agent"],
      scaffoldBundledSkills: !options["core-only"],
      scaffoldDevTools: !options["core-only"],
    })
    console.log(`Initialized ${result.repoName}`)
    console.log(`repo: ${result.repoRoot}`)
    console.log(`home: ${result.homeDir}`)
    console.log(`handoff: ${result.repoPaths.handoffPath}`)
    if (options["core-only"]) {
      console.log("bundled skills: skipped (--core-only)")
    } else if (result.bundledSkillsResult?.skippedReason === "self") {
      console.log("bundled skills: source bundle already present in this repo")
    } else if (result.bundledSkillsResult) {
      const copiedCount = result.bundledSkillsResult.copiedSkills.length
      console.log(
        copiedCount > 0
          ? `bundled skills: copied ${copiedCount} skill${copiedCount === 1 ? "" : "s"}`
          : "bundled skills: no missing bundled skills",
      )
    }
    if (options["core-only"]) {
      console.log("dev tools: skipped (--core-only)")
    } else if (result.devToolsResult?.skippedReason === "self") {
      console.log("dev tools: source bundle already present in this repo")
    } else if (result.devToolsResult?.missingTools?.length) {
      console.log(`dev tools: source bundle missing (${result.devToolsResult.missingTools.join(", ")})`)
    } else if (result.devToolsResult) {
      const copiedCount = result.devToolsResult.copiedFileCount
      console.log(
        copiedCount > 0
          ? `dev tools: copied ${copiedCount} file${copiedCount === 1 ? "" : "s"} (${result.devToolsResult.copiedTools.join(", ")})`
          : "dev tools: no missing dashboard / agentchattr files",
      )
    }

    if (result.hookResult) {
      printHookInstallResult("pre-commit hook", result.hookResult.preCommit)
      printHookInstallResult("pre-push hook", result.hookResult.prePush)
    }
    return
  }

  if (command === "agents") {
    const subcommand = ["set", "add"].includes(rest[0]) ? rest[0] : null
    if (!subcommand) {
      throw new BtrainError({
        message: "`btrain agents` requires a subcommand.",
        reason: "No subcommand was provided.",
        fix: "btrain agents set --repo . --agent claude --agent codex",
        context: "Available subcommands: set, add.",
      })
    }

    const options = parseOptions(rest.slice(1))
    const repoRoot = await resolveRepoRoot(options.repo)
    const result = await syncActiveAgents(repoRoot, {
      mode: subcommand,
      agent: options.agent,
      lanesPerAgent: options["lanes-per-agent"],
    })

    console.log(`Updated active agents for ${result.repoName}`)
    console.log(`repo: ${result.repoRoot}`)
    console.log(`handoff: ${result.repoPaths.handoffPath}`)
    return
  }

  if (command === "handoff") {
    const subcommand = ["claim", "update", "request-changes", "resolve", "show-next", "pull-pr"].includes(rest[0]) ? rest[0] : null
    const options = parseOptions(subcommand ? rest.slice(1) : rest)

    if (options.help || options.h) {
      printHelp()
      return
    }

    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "show-next") {
      await runHandoffShowNext(repoRoot, options)
      return
    }

    if (subcommand === "claim") {
      await claimHandoff(repoRoot, options)
      const result = await checkHandoff(repoRoot)
      printHandoffState(result)
      return
    }

    if (subcommand === "update") {
      await patchHandoff(repoRoot, options)
      const result = await checkHandoff(repoRoot)
      printHandoffState(result)
      return
    }

    if (subcommand === "resolve") {
      await resolveHandoff(repoRoot, options)
      const result = await checkHandoff(repoRoot)
      printHandoffState(result)
      const reminderActor = resolveReminderActor(options, result)
      const reminderLines = buildAssignedWorkReminderLines(result, reminderActor)
      if (reminderLines.length > 0) {
        console.log("")
        for (const line of reminderLines) {
          console.log(line)
        }
      }
      return
    }

    if (subcommand === "request-changes") {
      await requestChangesHandoff(repoRoot, options)
      const result = await checkHandoff(repoRoot)
      printHandoffState(result)
      return
    }

    if (subcommand === "pull-pr") {
      await pullPrComments(repoRoot, options)
      return
    }

    const result = await checkHandoff(repoRoot)
    const sinceHash = typeof options.since === "string" ? options.since.trim() : ""
    if (sinceHash && result.stateHash && sinceHash === result.stateHash) {
      console.log("unchanged")
      console.log(`state hash: ${result.stateHash}`)
      return
    }
    printHandoffState(result)
    return
  }

  if (command === "harness") {
    const subcommand = ["list", "inspect", "trace", "eval"].includes(rest[0]) ? rest[0] : null
    if (!subcommand) {
      throw new BtrainError({
        message: "`btrain harness` requires a subcommand.",
        reason: "No subcommand was provided.",
        fix: "btrain harness list --repo .",
        context: "Available subcommands: list, inspect, trace, eval.",
      })
    }

    if (subcommand === "trace") {
      const traceSubcommand = ["list", "show"].includes(rest[1]) ? rest[1] : null
      if (!traceSubcommand) {
        throw new BtrainError({
          message: "`btrain harness trace` requires a subcommand.",
          reason: "No trace subcommand was provided.",
          fix: "btrain harness trace list --repo .",
          context: "Available subcommands: list, show.",
        })
      }

      const options = parseOptions(rest.slice(2))
      const repoRoot = await resolveRepoRoot(options.repo)
      const config = await readProjectConfig(repoRoot)
      const repoName = config?.project?.name || path.basename(repoRoot)

      if (traceSubcommand === "list") {
        const limit = Number.parseInt(options.limit, 10)
        const result = await listTraceBundles({
          repoRoot,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        })
        console.log(
          formatHarnessTraceListResult({
            ...result,
            repoName,
            repoRoot,
          }),
        )
        return
      }

      const runId = options["run-id"] || options.runId || options._[0]
      if (!runId || runId === true) {
        throw new BtrainError({
          message: "`btrain harness trace show` requires --run-id <id>.",
          reason: "No run id was provided.",
          fix: "btrain harness trace show --run-id <id> --repo .",
        })
      }

      const bundle = await readTraceBundleSummary({ repoRoot, runId })
      console.log(
        formatHarnessTraceShowResult({
          ...bundle,
          repoName,
          repoRoot,
        }),
      )
      return
    }

    if (subcommand === "eval") {
      const evalSubcommand = ["list", "inspect"].includes(rest[1]) ? rest[1] : null
      if (!evalSubcommand) {
        throw new BtrainError({
          message: "`btrain harness eval` requires a subcommand.",
          reason: "No eval subcommand was provided.",
          fix: "btrain harness eval list --repo .",
          context: "Available subcommands: list, inspect.",
        })
      }

      const options = parseOptions(rest.slice(2))
      const repoRoot = await resolveRepoRoot(options.repo)
      const config = await readProjectConfig(repoRoot)
      const repoName = config?.project?.name || path.basename(repoRoot)

      if (evalSubcommand === "list") {
        const result = await listBenchmarkScenarios({
          repoRoot,
          category: options.category,
        })
        console.log(
          formatHarnessEvalListResult({
            ...result,
            repoName,
            repoRoot,
          }),
        )
        return
      }

      const scenarioId = options.scenario || options._[0]
      if (!scenarioId || scenarioId === true) {
        throw new BtrainError({
          message: "`btrain harness eval inspect` requires --scenario <id>.",
          reason: "No scenario id was provided.",
          fix: "btrain harness eval inspect --scenario <id> --repo .",
        })
      }

      const result = await inspectBenchmarkScenario({ repoRoot, scenarioId })
      console.log(
        formatHarnessEvalInspectResult({
          ...result,
          repoName,
          repoRoot,
        }),
      )
      return
    }

    const options = parseOptions(rest.slice(1))
    const repoRoot = await resolveRepoRoot(options.repo)
    const config = await readProjectConfig(repoRoot)
    const activeProfileId = getConfiguredHarnessProfileId(config)
    const repoName = config?.project?.name || path.basename(repoRoot)

    if (subcommand === "list") {
      const result = await listHarnessProfiles({
        repoRoot,
        activeProfileId,
      })
      console.log(
        formatHarnessListResult({
          ...result,
          repoName,
          repoRoot,
        }),
      )
      return
    }

    const result = await inspectHarnessProfile({
      repoRoot,
      profileId: options.profile,
      activeProfileId,
    })

    if (!result?.profile) {
      const requestedProfile = options.profile || activeProfileId
      throw new BtrainError({
        message: `Unknown harness profile "${requestedProfile}".`,
        reason: "No repo-local or bundled harness profile matched the requested id.",
        fix: "Run `btrain harness list --repo .` to see available profiles.",
      })
    }

    console.log(
      formatHarnessInspectResult({
        ...result,
        repoName,
        repoRoot,
      }),
    )
    return
  }

  if (command === "traces") {
    const subcommand = ["list", "show"].includes(rest[0]) ? rest[0] : null
    if (!subcommand) {
      throw new BtrainError({
        message: "`btrain traces` requires a subcommand.",
        reason: "No subcommand was provided.",
        fix: "btrain traces list --repo .",
        context: "Available subcommands: list, show.",
      })
    }

    const options = parseOptions(rest.slice(1))
    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "list") {
      const limit = Number.parseInt(options.limit, 10)
      const result = await listTraces({
        repoRoot,
        kind: options.kind,
        lane: options.lane,
        since: options.since,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
      })
      console.log(formatTracesListResult(result))
      return
    }

    // show
    const id = options.id || options._[0]
    if (!id || id === true) {
      throw new BtrainError({
        message: "`btrain traces show` requires an id.",
        reason: "No trace id was provided.",
        fix: "btrain traces show <id> --repo . (ids come from `btrain traces list`)",
      })
    }
    const result = await showTrace({ repoRoot, id })
    console.log(formatTracesShowResult(result))
    return
  }

  if (command === "register") {
    const options = parseOptions(rest)
    const targetPath = options._[0]
    if (!targetPath) {
      throw new BtrainError({
        message: "`btrain register` requires a repo path.",
        reason: "No positional argument was provided.",
        fix: "btrain register /path/to/repo",
      })
    }

    const result = await registerRepo(targetPath)
    console.log(`Registered ${result.repoName}`)
    console.log(`repo: ${result.repoRoot}`)
    console.log(`home: ${result.homeDir}`)
    if (result.warnings.length > 0) {
      console.log("warnings:")
      for (const warning of result.warnings) {
        console.log(`- ${warning}`)
      }
    }
    return
  }

  if (command === "review") {
    const subcommand = ["run", "status"].includes(rest[0]) ? rest[0] : null
    if (!subcommand) {
      throw new BtrainError({
        message: "`btrain review` requires a subcommand.",
        reason: "No subcommand was provided.",
        fix: "btrain review run --repo . --mode parallel",
        context: "Available subcommands: run, status.",
      })
    }

    const options = parseOptions(rest.slice(1))
    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "run") {
      const result = await runReview({
        repoRoot,
        mode: options.mode,
        base: options.base,
        head: options.head,
      })
      console.log(formatReviewRunResult(result))
      if (result.status === "failed") {
        process.exitCode = 1
      }
      return
    }

    const result = await getReviewStatus(repoRoot)
    console.log(formatReviewStatus(result))
    return
  }

  if (command === "loop") {
    const options = parseOptions(rest)
    const repoRoot = await resolveRepoRoot(options.repo)
    const result = await runLoop({
      repoRoot,
      dryRun: !!options["dry-run"],
      maxRounds: options["max-rounds"],
      timeout: options.timeout,
      pollInterval: options["poll-interval"],
      onEvent: (line) => console.log(line),
    })
    console.log("")
    console.log(formatLoopResult(result))
    if (result.status === "failed" || result.status === "timed-out" || result.status === "max-rounds-exceeded") {
      process.exitCode = 1
    }
    return
  }

  if (command === "sync-templates") {
    const options = parseOptions(rest)
    const repoRoot = options.repo ? path.resolve(options.repo) : null
    const result = await syncTemplates({
      repoRoot,
      dryRun: !!options["dry-run"],
    })

    if (result.results.length === 0) {
      console.log("No repos registered yet.")
      return
    }

    console.log(result.results.map(formatSyncResult).join("\n\n"))
    return
  }

  if (command === "status") {
    const options = parseOptions(rest)
    const repoRoot = options.repo ? path.resolve(options.repo) : null
    const statuses = await getStatus({ repoRoot })
    if (options.json) {
      console.log(JSON.stringify(statuses, null, 2))
      return
    }
    console.log(`btrain home: ${getBrainTrainHome()}`)
    console.log("")
    if (statuses.length === 0) {
      console.log("No repos registered yet.")
      return
    }
    console.log(statuses.map(formatRepoStatus).join("\n\n"))
    return
  }

  if (command === "doctor") {
    const options = parseOptions(rest)
    const repoRoot = options.repo ? path.resolve(options.repo) : null
    const results = await doctor({ repoRoot, repair: !!options.repair, skipFeedback: !!options["skip-feedback"] })
    console.log(`btrain home: ${getBrainTrainHome()}`)
    console.log("")
    if (results.length === 0) {
      console.log("No repos registered yet.")
      return
    }
    console.log(results.map(formatDoctorResult).join("\n\n"))
    if (results.some((result) => !result.healthy)) {
      process.exitCode = 1
    }
    return
  }

  if (command === "hooks") {
    const options = parseOptions(rest)
    const repoRoot = await resolveRepoRoot(options.repo)
    const result = await installGitHooks(repoRoot)

    if (result.preCommit.reason === "not-a-git-repo" && result.prePush.reason === "not-a-git-repo") {
      console.log("Not a git repo — nothing to install.")
      return
    }
    printHookInstallResult(`pre-commit hook (${repoRoot})`, result.preCommit)
    printHookInstallResult(`pre-push hook (${repoRoot})`, result.prePush)
    return
  }

  if (command === "override") {
    const subcommand = ["grant", "consume", "list"].includes(rest[0]) ? rest[0] : null
    if (!subcommand) {
      throw new BtrainError({
        message: "`btrain override` requires a subcommand.",
        reason: "No subcommand was provided.",
        fix: "btrain override grant --action push --requested-by <agent> --confirmed-by <human> --reason \"...\" ",
        context: "Available subcommands: grant, consume, list.",
      })
    }

    const options = parseOptions(rest.slice(1))
    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "grant") {
      const record = await grantOverride(repoRoot, options)
      const scope = record.scope === "lane" && record.laneId ? `lane ${record.laneId}` : "repo"
      console.log(`override granted: ${record.id}`)
      console.log(`action: ${record.action}`)
      console.log(`scope: ${scope}`)
      console.log(`requested by: ${record.requestedBy}`)
      console.log(`confirmed by: ${record.confirmedBy}`)
      console.log(`reason: ${record.reason}`)
      return
    }

    if (subcommand === "consume") {
      const record = await consumeOverride(repoRoot, {
        ...options,
        actorLabel: options.actor || "btrain override consume",
      })
      console.log(`override consumed: ${record.id}`)
      return
    }

    const overrides = await listActiveOverrides(repoRoot)
    if (overrides.length === 0) {
      console.log("No active overrides.")
      return
    }
    for (const record of overrides) {
      const scope = record.scope === "lane" && record.laneId ? `lane ${record.laneId}` : "repo"
      console.log(`${record.id}: ${record.action} (${scope}; requested by ${record.requestedBy}; confirmed by ${record.confirmedBy})`)
    }
    return
  }

  if (command === "repos") {
    const repos = await listRepos()
    if (repos.length === 0) {
      console.log("No repos registered yet.")
      return
    }

    for (const repo of repos) {
      console.log(`- ${repo.name}: ${repo.path}`)
    }
    return
  }

  if (command === "startup") {
    const options = parseOptions(rest)
    const repoRoot = await resolveRepoRoot(options.repo)
    const result = await getStartupSnapshot(repoRoot)
    console.log(formatStartupResult(result))
    return
  }

  if (command === "locks") {
    const subcommand = ["release", "release-lane"].includes(rest[0]) ? rest[0] : null
    const options = parseOptions(subcommand ? rest.slice(1) : rest)
    const repoRoot = await resolveRepoRoot(options.repo)

    if (subcommand === "release") {
      if (!options.path) {
        throw new BtrainError({
          message: "`btrain locks release` requires --path.",
          reason: "You must specify which lock path to release.",
          fix: "btrain locks release --path src/",
          context: "Run `btrain locks` to see all active lock paths.",
        })
      }
      const removed = await forceReleaseLock(repoRoot, options.path)
      console.log(removed > 0 ? `Released lock: ${options.path}` : `No lock found: ${options.path}`)
      return
    }

    if (subcommand === "release-lane") {
      if (!options.lane) {
        throw new BtrainError({
          message: "`btrain locks release-lane` requires --lane.",
          reason: "You must specify which lane's locks to release.",
          fix: "btrain locks release-lane --lane a",
          context: "Run `btrain locks` to see which lanes have active locks.",
        })
      }
      const released = await releaseLocks(repoRoot, options.lane)
      console.log(`Released ${released.length} lock(s) for lane ${options.lane}`)
      for (const lock of released) {
        console.log(`  ${lock.path} (${lock.owner})`)
      }
      return
    }

    // Default: list locks
    const locks = await listLocks(repoRoot)
    if (locks.length === 0) {
      console.log("No active locks.")
      return
    }

    console.log(`Active locks (${locks.length}):`)
    for (const lock of locks) {
      console.log(`  lane ${lock.lane}: ${lock.path} (${lock.owner}, ${lock.acquired_at})`)
    }
    return
  }

  if (command === "go") {
    const options = parseOptions(rest)
    const repoRoot = await resolveRepoRoot(options.repo)
    const config = await readProjectConfig(repoRoot)
    const laneConfigs = getLaneConfigs(config)

    console.log("# btrain go — agent bootstrap context")
    console.log("")
    console.log("Read these files to understand the project and your role:")
    console.log("")

    // 1. Agent instructions
    console.log("## Agent instructions")
    const claudeMd = path.join(repoRoot, "CLAUDE.md")
    const agentsMd = path.join(repoRoot, "AGENTS.md")
    for (const filePath of [claudeMd, agentsMd]) {
      try {
        await fs.access(filePath)
        console.log(`  ${path.relative(repoRoot, filePath)}`)
      } catch {
        // skip missing
      }
    }

    // 2. Project config
    console.log("")
    console.log("## Project config")
    console.log(`  .btrain/project.toml`)
    if (config) {
      const agents = config.agents?.active || []
      console.log(`    agents: ${agents.length > 0 ? agents.join(", ") : "(none)"}`)
      if (laneConfigs) {
        console.log(`    lanes: ${laneConfigs.map((l) => l.id).join(", ")}`)
      }
    }

    // 3. Handoff state (do not read HANDOFF_*.md directly — use CLI)
    console.log("")
    console.log("## Current handoff state")
    console.log("  btrain handoff                # whose turn, what to do, lane guidance")
    console.log("  btrain status --repo .        # lane overview across repos")
    if (laneConfigs) {
      console.log(`  ${laneConfigs.length} lanes configured (${laneConfigs.map((l) => l.id).join(", ")})`)
    }
    console.log("  Do NOT read .claude/collab/HANDOFF_*.md directly — always use the CLI.")

    // 4. Lock registry
    console.log("")
    console.log("## File locks")
    const locks = await listLocks(repoRoot)
    if (locks.length > 0) {
      for (const lock of locks) {
        console.log(`  lane ${lock.lane}: ${lock.path} (${lock.owner})`)
      }
    } else {
      console.log("  (no active locks)")
    }

    // 5. Skills
    console.log("")
    console.log("## Skills")
    const skillsDir = path.join(repoRoot, ".claude", "skills")
    try {
      const entries = await fs.readdir(skillsDir)
      const skillNames = entries.filter((e) => !e.startsWith(".")).sort()
      if (skillNames.length > 0) {
        console.log(`  .claude/skills/ (${skillNames.length} skills)`)
        for (const name of skillNames) {
          console.log(`    ${name}`)
        }
      } else {
        console.log("  (no skills)")
      }
    } catch {
      console.log("  (no .claude/skills/ directory)")
    }

    // 6. Settings
    console.log("")
    console.log("## Settings")
    for (const name of ["settings.json", "settings.local.json"]) {
      const settingsPath = path.join(repoRoot, ".claude", name)
      try {
        await fs.access(settingsPath)
        console.log(`  .claude/${name}`)
      } catch {
        // skip missing
      }
    }

    // 7. Spec-kit (if present)
    const specifyDir = path.join(repoRoot, ".specify")
    try {
      await fs.access(specifyDir)
      console.log("")
      console.log("## Spec-kit")
      console.log("  .specify/")
      const constitutionPath = path.join(specifyDir, "memory", "constitution.md")
      try {
        await fs.access(constitutionPath)
        console.log("  .specify/memory/constitution.md")
      } catch {
        // skip
      }
    } catch {
      // no .specify
    }

    // 8. Memory
    console.log("")
    console.log("## Memory")
    const memoryDir = path.join(repoRoot, ".claude", "projects")
    try {
      const memoryProjects = await fs.readdir(memoryDir)
      let found = false
      for (const proj of memoryProjects) {
        const memFile = path.join(memoryDir, proj, "memory", "MEMORY.md")
        try {
          await fs.access(memFile)
          console.log(`  .claude/projects/${proj}/memory/MEMORY.md`)
          found = true
        } catch {
          // skip
        }
      }
      if (!found) {
        console.log("  (no MEMORY.md files)")
      }
    } catch {
      console.log("  (no .claude/projects/ directory)")
    }

    // 9. Quick-start commands
    console.log("")
    console.log("## Quick-start commands")
    console.log("  btrain handoff              # see whose turn it is and what to do")
    console.log("  btrain locks                # see active file locks")
    console.log("  btrain doctor               # check repo health")
    if (laneConfigs) {
      console.log("  btrain handoff claim --lane <id> --task \"...\" --owner \"...\" --reviewer \"...\" --files \"...\"")
    } else {
      console.log("  btrain handoff claim --task \"...\" --owner \"...\" --reviewer \"...\"")
    }

    return
  }

  if (command === "hcleanup") {
    const options = parseOptions(rest)
    const repoRoot = await resolveRepoRoot(options.repo)
    const keep = options.keep ? Number(options.keep) : 3
    await runHcleanup(repoRoot, keep)
    return
  }

  if (command === "push") {
    throw new BtrainError({
      message: "`btrain push` has been removed.",
      reason: "The push workflow was replaced by the handoff claim/update/resolve flow.",
      fix: "Use `btrain handoff claim`, `btrain handoff update`, and `btrain handoff resolve` instead.",
    })
  }

  throw new BtrainError({
    message: `Unknown command: "${command}".`,
    reason: "This is not a recognized btrain command.",
    fix: "Run `btrain --help` to see all available commands.",
  })
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
