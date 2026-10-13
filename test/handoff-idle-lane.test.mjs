// spec 015 FR-5 enforcement (2026-10-13) of the legacy paths that acted on a
// lane nobody has claimed. An idle lane has no owner, reviewer, task, or
// locks, so there is nothing to resolve, rescope, or reassign:
//
// - `handoff resolve` on an idle lane was legacy row L2. Spec 002 (Resolve,
//   update, and claim authority): "handoff resolve requires an active lane.
//   Resolving an idle lane ... is rejected".
// - `handoff update --files` on an idle lane was the idle source of L6. Spec
//   014 (rescope designation): a rescope is an update "on an active lane";
//   rows 16 and 17 have no idle source.
// - `handoff update --owner/--reviewer` on an idle lane was the idle source
//   of L10. Spec 005 FR-5: reassignment is available in in-progress,
//   needs-review, or changes-requested; row 20 has no idle source.
//
// The formal harness tallied all three (seed 1167269621:
// resolve-from-idle=9, rescope-authorization=6, reassign-authorization=5;
// README ledger entry 13). The transition gate (transitions.mjs) now rejects
// them before any caller writes, so every entry point refuses them without a
// change in core.mjs.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  claimHandoff,
  patchHandoff,
  readAllLaneStates,
  readLockRegistry,
  readProjectConfig,
  resolveHandoff,
} from "../src/brain_train/core.mjs"
import { TransitionRejection } from "../src/brain_train/transitions.mjs"

const exec = promisify(execFile)

const PROJECT_TOML = `[project]
name = "idle-lane"

[agents]
active = ["alpha", "beta", "gamma"]

[lanes]
enabled = true
ids = ["x", "y"]

[lanes.x]
handoff_path = ".claude/collab/HANDOFF_X.md"

[lanes.y]
handoff_path = ".claude/collab/HANDOFF_Y.md"

[pr_flow]
enabled = true
base = "main"
required_bots = ["codex"]
`

function idleHandoff(lane) {
  return [
    "## Current",
    "",
    `Lane: ${lane}`,
    "Task: ",
    "Active Agent: ",
    "Peer Reviewer: ",
    "Status: idle",
    "Review Mode: manual",
    "Locked Files: ",
    "Next Action: Claim the next task.",
    "Base: ",
    "Last Updated: idle-lane test",
    "",
    "## Previous Handoffs",
    "",
    "",
  ].join("\n")
}

