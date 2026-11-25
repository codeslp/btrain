// Spec 024 FR-5, FR-9 and the plan's "Data model": the thread map in the state
// root (`<state root>/.btrain/slack/threads.json`, `"<laneId>@<claimKey>"` to
// `{ channel, cardTs }`) and the board map in the developer's global btrain
// home (`~/.btrain/slack/boards.json`, channel to `{ ts, pinned, repos }`).
//
// Each map is written whole to a temporary file and renamed. Only the delivery
// lock holder writes the thread map; the board map is shared by every
// repository of one developer, so a writer reads it again just before it
// writes. Imports nothing from core.mjs.

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { readJsonOr, writeJsonAtomic } from "./outbox.mjs"

export const THREADS_FILENAME = "threads.json"
export const BOARDS_RELATIVE = path.join("slack", "boards.json")

/** One thread per lane task: the lane and the time of its claim (FR-5). */
export function threadKey(laneId, claimKey) {
  return `${String(laneId || "")}@${String(claimKey || "")}`
}

function objectOr(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

export async function readThreads(slackDir) {
  return objectOr(await readJsonOr(path.join(slackDir, THREADS_FILENAME), {}))
}

/** The thread of one lane task, or null. */
export async function getThread(slackDir, laneId, claimKey) {
  const entry = (await readThreads(slackDir))[threadKey(laneId, claimKey)]
  return entry && typeof entry === "object" && entry.channel && entry.cardTs ? { channel: entry.channel, cardTs: entry.cardTs } : null
}

export async function setThread(slackDir, laneId, claimKey, { channel, cardTs }) {
  const threads = await readThreads(slackDir)
  threads[threadKey(laneId, claimKey)] = { channel: String(channel), cardTs: String(cardTs) }
  await writeJsonAtomic(path.join(slackDir, THREADS_FILENAME), threads)
}

/** Forget a lane task's thread, after its card was deleted in Slack. */
export async function deleteThread(slackDir, laneId, claimKey) {
  const threads = await readThreads(slackDir)
  if (!Object.hasOwn(threads, threadKey(laneId, claimKey))) return
  delete threads[threadKey(laneId, claimKey)]
  await writeJsonAtomic(path.join(slackDir, THREADS_FILENAME), threads)
}

export function boardsPath(homeDir) {
  return path.join(homeDir, BOARDS_RELATIVE)
}

export async function readBoards(homeDir) {
  return objectOr(await readJsonOr(boardsPath(homeDir), {}))
}

export async function getBoard(homeDir, channel) {
  const board = (await readBoards(homeDir))[String(channel)]
  return board && typeof board === "object" ? board : null
}

// The board map is shared by every repository of one developer, so its
// read-merge-write runs under a short lock in the btrain home. Unlike the
// delivery lock this one waits, briefly: each holder only reads, merges, and
// renames one small file. A lock left by a process that died is taken over
// after BOARD_LOCK_STALE_MS.
export const BOARD_LOCK_STALE_MS = 10_000
const BOARD_LOCK_WAIT_MS = 5_000

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withBoardLock(homeDir, fn) {
  const lockPath = `${boardsPath(homeDir)}.lock`
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const nonce = randomUUID()
  const deadline = Date.now() + BOARD_LOCK_WAIT_MS
  for (;;) {
    try {
      await fs.writeFile(lockPath, nonce, { flag: "wx", mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    try {
      const stat = await fs.stat(lockPath)
      if (Math.abs(Date.now() - stat.mtimeMs) > BOARD_LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => {})
        continue
      }
    } catch {
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error("The Slack board map is locked by another btrain process.")
    }
    await pause(5 + Math.floor(Math.random() * 20))
  }
  try {
    return await fn()
  } finally {
    try {
      if ((await fs.readFile(lockPath, "utf8")) === nonce) await fs.unlink(lockPath)
    } catch {
      // Already gone.
    }
  }
}

/**
 * Merge `update` into one channel's board record and write the map, under the
 * board lock, so concurrent repositories never lose each other's lines.
 */
export async function updateBoard(homeDir, channel, update) {
  return withBoardLock(homeDir, async () => {
    const boards = await readBoards(homeDir)
    const current = objectOr(boards[String(channel)])
    boards[String(channel)] = { ...current, ...update, repos: { ...objectOr(current.repos), ...objectOr(update.repos) } }
    await writeJsonAtomic(boardsPath(homeDir), boards)
    return boards[String(channel)]
  })
}
