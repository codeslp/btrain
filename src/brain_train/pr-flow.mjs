// pr-flow.mjs — GitHub PR review loop for btrain lanes.
//
// btrain's local handoff remains the peer review gate. This module handles the
// next phase: create/link a GitHub PR, collect bot feedback, request re-review,
// and keep the lane active until the PR is merged or intentionally closed.

import { execFile } from "node:child_process"
import crypto from "node:crypto"
import { promisify } from "node:util"
import {
  BtrainError,
  checkHandoff,
  getPrFlowConfig,
  normalizePrNumber,
  patchHandoff,
  readProjectConfig,
  resolveHandoff,
} from "./core.mjs"
import { applyTransition } from "./transitions.mjs"
import {
  appendComments,
  fetchAllComments,
  getRepoIdentity,
  isGhAvailable,
  parseConcatenatedJsonArrays,
  shapeComments,
} from "./handoff/pr-comments.mjs"
import {
  createSystemOneClient,
  readSystemOneRuntimeConfig,
} from "./system-one.mjs"

const execFileAsync = promisify(execFile)
const GH_MAX_BUFFER = 16 * 1024 * 1024
const MIN_COMMIT_PREFIX_LENGTH = 10

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase().replace(/\[bot\]$/, "")
}

function loginMatches(bot, login) {
  const normalized = normalizeLogin(login)
  return (bot.aliases || []).some((alias) => normalizeLogin(alias) === normalized)
}

function shortSha(value) {
  return String(value || "").trim().slice(0, 10)
}

