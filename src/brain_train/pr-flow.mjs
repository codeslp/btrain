// pr-flow.mjs — GitHub PR review loop for btrain lanes.
//
// btrain's local handoff remains the peer review gate. This module handles the
// next phase: create/link a GitHub PR, collect bot feedback, request re-review,
// and keep the lane active until the PR is merged or intentionally closed.

import { execFile } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import {
  BtrainError,
  checkHandoff,
  getPrFlowConfig,
  getRepoPaths,
  normalizePrNumber,
  patchHandoff,
  readProjectConfig,
  resolveHandoff,
} from "./core.mjs"
import { applyTransition } from "./transitions.mjs"
import { enforceLocalReview } from "./local_review.mjs"
import {
  appendComments,
  fetchAllComments,
  getRepoIdentity,
  ghHostArgs,
  isGhAvailable,
  parseConcatenatedJsonArrays,
  shapeComments,
} from "./handoff/pr-comments.mjs"
import { resolveStateRoot } from "./worktree.mjs"
import {
  createSystemOneClient,
  loadSystemOneRuntimeConfig,
} from "./system-one.mjs"

const execFileAsync = promisify(execFile)
const GH_MAX_BUFFER = 16 * 1024 * 1024
const MIN_COMMIT_PREFIX_LENGTH = 10

const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function stripGitSuffix(value) {
  return String(value).replace(/\.git$/i, "").replace(/\/+$/, "")
}

// One spelling for one repository. A remote arrives as a clone URL, an
// scp-like address, or the `host/owner/repo` a reviewer types, and all three
// must compare equal. A remote with no host is a path, kept verbatim after
// `path:` because paths are case-sensitive where hosts are not.
function canonicalRepoIdentity(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "")
  if (!raw) return ""
  if (raw.toLowerCase().startsWith("path:")) {
    const rest = stripGitSuffix(raw.slice(5).trim())
    return rest ? `path:${rest}` : ""
  }
  const scpLike = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw)
  if (scpLike) {
    return `${scpLike[1]}/${stripGitSuffix(scpLike[2]).replace(/^\/+/, "")}`.toLowerCase()
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed
    let repoPath
    try {
      parsed = new URL(raw)
      repoPath = stripGitSuffix(decodeURIComponent(parsed.pathname).replace(/^\/+/, ""))
    } catch {
      return ""
    }
    if (parsed.protocol === "file:") return repoPath ? `path:/${repoPath}` : ""
    if (!parsed.host || !repoPath) return ""
    return `${parsed.host}/${repoPath}`.toLowerCase()
  }
  if (raw.startsWith("/") || raw.startsWith(".") || raw.startsWith("~")) {
    const rest = stripGitSuffix(raw)
    return rest ? `path:${rest}` : ""
  }
  // `host/owner/repo` as a reviewer writes it. A bare word names no
  // repository — a remote name like `origin` means nothing outside one
  // checkout — so it is not an identity.
  return raw.includes("/") ? stripGitSuffix(raw).toLowerCase() : ""
}

function laneEventLogPath(repoRoot, laneId = "") {
  const { eventsDir } = getRepoPaths(repoRoot)
  return path.join(eventsDir, laneId ? `lane-${laneId}.jsonl` : "repo.jsonl")
}

async function readLaneEvents(repoRoot, laneId = "") {
  let content = ""
  try {
    content = await fs.readFile(laneEventLogPath(repoRoot, laneId), "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function shaMatches(left, right) {
  const a = String(left || "").trim().toLowerCase()
  const b = String(right || "").trim().toLowerCase()
  if (!FULL_OBJECT_ID_PATTERN.test(a) || !FULL_OBJECT_ID_PATTERN.test(b)) return false
  return a === b
}

function normalizePrTarget({ repo = "", ref = "", sha = "" } = {}) {
  const identity = canonicalRepoIdentity(repo)
  const baseRef = String(ref || "").trim()
  const baseSha = String(sha || "").trim().toLowerCase()
  if (!identity || !baseRef || !FULL_OBJECT_ID_PATTERN.test(baseSha)) return null
  return { repo: identity, ref: baseRef, sha: baseSha }
}

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
      baseSha: String(pr?.baseRefOid || pr?.base?.sha || "").toLowerCase(),
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

function semanticCandidatesForBot({ bot, headSha, rawComments, baselineState }) {
  const botInline = (rawComments.reviewComments || []).filter((comment) => loginMatches(bot, comment.user?.login))
  const currentInline = botInline.filter((comment) => commitMatches(inlineReviewedCommit(comment), headSha))
  if (currentInline.length > 0 && baselineState === "feedback") return []

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
  // Ambiguous text tied with deterministic evidence still needs classification:
  // validated feedback wins the tie when applied below, regardless of surface.
  const annotated = activities.map((activity) => ({
    ...activity,
    eligible: (activity.surface === "issue" || (
      activity.surface === "review" && String(activity.item.state || "").toUpperCase() === "COMMENTED"
    )) && !!String(activity.item.body || "").trim()
      && !bodyIndicatesClear(activity.item.body)
      && !bodyIndicatesFeedback(activity.item.body),
  }))
  const latestTime = annotated.reduce((latest, activity) => Math.max(latest, activity.time), -Infinity)

  return annotated
    .filter((activity) => activity.eligible && activity.time === latestTime)
    .map((selected) => ({
      botId: bot.id,
      surface: selected.surface,
      sourceId: selected.item.id || null,
      body: String(selected.item.body || ""),
      url: selected.item.html_url || selected.item.url || "",
      // Selection already requires the comment to attest headSha; keep the full SHA.
      reviewedCommit: headSha,
      at: selected.item.submitted_at || selected.item.created_at || selected.item.updated_at || "",
    }))
}

function sourceRepository(pr) {
  for (const value of [pr?.html_url, pr?.url]) {
    if (typeof value !== "string") continue
    try {
      const url = new URL(value)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts.length === 4 && parts[2] === "pull" && parts[3] === String(pr?.number)) return { repository: `${parts[0]}/${parts[1]}`, host: url.host.toLowerCase() }
      if (parts.length === 5 && parts[0] === "repos" && parts[3] === "pulls" && parts[4] === String(pr?.number)) return { repository: `${parts[1]}/${parts[2]}`, host: url.host.toLowerCase() === "api.github.com" ? "github.com" : url.host.toLowerCase() }
    } catch { /* Try the other GitHub URL shape. */ }
  }
  return null
}

function normalizedSourceRef(value) {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol)) return null
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch { return null }
}

