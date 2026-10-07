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
- `lane-lock-model-same-status.test.mjs` — checks that contract mode reads a
  `--status` equal to the lane's current status as a spec 015 row 19
  identity update. It runs in the default `npm test`; the harness's
  same-status witnesses run the same writes against the real entry points.
- `lane-lock-model-fr18.test.mjs` — checks the model's spec 006 FR-18 repair
  memory in both modes. It runs in the default `npm test`; the harness's FR-18
  repair-memory witnesses run the same cases against the real entry points.
- `lane-lock-model-doctor.test.mjs` — checks how the model's `doctorRepair`
  handles a resync that conflicts with another lane's lock (spec 015 rows 17
  and 13) in both modes. It runs in the default `npm test`; the harness's
  doctor resync conflict witnesses run the same cases against the real
  `doctor --repair`.

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
| FR-18 repair-memory witnesses | Repair entries, clears, a reclaim, and a doctor entry, each closed by a dispose | Must pass: model and implementation agree on every escalation (five cases in both modes, two in implementation mode only) |
| same-status witnesses | `--status X` on a lane already in X, for each modeled status and actor, plus a new-reason `repair-needed` re-write | Must pass: a spec 015 row 19 identity update in both modes; contract mode tallies only a third agent's write (`metadata-actor-unchecked`) |
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

Harness-found implementation defect, repaired 2026-09-30:

12. `patchHandoff` refused a metadata-only update (no `--status`, `--files`,
    `--owner`, or `--reviewer`) on a `resolved` lane. It took the lane's own
    `resolved` status as the next status and hit the guard for `--status
    resolved`, whose fix text (resolve again) is the repeat resolve that
    spec 002 rejects (L14). Spec 015 row 19 allows the update in any status,
    and spec 002 update authority names only its actor. Implementation mode
    found it with `BTRAIN_FORMAL_SEED=-1468514561` (resolve an idle lane,
    then update its metadata), and contract mode with `-154424753` (claim,
    owner abandon resolve by row 6, owner metadata update). The harness had
    scored a roleless reassign as accepted without consulting the model, so
    row 19 was never checked: not in `resolved`, not its lane-agent actor
    (L12), and not the FR-7 canonical actor that the update records.
    Repaired: `patchHandoff` exempts the metadata-only case, read from the
    four flags because a caller can supply `transitionEvent`; `--status
    resolved`, and files or roles on a resolved lane, stay rejected (rows
    16, 17, and 20 have no resolved source). The model's `metadata` op
    transcribes row 19, and a reassign draw with neither role runs as
    `metadata`. `test/handoff-update-resolved.test.mjs`, the row 19
    witnesses here, and the `test/transitions.test.mjs` cross-check fixtures
    guard it. Two differences remain: a metadata update of a resolved lane
    whose registry still holds stale entries releases them, as idle lanes
    already did, although row 19 says locks unchanged (harness runs never
    leave stale entries on an inactive lane); and `LaneLock.tla` has no
    metadata action, so the `lastActor` effect is mirror-only and belongs in
    the `specs/tla/README.md` known-differences list.

Mirror maintenance: after PR #33 the implementation mirror still accepted
terminal PR outcomes from any status, so implementation mode reported a
`validation_mismatch` that was a stale double, not a regression. Fixed on
2026-09-01; implementation mode is a regression signal again.

Mirror maintenance, 2026-10-01: the implementation mirror's `update` set the
status and returned before the FR-18 bookkeeping. After a same-reason repair
re-entry it still expected no escalation, so it rejected the disposition
(`dispose-requires-escalation`) that `disposeRepair` accepts. Random seeds
rarely draw that sequence; a review of the model found it. The mirror now
records each `repair-needed` entry the way `resolveRepairAssignment` counts
it, in `update` and in `doctorRepair`. An entry comes from another status. It
escalates when an earlier entry since the last claim had the same reason, and
a write while the lane is already `repair-needed` keeps the recorded
escalation. An entry also voids an earlier repair's disposition, because
`hasRepairDisposition` reads only dispositions recorded after the latest
entry. The FR-18 repair-memory witnesses and `lane-lock-model-fr18.test.mjs`
guard it.

Contract maintenance, 2026-10-06: contract-mode `update` treated a `--status`
equal to the lane's current status as a transition. `classifyTransitionEvent`
records the write as `handoff update --metadata` (spec 015 row 19, or L12 for
an agent outside the lane). So a same-reason `repair-needed` re-write tallied
`repair-escalation-missing`, a label this ledger did not list at the time. A
new-reason re-write moved the repair owner to the most recent actor before it,
so when that actor was not the FR-7 repair owner (after an entry by the
reviewer or a third agent, say), contract mode failed with a false
`validation_mismatch` (repair owner diverged), and random seeds can draw that
sequence. Same-status `needs-review`, `pr-review`, and `ready-to-merge`
writes, and the reviewer's `in-progress` write, tallied `update-source-status`
or `update-actor-unchecked`. Brian Faris designated the row 19 reading on
2026-10-06 over L4 (a literal reading of row 13's CLI source, which excludes
`repair-needed`), in line with spec 015's note that identity updates (same
status) stay accepted. Spec 002's Resolve, update, and claim authority records
it. `LaneLock.tla` has no metadata or same-status action, so the write is a
stutter step there and only its pin was refreshed. Contract-mode `update` now
routes the write through `metadata`. A lane agent's write keeps the status,
the locks, and the repair records (owner, escalation, attempts), and records a
supplied reason code and PR number, as `patchHandoff` does. Another agent's
write maps to `metadata-actor-unchecked`. The implementation mirror already
agreed on every compared field. It still moves the repair owner on a re-write,
which `patchHandoff` keeps, but implementation mode never reads or compares
the repair owner. The same-status witnesses, the FR-18 repair-memory
witnesses, `lane-lock-model-same-status.test.mjs`, and the
`test/transitions.test.mjs` cross-check fixtures guard it.

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
  `repairReasonsSeen` on claim. The FR-18 repair-memory witnesses compare
  the reset through a closing dispose; `test/core.test.mjs` carries the
  production-level reclaim regression (the harness does not compare
  attempt-counting internals).
