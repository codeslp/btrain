// Spec 024 FR-14, FR-16 and the plan's WS2 (T010): `btrain slack setup`,
// `status`, `channels`, and `test`. `cli.mjs` routes the `slack` command here
// and hands over one object of readers, so a later subcommand can need
// another reader without a change to that call. Nothing here imports core.mjs.
//
// No command prints the token. `setup` reads it from standard input and
// writes `~/.btrain/slack.json` with mode 0600; the other commands only say
// where it came from.

import fs from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { authTest, postMessage } from "./client.mjs"
import { boardStatus } from "./board.mjs"
import { channelForRepo, developerLabel, isSlackEnabled, listChannels } from "./config.mjs"
import { btrainHome, CREDENTIAL_REASONS, loadSlackCredentials, MAX_CREDENTIAL_BYTES, readSlackFile, slackFilePath } from "./credentials.mjs"
import { clearPause } from "./deliver.mjs"
import { listEntries, readDeliveryState } from "./outbox.mjs"

export const SLACK_SUBCOMMANDS = Object.freeze(["setup", "status", "channels", "test"])

// A Slack bot token. The value is checked for shape only; `btrain slack test`
// checks it against Slack.
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,}$/
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/
const USER_ID = /^[UW][A-Z0-9]{2,20}$/

const REASON_TEXT = Object.freeze({
  [CREDENTIAL_REASONS.MISSING]: "missing: no token in BTRAIN_SLACK_BOT_TOKEN or ~/.btrain/slack.json; run btrain slack setup",
  [CREDENTIAL_REASONS.INSECURE]: "refused: ~/.btrain/slack.json is readable by others or owned by another user; chmod 600 it",
  [CREDENTIAL_REASONS.INVALID]: "refused: ~/.btrain/slack.json is not a small JSON object in a regular file",
})

function reasonText(reason) {
  return REASON_TEXT[reason] || `refused: ${reason}`
}

/**
 * Run one `btrain slack` subcommand. `readers` holds what only cli.mjs can
 * provide: `repoRoot`, `config` (the parsed project.toml), `slackDir` (the
 * repository's Slack state), and optionally `env`, `stdin`, `out`, `err`,
 * `fetchImpl`, and `now`. Resolves with the exit code.
 */
export async function runSlackCommand(subcommand, options = {}, readers = {}) {
  const io = {
    env: readers.env || process.env,
    out: readers.out || ((line) => process.stdout.write(`${line}\n`)),
    err: readers.err || ((line) => process.stderr.write(`${line}\n`)),
  }
  switch (subcommand) {
    case "setup":
      return setup(options, readers, io)
    case "status":
      return status(readers, io)
    case "channels":
      return channels(readers, io)
    case "test":
      return test(readers, io)
    default:
      io.err(`btrain slack: unknown subcommand "${subcommand || ""}". Use one of: ${SLACK_SUBCOMMANDS.join(", ")}.`)
      return 1
  }
}

// Lines from standard input, one at a time, so a person at a terminal can
// answer the channel prompt after typing the token.
function lineReader(stdin) {
  const rl = readline.createInterface({ input: stdin, terminal: false })
  const iterator = rl[Symbol.asyncIterator]()
  return {
    async next() {
      const { value, done } = await iterator.next()
      return done ? null : String(value)
    },
    close() {
      rl.close()
    },
  }
}

// Write slack.json only in a form its reader accepts (FR-2: at most
// MAX_CREDENTIAL_BYTES): indented when that fits, else compact. Returns false,
// writing nothing, when even the compact form is too large, so a working file
// is never replaced by one that would turn the publisher off.
async function writeSlackFile(env, data) {
  const pretty = `${JSON.stringify(data, null, 2)}\n`
  const compact = `${JSON.stringify(data)}\n`
  const text = Buffer.byteLength(pretty) <= MAX_CREDENTIAL_BYTES ? pretty : compact
  if (Buffer.byteLength(text) > MAX_CREDENTIAL_BYTES) return false
  const target = slackFilePath(env)
  await fs.mkdir(btrainHome(env), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, text, { mode: 0o600 })
  await fs.chmod(temporary, 0o600)
  await fs.rename(temporary, target)
  return true
}

