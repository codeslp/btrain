// spec 015 row 19 (spec 002 CLI Commands, update authority): a `handoff
// update` without --status, --files, --owner, or --reviewer changes only
// metadata, and it applies in any status, `resolved` included. The formal
// harness found patchHandoff refusing it on a resolved lane (seed
// -1468514561, test/formal/README.md ledger finding 12): the lane's own
// `resolved` status was read as a request to enter `resolved`.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  BtrainError,
  claimHandoff,
  patchHandoff,
  readAllLaneStates,
  readLockRegistry,
  readProjectConfig,
  resolveHandoff,
} from "../src/brain_train/core.mjs"

const PROJECT_TOML = `[project]
name = "update-resolved"

[agents]
active = ["alpha", "beta", "gamma"]

[lanes]
enabled = true
ids = ["x"]

[lanes.x]
handoff_path = ".claude/collab/HANDOFF_X.md"

[pr_flow]
enabled = true
base = "main"
required_bots = ["codex"]
`

async function withResolvedLane(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-update-resolved-"))
  const repo = path.join(root, "repo")
  const previousHome = process.env.BRAIN_TRAIN_HOME
  await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
  await fs.mkdir(path.join(repo, ".claude", "collab"), { recursive: true })
  await fs.writeFile(path.join(repo, ".btrain", "project.toml"), PROJECT_TOML)
  process.env.BRAIN_TRAIN_HOME = path.join(root, "home")
  try {
    await asAgent("alpha", () =>
      claimHandoff(repo, { lane: "x", task: "resolved-lane updates", owner: "alpha", reviewer: "beta", files: "src/a/" }),
    )
    // Row 6 (AbandonResolve): the owner resolves an unlinked in-progress lane.
    await asAgent("alpha", () => resolveHandoff(repo, { lane: "x", actor: "alpha", summary: "abandoned" }))
    await fn(repo)
  } finally {
    if (previousHome === undefined) delete process.env.BRAIN_TRAIN_HOME
    else process.env.BRAIN_TRAIN_HOME = previousHome
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function asAgent(agent, fn) {
  const previous = process.env.BTRAIN_AGENT
  process.env.BTRAIN_AGENT = agent
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.BTRAIN_AGENT
    else process.env.BTRAIN_AGENT = previous
  }
}

async function laneX(repo) {
  const states = await readAllLaneStates(repo, await readProjectConfig(repo))
  const lane = states.find((state) => state._laneId === "x")
  const registry = await readLockRegistry(repo)
  return { ...lane, registry: registry.locks.filter((lock) => lock.lane === "x").map((lock) => lock.path) }
}

async function lastUpdateEvent(repo) {
  const content = await fs.readFile(path.join(repo, ".btrain", "events", "lane-x.jsonl"), "utf8")
  const events = content.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  return [...events].reverse().find((event) => event.type === "update")
}

describe("handoff update on a resolved lane (spec 015 row 19)", () => {
  it("accepts a metadata-only update from the owner or the reviewer and keeps the lane resolved", async () => {
    await withResolvedLane(async (repo) => {
      assert.equal((await laneX(repo)).status, "resolved")

      await asAgent("alpha", () =>
        patchHandoff(repo, { lane: "x", actor: "alpha", next: "follow-up lives in lane y", "no-dispatch": true }),
      )
      let lane = await laneX(repo)
      assert.equal(lane.status, "resolved")
      assert.equal(lane.nextAction, "follow-up lives in lane y")
      assert.deepEqual(lane.lockedFiles, [])
      assert.deepEqual(lane.registry, [])
      let event = await lastUpdateEvent(repo)
      assert.equal(event.details.transitionEvent, "handoff update --metadata")
      assert.equal(event.details["transition-advisory"], undefined, "a lane agent's metadata update is row 19, not legacy")

      await asAgent("beta", () =>
        patchHandoff(repo, { lane: "x", actor: "beta", task: "resolved-lane updates (renamed)", "no-dispatch": true }),
      )
      lane = await laneX(repo)
      assert.equal(lane.status, "resolved")
      assert.equal(lane.task, "resolved-lane updates (renamed)")
      event = await lastUpdateEvent(repo)
      assert.equal(event.actor, "beta")
      assert.equal(event.details["transition-advisory"], undefined)
    })
  })

  it("accepts a non-lane agent's metadata update with the L12 advisory record", async () => {
    await withResolvedLane(async (repo) => {
      const warnings = []
      await asAgent("gamma", () =>
        patchHandoff(repo, {
          lane: "x",
          actor: "gamma",
          next: "noted by a third agent",
          "no-dispatch": true,
          onEvent: (line) => warnings.push(line),
        }),
      )
      const lane = await laneX(repo)
      assert.equal(lane.status, "resolved")
      assert.equal(lane.nextAction, "noted by a third agent")
      const event = await lastUpdateEvent(repo)
      assert.equal(event.details["transition-advisory"], "L12")
      assert.match(warnings.join("\n"), /transition-advisory L12: handoff update --metadata `resolved`/)
    })
  })

  it("still refuses --status resolved through update, from an active or a resolved lane", async () => {
    await withResolvedLane(async (repo) => {
      await assert.rejects(
        asAgent("alpha", () =>
          patchHandoff(repo, { lane: "x", actor: "alpha", status: "resolved", next: "again", "no-dispatch": true }),
        ),
        (error) => error instanceof BtrainError && /Cannot set status to `resolved`/.test(error.message),
      )

      await asAgent("alpha", () =>
        claimHandoff(repo, { lane: "x", task: "second task", owner: "alpha", reviewer: "beta", files: "src/b/" }),
      )
      await assert.rejects(
        asAgent("alpha", () => patchHandoff(repo, { lane: "x", actor: "alpha", status: "resolved", "no-dispatch": true })),
        (error) => error instanceof BtrainError && /Cannot set status to `resolved`/.test(error.message),
      )
      const lane = await laneX(repo)
      assert.equal(lane.status, "in-progress")
      assert.deepEqual(lane.registry, ["src/b/"])
    })
  })

  it("still refuses files and roles on a resolved lane: rows 16, 17 and 20 have no resolved source", async () => {
    await withResolvedLane(async (repo) => {
      for (const change of [{ files: "src/b/" }, { owner: "gamma" }, { reviewer: "gamma" }]) {
        await assert.rejects(
          asAgent("alpha", () => patchHandoff(repo, { lane: "x", actor: "alpha", "no-dispatch": true, ...change })),
          BtrainError,
          `update ${JSON.stringify(change)} on a resolved lane`,
        )
      }
      const lane = await laneX(repo)
      assert.equal(lane.status, "resolved")
      assert.equal(lane.owner, "alpha")
      assert.equal(lane.reviewer, "beta")
      assert.deepEqual(lane.lockedFiles, [])
      assert.deepEqual(lane.registry, [])
    })
  })
})