function commitMatches(left, right) {
  const a = String(left || "").trim().toLowerCase()
  const b = String(right || "").trim().toLowerCase()
  if (!a || !b) return false
  if (a !== b && Math.min(a.length, b.length) < MIN_COMMIT_PREFIX_LENGTH) return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

function extractReviewedCommit(body) {
  const match = /reviewed commit:\s*(?:\*\*)?\s*`?([0-9a-f]{10,40})`?/i.exec(String(body || ""))
  return match ? match[1] : ""
}

function reviewCommit(review) {
  return review?.commit_id || review?.commit?.oid || extractReviewedCommit(review?.body)
}

function inlineReviewedCommit(comment) {
  return comment?.original_commit_id || comment?.commit_id || ""
}

function parseBtrainReviewMarker(body) {
  const match = /<!--\s*btrain-pr-review\s+([^>]*)-->/i.exec(String(body || ""))
  if (!match) return null
  const attrs = {}
  const attrPattern = /([a-z_-]+)=("[^"]*"|'[^']*'|[^\s]+)/gi
  for (const attr of match[1].matchAll(attrPattern)) {
    const rawValue = attr[2] || ""
    attrs[attr[1]] = rawValue.replace(/^["']|["']$/g, "")
  }
  return attrs
}

function isMarkedReviewRequest(comment, bot, headSha) {
  const marker = parseBtrainReviewMarker(comment?.body)
  if (!marker) return false
  if (marker.bot && marker.bot !== bot.id) return false
  if (!commitMatches(marker.head, headSha)) return false
  return true
}

function hasPositiveBotReaction(comment, bot, issueCommentReactions = {}) {
  const reactions = issueCommentReactions[String(comment?.id)] || []
  return reactions.some((reaction) => (
    String(reaction?.content || "") === "+1"
    && loginMatches(bot, reaction?.user?.login)
  ))
}

function positiveReactionTime(comment, bot, issueCommentReactions = {}) {
  const reactions = issueCommentReactions[String(comment?.id)] || []
  const times = reactions
    .filter((reaction) => String(reaction?.content || "") === "+1" && loginMatches(bot, reaction?.user?.login))
    .map((reaction) => new Date(reaction?.created_at || 0).getTime())
  return times.length > 0 ? Math.max(...times) : itemTime(comment)
}

function itemTime(value) {
  return new Date(value?.submitted_at || value?.created_at || value?.updated_at || 0).getTime()
}

function newest(items) {
  return [...items].sort((a, b) => itemTime(a) - itemTime(b)).at(-1) || null
}

function issueCountFromBody(body) {
  const match = /(\d+)\s+issues?\s+found/i.exec(String(body || ""))
  return match ? Number.parseInt(match[1], 10) : null
}

function bodyIndicatesClear(body) {
  const text = String(body || "")
  const count = issueCountFromBody(text)
  if (count === 0) return true
  return /no (issues|findings|suggestions)|did(?: not|n't) find any (?:major )?(issues|findings|suggestions)|looks good|approved/i.test(text)
}

function bodyIndicatesFeedback(body) {
  const text = String(body || "")
  const count = issueCountFromBody(text)
  if (count && count > 0) return true
  return /automated review suggestions|P[0-3] Badge|changes requested|blocking/i.test(text)
}

function normalizePrState(pr) {
  const state = String(pr?.state || "").toUpperCase()
  if (pr?.mergedAt || pr?.merged_at || state === "MERGED") return "merged"
  if (state === "CLOSED") return "closed"
  if (pr?.isDraft || pr?.draft) return "draft"
  return "open"
}

function summarizeFeedbackItems(items) {
  return items.map((item) => ({
    author: item.user?.login || item.author || "unknown",
    body: String(item.body || "").split("\n")[0].trim(),
    file: item.path || null,
    line: item.line ?? item.original_line ?? null,
    commit: item.commit_id || reviewCommit(item) || "",
    url: item.html_url || item.url || "",
    at: item.created_at || item.submitted_at || "",
  }))
}

export function classifyBotReview({
  bot,
  headSha,
  issueComments = [],
  issueCommentReactions = {},
  reviewComments = [],
  reviews = [],
  semanticVerdict = null,
}) {
  const botInline = (reviewComments || []).filter((comment) => loginMatches(bot, comment.user?.login))
  const botReviews = (reviews || []).filter((review) => loginMatches(bot, review.user?.login))
  const botIssueComments = (issueComments || []).filter((comment) => loginMatches(bot, comment.user?.login))
  const currentInline = botInline.filter((comment) => commitMatches(inlineReviewedCommit(comment), headSha))
  const currentReviews = botReviews.filter((review) => commitMatches(reviewCommit(review), headSha))
  const currentIssueComments = botIssueComments.filter((comment) => commitMatches(reviewCommit(comment), headSha))
  const latestCurrentReview = newest(currentReviews)
  const latestCurrentIssueComment = newest(currentIssueComments)
  const latestActivity = newest([...botInline, ...botReviews, ...botIssueComments])
  const staleInline = botInline.filter((comment) => !commitMatches(inlineReviewedCommit(comment), headSha))
  const clearReaction = newest((issueComments || []).filter((comment) => (
    isMarkedReviewRequest(comment, bot, headSha)
    && hasPositiveBotReaction(comment, bot, issueCommentReactions)
  )))

  // A bot can leave several kinds of signal on the same head (inline
  // findings, a formal review, an issue-comment verdict, a +1 reaction to a
  // marked review request). The newest signal describes its current opinion;
  // an older verdict must not mask a newer one.
  const signalCandidates = []

  if (currentInline.length > 0) {
    signalCandidates.push({
      time: itemTime(newest(currentInline)),
      classify: () => ({
        id: bot.id,
        state: "feedback",
        reviewedCommit: headSha,
        feedbackCount: currentInline.length,
        staleFeedbackCount: staleInline.length,
        feedback: summarizeFeedbackItems(currentInline),
        summary: `${currentInline.length} current-head inline finding${currentInline.length === 1 ? "" : "s"}`,
      }),
    })
  }

  if (latestCurrentReview) {
    signalCandidates.push({
      time: itemTime(latestCurrentReview),
      classify: () => {
        const reviewState = String(latestCurrentReview.state || "").toUpperCase()
        if (reviewState === "CHANGES_REQUESTED" || bodyIndicatesFeedback(latestCurrentReview.body)) {
          return {
            id: bot.id,
            state: "feedback",
            reviewedCommit: reviewCommit(latestCurrentReview) || headSha,
            feedbackCount: 1,
            staleFeedbackCount: staleInline.length,
            feedback: summarizeFeedbackItems([latestCurrentReview]),
            summary: `${bot.id} review reported feedback on the current head`,
          }
        }
        if (reviewState === "APPROVED" || bodyIndicatesClear(latestCurrentReview.body)) {
          return {
            id: bot.id,
            state: "clear",
            reviewedCommit: reviewCommit(latestCurrentReview) || headSha,
            feedbackCount: 0,
            staleFeedbackCount: staleInline.length,
            feedback: [],
            summary: `${bot.id} review is clear on the current head`,
          }
        }
        return null
      },
    })
  }

  if (latestCurrentIssueComment) {
    signalCandidates.push({
      time: itemTime(latestCurrentIssueComment),
      classify: () => {
        if (bodyIndicatesFeedback(latestCurrentIssueComment.body)) {
          return {
            id: bot.id,
            state: "feedback",
            reviewedCommit: reviewCommit(latestCurrentIssueComment) || headSha,
            feedbackCount: 1,
            staleFeedbackCount: staleInline.length,
            feedback: summarizeFeedbackItems([latestCurrentIssueComment]),
            summary: `${bot.id} issue comment reported feedback on the current head`,
          }
        }
        if (bodyIndicatesClear(latestCurrentIssueComment.body)) {
          return {
            id: bot.id,
            state: "clear",
            reviewedCommit: reviewCommit(latestCurrentIssueComment) || headSha,
            feedbackCount: 0,
            staleFeedbackCount: staleInline.length,
            feedback: [],
            summary: `${bot.id} issue comment is clear on the current head`,
          }
        }
        return null
      },
    })
  }

  if (clearReaction) {
    signalCandidates.push({
      time: positiveReactionTime(clearReaction, bot, issueCommentReactions),
      classify: () => ({
        id: bot.id,
        state: "clear",
        reviewedCommit: headSha,
        feedbackCount: 0,
        staleFeedbackCount: staleInline.length,
        feedback: [],
        summary: `${bot.id} reacted +1 to the btrain review request on head ${shortSha(headSha)}`,
      }),
    })
  }

  if (semanticVerdict?.state === "feedback") {
    signalCandidates.push({
      time: itemTime({ created_at: semanticVerdict.at }),
      priority: 1,
      classify: () => ({
        id: bot.id,
        state: "feedback",
        reviewedCommit: headSha,
        feedbackCount: 1,
        staleFeedbackCount: staleInline.length,
        feedback: [semanticVerdict.feedback],
        summary: `${bot.id} semantic review signal is feedback on the current head`,
      }),
    })
  }

  signalCandidates.sort((a, b) => b.time - a.time || (b.priority || 0) - (a.priority || 0))
  for (const candidate of signalCandidates) {
    const result = candidate.classify()
    if (result) {
      return result
    }
  }

  return {
    id: bot.id,
    state: "waiting",
    reviewedCommit: reviewCommit(latestActivity) || latestActivity?.commit_id || "",
    feedbackCount: 0,
    staleFeedbackCount: staleInline.length,
    feedback: [],
    summary: latestActivity
      ? `${bot.id} has no clear review on head ${shortSha(headSha)}; latest activity was on ${shortSha(reviewCommit(latestActivity) || latestActivity.commit_id)}`
      : `${bot.id} has not reviewed this PR yet`,
  }
}

export function classifyPrReviewState({ pr, rawComments = {}, prFlowConfig, semanticVerdicts = {} }) {
  const headSha = pr?.headRefOid || pr?.head?.sha || pr?.head_sha || ""
  const normalizedPrState = normalizePrState(pr)
  const bots = (prFlowConfig.requiredBots || []).map((id) => prFlowConfig.bots[id]).filter(Boolean)
  const botStates = bots.map((bot) => classifyBotReview({
    bot,
    headSha,
    issueComments: rawComments.issueComments || [],
    issueCommentReactions: rawComments.issueCommentReactions || {},
    reviewComments: rawComments.reviewComments || [],
    reviews: rawComments.reviews || [],
    semanticVerdict: semanticVerdicts[bot.id] || null,
  }))

  let overall = "waiting"
  if (normalizedPrState === "merged") {
    overall = "merged"
  } else if (normalizedPrState === "closed") {
    overall = "closed"
  } else if (normalizedPrState === "draft") {
    overall = "draft"
  } else if (botStates.some((bot) => bot.state === "feedback")) {
    overall = "feedback"
  } else if (botStates.every((bot) => bot.state === "clear")) {
    overall = "ready-to-merge"
  }

  return {
    overall,
    pr: {
      number: pr?.number || null,
      url: pr?.url || pr?.html_url || "",
      title: pr?.title || "",
      state: normalizedPrState,
      headSha,
      headShort: shortSha(headSha),
      base: pr?.baseRefName || pr?.base?.ref || "",
      head: pr?.headRefName || pr?.head?.ref || "",
      mergedAt: pr?.mergedAt || pr?.merged_at || "",
    },
    bots: botStates,
  }
}

const SEMANTIC_SIGNAL_LABELS = new Set(["clear", "feedback", "unavailable", "uncertain"])
const MIN_SEMANTIC_CONFIDENCE = 0.75
const MIN_SEMANTIC_PROBABILITY = 0.75
const MIN_SEMANTIC_MARGIN = 0.25
const MIN_VERDICT_PROBABILITY = 0.75

function semanticReviewQuestions() {
  return {
    signal: {
      type: "choice",
      instructions: "What result does this text communicate about the code review?",
      criteria: {
        clear: "The review completed and found no changes or blockers.",
        feedback: "The review found an actionable problem or requests a code or test change.",
        unavailable: "The reviewer failed, timed out, lacked quota or authentication, or did not perform the review.",
        uncertain: "The text is a request, progress update, summary without verdict, author reply, question, or social comment.",
      },
    },
    hasVerdict: {
      type: "noul",
      instructions: "Does the text itself contain a completed code-review verdict: either clear or actionable feedback?",
      criteria: null,
    },
  }
}

function semanticCandidateForBot({ bot, headSha, rawComments }) {
  const botInline = (rawComments.reviewComments || []).filter((comment) => loginMatches(bot, comment.user?.login))
  const currentInline = botInline.filter((comment) => commitMatches(inlineReviewedCommit(comment), headSha))
  if (currentInline.length > 0) return null

  const botReviews = (rawComments.reviews || []).filter((review) => loginMatches(bot, review.user?.login))
  const currentReviews = botReviews.filter((review) => commitMatches(reviewCommit(review), headSha))
  const botIssueComments = (rawComments.issueComments || []).filter((comment) => loginMatches(bot, comment.user?.login))
  const currentIssueComments = botIssueComments.filter((comment) => commitMatches(reviewCommit(comment), headSha))
  const clearReaction = newest((rawComments.issueComments || []).filter((comment) => (
    isMarkedReviewRequest(comment, bot, headSha)
    && hasPositiveBotReaction(comment, bot, rawComments.issueCommentReactions || {})
  )))

  const activities = [
    ...currentReviews.map((review) => ({ surface: "review", item: review, time: itemTime(review) })),
    ...currentIssueComments.map((comment) => ({ surface: "issue", item: comment, time: itemTime(comment) })),
  ]
  if (clearReaction) {
    activities.push({
      surface: "reaction",
      item: clearReaction,
      time: positiveReactionTime(clearReaction, bot, rawComments.issueCommentReactions || {}),
    })
  }
  const selected = activities.sort((a, b) => a.time - b.time).at(-1)
  if (!selected) return null

  if (selected.surface === "reaction") return null
  if (selected.surface === "review") {
    const state = String(selected.item.state || "").toUpperCase()
    if (
      state === "APPROVED"
      || state === "CHANGES_REQUESTED"
      || bodyIndicatesClear(selected.item.body)
      || bodyIndicatesFeedback(selected.item.body)
    ) return null
  }
  if (selected.surface === "issue" && (
    bodyIndicatesClear(selected.item.body) || bodyIndicatesFeedback(selected.item.body)
  )) return null
  if (!String(selected.item.body || "").trim()) return null

  return {
    botId: bot.id,
    surface: selected.surface,
    sourceId: selected.item.id || null,
    body: String(selected.item.body || ""),
    url: selected.item.html_url || selected.item.url || "",
    reviewedCommit: headSha,
    at: selected.item.submitted_at || selected.item.created_at || selected.item.updated_at || "",
  }
}

function noulProbability(answer) {
  const value = answer?.noul ?? answer?.probability
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

function normalizedProbabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) out[key] = raw
  }
  return out
}

function safeSemanticText(value, maximumLength = 128) {
  return String(value || "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, maximumLength)
}

function validChoiceEvidence(answer) {
  const prediction = String(answer?.choice || "")
  if (!SEMANTIC_SIGNAL_LABELS.has(prediction)) return null

  const rawProbabilities = answer?.probabilities
  if (!rawProbabilities || typeof rawProbabilities !== "object" || Array.isArray(rawProbabilities)) return null
  const rawKeys = Object.keys(rawProbabilities)
  if (rawKeys.length !== SEMANTIC_SIGNAL_LABELS.size || rawKeys.some((key) => !SEMANTIC_SIGNAL_LABELS.has(key))) {
    return null
  }
  const probabilities = normalizedProbabilities(answer.probabilities)
  const keys = Object.keys(probabilities)
  if (keys.length !== SEMANTIC_SIGNAL_LABELS.size || keys.some((key) => !SEMANTIC_SIGNAL_LABELS.has(key))) {
    return null
  }
  const values = [...SEMANTIC_SIGNAL_LABELS].map((label) => probabilities[label])
  if (values.some((value) => typeof value !== "number")) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  if (Math.abs(total - 1) > 0.01) return null
  if (probabilities[prediction] < Math.max(...values)) return null

  const confidence = answer.confidence
  if (confidence !== undefined && (
    typeof confidence !== "number"
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
  )) return null

  return {
    prediction,
    probabilities,
    confidence: confidence ?? null,
  }
}

function interpretSemanticResult(candidate, result, mode) {
  const common = {
    bot: candidate.botId,
    surface: candidate.surface,
    sourceId: candidate.sourceId,
    inputHash: crypto.createHash("sha256").update(candidate.body).digest("hex").slice(0, 16),
    reviewedCommit: candidate.reviewedCommit,
    at: candidate.at,
    applied: false,
  }
  if (!result?.ok) {
    return {
      ...common,
      outcome: "provider-failure",
      reason: result?.reason || "unknown",
      latencyMs: result?.latencyMs ?? null,
    }
  }

  const signal = validChoiceEvidence(result.answers?.signal)
  const verdictProbability = noulProbability(result.answers?.hasVerdict)
  if (!signal || verdictProbability === null) {
    return {
      ...common,
      outcome: "invalid-answer",
      model: safeSemanticText(result.model),
      latencyMs: result.latencyMs ?? null,
    }
  }

  const rawPrediction = signal.prediction
  const sortedProbabilities = Object.values(signal.probabilities).sort((a, b) => b - a)
  const margin = sortedProbabilities[0] - sortedProbabilities[1]
  const decisive = verdictProbability >= MIN_VERDICT_PROBABILITY
    && signal.confidence !== null
    && signal.confidence >= MIN_SEMANTIC_CONFIDENCE
    && signal.probabilities[rawPrediction] >= MIN_SEMANTIC_PROBABILITY
    && margin >= MIN_SEMANTIC_MARGIN
  const prediction = ["clear", "feedback"].includes(rawPrediction) && !decisive ? "uncertain" : rawPrediction
  return {
    ...common,
    outcome: "decision",
    model: safeSemanticText(result.model),
    rawPrediction,
    prediction,
    verdictProbability,
    margin,
    confidence: signal.confidence,
    probabilities: signal.probabilities,
    latencyMs: result.latencyMs ?? null,
    // Semantic evidence may add a blocking feedback signal, but it cannot
    // manufacture approval. A clear result remains advisory until the
    // deterministic bot protocol supplies a clear review or reaction.
    applied: mode === "assist" && prediction === "feedback",
  }
}

export async function classifyPrReviewStateWithSemantic(
  { pr, rawComments = {}, prFlowConfig },
  { mode = "off", decide } = {},
) {
  const baseline = classifyPrReviewState({ pr, rawComments, prFlowConfig })
  if (!["shadow", "assist"].includes(mode) || typeof decide !== "function") return baseline
  if (["merged", "closed", "draft"].includes(baseline.overall)) return baseline

  const headSha = baseline.pr.headSha
  const bots = (prFlowConfig.requiredBots || []).map((id) => prFlowConfig.bots[id]).filter(Boolean)
  const candidates = bots
    .map((bot) => semanticCandidateForBot({ bot, headSha, rawComments }))
    .filter(Boolean)

  const decisions = await Promise.all(candidates.map(async (candidate) => {
    let result
    try {
      result = await decide({
        state: { reviewComment: candidate.body },
        questions: semanticReviewQuestions(),
      })
    } catch {
      result = { ok: false, reason: "adapter-error", latencyMs: null }
    }
    return interpretSemanticResult(candidate, result, mode)
  }))

  const semanticVerdicts = {}
  if (mode === "assist") {
    for (const decision of decisions.filter((item) => item.applied)) {
      semanticVerdicts[decision.bot] = {
        state: decision.prediction,
        feedback: {
          author: decision.bot,
          body: candidateSummary(candidates.find((candidate) => candidate.botId === decision.bot)?.body),
          file: null,
          line: null,
          commit: decision.reviewedCommit,
          url: candidates.find((candidate) => candidate.botId === decision.bot)?.url || "",
          at: decision.at,
        },
        at: decision.at,
      }
    }
  }

  const classified = Object.keys(semanticVerdicts).length > 0
    ? classifyPrReviewState({ pr, rawComments, prFlowConfig, semanticVerdicts })
    : baseline
  return {
    ...classified,
    semantic: {
      mode,
      enabled: true,
      candidateCount: candidates.length,
      appliedCount: decisions.filter((item) => item.applied).length,
      decisions,
    },
  }
}

function candidateSummary(body) {
  const firstLine = safeSemanticText(String(body || "").split("\n")[0].trim(), 240)
  return firstLine.slice(0, 240) || "Semantic classifier reported actionable feedback in a current-head bot comment."
}

function formatBotLine(bot) {
  const stale = bot.staleFeedbackCount ? `; ${bot.staleFeedbackCount} stale old-head finding${bot.staleFeedbackCount === 1 ? "" : "s"}` : ""
  return `  - ${bot.id}: ${bot.state} — ${bot.summary}${stale}`
}

export function formatPrStatusSummary(status) {
  const lines = [
    `btrain pr status: ${status.overall}`,
    `PR #${status.pr.number || "?"}: ${status.pr.title || "(untitled)"}`,
    status.pr.url ? `url: ${status.pr.url}` : "",
    `head: ${status.pr.headShort || "(unknown)"} | state: ${status.pr.state}`,
    "required bots:",
    ...status.bots.map(formatBotLine),
  ].filter(Boolean)

  if (status.semantic) {
    const availability = status.semantic.enabled ? "enabled" : `disabled (${status.semantic.reason || "unavailable"})`
    lines.push(`semantic review signals: ${status.semantic.mode} — ${availability}`)
    for (const decision of status.semantic.decisions || []) {
      const result = decision.prediction || decision.outcome || decision.reason || "unknown"
      const applied = decision.applied ? "; applied" : ""
      lines.push(`  - ${decision.bot}: ${result}${decision.model ? ` via ${decision.model}` : ""}${applied}`)
    }
  }

  const feedback = status.bots.flatMap((bot) => bot.feedback.map((item) => ({ bot: bot.id, ...item })))
  if (feedback.length > 0) {
    lines.push("feedback:")
    for (const item of feedback.slice(0, 12)) {
      const location = item.file ? `${item.file}:${item.line ?? "?"}` : "(review)"
      lines.push(`  - ${item.bot} ${location}: ${item.body || "(no summary)"}`)
    }
  }

  return lines.join("\n")
}

async function ghJson(args, cwd) {
  const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: GH_MAX_BUFFER })
  return JSON.parse(stdout)
}

async function ghApiPaginated(endpoint, cwd) {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", endpoint, "--paginate", "-H", "Accept: application/vnd.github+json"],
    { cwd, maxBuffer: GH_MAX_BUFFER },
  )
  return parseConcatenatedJsonArrays(stdout)
}

