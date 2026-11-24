// Spec 024 FR-8: every agent-written field goes through one pipeline before it
// is queued or posted. Pure. Imports nothing from core.mjs (plan, "Plan
// decision"); the secret list is review/secret-patterns.mjs, the list
// `btrain review code` uses.
//
// Order (plan, "Text pipeline"):
//   1. scrub: every secret match becomes `[redacted]`;
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

/**
 * Step 1. Replace every secret match with `[redacted]`, also a secret glued to
 * the word before it.
 */
export function scrubSecrets(value) {
  const input = asText(value)
  let text = input
  for (const regex of globalSecretRegexes({ boundaries: false })) {
    text = text.replace(regex, REDACTED)
  }
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
 * The whole pipeline for one agent-written field. `maxChars` is the field's
 * length limit (`[slack].task_chars`, `summary_chars`); without one the field
 * is only scrubbed, escaped, and defanged.
 */
export function prepareAgentText(value, { maxChars } = {}) {
  let { text } = scrubSecrets(value)
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
