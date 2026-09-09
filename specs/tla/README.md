# TLA+ Models (spec 014 Phase 1)

This directory holds the formal models of designated btrain contracts, their
TLC configurations, cached verdicts, and pin headers.

## Setup

TLC needs Java 17+ and the official `tla2tools.jar`:

```bash
mkdir -p ~/.local/lib
gh release download v1.7.4 --repo tlaplus/tlaplus --pattern tla2tools.jar --dir ~/.local/lib
export TLC_JAR=~/.local/lib/tla2tools.jar
```

Pinned tool version: tla2tools **v1.7.4** (TLC2 2.19),
sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.

## Run

```bash
cd specs/tla
java -cp "$TLC_JAR" tlc2.TLC -config LaneLock.cfg -workers auto -deadlock LaneLock.tla
```

Expected: `Model checking completed. No error has been found.` The structured
verdict is cached at `.tlc-results/LaneLock.json`. It is keyed by every
semantic input spec 014 names (`keys`): the `.tla` content hash, the `.cfg`
hash, the pinned prose hash from the module header, the hash of the FR-6
harness files, the content hash of every semantic input (`inputs_sha256`),
and the tla2tools hash; the source commit is recorded for provenance only. The
`validation` block records the harness seed, run count, candidate tally, and
whether trace validation ran, so the verdict is also keyed by the trace set
that was actually executed. The top-level `status` is the spec 014 verdict
for the whole chain, not for TLC alone; today it is `validation_mismatch`
because the FR-6 candidate gate tallies ledgered candidates, even though TLC
and implementation mode pass.

Verify before reusing:

```bash
python3 scripts/tla_pin.py --verify-verdict specs/tla/.tlc-results/LaneLock.json
```

Every key is recomputed and reported FRESH or STALE, including the tool hash
(`TLC_JAR` or `--tool-jar`; unverifiable means STALE, never SKIP) and
`inputs_sha256`, a content hash over every semantic input: the `.tla`, the
`.cfg`, the pinned prose files, the harness files, and every file under
`src/brain_train/` (the implementation the harness drives). Keying by content
rather than by commit id means a squash merge or rebase does not orphan valid
evidence, and a change to the driven implementation invalidates a recorded
validation even when the model did not change. `source_commit` is recorded for
provenance and is not a reuse key. Any
STALE key, a missing seed/runs pair, a status other than `pass`, or a `pass`
whose recorded TLC or validation outcomes (contract mode, candidate gate,
implementation mode, trace validation) are not all passes means the file must
not be reused; re-run TLC and `npm run test:formal`. The verifier is the only sanctioned way to consume
this file. Consumer wiring lands in its own lanes because those files are
outside this lane's locks: `tla-run-tlc` (PR #40), `tla-trace-explain`, the
`formal-advisory` CI workflow, and `pre-handoff`. TLC baseline (2026-09-09, spec 016 WS4, with symmetry): 143,465,581 states
generated, 10,832,481 distinct, depth 31 (32 on an earlier run: with symmetry the reported depth depends on exploration order), 5 min 05 s with 10 workers (the
model carries 16 invariants and 5 action properties). Earlier baselines:
2026-09-08 (WS3, no symmetry) 159,482,257 generated, 14,990,809 distinct,
depth 25, 3 min 57 s; 2026-09-02 88,436,305 generated, 8,236,969 distinct,
1 min 17 s.

## Pin check

Every `.tla` carries `\* Pinned to:` and `\* Pinned-hash:` header lines that
tie it to designated prose sections. The deterministic drift check:

```bash
python3 scripts/tla_pin.py --check                       # all models
python3 scripts/tla_pin.py --show-range specs/tla/LaneLock.tla
python3 scripts/tla_pin.py --repin specs/tla/LaneLock.tla
```

A stale pin blocks handoff (spec 014 FR-5). Re-pin only after classifying
the prose change; never re-pin to silence the check.

### Pin coverage

The pin list must cover every prose range spec 014 designates as normative,
not just the sections a reviewer happens to remember. Two ranges were
designated but unpinned until 2026-09-01, so edits to them passed `--check`
untouched:

- spec 005 FR-1 through FR-8, FR-10, and FR-11. `§ Proposed Status Model`
  was pinned, but the pin range stops at the next `##` heading, and the FRs
  live under `## Functional Requirements`. Spec 015 finding #6 disclosed this
  by hand when it edited FR-7.
- spec 002 `§ handoff resolve --final`. The pinned `§ CLI Commands` section
  cross-references it, so pinned prose depended on unpinned prose. Spec 016
  WS1 relied on the section being "outside every pinned section" to ship
  edits without a re-pin.

Spec 005 FR-9 stays deliberately unpinned: spec 014 excludes it as
conflicting prose, since spec 002 v1.1.2 supersedes it in PR-flow
repositories. The `.tla` header records that exclusion inline so a future
reader does not "fix" the omission.

"Outside every pinned section" is only evidence of low formal impact when the
pin list is complete. Treat a gap in coverage as a defect, not a shortcut.

## LaneLock.tla

Models the designated lane/lock contract. The model encodes INTENDED
behavior only — designated implementation drift (close-without-merge to
`repair-needed`, unaudited release, the `--final` bypass, a repair resolve
without a recorded human decision) does not exist in the model. The FR-6
harness (`test/formal/`) covers the code side.

Spec 016 WS3 (2026-09-08) added the spec 006 FR-29 decision: `decision[l]`
is `none`, `disposed`, or `override`. `RepairDispose` (only after the FR-18
escalation) and `RepairOverrideGrant` are actor-free human records that change
no status, lock, owner, or reviewer, so they have no spec 015 transition row
(`test/transitions.test.mjs` lists them as record-only). `RepairResolve` now
requires a decision: a disposition carried out by a lane agent, or an override
presented by any configured agent. `RepairClear` voids a pending decision.
The pin list gained spec 006 § FR-29.

Pilot bounds (per the tla-author skill): 2 lanes, 3 agents, 3 abstract paths
with one nesting conflict, 4 claimable lock sets. Small by design; widen only
after the small model passes. Since spec 016 WS4 (2026-09-09) `Lanes`,
`Agents`, `NoAgent`, and `Doctor` are model-value constants in `LaneLock.cfg`
with `SYMMETRY Symm` over lanes and agents, which keeps TLC inside the CI
budget as the model grows; paths stay in-module because the nesting conflict
breaks their symmetry.

Spec 016 WS4 (2026-09-09) added: `ReturnToPr` (row 12, Q1: the owner returns
a PR-flow `changes-requested` lane to `pr-review` while local approval stands),
`PrRepoll` and `PrClear` from PR-flow `changes-requested`, `PrFeedback` keeping
`peerApproved` and `approver` (local approval survives GitHub feedback; a local
`RequestChanges` withdraws it), `Reassign` (row 20, Q8 Option C with swap
policy A-i, tracked by `priorOwner` and `Authors(l)`), and `Resync` (row 17,
Q2 Option B, with the `Doctor` guardian admitted only in `in-progress`,
`changes-requested`, and `repair-needed`).

### Invariant-to-prose mapping