async function ghText(args, cwd, env = {}) {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", ...env },
    maxBuffer: GH_MAX_BUFFER,
  })
  return stdout.trim()
}

async function gitText(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: GH_MAX_BUFFER })
  return stdout.trim()
}

function findLane(result, laneId) {
  if (result.lanes) {
    return result.lanes.find((lane) => lane._laneId === laneId) || null
  }
  return result.current || null
}

async function resolveLaneAndPr(repoRoot, options) {
  const laneId = String(options.lane || "").trim()
  const handoff = await checkHandoff(repoRoot)
  if (handoff.lanes && !laneId) {
    throw new Error("`btrain pr` requires --lane <id> when lanes are enabled")
  }
  const lane = findLane(handoff, laneId)
  if (!lane) {
    throw new Error(`Unknown lane: ${laneId}`)
  }
  const explicitPr = normalizePrNumber(options.pr)
  const linkedPr = normalizePrNumber(lane.prNumber)
  // A lane-locked runner may only operate on its own lane's PR: polling or
  // re-reviewing another PR could resolve this lane against the wrong merge.
  if (process.env.BTRAIN_LANE_LOCKED === "1" && explicitPr && explicitPr !== linkedPr) {
    throw new Error(
      linkedPr
        ? `This btrain runner is scoped to lane ${laneId} (PR #${linkedPr}); refusing --pr ${explicitPr}.`
        : `This btrain runner is scoped to lane ${laneId}, which has no linked PR; refusing --pr ${explicitPr}.`,
    )
  }
  const prNumber = explicitPr || linkedPr
  if (!prNumber) {
    throw new Error("No PR linked. Pass --pr <number> or run `btrain pr create --lane <id>` first.")
  }
  return { laneId, lane, prNumber }
}

