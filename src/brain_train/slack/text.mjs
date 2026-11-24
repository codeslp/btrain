// Spec 024 FR-8: every agent-written field goes through one pipeline before it
// is queued or posted. Pure. Imports nothing from core.mjs (plan, "Plan
// decision"); the secret list is review/secret-patterns.mjs, the list
// `btrain review code` uses.
//
// Order (plan, "Text pipeline", with one step added after the scrub):
//   1. scrub: every secret match becomes `[redacted]`, matched through any
//      control or invisible format character placed inside it;
//   1a. control characters become spaces (line breaks too, for a one-line
//      field) and format characters are removed;
//   2. cut to the field's length on a character boundary;
//   3. escape `&`, `<`, `>`;
//   4. rewrite `://` to `[:]//`.
// Scrubbing first means a cut cannot leave the start of a secret behind.
// Escaping before defanging is safe: neither step produces what the other
// rewrites.
//
// Not covered, and left to the spec (an open question, not decided here):
// Slack also turns `www.example.com`, a bare domain, and an e-mail address
// into a link. The plan's pipeline rewrites only `://`.
//
// Each step is exported on its own and returns `{ text, changed }`, so the
// spec 025 listener can reuse one step. `prepareAgentText` runs all four and
// returns the text.

import { globalSecretRegexes } from "../review/secret-patterns.mjs"

export const REDACTED = "[redacted]"
export const ELLIPSIS = "…"
// Slack's limit is 4,000 characters; every finished message stays under it.
export const MAX_MESSAGE_CHARS = 3999

function asText(value) {
  if (value === null || value === undefined) return ""
  return typeof value === "string" ? value : String(value)
}

// Control (Cc) and invisible format (Cf, such as U+200B) characters. An agent
// can put one inside a secret to break the pattern; the scrub looks through
// them.
const HIDDEN_CHAR = /^[\p{Cc}\p{Cf}]$/u

// A view of `input` for matching, with every hidden character replaced by a
// space (`space`) or removed (`drop`). `map[i]` is the index in `input` of the
// view's UTF-16 unit `i`.
function hiddenCharView(input, mode) {
  let text = ""
  const map = []
  let index = 0
  for (const char of input) {
    if (HIDDEN_CHAR.test(char)) {
      if (mode === "space") {
        text += " "
        map.push(index)
      }
    } else {
      text += char
      for (let unit = 0; unit < char.length; unit += 1) map.push(index + unit)
    }
    index += char.length
  }
  return { text, map }
}

/**
 * Step 1. Replace every secret with `[redacted]`: also a secret glued to the
 * word before it, and one with a control or invisible format character inside
 * it (`Bearer\u0000…`, a token split by U+200B or a line break). Matches are
 * found in two views of the text, hidden characters as spaces and hidden
 * characters removed, and the span of the original text each covers is
 * redacted.
 */
export function scrubSecrets(value) {
  const input = asText(value)
  const spans = []
  for (const mode of ["space", "drop"]) {
    const view = hiddenCharView(input, mode)
    for (const regex of globalSecretRegexes({ boundaries: false })) {
      for (const match of view.text.matchAll(regex)) {
        if (match[0].length === 0) continue
        const start = view.map[match.index]
        const end = view.map[match.index + match[0].length - 1] + 1
        spans.push([start, end])
      }
    }
  }
  if (spans.length === 0) {
    return { text: input, changed: false }
  }
  spans.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  let text = ""
  let cursor = 0
  let open = null
  for (const [start, end] of spans) {
    if (open && start <= open[1]) {
      open[1] = Math.max(open[1], end)
      continue
    }
    if (open) {
      text += `${input.slice(cursor, open[0])}${REDACTED}`
      cursor = open[1]
    }
    open = [start, end]
  }
  text += `${input.slice(cursor, open[0])}${REDACTED}${input.slice(open[1])}`
  return { text, changed: text !== input }
}

/**
 * Step 2. Cut to at most `maxChars` characters on a code-point boundary, so a
 * surrogate pair is never split. A cut text ends with `…`, counted in the
 * limit. No limit (or a non-positive one) leaves the text as it is.
 */
export function cutText(value, maxChars) {
  const input = asText(value)
  const limit = Math.floor(Number(maxChars))
  if (!Number.isFinite(limit) || limit <= 0) {
    return { text: input, changed: false }
  }
  const chars = Array.from(input)
  if (chars.length <= limit) {
    return { text: input, changed: false }
  }
  return { text: `${chars.slice(0, limit - 1).join("")}${ELLIPSIS}`, changed: true }
}

/** Step 3. Escape the three characters Slack treats as markup. */
export function escapeSlackText(value) {
  const input = asText(value)
  const text = input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return { text, changed: text !== input }
}

/** Step 4. Rewrite the scheme separator, so Slack makes no link from it. */
export function defangUrls(value) {
  const input = asText(value)
  const text = input.replaceAll("://", "[:]//")
  return { text, changed: text !== input }
}

/**
 * Turn control characters into one space. By default that is every line
 * break, tab, other control character, and the Unicode line and paragraph
 * separators, so agent text cannot add a line to a card (forging an FR-13
 * `owner:` or `pr:` line) or turn a one-line reply (FR-7) into two. With
 * `keepLineBreaks`, `\n`, `\r`, `\t` and U+2028/U+2029 stay. Invisible format
 * characters (U+200B and the rest of Cf) are removed in both modes, so none
 * can sit unseen inside a posted word or between `:` and `//`.
 *
 * It runs after the scrub, which looks through these characters itself.
 */
export function flattenLines(value, { keepLineBreaks = false } = {}) {
  const input = asText(value)
  const visible = input.replace(/\p{Cf}+/gu, "")
  const text = keepLineBreaks
    // eslint-disable-next-line no-control-regex
    ? visible.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/g, " ")
    // eslint-disable-next-line no-control-regex
    : visible.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
  return { text, changed: text !== input }
}

/**
 * The whole pipeline for one agent-written field. `maxChars` is the field's
 * length limit (`[slack].task_chars`, `summary_chars`); without one the field
 * is only scrubbed, flattened, escaped, and defanged. Control characters
 * become spaces and format characters are removed; `singleLine` also
 * flattens line breaks, and every card, reply, and board field uses it.
 */
export function prepareAgentText(value, { maxChars, singleLine = false } = {}) {
  let { text } = scrubSecrets(value)
  text = flattenLines(text, { keepLineBreaks: !singleLine }).text
  text = cutText(text, maxChars).text
  text = escapeSlackText(text).text
  text = defangUrls(text).text
  return text
}

/**
 * Cut a finished message to `MAX_MESSAGE_CHARS`. The message is already
 * escaped and defanged, so the cut never produces markup or a link; a trailing
 * partial entity such as `&am` is dropped so the message does not end in a
 * broken escape.
 */
export function capMessage(value, maxChars = MAX_MESSAGE_CHARS) {
  const input = asText(value)
  const chars = Array.from(input)
  if (chars.length <= maxChars) {
    return input
  }
  const text = chars.slice(0, Math.max(0, maxChars - 1)).join("").replace(/&[a-z]{0,3}$/, "")
  return `${text}${ELLIPSIS}`
}
