// Spec 023 FR-1, FR-4, FR-8: what btrain knows about each runner executable
// that runs one lab's models. Pure: no I/O, no import of core.mjs.
//
// One entry per executable basename. An executable with no entry (`agent`,
// `cursor-agent`, `npx`, `env`, a shell script) has no lab and no fresh-session
// flags: it gets a lab only from `[agents.labs]`.
//
// Signal patterns ship only with a captured sample under
// test/fixtures/runner-signals/ (implementation plan, "Runner table": no
// sample, no pattern). Each entry names its sample file so the test can check
// the pattern against it. `[review.signals.<executable>]` adds patterns for one
// repository without a release.

export const FAILURE_CLASSES = Object.freeze({
  TOOL_UNAVAILABLE: "tool_unavailable",
  POLICY_BLOCKED: "policy_blocked",
  FAILED: "failed",
})

// How many trailing output lines a pattern is matched against.
export const SIGNAL_TAIL_LINES = 50

function freeze(entry) {
  return Object.freeze({
    ...entry,
    probeArgs: Object.freeze([...entry.probeArgs]),
    freshSessionArgs: Object.freeze([...entry.freshSessionArgs]),
    rejectedFlags: Object.freeze([...entry.rejectedFlags]),
    rejectedFlagPrefixes: Object.freeze([...entry.rejectedFlagPrefixes]),
    rejectedSubcommands: Object.freeze([...entry.rejectedSubcommands]),
    signals: Object.freeze(entry.signals.map((signal) => Object.freeze({ ...signal }))),
  })
}

export const RUNNER_TABLE = Object.freeze({
  claude: freeze({
    lab: "anthropic",
    probeArgs: ["--version"],
    // Spec 017 FR-3: no persisted session in print mode.
    freshSessionArgs: ["--no-session-persistence"],
    freshSessionNeedsId: false,
    rejectedFlags: ["--resume", "-r", "--continue", "-c", "--fork-session", "--from-pr"],
    rejectedFlagPrefixes: [],
    rejectedSubcommands: [],
    signals: [
      {
        class: FAILURE_CLASSES.TOOL_UNAVAILABLE,
        kind: "authentication",
        pattern: /Not logged in\b.*\/login/i,
        sample: "claude-not-logged-in.txt",
      },
    ],
  }),
  codex: freeze({
    lab: "openai",
    probeArgs: ["--version"],
    freshSessionArgs: ["exec", "--ephemeral"],
    freshSessionNeedsId: false,
    rejectedFlags: [],
    rejectedFlagPrefixes: ["--session"],
    rejectedSubcommands: ["resume", "fork"],
    signals: [
      {
        class: FAILURE_CLASSES.TOOL_UNAVAILABLE,
        kind: "quota",
        // The CLI writes a curly apostrophe ("You’ve"); match the stable tail.
        pattern: /hit your usage limit|usage_limit_exceeded/i,
        sample: "codex-usage-limit.txt",
      },
    ],
  }),
  gemini: freeze({
    lab: "google",
    probeArgs: ["--version"],
    // A fresh `--session-id <id>` for each dispatch; the caller supplies the id.
    freshSessionArgs: ["--session-id"],
    freshSessionNeedsId: true,
    rejectedFlags: ["-r", "--resume"],
    rejectedFlagPrefixes: [],
    rejectedSubcommands: [],
    signals: [],
  }),
})

/**
 * Split a runner command line into words, honoring single and double quotes
 * and backslash escapes. Enough for the first word and flag scans; the loop
 * runner in core.mjs keeps its own tokenizer for execution.
 */
export function splitRunnerWords(value) {
  const words = []
  let current = ""
  let quote = ""
  let hasWord = false
  const text = typeof value === "string" ? value : ""
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote) {
        quote = ""
      } else if (char === "\\" && quote === "\"" && index + 1 < text.length) {
        index += 1
        current += text[index]
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      hasWord = true
      continue
    }
    if (char === "\\" && index + 1 < text.length) {
      index += 1
      current += text[index]
      hasWord = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasWord) {
        words.push(current)
        current = ""
        hasWord = false
      }
      continue
    }
    current += char
    hasWord = true
  }
  if (hasWord) {
    words.push(current)
  }
  return words
}

function basenameOf(command) {
  const parts = String(command || "").split(/[\\/]/)
  return parts[parts.length - 1] || ""
}

/**
 * The executable basename of a runner value: `"/opt/bin/codex exec"` is
 * `codex`. A `notify` runner and an empty value have none.
 */
