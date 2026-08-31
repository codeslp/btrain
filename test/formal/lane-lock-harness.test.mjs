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
// Expected baseline while designated drift exists (spec 014, Current
// Bootstrap Gaps; modeling brief, Known Incidents): CONTRACT mode ledgers
// designated drift, tallies candidate findings, and fails only on a
// divergence outside the documented ledger (a fresh `validation_mismatch`).
// Candidate findings surface through a dedicated todo test so they never
// pass silently. IMPLEMENTATION mode mirrors known drift and hunts for
// undesignated divergences. Deterministic todo witnesses keep designated
// contract gaps visible until the implementation is repaired.

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
import { KNOWN_DRIFTS, LaneLockModel } from "./lane-lock-model.mjs"

const ENABLED = process.env.BTRAIN_FORMAL === "1"
const NUM_RUNS = Number(process.env.BTRAIN_FORMAL_RUNS || 15)
const SEED = process.env.BTRAIN_FORMAL_SEED ? Number(process.env.BTRAIN_FORMAL_SEED) : undefined
const TRACE_DIR =
  process.env.BTRAIN_FORMAL_TRACE_DIR || path.join(os.tmpdir(), "btrain-formal-traces")

const LANES = ["x", "y"]
const AGENTS = ["alpha", "beta", "gamma"]
// "src/" is an ancestor of "src/a/" and "src/b/", so generated claims and
// rescopes exercise prefix-overlap exclusivity, not only identical paths.
const FILE_POOL = ["src/", "src/a/", "src/b/", "docs/"]
const PR_NUMBER = "101"
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
  const repair = {}
  for (const id of LANES) {
    const s = states.find((x) => x._laneId === id) || {}
    lanes[id] = {
      status: s.status || "idle",
      owner: s.owner || "",
      reviewer: s.reviewer || "",
      reasonCode: String(s.reasonCode || ""),
      lockedFiles: sortedPaths(s.lockedFiles),
      registry: registry.locks
        .filter((l) => l.lane === id)
        .map((l) => l.path)
        .sort(),
    }
    // Compared through explicit contract expectations, not raw equality:
    // the implementation's attempt-counting internals are not designated.
    repair[id] = {
      attempts: Number(s.repairAttempts) || 0,
      escalation: String(s.repairEscalation || ""),
      owner: String(s.repairOwner || ""),
    }
  }
  return { lanes, repair }
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
    { arbitrary: fc.record({ t: fc.constant("update"), lane, actorSel, status: fc.constantFrom("needs-review", "needs-review", "pr-review", "in-progress", "repair-needed", "ready-to-merge"), reason: fc.constantFrom("invalid-handoff", "lock-mismatch") }), weight: 4 },
    { arbitrary: fc.record({ t: fc.constant("requestChanges"), lane, actorSel }), weight: 2 },
    { arbitrary: fc.record({ t: fc.constant("resolve"), lane, actorSel, final: fc.boolean() }), weight: 3 },
    { arbitrary: fc.record({ t: fc.constant("prOutcome"), lane, outcome: fc.constantFrom("merged", "closed", "feedback", "clear", "waiting") }), weight: 3 },
    { arbitrary: fc.record({ t: fc.constant("rescope"), lane, actorSel, files: fc.uniqueArray(fc.constantFrom(...FILE_POOL), { minLength: 1, maxLength: 2 }) }), weight: 2 },
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
          ...(cmd.status === "repair-needed" ? { "reason-code": cmd.reason || "invalid-handoff" } : {}),
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
    case "rescope":
      // `btrain handoff update --files` without --status: the designated
      // rescope path.
      return asAgent(actor, () =>
        patchHandoff(repo, {
          lane: cmd.lane,
          actor,
          files: cmd.files.join(","),
          "no-dispatch": true,
        }),
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
      return model.update({
        lane: cmd.lane,
        actor,
        status: cmd.status,
        pr: cmd.status === "pr-review" ? PR_NUMBER : undefined,
        reason: cmd.status === "repair-needed" ? cmd.reason || "invalid-handoff" : undefined,
      })
    case "requestChanges":
      return model.requestChanges({ lane: cmd.lane, actor })
    case "resolve":
      return model.resolve({ lane: cmd.lane, actor, final: cmd.final })
    case "prOutcome":
      return model.prOutcome({ ...cmd, pr: PR_NUMBER })
    case "rescope":
      return model.rescope({ lane: cmd.lane, actor, files: cmd.files })
    case "releaseLane":
      return model.releaseLane(cmd)
    default:
      throw new Error(`unknown command ${cmd.t}`)
  }
}

