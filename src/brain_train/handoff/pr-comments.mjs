// pr-comments.mjs — `btrain handoff pull-pr` handler.
//
// Fetches GitHub PR comment surfaces (issue, review, inline) via `gh` CLI,
// shapes them into uniform records, persists deltas to an append-only JSONL
// log, and tracks per-surface cursors so subsequent pulls only return new
// content. Optional --show prints new comments inline; --acknowledge advances
// the cursor (marks new as read).
//
// Phase 1: subcommand only. The `btrain handoff` status surface and the
// CHANGES_REQUESTED pre-push gate are deliberate phase-2 follow-ups.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import fs from "node:fs/promises"

const execFileAsync = promisify(execFile)

const GH_MAX_BUFFER = 16 * 1024 * 1024

// ---- path helpers ----

export function getPrCommentsDir(repoRoot) {
  return path.join(repoRoot, ".btrain", "pr-comments")
}

export function getPrCommentsLogPath(repoRoot, laneId, prNumber) {
  return path.join(getPrCommentsDir(repoRoot), `lane-${laneId}-${prNumber}.jsonl`)
}

export function getPrCommentsCursorsPath(repoRoot) {
  return path.join(getPrCommentsDir(repoRoot), "cursors.json")
}

export function getCursorKey(laneId, prNumber) {
  return `lane-${laneId}-${prNumber}`
}

// ---- cursor I/O ----

export async function readCursors(repoRoot) {
  const p = getPrCommentsCursorsPath(repoRoot)
  try {
    const raw = await fs.readFile(p, "utf8")
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === "ENOENT") return {}
    throw err
  }
}