function frozenReviewedCommitMatches(source, body, headSha) {
  const attested = source.reviewedCommit
  if (!commitMatches(attested, headSha)) return false
  if (attested.length === 40) return true
  return source.surface === "issue"
    && source.eventAt && source.updatedAt
    && Date.parse(source.eventAt) === Date.parse(source.updatedAt)
    && extractReviewedCommit(body).toLowerCase() === attested.toLowerCase()
}

// Build source-bound cases for offline replay. A captured full reviewed-commit
// attestation can prove the evaluated commit without claiming an event-time head.
// A later polling-time head alone never makes an unknown event head current.
export function buildPrSemanticReplayCandidates({ pr, rawComments = {}, prFlowConfig, sourceSnapshots }) {
  if (!Array.isArray(sourceSnapshots)) throw new Error("Source snapshots are required for PR replay")
  const baseline = classifyPrReviewState({ pr, rawComments, prFlowConfig })
  const headSha = baseline.pr.headSha
  if (!/^[a-f0-9]{40}$/i.test(headSha || "")) throw new Error("A full PR head SHA is required for offline replay")
  const identity = sourceRepository(pr)
  const repository = identity?.repository
  const bots = (prFlowConfig.requiredBots || []).map((id) => prFlowConfig.bots[id]).filter(Boolean)
  const selected = bots.flatMap((bot) => semanticCandidatesForBot({
    bot, headSha, rawComments,
    baselineState: baseline.bots.find((result) => result.id === bot.id)?.state,
  }))
  const candidates = []
  const excluded = []
  // null for a missing or unparseable ref, so it never equals the PR's host.
  const sourceHost = (source) => {
    const ref = normalizedSourceRef(source.sourceRef)
    return ref ? new URL(ref).host.toLowerCase() : null
  }
  for (const candidate of selected) {
    const eventVersions = sourceSnapshots.filter((source) => source?.surface === candidate.surface && String(source.eventId) === String(candidate.sourceId))
    const matchesIdentity = (source) => identity && source.repository === identity.repository && source.prNumber === pr.number
      && sourceHost(source) === identity.host
      && typeof source.id === "string" && /^[a-f0-9]{64}$/.test(source.id)
    const versions = eventVersions.filter(matchesIdentity)
    excluded.push(...[...new Set(eventVersions.filter((source) => !matchesIdentity(source)).map((source) => source.id || candidate.sourceId))]
      .map((sourceId) => ({ sourceId, reason: "source-identity-mismatch" })))
    if (eventVersions.length && !versions.length) continue
    const bodyHash = crypto.createHash("sha256").update(candidate.body).digest("hex")
    const exactVersions = versions.filter((source) => source.sourceHash === bodyHash)
    const matches = exactVersions.length ? exactVersions : versions
    if (matches.length > 1) {
      excluded.push(...[...new Set(matches.map((source) => source.id))].map((sourceId) => ({ sourceId, reason: "ambiguous-source-snapshot" })))
      continue
    }
    const source = matches[0] || null
    const sourceId = source?.id || candidate.sourceId
    const candidateSourceRef = normalizedSourceRef(candidate.url)
    let reason = null
    if (!source) reason = "missing-source-snapshot"
    else if (source.eventHead && source.eventHead !== "unknown" && !/^[a-f0-9]{40}$/i.test(source.eventHead)) reason = "invalid-event-head"
    else if (source.eventHead && source.eventHead !== "unknown" && source.eventHead.toLowerCase() !== headSha.toLowerCase()) reason = "stale-event-head"
    else if (source.reviewedCommit && !frozenReviewedCommitMatches(source, candidate.body, headSha)) reason = "stale-reviewed-commit"
    else if ((!source.eventHead || source.eventHead === "unknown") && !frozenReviewedCommitMatches(source, candidate.body, headSha)) reason = "unknown-event-head"
    else if (!candidateSourceRef || candidateSourceRef !== source.sourceRef) reason = "source-ref-mismatch"
    else if (crypto.createHash("sha256").update(candidate.body).digest("hex") !== source.sourceHash) reason = "source-hash-mismatch"
    if (reason) {
      excluded.push({ sourceId, reason })
      continue
    }
    candidates.push({
      sourceId: source.id,
      sourceRef: source.sourceRef,
      sourceRefs: [source.sourceRef],
      sourceHash: source.sourceHash,
      sourceContent: candidate.body,
      baseline: "uncertain",
      eligible: true,
      privacyClass: "private",
      callIndex: 0,
      reviewedCommit: headSha,
      headEvidence: source.eventHead?.toLowerCase() === headSha.toLowerCase() ? "event-head" : source.reviewedCommit.length === 40 ? "reviewed-commit" : "reviewed-commit-prefix",
    })
  }
  const accounted = new Set([...candidates, ...excluded].map((entry) => entry.sourceId))
  for (const source of sourceSnapshots) {
    if (!source || source.repository !== repository || source.prNumber !== pr.number || !source.id || accounted.has(source.id)) continue
    let reason = "not-current-semantic-candidate"
    if (sourceHost(source) !== identity?.host) reason = "source-identity-mismatch"
    else if (source.eventHead && source.eventHead !== "unknown" && !/^[a-f0-9]{40}$/i.test(source.eventHead)) reason = "invalid-event-head"
    else if (source.eventHead && source.eventHead !== "unknown" && source.eventHead.toLowerCase() !== headSha.toLowerCase()) reason = "stale-event-head"
    else if (source.reviewedCommit && !commitMatches(source.reviewedCommit, headSha)) reason = "stale-reviewed-commit"
    else if ((!source.eventHead || source.eventHead === "unknown") && !source.reviewedCommit) reason = "unknown-event-head"
    excluded.push({ sourceId: source.id, reason })
    accounted.add(source.id)
  }
  return { candidates, excluded }
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
    .flatMap((bot) => semanticCandidatesForBot({
      bot, headSha, rawComments,
      baselineState: baseline.bots.find((result) => result.id === bot.id)?.state,
    }))
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
      const source = candidates.find((candidate) => (
        candidate.botId === decision.bot
        && candidate.surface === decision.surface
        && candidate.sourceId === decision.sourceId
      ))
      semanticVerdicts[decision.bot] = {
        state: decision.prediction,
        feedback: {
          author: decision.bot,
          body: candidateSummary(source?.body),
          file: null,
          line: null,
          commit: decision.reviewedCommit,
          url: source?.url || "",
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
      const result = decision.outcome === "provider-failure" && decision.reason
        ? `${decision.outcome} (${decision.reason})`
        : decision.prediction || decision.outcome || decision.reason || "unknown"
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

async function ghApiPaginated(endpoint, cwd, host = "") {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", endpoint, ...ghHostArgs(host), "--paginate", "-H", "Accept: application/vnd.github+json"],
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
  // An explicit number may adopt a PR for an unlinked lane. A linked lane
  // must be relinked before a command can operate on a different number.
  if (explicitPr && linkedPr && explicitPr !== linkedPr) {
    throw new Error(
      `Lane ${laneId || "(single)"} is linked to PR #${linkedPr}; refusing --pr ${explicitPr}. `
        + `Relink the lane first with \`btrain handoff update --lane ${laneId || "<id>"} --status pr-review --pr ${explicitPr}\`, or run the command without --pr.`,
    )
  }
  const prNumber = explicitPr || linkedPr
  if (!prNumber) {
    throw new Error("No PR linked. Pass --pr <number> or run `btrain pr create --lane <id>` first.")
  }
  // One resolution per command, shared by every GitHub call it makes, so a
  // lane cannot view one repository's PR and comment on another's. Only the
  // lane's own PR is pinned; an explicit `--pr` on a lane with none linked is
  // a look at someone else's PR, not an adoption of it.
  const prRepo = await resolvePrRepository(repoRoot, {
    laneId,
    prNumber,
    url: String(options.pr ?? ""),
    linked: prNumber === linkedPr,
  })
  return { laneId, lane, prNumber, prRepo }
}

async function fetchMarkedIssueCommentReactions({ host = "", owner, repo, issueComments = [], cwd }) {
  const marked = (issueComments || []).filter((comment) => parseBtrainReviewMarker(comment.body))
  if (marked.length === 0) return {}

  const out = {}
  for (const comment of marked) {
    try {
      out[String(comment.id)] = await ghApiPaginated(
        `repos/${owner}/${repo}/issues/comments/${comment.id}/reactions`,
        cwd,
        host,
      )
    } catch {
      out[String(comment.id)] = []
    }
  }
  return out
}

// The lanes of this checkout that have pinned a repository for `prNumber`
// under their current claim, as a map of repository to the lanes holding it.
// A PR number is not an identity on its own, so the lookup answers with
// everything it found and leaves the decision to the caller.
async function lanesAssociatedWithPr(repoRoot, prNumber) {
  const handoff = await checkHandoff(repoRoot)
  const lanes = handoff.lanes || (handoff.current ? [handoff.current] : [])
  const byRepo = new Map()
  for (const lane of lanes) {
    if (normalizePrNumber(lane.prNumber) !== prNumber) continue
    const laneId = String(lane._laneId || "")
    const claim = await currentClaimStamp(repoRoot, laneId)
    const pinned = await readPrAssociation(repoRoot, laneId, prNumber, claim)
    if (!pinned?.repo) continue
    byRepo.set(pinned.repo, [...(byRepo.get(pinned.repo) || []), laneId || "(single)"])
  }
  return byRepo
}

// `btrain go` probes a lane's merge state with the repository root and the PR
// number alone: it renders every lane in one loop and carries no lane
// identity into the call. Re-deriving the repository from the checkout's
// current remote would make a repointed remote enough to answer about a
// different `#7` — exactly what the association exists to prevent — so the
// lane that adopted this number answers for it instead. Two lanes holding
// this number in two repositories make the number ambiguous, and an ambiguous
// lookup is refused rather than resolved to one of them. With no association
// at all the derivation stands, which is what a lane that has pinned nothing
// still relies on.
async function resolveProbePrRepository(repoRoot, prNumber) {
  const byRepo = await lanesAssociatedWithPr(repoRoot, prNumber)
  const repos = [...byRepo.keys()]
  if (repos.length === 1) return repos[0]
  if (repos.length > 1) {
    throw new BtrainError({
      message: `PR #${prNumber} is associated with more than one repository in this checkout: ${
        repos.map((repo) => `\`${repo}\` (lane ${byRepo.get(repo).join(", ")})`).join(", ")
      }.`,
      reason: "A PR number names no repository, so a lookup that carries no lane cannot tell these PRs apart.",
      fix: "Ask for this PR through its own lane, which resolves the repository that lane is associated with.",
    })
  }
  return resolvePrRepository(repoRoot)
}

export async function fetchPrMergeState(repoRoot, prNumber, prRepo = null) {
  const repo = prRepo === null ? await resolveProbePrRepository(repoRoot, prNumber) : prRepo
  return ghJson(["pr", "view", prNumber, ...ghRepoArgs(repo), "--json", "url,mergeable,mergeStateStatus"], repoRoot)
}

export async function fetchPrReviewStatus(repoRoot, options = {}) {
  const config = await readProjectConfig(repoRoot)
  const prFlowConfig = getPrFlowConfig(config)
  const { prNumber, prRepo } = await resolveLaneAndPr(repoRoot, options)

  return fetchResolvedPrReviewStatus(repoRoot, prFlowConfig, prNumber, prRepo)
}

async function fetchResolvedPrReviewStatus(repoRoot, prFlowConfig, prNumber, prRepo) {
  if (!(await isGhAvailable())) {
    throw new Error("gh CLI is not installed; PR review flow requires gh.")
  }

  const pr = await ghJson([
    "pr",
    "view",
    prNumber,
    ...ghRepoArgs(prRepo),
    "--json",
    "number,title,url,state,isDraft,mergedAt,headRefOid,headRefName,baseRefName,baseRefOid",
  ], repoRoot)
  requirePrIdentity(pr, prNumber, prRepo)
  const identity = await prRestIdentity(repoRoot, prRepo)
  const rawComments = await fetchAllComments({ ...identity, prNumber, cwd: repoRoot })
  rawComments.issueCommentReactions = await fetchMarkedIssueCommentReactions({
    ...identity,
    issueComments: rawComments.issueComments,
    cwd: repoRoot,
  })
  const input = { pr, rawComments, prFlowConfig }
  const semanticConfig = await loadSystemOneRuntimeConfig(process.env)
  if (semanticConfig.mode === "off" && semanticConfig.reason === "mode-off") {
    return classifyPrReviewState(input)
  }
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

// The live revision of a branch on the remote itself, not the local tracking
// cache. `git ls-remote` talks to the remote every time; `refs/remotes/...`
// is only as fresh as the last fetch.
export async function fetchRemoteBranchSha(repoRoot, remote, branch) {
  if (!remote || !branch) return ""
  const output = await gitText(["ls-remote", remote, `refs/heads/${branch}`], repoRoot).catch(() => "")
  const match = /^([0-9a-f]{40,64})\s/m.exec(output)
  return match ? match[1].toLowerCase() : ""
}

// A remote URL can carry credentials (https://user:token@host/owner/repo).
// Diagnostics are printed, logged and pasted into reviews, so only the
// host and path of a push destination are ever shown.
export function redactRemoteUrl(url) {
  const raw = String(url || "").trim()
  if (!raw) return ""
  const scpLike = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(raw)
  if (scpLike) return `${scpLike[2]}:${scpLike[3]}`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return "(unparseable remote URL)"
  }
  const credentials = parsed.username || parsed.password ? "***@" : ""
  return `${parsed.protocol}//${credentials}${parsed.host}${parsed.pathname}`
}

// `git push <remote>` writes to the remote's push URLs, which are not its
// fetch URL when `remote.<name>.pushurl` is set — and a remote may have
// several, every one of which receives the push. Verifying the publish
// against the fetch URL can both miss a branch that was published and accept
// one that was not, so verification follows the push.
export async function resolvePushDestinations(repoRoot, remote) {
  if (!remote) return []
  const output = await gitText(["remote", "get-url", "--push", "--all", remote], repoRoot).catch(() => "")
  const urls = output.split("\n").map((line) => line.trim()).filter(Boolean)
  // No configured push URL means the fetch URL is the push destination, and
  // the remote name resolves to it.
  return urls.length > 0 ? urls : [remote]
}

// What every push destination of `remote` currently has on `branch`.
export async function fetchPublishedBranchShas(repoRoot, remote, branch) {
  const destinations = await resolvePushDestinations(repoRoot, remote)
  const published = []
  for (const destination of destinations) {
    published.push({
      destination,
      label: destination === remote ? remote : redactRemoteUrl(destination),
      sha: await fetchRemoteBranchSha(repoRoot, destination, branch),
    })
  }
  return published
}

// What a PR *would* be opened against, for the one path where no PR exists
// yet: the canonical identity of the repository that will receive it, the
// base ref, and the object that ref points at on that repository right now.
// Always the remote's answer, never a local tracking ref. Once the PR
// exists, GitHub reports the same three facts itself and
// `fetchAuthoritativePrHead` is used instead — same meaning, better source.
export async function resolveTargetBase(repoRoot, remote, baseRef) {
  if (!remote || !baseRef) return null
  const [url, baseSha] = await Promise.all([
    gitText(["remote", "get-url", remote], repoRoot).catch(() => ""),
    fetchRemoteBranchSha(repoRoot, remote, baseRef),
  ])
  return normalizePrTarget({ repo: canonicalRepoIdentity(url || remote), ref: baseRef, sha: baseSha })
}

// `host/owner/repo` is what `gh --repo` accepts. A `path:` identity is a
// local remote with no GitHub repository behind it, and anything else is not
// a repository gh can be pointed at.
export function ghRepoFlagFor(identity) {
  const value = String(identity || "")
  if (value.startsWith("path:")) return ""
  return value.split("/").length === 3 ? value : ""
}

// Every `gh` call about a lane's PR names the repository that PR lives in.
// Left off, gh picks one from `GH_REPO` or the working directory's default
// remote, and either can be a repository the lane never opened a PR on: the
// call then reports another PR of the same number, or none at all. An empty
// list is the old behavior and is reached only when no identity is known —
// a local remote, or a checkout with no usable remote.
export function ghRepoArgs(identity) {
  const flag = ghRepoFlagFor(identity)
  return flag ? ["--repo", flag] : []
}

// The REST API addresses a repository as `owner/repo`, but the host decides
// which GitHub the request reaches, so it travels with the pair: an
// enterprise repository addressed by name alone is fetched from github.com.
// What counts as an addressable repository is decided in one place, above.
export function restIdentityFor(identity) {
  const [host, owner, repo] = ghRepoFlagFor(identity).split("/")
  return repo ? { host, owner, repo } : null
}

// `fetchAllComments` and the reaction lookups need an addressable repository.
// The lane's own repository answers it; `gh repo view` is the fallback for a
// checkout whose remote names no GitHub repository, which is what every
// caller used before.
async function prRestIdentity(repoRoot, prRepo) {
  return restIdentityFor(prRepo) || (await getRepoIdentity(repoRoot))
}

// ---------------------------------------------------------------------------
// The lane's PR association
// ---------------------------------------------------------------------------
//
// A PR number alone does not say which repository it is a number in, and
// every repository has a #7. The association below pins the repository the
// moment a lane acquires a PR — `pr create` from the URL gh printed, adoption
// from the first resolution — and every later `status`, `poll` and
// `request-review` reads it back rather than re-deriving it. Re-derivation
// answers from the checkout's current remote and `GH_REPO`, both of which can
// be changed after the fact by anyone who can edit a git config or export an
// environment variable; a lane that polls `--apply` acts on what it reads, so
// a redirected read can resolve a lane against another repository's merge.
//
// One record is one file, named for the lane, the PR and the claim, and
// written once: lanes run concurrently and share a state root, so a single
// document holding every lane's association would lose one lane's write to
// another's read-modify-rename. Nothing ever updates a record in place, so
// there is no update to lose, and the name carries the lifecycle — a fresh
// claim looks for a file that does not exist yet, and a record left over from
// an earlier claim is never read.
const PR_ASSOCIATION_VERSION = 1

function prAssociationPath(repoRoot, laneId, prNumber, claim) {
  const safe = (value) => String(value || "").replace(/[^A-Za-z0-9._-]/g, "_")
  const claimKey = crypto.createHash("sha256").update(String(claim || "")).digest("hex").slice(0, 12)
  // Lane state: a linked worktree shares its main checkout's records.
  return path.join(
    resolveStateRoot(repoRoot),
    ".btrain",
    "pr-flow",
    `lane-${safe(laneId) || "single"}-pr${safe(prNumber)}-${claimKey}.json`,
  )
}

// The claim a lane is living in right now, as the timestamp of its last
// `claim` event. An association made under a previous claim describes work
// that has already been resolved.
async function currentClaimStamp(repoRoot, laneId) {
  const events = await readLaneEvents(repoRoot, laneId)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "claim") return String(events[index].recordedAt || "")
  }
  return ""
}

// An unreadable record is not an absent one. Absent means "this lane has
// never pinned a PR", which is the ordinary state of every lane that existed
// before these records did, and the one case that may fall through to
// re-deriving the repository. Anything present but unreadable is reported:
// silently re-deriving it would hand back exactly the answer the record
// exists to overrule.
function corruptAssociation(file, detail) {
  return new BtrainError({
    message: `The PR association at ${file} cannot be read (${detail}).`,
    reason: "btrain pins the repository a lane's PR lives in; an unreadable record cannot authorize a GitHub call.",
    fix: `Delete ${file} to let btrain pin the repository again from the lane's remote, or upgrade btrain if a newer version wrote it.`,
  })
}

// The association for this lane, PR and claim, or null when none was written.
async function readPrAssociation(repoRoot, laneId, prNumber, claim) {
  const file = prAssociationPath(repoRoot, laneId, prNumber, claim)
  let raw
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw corruptAssociation(file, error?.message || "invalid JSON")
  }
  if (parsed?.version !== PR_ASSOCIATION_VERSION) {
    throw corruptAssociation(file, `unsupported record version ${JSON.stringify(parsed?.version)}`)
  }
  const repo = canonicalRepoIdentity(parsed?.repo)
  if (!repo) throw corruptAssociation(file, `no repository in ${JSON.stringify(parsed?.repo)}`)
  return { ...parsed, repo }
}

// A caller that named a repository outright and a lane that is associated
// with another one disagree about which PR this is. The lane's evidence,
// approval and locks all belong to the one it adopted, so the named one is a
// redirect rather than a correction. Both the already-pinned path and the
// lost-race path refuse it here, so they cannot drift apart.
function redirectRefusal(laneId, prNumber, associated, named) {
  if (!named || named === associated) return null
  return new BtrainError({
    message: `Lane ${laneId || "(single)"} is associated with PR #${prNumber} in \`${associated}\`; refusing to act on \`${named}\`.`,
    reason: "The lane and its comment log belong to the associated PR.",
    fix: `Drop the repository from --pr, or claim a fresh lane for the PR in \`${named}\`.`,
  })
}

// Create-if-absent, never overwrite. Two first commands on one lane can each
// derive a repository before either has written one; the exclusive publish
// decides which of them the lane keeps, and the loser adopts that answer
// rather than acting on its own.
//
// The record is written in full under a private name and then published with
// a single `link`, whose destination is exclusive. Creating the public
// pathname first and writing into it afterwards — what an exclusive `open`
// does — would leave a window in which a concurrent reader, or a crash, finds
// an empty file where the lane's association should be.
async function pinPrRepository(repoRoot, { laneId, prNumber, claim, repo, named }) {
  const file = prAssociationPath(repoRoot, laneId, prNumber, claim)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const record = {
    version: PR_ASSOCIATION_VERSION,
    lane: laneId || "",
    pr: String(prNumber),
    claim: String(claim || ""),
    repo,
    associatedAt: new Date().toISOString(),
  }
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" })
    try {
      await fs.link(temp, file)
      return repo
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const winner = await readPrAssociation(repoRoot, laneId, prNumber, claim)
      // The association existed a moment ago and does not now, so something
      // outside btrain removed it mid-command. Proceeding would act on this
      // command's own derived repository with nothing pinning it.
      if (!winner) {
        throw new BtrainError({
          message: `The PR association at ${file} was created and then removed while this command was pinning it.`,
          reason: "btrain pins the repository a lane's PR lives in before it calls GitHub; an association that disappears mid-command authorizes nothing.",
          fix: "Re-run the command. If it keeps happening, something outside btrain is deleting .btrain/pr-flow records.",
        })
      }
      const refusal = redirectRefusal(laneId, prNumber, winner.repo, named)
      if (refusal) throw refusal
      return winner.repo
    }
  } finally {
    await fs.rm(temp, { force: true })
  }
}

