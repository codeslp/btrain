import fs from "node:fs/promises"
import path from "node:path"
import { getRepoPaths } from "./core.mjs"
import { isFeatureEnabled } from "./repo_mode.mjs"

const PR_STATUSES = new Set(["ready-for-pr", "pr-review", "ready-to-merge"])
const WITHDRAWAL_EVENTS = new Set(["claim", "request-changes", "watchdog-repair"])

function laneEventLogPath(repoRoot, laneId = "") {
  const { eventsDir } = getRepoPaths(repoRoot)
  return path.join(eventsDir, laneId ? `lane-${laneId}.jsonl` : "repo.jsonl")
}

export async function readLaneEvents(repoRoot, laneId = "") {
  let content = ""
  try {
    content = await fs.readFile(laneEventLogPath(repoRoot, laneId), "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// Local events record workflow decisions. GitHub enforces repository access.
function hasLocalPeerApproval(events, lane) {
  const owner = String(lane.owner || "").trim().toLowerCase()
  const reviewer = String(lane.reviewer || "").trim().toLowerCase()
  if (!owner || !reviewer || owner === reviewer) return false

  for (const event of events.slice().reverse()) {
    const status = event?.after?.status
    if (WITHDRAWAL_EVENTS.has(event?.type) || (status && !PR_STATUSES.has(status))) return false

    if (event?.type === "resolve" && event.after?.status === "ready-for-pr") {
      return event.before?.status === "needs-review"
        && event.details?.localReviewApproved === true
        && !event.details["transition-advisory"]
        && String(event.actor || "").trim().toLowerCase() === reviewer
        && String(event.before.reviewer || "").trim().toLowerCase() === reviewer
        && String(event.before.owner || "").trim().toLowerCase() === owner
    }
  }

  return false
}

export async function enforceLocalReview(repoRoot, config, { lane, laneId, stage }) {
  const laneLabel = laneId || "(single)"
  if (PR_STATUSES.has(lane.status) && hasLocalPeerApproval(await readLaneEvents(repoRoot, laneId), lane)) return

  const message = `${stage} needs a current local peer review for lane ${laneLabel}.`
  if (!isFeatureEnabled(config, "local_review")) {
    console.error(`warning: local_review is disabled. ${message}`)
    return
  }

  const laneArg = laneId ? ` --lane ${laneId}` : ""
  throw new Error(
    `${message} `
    + `Run btrain handoff update${laneArg} --status needs-review. `
    + `After reviewing, the assigned peer runs btrain handoff resolve${laneArg}. `
    + "Relink an existing PR from ready-for-pr before requesting bot review."
  )
}