| Invariant | Designated prose |
| --- | --- |
| `Exclusivity` | spec 002 v1.1.2 Lock Enforcement: no two lanes hold conflicting paths |
| `CoverageForActive` | spec 002/014: active lanes have matching handoff/registry coverage except after an audited force-release |
| `TerminalClean` | spec 002 v1.1.2: terminal `resolved` (and `idle`) hold no registry locks |
| `ReviewerSeparation` | spec 014 Pilot Scope: owner and reviewer separation on active lanes |
| `ActiveHasLocks` | designated active-lane lock requirement (spec 014 v0.1.9) |
| `PrFlowRetention` | spec 002 v1.1.2: locks retained through `ready-for-pr`, `pr-review`, `ready-to-merge` |
| `RepairBudgetBounded` | spec 006 FR-18 via FR-29: the `MaxRepair` guard sits on `RepairDispose` (a disposition needs the exhausted budget; the override exit does not); every terminal transition resets the count, so terminal lanes carry `repairCount = 0` |
| `PrFlowNeedsPeerApproval` | spec 002 v1.1.2 review routing: no lane sits in the PR flow without a peer approval by a reviewer distinct from the owner |
| `RepairOwnerAssigned` | spec 006 FR-7: a `repair-needed` lane always carries a responsible actor, and it is the lane's owner or reviewer (the most recent canonical workflow actor); outside repair none is assigned |
| `LastActorIsLaneAgent` | spec 006 FR-7 support: the recorded canonical actor of an active lane is always a lane agent, never GitHub, the watchdog, or an override requester |
| `LinkedLaneStaysActive` | spec 002 PR-flow states and actors: a lane with a linked PR never reaches a terminal status except through `PrTerminal` or a decision-backed `RepairResolve`; `AbandonResolve` is guarded on `~prLinked` |
| `DecisionOnlyDuringRepair` | spec 006 FR-29: a recorded human decision (disposition or override) exists only while the lane is `repair-needed`; clearing or resolving the repair voids it |
| `DispositionAfterEscalation` | spec 006 FR-29: a disposition is recorded only after the FR-18 escalation fired (`repairCount >= MaxRepair`); the override path needs no escalation |
| `AuthorSeparation` | spec 005 FR-5 reassignment (Q8, swap policy A-i): no author of the current task (owner or prior owner) is its reviewer |
| `PrReviewIsLinked` | spec 002 PR-flow states: `pr-review` and `ready-to-merge` always carry a linked PR |
| `OwnerChangesOnlyByReassign` (action property) | spec 005 FR-5: an active lane's owner changes only in `in-progress`, `needs-review`, or unlinked `changes-requested`, and the status does not change in the same step |
| `RepairResolveNeedsDecision` (action property) | spec 006 FR-29 (spec 015 row 15, Q3 Option A): the step repair-needed → resolved requires `decision # "none"` before it, and a `disposed` decision additionally requires `repairCount >= MaxRepair`; this is what makes the `RepairResolve` guard checkable rather than structural |
| `RepairClearByResponsibleActor` (action property) | spec 006 FR-15: the actor who clears repair-needed is the recorded repair owner |
| `RepairEnterAssignsLastActor` (action property) | spec 006 FR-7: entering repair assigns the most recent canonical actor |
| `PrFlowEntryByReviewer` (action property) | spec 002 v1.1.2: entry to `ready-for-pr` happens only from `needs-review` by the assigned reviewer, distinct from the owner; `PrFlowNeedsPeerApproval` now also checks the recorded `approver` |
| `TypeOK` | state-space sanity, no prose claim |

### Verification hygiene

The baseline run includes mutation checks that remove or swap a GUARD (not
merely the field an invariant reads), so the properties are load-bearing:
removing `NoConflictWithOthers` from `Claim` violates `Exclusivity`;
replacing `RepairResolve`'s decision disjunction with plain `IsLaneAgent`
violates `RepairResolveNeedsDecision` (verified 2026-09-08, spec 016 WS3);
the budget guard moved from `RepairResolve` to `RepairDispose`, and deleting
`repairCount[l] >= MaxRepair` there violates the state invariant
`DispositionAfterEscalation` (by construction; shortest violating trace
Claim, RepairEnter, RepairDispose at count 1); changing `PeerResolve`'s guard to `IsOwner`
violates `PrFlowNeedsPeerApproval` and `PrFlowEntryByReviewer`; changing
`RepairClear`'s guard to `IsLaneAgent` violates
`RepairClearByResponsibleActor`; assigning `owner[l]` instead of
`lastActor[l]` in `RepairEnter` violates `RepairEnterAssignsLastActor`; dropping
`r2 \notin Authors(l) \union {o2}` from `Reassign` violates `AuthorSeparation`
(verified 2026-09-09, spec 016 WS4).

### Actor authority

`RepairClear` is guarded on `IsRepairOwner`, the actor `RepairEnter` copied
from `lastActor` (spec 006 FR-7/FR-15). `RepairResolve` is guarded on the
recorded `decision` (FR-29 as amended 2026-09-08): `disposed` admits a lane
agent, `override` admits any configured agent. `RepairDispose` and
`RepairOverrideGrant` are actor-free human records that change only
`decision`. `test/formal/lane-lock-model.mjs` `resolve()` mirrors the
disposition path through its `dispose()` op; the harness grants no overrides,
so the override path is covered by `test/core.test.mjs` only. `Rescope` has no `repair-needed` branch: FR-20 reserves repair
rescoping for a guardian or human, neither of which is in the agent pool, and
the harness transcription rejects agent-pool repair rescopes the same way.