// The repository a lane's PR lives in, resolved once per command and used for
// every GitHub call it makes: views, comments, the REST comment fetch, and
// review requests.
//
// A recorded association wins outright. Without one — a lane that adopted a
// PR before this record existed, or one that has just been handed a number —
// the repository comes from a URL the caller named outright (`--pr <url>`, or
// the URL `gh pr create` printed), else from the repository btrain opens PRs
// on for this checkout. The next command reads the saved association.
// `laneId` is null for the few read-only probes that are not run on a lane's
// behalf; they derive the repository and read nothing. `linked` says the PR
// is the one this lane is linked to, which is what may be pinned: a `--pr`
// aimed at some other number is a look, not an association, and pinning it
// would bind the lane to a PR it never adopted.
export async function resolvePrRepository(
  repoRoot,
  { laneId = null, prNumber = "", url = "", linked = false } = {},
) {
  const laneScoped = laneId !== null && Boolean(prNumber)
  const named = canonicalRepoIdentity(prRepoIdentityFromUrl(url))
  const claim = laneScoped ? await currentClaimStamp(repoRoot, laneId) : ""
  const pinned = laneScoped ? await readPrAssociation(repoRoot, laneId, prNumber, claim) : null
  if (pinned) {
    const refusal = redirectRefusal(laneId, prNumber, pinned.repo, named)
    if (refusal) throw refusal
    return pinned.repo
  }
  // A checkout with no remotes — or no git repository at all — names no
  // repository, and gh keeps its own default, exactly as before.
  const remote = await resolveBaseRemote(repoRoot).catch(() => "")
  const resolved = named
    || canonicalRepoIdentity(
      remote ? await gitText(["remote", "get-url", remote], repoRoot).catch(() => "") : "",
    )
  if (resolved && laneScoped && linked) {
    return pinPrRepository(repoRoot, { laneId, prNumber, claim, repo: resolved, named })
  }
  return resolved
}