// Per-step divergence classification. Designated drift (KNOWN_DRIFTS) is
// ledgered and never fails; candidate findings (README ledger) are tallied
// and surfaced through a dedicated todo test; anything unclassified is a
// fresh validation_mismatch and fails the run. `kind` is "allow" (the model
// rejected, the implementation accepted) or "state" (both accepted, states
// diverged).
const CANDIDATE_REASON_LABELS = new Map([
  ["resolve-from-idle", "resolve-from-idle"],
  ["resolve-requires-lane-actor", "resolve-actor-unchecked"],
  ["ready-for-pr-entry-requires-reviewer", "resolve-actor-unchecked"],
  ["resolve-from-pr-flow-status", "resolve-from-pr-flow"],
  ["needs-review-requires-owner", "update-actor-unchecked"],
  ["pr-review-requires-owner", "update-actor-unchecked"],
  ["in-progress-requires-owner", "update-actor-unchecked"],
  ["needs-review-from-invalid-status", "update-source-status"],
  ["pr-review-from-invalid-status", "update-source-status"],
  ["ready-to-merge-requires-clear-bots", "update-source-status"],
  ["repair-from-inactive", "update-source-status"],
  ["in-progress-from-invalid-status", "update-source-status"],
  ["no-linked-pr", "pr-outcome-source-status"],
  ["pr-outcome-from-invalid-status", "pr-outcome-source-status"],
  ["rescope-requires-owner", "rescope-authorization"],
  ["rescope-from-invalid-status", "rescope-authorization"],
  ["repair-rescope-requires-guardian", "rescope-authorization"],
  ["repair-resolve-before-escalation", "repair-resolve-before-escalation"],
  ["repair-clear-requires-repair-owner", "update-actor-unchecked"],
])

