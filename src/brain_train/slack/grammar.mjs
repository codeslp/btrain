// Spec 025 FR-2 and the plan's "Command grammar": a `btrain>` command in four
// steps. Pure. Imports nothing from core.mjs.
//
//   1. Undo Slack's encoding of an operator's message: link markup becomes its
//      label (or its URL), a code fence around the command is removed, and
//      `&lt;`, `&gt;`, `&amp;` are decoded. A model's reply is not encoded and
//      skips this step.
//   2. Find the command: the one line that starts with `btrain>`, and the
//      `key: value` lines after it up to the first blank line.
//   3. Check it against slack/verbs.mjs.
//   4. Render canonical text: the verb line with its short arguments in table
//      order, then the fields in table order.
//
// Step 1 follows Slack's documented message formatting. How a Slack client
// actually encodes a typed file name or a pasted code block is a live capture
// (spec 025 T003) that has not been made; the tests built on those captures
// are skipped until it is.

import { checkValue, resolveRepo, VERBS } from "./verbs.mjs"

export const COMMAND_PREFIX = "btrain>"

// A user, channel, user-group, or special mention token, which a command may
// never hold (`<@U…>`, `<#C…>`, `<!here>`, `<!subteam^S…>`, `<!date^…>`).
const MENTION_TOKEN = /<[@#!][^>]*>/
// Link markup Slack writes for a URL, a mail address, or a file name it
// turned into a link: `<url|label>` or `<url>`. Mention tokens start with
// `@`, `#`, or `!` and are left for the check above.
const LINK_MARKUP = /<([^@#!<>|][^<>|]*)(?:\|([^<>]*))?>/g

/** Step 1: undo Slack's encoding of an operator's message. */
export function decodeSlackText(text) {
  let out = typeof text === "string" ? text : ""
  out = out.replace(LINK_MARKUP, (_, url, label) => (label !== undefined && label !== "" ? label : url))
  // A code block: remove the fences, keeping what is inside on its own lines.
  out = out.replace(/```/g, "\n")
  // `&amp;` last, so `&amp;lt;` decodes to the text `&lt;`, not to `<`.
  out = out.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
  return out
}

function isCommandLine(line) {
  return line.trimStart().startsWith(COMMAND_PREFIX)
}

/** Whether a text holds at least one `btrain>` line. */
export function hasCommand(text) {
  return String(text ?? "").split("\n").some(isCommandLine)
}

/**
 * Step 2: find the command block. Returns `{ found, reason, block, start, end }`:
 * `block` is the command line and its field lines, and `start`/`end` are the
 * line indexes it spans, so a caller can remove it from prose.
 */
export function findCommand(text) {
  const lines = String(text ?? "").split("\n")
  const starts = lines.map((line, index) => (isCommandLine(line) ? index : -1)).filter((index) => index >= 0)
  if (starts.length === 0) return { found: false, reason: "no btrain> command", block: [], start: -1, end: -1 }
  if (starts.length > 1) return { found: false, reason: "more than one btrain> line", block: [], start: -1, end: -1, many: true }
  const start = starts[0]
  let end = start + 1
  while (end < lines.length && lines[end].trim() !== "") end += 1
  return { found: true, reason: "", block: lines.slice(start, end), start, end }
}

/**
 * Parse a command block into its verb, short arguments, and fields, with no
 * check of the values. Returns `{ ok, reason, verb, args, fields }`.
 */
export function parseCommandBlock(block) {
  const [first = "", ...rest] = block
  const head = first.trimStart().slice(COMMAND_PREFIX.length).trim()
  if (!head) return { ok: false, reason: "the btrain> line names no verb" }
  const [verbName, ...words] = head.split(/\s+/)
  const args = {}
  for (const word of words) {
    const split = word.indexOf("=")
    if (split <= 0) return { ok: false, reason: `"${word}" is not key=value` }
    const key = word.slice(0, split)
    if (Object.hasOwn(args, key)) return { ok: false, reason: `${key} is given twice` }
    args[key] = word.slice(split + 1)
  }
  const fields = {}
  for (const line of rest) {
    const split = line.indexOf(":")
    if (split <= 0) return { ok: false, reason: `"${line.trim()}" is not a key: value line` }
    const key = line.slice(0, split).trim()
    if (!/^[a-z][a-z-]*$/.test(key)) return { ok: false, reason: `"${key}" is not a field name` }
    if (Object.hasOwn(fields, key) || Object.hasOwn(args, key)) return { ok: false, reason: `${key} is given twice` }
    fields[key] = line.slice(split + 1).trim()
  }
  return { ok: true, reason: "", verb: verbName, args, fields }
}

/**
 * Step 3: check a parsed command against the verb table. `channel.repos` is
 * the list of served repositories of the channel, each
 * `{ name, path, laneIds, agents }`. Returns `{ ok, reason, verb, repo, values }`
 * where `values` maps every given key (`repo` excluded) to its trimmed value.
 */
export function checkCommand(parsed, channel = {}) {
  if (!parsed?.ok) return { ok: false, reason: parsed?.reason || "not a command" }
  const definition = Object.hasOwn(VERBS, parsed.verb) ? VERBS[parsed.verb] : null
  if (!definition) return { ok: false, reason: `unknown verb ${parsed.verb}` }
  for (const key of Object.keys(parsed.args)) {
    if (!definition.args.includes(key)) return { ok: false, reason: `${parsed.verb} takes no argument ${key}=` }
  }
  for (const key of Object.keys(parsed.fields)) {
    if (!definition.fields.includes(key)) return { ok: false, reason: `${parsed.verb} takes no field ${key}:` }
  }
  const given = { ...parsed.args, ...parsed.fields }
  for (const key of definition.required) {
    if (!Object.hasOwn(given, key)) return { ok: false, reason: `${parsed.verb} needs ${key}` }
  }
  if (Object.hasOwn(given, "repo")) {
    const reason = checkValue("repo", given.repo)
    if (reason) return { ok: false, reason }
  }
  const { repo, reason: repoReason } = resolveRepo(given.repo, channel.repos)
  if (!repo) return { ok: false, reason: repoReason }
  const values = {}
  for (const [key, raw] of Object.entries(given)) {
    if (key === "repo") continue
    const reason = checkValue(key, raw, { laneIds: repo.laneIds, agents: repo.agents, repoPath: repo.path })
    if (reason) return { ok: false, reason }
    values[key] = raw.trim()
  }
  return { ok: true, reason: "", verb: parsed.verb, repo, values, repoGiven: given.repo }
}

/**
 * Step 4: the canonical text. Short arguments in table order on the verb line
 * (with `repo=` when the command gave it), then each field on its own line in
 * table order, one space after the colon, no trailing space.
 */
export function renderCanonical({ verb, values = {}, repoGiven }) {
  const definition = VERBS[verb]
  const head = [`${COMMAND_PREFIX} ${verb}`]
  for (const key of definition.args) {
    if (key === "repo") {
      if (repoGiven) head.push(`repo=${repoGiven}`)
      continue
    }
    if (values[key] !== undefined) head.push(`${key}=${values[key]}`)
  }
  const lines = [head.join(" ")]
  for (const key of definition.fields) {
    if (values[key] !== undefined) lines.push(`${key}: ${values[key]}`)
  }
  return lines.join("\n")
}

function parseAndCheck(text, channel) {
  const found = findCommand(text)
  if (!found.found) return { ok: false, reason: found.reason, many: Boolean(found.many) }
  const blockText = found.block.join("\n")
  if (MENTION_TOKEN.test(blockText)) {
    return { ok: false, reason: "a command may not hold a user, channel, or special mention" }
  }
  const checked = checkCommand(parseCommandBlock(found.block), channel)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  return { ...checked, canonical: renderCanonical(checked), start: found.start, end: found.end }
}

/**
 * An operator's message, as Slack returned it: all four steps. Returns
 * `{ ok, reason, verb, repo, values, canonical }`. Text around the command is
 * ignored (FR-2).
 */
export function parseOperatorCommand(slackText, channel = {}) {
  return parseAndCheck(decodeSlackText(slackText), channel)
}

/**
 * A command a model wrote: steps 2 to 4, with no decoding. A mention token is
 * still refused. Returns what `parseOperatorCommand` does, plus `start` and
 * `end`, the line span of the command block in the text.
 */
export function parseModelCommand(text, channel = {}) {
  return parseAndCheck(String(text ?? ""), channel)
}

/**
 * Parse stored canonical text back into its verb and values, for the command
 * that runs it (FR-7: what runs is what was shown). No repository check:
 * the stored text was checked when it was stored, and slack/commands.mjs runs
 * its own pre-checks.
 */
export function parseCanonical(canonical) {
  const found = findCommand(canonical)
  if (!found.found) return { ok: false, reason: found.reason }
  const parsed = parseCommandBlock(found.block)
  if (!parsed.ok) return parsed
  const { repo, ...args } = parsed.args
  return { ok: true, reason: "", verb: parsed.verb, values: { ...args, ...parsed.fields }, repoGiven: repo }
}
