// Spec 024 WS4: where one repository's Slack state lives and where it is
// delivered, shared by the lane-command wiring (index.mjs), `btrain slack
// flush` and `refresh` (cli.mjs), and `btrain doctor` (doctor.mjs). Nothing
// here imports core.mjs.

import path from "node:path"
import { resolveStateRoot } from "../worktree.mjs"
import { channelForRepo, developerLabel, getSlackOptions, mentionList } from "./config.mjs"
import { btrainHome, loadSlackCredentials } from "./credentials.mjs"
import { deliver } from "./deliver.mjs"
import { readClaimKey } from "./threads.mjs"

/** The repository's Slack state directory, in the state root a linked worktree shares. */
export function slackDirFor(repoRoot) {
  return path.join(resolveStateRoot(repoRoot), ".btrain", "slack")
}

/**
 * Everything delivery needs for one repository: the state directory, the
 * token (or why there is none), the channel the registered path maps to, the
 * inline budget, and the render context. Reads ~/.btrain/slack.json; never
 * returns the file's other secrets.
 */
export async function deliveryTarget(repoRoot, config, { env = process.env } = {}) {
  const stateRoot = resolveStateRoot(repoRoot)
  const credentials = await loadSlackCredentials({ env })
  const options = getSlackOptions(config)
  return {
    stateRoot,
    slackDir: path.join(stateRoot, ".btrain", "slack"),
    homeDir: btrainHome(env),
    token: credentials.token || "",
    tokenReason: credentials.reason || "",
    channel: channelForRepo(credentials.settings, stateRoot).channel,
    inlineTimeoutMs: options.inlineTimeoutMs,
    context: {
      label: developerLabel(credentials.settings),
      mention: mentionList(credentials.settings),
      repoName: path.basename(stateRoot),
      taskChars: options.taskChars,
    },
  }
}

/**
 * Wrap a reader of current lane states so each state carries `laneId` and the
 * claim key of the lane's current task, which delivery compares with an
 * entry's claim key (FR-5).
 */
export function withClaimKeys(readLanes, slackDir) {
  return async () => {
    const lanes = (await readLanes()) || []
    return Promise.all(lanes.map(async (lane) => {
      const laneId = String(lane?.laneId ?? lane?._laneId ?? lane?.lane ?? "")
      return { ...lane, laneId, claimKey: await readClaimKey(slackDir, laneId) }
    }))
  }
}

/**
 * Drain the target's outbox (deliver.mjs). `readLanes` reads the repository's
 * current lane states; `budgetMs` (default none), `refresh`, `fetchImpl`, and
 * `now` pass through.
 */
export function deliverToTarget(target, { readLanes, fetchImpl = globalThis.fetch, budgetMs, refresh = false, now } = {}) {
  return deliver({
    slackDir: target.slackDir,
    repo: { path: target.stateRoot, name: target.context.repoName },
    channel: target.channel,
    token: target.token,
    fetchImpl,
    readLanes: withClaimKeys(readLanes, target.slackDir),
    context: target.context,
    homeDir: target.homeDir,
    refresh,
    ...(budgetMs === undefined ? {} : { budgetMs }),
    ...(now ? { now } : {}),
  })
}