async function fetchMarkedIssueCommentReactions({ owner, repo, issueComments = [], cwd }) {
  const marked = (issueComments || []).filter((comment) => parseBtrainReviewMarker(comment.body))
  if (marked.length === 0) return {}

  const out = {}
  for (const comment of marked) {
    try {
      out[String(comment.id)] = await ghApiPaginated(
        `repos/${owner}/${repo}/issues/comments/${comment.id}/reactions`,
        cwd,
      )
    } catch {
      out[String(comment.id)] = []
    }
  }
  return out
}

export async function fetchPrMergeState(repoRoot, prNumber) {
  return ghJson(["pr", "view", prNumber, "--json", "url,mergeable,mergeStateStatus"], repoRoot)
}

export async function fetchPrReviewStatus(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  const prFlowConfig = getPrFlowConfig(config)
  const { prNumber } = await resolveLaneAndPr(repoRoot, options)

  if (!(await isGhAvailable())) {
    throw new Error("gh CLI is not installed; PR review flow requires gh.")
  }

  const pr = await ghJson([
    "pr",
    "view",
    prNumber,
    "--json",
    "number,title,url,state,isDraft,mergedAt,headRefOid,headRefName,baseRefName",
  ], repoRoot)
  const identity = await getRepoIdentity(repoRoot)
  const rawComments = await fetchAllComments({ ...identity, prNumber, cwd: repoRoot })
  rawComments.issueCommentReactions = await fetchMarkedIssueCommentReactions({
    ...identity,
    issueComments: rawComments.issueComments,
    cwd: repoRoot,
  })
  const input = { pr, rawComments, prFlowConfig }
  const semanticConfig = readSystemOneRuntimeConfig(process.env)
  if (semanticConfig.mode === "off") return classifyPrReviewState(input)
  if (!semanticConfig.enabled) {
    return {
      ...classifyPrReviewState(input),
      semantic: {
        mode: semanticConfig.mode,
        enabled: false,
        reason: semanticConfig.reason,
        candidateCount: 0,
        appliedCount: 0,
        decisions: [],
      },
    }
  }

  const client = createSystemOneClient(semanticConfig)
  return classifyPrReviewStateWithSemantic(input, {
    mode: semanticConfig.mode,
    decide: client.decide,
  })
}

