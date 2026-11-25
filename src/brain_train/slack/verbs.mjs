// Spec 025 FR-2, FR-3, FR-4, FR-8 and the plan's "Verb table": the six verbs a
// Slack command may name, as data. Pure. Imports nothing from core.mjs.
//
// Each verb lists its short arguments (on the `btrain>` line) and its fields
// (the `key: value` lines after it), in the order the canonical text uses;
// which keys are required; its approval rule; the lane-state pre-checks that
// slack/commands.mjs (WS5) runs; and the argument template of each `btrain`
// child it starts. A template is a list of literal words and named values,
// never a string for a shell: every value becomes exactly one argument.
//
// The FR-4 list names what can never be requested from Slack. No verb exists
// for any of it and no template holds one of its words.

import path from "node:path"

/** Command words of FR-4: never a verb, never in a template. */
export const FR4_FORBIDDEN = Object.freeze([
  "merge", "resolve", "request-changes", "fix", "confirm-fix", "override",
  "locks", "doctor", "features", "init", "agents",
])

export const APPROVAL = Object.freeze({
  // Runs at once when typed; from a proposal, runs at once only when the verb
  // is on the repository's `[slack.orchestrator].auto` list.
  AUTO_LIST: "auto-list",
  // Always waits for the operator's typed `approve` when it is a proposal.
  REQUIRED: "required",
  // Only the operator's typed command; a proposal for it is rejected.
  TYPED_ONLY: "typed-only",
})

/** The default `[slack.orchestrator].auto` list (spec 025 FR-3). */
export const DEFAULT_AUTO = Object.freeze(["status", "flush", "poll-pr", "retry-review"])

// A named value in a template; `flag` set means "--flag value", left out when
// the value is empty and `optional` is true.
const value = (name) => Object.freeze({ value: name })
const flag = (flagName, name, { optional = false } = {}) => Object.freeze({ flag: flagName, value: name, optional })

function verb(definition) {
  return Object.freeze({
    args: Object.freeze(["repo", ...(definition.args || [])]),
    fields: Object.freeze(definition.fields || []),
    required: Object.freeze(definition.required || []),
    approval: definition.approval,
    preChecks: Object.freeze(definition.preChecks || []),
    children: Object.freeze((definition.children || []).map((child) => Object.freeze({
      detached: Boolean(child.detached),
      template: Object.freeze([...child.template]),
    }))),
  })
}

export const VERBS = Object.freeze({
  status: verb({
    approval: APPROVAL.AUTO_LIST,
    children: [{ template: ["slack", "refresh"] }],
  }),
  flush: verb({
    approval: APPROVAL.AUTO_LIST,
    children: [{ template: ["slack", "flush"] }],
  }),
  "poll-pr": verb({
    args: ["lane"],
    required: ["lane"],
    approval: APPROVAL.AUTO_LIST,
    // FR-3: a PR number alone is not enough.
    preChecks: [
      { feature: "pr_flow" },
      { statuses: ["pr-review", "ready-to-merge"], orChangesRequestedEnteredByPrPoll: true },
    ],
    children: [{ template: ["pr", "poll", flag("--lane", "lane"), "--apply"] }],
  }),
  "retry-review": verb({
    args: ["lane"],
    required: ["lane"],
    approval: APPROVAL.AUTO_LIST,
    preChecks: [{ feature: "loop" }, { statuses: ["needs-review"] }, { limit: "max_active" }],
    children: [{
      detached: true,
      template: ["loop", flag("--lane", "lane"), "--max-rounds", "1", "--expect-status", "needs-review"],
    }],
  }),
  start: verb({
    args: ["owner"],
    fields: ["task", "files", "reviewer", "objective", "deliverable", "acceptance", "done-when"],
    required: ["owner", "task", "files"],
    approval: APPROVAL.REQUIRED,
    preChecks: [{ feature: "loop" }, { limit: "max_active" }, { freeLane: true }],
    children: [
      {
        template: [
          "handoff", "claim",
          flag("--lane", "lane", { optional: true }),
          flag("--owner", "owner"),
          flag("--task", "task"),
          flag("--files", "files"),
          flag("--reviewer", "reviewer", { optional: true }),
          flag("--objective", "objective", { optional: true }),
          flag("--deliverable", "deliverable", { optional: true }),
          flag("--acceptance", "acceptance", { optional: true }),
          flag("--done-when", "done-when", { optional: true }),
          flag("--requested-via", "requested-via"),
        ],
      },
      {
        detached: true,
        template: ["loop", flag("--lane", "lane", { optional: true }), "--max-rounds", value("max-rounds")],
      },
    ],
  }),
  pause: verb({
    approval: APPROVAL.TYPED_ONLY,
    children: [],
  }),
})