### Known gaps

- FR-18 is modeled as a per-lane `repairCount` (0..2) without reason
  identity; distinct-reason repair sequences share one budget in the model.
  Spec 015 Q4 (Option A, 2026-09-08) keeps the model's claim-resets-count
  behavior; the implementation aligns in spec 016 WS4.
- Override scoping (spec 016 WS3 review): the model admits a `repair-resolve`
  override grant only while the lane is `repair-needed` and voids a pending
  one on `RepairClear`; the implementation scopes neither (`grantOverride`
  checks no lane status, and `resolveHandoff` consumes any active
  `repair-resolve` grant for the lane), so a grant survives a clear and
  re-entry. The model's single `decision` slot also forbids an override
  after a disposition, which the implementation allows as two coexisting
  records. Neither is harness-observable (no overrides in throwaway repos).
  Tighten the implementation or relax the model in a follow-up lane after
  WS4 (deferred; `grantOverride` is unchanged by WS4).
- The FR-15 override clear (`RepairClear` by an audited override rather than
  the repair owner) is distinct from the FR-29 `repair-resolve` override
  modeled as `decision = "override"`, and is not modeled. Adding it would
  relax `RepairClearByResponsibleActor`; deferred until prose designates who
  the recorded actor is after an override clear.
- Resolved 2026-09-09 (spec 016 WS4): the spec 002 row "resolved after
  close without merge" now reads as closing the PR on GitHub and running
  `btrain pr poll --apply`; a plain resolve from a PR-flow status is
  designated as rejected. Kept for history: spec 002
  `PR-flow states and actors`, row `resolved after close without merge`,
  permits "a human/owner intentionally resolving". The model has no
  lane-agent exit from a PR-flow status; only `PrTerminal` (a GitHub outcome)
  terminates one. Spec 014 FR-2 treats conflicting prose as blocking model
  approval. The reconciliation (read the phrase as `btrain pr poll --apply`
  after the PR is closed on GitHub) is scheduled in spec 016 WS4 because the
  section is pinned by this model and editing it forces a repin.
- Two hand transcriptions of the same contract exist (this model and
  `test/formal/lane-lock-model.mjs`); they are kept independent and
  cross-checked by review, and spec 015 FR-7 adds an executable cross-check.
  Known differences: (a) resolved 2026-09-09 (spec 016 WS4): `PrRepoll` and
  `PrClear` fire from PR-flow `changes-requested` while local approval stands,
  and the mirror admits the same only when the lane's reason code is
  `pr-review-feedback`. (b) resolved 2026-09-09: the mirror's contract-mode
  `resolve()` now rejects a linked `changes-requested` lane, matching
  `AbandonResolve`'s `~prLinked`. (c) `Claim` with reviewer = owner is
  rejected by the model and silently reassigned to a distinct peer by the
  harness; reachable states are equivalent. (d) the harness mirror has no
  override path at all (`disposition` only); the model's `override` branch of
  `RepairResolve` is exercised by TLC and by `test/core.test.mjs`. (e) the mirror's `update` accepts
  `changes-requested -> in-progress` by the owner (pre-existing); the model
  has no such action (row 14 is the repair exit only), so that path is
  undesignated and stays a mirror-only acceptance until prose speaks.
- `Reassign` is admitted only in `in-progress`, `needs-review`, and
  `changes-requested`, in each case without a linked PR (spec 005 FR-5 as
  designated 2026-09-09); the registry owner label is not modeled. `Resync` fires only from the force-release
  `uncovered` state; btrain's doctor also repairs a registry that was emptied
  outside btrain, which the model treats as the same event. The harness
  generates reassignments (mirror `reassign`, label
  `reassign-authorization` during the FR-5 window) and runs the real
  `btrain doctor --repair` in a deterministic resync witness (mirror
  `dropRegistry` + `doctorRepair`); status updates on an uncovered lane stay
  out of the generator because their contract is undesignated.
- Crash windows between the handoff write and the registry write are not
  modeled; the writes are atomic in the model.
- TLC trace validation against harness-emitted traces is future work
  (spec 014 authority chain, link 4).
