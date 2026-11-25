// Spec 024 FR-2: the bot token and the developer's Slack settings never enter
// a repository.
//
// The token comes from `BTRAIN_SLACK_BOT_TOKEN`, else from
// `<btrain home>/slack.json` (`BRAIN_TRAIN_HOME` moves the home). The file is
// read under the rules `loadSystemOneRuntimeConfig` applies to `jev.json`:
// opened without following a symlink, at most 4096 bytes, owned by the
// current user, and not readable by group or other. Windows skips the owner
// and mode checks. A file that fails a check is reported as
// `insecure-credential-file` or `invalid-credential-file`, and the publisher
// stays off. No result, error, or reason holds the token's value.
//
// Imports nothing from core.mjs.

import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const TOKEN_ENV = "BTRAIN_SLACK_BOT_TOKEN"
export const SLACK_FILENAME = "slack.json"
export const MAX_CREDENTIAL_BYTES = 4096

export const CREDENTIAL_REASONS = Object.freeze({
  MISSING: "missing-token",
  INSECURE: "insecure-credential-file",
  INVALID: "invalid-credential-file",
})

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

/** The btrain home: `BRAIN_TRAIN_HOME`, else `~/.btrain`. */
export function btrainHome(env = process.env) {
  return path.resolve(text(env.BRAIN_TRAIN_HOME) || path.join(os.homedir(), ".btrain"))
}

export function slackFilePath(env = process.env) {
  return path.join(btrainHome(env), SLACK_FILENAME)
}

/**
 * Read `slack.json` with the FR-2 checks. Returns `{ data, reason }`: `data` is
 * the parsed object, or null when the file is missing (`reason` empty) or
 * fails a check (`reason` names which).
 */
export async function readSlackFile({ env = process.env, platform = process.platform, getuid = process.getuid } = {}) {
  let file
  try {
    file = await fs.open(slackFilePath(env), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) {
      return { data: null, reason: CREDENTIAL_REASONS.INVALID }
    }
    if (platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof getuid === "function" && stat.uid !== getuid()))) {
      return { data: null, reason: CREDENTIAL_REASONS.INSECURE }
    }
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_CREDENTIAL_BYTES) {
      return { data: null, reason: CREDENTIAL_REASONS.INVALID }
    }
    const data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { data: null, reason: CREDENTIAL_REASONS.INVALID }
    }
    return { data, reason: "" }
  } catch (error) {
    // ELOOP: the path is a symlink, which O_NOFOLLOW refuses.
    return error.code === "ENOENT" ? { data: null, reason: "" } : { data: null, reason: CREDENTIAL_REASONS.INVALID }
  } finally {
    await file?.close().catch(() => {})
  }
}

/**
 * The token and where it came from: `{ token, source, reason, settings }`.
 * `source` is `env` or `file`; `token` is "" with a `reason` when there is
 * none. `settings` is the file's object (with `botToken` removed) for
 * config.mjs, or `{}`. The environment variable wins over the file's token,
 * but a file that fails a check still turns the publisher off: its settings
 * cannot be trusted either.
 */
export async function loadSlackCredentials(options = {}) {
  const env = options.env || process.env
  const { data, reason } = await readSlackFile({ ...options, env })
  if (reason) {
    return { token: "", source: "", reason, settings: {} }
  }
  const { botToken, ...settings } = data || {}
  const fromEnv = text(env[TOKEN_ENV])
  if (fromEnv) {
    return { token: fromEnv, source: "env", reason: "", settings }
  }
  const fromFile = text(botToken)
  if (fromFile) {
    return { token: fromFile, source: "file", reason: "", settings }
  }
  return { token: "", source: "", reason: CREDENTIAL_REASONS.MISSING, settings }
}