export async function runPrStatus(repoRoot, options = {}) {
  const status = await fetchPrReviewStatus(repoRoot, options)
  if (options.format === "json") {
    console.log(JSON.stringify(status, null, 2))
  } else {
    console.log(formatPrStatusSummary(status))
  }
  return status
}

function botsOptionToIds(value, prFlowConfig) {
  if (!value || value === true || value === "all") return prFlowConfig.requiredBots
  if (String(value).trim().toLowerCase() === "none") return []
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildReviewRequestBody(bot, { laneId = "", headSha = "" } = {}) {
  const attrs = [`bot=${bot.id}`]
  if (laneId) attrs.push(`lane=${laneId}`)
  if (headSha) attrs.push(`head=${headSha}`)
  return `${bot.requestBody}\n\n<!-- btrain-pr-review ${attrs.join(" ")} -->`
}

export function selectReviewRequestHeadSha({
  prHeadSha = "",
  prHeadRefName = "",
  localBranch = "",
  localHeadSha = "",
  remoteHeadSha = "",
} = {}) {
  const localBranchMatches = localBranch && localBranch === prHeadRefName
  const localHeadIsPushed = commitMatches(localHeadSha, remoteHeadSha)
  return localBranchMatches && localHeadIsPushed ? localHeadSha : prHeadSha
}

// Normalize a remote URL to "host/owner/repo". Local paths and unknown
// forms have no host and yield "" — they can never be a GitHub PR head repo.
function normalizeRemoteTarget(url) {
  const raw = String(url || "").trim()
  const scpLike = /^[^@/]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(raw)
  if (scpLike) {
    return `${scpLike[1]}/${scpLike[2]}`.toLowerCase()
  }
  try {
    const parsed = new URL(raw)
    const repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "")
    if (parsed.host && repoPath) {
      return `${parsed.host}/${repoPath}`.toLowerCase()
    }
  } catch {
    // not a URL — fall through
  }
  return ""
}