// gh picks the repository a PR opens on from its own defaults — a
// `gh-resolved` remote marker, `GH_REPO`, a fork's parent — none of which has
// to be the repository the gate just authorized. So the repository is named
// explicitly on the command. That makes the head cross-repository whenever it
// lives elsewhere (the ordinary fork layout), and gh needs those qualified as
// `owner:branch`; a same-repository head must stay bare.
export function prCreateHeadSpec(branch, headIdentity, baseIdentity) {
  const head = String(headIdentity || "")
  if (!head || !baseIdentity || head === baseIdentity) return branch
  const owner = head.split("/")[1] || ""
  return owner ? `${owner}:${branch}` : branch
}

// Read the live head and base together for clearance or bot review.
export async function fetchAuthoritativePrHead(repoRoot, prNumber, prRepo = "") {
  const pr = await ghJson(
    [
      "pr",
      "view",
      prNumber,
      ...ghRepoArgs(prRepo),
      "--json",
      "headRefOid,headRefName,headRepository,headRepositoryOwner,baseRefName,baseRefOid,url",
    ],
    repoRoot,
  )
  requirePrIdentity(pr, prNumber, prRepo)
  return {
    headRefOid: String(pr?.headRefOid || "").toLowerCase(),
    headRefName: String(pr?.headRefName || ""),
    headRepo: prHeadRepositoryIdentity(pr),
    baseRefName: String(pr?.baseRefName || ""),
    baseRefOid: String(pr?.baseRefOid || "").toLowerCase(),
    repo: canonicalRepoIdentity(prRepoIdentityFromUrl(pr?.url)),
  }
}

