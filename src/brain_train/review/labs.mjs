// Spec 023 FR-1, FR-2, FR-3: the lab of each agent, the labs of a lane's
// authors, the tier of a reviewer candidate, and the candidates in order.
// Pure: reads only the parsed project config it is given. No import of
// core.mjs.
//
// FR-1 order: an `[agents.labs]` entry, else the lab of the runner's
// executable basename from the runner table, else none. The agent name is
// never read to infer a lab: an agent called `claude-gpt` with a `codex`
// runner is `openai`.

import { stripTomlComment } from "./review-config.mjs"
import { labOfExecutable, runnerExecutable } from "./runner-table.mjs"

// A lab is a lowercase label (spec 023 "Terms"), such as `openai`.
const LAB_LABEL = /^[a-z0-9][a-z0-9_-]*$/

export const TIERS = Object.freeze({
  OTHER_LAB: "other-lab",
  SAME_LAB: "same-lab",
})

const ANY_OTHER = "any-other"

function normalizeName(value) {
  return typeof value === "string" ? value.trim() : ""
}

function keyOf(value) {
  return normalizeName(value).toLowerCase()
}

function isAnyOther(value) {
  return keyOf(value).replaceAll(/[\s_]+/g, "-") === ANY_OTHER
}

function tableOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

// Exact key first, then a case-insensitive match, the way core.mjs reads
// `[agents.runners]`.
function lookupByAgent(table, agent) {
  const name = normalizeName(agent)
  if (!name) {
    return undefined
  }
  if (Object.hasOwn(table, name)) {
    return table[name]
  }
  const key = name.toLowerCase()
  const match = Object.keys(table).find((candidate) => normalizeName(candidate).toLowerCase() === key)
  return match === undefined ? undefined : table[match]
}

/** The raw `[agents.runners]` value for an agent, or "". */
export function runnerValueOf(config, agent) {
  const value = lookupByAgent(tableOf(config?.agents?.runners), agent)
  return typeof value === "string" ? value.trim() : ""
}

/**
 * `cli` for a configured command, `notify` for a `notify` runner or none at
 * all (the loop falls back to notification mode for a missing runner).
 */
export function runnerKindOf(config, agent) {
  const value = runnerValueOf(config, agent)
  if (!value || value.toLowerCase() === "notify") {
    return "notify"
  }
  return "cli"
}

/**
 * The lab of an agent and where it came from: `{ lab, source, executable }`.
 * `source` is `agents.labs`, `runner`, or "" when the agent has no lab. An
 * `[agents.labs]` value that is not a lowercase label adds `invalid`.
 */
export function explainAgentLab(config, agent) {
  const declared = stripTomlComment(lookupByAgent(tableOf(config?.agents?.labs), agent))
  let invalid
  if (typeof declared === "string" && declared.trim()) {
    const lab = declared.trim().toLowerCase()
    if (LAB_LABEL.test(lab)) {
      return { lab, source: "agents.labs", executable: runnerExecutable(runnerValueOf(config, agent)) }
    }
    // A value that is not a label (a typo, or text the TOML parser kept) is
    // never used as a lab: it could make a same-lab agent look other-lab. The
    // runner's lab still applies, which is never less safe, and `invalid`
    // carries the value for a doctor warning.
    invalid = declared
  }
  const extra = invalid === undefined ? {} : { invalid }
  const runnerValue = runnerValueOf(config, agent)
  if (!runnerValue || runnerKindOf(config, agent) === "notify") {
    return { lab: "", source: "", executable: "", ...extra }
  }
  const executable = runnerExecutable(runnerValue)
  const lab = labOfExecutable(executable)
  return { lab, source: lab ? "runner" : "", executable, ...extra }
}

/** The lab of an agent, or "" when it has none (FR-1). */
export function resolveAgentLab(config, agent) {
  return explainAgentLab(config, agent).lab
}

/**
 * The configured agents in configured order: `[agents].active`, else the
 * writer and reviewer defaults, else the runner keys. This mirrors
 * `getConfiguredAgentNames` in core.mjs, which this module cannot import.
 */