async function setup(options, readers, io) {
  const lines = lineReader(readers.stdin || process.stdin)
  try {
    const { data: existing, reason } = await readSlackFile({ env: io.env })
    if (reason) {
      io.err(`btrain slack setup: ${reasonText(reason)}`)
      return 1
    }
    io.err("Paste the bot token (xoxb-...) and press Enter. It is not shown or printed.")
    const token = String((await lines.next()) || "").trim()
    if (!BOT_TOKEN.test(token)) {
      io.err("btrain slack setup: that is not a Slack bot token (it starts with xoxb-). Nothing was written.")
      return 1
    }
    const data = { ...(existing || {}), botToken: token }

    if (options.operator !== undefined) {
      const operator = String(options.operator).trim()
      if (!USER_ID.test(operator)) {
        io.err(`btrain slack setup: --operator must be a Slack user ID (U... or W...). Nothing was written.`)
        return 1
      }
      data.operator = operator
    }

    const repoPath = path.resolve(String(readers.repoRoot || ""))
    const channelsMap = data.channels && typeof data.channels === "object" && !Array.isArray(data.channels) ? { ...data.channels } : {}
    if (options.channel !== undefined) {
      const channel = String(options.channel).trim()
      if (!CHANNEL_ID.test(channel)) {
        io.err("btrain slack setup: --channel must be a Slack channel ID (C..., G..., or D...). Nothing was written.")
        return 1
      }
      channelsMap[repoPath] = channel
    } else if (channelForRepo(data, repoPath).source !== "mapped") {
      // FR-16: fold the repository into an existing project channel first,
      // then the catch-all, then a new channel.
      const existingChannels = listChannels(data)
      const choices = [
        ...existingChannels.map(({ channel, repos }) => ({ kind: "channel", channel, label: `${channel} (carries ${repos.join(", ")})` })),
        { kind: "default", label: CHANNEL_ID.test(String(data.defaultChannel || "")) ? `the catch-all ${data.defaultChannel}` : "the catch-all (asks for its channel ID)" },
        { kind: "new", label: "a new channel ID for this repository" },
      ]
      io.err(`Where should ${repoPath} publish?`)
      choices.forEach((choice, index) => io.err(`  ${index + 1}) ${choice.label}`))
      const answer = String((await lines.next()) || "").trim()
      const picked = choices[Number.parseInt(answer, 10) - 1]
      if (!picked) {
        io.err("No channel chosen; the repository stays unmapped. Run btrain slack setup --channel <id> later.")
      } else if (picked.kind === "channel") {
        channelsMap[repoPath] = picked.channel
      } else {
        const needsId = picked.kind === "new" || !CHANNEL_ID.test(String(data.defaultChannel || ""))
        let channel = ""
        if (needsId) {
          io.err("Channel ID (C..., G..., or D...):")
          channel = String((await lines.next()) || "").trim()
          if (!CHANNEL_ID.test(channel)) {
            io.err("btrain slack setup: that is not a Slack channel ID. Nothing was written.")
            return 1
          }
        }
        if (picked.kind === "new") channelsMap[repoPath] = channel
        else if (needsId) data.defaultChannel = channel
      }
    }
    if (Object.keys(channelsMap).length > 0) data.channels = channelsMap

    if (!(await writeSlackFile(io.env, data))) {
      io.err(`btrain slack setup: the settings would exceed ${MAX_CREDENTIAL_BYTES} bytes, which ${slackFilePath(io.env)} may not. Nothing was written; remove unused entries from its channels map.`)
      return 1
    }
    const { channel, source } = channelForRepo(data, repoPath)
    io.out(`Saved ${slackFilePath(io.env)} (mode 0600). The token is stored, not shown.`)
    io.out(channel ? `This repository publishes to ${channel}${source === "default" ? " (the catch-all)" : ""}.` : "No channel is mapped for this repository.")
    io.out("Check it with: btrain slack test")
    return 0
  } finally {
    lines.close()
  }
}

