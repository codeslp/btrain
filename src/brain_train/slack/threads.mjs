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

// The board map and the channel pace are shared by every repository of one
// developer, so their read-merge-write runs under a short lock in the btrain
// home. Unlike the delivery lock this one waits, briefly: each holder only
// reads, merges, and renames one small file. A lock left by a process that
// died is taken over after HOME_LOCK_STALE_MS, which is longer than a send
// held under it (sendOnChannel: one Slack call, at most 10 seconds).
export const HOME_LOCK_STALE_MS = 30_000
const HOME_LOCK_WAIT_MS = 5_000
export const CHANNELS_RELATIVE = path.join("slack", "channels.json")

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withHomeLock(homeDir, { waitMs = HOME_LOCK_WAIT_MS } = {}, fn) {
  const lockPath = path.join(homeDir, "slack", "home.lock")
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const nonce = randomUUID()
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    try {
      await fs.writeFile(lockPath, nonce, { flag: "wx", mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    try {
      const stat = await fs.stat(lockPath)
      if (Math.abs(Date.now() - stat.mtimeMs) > HOME_LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => {})
        continue
      }
    } catch {
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error("The Slack state in the btrain home is locked by another btrain process.")
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
 * home lock, so concurrent repositories never lose each other's lines.
 */
export async function updateBoard(homeDir, channel, update) {
  return withHomeLock(homeDir, {}, async () => {
    const boards = await readBoards(homeDir)
    const current = objectOr(boards[String(channel)])
    boards[String(channel)] = { ...current, ...update, repos: { ...objectOr(current.repos), ...objectOr(update.repos) } }
    await writeJsonAtomic(boardsPath(homeDir), boards)
    return boards[String(channel)]
  })
}

function channelsPath(homeDir) {
  return path.join(homeDir, CHANNELS_RELATIVE)
}

/** The channel's shared send state: `{ lastSentAt, retryUntil }` (ms since the epoch). */
export async function readChannelState(homeDir, channel) {
  const all = objectOr(await readJsonOr(channelsPath(homeDir), {}))
  const entry = objectOr(all[String(channel)])
  return { lastSentAt: Number(entry.lastSentAt) || 0, retryUntil: Number(entry.retryUntil) || 0 }
}

/**
 * Reserve the next send to a channel, for every repository of this developer
 * (FR-10: at most one message a second to a channel; a 429 holds the
 * channel). Returns `{ blockedUntil }` while a Retry-After holds the channel;
 * `{ tooLate }` when the next free slot is after `notAfter`, in which case
 * nothing is reserved, so a send the caller's budget cannot make leaves no
 * phantom slot; else `{ slotAt }`: the time this send may go, at least
 * `intervalMs` after the last reserved one. The slot is recorded at once, so
 * two processes never get the same one. `waitMs` bounds the wait for the
 * home lock.
 */
export async function reserveChannelSend(homeDir, channel, { now, intervalMs, notAfter = Infinity, waitMs }) {
  return withHomeLock(homeDir, { waitMs }, async () => {
    const all = objectOr(await readJsonOr(channelsPath(homeDir), {}))
    const entry = objectOr(all[String(channel)])
    const retryUntil = Number(entry.retryUntil) || 0
    if (retryUntil > now) return { blockedUntil: retryUntil }
    const slotAt = Math.max(now, (Number(entry.lastSentAt) || 0) + intervalMs)
    if (slotAt > notAfter) return { tooLate: slotAt }
    all[String(channel)] = { ...entry, lastSentAt: slotAt }
    await writeJsonAtomic(channelsPath(homeDir), all)
    return { slotAt }
  })
}

/**
 * Send on a channel, for every repository of this developer, holding the
 * home lock for the whole send: FR-10's one message a second to a channel,
 * and a 429's Retry-After, hold across repositories with no gap between a
 * check and the send it allows. Under the lock: the clock is read, a channel
 * held by a Retry-After returns `{ blockedUntil }`, a channel whose last send
 * ended less than `intervalMs` ago returns `{ waitUntil }`, and otherwise
 * `send()` runs. Its result is returned as `{ result }`, and the channel's
 * last send is recorded as the clock *after* it returned, so the next send
 * starts at least `intervalMs` after this one ended, however long the call
 * or the file writes took. A `send()` that returns `{ skipped }` sent
 * nothing, and nothing is recorded. A result with HTTP 429 or a `ratelimited`
 * error holds the channel for its Retry-After (at least `intervalMs`).
 *
 * `now` is a clock function (a number is accepted for a fixed time).
 * `waitMs` bounds the wait for the home lock.
 */
export async function sendOnChannel(homeDir, channel, { now, intervalMs, waitMs }, send) {
  const clock = typeof now === "function" ? now : () => now
  return withHomeLock(homeDir, { waitMs }, async () => {
    const at = clock()
    const all = objectOr(await readJsonOr(channelsPath(homeDir), {}))
    const entry = objectOr(all[String(channel)])
    const retryUntil = Number(entry.retryUntil) || 0
    if (retryUntil > at) return { blockedUntil: retryUntil }
    const freeAt = (Number(entry.lastSentAt) || 0) + intervalMs
    if (freeAt > at) return { waitUntil: freeAt }
    const result = await send()
    if (result?.skipped) return { result }
    const endedAt = clock()
    const updated = { ...entry, lastSentAt: endedAt }
    if (result?.status === 429 || result?.error === "ratelimited") {
      updated.retryUntil = Math.max(retryUntil, endedAt + Math.max(Number(result.retryAfterMs) || 0, intervalMs))
    }
    all[String(channel)] = updated
    await writeJsonAtomic(channelsPath(homeDir), all)
    return { result }
  })
}

/** Hold a channel until `retryUntil` after a 429, for every repository. */
export async function holdChannel(homeDir, channel, retryUntil, { waitMs } = {}) {
  return withHomeLock(homeDir, { waitMs }, async () => {
    const all = objectOr(await readJsonOr(channelsPath(homeDir), {}))
    const entry = objectOr(all[String(channel)])
    all[String(channel)] = { ...entry, retryUntil: Math.max(Number(entry.retryUntil) || 0, retryUntil) }
    await writeJsonAtomic(channelsPath(homeDir), all)
  })
}
