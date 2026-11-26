// Spec 025 T015: the readers the `slack` block in cli.mjs hands to
// slack/cli.mjs, for the listener. slack/ never imports core.mjs, so these
// wrap the core functions it needs. A module of its own, not inline in
// cli.mjs, so tests can call the same functions the CLI passes.

import fs from "node:fs/promises"
import path from "node:path"
import {
  checkHandoff,
  findAvailableLane,
  getLaneConfigs,
  listRepos,
  parseCurrentSection,
  readAllLaneStates,
  readProjectConfig,
  readWorkflowEvents,
} from "./core.mjs"
import { claimKeyOf } from "./slack/events.mjs"
import { enteredByPrPoll } from "./slack/pr-poll.mjs"
import { resolveStateRoot } from "./worktree.mjs"

/**
 * Whether the lane (or, with no lane id, the single handoff of a repository
 * without lanes) is a `changes-requested` lane that `btrain pr poll` entered.
 * Reads only that lane's handoff file and its own event log, never another
 * lane's. An unknown lane, or one whose handoff file is missing, is false.
 */
export async function readEnteredByPrPoll(repoRoot, laneId = "") {
  const config = await readProjectConfig(repoRoot)
  let lane = null
  if (laneId) {
    const laneConfig = (getLaneConfigs(config) || []).find((entry) => entry.id === laneId)
    if (!laneConfig) return false
    const handoffPath = path.isAbsolute(laneConfig.handoffPath)
      ? laneConfig.handoffPath
      : path.resolve(resolveStateRoot(repoRoot), laneConfig.handoffPath)
    try {
      lane = parseCurrentSection(await fs.readFile(handoffPath, "utf8"))
    } catch (error) {
      if (error?.code === "ENOENT") return false
      throw error
    }
  } else {
    lane = (await checkHandoff(repoRoot)).current
  }
  return enteredByPrPoll(await readWorkflowEvents(repoRoot, config, laneId), lane)
}

/**
 * Spec 024 WS4: current lane states for delivery, each with its `laneId` and
 * the `claimKey` of its current task, read from the lane's own event log
 * (FR-5). A repository with lanes turned off has one state, the single
 * handoff, with the lane id "".
 */
export async function readLaneStates(repoRoot) {
  const config = await readProjectConfig(repoRoot)
  const lanes = await readAllLaneStates(repoRoot, config)
  const states = lanes
    ? lanes.map((lane) => ({ ...lane, laneId: lane._laneId }))
    : [{ ...(await checkHandoff(repoRoot)).current, laneId: "" }]
  return Promise.all(states.map(async (lane) => ({
    ...lane,
    claimKey: claimKeyOf(await readWorkflowEvents(repoRoot, config, lane.laneId)),
  })))
}

/** The readers object of the `slack` block, beyond the repository fields. */
export function buildSlackReaders({ cliPath }) {
  return {
    listRepos,
    findAvailableLane,
    readConfig: readProjectConfig,
    readLanes: readLaneStates,
    enteredByPrPoll: readEnteredByPrPoll,
    cliPath,
  }
}
