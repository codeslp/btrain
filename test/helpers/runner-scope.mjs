// Test subprocesses must not inherit a loop runner's lane scope: a bare
// `node --test` run from a lane-locked session would otherwise have its
// spawned btrain commands rejected by the lane-lock allowlist. npm test
// unsets these via `env -u`, but direct invocations bypass that wrapper.
const LANE_SCOPE_KEYS = [
  "BTRAIN_AGENT",
  "BRAIN_TRAIN_AGENT",
  "BTRAIN_LANE",
  "BTRAIN_LANE_LOCKED",
  "BTRAIN_REPO",
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
