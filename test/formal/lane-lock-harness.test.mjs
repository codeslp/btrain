// spec 014 FR-6 code-to-model validation harness.
//
// Drives the real btrain entry points (claimHandoff, patchHandoff,
// requestChangesHandoff, resolveHandoff, releaseLocks, and pr-flow's
// applyPrStatusToHandoff) with fast-check-generated command sequences
// against throwaway repos, and checks every step against the executable
// contract transcription in lane-lock-model.mjs.
//
// Opt-in: BTRAIN_FORMAL=1 npm run test:formal
//   BTRAIN_FORMAL_RUNS=<n>      property runs per mode (default 15)
//   BTRAIN_FORMAL_SEED=<n>      reproduce a recorded run
//   BTRAIN_FORMAL_TRACE_DIR=<p> where failing traces are written
//
// Expected baseline while the designated drift exists (spec 014, Current
// Bootstrap Gaps; modeling brief, Known Incidents): the CONTRACT mode fails
// with a shrunk counterexample — that is the harness detecting the
// designated close-without-merge / unaudited-release drift, i.e. a
// `validation_mismatch` verdict. The IMPLEMENTATION mode mirrors known
// drift and hunts for undesignated divergences.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import fc from "fast-check"

import {
  claimHandoff,
  patchHandoff,
  requestChangesHandoff,
  resolveHandoff,
  releaseLocks,
  readAllLaneStates,
  readLockRegistry,
  readProjectConfig,
  BtrainError,
} from "../../src/brain_train/core.mjs"
import { applyPrStatusToHandoff } from "../../src/brain_train/pr-flow.mjs"
import { LaneLockModel } from "./lane-lock-model.mjs"

const ENABLED = process.env.BTRAIN_FORMAL === "1"
const NUM_RUNS = Number(process.env.BTRAIN_FORMAL_RUNS || 15)
const SEED = process.env.BTRAIN_FORMAL_SEED ? Number(process.env.BTRAIN_FORMAL_SEED) : undefined
const TRACE_DIR =
  process.env.BTRAIN_FORMAL_TRACE_DIR || path.join(os.tmpdir(), "btrain-formal-traces")

const LANES = ["x", "y"]
const AGENTS = ["alpha", "beta", "gamma"]
const FILE_POOL = ["src/a/", "src/b/", "docs/"]
const PR_NUMBER = "101"
const UNDESIGNATED_SKIPS = new Set(["no-linked-pr", "pr-outcome-from-invalid-status"])
const NEEDS_REVIEW_CONTEXT = {
  base: "main",
  "no-diff": true,
  preflight: "formal harness pre-flight: model and locks reviewed",
  changed: "probe files inside the locked scope",
  verification: "conformance property run against the contract model",
  gap: "none",
  why: "generated command sequence reached needs-review",
  "review-ask": "check state agreement with the contract model",
}

for (const name of [
  "BTRAIN_LANE",
  "BTRAIN_LANE_LOCKED",
  "BTRAIN_REPO",
  "BRAIN_TRAIN_AGENT",
  "BTRAIN_AGENT",
  "HANDOFF_HISTORY_PATH",
]) {
  delete process.env[name]
}

const PROJECT_TOML = `[project]
name = "formal-harness"

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

[pr_flow.bots.codex]
aliases = ["codex[bot]"]
request_body = "@codex review"
`

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "btrain-formal-"))
  const repo = path.join(root, "repo")
  await fs.mkdir(path.join(repo, ".btrain"), { recursive: true })
  await fs.mkdir(path.join(repo, ".claude", "collab"), { recursive: true })
  await fs.writeFile(path.join(repo, ".btrain", "project.toml"), PROJECT_TOML)
  process.env.BRAIN_TRAIN_HOME = path.join(root, "home")
  return { root, repo }
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

function sortedPaths(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => String(p).trim())
    .filter(Boolean)
    .sort()
}

