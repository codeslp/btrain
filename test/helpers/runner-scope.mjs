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

export function withoutLaneScope(env = process.env) {
  const clean = { ...env }
  for (const key of LANE_SCOPE_KEYS) {
    delete clean[key]
  }
  // Existing tests must not auto-spawn configured claude/codex CLIs when a
  // lane enters needs-review. Opt in with BTRAIN_NO_REVIEW_DISPATCH=0.
  if (clean.BTRAIN_NO_REVIEW_DISPATCH === undefined) {
    clean.BTRAIN_NO_REVIEW_DISPATCH = "1"
  }
  return clean
}
