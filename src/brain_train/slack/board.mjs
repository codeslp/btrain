// Spec 024 FR-9 and the plan's WS5 (T022): the record behind one developer's
// board in one channel. Pure, apart from the board map in the btrain home
// (threads.mjs). Imports nothing from core.mjs.
//
// The record is `{ ts, text, pinned, pinError, repos }` under the channel in
// `~/.btrain/slack/boards.json`. `repos` maps a repository's path to
// `{ name, lanes, stale }`: the lines that repository last wrote. Each
// repository's delivery run writes only its own entry, so a repository whose
// state cannot be read never blocks the board for the others, and the board
// shows every repository mapped to the channel from its last read.
//
// `text` is what was last posted. The board is owed an update whenever the
// text rendered from the record differs from it, so a failed update is retried
// by a later run without any other bookkeeping.

import path from "node:path"
import { renderBoard } from "./render.mjs"
import { getBoard, updateBoard } from "./threads.mjs"

const INACTIVE = new Set(["", "idle", "resolved"])

/** The board key of a repository: its resolved path (FR-16 keys by path). */
export function repoKey(repoPath) {
  return path.resolve(String(repoPath || ""))
}

/** The fields the board shows, for each active lane, in lane order. */
export function boardLanes(lanes) {
  return (Array.isArray(lanes) ? lanes : [])
    .filter((lane) => lane && !INACTIVE.has(String(lane.status || "")))
    .map((lane) => ({
      lane: String(lane.lane ?? lane.laneId ?? lane._laneId ?? ""),
      status: String(lane.display || lane.displayStatus || lane.status || ""),
      owner: String(lane.owner || ""),
      reviewer: String(lane.reviewer || ""),
      prNumber: String(lane.prNumber || ""),
    }))
    .sort((left, right) => left.lane.localeCompare(right.lane))
}

/** The board text for a record: repositories by name, then by path. */
export function boardText(record, label) {
  const repos = Object.entries(record?.repos && typeof record.repos === "object" ? record.repos : {})
    .sort(([leftKey, left], [rightKey, right]) => String(left?.name || "").localeCompare(String(right?.name || "")) || leftKey.localeCompare(rightKey))
    .map(([, repo]) => ({ repoName: repo?.name || "", lanes: Array.isArray(repo?.lanes) ? repo.lanes : [], stale: Boolean(repo?.stale) }))
  return renderBoard(repos, { label })
}

/**
 * Write this repository's entry and return the merged record. With `stale`,
 * the entry keeps its last lanes and is marked "not refreshed"; a repository
 * the board has never shown gets no entry then.
 */
export async function writeRepoEntry(homeDir, channel, { repoPath, name, lanes, stale = false }) {
  const key = repoKey(repoPath)
  if (stale) {
    const record = (await getBoard(homeDir, channel)) || { repos: {} }
    const existing = record.repos?.[key]
    if (!existing) return record
    return updateBoard(homeDir, channel, { repos: { [key]: { ...existing, stale: true } } })
  }
  return updateBoard(homeDir, channel, { repos: { [key]: { name: String(name || ""), lanes: boardLanes(lanes), stale: false } } })
}

/** Whether any repository of the record shows an active lane. */
export function hasActiveLanes(record) {
  return Object.values(record?.repos && typeof record.repos === "object" ? record.repos : {})
    .some((repo) => Array.isArray(repo?.lanes) && repo.lanes.length > 0)
}

/**
 * Whether the board in `channel` must be posted, updated, or pinned for
 * `label`. A board with no message yet is owed only once some lane is
 * active. A pin is owed until it succeeds or fails once (`pinError`).
 */
export async function boardOwed(homeDir, channel, label) {
  const record = await getBoard(homeDir, channel)
  if (!record) return false
  if (!record.ts) return hasActiveLanes(record)
  if (!record.pinned && !record.pinError) return true
  return boardText(record, label) !== record.text
}

/**
 * What `btrain slack status` reports for the board in `channel`:
 * `{ posted, pinned, pinError }`. A failed pin is reported and blocks nothing.
 */
export async function boardStatus(homeDir, channel) {
  const record = await getBoard(homeDir, channel)
  return {
    posted: Boolean(record?.ts),
    pinned: Boolean(record?.pinned),
    pinError: String(record?.pinError || ""),
  }
}
