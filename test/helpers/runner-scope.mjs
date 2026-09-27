import { runtimeAgentSignalKeys } from "../../src/brain_train/runtime_agent_hints.mjs"

// Test subprocesses must not inherit a loop runner's lane scope: a bare
// `node --test` run from a lane-locked session would otherwise have its
// spawned btrain commands rejected by the lane-lock allowlist. npm test
// unsets these via `env -u`, but direct invocations bypass that wrapper.
//
// This list must cover everything `buildLoopRunnerEnv` injects
// (src/brain_train/core.mjs). It drifted once: BTRAIN_LOOP_ACTIVE was added to
// the runner env without being added here, so any test run from inside
// `btrain loop` -- which is exactly how a dispatched reviewer runs the suite --
// inherited it. `dispatchNeedsReviewReviewer` then took its nested-dispatch
// guard and returned "skipped" instead of spawning, so the reviewer-dispatch
// tests failed for the eight cases that assert a spawn, while the two that
// assert no spawn kept passing. The handoff update still exited 0, so the
// failure looked like a product bug rather than a leaked variable.
const LANE_SCOPE_KEYS = [
  "BTRAIN_AGENT",
  "BRAIN_TRAIN_AGENT",
  "BTRAIN_LANE",
  "BTRAIN_LANE_LOCKED",
  "BTRAIN_REPO",
  "BTRAIN_LOOP_ACTIVE",
]

// Nor the markers of the agent CLI running the suite (CLAUDECODE,
// CODEX_THREAD_ID, ...). btrain detects the current agent from them, so a run
// from Claude Code would verify as claude in every test repo that configures a
// claude agent, and results would depend on who ran the suite. The list comes
// from the detector, so a new marker is stripped without an edit here.
const AGENT_MARKER_KEYS = runtimeAgentSignalKeys()

/**
 * The variables a test subprocess must not inherit, as one source.
 *
 * Exported so the npm-script guard derives from the same list rather than
 * pinning one variable: adding a seventh here and to `buildLoopRunnerEnv` while
 * forgetting `package.json` used to pass every guard while `npm test` broke
 * under a dispatch exactly as before.
 */
export function laneScopeKeys() {
  return [...LANE_SCOPE_KEYS]
}

export function withoutLaneScope(env = process.env) {
  const clean = { ...env }
  for (const key of [...LANE_SCOPE_KEYS, ...AGENT_MARKER_KEYS]) {
    delete clean[key]
  }
  // Existing tests must not auto-spawn configured claude/codex CLIs when a
  // lane enters needs-review. Opt in with BTRAIN_NO_REVIEW_DISPATCH=0.
  if (clean.BTRAIN_NO_REVIEW_DISPATCH === undefined) {
    clean.BTRAIN_NO_REVIEW_DISPATCH = "1"
  }
  return clean
}

/**
 * Run `fn` with no agent identity in `process.env`: no BTRAIN_AGENT pin and
 * none of the agent CLI markers. For tests that run detection in-process, where
 * the subprocess env from withoutLaneScope does not apply. The previous values
 * are restored afterwards.
 */
export async function withoutAgentIdentity(fn) {
  const keys = ["BTRAIN_AGENT", "BRAIN_TRAIN_AGENT", ...AGENT_MARKER_KEYS]
  const saved = {}
  for (const key of keys) {
    if (key in process.env) {
      saved[key] = process.env[key]
    }
    delete process.env[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of keys) {
      delete process.env[key]
    }
    Object.assign(process.env, saved)
  }
}
