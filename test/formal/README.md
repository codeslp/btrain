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
  `patchHandoff`, `requestChangesHandoff`, `resolveHandoff`, `disposeRepair`
  (spec 006 FR-29 `btrain repair dispose`), `releaseLocks`, and
  `applyPrStatusToHandoff` against throwaway repos and compares every step
  with the model.

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
| contract mode (ledger gated) | Real behavior vs the designated contract; candidate findings are tallied, each divergent lane is adopted so the rest of the sequence stays checked | Must pass; a divergence outside the candidate ledger fails as `validation_mismatch`. No designated drift remains — a reappearance fails |
| candidate findings absent | Asserts the candidate tally is empty | FAILS while ledger candidates 4-11 sit in their spec 015 FR-5 advisory windows (6 and 11 since spec 016 WS3 on 2026-09-08; 4, 5, 7, 9, 10 since WS4 on 2026-09-09): the implementation still accepts the legacy paths with a `transition-advisory` record, contract mode still rejects them, so the tally persists by design until the enforcement lanes land. The formal verdict is `validation_mismatch` and the suite exits non-zero (spec 014 blocks on it) |
| implementation mode | Real behavior vs the implementation mirror | Must pass; a failure means a new, unknown divergence |
| closed-chain check | Deterministic close-without-merge chain | Must pass with zero tallies: the chain conforms end to end |
| FR-18 witness | Same-reason repair re-entry | Must pass: the implementation escalates to a human (verified working) |
| repaired-drift witnesses | Close-without-merge, `--final` rejection, unaudited-release rejection | Must pass: normal regression tests since the drift-repair lane |

A contract-mode failure is a fresh `validation_mismatch` verdict in spec 014
terms: a divergence no ledger entry explains. Candidate findings never pass
silently — they fail the dedicated gate test, so `npm run test:formal` exits
non-zero while any exist. An implementation-mode failure is a regression
signal: real behavior moved away from the recorded reality.

## Findings ledger

Repaired designated drift (fixed in the drift-repair lane; each is guarded
by a passing regression witness, and a reappearance fails contract mode as
an unknown divergence):

1. Close-without-merge routes to `repair-needed` instead of terminal
   `resolved` plus lock release (`src/brain_train/pr-flow.mjs`,
   `applyPrStatusToHandoff`).
2. `btrain locks release-lane` drops registry entries with no audited
   override and leaves the handoff locked-file record behind.
3. `handoff resolve --final` from `needs-review` or a PR-flow status
   terminally resolves. Spec 002 requires plain resolve into `ready-for-pr`.

Candidate findings surfaced by harness runs. All are now designated: 6, 8,
and 11 by spec 016 WS3 (2026-09-08), and 4, 5, 7, 9, 10 by WS4 (2026-09-09,
spec 002 resolve/update/claim authority and PR-flow non-terminal outcomes,
spec 005 FR-5 reassignment, spec 006 FR-18 and FR-2, spec 014 rescope/resync
split). The implementation accepts each legacy path with a `transition-advisory`
record during the spec 015 FR-5 window; contract mode rejects it, so every
label below keeps tallying until the enforcement lanes retire the rows, when
the labels become regressions. Label notes: `pr-outcome-source-status` also
covers a non-terminal outcome on a `changes-requested` reached by a local
`request-changes` (not PR-flow feedback); `rescope-authorization` also covers a
resync by a non-owner (`resync-requires-owner`).

4. `resolveHandoff` still permits non-reviewer approval from `needs-review`
   while legacy row L8 is in its required advisory window. It also permits a
   lane agent to resolve from PR-flow statuses and terminally release retained
   locks. The designated contract assigns `ready-for-pr` entry to the reviewer
   and terminates PR-flow lanes through merge or closure.
5. `resolveHandoff` resolves an idle, never-claimed lane. When the lane's
   handoff file is absent it also falls back to repo-level state and writes a
   `Previous Handoffs` entry into a newly created lane file using another
   lane's task text (reproduced 2026-09-01).
6. When the reviewer (not the owner) moves a lane to `needs-review`,
   `inferPeerReviewer` reassigns the reviewer to the owner. The lane then
   waits for review with reviewer == owner, which breaks owner/reviewer
   separation. **WS3 (2026-09-08):** the reassignment is repaired
   (`inferPeerReviewer` now excludes the owner, not the actor; spec 015
   FR-9) and the non-owner handoff itself is accepted with
   `transition-advisory: L3` until enforcement. Contract mode still rejects
   it (`needs-review-requires-owner`), so the tally persists by design.