- The override exit from `repair-needed` (spec 006 FR-29, `repair-resolve`
  override) is not generated by the harness: throwaway repos grant no
  overrides. `test/core.test.mjs` covers it end to end.
- Repeat resolve (spec 015 L14): spec 002 resolve authority rejects resolving
  a `resolved` lane again, and `LaneLock.tla` has no resolve action from
  `resolved`. Contract mode rejects it for every actor
  (`resolve-from-resolved`), which maps to the candidate label
  `resolve-repeat`; the implementation accepts it with a
  `transition-advisory: L14` record, so the label persists during the spec
  015 FR-5 advisory window like the other legacy labels. Before 2026-09-30
  the model accepted a lane agent's repeat resolve, so L14 never tallied, and
  a third agent's repeat resolve tallied as `resolve-actor-unchecked`.
- Reassignment (spec 015 row 20, Q8) is generated (`reassign` command; mirror
  `reassign` with the author history); every contract rejection maps to the
  candidate label `reassign-authorization`, which persists during the spec
  015 FR-5 advisory window like the other legacy labels.
- Metadata-only updates (spec 015 row 19) are generated as `metadata` (a
  reassign draw with neither role). A non-lane agent's update maps to the
  candidate label `metadata-actor-unchecked` (L12), which persists during the
  spec 015 FR-5 advisory window like the other legacy labels. On a
  `needs-review` lane the implementation reruns the needs-review gate
  (reviewer context and reviewable diff), which row 19 does not name; the
  throwaway repos have no git history, so the diff half always passes and
  the harness cannot see a rejection.
- Doctor resync (spec 015 row 17, Q2) runs as deterministic witnesses in
  both modes: the harness drops a lane's registry entry (`dropRegistry`) and
  runs the real `doctor --repair` (`doctorRepair`); the model restores
  coverage in the three permitted statuses and enters repair-needed
  elsewhere. Status and metadata updates on an uncovered lane are not
  generated: the implementation rejects them as a lock-state mismatch until
  a resync restores coverage (only request-changes and peer resolve
  re-acquire), while the contract rows name no coverage guard for them, an
  undesignated difference for a later lane. Row 17's guard also requires
  that no other lane holds a lock that overlaps the recorded set. When one
  does, the real resync fails (the doctor catches the `acquireLocks`
  conflict), the integrity check finds an active lane with no locks, and the
  doctor writes repair-needed with `lock-mismatch` (row 13). From
  in-progress or changes-requested that is an FR-18 entry; on a lane already
  repair-needed it is a re-write, not an entry, that keeps the repair owner
  and disposition and changes the reason code. Until 2026-10-06 the
  model skipped the conflicting lane; the doctor resync conflict witnesses
  and `lane-lock-model-doctor.test.mjs` guard the fall-through. A failed
  resync of a lane already repair-needed is guardian intervention that still
  cannot restore a healthy state, so spec 006 FR-18 escalates it to a human
  (designated 2026-10-07; row 13 has the watchdog re-write compute the
  escalation). Contract mode expects that escalation. The implementation
  keeps the recorded escalation on the re-write, so the mirror does too and
  contract mode tallies `repair-escalation-missing`, which persists like the
  other candidate labels until the runtime escalates. The model still
  reads coverage loss from its `uncovered` flag, while the real doctor reads
  the registry: a re-acquire (implementation-mode request-changes and peer
  resolve) or a contract-mode rescope to a new set restores coverage without
  clearing the flag, so a later doctor run sends a covered review or PR-flow
  lane to repair-needed that the real doctor leaves alone. That gap is also
  left for a later lane.
- PR-flow `changes-requested` provenance: the implementation reads the
  workflow event that entered `changes-requested` (`details.transitionEvent
  === "pr-poll"`); the mirror tracks the same fact as `prFeedbackEntered`,
  set by `prOutcome` feedback and cleared by any other status change,
  including a local `requestChanges`. A forged `pr-review-feedback` reason
  code from the CLI is covered by `test/core.test.mjs` (the shortcut then
  records L4); the harness never forges it.

- Crash-window injection (partial failure between the lock-registry write
  and the handoff write) is not exercised yet.
- Concurrent interleavings are not exercised; runs are sequential.
- The FR-18 comparison checks escalation presence on same-reason re-entry,
  and the FR-7 comparison checks the assigned repair owner (most recent
  canonical actor before the repair). The implementation's attempt-counting
  internals are not designated and not compared.
- Spec 002 (Resolve, update, and claim authority) records the same-status
  reading, and spec 015's ledger note #7 points to it, but spec 015 row 19's
  event cell still reads `handoff update` without `--status`, `--files`,
  `--owner`, or `--reviewer`. Lane h edits that row, so the cell's wording
  waits for it.
- Traces are harness-internal JSON. Exporting them for TLC trace validation
  against `specs/tla/LaneLock.tla` is future work (`specs/tla/README.md`).