export function runnerExecutable(runnerValue) {
  const words = splitRunnerWords(runnerValue)
  if (words.length === 0) {
    return ""
  }
  if (words.length === 1 && words[0].trim().toLowerCase() === "notify") {
    return ""
  }
  return basenameOf(words[0])
}

/** The table entry for an executable basename, or null. */
export function getRunnerEntry(executable) {
  const key = String(executable || "")
  return Object.hasOwn(RUNNER_TABLE, key) ? RUNNER_TABLE[key] : null
}

/** The lab of an executable that runs one lab's models only, or "". */
export function labOfExecutable(executable) {
  return getRunnerEntry(executable)?.lab || ""
}

/**
 * The fresh-session arguments for a same-lab dispatch (spec 017 FR-3), or null
 * when the table has no entry: such a runner is not dispatched at the
 * same-lab tier. `sessionId` is required for an executable whose entry needs
 * one (gemini).
 */
export function freshSessionArgs(executable, { sessionId = "" } = {}) {
  const entry = getRunnerEntry(executable)
  if (!entry) {
    return null
  }
  if (entry.freshSessionNeedsId) {
    if (!sessionId) {
      throw new Error(`A fresh ${executable} session needs a new session id.`)
    }
    return [...entry.freshSessionArgs, sessionId]
  }
  return [...entry.freshSessionArgs]
}

/**
 * The arguments that would resume or fork an earlier session, which a
 * same-lab attempt must not carry (spec 023 FR-8). Returns the offending
 * tokens, empty when there are none or the executable has no entry.
 */
export function findRejectedRunnerArgs(executable, args = []) {
  const entry = getRunnerEntry(executable)
  if (!entry) {
    return []
  }
  const found = []
  const list = Array.isArray(args) ? args.map(String) : []
  for (const token of list) {
    const flag = token.split("=")[0]
    if (entry.rejectedFlags.includes(flag)) {
      found.push(token)
      continue
    }
    if (entry.rejectedFlagPrefixes.some((prefix) => flag.startsWith(prefix))) {
      found.push(token)
    }
  }
  // A subcommand is the first word that is not a flag.
  const subcommand = list.find((token) => !token.startsWith("-"))
  if (subcommand && entry.rejectedSubcommands.includes(subcommand)) {
    found.push(subcommand)
  }
  return found
}

function tailText(tail) {
  const text = Array.isArray(tail) ? tail.join("\n") : String(tail ?? "")
  return text.split("\n").slice(-SIGNAL_TAIL_LINES).join("\n")
}

function normalizeExtraPatterns(list) {
  if (!Array.isArray(list)) {
    return []
  }
  return list.map((item) => String(item).trim()).filter(Boolean)
}

/**
 * Classify a runner's exit (implementation plan, request loop rule 4).
 *
 * A quota or authentication signal is `tool_unavailable`; a refusal signal is
 * `policy_blocked`; any other non-zero exit is `failed`. An exit 0 with no
 * signal has no failure class (`outcome: null`): whether it gave a verdict is
 * read from the lane, not from the exit.
 *
 * `extraSignals` is the `[review.signals.<executable>]` table: `unavailable`
 * and `refused` lists, matched as case-insensitive substrings.
 */
export function classifyExit({ executable = "", exitCode = 0, tail = "", extraSignals = {} } = {}) {
  const text = tailText(tail)
  const lowered = text.toLowerCase()
  const entry = getRunnerEntry(executable)

  const builtIn = entry ? entry.signals : []
  const ordered = [
    ...builtIn.filter((signal) => signal.class === FAILURE_CLASSES.TOOL_UNAVAILABLE),
    ...builtIn.filter((signal) => signal.class === FAILURE_CLASSES.POLICY_BLOCKED),
  ]
  for (const signal of ordered) {
    if (signal.pattern.test(text)) {
      return { outcome: signal.class, kind: signal.kind, source: "built-in", match: String(signal.pattern) }
    }
  }

  const extras = extraSignals && typeof extraSignals === "object" ? extraSignals : {}
  for (const [key, outcome] of [["unavailable", FAILURE_CLASSES.TOOL_UNAVAILABLE], ["refused", FAILURE_CLASSES.POLICY_BLOCKED]]) {
    for (const pattern of normalizeExtraPatterns(extras[key])) {
      if (lowered.includes(pattern.toLowerCase())) {
        return { outcome, kind: key, source: "config", match: pattern }
      }
    }
  }

  // A runner killed by a signal has a null exit code: that is not a clean exit.
  if (exitCode === 0 || exitCode === "0") {
    return { outcome: null, kind: "", source: "", match: "" }
  }
  return { outcome: FAILURE_CLASSES.FAILED, kind: "", source: "", match: "" }
}
