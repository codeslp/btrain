// Spec 023 "Configuration": the `[review]`, `[review.fixes]`, and
// `[review.signals.<executable>]` tables, and `[pr_flow].bot_pending_timeout`.
// Pure: reads only the parsed project config it is given. No import of
// core.mjs.
//
// A key that is missing takes its default. A value that does not parse also
// takes its default and is returned in `errors`, which `btrain doctor`
// reports as an error. The lane keeps working on the default.
//
// The project TOML parser in core.mjs returns an unquoted number as a string,
// so integers are parsed here from either form.

export const REVIEW_DEFAULTS = Object.freeze({
  otherLabWindow: "15m",
  silenceLimit: "5m",
  attemptMax: "45m",
  botPendingTimeout: "30m",
  fixes: Object.freeze({
    enabled: true,
    maxFiles: 3,
    maxChangedLines: 60,
    maxRounds: 2,
  }),
})

const UNIT_MS = Object.freeze({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 })

/**
 * Parse a duration such as `15m`, `30s`, `1h`, `1h30m`, or `500ms` to
 * milliseconds. Returns null for anything else, including a bare number
 * (the unit would be a guess) and zero.
 */
export function parseDuration(value) {
  if (typeof value !== "string") {
    return null
  }
  const text = value.trim().toLowerCase()
  if (!text || !/^(\d+(ms|s|m|h))+$/.test(text)) {
    return null
  }
  let total = 0
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|s|m|h)/g)) {
    total += Number(amount) * UNIT_MS[unit]
  }
  return total > 0 && Number.isSafeInteger(total) ? total : null
}

function tableOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

/**
 * The value a TOML line meant when it ended in a comment. The project parser
 * in core.mjs does not strip `# ...` after a value, so `x = "15m"  # note`
 * reaches this module as the text `"15m"  # note`, and `x = []  # note` as
 * `[]  # note`. This returns the quoted string or the list of quoted strings;
 * any other value is returned unchanged.
 */
export function stripTomlComment(value) {
  if (typeof value !== "string") {
    return value
  }
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*#.*$/.exec(value)
  if (quoted) {
    return quoted[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
  }
  const list = /^\[(.*)\]\s*#.*$/.exec(value)
  if (list) {
    const body = list[1].trim()
    if (!body) return []
    const items = body.split(",").map((item) => item.trim()).filter(Boolean)
    if (items.every((item) => /^"(?:[^"\\]|\\.)*"$/.test(item))) {
      return items.map((item) => item.slice(1, -1))
    }
  }
  return value
}

function cleanTable(table) {
  const clean = {}
  for (const [key, value] of Object.entries(table)) clean[key] = stripTomlComment(value)
  return clean
}

function readDuration(table, key, fallback, section, errors) {
  if (!Object.hasOwn(table, key)) {
    return parseDuration(fallback)
  }
  const parsed = parseDuration(table[key])
  if (parsed === null) {
    errors.push({
      key: `${section}.${key}`,
      value: table[key],
      message: `[${section}].${key} = ${JSON.stringify(table[key])} is not a duration such as "15m", "30s", or "1h"; using the default ${fallback}.`,
    })
    return parseDuration(fallback)
  }
  return parsed
}

function readPositiveInteger(table, key, fallback, section, errors) {
  if (!Object.hasOwn(table, key)) {
    return fallback
  }
  const raw = table[key]
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : ""
  const limit = Number(/^(\d+)(?:\s*#.*)?$/.exec(text)?.[1])
  if (Number.isSafeInteger(limit) && limit > 0) {
    return limit
  }
  errors.push({
    key: `${section}.${key}`,
    value: raw,
    message: `[${section}].${key} = ${JSON.stringify(raw)} is not a positive whole number; using the default ${fallback}.`,
  })
  return fallback
}

function readBoolean(table, key, fallback, section, errors) {
  if (!Object.hasOwn(table, key)) {
    return fallback
  }
  const raw = table[key]
  if (raw === true || raw === false) {
    return raw
  }
  if (typeof raw === "string") {
    const flag = /^(true|false)\s*#.*$/.exec(raw.trim())
    if (flag) return flag[1] === "true"
  }
  errors.push({
    key: `${section}.${key}`,
    value: raw,
    message: `[${section}].${key} = ${JSON.stringify(raw)} is not true or false; using the default ${fallback}.`,
  })
  return fallback
}

function readNameList(table, key, section, errors) {
  if (!Object.hasOwn(table, key)) {
    return []
  }
  const raw = table[key]
  if (!Array.isArray(raw)) {
    errors.push({
      key: `${section}.${key}`,
      value: raw,
      message: `[${section}].${key} must be a list of agent names; ignoring it.`,
    })
    return []
  }
  return raw.map((item) => String(item).trim()).filter(Boolean)
}

function readSignals(reviewTable, errors) {
  const signals = {}
  for (const [executable, value] of Object.entries(tableOf(reviewTable.signals))) {
    const table = cleanTable(tableOf(value))
    const entry = { unavailable: [], refused: [] }
    for (const key of Object.keys(entry)) {
      entry[key] = readNameList(table, key, `review.signals.${executable}`, errors)
    }
    signals[executable] = entry
  }
  return signals
}

/**
 * The review policy for one repository, with defaults applied.
 *
 * Durations are in milliseconds. `errors` lists every value that did not
 * parse; each one fell back to its default.
 */
export function getReviewPolicy(config) {
  const errors = []
  const rawReview = tableOf(config?.review)
  const review = { ...cleanTable(rawReview), signals: rawReview.signals }
  const fixes = cleanTable(tableOf(rawReview.fixes))
  const prFlow = cleanTable(tableOf(config?.pr_flow))

  return {
    otherLabWindowMs: readDuration(review, "other_lab_window", REVIEW_DEFAULTS.otherLabWindow, "review", errors),
    silenceLimitMs: readDuration(review, "silence_limit", REVIEW_DEFAULTS.silenceLimit, "review", errors),
    attemptMaxMs: readDuration(review, "attempt_max", REVIEW_DEFAULTS.attemptMax, "review", errors),
    reviewerOrder: readNameList(review, "reviewer_order", "review", errors),
    fixes: {
      enabled: readBoolean(fixes, "enabled", REVIEW_DEFAULTS.fixes.enabled, "review.fixes", errors),
      maxFiles: readPositiveInteger(fixes, "max_files", REVIEW_DEFAULTS.fixes.maxFiles, "review.fixes", errors),
      maxChangedLines: readPositiveInteger(fixes, "max_changed_lines", REVIEW_DEFAULTS.fixes.maxChangedLines, "review.fixes", errors),
      maxRounds: readPositiveInteger(fixes, "max_rounds", REVIEW_DEFAULTS.fixes.maxRounds, "review.fixes", errors),
    },
    signals: readSignals(review, errors),
    botPendingTimeoutMs: readDuration(prFlow, "bot_pending_timeout", REVIEW_DEFAULTS.botPendingTimeout, "pr_flow", errors),
    errors,
  }
}