function age(ms) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

async function status(readers, io) {
  const now = readers.now || Date.now
  const repoPath = path.resolve(String(readers.repoRoot || ""))
  const credentials = await loadSlackCredentials({ env: io.env })
  const { channel, source } = channelForRepo(credentials.settings, repoPath)
  io.out(`publisher: ${isSlackEnabled(readers.config) ? "on" : "off ([features].slack is not true)"}`)
  io.out(`token: ${credentials.token ? `from ${credentials.source === "env" ? "BTRAIN_SLACK_BOT_TOKEN" : "~/.btrain/slack.json"}` : reasonText(credentials.reason)}`)
  io.out(`label: ${developerLabel(credentials.settings)}`)
  io.out(channel
    ? `channel: ${channel}${source === "default" ? " (the catch-all)" : ""}`
    : "channel: none mapped; run btrain slack setup --channel <id> or set defaultChannel")

  const slackDir = readers.slackDir
  const entries = slackDir ? await listEntries(slackDir) : []
  const times = entries.map((item) => Date.parse(item.entry?.queuedAt || "")).filter(Number.isFinite)
  io.out(`pending: ${entries.length}${times.length > 0 ? `, oldest ${age(now() - Math.min(...times))} old` : ""}`)
  const state = slackDir ? await readDeliveryState(slackDir) : null
  io.out(`paused: ${state?.paused ? `yes (${state.paused.error}); run btrain slack test to resume` : "no"}`)
  if (state?.lastError) io.out(`last error: ${state.lastError}`)

  if (channel) {
    const board = await boardStatus(btrainHome(io.env), channel)
    io.out(`board: ${!board.posted ? "not posted yet" : board.pinned ? "posted and pinned" : board.pinError ? `posted, not pinned (${board.pinError})` : "posted, not pinned yet"}`)
  }
  return 0
}

async function channels(readers, io) {
  const credentials = await loadSlackCredentials({ env: io.env })
  if (credentials.reason && credentials.reason !== CREDENTIAL_REASONS.MISSING) {
    io.out(`settings: ${reasonText(credentials.reason)}`)
    return 0
  }
  const list = listChannels(credentials.settings)
  if (list.length === 0) io.out("No repository is mapped to a channel.")
  for (const { channel, repos } of list) {
    io.out(`${channel}`)
    for (const repo of repos) io.out(`  ${repo}`)
  }
  const fallback = String(credentials.settings.defaultChannel || "")
  io.out(CHANNEL_ID.test(fallback) ? `catch-all: ${fallback}` : "catch-all: none set")
  return 0
}

async function test(readers, io) {
  const repoPath = path.resolve(String(readers.repoRoot || ""))
  const credentials = await loadSlackCredentials({ env: io.env })
  if (!credentials.token) {
    io.err(`btrain slack test: token ${reasonText(credentials.reason)}`)
    return 1
  }
  const { channel } = channelForRepo(credentials.settings, repoPath)
  if (!channel) {
    io.err("btrain slack test: no channel is mapped for this repository. Run btrain slack setup --channel <id>.")
    return 1
  }
  const call = { token: credentials.token, fetchImpl: readers.fetchImpl || globalThis.fetch }
  const auth = await authTest(call)
  if (!auth.ok) {
    io.err(`btrain slack test: auth.test failed (${auth.error}).`)
    return 1
  }
  io.out(`auth: ok (${auth.body?.team || "workspace"}, bot ${auth.body?.user || "user"})`)
  const label = developerLabel(credentials.settings)
  const sent = await postMessage({ ...call, channel, text: `btrain test from dev: ${label}` })
  if (!sent.ok) {
    io.err(`btrain slack test: posting to ${channel} failed (${sent.error}).`)
    return 1
  }
  io.out(`posted a test message to ${channel}`)
  if (readers.slackDir) await clearPause(readers.slackDir)
  return 0
}
