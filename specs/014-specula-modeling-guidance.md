# Target-Specific Modeling Guidance: btrain Lane and Lock Pilot

## Goal

- Determine whether btrain's committed workflow behavior preserves lane, actor,
  lock, review, PR, and repair contracts under concurrent and failed operations.
- Produce evidence suitable for deciding whether focused formal checks should
  become a btrain review and CI gate.

## Scope

- In scope: lane status changes, owner and reviewer authority, lock acquisition
  and release, review/rework routing, PR lifecycle, and repair escalation.
- Boundaries/exclusions: do not model all of btrain, AgentChatTR, Git, GitHub,
  subprocess internals, dashboard rendering, or coding-agent reasoning.
- Treat intended prose as the contract to test. Do not infer that current code is
  correct and do not silently rewrite intended behavior to match it.

## Priority Questions

1. When two lanes claim overlapping paths or claim/update operations interleave,
   can both lanes become active with overlapping locks?
   Expected behavior: active lanes have exclusive, matching lock coverage, except after a verified spec 006 audited override consumed by `btrain locks release` / `release-lane`. That trace must set an uncovered/override flag. An unaudited CLI release (no grant/consume, no human confirm) is drift, not a valid uncovered trace.
2. When a lane changes status, can an actor other than the contractually assigned
   owner, reviewer, repair owner, or PR-flow actor advance it?
   Expected behavior: every transition is authorized and routes the correct next actor.
3. When local review, PR feedback, merge, closure, or repair occurs, can locks be
   released too early, retained after terminal completion, or diverge from the
   handoff record?
   Expected behavior: lock retention and release follow spec 002 v1.1.2: retain through PR-flow states; release on merge, close-without-merge (terminal resolved, not repair-needed), terminal resolved, or audited force-release.
4. When review requests changes or PR bots return feedback, can the lane lose its
   reviewer, owner, findings, or same-lane rework path?
   Expected behavior: rework remains active, canonical, and routed to the writer.
5. When the same unresolved repair reason recurs, can automated repair avoid or
   exceed the approved human-escalation bound?
   Expected behavior: one meaningful failed repair cycle leads to human escalation.

## Must-cover Interactions

- CLI transition validation ↔ canonical handoff persistence ↔ workflow event log.
- Handoff persistence ↔ lock registry updates, including partial-failure windows.
- Local peer approval ↔ PR-flow status updates ↔ final lock release.
- Watchdog diagnosis ↔ repair assignment ↔ repeat-attempt counting and escalation.

## Assumptions

- GitHub, filesystem, subprocess, provider, and agent outcomes may occur
  nondeterministically; the pilot checks btrain's response to those outcomes.
- Normative prose must be reconciled before a generated model is approved.

## Known Incidents and References

- Spec 002 v1.1.2 designates lock release. Remaining mismatch: current
  `applyPrStatusToHandoff` sends GitHub close-without-merge to `repair-needed`
  while the contract is terminal `resolved` plus lock release. Model the
  contract; treat the JS path as a candidate counterexample.
- `btrain locks release-lane` currently drops registry entries without a spec
  006 override grant/consume and without updating the handoff locked-file
  record. Treat that unaudited path as drift. Suspend matching coverage only
  after a verified override event.
- The bundled formal skills currently cite nonexistent spec 002 sections and the
  pin workflow no-ops because no formal artifacts exist.

## Suggested Starting Points

- `src/brain_train/core.mjs:claimHandoff`: lane claim and lock acquisition.
- `src/brain_train/core.mjs:patchHandoff`: status, lock, and repair updates.
- `src/brain_train/core.mjs:requestChangesHandoff`: reviewer-driven rework.
- `src/brain_train/core.mjs:resolveHandoff`: local approval and terminal resolution.
- `src/brain_train/core.mjs:resolveRepairAssignment`: repair bounds and escalation.
- `src/brain_train/pr-flow.mjs:applyPrStatusToHandoff`: external PR outcomes.
