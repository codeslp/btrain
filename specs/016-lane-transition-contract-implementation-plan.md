# Plan: Implement the Lane Transition Contract (spec 015)

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-09-01

## Summary

This plan turns spec 015 into an ordered sequence of lanes. It interleaves
with spec 014 rather than following it: spec 014 Phase 3 cannot switch on
until the harness candidate tally is zero, and spec 015 is how each candidate
reaches a designation. The plan therefore does not "finish 014 first". It
merges the two open 014 PRs, ships the behavior-preserving half of 015, and
then retires ledger findings one designation at a time until the 014 gate can
close.

One rule holds throughout: prose lands before model, model before code, and no
row in the production list is enforced until its owning prose exists.

Primary input:

- [specs/015-lane-transition-contract.md](015-lane-transition-contract.md)
- [specs/014-specula-formal-verification-pilot.md](014-specula-formal-verification-pilot.md)
- [specs/checklists/015-transition-contract.md](checklists/015-transition-contract.md)
- [test/formal/README.md](../test/formal/README.md)

## Review Goals

Review this plan for:

- whether any workstream edits a section pinned by `LaneLock.tla` before PR #35 merges
- whether the structural half (WS2) can regress observable CLI behavior
- whether every semantic step cites the prose that lands first
- missing rollback points
- whether lane locks in this repository make a step unclaimable when scheduled
- whether the human decisions are isolated so they do not block unrelated steps

## Repo-Local Grounding

Verified on 2026-09-01 against this checkout:

- `npm test`: 546 passing, 9 skipped.
- `npm run test:formal`: exits 1. The candidate gate fails as designed
  (`resolve-from-idle`, `update-actor-unchecked`, `update-source-status`
  tallied). The implementation-mode test also fails because the mirror in
  `test/formal/lane-lock-model.mjs:377-386` predates PR #33; that failure is
  stale, not a regression.
- `LaneLock.tla` pin hash on PR #35 equals the hash of the current `main`
  prose (`90cb7554…613ed`), so #35 is mergeable against `main` as long as no
  pinned section changes first.
