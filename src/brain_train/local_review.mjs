import fs from "node:fs/promises"
import path from "node:path"
import { consumeOverride, getRepoPaths, listActiveOverrides } from "./core.mjs"

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
function hasLocalReviewDecision(events, lane, laneId) {
  const owner = String(lane.owner || "").trim().toLowerCase()
  const reviewer = String(lane.reviewer || "").trim().toLowerCase()

  let consumedOverride = false
  for (const event of events.slice().reverse()) {
    const status = event?.after?.status
    if (WITHDRAWAL_EVENTS.has(event?.type) || (status && !PR_STATUSES.has(status))) return false

    // Consumption has no status snapshot. Only an earlier snapshot proves
    // it occurred inside this PR cycle, after all withdrawal checks above.
    if (consumedOverride && status) return true

    if (event?.type === "override-consumed" && event.details?.action === "local-review"
      && (event.laneId || "") === (laneId || "")
      && event.details.scope === (laneId ? "lane" : "repo")) consumedOverride = true

    if (event?.type === "resolve" && event.after?.status === "ready-for-pr") {
      return Boolean(owner && reviewer && owner !== reviewer)
        && event.before?.status === "needs-review"
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
  if (PR_STATUSES.has(lane.status)) {
    if (hasLocalReviewDecision(await readLaneEvents(repoRoot, laneId), lane, laneId)) return

    const pending = (await listActiveOverrides(repoRoot)).find((record) => record.action === "local-review"
      && (record.laneId || "") === (laneId || "")
      && record.scope === (laneId ? "lane" : "repo"))
    if (pending) {
      await consumeOverride(repoRoot, {
        config, action: "local-review", laneId, overrideId: pending.id, actor: lane.owner,
      })
      return
    }
  }

  const message = `${stage} needs a current local peer review for lane ${laneLabel}.`
  const laneArg = laneId ? ` --lane ${laneId}` : ""
  throw new Error(
    `${message} `
    + `Run btrain handoff update${laneArg} --status needs-review. `
    + `After reviewing, the assigned peer runs btrain handoff resolve${laneArg}. `
    + "Relink an existing PR from ready-for-pr before requesting bot review. "
    + `For an audited override, run btrain override grant --action local-review${laneArg} `
    + '--requested-by <agent> --confirmed-by <human> --reason "...".'
  )
}