async function realSnapshot(repo, config) {
  const states = await readAllLaneStates(repo, config)
  const registry = await readLockRegistry(repo)
  const lanes = {}
  for (const id of LANES) {
    const s = states.find((x) => x._laneId === id) || {}
    lanes[id] = {
      status: s.status || "idle",
      owner: s.owner || "",
      reviewer: s.reviewer || "",
      lockedFiles: sortedPaths(s.lockedFiles),
      registry: registry.locks
        .filter((l) => l.lane === id)
        .map((l) => l.path)
        .sort(),
    }
  }
  return lanes
}

// Actor selectors resolve against the model's lane state at execution time so
// generated commands can deliberately probe wrong-actor authorization.
function resolveActor(model, lane, selector) {
  const s = model.lane(lane)
  if (selector === "owner") return s.owner || AGENTS[0]
  if (selector === "reviewer") return s.reviewer || AGENTS[1]
  return AGENTS.find((a) => a !== s.owner && a !== s.reviewer) || AGENTS[2]
}

function commandArb() {
  const lane = fc.constantFrom(...LANES)
  const actorSel = fc.constantFrom("owner", "owner", "reviewer", "reviewer", "third")
  return fc.oneof(
    { arbitrary: fc.record({ t: fc.constant("claim"), lane, owner: fc.constantFrom(...AGENTS), reviewer: fc.constantFrom(...AGENTS), files: fc.uniqueArray(fc.constantFrom(...FILE_POOL), { minLength: 1, maxLength: 2 }) }), weight: 3 },
    { arbitrary: fc.record({ t: fc.constant("update"), lane, actorSel, status: fc.constantFrom("needs-review", "needs-review", "pr-review", "in-progress", "repair-needed", "ready-to-merge") }), weight: 4 },
    { arbitrary: fc.record({ t: fc.constant("requestChanges"), lane, actorSel }), weight: 2 },
    { arbitrary: fc.record({ t: fc.constant("resolve"), lane, actorSel, final: fc.boolean() }), weight: 3 },
    { arbitrary: fc.record({ t: fc.constant("prOutcome"), lane, outcome: fc.constantFrom("merged", "closed", "feedback", "clear", "waiting") }), weight: 3 },
    { arbitrary: fc.record({ t: fc.constant("releaseLane"), lane }), weight: 1 },
  )
}

async function runReal(repo, cmd, actor) {
  switch (cmd.t) {
    case "claim":
      return asAgent(cmd.owner, () =>
        claimHandoff(repo, {
          lane: cmd.lane,
          task: `formal probe ${cmd.lane}`,
          owner: cmd.owner,
          reviewer: cmd.reviewer,
          files: cmd.files.join(","),
        }),
      )
    case "update":
      return asAgent(actor, () =>
        patchHandoff(repo, {
          lane: cmd.lane,
          actor,
          status: cmd.status,
          "no-dispatch": true,
          ...(cmd.status === "pr-review" ? { pr: PR_NUMBER } : {}),
          ...(cmd.status === "repair-needed" ? { "reason-code": "invalid-handoff" } : {}),
          // The needs-review gate requires the six reviewer-context fields
          // and a diff check; the harness supplies real context and skips the
          // git diff because the throwaway repo has no git history.
          ...(cmd.status === "needs-review" ? NEEDS_REVIEW_CONTEXT : {}),
        }),
      )
    case "requestChanges":
      return asAgent(actor, () =>
        requestChangesHandoff(repo, {
          lane: cmd.lane,
          actor,
          summary: "formal probe findings",
          "reason-code": "spec-mismatch",
        }),
      )
    case "resolve":
      return asAgent(actor, () =>
        resolveHandoff(repo, {
          lane: cmd.lane,
          actor,
          final: cmd.final,
          summary: "formal probe resolution",
        }),
      )
    case "prOutcome":
      return asAgent(actor, () =>
        applyPrStatusToHandoff(
          repo,
          { lane: cmd.lane, pr: PR_NUMBER, actor },
          {
            overall: cmd.outcome === "clear" ? "ready-to-merge" : cmd.outcome,
            pr: { mergedAt: "2026-01-01T00:00:00Z" },
            bots:
              cmd.outcome === "feedback"
                ? [{ id: "codex", state: "feedback" }]
                : [{ id: "codex", state: "approved" }],
          },
        ),
      )
    case "releaseLane":
      return releaseLocks(repo, cmd.lane)
    default:
      throw new Error(`unknown command ${cmd.t}`)
  }
}