// Designated classifications are non-failing, so each verifies that the
// observed real state matches the KNOWN drift shape before ledgering — a
// different wrong state on the same command is an unknown divergence and
// fails. Candidate classifications feed a failing gate, so shape precision
// there cannot hide a new mismatch.
function classifyDivergence(cmd, modelReason, kind, realLane, ctx = {}) {
  const sameSet = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const pre = ctx.pre || null
  if (kind === "state" && cmd.t === "prOutcome" && cmd.outcome === "closed") {
    // Drift shape, complete: routed to repair-needed with locks retained and
    // EVERY non-designated field unchanged from the pre-command contract
    // state (owner, reviewer, locked set), the drift's canonical reason
    // code, and the FR-7 repair owner. Any additional corruption riding the
    // closed outcome is an unknown divergence.
    const shapeOk =
      pre !== null &&
      realLane.status === "repair-needed" &&
      realLane.owner === pre.owner &&
      realLane.reviewer === pre.reviewer &&
      realLane.reasonCode === "invalid-handoff" &&
      sameSet(realLane.lockedFiles, [...pre.lockedFiles].sort()) &&
      sameSet(realLane.registry, realLane.lockedFiles) &&
      realLane.lockedFiles.length > 0 &&
      (!ctx.realRepair || ctx.realRepair.owner === (pre.lastActor || pre.owner))
    return shapeOk ? { designated: true, label: "close-without-merge" } : null
  }
  if (kind === "allow" && cmd.t === "releaseLane" && modelReason === "unaudited-release-forbidden") {
    // Drift shape, complete: registry emptied while the handoff record and
    // every other field keep their pre-command values.
    const shapeOk =
      pre !== null &&
      realLane.registry.length === 0 &&
      realLane.status === pre.status &&
      realLane.owner === pre.owner &&
      realLane.reviewer === pre.reviewer &&
      sameSet(realLane.lockedFiles, [...pre.lockedFiles].sort()) &&
      realLane.lockedFiles.length > 0
    return shapeOk ? { designated: true, label: "unaudited-release" } : null
  }
  if (kind === "allow" && cmd.t === "resolve" && modelReason === KNOWN_DRIFTS.finalFromPrFlow) {
    // Drift shape: terminal resolved with everything released.
    const shapeOk =
      realLane.status === "resolved" &&
      realLane.registry.length === 0 &&
      realLane.lockedFiles.length === 0
    return shapeOk ? { designated: true, label: "final-resolve-bypass" } : null
  }
  if (kind === "allow" && CANDIDATE_REASON_LABELS.has(modelReason)) {
    return { designated: false, label: CANDIDATE_REASON_LABELS.get(modelReason) }
  }
  return null
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
  const designatedTally = new Map()
  const candidateTally = new Map()
  const tainted = new Set()
  const record = (map, label) => map.set(label, (map.get(label) || 0) + 1)
  const ledger = (cls, cmd, real) => {
    record(cls.designated ? designatedTally : candidateTally, cls.label)
    tainted.add(cmd.lane)
  }
  try {
    const config = await readProjectConfig(repo)
    const model = new LaneLockModel({ lanes: LANES, agents: AGENTS, prFlowEnabled: true, mode })

    for (const [i, cmd] of cmds.entries()) {
      const actor = "actorSel" in cmd ? resolveActor(model, cmd.lane, cmd.actorSel) : cmd.owner || ""

      // A tainted lane carries adopted, ledgered drift: execute real-only
      // and keep the model synced by adoption so the untainted lanes stay
      // fully checked.
      if (mode === "contract" && tainted.has(cmd.lane)) {
        try {
          await runReal(repo, cmd, actor)
        } catch (error) {
          if (!(error instanceof BtrainError) && error?.code !== "ENOENT") throw error
        }
        const snapNow = await realSnapshot(repo, config)
        model.adoptReal(cmd.lane, snapNow.lanes[cmd.lane])
        trace.push({ i, cmd, actor, taintedLane: true })
        continue
      }

      // Pre-command contract state of the target lane, for verifying that a
      // ledgered designated drift changed ONLY its designated fields.
      const preLane =
        mode === "contract" ? JSON.parse(JSON.stringify(model.lane(cmd.lane))) : null

      const expected = applyModel(model, cmd, actor)

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

      const snap = await realSnapshot(repo, config)
      const real = snap.lanes
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
        realRepair: snap.repair,
      }
      trace.push(step)

      if (expected.ok !== realOk) {
        const cls =
          mode === "contract" && !expected.ok && realOk
            ? classifyDivergence(cmd, expected.reason, "allow", real[cmd.lane], {
                pre: preLane,
                realRepair: snap.repair[cmd.lane],
              })
            : null
        if (cls) {
          ledger(cls, cmd)
          model.adoptReal(cmd.lane, real[cmd.lane])
          continue
        }
        throw new Divergence(
          `step ${i} ${cmd.t}: model ${expected.ok ? "allows" : `rejects (${expected.reason})`} but implementation ${realOk ? "accepted" : `rejected: ${realError}`}`,
          trace,
        )
      }

      const diffLanes = LANES.filter(
        (id) => !tainted.has(id) && JSON.stringify(expectedState[id]) !== JSON.stringify(real[id]),
      )
      if (diffLanes.length > 0) {
        const cls =
          mode === "contract" && diffLanes.length === 1 && diffLanes[0] === cmd.lane
            ? classifyDivergence(cmd, expected.reason || "", "state", real[cmd.lane], {
                pre: preLane,
                realRepair: snap.repair[cmd.lane],
              })
            : null
        if (cls) {
          ledger(cls, cmd)
          model.adoptReal(cmd.lane, real[cmd.lane])
          continue
        }
        throw new Divergence(
          `step ${i} ${cmd.t}: state diverged from the contract model (lanes: ${diffLanes.join(", ")})`,
          trace,
        )
      }

      // spec 006 FR-18 (spec 014 designation): a same-reason repair re-entry
      // exhausts the one-attempt budget, so the contract expects a recorded
      // human escalation on the real lane. spec 006 FR-7: the assigned
      // repair owner is the most recent canonical actor before the repair.
      if (mode === "contract" && !tainted.has(cmd.lane)) {
        const m = model.lane(cmd.lane)
        if (m.escalationExpected && !snap.repair[cmd.lane].escalation) {
          record(candidateTally, "repair-escalation-missing")
          tainted.add(cmd.lane)
          model.adoptReal(cmd.lane, real[cmd.lane])
          continue
        }
        if (
          m.status === "repair-needed" &&
          m.repairOwner &&
          snap.repair[cmd.lane].owner !== m.repairOwner
        ) {
          throw new Divergence(
            `step ${i} ${cmd.t}: repair owner diverged — contract expects "${m.repairOwner}" (FR-7 most recent canonical actor), implementation assigned "${snap.repair[cmd.lane].owner}"`,
            trace,
          )
        }
      }

      // Invariants judge the contract. Implementation mode intentionally
      // mirrors real behavior, including designated violations, so it checks
      // state agreement only.
      if (mode === "contract") {
        const violations = model.invariantViolations(tainted)
        if (violations.length > 0) {
          throw new Divergence(`step ${i} ${cmd.t}: invariant violated: ${violations.join("; ")}`, trace)
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
  return { trace, designatedTally, candidateTally }
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
  const designated = new Map()
  const candidates = new Map()
  const fold = (into, from) => {
    for (const [label, n] of from) into.set(label, (into.get(label) || 0) + n)
  }
  // FR-6: every run — pass or fail — is reproducible from a recorded seed,
  // so a chosen seed is supplied up front instead of letting fast-check pick
  // an internal one it only reveals on failure.
  const runSeed =
    SEED !== undefined ? SEED : (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(commandArb(), { minLength: 3, maxLength: 12 }), async (cmds) => {
        try {
          const result = await executeSequence(mode, cmds)
          fold(designated, result.designatedTally)
          fold(candidates, result.candidateTally)
        } catch (error) {
          if (error instanceof Divergence) {
            lastDivergence = error
          }
          throw error
        }
      }),
      { numRuns: NUM_RUNS, seed: runSeed },
    )
    const show = (map) => [...map].map(([label, n]) => `${label}=${n}`).join(", ") || "(none)"
    console.log(
      `[formal:${mode}] seed: ${runSeed} runs: ${NUM_RUNS} (reproduce with BTRAIN_FORMAL_SEED=${runSeed} BTRAIN_FORMAL_RUNS=${NUM_RUNS})`,
    )
    console.log(`[formal:${mode}] designated drift ledgered: ${show(designated)}`)
    console.log(`[formal:${mode}] candidate findings tallied: ${show(candidates)}`)
    return { designated, candidates, seed: runSeed }
  } catch (error) {
    const details = {
      seed: String(runSeed),
      counterexamplePath: /Counterexample:[\s\S]*?(\[[\s\S]*?\])/.exec(error.message)?.[1] ?? "",
    }
    const divergence = lastDivergence || error
    const traceFile = await writeFailureTrace(mode, divergence, details)
    assert.fail(
      `${mode} conformance failed (validation_mismatch — divergence outside the documented ledger).\n` +
        `${divergence.message}\n` +
        `Reproduce with BTRAIN_FORMAL_SEED=${runSeed} BTRAIN_FORMAL_RUNS=${NUM_RUNS}.\n` +
        `Trace written to ${traceFile}\n\n${error.message}`,
    )
  }
}

// Real gate: a divergence outside the documented ledger fails as a fresh
// validation_mismatch. Designated drift is ledgered; candidate findings are
// tallied here and surfaced as expected failures by the todo test below —
// neither can hide a new divergence.
test(
  "lane/lock contract conformance (contract mode, ledger gated)",
  { skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness" },
  async () => {
    await runConformance("contract")
  },
)

// Candidate findings are violations of the approved model that are not yet
// designated drift — validation_mismatch verdicts under spec 014, so this
// test FAILS (and the formal gate exits non-zero) while the implementation
// exhibits any of them. It goes green as candidates are fixed or designated.
// The default `npm test` is unaffected (the formal suite is opt-in).
test(
  "candidate findings absent (contract mode — failing means validation_mismatch)",
  { skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness" },
  async () => {
    const { candidates } = await runConformance("contract")
    const summary = [...candidates].map(([label, n]) => `${label}=${n}`).join(", ")
    assert.equal(
      candidates.size,
      0,
      `validation_mismatch: candidate contract violations observed (${summary}). ` +
        "Fix the implementation or designate the behavior in specs 002/005/006; see test/formal/README.md ledger.",
    )
  },
)

// Deterministic classifier check: the close-without-merge chain must ledger
// as designated drift, never fail as an unknown divergence.
test(
  "close-without-merge classifies as designated drift (contract mode)",
  { skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness" },
  async () => {
    const { designatedTally } = await executeSequence("contract", [
      { t: "claim", lane: "x", owner: "alpha", reviewer: "beta", files: ["src/a/"] },
      { t: "update", lane: "x", actorSel: "owner", status: "needs-review" },
      { t: "resolve", lane: "x", actorSel: "reviewer", final: false },
      { t: "update", lane: "x", actorSel: "owner", status: "pr-review" },
      { t: "prOutcome", lane: "x", outcome: "closed" },
    ])
    assert.equal(
      designatedTally.get("close-without-merge"),
      1,
      "the close-without-merge divergence must be ledgered, not unknown",
    )
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
      const { lanes } = await realSnapshot(repo, config)
      assert.equal(lanes.x.status, "resolved", "contract: close without merge is terminal resolved")
      assert.deepEqual(lanes.x.registry, [], "contract: terminal resolved releases the lane's locks")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

// Positive FR-4 witness (spec 005): reviewer findings persist canonically —
// the summary lands in the handoff record and the reason code in lane state.
test(
  "canonical findings: request-changes persists the summary and reason code",
  { skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness" },
  async () => {
    const { root, repo } = await makeRepo()
    try {
      const config = await readProjectConfig(repo)
      await asAgent("alpha", () =>
        claimHandoff(repo, { lane: "x", task: "findings witness", owner: "alpha", reviewer: "beta", files: "src/a/" }),
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
      const summary = "canonical findings witness body 7f3a"
      await asAgent("beta", () =>
        requestChangesHandoff(repo, {
          lane: "x",
          actor: "beta",
          summary,
          "reason-code": "spec-mismatch",
        }),
      )
      const { lanes } = await realSnapshot(repo, config)
      assert.equal(lanes.x.status, "changes-requested")
      assert.equal(lanes.x.reasonCode, "spec-mismatch", "FR-15/spec 005: reason code persists in lane state")
      const record = await fs.readFile(path.join(repo, ".claude/collab/HANDOFF_X.md"), "utf8")
      assert.ok(record.includes(summary), "FR-4: the reviewer's findings persist in the canonical record")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

// Positive FR-18 witness: the implementation escalates a same-reason repair
// re-entry to a human (spec 006 FR-18, spec 014 designation). Guards
// regression of the escalation path.
test(
  "FR-18: same-reason repair re-entry escalates to a human",
  { skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness" },
  async () => {
    const { root, repo } = await makeRepo()
    try {
      const config = await readProjectConfig(repo)
      await asAgent("alpha", () =>
        claimHandoff(repo, { lane: "x", task: "fr18 witness", owner: "alpha", reviewer: "beta", files: "src/a/" }),
      )
      const repair = () =>
        asAgent("alpha", () =>
          patchHandoff(repo, {
            lane: "x",
            actor: "alpha",
            status: "repair-needed",
            "reason-code": "invalid-handoff",
            "no-dispatch": true,
          }),
        )
      await repair()
      await asAgent("alpha", () =>
        patchHandoff(repo, { lane: "x", actor: "alpha", status: "in-progress", "no-dispatch": true }),
      )
      await repair()
      const { repair: repairState } = await realSnapshot(repo, config)
      assert.equal(repairState.x.escalation, "human", "FR-18: second same-reason repair escalates to a human")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test(
  "designated drift witness: --final from needs-review does not skip ready-for-pr",
  {
    skip: ENABLED ? false : "set BTRAIN_FORMAL=1 to run the formal harness",
    todo: "resolveHandoff honors --final from needs-review (designated drift)",
  },
  async () => {
    const { root, repo } = await makeRepo()
    try {
      const config = await readProjectConfig(repo)
      await asAgent("alpha", () =>
        claimHandoff(repo, { lane: "x", task: "final witness", owner: "alpha", reviewer: "beta", files: "src/a/" }),
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
        resolveHandoff(repo, { lane: "x", actor: "beta", final: true, summary: "illegal final" }),
      )
      const { lanes } = await realSnapshot(repo, config)
      assert.equal(lanes.x.status, "ready-for-pr", "contract: reviewer plain resolve enters ready-for-pr; --final is not a bypass")
      assert.deepEqual(lanes.x.registry, ["src/a/"], "contract: ready-for-pr retains locks")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)
