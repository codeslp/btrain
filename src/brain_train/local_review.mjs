// local_review.mjs — local peer review before GitHub bot review.
//
// A lane status alone cannot say which revision a reviewer approved: the owner
// can approve-then-commit and stay in `ready-for-pr` the whole time. So the
// gate reads the canonical workflow event log and binds the approval to one
// revision, recorded by the reviewer as a `Reviewed-Head:` trailer in the
// `btrain handoff resolve --summary`.
//
// The log is the same one core.mjs writes (`.btrain/events/lane-<id>.jsonl`,
// or `repo.jsonl` when lanes are off). `getRepoPaths` resolves it through the
// main checkout, so a linked worktree reads the same lane history.

import fs from "node:fs/promises"
import path from "node:path"
import { getRepoPaths } from "./core.mjs"
import { isFeatureEnabled } from "./repo_mode.mjs"

// A lane reaches these statuses only through local peer review: `handoff
// resolve` (ready-for-pr), or a PR link made from it (pr-review).
const BOT_REVIEW_READY_STATUSES = new Set(["ready-for-pr", "pr-review"])

// After an approval the lane may move on inside the PR flow without losing it.
// Anything else — a return to needs-review, bot feedback, a repair — means the
// approved revision is no longer the one heading for GitHub.
const APPROVAL_SURVIVES_STATUSES = new Set(["ready-for-pr", "pr-review", "ready-to-merge"])
const APPROVAL_WITHDRAWN_BY_TYPES = new Set(["claim", "request-changes", "watchdog-repair"])

const REVIEWED_HEAD_PATTERN = /^[ \t]*Reviewed-Head[ \t]*:[ \t]*([0-9a-fA-F]{7,40})[ \t]*$/im
const ABBREVIATED_SHA_PATTERN = /^[0-9a-f]{7,40}$/

function laneEventLogPath(repoRoot, laneId = "") {
  const { eventsDir } = getRepoPaths(repoRoot)
  return path.join(eventsDir, laneId ? `lane-${laneId}.jsonl` : "repo.jsonl")
}

export async function readLaneEvents(repoRoot, laneId = "") {
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

export function parseReviewedHead(summary) {
  const match = REVIEWED_HEAD_PATTERN.exec(String(summary || ""))
  return match ? match[1].toLowerCase() : ""
}

// Git abbreviates, so an approval recorded as `9f8bbe4` must still match a
// full target SHA. Only a prefix relationship counts, never a substring.
export function shaMatches(left, right) {
  const a = String(left || "").toLowerCase()
  const b = String(right || "").toLowerCase()
  if (!ABBREVIATED_SHA_PATTERN.test(a) || !ABBREVIATED_SHA_PATTERN.test(b)) return false
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b)
}

// The live approval is the last `handoff resolve` that reached ready-for-pr
// since the current claim, provided nothing after it withdrew the approval.
export function findLocalReviewApproval(events) {
  const list = Array.isArray(events) ? events : []
  let epoch = 0
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.type === "claim") {
      epoch = index + 1
      break
    }
  }
  const sinceClaim = list.slice(epoch)

  let approvalIndex = -1
  for (let index = sinceClaim.length - 1; index >= 0; index -= 1) {
    const event = sinceClaim[index]
    if (event?.type === "resolve"
      && event?.details?.localReviewApproved === true
      && event?.after?.status === "ready-for-pr") {
      approvalIndex = index
      break
    }
  }
  if (approvalIndex === -1) {
    return { approval: null, reason: epoch > 0 ? "no approval since the current claim" : "no approval recorded" }
  }

  for (const later of sinceClaim.slice(approvalIndex + 1)) {
    if (APPROVAL_WITHDRAWN_BY_TYPES.has(later?.type)) {
      return { approval: null, reason: `a later \`${later.type}\` event withdrew it` }
    }
    const status = String(later?.after?.status || "")
    if (!APPROVAL_SURVIVES_STATUSES.has(status)) {
      return { approval: null, reason: `the lane moved to \`${status}\` after it` }
    }
  }
  return { approval: sinceClaim[approvalIndex], reason: "" }
}

