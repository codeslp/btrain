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
import { authTest, callSlack, postMessage } from "./client.mjs"
import { boardStatus } from "./board.mjs"
import { channelForRepo, developerLabel, isSlackEnabled, listChannels } from "./config.mjs"
import { btrainHome, CREDENTIAL_REASONS, loadSlackCredentials, MAX_CREDENTIAL_BYTES, readSlackFile, slackFilePath } from "./credentials.mjs"
import { clearPause } from "./deliver.mjs"
import { listEntries, readDeliveryState } from "./outbox.mjs"
import { deliverToTarget, deliveryTarget } from "./target.mjs"
import { getListenerSettings } from "./config.mjs"
import { createListener } from "./listen.mjs"
import { clearPaused, leasePath, readLeaseHolder, requestStop } from "./lease.mjs"
import { LOCK_STALE_MS } from "./lock.mjs"
import { scrubSecrets } from "./text.mjs"

export const SLACK_SUBCOMMANDS = Object.freeze(["setup", "status", "channels", "test", "whois", "flush", "refresh", "listen"])

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
    case "whois":
      return whois(options, readers, io)
    case "listen":
      return listen(options, readers, io)
    case "flush":
      return drain("flush", readers, io)
    case "refresh":
      return drain("refresh", readers, io)
    default:
      io.err(`btrain slack: unknown subcommand "${subcommand || ""}". Use one of: ${SLACK_SUBCOMMANDS.join(", ")}.`)
      return 1
  }
}

