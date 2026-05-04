import path from "node:path"
import {
  BtrainError,
  checkHandoff,
  getLaneConfigs,
  readProjectConfig,
} from "../core.mjs"
import {
  buildContextQuery,
  formatUnblockedContextSummary,
  runUnblockedResearch,
} from "../unblocked/context.mjs"

function normalizeLaneId(value) {
  return String(value || "").trim()
}

function normalizeFiles(state = {}) {
  const candidates = [
    state.lockedFiles,
    state.handoffPaths,
    state.lockPaths,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.map((item) => String(item).trim()).filter(Boolean)
    }
  }
  return []
}

async function resolveReviewContextState(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  const laneConfigs = getLaneConfigs(config)
  const handoff = await checkHandoff(repoRoot)

  if (!laneConfigs) {
    return {
      laneId: "",
      state: handoff.current,
    }
  }

  const laneId = normalizeLaneId(options.lane)
  if (!laneId) {
    throw new BtrainError({
      message: "`btrain review context` requires --lane when [lanes] is enabled.",
      reason: "Reviewer-side context needs a concrete lane task and locked-file scope.",
      fix: "btrain review context --lane <id> --repo .",
    })
  }

  const state = (handoff.lanes || []).find((lane) => lane._laneId === laneId || lane.lane === laneId)
  if (!state) {
    throw new BtrainError({
      message: `Lane ${laneId} was not found.`,
      reason: "The requested lane is not configured in this repo.",
      fix: "Run `btrain handoff` to see available lanes.",
    })
  }

  return {
    laneId,
    state,
  }
}

async function reviewContext(repoRoot, options = {}) {
  const { laneId, state } = await resolveReviewContextState(repoRoot, options)
  const files = normalizeFiles(state)
  const task = state?.task || ""
  const query = options.query || buildContextQuery({
    purpose: "Reviewer-side btrain context check",
    task,
    files,
    laneId,
  })
  const result = await runUnblockedResearch(repoRoot, {
    query,
    effort: options.effort || "low",
    limit: options.limit || 5,
    helperPath: options.helperPath,
  })

  return {
    repoRoot: path.resolve(repoRoot),
    lane: laneId,
    task,
    files,
    query,
    ...result,
  }
}

function formatReviewContextSummary(result) {
  const header = [
    `repo: ${result.repoRoot}`,
    result.lane ? `lane: ${result.lane}` : "",
    result.task ? `task: ${result.task}` : "",
    result.files?.length ? `files: ${result.files.join(", ")}` : "",
  ].filter(Boolean)

  return [
    ...header,
    formatUnblockedContextSummary(result, { label: "btrain review context" }),
  ].join("\n")
}

export {
  formatReviewContextSummary,
  reviewContext,
}