// The repository a PR's head branch lives in, which is the PR's own
// repository for an ordinary branch and someone else's for a fork. GitHub
// reports it as an owner and a name with no host, and the head repository
// lives on the same host as the PR. An inaccessible or deleted head
// repository reports neither, and that is "" — unknown, not "the PR's own".
function prHeadRepositoryIdentity(pr) {
  const owner = pr?.headRepositoryOwner?.login || ""
  const name = pr?.headRepository?.name || ""
  if (!owner || !name) return ""
  try {
    const { host } = new URL(String(pr?.url || ""))
    return host ? canonicalRepoIdentity(`${host}/${owner}/${name}`) : ""
  } catch {
    return ""
  }
}

// "https://github.com/owner/repo/pull/7" names the repository the PR lives
// in, which is the base repository of that PR.
function prRepoIdentityFromUrl(url) {
  const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/i.exec(String(url || "").trim())
  return match ? match[1] : ""
}

function requirePrIdentity(pr, prNumber, prRepo) {
  const urlNumber = /\/pull\/(\d+)(?:[/?#]|$)/.exec(String(pr?.url || ""))?.[1]
  const repo = canonicalRepoIdentity(prRepoIdentityFromUrl(pr?.url))
  const expectedRepo = ghRepoFlagFor(prRepo)
  if (urlNumber !== prNumber || (expectedRepo && repo !== expectedRepo)) {
    throw new Error(`GitHub did not return PR #${prNumber} in the selected repository.`)
  }
}

// Whether this checkout's branch is the PR's head branch, and so may be held
// to GitHub's head revision. A shared branch name proves nothing across
// repositories: an adopted fork PR whose head branch is `main` is reviewed
// from a `main` checkout of the base repository, and those two branches carry
// different objects for ordinary reasons. So the branch must push into the
// repository GitHub names as the head, under the head's own branch name.
//
// With no head repository reported — a head repository that was deleted or
// is not visible — there is nothing to tell a fork from the PR's own
// repository, and the branch name stands as it did before: a divergence is
// still refused rather than waved through. When the head repository is known
// but this branch pushes somewhere else, or nowhere at all, the checkout is
// not the PR's head and the authoritative head and base gate decides alone.
async function localBranchIsPrHead(repoRoot, branchName, headRepo, headRefName) {
  if (!headRepo) return branchName === headRefName
  for (const destination of ["push", "upstream"]) {
    const ref = `${branchName}@{${destination}}`
    const symbolic = await gitText(["rev-parse", "--symbolic-full-name", ref], repoRoot).catch(() => "")
    if (!symbolic.startsWith("refs/remotes/")) continue
    const [, , remote, ...rest] = symbolic.split("/")
    if (!remote || rest.join("/") !== headRefName) continue
    const urlArgs = destination === "push" ? ["--push", "--all"] : []
    const urls = await gitText(["remote", "get-url", ...urlArgs, remote], repoRoot).catch(() => "")
    if (urls.split("\n").some((url) => canonicalRepoIdentity(url) === headRepo)) return true
  }
  return false
}

// Use the current GitHub revision in each review request.
async function requestReviewComments(repoRoot, prNumber, botIds, prFlowConfig, context = {}) {
  if (botIds.length === 0) return []
  const laneId = context.laneId || ""
  const lane = findLane(await checkHandoff(repoRoot), laneId)
  if (!lane) throw new Error(`Unknown lane: ${laneId}`)
  await enforceLocalReview(repoRoot, await readProjectConfig(repoRoot), {
    lane, laneId, stage: "Requesting bot review",
  })

  const target = context.prRepo || ""
  const { headRefOid, headRefName, headRepo, baseRefName, baseRefOid, repo: prRepo } = await fetchAuthoritativePrHead(repoRoot, prNumber, target)
  if (!FULL_OBJECT_ID_PATTERN.test(headRefOid)) {
    throw new Error(`GitHub did not report a head revision for PR #${prNumber}, so no bot review can be authorized.`)
  }
  if (!baseRefName || !FULL_OBJECT_ID_PATTERN.test(baseRefOid) || !prRepo) {
    throw new Error(
      `GitHub did not report the full target of PR #${prNumber} (repository, base branch and base revision), so no bot review can be authorized.`,
    )
  }

  // If the owner's checkout is on the PR's own head branch — the same branch
  // of the same repository, not merely the same name — but sits on a
  // different revision, the two have diverged: either the push has not landed
  // or propagated, or there are unpushed commits. Posting now would ask the
  // bots to review something other than what is in front of the owner.
  const localBranch = await gitText(["branch", "--show-current"], repoRoot).catch(() => "")
  if (localBranch && headRefName
    && await localBranchIsPrHead(repoRoot, localBranch, headRepo, headRefName)) {
    const localHead = await gitText(["rev-parse", "HEAD"], repoRoot).catch(() => "")
    if (localHead && localHead.toLowerCase() !== headRefOid) {
      throw new Error(
        `GitHub has PR #${prNumber} at ${headRefOid} but this checkout is on ${localHead.toLowerCase()} (branch ${headRefName}).\n`
          + "Push the revision you want reviewed and re-run, or wait for GitHub to catch up with a push that has just landed. "
          + "Bot review is authorized against GitHub's head, so btrain will not post while the two disagree.",
      )
    }
  }

  const expectedBase = context.base
  if ((context.headSha && !shaMatches(context.headSha, headRefOid))
    || (expectedBase && (expectedBase.repo !== prRepo || expectedBase.ref !== baseRefName
      || !shaMatches(expectedBase.sha, baseRefOid)))) {
    throw new Error(`PR #${prNumber} changed before the bot request. Poll the updated target and try again.`)
  }

  context = { ...context, headSha: headRefOid }
  const posted = []
  for (const botId of botIds) {
    const bot = prFlowConfig.bots[botId]
    if (!bot) continue
    const body = buildReviewRequestBody(bot, context)
    await ghText(["pr", "comment", prNumber, ...ghRepoArgs(target), "--body", body], repoRoot)
    posted.push({ bot: botId, body: bot.requestBody })
  }
  return posted
}

// Applies a classified outcome to the transition gate. The GitHub polling
// entry point revalidates clearance against the live PR before calling this.
export async function applyPrStatusToHandoff(repoRoot, options, status) {
  const { laneId, lane, prNumber, prRepo } = await resolveLaneAndPr(repoRoot, options)
  if (status.pr?.url) requirePrIdentity(status.pr, prNumber, prRepo)
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

  if (!normalizePrNumber(lane.prNumber) && prRepo) {
    // Publish the repository before the lane carries the number. A concurrent
    // first adoption of this number must agree with that association.
    const claim = await currentClaimStamp(repoRoot, laneId)
    await pinPrRepository(repoRoot, { laneId, prNumber, claim, repo: prRepo, named: prRepo })
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
      next: `Address ${feedbackBots.join(", ")} feedback on PR #${prNumber}. Commit and push the fix, then return the lane to needs-review. After local peer approval, relink the PR and request bot review.`,
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
  const { laneId, prNumber, prRepo } = await resolveLaneAndPr(repoRoot, options)
  const identity = await prRestIdentity(repoRoot, prRepo)
  const rawComments = await fetchAllComments({ ...identity, prNumber, cwd: repoRoot })
  const shaped = shapeComments(rawComments)
  const appended = await appendComments(repoRoot, laneId, prNumber, shaped)
  const status = await fetchResolvedPrReviewStatus(repoRoot, prFlowConfig, prNumber, prRepo)

  if (options.format === "json") {
    console.log(JSON.stringify({ ...status, appendedToLog: appended.length }, null, 2))
  } else {
    console.log(formatPrStatusSummary(status))
    console.log(`comments logged: ${appended.length} new`)
  }

  if (options.apply) {
    if (status.overall === "ready-to-merge") {
      const current = await resolveLaneAndPr(repoRoot, options)
      if (current.prNumber !== prNumber || current.prRepo !== prRepo) {
        throw new Error("The lane PR association changed. Poll again before applying clearance.")
      }
      const target = await fetchAuthoritativePrHead(repoRoot, prNumber, prRepo)
      if (!shaMatches(status.pr.headSha, target.headRefOid)) {
        throw new Error(`PR #${prNumber}'s head changed since bot review was checked. Poll again before applying clearance.`)
      }
      const classifiedRepo = canonicalRepoIdentity(prRepoIdentityFromUrl(status.pr.url))
      if (classifiedRepo !== target.repo || status.pr.base !== target.baseRefName
        || !shaMatches(status.pr.baseSha, target.baseRefOid)) {
        throw new Error(`PR #${prNumber}'s base changed since bot review was checked. Poll again before applying clearance.`)
      }
      await enforceLocalReview(repoRoot, config, {
        lane: current.lane, laneId, stage: "Applying bot clearance",
      })
    }
    const nextStatus = await applyPrStatusToHandoff(repoRoot, options, status)
    console.log(`handoff updated: ${nextStatus}`)
  }

  if (options["request-review"] && ["feedback", "waiting", "draft"].includes(status.overall)) {
    const botIds = botsOptionToIds(options.bots, prFlowConfig)
    const posted = await requestReviewComments(repoRoot, prNumber, botIds, prFlowConfig, {
      laneId,
      prRepo,
      headSha: status.pr.headSha,
      base: { repo: canonicalRepoIdentity(prRepoIdentityFromUrl(status.pr.url)), ref: status.pr.base, sha: status.pr.baseSha },
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
  const { laneId, prNumber, prRepo } = await resolveLaneAndPr(repoRoot, options)
  const botIds = botsOptionToIds(options.bots, prFlowConfig)
  const posted = await requestReviewComments(repoRoot, prNumber, botIds, prFlowConfig, { laneId, prRepo })

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
  await enforceLocalReview(repoRoot, config, { lane, laneId, stage: "Creating a PR" })


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
  const targetBase = await resolveTargetBase(repoRoot, baseRemote, base)
  if (!targetBase) throw new Error(`Could not resolve the live base ${base} on remote ${baseRemote}.`)

  // Publish the selected object even if the local branch moves during push.
  const headRemote = "origin"
  if (!options["no-push"]) {
    await execFileAsync("git", ["push", headRemote, `${headSha}:refs/heads/${branch}`], {
      cwd: repoRoot,
      maxBuffer: GH_MAX_BUFFER,
    })
    // Keep the convenience `git push -u` used to provide, without letting a
    // failure here block a PR whose branch is already published correctly.
    await execFileAsync("git", ["branch", `--set-upstream-to=${headRemote}/${branch}`, branch], {
      cwd: repoRoot,
      maxBuffer: GH_MAX_BUFFER,
    }).catch(() => {})
  }

  // Ask the destinations the push actually writes to what the branch points
  // at, including under --no-push where btrain published nothing and the
  // branch may be absent, behind, or someone else's work. `gh pr create`
  // opens against what is published, so this is the last catchable mismatch.
  for (const published of await fetchPublishedBranchShas(repoRoot, headRemote, branch)) {
    const where = `\`${published.label}\` (${branch})`
    if (!published.sha) {
      throw new Error(
        `${where} does not have the branch, so there is nothing for \`gh pr create\` to open.\n`
          + (options["no-push"]
            ? `Push the selected revision yourself with \`git push ${headRemote} ${headSha}:refs/heads/${branch}\`, or re-run without --no-push.`
            : `The push reported success but the destination does not show the branch; check \`git ls-remote --get-url --push ${headRemote}\`.`),
      )
    }
    if (published.sha !== headSha.toLowerCase()) {
      throw new Error(
        `${where} is at ${published.sha}, but this command selected ${headSha.toLowerCase()}.\n`
          + `\`gh pr create\` would open a PR on a different revision. `
          + `Push the selected revision with \`git push ${headRemote} ${headSha}:refs/heads/${branch}\`, or check out the published revision and try again.`,
      )
    }
  }

  const title = typeof options.title === "string" && options.title.trim() ? options.title.trim() : lane.task || branch
  const body = typeof options.body === "string" && options.body.trim() ? options.body.trim() : buildPrBody(lane)
  const currentBase = await resolveTargetBase(repoRoot, baseRemote, base)
  if (!currentBase || currentBase.repo !== targetBase.repo || !shaMatches(currentBase.sha, targetBase.sha)) {
    throw new Error(`The base ${base} changed before PR creation. Read the updated target and try again.`)
  }
  // Name the selected repository and qualify the branch for a fork.
  const repoFlag = ghRepoFlagFor(targetBase?.repo)
  // Where the branch was actually published: `--push` yields the push URL
  // when one is configured and the fetch URL otherwise.
  const headIdentity = canonicalRepoIdentity(
    await gitText(["remote", "get-url", "--push", headRemote], repoRoot).catch(() => ""),
  )
  const head = repoFlag ? prCreateHeadSpec(branch, headIdentity, targetBase?.repo) : branch
  const args = ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body]
  if (repoFlag) {
    args.push("--repo", repoFlag)
  }
  if (options.draft) {
    args.push("--draft")
  }
  const url = await ghText(args, repoRoot)
  const number = normalizePrNumber(url)
  if (!number) throw new Error("GitHub did not return a PR number after creation.")
  requirePrIdentity({ url }, number, repoFlag)
  // Publish the association before the lane carries the PR number.
  const prRepo = await resolvePrRepository(repoRoot, { laneId, prNumber: number, url, linked: true })

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
  const posted = await requestReviewComments(repoRoot, number, botIds, prFlowConfig, {
    laneId, prRepo, headSha, base: ghRepoFlagFor(targetBase.repo) ? targetBase : null,
  })
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
