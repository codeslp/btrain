// Spec 024 FR-3 and the plan's "Data model": the outbox is a directory of
// entry files under `<state root>/.btrain/slack/outbox/`, one file per entry,
// named `<stamp>-<id>.json`. Nothing appends to a shared file: an entry is
// written under a temporary name and renamed into place, so a reader never
// sees half an entry and two writers never share a file.
//
// `delivery-state.json` beside it holds each failed entry's retry state, the
// pause, and the counters. Only the delivery lock holder writes it, by the
// same temporary-file-and-rename.
//
// Every function takes the Slack state directory (`<state root>/.btrain/slack`)
// as its first argument. Imports nothing from core.mjs.

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export const OUTBOX_DIRNAME = "outbox"
export const DELIVERY_STATE_FILENAME = "delivery-state.json"

// `<stamp>-<sequence>-<uuid>.json`: the stamp is fixed-width UTC with no
// colon, so names sort in time order and are legal on Windows.
const ENTRY_NAME = /^\d{8}T\d{9}Z-(?:\d{10}-)?[0-9a-f-]{36}\.json$/
const TEMP_PREFIX = ".tmp-"

export function outboxDir(slackDir) {
  return path.join(slackDir, OUTBOX_DIRNAME)
}

/** `2026-11-23T21:45:00.123Z` as `20261123T214500123Z`. */
export function formatStamp(date) {
  const iso = new Date(date).toISOString()
  return iso.replace(/[-:.]/g, "")
}

/**
 * Write `value` as JSON to `filePath` through a temporary file in the same
 * directory and a rename, so no reader sees a partial file.
 */
export async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const temp = path.join(dir, `${TEMP_PREFIX}${path.basename(filePath)}-${process.pid}-${randomUUID()}`)
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await fs.rename(temp, filePath)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** Read a JSON file, or return `fallback` when it is missing or does not parse. */
export async function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return fallback
  }
}

/**
 * Queue one entry. `entry` holds `laneId`, `claimKey`, `kind`, `reply`,
 * `mention`, and `fields` already prepared by the text pipeline; `id` and
 * `queuedAt` are filled in when missing. Returns `{ name, entry }`.
 */
// A per-process sequence in the name, after the stamp: two entries queued in
// the same millisecond would otherwise sort by their random ids, out of
// queue order. The queue time itself is never changed.
let sequence = 0

export async function writeEntry(slackDir, entry, { now = Date.now } = {}) {
  const at = now()
  sequence += 1
  const full = { id: randomUUID(), queuedAt: new Date(at).toISOString(), ...entry }
  if (!/^[0-9a-f-]{36}$/.test(String(full.id))) {
    throw new Error("An outbox entry id must be a UUID.")
  }
  const name = `${formatStamp(full.queuedAt)}-${String(sequence).padStart(10, "0")}-${full.id}.json`
  await writeJsonAtomic(path.join(outboxDir(slackDir), name), full)
  return { name, entry: full }
}

/**
 * The pending entries in name order (queue order). A file that does not parse
 * is listed with `entry: null` and its `error`, so delivery can drop it; one
 * that cannot be read right now is left out of this listing.
 * Temporary files and anything else in the directory are not listed.
 */
export async function listEntries(slackDir) {
  let names
  try {
    names = await fs.readdir(outboxDir(slackDir))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const listed = []
  for (const name of names.filter((item) => ENTRY_NAME.test(item)).sort()) {
    try {
      const entry = JSON.parse(await fs.readFile(path.join(outboxDir(slackDir), name), "utf8"))
      listed.push({ name, entry: entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null, error: "" })
    } catch (error) {
      // Only an entry that does not parse is broken. A read that failed for
      // another reason (EMFILE, EACCES) leaves the entry for the next run.
      if (error instanceof SyntaxError) listed.push({ name, entry: null, error: error.message })
    }
  }
  return listed
}

/** Remove a finished entry. A file already gone is not an error. */
export async function removeEntry(slackDir, name) {
  if (!ENTRY_NAME.test(name)) {
    throw new Error(`Not an outbox entry name: ${name}`)
  }
  await fs.rm(path.join(outboxDir(slackDir), name), { force: true })
}

/**
 * `entries`: retry state of failed entries, by entry id. `cards`: cards whose
 * refresh is still owed, by thread key. `channels`: the earliest next send to
 * each channel (pace and Retry-After). `paused`: the configuration error that
 * paused delivery.
 */
export function emptyDeliveryState() {
  return { entries: {}, cards: {}, channels: {}, paused: null, counters: { sent: 0, dropped: 0, collapsed: 0 }, lastError: "" }
}

/** The delivery state, with defaults for anything missing. */
export async function readDeliveryState(slackDir) {
  const stored = await readJsonOr(path.join(slackDir, DELIVERY_STATE_FILENAME), null)
  const state = emptyDeliveryState()
  if (!stored || typeof stored !== "object") return state
  for (const key of ["entries", "cards", "channels"]) {
    if (stored[key] && typeof stored[key] === "object" && !Array.isArray(stored[key])) state[key] = { ...stored[key] }
  }
  if (stored.paused && typeof stored.paused === "object") state.paused = { ...stored.paused }
  if (stored.counters && typeof stored.counters === "object") {
    for (const key of Object.keys(state.counters)) {
      const value = Number(stored.counters[key])
      state.counters[key] = Number.isFinite(value) && value >= 0 ? value : 0
    }
  }
  if (typeof stored.lastError === "string") state.lastError = stored.lastError
  return state
}

export async function writeDeliveryState(slackDir, state) {
  await writeJsonAtomic(path.join(slackDir, DELIVERY_STATE_FILENAME), state)
}
