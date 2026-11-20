// local_review.mjs — local peer review before GitHub bot review.
//
// A lane status alone cannot say what a reviewer approved: the owner can
// approve-then-commit and stay in `ready-for-pr` the whole time, and can
// open the PR against a base the review never saw. So the gate reads the
// canonical workflow event log and binds the approval to one target —
// repository, base ref, base object ID, head object ID — recorded by the
// reviewer as `Reviewed-Head:` and `Reviewed-Base:` trailers in the
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
// Any other recorded move — a return to needs-review, bot feedback, a repair —
// means the approved revision is no longer the one heading for GitHub. An
// approval is withdrawn by an explicit withdrawal event or by an observed move
// to a status outside the surviving set, never by the absence of a snapshot.
const APPROVAL_SURVIVES_STATUSES = new Set(["ready-for-pr", "pr-review", "ready-to-merge"])
const APPROVAL_WITHDRAWN_BY_TYPES = new Set(["claim", "request-changes", "watchdog-repair"])

// Only a full object ID is accepted. An abbreviation can name two different
// commits — git itself only guarantees uniqueness at the moment it abbreviates
// — and an approval that matches the wrong commit is exactly the failure this
// gate exists to prevent. 40 hex is sha1, 64 is sha256.
const REVIEWED_HEAD_PATTERN = /^[ \t]*Reviewed-Head[ \t]*:[ \t]*([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)[ \t]*$/im
const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// A head object ID alone does not describe what a reviewer read. The diff
// they read is `base...head`, so the same head against a different base is a
// different change: moving the base from a near ancestor to `main` can add
// files no one reviewed. The approval therefore names the whole target —
// repository, base ref, base object ID, head object ID — and the gate
// authorizes only that exact target.
//
// Canonical trailer format, one per line in the `handoff resolve --summary`:
//
//   Reviewed-Head: <head object ID>
//   Reviewed-Base: <repository> <base ref> <base object ID>
//
// `<repository>` is the canonical identity below, `<base ref>` is the branch
// the PR opens against (`main`), and both object IDs are full 40- or
// 64-character IDs. Fields are separated by spaces; the base ref may not
// contain one, which git already forbids.
const REVIEWED_BASE_PATTERN =
  /^[ \t]*Reviewed-Base[ \t]*:[ \t]*(\S+)[ \t]+(\S+)[ \t]+([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)[ \t]*$/im

function stripGitSuffix(value) {
  return String(value).replace(/\.git$/i, "").replace(/\/+$/, "")
}

// One spelling for one repository. A remote arrives as a clone URL, an
// scp-like address, or the `host/owner/repo` a reviewer types, and all three
// must compare equal. A remote with no host is a path, kept verbatim after
// `path:` because paths are case-sensitive where hosts are not.
export function canonicalRepoIdentity(value) {
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
    try {
      parsed = new URL(raw)
    } catch {
      return ""
    }
    const repoPath = stripGitSuffix(decodeURIComponent(parsed.pathname).replace(/^\/+/, ""))
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

// Returns { repo, ref, sha } or null. A trailer whose repository field is
// not a recognizable identity is treated as absent rather than as a target
// that can never match: the reviewer is told the format instead of being
// told their review covers the wrong repository.
export function parseReviewedBase(summary) {
  const match = REVIEWED_BASE_PATTERN.exec(String(summary || ""))
  if (!match) return null
  const repo = canonicalRepoIdentity(match[1])
  if (!repo) return null
  return { repo, ref: match[2], sha: match[3].toLowerCase() }
}

// Full object IDs, compared whole. No prefix matching: two commits can share a
// short prefix, and a gate that accepts a prefix can authorize the wrong one.
export function shaMatches(left, right) {
  const a = String(left || "").trim().toLowerCase()
  const b = String(right || "").trim().toLowerCase()
  if (!FULL_OBJECT_ID_PATTERN.test(a) || !FULL_OBJECT_ID_PATTERN.test(b)) return false
  return a === b
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
    // Bookkeeping events carry no state snapshot: `history-compact` archives
    // old handoff entries and records no `after` at all. The lane did not
    // move, so reading the missing snapshot as a move to an empty status
    // would retire a live approval over an archival housekeeping run.
    const status = String(later?.after?.status || "")
    if (!status) continue
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

// The target a caller is about to send to GitHub, in the same shape as the
// trailers: null when any part of it is unknown, because a half-known target
// cannot authorize anything.
export function normalizeReviewTarget({ repo = "", ref = "", sha = "" } = {}) {
  const identity = canonicalRepoIdentity(repo)
  const baseRef = String(ref || "").trim()
  const baseSha = String(sha || "").trim().toLowerCase()
  if (!identity || !baseRef || !FULL_OBJECT_ID_PATTERN.test(baseSha)) return null
  return { repo: identity, ref: baseRef, sha: baseSha }
}

// Returns "" when the revision may go to GitHub, or one sentence saying why not.
// `requireHead: false` runs everything except the target comparison, so a
// caller can refuse a hopeless request before it spends a `gh` round trip to
// learn which revision the PR is even on.
export async function findLocalReviewProblem(
  repoRoot,
  { lane = {}, laneId = "", targetSha = "", targetBase = null, requireHead = true } = {},
) {
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
    return `the local peer approval of lane ${label} does not name the revision it covers (the resolve summary has no \`Reviewed-Head:\` trailer carrying a full 40-character object ID)`
  }
  const reviewedBase = parseReviewedBase(approval.details?.summary)
  if (!reviewedBase) {
    return `the local peer approval of lane ${label} does not name the base it was read against (the resolve summary has no \`Reviewed-Base: <repository> <base ref> <base object ID>\` trailer)`
  }

  if (!targetSha) {
    if (!requireHead) return ""
    return `the revision bound for GitHub could not be determined, so the approval of \`${reviewedHead}\` cannot be checked against it`
  }
  if (!shaMatches(reviewedHead, targetSha)) {
    return `the local peer approval of lane ${label} covers \`${reviewedHead}\`, but the revision bound for GitHub is \`${targetSha}\``
  }

  const base = normalizeReviewTarget(targetBase || {})
  if (!base) {
    if (!requireHead) return ""
    return `the base bound for GitHub could not be determined, so the approval of \`${reviewedBase.ref}\` at \`${reviewedBase.sha}\` cannot be checked against it`
  }
  if (base.repo !== reviewedBase.repo) {
    return `the local peer approval of lane ${label} was read in \`${reviewedBase.repo}\`, but the revision is bound for \`${base.repo}\``
  }
  if (base.ref !== reviewedBase.ref) {
    return `the local peer approval of lane ${label} was read against base \`${reviewedBase.ref}\`, but the PR opens against \`${base.ref}\` — a different base is a different diff`
  }
  if (!shaMatches(reviewedBase.sha, base.sha)) {
    return `the local peer approval of lane ${label} was read against \`${reviewedBase.ref}\` at \`${reviewedBase.sha}\`, but \`${base.ref}\` is now at \`${base.sha}\``
  }
  return ""
}

// A repository identity and a ref come from a remote URL and a branch name,
// neither of which this process chose. Git allows `$`, backticks, quotes and
// `%` in a branch name, so such a value goes into a printed command only when
// it is inert in both shell and printf; otherwise the command keeps its
// placeholders and the real target is printed beside it as plain text.
const SHELL_INERT_FIELD = /^[A-Za-z0-9._@+:/-]+$/

function pasteableBaseLine(base) {
  if (!base) return ""
  if (!SHELL_INERT_FIELD.test(base.repo) || !SHELL_INERT_FIELD.test(base.ref)) return ""
  return `Reviewed-Base: ${base.repo} ${base.ref} ${base.sha}`
}

// The remediation is meant to be pasted into a shell, so the resolve command
// builds its multi-line summary with printf. A literal "\n" inside double
// quotes would reach btrain as two characters and the trailer would not parse.
function refusalText(problem, laneId, stage, targetBase = null) {
  const label = laneLabelFor(laneId)
  const base = normalizeReviewTarget(targetBase || {})
  // Naming the live target saves the reviewer a lookup, but it is only the
  // target: they still have to read `base...head` and mean it.
  const baseLine = pasteableBaseLine(base)
  const formatLine = baseLine || "Reviewed-Base: <repository> <base ref> <base object ID>"
  return `${stage} needs a current local peer review first: ${problem}.\n`
    + `  1. Hand the revision to the reviewer:\n`
    + `       btrain handoff update --lane ${label} --status needs-review\n`
    + `  2. The reviewer approves the exact target they read — the head, and the base that head was read against:\n`
    + `       btrain handoff resolve --lane ${label} --summary "$(printf '<verdict>\\n\\nReviewed-Head: %s\\n${formatLine}' "$(git rev-parse HEAD)")"\n`
    + `     Both object IDs must be full 40-character IDs; an abbreviation is rejected.`
    + (baseLine
      ? ` The base line above is this PR's target right now; re-read it against HEAD before pasting it.\n`
      : base
        ? `\n     This PR's target, to fill in by hand: repository ${base.repo}, base ref ${base.ref}, base object ID ${base.sha}.\n`
        : "\n")
    + `An approval made before this gate existed, or one overtaken by a new commit or a changed base, is refreshed by those same two steps.\n`
    + `If the local reviewer cannot run (out of tokens), turn this gate off with \`btrain features disable local_review\` and back on with \`btrain features enable local_review\`.`
}

function warningText(problem, laneId, stage) {
  return `warning: local_review is disabled, so ${stage} proceeds for lane ${laneLabelFor(laneId)} without a current local peer review: ${problem}. `
    + "Re-enable it with `btrain features enable local_review` once the local reviewer can run."
}

// The one policy every GitHub-bound path shares: refuse an unapproved revision
// while `local_review` is on, warn instead of refusing while it is off.
export async function enforceLocalReview(repoRoot, config, context = {}, onWarn) {
  const { lane = {}, laneId = "", targetSha = "", targetBase = null, requireHead = true, stage = "Bot review" } = context
  const problem = await findLocalReviewProblem(repoRoot, { lane, laneId, targetSha, targetBase, requireHead })
  if (!problem) return

  if (isFeatureEnabled(config, "local_review")) {
    throw new Error(refusalText(problem, laneId, stage, targetBase))
  }
  const warning = warningText(problem, laneId, stage)
  if (typeof onWarn === "function") onWarn(warning)
  else console.error(warning)
}