// An approval only counts when a real peer made it: not the owner, not someone
// other than the recorded reviewer, and not an advisory resolve (L8 is exactly
// "actor is not the recorded reviewer", L9 is an uncovered lane).
export function approvalIdentityProblem(approval, lane = {}) {
  const actor = String(approval?.actor || "").trim()
  if (!actor) return "the approval records no actor"

  const owners = [approval?.before?.owner, approval?.after?.owner, lane?.owner]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
  if (owners.includes(actor.toLowerCase())) {
    return `it was self-approved by the lane owner \`${actor}\``
  }

  const reviewer = String(approval?.before?.reviewer || approval?.after?.reviewer || "").trim()
  if (!reviewer) return "the lane recorded no reviewer at approval time"
  if (reviewer.toLowerCase() !== actor.toLowerCase()) {
    return `\`${actor}\` approved it but the recorded reviewer is \`${reviewer}\``
  }

  const advisory = approval?.details?.["transition-advisory"]
  if (advisory) return `it was an advisory resolve (${advisory}), not a clean peer approval`
  return ""
}

function laneLabelFor(laneId) {
  return laneId || "(single)"
}

// Returns "" when the revision may go to GitHub, or one sentence saying why not.
// `requireHead: false` runs everything except the revision comparison, so a
// caller can refuse a hopeless request before it spends a `gh` round trip to
// learn which revision the PR is even on.
export async function findLocalReviewProblem(repoRoot, { lane = {}, laneId = "", targetSha = "", requireHead = true } = {}) {
  const label = laneLabelFor(laneId)
  if (!BOT_REVIEW_READY_STATUSES.has(lane.status)) {
    return `lane ${label} is \`${lane.status}\`, but it must be \`ready-for-pr\` or \`pr-review\``
  }

  const { approval, reason } = findLocalReviewApproval(await readLaneEvents(repoRoot, laneId))
  if (!approval) return `lane ${label} has no live local peer approval (${reason})`

  const identity = approvalIdentityProblem(approval, lane)
  if (identity) return `the local peer approval of lane ${label} does not count: ${identity}`

  const reviewedHead = parseReviewedHead(approval.details?.summary)
  if (!reviewedHead) {
    return `the local peer approval of lane ${label} does not name the revision it covers (no \`Reviewed-Head:\` trailer in the resolve summary)`
  }
  if (!targetSha) {
    if (!requireHead) return ""
    return `the revision bound for GitHub could not be determined, so the approval of \`${reviewedHead}\` cannot be checked against it`
  }
  if (!shaMatches(reviewedHead, targetSha)) {
    return `the local peer approval of lane ${label} covers \`${reviewedHead}\`, but the revision bound for GitHub is \`${targetSha}\``
  }
  return ""
}

function refusalText(problem, laneId, stage) {
  const label = laneLabelFor(laneId)
  return `${stage} needs a current local peer review first: ${problem}. `
    + `Hand the revision to the reviewer with \`btrain handoff update --lane ${label} --status needs-review\`. `
    + `The reviewer approves it with \`btrain handoff resolve --lane ${label} --summary "<verdict>\\n\\nReviewed-Head: <sha>"\`, where <sha> is the revision they reviewed. `
    + "An approval made before this gate existed, or one that no longer covers the current revision, is refreshed the same way: back to needs-review, then a resolve whose summary carries the current `Reviewed-Head`. "
    + `If the local reviewer cannot run (out of tokens), turn this gate off with \`btrain features disable local_review\` and back on with \`btrain features enable local_review\`.`
}

function warningText(problem, laneId, stage) {
  return `warning: local_review is disabled, so ${stage} proceeds for lane ${laneLabelFor(laneId)} without a current local peer review: ${problem}. `
    + "Re-enable it with `btrain features enable local_review` once the local reviewer can run."
}

// The one policy every GitHub-bound path shares: refuse an unapproved revision
// while `local_review` is on, warn instead of refusing while it is off.
export async function enforceLocalReview(repoRoot, config, context = {}, onWarn) {
  const { lane = {}, laneId = "", targetSha = "", requireHead = true, stage = "Bot review" } = context
  const problem = await findLocalReviewProblem(repoRoot, { lane, laneId, targetSha, requireHead })
  if (!problem) return

  if (isFeatureEnabled(config, "local_review")) {
    throw new Error(refusalText(problem, laneId, stage))
  }
  const warning = warningText(problem, laneId, stage)
  if (typeof onWarn === "function") onWarn(warning)
  else console.error(warning)
}