async function remoteNameForRef(repoRoot, ref) {
  if (ref.startsWith("refs/remotes/")) {
    return ref.split("/")[2] || ""
  }
  const symbolic = await gitText(["rev-parse", "--symbolic-full-name", ref], repoRoot).catch(() => "")
  return symbolic.startsWith("refs/remotes/") ? symbolic.split("/")[2] || "" : ""
}

// The PR branch may be pushed through any remote (github, upstream, a fork
// remote), so let git resolve the branch's configured push target instead of
// assuming origin — but a matching branch name on an unrelated repository is
// not the PR head, so when the PR's head repo is known the remote must point
// at that exact host and slug.
export async function resolvePushedHeadSha(repoRoot, branchName, expectedHeadTarget = "") {
  if (!branchName) {
    return ""
  }
  const expected = String(expectedHeadTarget || "").trim().toLowerCase()
  for (const ref of [`${branchName}@{push}`, `${branchName}@{upstream}`, `refs/remotes/origin/${branchName}`]) {
    const sha = await gitText(["rev-parse", "--verify", "--quiet", ref], repoRoot).catch(() => "")
    if (!sha) {
      continue
    }
    if (expected) {
      const remoteName = await remoteNameForRef(repoRoot, ref)
      const remoteUrl = remoteName
        ? await gitText(["remote", "get-url", remoteName], repoRoot).catch(() => "")
        : ""
      if (normalizeRemoteTarget(remoteUrl) !== expected) {
        continue
      }
    }
    return sha
  }
  return ""
}

async function fetchPrHeadSha(repoRoot, prNumber) {
  const pr = await ghJson(
    ["pr", "view", prNumber, "--json", "headRefOid,headRefName,headRepository,headRepositoryOwner,url"],
    repoRoot,
  )
  const headOwner = pr?.headRepositoryOwner?.login || ""
  const headRepo = pr?.headRepository?.name || ""
  let headTarget = ""
  if (headOwner && headRepo) {
    try {
      // The head repo lives on the same host as the PR itself.
      const host = new URL(String(pr?.url || "")).host
      headTarget = host ? `${host}/${headOwner}/${headRepo}` : ""
    } catch {
      headTarget = ""
    }
  }
  const [localBranch, localHeadSha, remoteHeadSha] = await Promise.all([
    gitText(["branch", "--show-current"], repoRoot).catch(() => ""),
    gitText(["rev-parse", "HEAD"], repoRoot).catch(() => ""),
    resolvePushedHeadSha(repoRoot, pr?.headRefName || "", headTarget),
  ])
  return selectReviewRequestHeadSha({
    prHeadSha: pr?.headRefOid || "",
    prHeadRefName: pr?.headRefName || "",
    localBranch,
    localHeadSha,
    remoteHeadSha,
  })
}

async function requestReviewComments(repoRoot, prNumber, botIds, prFlowConfig, context = {}) {
  const posted = []
  for (const botId of botIds) {
    const bot = prFlowConfig.bots[botId]
    if (!bot) continue
    const body = buildReviewRequestBody(bot, context)
    await ghText(["pr", "comment", prNumber, "--body", body], repoRoot)
    posted.push({ bot: botId, body: bot.requestBody })
  }
  return posted
}

export async function applyPrStatusToHandoff(repoRoot, options, status) {
  const { laneId, lane, prNumber } = await resolveLaneAndPr(repoRoot, options)
  const actor = typeof options.actor === "string" && options.actor.trim()
    ? options.actor.trim()
    : undefined
  const actorLabel = actor || lane.owner || "owner"

  // Terminal PR outcomes (merged/closed) require the lane to be in a
  // PR-flow state. An explicit --pr on an in-progress lane must not
  // short-circuit through here and abandon work / release locks.
  const prFlowStatuses = new Set(["ready-for-pr", "pr-review", "ready-to-merge", "changes-requested"])

  if (status.overall === "merged") {
    if (!prFlowStatuses.has(lane.status)) {
      throw new BtrainError({
        message: `Cannot apply merged-PR outcome to lane ${laneId} in \`${lane.status}\`.`,
        reason: "Only lanes in a PR-flow state can be terminally resolved by a PR outcome.",
        fix: `Move the lane into PR-flow first, or claim a fresh lane.`,
      })
    }
    await resolveHandoff(repoRoot, {
      lane: laneId,
      actor,
      pr: prNumber,
      final: true,
      viaPrOutcome: true,
      summary: `PR #${prNumber} merged${status.pr.mergedAt ? ` at ${status.pr.mergedAt}` : ""}.`,
    })
    return "resolved"
  }

  if (status.overall === "closed") {
    // spec 002 v1.1.2: close without merge is terminal `resolved` plus lock
    // release — the same terminal outcome as a merge, not `repair-needed`
    // (spec 006 retention covers workflow-integrity repair, not GitHub
    // close).
    if (!prFlowStatuses.has(lane.status)) {
      throw new BtrainError({
        message: `Cannot apply closed-PR outcome to lane ${laneId} in \`${lane.status}\`.`,
        reason: "Only lanes in a PR-flow state can be terminally resolved by a PR outcome.",
        fix: `Move the lane into PR-flow first, or claim a fresh lane.`,
      })
    }
    await resolveHandoff(repoRoot, {
      lane: laneId,
      actor,
      pr: prNumber,
      final: true,
      viaPrOutcome: true,
      summary: `PR #${prNumber} closed without a merge; lane resolved and locks released per spec 002 v1.1.2. Reopen with a fresh claim if the work should continue.`,
    })
    return "resolved"
  }

  if (status.overall === "feedback") {
    const feedbackBots = status.bots.filter((bot) => bot.state === "feedback").map((bot) => bot.id)
    await patchHandoff(repoRoot, {
      lane: laneId,
      actor,
      status: "changes-requested",
      pr: prNumber,
      "reason-code": "pr-review-feedback",
      "reason-tag": feedbackBots,
      transitionEvent: "pr-poll",
      next: `Address ${feedbackBots.join(", ")} feedback on PR #${prNumber}, push, then run \`btrain pr request-review --lane ${laneId} --bots all\` and \`btrain handoff update --lane ${laneId} --status pr-review --actor "${actorLabel}"\`.`,
    })
    return "changes-requested"
  }

  if (status.overall === "ready-to-merge") {
    await patchHandoff(repoRoot, {
      lane: laneId,
      actor,
      status: "ready-to-merge",
      pr: prNumber,
      transitionEvent: "pr-poll",
      next: `Required bot feedback is clear on PR #${prNumber}. Merge the PR, then run \`btrain pr poll --lane ${laneId} --apply\` to resolve the lane.`,
    })
    return "ready-to-merge"
  }

  await patchHandoff(repoRoot, {
    lane: laneId,
    actor,
    status: "pr-review",
    pr: prNumber,
    transitionEvent: "pr-poll",
    next: `Waiting on required PR reviewers for PR #${prNumber}. Poll with \`btrain pr poll --lane ${laneId} --apply\`.`,
  })
  return "pr-review"
}