export const VERB_NAMES = Object.freeze(Object.keys(VERBS))

/** Every literal word of every child template, for the FR-4 test. */
export function templateWords() {
  const words = []
  for (const definition of Object.values(VERBS)) {
    for (const child of definition.children) {
      for (const item of child.template) {
        if (typeof item === "string") words.push(item)
        else if (item.flag) words.push(item.flag)
      }
    }
  }
  return words
}

const TEXT_LIMITS = Object.freeze({
  task: 2000,
  objective: 500,
  deliverable: 500,
  acceptance: 500,
  "done-when": 500,
})
const MAX_FILES = 50
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * The checks that apply to every value (plan, "Command grammar"): not empty,
 * one line, no control character, and not starting with `-`, because the
 * btrain CLI reads any argument that starts with `--` as a flag. Returns the
 * reason, or "".
 */
export function checkAnyValue(key, raw) {
  const text = typeof raw === "string" ? raw : ""
  if (text.trim() === "") return `${key} is empty`
  if (CONTROL_CHAR.test(text)) return `${key} holds a line break or a control character`
  if (text.startsWith("-")) return `${key} may not start with "-"`
  return ""
}

function checkFiles(raw, repoPath) {
  const entries = raw.split(",").map((item) => item.trim())
  if (entries.length === 0 || entries.some((item) => item === "")) return "files needs a comma list of paths with no empty entry"
  if (entries.length > MAX_FILES) return `files names more than ${MAX_FILES} paths`
  for (const entry of entries) {
    if (entry.includes("\\")) return `files: ${entry} holds a backslash`
    if (entry.startsWith("/") || entry.startsWith("~")) return `files: ${entry} is not a relative path`
    if (entry.split("/").includes("..")) return `files: ${entry} holds a ".." segment`
    if (entry.startsWith("-")) return `files: ${entry} may not start with "-"`
    const base = repoPath || "/repo"
    const resolved = path.posix.resolve(base, entry)
    if (resolved !== base && !resolved.startsWith(`${base.replace(/\/+$/, "")}/`)) return `files: ${entry} is outside the repository`
  }
  return ""
}

/**
 * Check one value against its key's rule. `context` holds what the check
 * needs about the repository the command applies to: `laneIds` (its lane
 * IDs), `agents` (its active agents whose runner is set and is not `notify`),
 * and `repoPath`. The `repo` key is resolved by `resolveRepo`, not here.
 * Returns the reason, or "".
 */
export function checkValue(key, raw, context = {}) {
  const generic = checkAnyValue(key, raw)
  if (generic) return generic
  const text = raw.trim()
  if (Object.hasOwn(TEXT_LIMITS, key)) {
    return Array.from(text).length > TEXT_LIMITS[key] ? `${key} is longer than ${TEXT_LIMITS[key]} characters` : ""
  }
  switch (key) {
    case "lane": {
      const lanes = Array.isArray(context.laneIds) ? context.laneIds.map(String) : []
      return lanes.includes(text) ? "" : `lane ${text} is not a lane of this repository`
    }
    case "owner":
    case "reviewer": {
      const agents = Array.isArray(context.agents) ? context.agents.map(String) : []
      return agents.includes(text) ? "" : `${key} ${text} is not an active agent with a runner in this repository`
    }
    case "files":
      return checkFiles(text, context.repoPath)
    case "repo":
      return ""
    default:
      return `unknown key ${key}`
  }
}