async function withIdleLanes(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-idle-lane-"))
  const repo = path.join(root, "repo")
  const previousHome = process.env.BRAIN_TRAIN_HOME
  await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
  await fs.mkdir(path.join(repo, ".claude", "collab"), { recursive: true })
  await fs.writeFile(path.join(repo, ".btrain", "project.toml"), PROJECT_TOML)
  for (const lane of ["x", "y"]) {
    await fs.writeFile(path.join(repo, ".claude", "collab", `HANDOFF_${lane.toUpperCase()}.md`), idleHandoff(lane))
  }
  process.env.BRAIN_TRAIN_HOME = path.join(root, "home")
  try {
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

async function lane(repo, id) {
  const states = await readAllLaneStates(repo, await readProjectConfig(repo))
  const state = states.find((entry) => entry._laneId === id)
  const registry = await readLockRegistry(repo)
  return { ...state, registry: registry.locks.filter((lock) => lock.lane === id).map((lock) => lock.path) }
}

async function laneEvents(repo, id) {
  try {
    const content = await fs.readFile(path.join(repo, ".btrain", "events", `lane-${id}.jsonl`), "utf8")
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

function rejectedByGate(rowId) {
  return (error) => {
    assert.ok(error instanceof TransitionRejection, `expected a TransitionRejection, got ${error?.constructor?.name}: ${error?.message}`)
    assert.equal(error.rowId, rowId)
    assert.match(error.message, /is idle/)
    assert.match(error.message, /btrain handoff claim --lane <id>/)
    return true
  }
}

async function assertStillIdle(repo, id) {
  const state = await lane(repo, id)
  assert.equal(state.status, "idle")
  assert.equal(state.owner, "")
  assert.equal(state.reviewer, "")
  assert.deepEqual(state.lockedFiles, [])
  assert.deepEqual(state.registry, [])
  assert.deepEqual(await laneEvents(repo, id), [], "a rejected write records no workflow event")
}

const ACTORS = ["alpha", "beta", "gamma"]

describe("idle lanes refuse resolve, rescope, and reassign (spec 015 L2, L6 idle, L10 idle)", () => {
  it("rejects handoff resolve on an idle lane for every actor, with and without --final", async () => {
    await withIdleLanes(async (repo) => {
      for (const actor of ACTORS) {
        for (const final of [false, true]) {
          await assert.rejects(
            asAgent(actor, () => resolveHandoff(repo, { lane: "x", actor, final, summary: "nothing here" })),
            rejectedByGate("L2"),
            `resolve by ${actor} final=${final}`,
          )
        }
      }
      await assertStillIdle(repo, "x")
    })
  })

  it("rejects handoff update --files on an idle lane, including the empty set that used to release records", async () => {
    await withIdleLanes(async (repo) => {
      for (const actor of ACTORS) {
        for (const files of ["src/a/", "src/,docs/", ""]) {
          await assert.rejects(
            asAgent(actor, () => patchHandoff(repo, { lane: "x", actor, files, "no-dispatch": true })),
            rejectedByGate("L6"),
            `--files "${files}" by ${actor}`,
          )
        }
      }
      await assertStillIdle(repo, "x")
    })
  })

  it("rejects handoff update --owner and --reviewer on an idle lane", async () => {
    await withIdleLanes(async (repo) => {
      for (const actor of ACTORS) {
        for (const roles of [{ owner: "alpha" }, { reviewer: "beta" }, { owner: "alpha", reviewer: "beta" }]) {
          await assert.rejects(
            asAgent(actor, () => patchHandoff(repo, { lane: "x", actor, "no-dispatch": true, ...roles })),
            rejectedByGate("L10"),
            `${JSON.stringify(roles)} by ${actor}`,
          )
        }
      }
      // A role change bundled with a status change is checked against row 20
      // as well, so the idle source is refused however the update is labeled.
      await assert.rejects(
        asAgent("alpha", () =>
          patchHandoff(repo, { lane: "x", actor: "alpha", status: "in-progress", owner: "alpha", reviewer: "beta", files: "src/a/", "no-dispatch": true }),
        ),
        rejectedByGate("L10"),
      )
      await assertStillIdle(repo, "x")
    })
  })

  it("leaves a metadata-only update on an idle lane alone (spec 015 row 19 / L12) and keeps the lane claimable", async () => {
    await withIdleLanes(async (repo) => {
      await asAgent("alpha", () => patchHandoff(repo, { lane: "x", actor: "alpha", next: "parked note", "no-dispatch": true }))
      let state = await lane(repo, "x")
      assert.equal(state.status, "idle")
      assert.equal(state.nextAction, "parked note")
      assert.deepEqual(state.registry, [])

      await asAgent("alpha", () =>
        claimHandoff(repo, { lane: "x", task: "first task", owner: "alpha", reviewer: "beta", files: "src/a/" }),
      )
      state = await lane(repo, "x")
      assert.equal(state.status, "in-progress")
      assert.deepEqual(state.registry, ["src/a/"])
      // Rescope and reassign are legal again on the claimed lane (rows 16 and 20).
      await asAgent("alpha", () => patchHandoff(repo, { lane: "x", actor: "alpha", files: "src/b/", "no-dispatch": true }))
      await asAgent("alpha", () => patchHandoff(repo, { lane: "x", actor: "alpha", reviewer: "gamma", "no-dispatch": true }))
      state = await lane(repo, "x")
      assert.deepEqual(state.registry, ["src/b/"])
      assert.equal(state.reviewer, "gamma")
      // And so is the owner's abandon resolve (row 6).
      await asAgent("alpha", () => resolveHandoff(repo, { lane: "x", actor: "alpha", summary: "abandoned" }))
      assert.equal((await lane(repo, "x")).status, "resolved")
      await assertStillIdle(repo, "y")
    })
  })

  it("prints the gate's rejection from the CLI with a non-zero exit", async () => {
    await withIdleLanes(async (repo) => {
      const cli = path.resolve("src/brain_train/cli.mjs")
      const env = { ...process.env, BRAIN_TRAIN_HOME: process.env.BRAIN_TRAIN_HOME, BTRAIN_AGENT: "alpha" }
      for (const name of ["BTRAIN_LANE", "BTRAIN_LANE_LOCKED", "BTRAIN_REPO"]) delete env[name]
      const run = async (args) => {
        try {
          const result = await exec("node", [cli, ...args], { cwd: repo, env })
          return { code: 0, stdout: result.stdout, stderr: result.stderr }
        } catch (error) {
          return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || "" }
        }
      }
      const resolve = await run(["handoff", "resolve", "--repo", repo, "--lane", "x", "--summary", "nothing here", "--actor", "alpha"])
      assert.equal(resolve.code, 1)
      assert.match(resolve.stderr, /✖ .*is idle/)
      assert.match(resolve.stderr, /spec 015 L2/)
      assert.match(resolve.stderr, /Fix: .*btrain handoff claim --lane <id>/)
      assert.doesNotMatch(resolve.stdout + resolve.stderr, /transition-advisory/)

      const rescope = await run(["handoff", "update", "--repo", repo, "--lane", "x", "--files", "src/a/", "--actor", "alpha"])
      assert.equal(rescope.code, 1)
      assert.match(rescope.stderr, /spec 015 L6/)

      const reassign = await run(["handoff", "update", "--repo", repo, "--lane", "x", "--owner", "alpha", "--actor", "alpha"])
      assert.equal(reassign.code, 1)
      assert.match(reassign.stderr, /spec 015 L10/)
      await assertStillIdle(repo, "x")
    })
  })
})