export function listConfiguredAgents(config) {
  const names = []
  const seen = new Set()
  const add = (value) => {
    const name = normalizeName(value)
    if (!name || isAnyOther(name) || seen.has(name.toLowerCase())) {
      return
    }
    seen.add(name.toLowerCase())
    names.push(name)
  }
  const active = config?.agents?.active
  const activeList = Array.isArray(active) ? active : typeof active === "string" ? active.split(",") : []
  for (const name of activeList) add(name)
  add(config?.agents?.writer_default)
  add(config?.agents?.reviewer_default)
  if (names.length === 0) {
    for (const name of Object.keys(tableOf(config?.agents?.runners))) add(name)
  }
  return names
}

function toNameList(authors) {
  if (!authors) {
    return []
  }
  const list = authors instanceof Set ? [...authors] : Array.isArray(authors) ? authors : [authors]
  return list.map(normalizeName).filter(Boolean)
}

/**
 * The author set of a commit range, as labs (spec 023 Terms). Authors with no
 * lab add nothing to `labs` and are listed in `unlabeled`.
 */
export function authorLabs(authors, config) {
  const labs = []
  const unlabeled = []
  for (const author of toNameList(authors)) {
    const lab = resolveAgentLab(config, author)
    if (!lab) {
      if (!unlabeled.some((name) => keyOf(name) === keyOf(author))) unlabeled.push(author)
      continue
    }
    if (!labs.includes(lab)) labs.push(lab)
  }
  return { labs, unlabeled }
}

function labsFrom(authorLabSet) {
  if (!authorLabSet) return []
  if (Array.isArray(authorLabSet)) return authorLabSet
  if (authorLabSet instanceof Set) return [...authorLabSet]
  if (Array.isArray(authorLabSet.labs)) return authorLabSet.labs
  return []
}

/**
 * `other-lab` when the candidate has a known lab outside the author labs,
 * else `same-lab`. An agent with no lab is `same-lab`: btrain cannot show it
 * is from another lab (FR-3).
 */
export function tierOf(candidate, { config, authorLabs: authorLabSet } = {}) {
  const lab = resolveAgentLab(config, candidate)
  if (!lab) {
    return TIERS.SAME_LAB
  }
  return labsFrom(authorLabSet).includes(lab) ? TIERS.SAME_LAB : TIERS.OTHER_LAB
}

/**
 * Reviewer candidates for a lane, in the FR-2 order.
 *
 * `otherLab`: agents with a known lab outside the author labs and a `cli`
 * runner, in `[review].reviewer_order`, then `[agents].reviewer_default` when
 * it qualifies, then configured order.
 * `sameLab`: the other agents with a `cli` runner that are not in the author
 * history, in configured order.
 *
 * Neither list holds an author or the owner. `unknownReviewerOrder` lists
 * names in `reviewer_order` that are not configured agents (a doctor warning).
 */
export function orderCandidates(config, { owner = "", authorHistory = [], configuredAgents } = {}) {
  const agents = Array.isArray(configuredAgents) ? configuredAgents.map(normalizeName).filter(Boolean) : listConfiguredAgents(config)
  const authors = toNameList(authorHistory)
  if (normalizeName(owner)) authors.push(normalizeName(owner))
  const authorKeys = new Set(authors.map(keyOf))
  const { labs } = authorLabs(authors, config)

  const canonical = (name) => agents.find((agent) => keyOf(agent) === keyOf(name)) || ""
  const eligible = (name) => name && !authorKeys.has(keyOf(name)) && runnerKindOf(config, name) === "cli"
  const isOtherLab = (name) => tierOf(name, { config, authorLabs: labs }) === TIERS.OTHER_LAB

  const reviewerOrderRaw = stripTomlComment(config?.review?.reviewer_order)
  const reviewerOrder = Array.isArray(reviewerOrderRaw) ? reviewerOrderRaw.map(normalizeName).filter(Boolean) : []
  const unknownReviewerOrder = reviewerOrder.filter((name) => !canonical(name))

  const otherLab = []
  const addOther = (name) => {
    const agent = canonical(name)
    if (eligible(agent) && isOtherLab(agent) && !otherLab.includes(agent)) otherLab.push(agent)
  }
  for (const name of reviewerOrder) addOther(name)
  addOther(config?.agents?.reviewer_default)
  for (const name of agents) addOther(name)

  const sameLab = agents.filter((agent) => eligible(agent) && !isOtherLab(agent))

  return { otherLab, sameLab, authorLabs: labs, unknownReviewerOrder }
}