// The token from a terminal, read with echo off (raw mode) so a pasted token is
// never shown. Enter ends it; Backspace removes a character; Ctrl-C cancels
// (resolves null). Raw mode is turned off again on every path, and input
// after Enter is put back for the channel prompt.
function readSecretFromTerminal(stdin, prompt) {
  return new Promise((resolve) => {
    let value = ""
    // Echo goes off before the prompt is shown: a person, or a script, may
    // type the moment the prompt appears.
    stdin.setRawMode(true)
    prompt()
    const finish = (result, rest = "") => {
      stdin.removeListener("data", onData)
      stdin.removeListener("end", onEnd)
      stdin.setRawMode(false)
      // Paused, so input put back waits for the channel prompt's reader.
      stdin.pause()
      if (rest) stdin.unshift(Buffer.from(rest))
      resolve(result)
    }
    const onEnd = () => finish(value)
    const onData = (chunk) => {
      const text = String(chunk)
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (character === "\r" || character === "\n") {
          // A carriage return from Enter may come with its line feed.
          const restStart = character === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1
          return finish(value, text.slice(restStart))
        }
        if (character === "\u0003") return finish(null)
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1)
        else value += character
      }
    }
    stdin.on("data", onData)
    stdin.on("end", onEnd)
    stdin.resume()
  })
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
  const stdin = readers.stdin || process.stdin
  const terminal = Boolean(stdin.isTTY) && typeof stdin.setRawMode === "function"
  // At a terminal the token is read with echo off before the line reader
  // starts; piped input reads it as the first line.
  let lines = terminal ? null : lineReader(stdin)
  try {
    const { data: existing, reason } = await readSlackFile({ env: io.env })
    if (reason) {
      io.err(`btrain slack setup: ${reasonText(reason)}`)
      return 1
    }
    const prompt = () => io.err("Paste the bot token (xoxb-...) and press Enter. It is not shown or printed.")
    let typed
    if (terminal) {
      typed = await readSecretFromTerminal(stdin, prompt)
    } else {
      prompt()
      typed = await lines.next()
    }
    if (typed === null && terminal) {
      io.err("btrain slack setup: cancelled. Nothing was written.")
      return 1
    }
    const token = String(typed || "").trim()
    if (!lines) lines = lineReader(stdin)
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
    lines?.close()
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

// Spec 025 WS3 (T017, T018): `btrain slack listen` runs the listener in the
// foreground until the stop flag; `--stop` writes that flag and waits up to
// two poll intervals for the lease to go; `--resume` removes the pause flag.
// It refuses to start with no operator, no token, no served repository, or a
// live lease, which it names. It prints one line for each action and never
// message text or the token.
async function listen(options, readers, io) {
  const home = btrainHome(io.env)
  const slackDir = path.join(home, "slack")
  if (options.resume) {
    io.out((await clearPaused(slackDir)) ? "listen: resumed; messages sent during the pause are ignored" : "listen: was not paused")
    return 0
  }
  if (options.stop) return stopListener(slackDir, io)

  let listener
  try {
    listener = await createListener({ home, env: io.env, readers, cliPath: readers.cliPath, fetch: readers.fetchImpl || globalThis.fetch, log: (line) => io.out(line) })
  } catch (error) {
    io.err(`btrain slack listen: ${error.message}`)
    return 1
  }
  if (!listener.operator) {
    io.err("btrain slack listen: no operator is set in ~/.btrain/slack.json; run btrain slack setup --operator <user id>")
    return 1
  }
  if (!listener.token) {
    io.err("btrain slack listen: no Slack token; run btrain slack setup")
    return 1
  }
  if (listener.served.length === 0) {
    io.err("btrain slack listen: no repository is served; turn on [features].slack and slack_listen and map a channel with btrain slack setup --channel <id>")
    return 1
  }
  const taken = await listener.acquire()
  if (!taken.ok) {
    const holder = taken.holder
    io.err(`btrain slack listen: another listener holds this btrain home${holder?.pid ? ` (process ${holder.pid}, started ${holder.startedAt || "at an unknown time"})` : ""}`)
    return 1
  }
  io.out(`operator: ${listener.operator}`)
  for (const repo of listener.served) io.out(`serving ${repo.name} (${repo.path}) in ${repo.channel}`)
  io.out(`runner: ${listener.runner || "none"} (profile check: ${listener.profile.ok ? "passed" : `not passed, ${listener.profile.reason}`})`)

  let interrupted = false
  let wake = () => {}
  const onSignal = () => {
    interrupted = true
    wake()
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  try {
    while (!interrupted) {
      const result = await listener.cycle()
      if (result.status !== "ok") {
        io.out(result.status === "stopped" ? "listen: stopped" : "listen: the lease was taken over; exiting")
        return 0
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, listener.pollSeconds * 1000)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    io.out("listen: interrupted")
    return 0
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    await listener.stop()
  }
}

async function leaseIsLive(slackDir) {
  try {
    const stat = await fs.stat(leasePath(slackDir))
    return Date.now() - stat.mtimeMs < LOCK_STALE_MS
  } catch {
    return false
  }
}

async function stopListener(slackDir, io) {
  if (!(await leaseIsLive(slackDir))) {
    io.out("listen: no listener is running")
    return 0
  }
  const holder = readLeaseHolder(slackDir)
  await requestStop(slackDir)
  const credentials = await loadSlackCredentials({ env: io.env })
  const deadline = Date.now() + 2 * getListenerSettings(credentials.settings).pollSeconds * 1000 + 1000
  while (Date.now() < deadline) {
    if (!(await leaseIsLive(slackDir))) {
      io.out(`listen: stopped${holder?.pid ? ` process ${holder.pid}` : ""}`)
      return 0
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  io.err("btrain slack listen --stop: the listener did not stop within two poll intervals")
  return 1
}

// Spec 024 FR-11 (T018): `flush` drains the queue now, with no time budget;
// `refresh` also re-renders every active card and the board from current lane
// state. Both print one line of counts and exit 0, and skip while another
// process holds the delivery lock. `readers.readLanes(repoRoot)` is the lane
// state reader cli.mjs passes in.
async function drain(subcommand, readers, io) {
  const repoRoot = path.resolve(String(readers.repoRoot || ""))
  if (!isSlackEnabled(readers.config)) {
    io.out(`${subcommand}: the publisher is off ([features].slack is not true)`)
    return 0
  }
  const target = await deliveryTarget(repoRoot, readers.config, { env: io.env })
  if (!target.token) {
    io.out(`${subcommand}: token ${reasonText(target.tokenReason)}`)
    return 0
  }
  if (!target.channel) {
    io.out(`${subcommand}: no channel is mapped for this repository; run btrain slack setup --channel <id>`)
    return 0
  }
  await fs.mkdir(target.slackDir, { recursive: true })
  const summary = await deliverToTarget(target, {
    readLanes: typeof readers.readLanes === "function" ? () => readers.readLanes(repoRoot) : async () => [],
    fetchImpl: readers.fetchImpl || globalThis.fetch,
    now: readers.now,
    refresh: subcommand === "refresh",
  })
  const reason = summary.reason ? ` (${scrubSecrets(summary.reason).text.slice(0, 200)})` : ""
  io.out(`${subcommand}: ${summary.status}${reason} · sent ${summary.sent}, dropped ${summary.dropped}, collapsed ${summary.collapsed}, deferred ${summary.deferred}, cards ${summary.cards}`)
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

// Spec 025 FR-5 (T015): the author fields of the last ten messages in a
// channel, so a person can see what the listener will and will not hear. No
// message text is printed.
const WHOIS_LIMIT = 10

async function whois(options, readers, io) {
  const repoPath = path.resolve(String(readers.repoRoot || ""))
  const credentials = await loadSlackCredentials({ env: io.env })
  if (!credentials.token) {
    io.err(`btrain slack whois: token ${reasonText(credentials.reason)}`)
    return 1
  }
  let channel = ""
  if (options.channel !== undefined) {
    channel = String(options.channel).trim()
    if (!CHANNEL_ID.test(channel)) {
      io.err("btrain slack whois: --channel must be a Slack channel ID (C..., G..., or D...).")
      return 1
    }
  } else {
    channel = channelForRepo(credentials.settings, repoPath).channel
    if (!channel) {
      io.err("btrain slack whois: no channel is mapped for this repository. Pass --channel <id>.")
      return 1
    }
  }
  const result = await callSlack({
    method: "conversations.history",
    httpMethod: "GET",
    token: credentials.token,
    args: { channel, limit: WHOIS_LIMIT },
    fetchImpl: readers.fetchImpl || globalThis.fetch,
  })
  if (!result.ok) {
    io.err(`btrain slack whois: conversations.history failed (${result.error}).`)
    return 1
  }
  const messages = Array.isArray(result.body?.messages) ? result.body.messages : []
  // Newest first, as Slack returns them; the order is kept even if it does not.
  const newestFirst = [...messages].sort((left, right) => Number(right?.ts || 0) - Number(left?.ts || 0)).slice(0, WHOIS_LIMIT)
  const field = (value) => (typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) ? value : "-")
  io.out(`channel ${channel}: the last ${newestFirst.length} message${newestFirst.length === 1 ? "" : "s"}, newest first`)
  for (const message of newestFirst) {
    io.out([
      `ts=${field(message?.ts)}`,
      `user=${field(message?.user)}`,
      `bot_id=${field(message?.bot_id)}`,
      `app_id=${field(message?.app_id)}`,
      `client_msg_id=${message?.client_msg_id ? "yes" : "no"}`,
      `subtype=${field(message?.subtype)}`,
    ].join(" "))
  }
  return 0
}