export async function runPrPoll(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  const prFlowConfig = getPrFlowConfig(config)
  const { laneId, prNumber } = await resolveLaneAndPr(repoRoot, options)
  const identity = await getRepoIdentity(repoRoot)
  const rawComments = await fetchAllComments({ ...identity, prNumber, cwd: repoRoot })
  const shaped = shapeComments(rawComments)
  const appended = await appendComments(repoRoot, laneId, prNumber, shaped)
  const status = await fetchPrReviewStatus(repoRoot, options)

  if (options.format === "json") {
    console.log(JSON.stringify({ ...status, appendedToLog: appended.length }, null, 2))
  } else {
    console.log(formatPrStatusSummary(status))
    console.log(`comments logged: ${appended.length} new`)
  }

  if (options.apply) {
    const nextStatus = await applyPrStatusToHandoff(repoRoot, options, status)
    console.log(`handoff updated: ${nextStatus}`)
  }

  if (options["request-review"] && ["feedback", "waiting", "draft"].includes(status.overall)) {
    const botIds = botsOptionToIds(options.bots, prFlowConfig)
    const posted = await requestReviewComments(repoRoot, prNumber, botIds, prFlowConfig, {
      laneId,
      headSha: status.pr.headSha,
    })
    for (const item of posted) {
      console.log(`requested ${item.bot}: ${item.body}`)
    }
  }

  return status
}

export async function runPrRequestReview(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  const prFlowConfig = getPrFlowConfig(config)
  const { laneId, prNumber } = await resolveLaneAndPr(repoRoot, options)
  const botIds = botsOptionToIds(options.bots, prFlowConfig)
  const posted = await requestReviewComments(repoRoot, prNumber, botIds, prFlowConfig, {
    laneId,
    headSha: await fetchPrHeadSha(repoRoot, prNumber),
  })

  for (const item of posted) {
    console.log(`requested ${item.bot}: ${item.body}`)
  }
  if (posted.length === 0) {
    console.log("no bot review requests posted")
  }
  return posted
}

function buildPrBody(lane) {
  const packet = lane.delegationPacket || {}
  const lines = [
    "## Summary",
    "",
    packet.deliverable || lane.task || "btrain lane work",
    "",
    "## btrain lane",
    "",
    `- Lane: ${lane._laneId || lane.lane || "(single)"}`,
    `- Owner: ${lane.owner || "(unknown)"}`,
    `- Reviewer: ${lane.reviewer || "(unknown)"}`,
    packet.objective ? `- Objective: ${packet.objective}` : "",
    "",
    "## Verification",
    "",
    "See the lane handoff packet for the current verification list and review asks.",
  ].filter(Boolean)
  return lines.join("\n")
}

// The PR base lives on the repository gh targets, which in fork workflows is
// not the push remote. Mirror gh's resolution: the remote marked by
// `gh repo set-default` (remote.<name>.gh-resolved), else upstream, github,
// origin, else the first remote.
async function resolveBaseRemote(repoRoot) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "config", "--get-regexp", "^remote\\..+\\.gh-resolved$"],
      { cwd: repoRoot, maxBuffer: GH_MAX_BUFFER },
    )
    const marked = stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0]
    if (marked) {
      return marked.split(".").slice(1, -1).join(".")
    }
  } catch {
    // no gh-resolved marker configured
  }
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, "remote"], {
    cwd: repoRoot,
    maxBuffer: GH_MAX_BUFFER,
  })
  const remotes = stdout.split("\n").map((line) => line.trim()).filter(Boolean)
  for (const candidate of ["upstream", "github", "origin"]) {
    if (remotes.includes(candidate)) {
      return candidate
    }
  }
  return remotes[0] || "origin"
}

// gh needs the base to exist on the PR target remote; local remote-tracking
// refs are not proof either way (single-branch clones and stale fetches miss
// branches that do exist), so ask the remote itself.
export async function remoteBranchExists(repoRoot, name, baseRemote = null) {
  const remote = baseRemote || (await resolveBaseRemote(repoRoot))
  try {
    // The full refs/heads/ pattern forces an exact match — a bare name also
    // matches nested branches sharing the suffix (release/<name>).
    await execFileAsync(
      "git",
      ["-C", repoRoot, "ls-remote", "--exit-code", "--heads", remote, `refs/heads/${name}`],
      { cwd: repoRoot, maxBuffer: GH_MAX_BUFFER },
    )
    return true
  } catch (error) {
    // ls-remote --exit-code reserves 2 for "no matching refs"; anything else
    // (auth, network, bad remote) is an operational failure, not absence.
    if (error?.code === 2) {
      return false
    }
    throw error
  }
}

