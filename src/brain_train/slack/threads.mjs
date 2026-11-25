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
// died is superseded after HOME_LOCK_STALE_MS, which is longer than a send
// held under it (sendOnChannel: one Slack call, at most 10 seconds).
export const HOME_LOCK_STALE_MS = 30_000
const HOME_LOCK_WAIT_MS = 5_000
export const CHANNELS_RELATIVE = path.join("slack", "channels.json")

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The home lock is a series of generation files in `<home>/slack/`:
// `home.lock.<n>`, n = 1, 2, ... (an older `home.lock` counts as generation 0).
// The highest generation is the lock. A holder owns it while its file is the
// highest and still holds its nonce.
//
// - To acquire, a process creates the next generation, one above the highest
//   it sees, with an exclusive create, when the highest is gone or stale. Two
//   processes that race for one generation cannot both create it.
// - A stale lock (its holder died) is never moved or deleted to take it over:
//   the next generation simply supersedes it. So no live lock's path is ever
//   vacated, and nobody can slip in while a lock is being recovered.
// - Release deletes the holder's own file. After acquiring, a holder deletes
//   the generations below its own; their holders, if still alive, find before
//   they send that they no longer hold the lock.
const HOME_LOCK_NAME = /^home\.lock(?:\.(\d+))?$/

async function homeLockGenerations(dir) {
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const generations = []
  for (const name of names) {
    const match = HOME_LOCK_NAME.exec(name)
    if (match) generations.push({ generation: match[1] === undefined ? 0 : Number(match[1]), file: path.join(dir, name) })
  }
  return generations.sort((left, right) => left.generation - right.generation)
}

// Take the home lock, waiting up to `waitMs`. Returns a handle, or null when
// another live holder kept it for the whole wait.
async function acquireHomeLock(homeDir, waitMs) {
  const dir = path.join(homeDir, "slack")
  await fs.mkdir(dir, { recursive: true })
  const nonce = randomUUID()
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const generations = await homeLockGenerations(dir)
    const top = generations.at(-1) || null
    let free = !top
    if (top) {
      try {
        const seen = await fs.stat(top.file)
        free = Math.abs(Date.now() - seen.mtimeMs) > HOME_LOCK_STALE_MS
      } catch {
        // Released between the listing and the stat: look again.
        continue
      }
    }
    if (free) {
      const generation = (top ? top.generation : 0) + 1
      const file = path.join(dir, `home.lock.${generation}`)
      try {
        await fs.writeFile(file, nonce, { flag: "wx", mode: 0o600 })
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        // Another process took this generation first.
        continue
      }
      // Superseded generations: a stale one's holder is gone, and a live one
      // finds before it sends that it no longer holds the lock.
      for (const older of generations) await fs.unlink(older.file).catch(() => {})
      return makeHomeLock(dir, file, generation, nonce)
    }
    if (Date.now() >= deadline) return null
    await pause(5 + Math.floor(Math.random() * 20))
  }
}

function makeHomeLock(dir, file, generation, nonce) {
  return {
    /** True while this holder's generation is the highest and holds its nonce. */
    async stillMine() {
      try {
        if ((await fs.readFile(file, "utf8")) !== nonce) return false
        const top = (await homeLockGenerations(dir)).at(-1)
        return Boolean(top && top.generation === generation)
      } catch {
        return false
      }
    },
    async release() {
      try {
        if ((await fs.readFile(file, "utf8")) === nonce) await fs.unlink(file)
      } catch {
        // Already gone.
      }
    },
  }
}

async function withHomeLock(homeDir, { waitMs = HOME_LOCK_WAIT_MS } = {}, fn) {
  const lock = await acquireHomeLock(homeDir, waitMs)
  if (!lock) {
    throw new Error("The Slack state in the btrain home is locked by another btrain process.")
  }
  try {
    return await fn(lock)
  } finally {
    await lock.release()
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
 * `waitMs` bounds the wait for the home lock; when another sender holds it
 * for the whole wait, nothing is sent and `{ busy: true }` is returned.
 */
export async function sendOnChannel(homeDir, channel, { now, intervalMs, waitMs = HOME_LOCK_WAIT_MS }, send) {
  const clock = typeof now === "function" ? now : () => now
  const lock = await acquireHomeLock(homeDir, waitMs)
  // Another sender held the channel's lock for the whole wait.
  if (!lock) return { busy: true }
  try {
    const at = clock()
    const all = objectOr(await readJsonOr(channelsPath(homeDir), {}))
    const entry = objectOr(all[String(channel)])
    const retryUntil = Number(entry.retryUntil) || 0
    if (retryUntil > at) return { blockedUntil: retryUntil }
    const freeAt = (Number(entry.lastSentAt) || 0) + intervalMs
    if (freeAt > at) return { waitUntil: freeAt }
    // The lock may have been taken over (see acquireHomeLock): never send
    // without it.
    if (!(await lock.stillMine())) return { busy: true }
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
  } finally {
    await lock.release()
  }
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
