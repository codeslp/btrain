# Formal Validation Harness (spec 014 FR-6)

This directory holds the code-to-model validation harness for the lane/lock
pilot. It checks that real btrain behavior conforms to the designated
contract, using fast-check model-based command sequences per spec 014 FR-6.

## Files

- `lane-lock-model.mjs` — executable transcription of the designated contract
  (spec 014 v0.1.9 exact normative ranges). The model cites its sources
  inline. It is btrain-owned prose-derived work: change it only with a
  formal-impact declaration.
- `lane-lock-harness.test.mjs` — the harness. It drives `claimHandoff`,
  `patchHandoff`, `requestChangesHandoff`, `resolveHandoff`, `releaseLocks`,
  and `applyPrStatusToHandoff` against throwaway repos and compares every
  step with the model.

## Run

```bash
npm run test:formal
```

Environment knobs:

- `BTRAIN_FORMAL=1` — enables the tests (the default suite skips them).
- `BTRAIN_FORMAL_RUNS` — property runs per mode (default 15).
- `BTRAIN_FORMAL_SEED` — reproduce a recorded failure.
- `BTRAIN_FORMAL_TRACE_DIR` — where failing traces are written (default:
  `$TMPDIR/btrain-formal-traces`).

Every failure prints its seed and writes a JSON trace. This satisfies the
FR-6 requirements for trace emission and seed reproducibility. Runs need no
agent or provider credentials.

## Modes and verdicts

| Test | Meaning | Expected today |
| --- | --- | --- |
| contract mode | Real behavior vs the designated contract | Must pass except for classified designated drift (close-without-merge, unaudited release, `--final` from PR-flow). A new mismatch fails the suite. |
| implementation mode | Real behavior vs a model that mirrors known drift | Must pass; a failure means a new, unknown divergence |
| drift witnesses (todo) | Deterministic close-without-merge and `--final` sequences, contract asserted | Stay red until the JS is repaired; they do not todo the random property |

A contract-mode failure is a `validation_mismatch` verdict in spec 014 terms.
An implementation-mode failure is a regression signal: real behavior moved
away from the recorded reality.

## Findings ledger

Designated drift (already recorded in spec 002 v1.1.2 and the modeling brief):

1. Close-without-merge routes to `repair-needed` instead of terminal
   `resolved` plus lock release (`src/brain_train/pr-flow.mjs`,
   `applyPrStatusToHandoff`).
2. `btrain locks release-lane` drops registry entries with no audited
   override and leaves the handoff locked-file record behind.
2b. `handoff resolve --final` from `needs-review` or a PR-flow status
    terminally resolves. Spec 002 requires plain resolve into `ready-for-pr`.

Candidate findings surfaced by harness runs (need designation decisions in
spec 002/005/006 before the model treats them as normative):

3. `resolveHandoff` never checks the acting agent against the lane. Any
   configured agent can approve `needs-review` into `ready-for-pr` or resolve
   any lane. The designated contract assigns `ready-for-pr` entry to the
   reviewer.
4. `resolveHandoff` resolves an idle, never-claimed lane.
5. When the reviewer (not the owner) moves a lane to `needs-review`,
   `inferPeerReviewer` reassigns the reviewer to the owner. The lane then
   waits for review with reviewer == owner, which breaks owner/reviewer
   separation.
6. `patchHandoff` validates the target status name but not the source
   status: `needs-review` from `resolved`, `pr-review` from `in-progress`,
   and direct `ready-to-merge` updates are all accepted.
7. `patchHandoff` crashes with a raw `ENOENT` (not a `BtrainError`) when the
   lane has never been claimed.
8. `applyPrStatusToHandoff` with an explicit `--pr` applies outcomes from any
   lane status, so a merged PR can terminally resolve an `in-progress` lane.

Observed during this lane's own workflow (not harness-derived): the pre-push
guard blocks all pushes while any lane is `in-progress`, including pushes
that only carry another lane's reviewed work.

## Known gaps

- Rescoping (`handoff update --files`) is not a generated command yet. The
  designated rescope contract (spec 014 v0.1.9) needs a model transition and
  a generator entry.
- Crash-window injection (partial failure between the lock-registry write
  and the handoff write) is not exercised yet.
- Concurrent interleavings are not exercised; runs are sequential.
- Repair-attempt counting and the spec 006 FR-18 escalation bound are not
  compared.
- Traces are harness-internal JSON; export to TLC trace-validation format is
  future work once `specs/tla/` exists.