export async function writeCursors(repoRoot, cursors) {
  const p = getPrCommentsCursorsPath(repoRoot)
  await fs.mkdir(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(cursors, null, 2)}\n`, "utf8")
  await fs.rename(tmp, p)
}

// ---- JSONL log I/O ----

// Dedup-on-append: any comment whose (surface, id) pair already exists in the
// log is skipped. Returns the records that were actually appended so callers
// can report an accurate "N new" number independent of the read-cursor.
export async function appendComments(repoRoot, laneId, prNumber, comments) {
  if (!Array.isArray(comments) || comments.length === 0) return []
  const existing = await readComments(repoRoot, laneId, prNumber)
  const seen = new Set(existing.map((c) => `${c.surface}:${c.id}`))
  const fresh = comments.filter((c) => !seen.has(`${c.surface}:${c.id}`))
  if (fresh.length === 0) return []
  const logPath = getPrCommentsLogPath(repoRoot, laneId, prNumber)
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const lines = fresh.map((c) => JSON.stringify(c)).join("\n")
  await fs.appendFile(logPath, `${lines}\n`, "utf8")
  return fresh
}

export async function readComments(repoRoot, laneId, prNumber) {
  const logPath = getPrCommentsLogPath(repoRoot, laneId, prNumber)
  try {
    const raw = await fs.readFile(logPath, "utf8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (err) {
    if (err.code === "ENOENT") return []
    throw err
  }
}

// ---- gh shellouts ----

export async function isGhAvailable() {
  try {
    await execFileAsync("gh", ["--version"])
    return true
  } catch {
    return false
  }
}

export async function getRepoIdentity(repoRoot) {
  const { stdout } = await execFileAsync(
    "gh",
    ["repo", "view", "--json", "owner,name", "-q", '.owner.login + "/" + .name'],
    { cwd: repoRoot, maxBuffer: GH_MAX_BUFFER },
  )
  const slug = stdout.trim()
  if (!slug.includes("/")) {
    throw new Error(`Could not parse repo identity from gh: "${slug}"`)
  }
  const [owner, repo] = slug.split("/")
  return { owner, repo }
}

async function ghApiPaginated(endpoint, cwd) {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", endpoint, "--paginate"],
    { cwd, maxBuffer: GH_MAX_BUFFER },
  )
  // --paginate concatenates JSON arrays as adjacent arrays; gh joins with no
  // delimiter for arrays. Safest: split by newlines that begin a new array,
  // or just rely on gh's stitching which already returns valid JSON for each
  // page. In practice the output is one valid array per page; we wrap in a
  // tolerant parse.
  return parseConcatenatedJsonArrays(stdout)
}

export function parseConcatenatedJsonArrays(text) {
  // gh --paginate emits each page as a separate JSON array (arrays joined
  // with no separator). Split into individual arrays and concatenate.
  const trimmed = text.trim()
  if (!trimmed) return []
  // If it's a single valid JSON value, return as-is.
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    // Fall through to multi-array parser.
  }
  const out = []
  let depth = 0
  let start = -1
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === "[") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "]") {
      depth--
      if (depth === 0 && start !== -1) {
        const slice = trimmed.slice(start, i + 1)
        const parsed = JSON.parse(slice)
        if (Array.isArray(parsed)) out.push(...parsed)
        start = -1
      }
    }
  }
  return out
}

export async function fetchAllComments({ owner, repo, prNumber, cwd }) {
  const issueComments = await ghApiPaginated(
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    cwd,
  )
  const reviewComments = await ghApiPaginated(
    `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    cwd,
  )
  const reviews = await ghApiPaginated(
    `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    cwd,
  )
  return { issueComments, reviewComments, reviews }
}

// ---- comment shaping ----

export function shapeComments({ issueComments, reviewComments, reviews }) {
  const out = []
  for (const c of issueComments || []) {
    out.push({
      surface: "issue",
      id: c.id,
      author: c.user?.login || "unknown",
      body: c.body || "",
      url: c.html_url,
      at: c.created_at,
    })
  }
  for (const c of reviewComments || []) {
    out.push({
      surface: "inline",
      id: c.id,
      author: c.user?.login || "unknown",
      body: c.body || "",
      url: c.html_url,
      at: c.created_at,
      file: c.path || null,
      line: c.line ?? c.original_line ?? null,
      review_id: c.pull_request_review_id || null,
    })
  }
  for (const r of reviews || []) {
    // Reviews without a body and without state CHANGES_REQUESTED/APPROVED are
    // usually empty wrappers — skip those, the line comments carry the content.
    if (!r.body && r.state === "COMMENTED") continue
    out.push({
      surface: "review",
      id: r.id,
      author: r.user?.login || "unknown",
      body: r.body || "",
      state: r.state || null,
      url: r.html_url,
      at: r.submitted_at,
    })
  }
  out.sort((a, b) => {
    const ta = new Date(a.at || 0).getTime()
    const tb = new Date(b.at || 0).getTime()
    if (ta !== tb) return ta - tb
    return (a.id || 0) - (b.id || 0)
  })
  return out
}

// ---- delta + cursor logic ----

export function filterDeltas(comments, surfaceCursors) {
  return comments.filter((c) => {
    const cursor = surfaceCursors?.[c.surface]
    if (!cursor) return true
    return new Date(c.at).getTime() > new Date(cursor).getTime()
  })
}

export function advanceCursor(surfaceCursors, comments) {
  const updated = { ...(surfaceCursors || {}) }
  for (const c of comments) {
    const prev = updated[c.surface]
    if (!prev || new Date(c.at).getTime() > new Date(prev).getTime()) {
      updated[c.surface] = c.at
    }
  }
  return updated
}

export function countUnread(comments, surfaceCursors) {
  let unread = 0
  let changesRequested = 0
  for (const c of comments) {
    const cursor = surfaceCursors?.[c.surface]
    const isNew = !cursor || new Date(c.at).getTime() > new Date(cursor).getTime()
    if (!isNew) continue
    unread++
    if (c.surface === "review" && c.state === "CHANGES_REQUESTED") {
      changesRequested++
    }
  }
  return { unread, changesRequested }
}

// ---- formatting for --show ----

export function formatComment(c) {
  const at = c.at ? c.at.replace("T", " ").replace("Z", "") : "(no timestamp)"
  const header = c.surface === "review"
    ? `[${c.surface}:${c.state || "?"}] ${c.author} @ ${at}`
    : c.surface === "inline"
      ? `[${c.surface}] ${c.author} @ ${at} on ${c.file || "?"}:${c.line ?? "?"}`
      : `[${c.surface}] ${c.author} @ ${at}`
  const body = (c.body || "").trim() || "(no body)"
  return `${header}\n  ${c.url}\n  ${body.split("\n").join("\n  ")}`
}

// ---- main entry ----

export async function pullPrComments(repoRoot, options) {
  const laneId = String(options.lane || "").trim()
  const prNumber = String(options.pr || "").trim()
  const acknowledge = !!options.acknowledge
  const show = !!options.show

  if (!laneId) {
    throw new Error("`btrain handoff pull-pr` requires --lane <id>")
  }
  if (!prNumber) {
    throw new Error("`btrain handoff pull-pr` requires --pr <number>")
  }

  if (!(await isGhAvailable())) {
    console.error("gh CLI not installed; pull-pr requires gh. Skipping.")
    return { skipped: "gh-not-installed", laneId, prNumber }
  }

  let identity
  try {
    identity = await getRepoIdentity(repoRoot)
  } catch (err) {
    console.error(`Could not resolve repo identity (gh repo view): ${err.message}`)
    return { skipped: "no-repo-identity", laneId, prNumber }
  }

  let raw
  try {
    raw = await fetchAllComments({ ...identity, prNumber, cwd: repoRoot })
  } catch (err) {
    console.error(`gh API fetch failed: ${err.message}`)
    return { skipped: "fetch-failed", laneId, prNumber }
  }

  const shaped = shapeComments(raw)

  const cursors = await readCursors(repoRoot)
  const cursorKey = getCursorKey(laneId, prNumber)
  const surfaceCursors = cursors[cursorKey] || {}

  // Append all shaped comments; appendComments dedups on (surface, id) so
  // re-pulls do not re-append. Returns only the records actually written.
  const appended = await appendComments(repoRoot, laneId, prNumber, shaped)

  // Counts reflect "unread vs current cursor" (pre-acknowledge).
  const { unread, changesRequested } = countUnread(shaped, surfaceCursors)

  if (acknowledge) {
    cursors[cursorKey] = advanceCursor(surfaceCursors, shaped)
    await writeCursors(repoRoot, cursors)
  }

  console.log(
    `pull-pr lane=${laneId} pr=${prNumber}: fetched ${shaped.length} total, appended ${appended.length} new to log`,
  )
  console.log(
    `unread (since cursor): ${unread} | changes-requested reviews: ${changesRequested}${acknowledge ? " — cursor advanced, all marked read" : ""}`,
  )

  // Show what's unread (against cursor) rather than what was just appended.
  // The log is forever; "what's new for the agent to read" is the cursor delta.
  if (show) {
    const unreadRecords = filterDeltas(shaped, surfaceCursors)
    if (unreadRecords.length > 0) {
      console.log("")
      console.log(`--- unread comments (${unreadRecords.length}) ---`)
      for (const c of unreadRecords) {
        console.log("")
        console.log(formatComment(c))
      }
    }
  }

  return {
    laneId,
    prNumber,
    fetched: shaped.length,
    appendedToLog: appended.length,
    unread,
    changesRequested,
    acknowledged: acknowledge,
  }
}