/**
 * Pick the repository a command applies to (FR-2). `repos` are the served
 * repositories of the message's channel, each `{ name, path }`. With one
 * repository, `repo=` may be left out. With more, it is required and must
 * name exactly one of them, by name when only one has that name, else by its
 * registered path. Returns `{ repo, reason }`.
 */
export function resolveRepo(requested, repos = []) {
  const list = Array.isArray(repos) ? repos : []
  if (list.length === 0) return { repo: null, reason: "this channel serves no repository" }
  if (requested === undefined || requested === null || requested === "") {
    return list.length === 1
      ? { repo: list[0], reason: "" }
      : { repo: null, reason: "this channel serves more than one repository; add repo=<name or path>" }
  }
  const byPath = list.find((item) => item.path === requested)
  if (byPath) return { repo: byPath, reason: "" }
  const byName = list.filter((item) => item.name === requested)
  if (byName.length === 1) return { repo: byName[0], reason: "" }
  if (byName.length > 1) return { repo: null, reason: `more than one repository here is named ${requested}; use its registered path` }
  return { repo: null, reason: `${requested} is not a repository served in this channel` }
}

/**
 * The `auto` list of a repository with `start` and `pause` refused and unknown
 * verbs dropped. Returns `{ auto, errors }`; each error is a `btrain doctor`
 * finding.
 */
export function normalizeAutoList(list) {
  if (list === undefined || list === null) return { auto: [...DEFAULT_AUTO], errors: [] }
  if (!Array.isArray(list)) return { auto: [...DEFAULT_AUTO], errors: ["[slack.orchestrator].auto must be a list of verbs; using the default"] }
  const auto = []
  const errors = []
  for (const item of list.map(String)) {
    if (!Object.hasOwn(VERBS, item)) {
      errors.push(`[slack.orchestrator].auto names an unknown verb: ${item}`)
    } else if (VERBS[item].approval !== APPROVAL.AUTO_LIST) {
      errors.push(`[slack.orchestrator].auto may not hold ${item}: it always needs the operator`)
    } else if (!auto.includes(item)) {
      auto.push(item)
    }
  }
  return { auto, errors }
}

/**
 * Whether a proposal for this verb may run without approval in a repository
 * whose `auto` list is `auto`.
 */
export function runsWithoutApproval(verbName, auto = DEFAULT_AUTO) {
  const definition = VERBS[verbName]
  if (!definition || definition.approval !== APPROVAL.AUTO_LIST) return false
  return normalizeAutoList(auto).auto.includes(verbName)
}

/**
 * The argument lists of the children a verb starts, from checked values.
 * `values` holds the command's keys plus what the listener supplies: `lane`
 * (picked for `start`), `requested-via`, and `max-rounds`. Returns one
 * `{ argv, detached }` for each child, `argv` without the node and CLI path.
 * Throws when a value fails `checkAnyValue`, so a template can never be
 * filled with an argument that starts with `-`.
 */
export function buildChildArgs(verbName, values = {}) {
  const definition = VERBS[verbName]
  if (!definition) throw new Error(`unknown verb ${verbName}`)
  return definition.children.map((child) => {
    const argv = []
    for (const item of child.template) {
      if (typeof item === "string") {
        argv.push(item)
        continue
      }
      const raw = values[item.value]
      const present = raw !== undefined && raw !== null && String(raw) !== ""
      if (!present) {
        if (item.optional) continue
        throw new Error(`${verbName}: ${item.value} is required`)
      }
      const text = String(raw)
      const reason = checkAnyValue(item.value, text)
      if (reason) throw new Error(`${verbName}: ${reason}`)
      if (item.flag) argv.push(item.flag)
      argv.push(text)
    }
    return { argv, detached: child.detached }
  })
}