// Positive validation: git itself decides what a branch name is. Rejects
// uppercase HEAD, rev expressions (HEAD~1, main@{upstream}), ranges
// (main...HEAD), and object expressions (main:path) while permitting
// ordinary names like "head" or "af14b47". check-ref-format needs no repo.
async function isValidBranchName(name) {
  try {
    await execFileAsync("git", ["check-ref-format", "--branch", name], {
      maxBuffer: GH_MAX_BUFFER,
    })
    return true
  } catch {
    return false
  }
}

function stripRemotePrefixes(ref, remote = "origin") {
  const escaped = remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return ref
    .replace(new RegExp(`^refs/remotes/${escaped}/`), "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(new RegExp(`^${escaped}/`), "")
    .replace(/^origin\//, "")
}

export async function resolvePrBaseBranch(
  base,
  fallback = "main",
  { isBranchName = isValidBranchName, isRemoteBranch = async () => false, remote = "origin", strict = false } = {},
) {
  const fallbackBranch = stripRemotePrefixes(String(fallback || "").trim(), remote) || "main"
  // strict is for explicit user overrides (--base): a base that cannot be
  // used is an error, never a silent retarget. Fallback is reserved for
  // machine-written lane Base metadata.
  const reject = (reason) => {
    if (strict) {
      throw new Error(`Base "${String(base ?? "")}" ${reason}. Pass --base <branch> naming a branch that exists on ${remote}.`)
    }
    return fallbackBranch
  }
  const ref = String(base || "").trim()
  if (!ref || /\s/.test(ref)) {
    return reject("is not a branch name")
  }
  const branch = stripRemotePrefixes(ref, remote)
  if (branch === "HEAD" || !(await isBranchName(branch))) {
    return reject("is not a valid branch name")
  }
  // Well-formed is not enough: tags, commit SHAs, and unpushed branches all
  // pass check-ref-format, but gh requires a branch that exists on the
  // remote. Only the remote itself can confirm that.
  if (!(await isRemoteBranch(branch))) {
    return reject(`is not a branch on ${remote}`)
  }
  return branch
}

export async function runPrCreate(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  const prFlowConfig = getPrFlowConfig(config)
  const laneId = String(options.lane || "").trim()
  const handoff = await checkHandoff(repoRoot)
  if (handoff.lanes && !laneId) {
    throw new Error("`btrain pr create` requires --lane <id> when lanes are enabled")
  }
  const lane = findLane(handoff, laneId)
  if (!lane) {
    throw new Error(`Unknown lane: ${laneId}`)
  }
  if (lane.status !== "ready-for-pr") {
    const laneLabel = laneId || "(single)"
    const reviewerHint = lane.reviewer ? ` --actor "${lane.reviewer}"` : ""
    throw new Error(
      `\`btrain pr create\` requires lane ${laneLabel} to be in \`ready-for-pr\` (local peer review approved). Current status: \`${lane.status}\`. `
        + `Run \`btrain handoff resolve --lane ${laneLabel}${reviewerHint}\` after the local review passes; PR-flow repos route that to ready-for-pr. `
        + `To relink an existing PR without re-running create, use \`btrain handoff update --lane ${laneLabel} --status pr-review --pr <number> --actor "${lane.owner || "owner"}"\`.`,
    )
  }

  validatePrCreateTransition(lane, options.actor || lane.owner || "btrain")

  const branch = await gitText(["branch", "--show-current"], repoRoot)
  if (!branch || ["main", "master"].includes(branch)) {
    throw new Error("Create a feature branch before running `btrain pr create`.")
  }
  const headSha = await gitText(["rev-parse", "HEAD"], repoRoot)

  // Lane Base fields often hold diff refs ("origin/main") or prose, but
  // `gh pr create --base` only accepts a branch name on the remote.
  const baseRemote = await resolveBaseRemote(repoRoot)
  const isRemoteBranch = (name) => remoteBranchExists(repoRoot, name, baseRemote)
  const base = options.base
    ? await resolvePrBaseBranch(options.base, prFlowConfig.base, { isRemoteBranch, remote: baseRemote, strict: true })
    : await resolvePrBaseBranch(lane.base, prFlowConfig.base, { isRemoteBranch, remote: baseRemote })
  if (!options["no-push"]) {
    await execFileAsync("git", ["push", "-u", "origin", branch], {
      cwd: repoRoot,
      maxBuffer: GH_MAX_BUFFER,
    })
  }

  const title = typeof options.title === "string" && options.title.trim() ? options.title.trim() : lane.task || branch
  const body = typeof options.body === "string" && options.body.trim() ? options.body.trim() : buildPrBody(lane)
  const args = ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body]
  if (options.draft) {
    args.push("--draft")
  }
  const url = await ghText(args, repoRoot)
  const number = normalizePrNumber(url)

  await patchHandoff(repoRoot, {
    lane: laneId,
    actor: options.actor || lane.owner || "btrain",
    status: "pr-review",
    pr: number,
    transitionEvent: "pr-create",
    transitionCompatibility: true,
    base,
    next: `PR #${number} is open. Poll with \`btrain pr poll --lane ${laneId} --apply\`; request re-review with \`btrain pr request-review --lane ${laneId} --bots all\`.`,
  })

  console.log(url)

  const botIds = botsOptionToIds(options.bots, prFlowConfig)
  const posted = await requestReviewComments(repoRoot, number, botIds, prFlowConfig, { laneId, headSha })
  for (const item of posted) {
    console.log(`requested ${item.bot}: ${item.body}`)
  }

  return { url, number, posted }
}

export function validatePrCreateTransition(lane, actor) {
  return applyTransition(lane, "pr-create", {
    to: "pr-review",
    actor,
    prFlowEnabled: true,
    prLinked: true,
    structuralCompatibility: true,
  })
}