- Lane locks: lane `b` (PR #34, codex) holds `src/brain_train/` and `test/`;
  lane `j` (PR #35, codex) holds `scripts/tla_pin.py` and `specs/tla/`; lane
  `e` (claude) holds `README.md` and `docs/`.
- Lane and lock state is local (`.claude/collab/HANDOFF_*.md` and
  `.btrain/locks.json` are untracked), so branch switches do not move it.

## Implementation Principles

- btrain stays the workflow authority; no graph runtime is added.
- Zero runtime dependencies. `fast-check` stays a dev dependency.
- The production list, `LaneLock.tla`, and `lane-lock-model.mjs` are three
  hand-authored transcriptions of prose. None is generated from another.
- Legacy rows preserve current behavior until prose retires them.
- Every step that touches a modeled entry point carries a spec 014
  formal-impact declaration.
- Pinned sections are edited only inside the lane that also repins
  `LaneLock.tla`, so the pin never goes stale on `main`.
- Advisory before enforcement for every behavior change agents rely on today.

## First-Version Decisions

### Interleave 014 and 015

Spec 014 Phase 3 depends on the designations spec 015 packages. Waiting for
014 to "finish" would wait on 015. The order below alternates between them.

### Merge the open 014 PRs before any code lane

PR #34 holds the source and test locks. PR #35 holds the model and pin script.
WS2 and WS3 cannot be claimed until #34 merges, and WS4 cannot edit pinned
prose until #35 merges.

### Prose that is unpinned ships first

Spec 005 FR-7, a new spec 006 FR-29, and the stale drift notes in spec 002
outside its pinned sections do not touch the pin. They land in WS1, in
parallel with the open PRs.

### The structural half ships as one lane

`transitions.mjs`, the gate, the watchdog rerouting, the `ENOENT` fix, the
cross-check test, and the exporter are one reviewable change with an
all-or-nothing rollback.

### Human decisions are batched

The eight open questions in spec 015 are collected into one decision request
(WS0) so WS4 is not blocked question by question.

## Dependency Diagram

```mermaid
flowchart TD
    PR34["PR #34 merge (lane b: codex)"] --> WS2["WS2 Phase A structural gate"]
    PR35["PR #35 merge + line 77 reconciliation (lane j: codex)"] --> WS4["WS4 Phase B pinned designations (#4 #5 #7 #9 #10)"]
    WS1["WS1 unpinned prose (this lane k)"] --> WS3["WS3 Phase B unpinned designations (#6 #8 #11)"]
    WS2 --> WS3
    WS2 --> WS4
    WS0["WS0 human decisions (8 questions)"] --> WS4
    WS3 --> WS5["WS5 spec 014 Phase 3 gate on"]
    WS4 --> WS5
```

## Workstreams

### Workstream 0: Human decisions

**Goal**: answer the eight open questions in spec 015 so WS4 has designated
rules to encode.

**Primary changes**

- one decision record, either as answers appended to spec 015 Open questions
  or as a short decision section in spec 002 once it reopens
- questions 1 (PR-feedback shortcut), 2 (doctor as guardian for resync), 3
  (override exit from repair), 4 (FR-18 budget across re-claims), 5 (who may
  abandon an in-progress lane), 6 (unverified actor policy), 7 (who may declare
  `repair-needed` manually), 8 (owner reassignment)

**Owner**: a human. No agent may decide these.

**Blocked by**: nothing. Can start today.

### Workstream 1: Unpinned prose (this lane)

**Goal**: land every prose change that does not touch a pinned section.

**Primary changes**

- spec 015 v0.1.1 and its requirements checklist
- this plan
- spec 005 FR-7: only the lane owner may move a lane to `needs-review`;
  btrain rejects other actors rather than reassigning the reviewer (finding 6)
- spec 006 FR-29 `repair-needed` transitions: entry from active statuses
  only; exits to `in-progress` by the repair actor or to `resolved` after
  FR-18 escalation or through the FR-2c/2d override; no other exit
  (finding 11). Adopts the spec 014 provisional designation with the override
  exit added
- spec 002 lines 9, 87, 91: describe the three PR #33 repairs as repaired.
  These lines are outside every pinned section

**Likely files**

- [specs/015-lane-transition-contract.md](015-lane-transition-contract.md)
- [specs/016-lane-transition-contract-implementation-plan.md](016-lane-transition-contract-implementation-plan.md)
- [specs/checklists/015-transition-contract.md](checklists/015-transition-contract.md)
- [specs/002-multi-lane-handoffs.md](002-multi-lane-handoffs.md)
- [specs/005-review-findings-rework-loop.md](005-review-findings-rework-loop.md)
- [specs/006-workflow-resilience-and-guardian.md](006-workflow-resilience-and-guardian.md)

**Tests**

- the pin hash recomputed with the PR #35 `tla_pin.py` algorithm over the
  current pinned sections equals the recorded hash after the edits
- `btrain review code --lane k --base main` exits 0

**Formal impact**: none. Code-free; pin check only (spec 014 FR-7).

**Blocked by**: nothing.

### Workstream 2: Phase A structural gate

**Goal**: one gate, identical behavior.

**Primary changes**

- fix the stale implementation mirror in `lane-lock-model.mjs:377-386` so
  `npm run test:formal` fails only on the candidate gate
- reword ledger #9 (terminal half repaired in PR #33) and extend #5 (missing
  file reads repo state and fabricates history)
- add `src/brain_train/transitions.mjs` with rows 1-20 and L1-L7 from spec 015
  as data, `owner` and `state` included
- add `applyTransition` and route `claimHandoff`, `patchHandoff`,
  `requestChangesHandoff`, `resolveHandoff`, `applyPrStatusToHandoff`, the
  `pr create` status write (`pr-flow.mjs:937`), and `applyWatchdogRepairs`
  (`core.mjs:8717`) through it, inside the existing registry critical section
- replace the raw `ENOENT` at `core.mjs:5185` with a `BtrainError`
- fix `resolveHandoff`'s missing-file fallback at `core.mjs:5680-5685` so it
  never reads repo-level state for a lane
- keep `inferPeerReviewer` from replacing a valid reviewer (spec 015 FR-9)
- add the cross-check test with guard fixtures (spec 015 FR-7), legacy rows
  excluded
- add `btrain transitions --format json|mermaid`; make
  `defaultNextActionForStatus`, `buildLaneGuidance`, and
  `describeLoopAgentReason` read the list

**Likely files**

- [src/brain_train/core.mjs](../src/brain_train/core.mjs)
- [src/brain_train/pr-flow.mjs](../src/brain_train/pr-flow.mjs)
- [src/brain_train/cli.mjs](../src/brain_train/cli.mjs)
- new `src/brain_train/transitions.mjs`
- [test/formal/lane-lock-model.mjs](../test/formal/lane-lock-model.mjs)
- [test/formal/lane-lock-harness.test.mjs](../test/formal/lane-lock-harness.test.mjs)
- [test/formal/README.md](../test/formal/README.md)
- new `test/transitions.test.mjs`

**Tests**

- full suite unchanged: 546 passing before and after
- `npm run test:formal`: implementation mode passes; contract-mode candidate
  tally names the same labels as before the change
- cross-check test passes
- one regression test per fixed defect: `ENOENT`, missing-file resolve,
  reviewer inference
- `btrain transitions --format json` lists 27 rows

**Formal impact**: no semantic impact, touches modeled entry points and the
harness. Pin check plus focused implementation validation plus focused harness
run before review (spec 014 FR-7).

**Rollback**: revert the merge commit. No new fields are written to handoff
files or `locks.json` in this phase.

**Blocked by**: PR #34 (lane `b` locks).

### Workstream 3: Phase B unpinned designations

**Goal**: retire L3 (finding 6) and L7 (finding 11), and close finding 8.

**Primary changes**

- model: add `RepairResolve` override guard to `LaneLock.tla` and
  `lane-lock-model.mjs` (spec 006 FR-29); repin
- advisory: row 2 actor guard and row 15 escalation-or-override guard record
  `transition-advisory` and warn
- after the advisory window (spec 015 FR-5): enforce, remove L3 and L7
- ledger: mark 6, 8, 11 closed; harness candidate labels
  `update-actor-unchecked` (needs-review case) and
  `repair-resolve-before-escalation` become regressions

**Likely files**

- `src/brain_train/transitions.mjs`, `specs/tla/LaneLock.tla`,
  `test/formal/lane-lock-model.mjs`, `test/formal/README.md`,
  `test/core.test.mjs`

**Tests**

- `test/core.test.mjs:4972` is rewritten: `repair-needed -> needs-review` is
  rejected, `repair-needed -> in-progress -> needs-review` is the legal path
- TLC passes with the modified `RepairResolve`
- advisory events appear in the workflow log for one exercised legacy path

**Formal impact**: semantic. Prose (WS1) first, model, then code.

**Blocked by**: WS1 merged, WS2 merged, and lane `j` released so `specs/tla/`
can be locked (PR #35 merge).

### Workstream 4: Phase B pinned designations

**Goal**: retire L1, L2, L4, L5, L6 (findings 4, 5, 7, 9, 10).

**Primary changes**

- spec 002 `CLI Commands`: resolve requires an active lane; resolve from a
  PR-flow status is rejected; who may abandon an `in-progress` lane (WS0 Q5)
- spec 002 `PR-flow states and actors`: source statuses per row; row 12
  decision (WS0 Q1); `ready-to-merge -> pr-review` decision; line 77
  reconciliation if PR #35 did not already do it
- spec 014 `Normative-source prerequisite`: point repair exits at spec 006
  FR-29; split rescope from resync (WS0 Q2)
- spec 005 `Proposed Status Model`: no change expected; confirm
- repin `LaneLock.tla`; add `ReturnToPr`, `Resync`, and `Reassign` actions if
  designated; TLC
- production rows 6, 12, 17, 20 move from `undesignated` to `designated`
  or are removed
- advisory then enforce; remove L1, L2, L4, L5, L6
- rewrite `test/core.test.mjs:1495-1503`, `test/core.test.mjs:1539`,
  `test/watchdog.test.mjs:122` to the designated paths

**Likely files**

- `specs/002-multi-lane-handoffs.md`, `specs/014-specula-formal-verification-pilot.md`,
  `specs/tla/LaneLock.tla`, `specs/tla/.tlc-results/LaneLock.json`,
  `src/brain_train/transitions.mjs`, `test/formal/*`, `test/core.test.mjs`,
  `test/watchdog.test.mjs`

**Tests**

- TLC passes on the widened model; the mutation check in
  `specs/tla/README.md` still reports a violation when a guard is removed
- candidate tally reaches zero; the `candidate findings absent` gate test
  passes and is then retired

**Formal impact**: semantic. Independent model-family review required (spec
014 FR-9).

**Blocked by**: PR #35 merged, WS0 answered, WS2 merged.

### Workstream 5: Spec 014 Phase 3

**Goal**: block stale pins, counterexamples, and validation mismatches for the
pilot model in CI.

**Primary changes**

- flip the advisory CI job to blocking for `LaneLock.tla`
- adopt the exhaustion and tool-unavailable policy spec 014 requires

**Blocked by**: WS3 and WS4 (zero candidate tally).

## Sequencing

| Step | Work | Owner | Blocked by | Status 2026-09-01 |
| --- | --- | --- | --- | --- |
| 1 | WS0 decisions | human | none | open |
| 2 | WS1 unpinned prose | claude, lane `k` | none | in progress |
| 3 | PR #34 feedback and merge | codex, lane `b` | codex bot feedback | changes-requested |
| 4 | PR #35 feedback, line 77 reconciliation, merge | codex, lane `j` | codex bot feedback | changes-requested |
| 5 | WS2 structural gate | any agent | step 3 | blocked |
| 6 | WS3 unpinned designations | any agent | steps 2, 4, 5 | blocked |
| 7 | WS4 pinned designations | any agent | steps 1, 4, 5 | blocked |
| 8 | WS5 014 Phase 3 | any agent | steps 6, 7 | blocked |

Steps 1 and 2 run now. Steps 3 and 4 belong to codex's lanes and are not
touched by this lane. Steps 5 through 8 follow.

## Rollback Points

- After step 2: revert the docs commit; nothing else depends on it yet.
- After step 5: revert the merge; no persisted data changed.
- After each enforcement in steps 6 and 7: flip the row back to advisory
  (one-line change) while the prose stays; the model is unaffected.

## Acceptance Criteria

- Every spec 015 row has a `state` other than `legacy` or `undesignated`, or
  an open question naming the human decision it waits on.
- `npm run test:formal` passes with the candidate gate retired.
- Spec 014 Phase 3 is on for `LaneLock.tla`.
- No step edited a pinned section outside the lane that repinned the model.