function applyModel(model, cmd, actor) {
  switch (cmd.t) {
    case "claim":
      return model.claim(cmd)
    case "update":
      return model.update({ lane: cmd.lane, actor, status: cmd.status, pr: cmd.status === "pr-review" ? PR_NUMBER : undefined })
    case "requestChanges":
      return model.requestChanges({ lane: cmd.lane, actor })
    case "resolve":
      return model.resolve({ lane: cmd.lane, actor, final: cmd.final })
    case "prOutcome":
      return model.prOutcome({ ...cmd, pr: PR_NUMBER })
    case "releaseLane":
      return model.releaseLane(cmd)
    default:
      throw new Error(`unknown command ${cmd.t}`)
  }
}

class Divergence extends Error {
  constructor(message, trace) {
    super(message)
    this.name = "Divergence"
    this.trace = trace
  }
}

async function executeSequence(mode, cmds) {
  const { root, repo } = await makeRepo()
  const trace = []
  try {
    const config = await readProjectConfig(repo)
    const model = new LaneLockModel({ lanes: LANES, agents: AGENTS, prFlowEnabled: true, mode })

    for (const [i, cmd] of cmds.entries()) {
      const actor = "actorSel" in cmd ? resolveActor(model, cmd.lane, cmd.actorSel) : cmd.owner || ""
      const expected = applyModel(model, cmd, actor)

      // The contract does not designate PR-outcome behavior for lanes outside
      // the PR flow, so those probes are skipped rather than compared. The
      // undesignated surface is listed in README.md as pilot evidence.
      if (!expected.ok && UNDESIGNATED_SKIPS.has(expected.reason)) {
        trace.push({ i, cmd, actor, skipped: expected.reason })
        continue
      }

      let realOk = true
      let realError = ""
      try {
        await runReal(repo, cmd, actor)
      } catch (error) {
        if (error instanceof BtrainError) {
          realOk = false
          realError = error.message
        } else if (error?.code === "ENOENT") {
          // patchHandoff crashes with a raw fs error when the lane has never
          // been claimed (no handoff file). Treated as a rejection here and
          // listed in README.md as a robustness finding.
          realOk = false
          realError = `ENOENT crash: ${error.message}`
        } else {
          trace.push({ i, cmd, actor, crash: `${error.constructor?.name}: ${error.message}` })
          throw new Divergence(
            `step ${i} ${cmd.t}: unexpected ${error.constructor?.name}: ${error.message}`,
            trace,
          )
        }
      }

      const real = await realSnapshot(repo, config)
      const expectedState = model.snapshot()
      const step = {
        i,
        cmd,
        actor,
        modelOk: expected.ok,
        modelReason: expected.reason || "",
        realOk,
        realError,
        expectedState,
        realState: real,
      }
      trace.push(step)

      if (expected.ok !== realOk) {
        throw new Divergence(
          `step ${i} ${cmd.t}: model ${expected.ok ? "allows" : `rejects (${expected.reason})`} but implementation ${realOk ? "accepted" : `rejected: ${realError}`}`,
          trace,
        )
      }
      const stateDiff = JSON.stringify(expectedState) !== JSON.stringify(real)
      if (stateDiff) {
        throw new Divergence(`step ${i} ${cmd.t}: state diverged from the contract model`, trace)
      }
      // Invariants judge the contract. Implementation mode intentionally
      // mirrors real behavior, including designated violations, so it checks
      // state agreement only.
      if (mode === "contract") {
        const violations = model.invariantViolations()
        if (violations.length > 0) {
          throw new Divergence(`step ${i} ${cmd.t}: invariant violated: ${violations.join("; ")}`, trace)
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
  return trace
}

async function writeFailureTrace(mode, error, details) {
  await fs.mkdir(TRACE_DIR, { recursive: true })
  const file = path.join(TRACE_DIR, `lane-lock-${mode}-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        mode,
        seed: details.seed,
        counterexamplePath: details.counterexamplePath,
        numRuns: NUM_RUNS,
        message: error.message,
        trace: error.trace || null,
      },
      null,
      2,
    ),
  )
  return file
}

async function runConformance(mode) {
  let lastDivergence = null
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(commandArb(), { minLength: 3, maxLength: 12 }), async (cmds) => {
        try {
          await executeSequence(mode, cmds)
        } catch (error) {
          if (error instanceof Divergence) {
            lastDivergence = error
          }
          throw error
        }
      }),
      { numRuns: NUM_RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) },
    )
  } catch (error) {
    const details = {
      seed: /seed:\s*(-?\d+)/.exec(error.message)?.[1] ?? String(SEED ?? ""),
      counterexamplePath: /Counterexample:[\s\S]*?(\[[\s\S]*?\])/.exec(error.message)?.[1] ?? "",
    }
    const divergence = lastDivergence || error
    const traceFile = await writeFailureTrace(mode, divergence, details)
    assert.fail(
      `${mode} conformance failed (validation_mismatch).\n` +
        `${divergence.message}\n` +
        `Reproduce with BTRAIN_FORMAL_SEED=${details.seed}.\n` +
        `Trace written to ${traceFile}\n\n${error.message}`,
    )
  }
}

// Expected to fail (todo) until the designated drift is repaired: a failure
// here is the harness returning `validation_mismatch` against the contract.
test(
  "lane/lock contract conformance (contract mode)",
  {
    skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness",
    todo: "validation_mismatch expected while designated drift exists (spec 014, Current Bootstrap Gaps)",
  },
  async () => {
    await runConformance("contract")
  },
)

// Must pass: mirrors the designated drift and hunts undesignated divergences.
test(
  "lane/lock conformance with designated drift mirrored (implementation mode)",
  { skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness" },
  async () => {
    await runConformance("implementation")
  },
)

// Deterministic witness for KNOWN_DRIFTS.closeWithoutMerge: asserts the
// CONTRACT (close without merge → terminal resolved + lock release), so it
// stays todo-red until pr-flow.mjs applyPrStatusToHandoff is repaired, and
// flips green the moment it is.
test(
  "designated drift witness: close-without-merge resolves and releases",
  {
    skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness",
    todo: "pr-flow.mjs routes close-without-merge to repair-needed (designated drift)",
  },
  async () => {
    const { root, repo } = await makeRepo()
    try {
      const config = await readProjectConfig(repo)
      await asAgent("alpha", () =>
        claimHandoff(repo, { lane: "x", task: "drift witness", owner: "alpha", reviewer: "beta", files: "src/a/" }),
      )
      await asAgent("alpha", () =>
        patchHandoff(repo, {
          lane: "x",
          actor: "alpha",
          status: "needs-review",
          "no-dispatch": true,
          ...NEEDS_REVIEW_CONTEXT,
        }),
      )
      await asAgent("beta", () =>
        resolveHandoff(repo, { lane: "x", actor: "beta", summary: "peer approval" }),
      )
      await asAgent("alpha", () =>
        patchHandoff(repo, { lane: "x", actor: "alpha", status: "pr-review", pr: PR_NUMBER }),
      )
      await asAgent("alpha", () =>
        applyPrStatusToHandoff(
          repo,
          { lane: "x", pr: PR_NUMBER, actor: "alpha" },
          { overall: "closed", pr: {}, bots: [] },
        ),
      )
      const lanes = await realSnapshot(repo, config)
      assert.equal(lanes.x.status, "resolved", "contract: close without merge is terminal resolved")
      assert.deepEqual(lanes.x.registry, [], "contract: terminal resolved releases the lane's locks")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