7. `patchHandoff` validates the target status name but not the source
   status: `needs-review` from `resolved`, `pr-review` from `in-progress`,
   and direct `ready-to-merge` updates are all accepted.
8. `patchHandoff` crashes with a raw `ENOENT` (not a `BtrainError`) when the
   lane has never been claimed. **Closed (WS2/WS3):** a missing lane handoff
   file is a `BtrainError` naming the restore step in `patchHandoff`,
   `resolveHandoff`, and `disposeRepair`; `test/core.test.mjs` carries the
   regression test. The harness's `ENOENT` tolerance stays as a guard.
9. `applyPrStatusToHandoff` with an explicit `--pr` applies the non-terminal
   outcomes (`waiting`, `feedback`, `ready-to-merge`) from any lane status,
   so an `in-progress` lane can enter `pr-review` without peer approval.
   The terminal half (merged or closed from a non-PR-flow lane) was repaired
   in PR #33 and is now rejected.
10. `patchHandoff --files` (the designated rescope path) enforces no actor
    or source-status restrictions: any agent can rescope any active lane,
    including during `needs-review` and PR-flow retention, against the
    spec 014 rescope designation.
11. `resolveHandoff` resolves a `repair-needed` lane before the FR-18
    escalation, releasing contained locks early. Spec 014 designates repair
    exit-to-resolved only as a terminal disposition after escalation.
    **WS3 (2026-09-08):** spec 006 FR-29 now owns the rule and both exits
    exist in code: `btrain repair dispose --lane <id> --confirmed-by <human>
    --reason "..."` writes the `repair-disposition` event (only after the
    escalation), and `btrain override grant --action repair-resolve` is
    consumed by the resolve. A plain resolve that meets neither condition is
    accepted with `transition-advisory: L7` until enforcement; contract mode
    rejects it (`repair-resolve-before-escalation`, now meaning "before a
    recorded human decision"), so the tally persists by design. The model's
    `dispose` op and the harness's `dispose` command exercise the legal path.

Mirror maintenance: after PR #33 the implementation mirror still accepted
terminal PR outcomes from any status, so implementation mode reported a
`validation_mismatch` that was a stale double, not a regression. Fixed on
2026-09-01; implementation mode is a regression signal again.

Verified working (positive witnesses): spec 006 FR-18 same-reason repair
re-entry escalates to a human (`repairEscalation: "human"`, attempts
counted).

Observed during this lane's own workflow (not harness-derived): the pre-push
guard blocks all pushes while any lane is `in-progress`, including pushes
that only carry another lane's reviewed work.

## Known gaps

- Spec 015 Q4 (Option A), designated in spec 006 FR-18 on 2026-09-09: a
  fresh claim resets the FR-18 repair count and `RepairClear` does not. The
  implementation counts only entries after the most recent claim
  (`countRepairEntries` via `eventsSinceLastClaim`) and the mirror resets
  `repairReasonsSeen` on claim. `test/core.test.mjs` carries the
  production-level reclaim regression (the harness does not compare
  attempt-counting internals).
- The override exit from `repair-needed` (spec 006 FR-29, `repair-resolve`
  override) is not generated by the harness: throwaway repos grant no
  overrides. `test/core.test.mjs` covers it end to end.
- PR-flow `changes-requested` provenance: the implementation reads the
  workflow event that entered `changes-requested` (`details.transitionEvent
  === "pr-poll"`); the mirror uses the lane's reason code
  (`pr-review-feedback`) as a stand-in. They agree in the harness because its
  only path into `changes-requested` with that reason is `prOutcome`
  (`applyPrStatusToHandoff`) and its `requestChanges` always writes
  `spec-mismatch`. A forged reason code from the CLI is covered by
  `test/core.test.mjs` (the shortcut then records L4).

- Crash-window injection (partial failure between the lock-registry write
  and the handoff write) is not exercised yet.
- Concurrent interleavings are not exercised; runs are sequential.
- The FR-18 comparison checks escalation presence on same-reason re-entry,
  and the FR-7 comparison checks the assigned repair owner (most recent
  canonical actor before the repair). The implementation's attempt-counting
  internals are not designated and not compared.
- Traces are harness-internal JSON; export to TLC trace-validation format is
  future work once `specs/tla/` exists.
