// Spec 023 FR-1, FR-3, FR-4, FR-8 and the plan's CLI contract (part of task
// T007): what `btrain doctor` reports about reviewer labs and the review
// configuration. Pure: reads only the parsed project config it is given.
// Appending these findings in `doctorRepo` (core.mjs) is the rest of T007.
//
// A missing lab is a warning, never an error: existing repositories keep
// working and `btrain doctor` keeps its exit code for it. A review setting
// that does not parse is an error; the default applies meanwhile.

import { explainAgentLab, listConfiguredAgents, orderCandidates, runnerKindOf } from "./labs.mjs"
import { getReviewPolicy } from "./review-config.mjs"
import { getRunnerEntry } from "./runner-table.mjs"

/**
 * Returns `{ labs, warnings, errors }`:
 *   labs      one line per configured agent with its resolved lab and source
 *   warnings  an agent with no lab; an invalid [agents.labs] value; an owner
 *             with no other-lab agent that has a cli runner; an unknown name
 *             in [review].reviewer_order; a cli runner the same-lab tier
 *             cannot start in a fresh session
 *   errors    review settings that did not parse
 */
export function collectReviewDoctorFindings(config, { configuredAgents } = {}) {
  const agents = Array.isArray(configuredAgents) ? configuredAgents : listConfiguredAgents(config)
  const labs = []
  const warnings = []

  for (const agent of agents) {
    const explained = explainAgentLab(config, agent)
    const kind = runnerKindOf(config, agent)
    if (explained.lab) {
      labs.push(`${agent}: ${explained.lab} (from ${explained.source === "agents.labs" ? "[agents.labs]" : `the ${explained.executable} runner`})`)
    } else {
      labs.push(`${agent}: no lab`)
      warnings.push(
        `Agent "${agent}" has no lab, so it is never an other-lab reviewer. Name its lab in [agents.labs] (for example "${agent}" = "openai").`,
      )
    }
    if (explained.invalid !== undefined) {
      warnings.push(
        `[agents.labs] "${agent}" = ${JSON.stringify(explained.invalid)} is not a lowercase lab name such as "anthropic"; it is ignored.`,
      )
    }
    if (kind === "cli" && explained.executable && !getRunnerEntry(explained.executable)) {
      warnings.push(
        `Agent "${agent}" runs "${explained.executable}", which has no fresh-session entry in the runner table, so it is never dispatched as a same-lab reviewer.`,
      )
    }
  }

  // FR-4: with no other-lab agent that has a cli runner, the same-lab tier
  // applies at once for that owner. One warning per owner that can write.
  for (const owner of agents.filter((agent) => runnerKindOf(config, agent) === "cli")) {
    const { otherLab } = orderCandidates(config, { owner, configuredAgents: agents })
    if (otherLab.length === 0) {
      warnings.push(
        `No other-lab agent with a cli runner can review "${owner}"'s lanes, so they are reviewed by the same lab (reason no-other-lab-configured).`,
      )
    }
  }

  const { unknownReviewerOrder } = orderCandidates(config, { owner: "", configuredAgents: agents })
  for (const name of unknownReviewerOrder) {
    warnings.push(`[review].reviewer_order names "${name}", which is not a configured agent.`)
  }

  const errors = getReviewPolicy(config).errors.map((error) => error.message)
  return { labs, warnings, errors }
}
