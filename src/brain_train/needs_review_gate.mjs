// spec 015 rows 2 and 19: how much of the needs-review gate an update meets.
//
// Row 2 gates the move into `needs-review`: complete reviewer context, a
// reviewable diff in the locked files (or --no-diff, or a consumed override),
// the code-simplifier line for a multi-file diff, and the cgraph review packet
// and audit. Row 19, an update that changes only metadata, leaves a lane that
// is already in review where row 2 put it, so the diff and cgraph checks stay
// with that transition (the reading Brian Farish chose on 2026-09-30). Only
// completeness follows the lane: an update that edits the reviewer context or
// its base must leave the context complete. An update with --status, --files,
// --owner, or --reviewer still meets the whole gate.

// Any of these makes an update more than metadata (spec 015 row 19).
const NON_METADATA_FLAGS = ["status", "files", "owner", "reviewer"]
// The inputs of the reviewer-context completeness check.
const REVIEW_CONTEXT_FLAGS = ["base", "preflight", "changed", "verification", "gap", "why", "review-ask"]

// Returns "full" (row 2's whole gate), "context" (the completeness check
// only), or "" (no gate).
export function needsReviewGateScope(options, nextStatus) {
  if (nextStatus !== "needs-review") return ""
  if (NON_METADATA_FLAGS.some((flag) => options[flag] !== undefined)) return "full"
  return REVIEW_CONTEXT_FLAGS.some((flag) => options[flag] !== undefined) ? "context" : ""
}
