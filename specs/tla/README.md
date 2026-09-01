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
`formal-advisory` CI workflow, and `pre-handoff`. TLC baseline: 88,436,305 states generated, 8,236,969 distinct, depth
25, 1 min 17 s with 10 workers (the model now carries 12 invariants and 4
action properties).

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

## LaneLock.tla

Models the designated lane/lock contract. The model encodes INTENDED
behavior only — designated implementation drift (close-without-merge to
`repair-needed`, unaudited release, the `--final` bypass) does not exist in
the model. The FR-6 harness (`test/formal/`) covers the code side.

Pilot bounds (in-module, per the tla-author skill): 2 lanes, 3 agents,
3 abstract paths with one nesting conflict, 4 claimable lock sets. Small by
design; widen only after the small model passes.

### Invariant-to-prose mapping

| Invariant | Designated prose |
| --- | --- |
| `Exclusivity` | spec 002 v1.1.2 Lock Enforcement: no two lanes hold conflicting paths |
| `CoverageForActive` | spec 002/014: active lanes have matching handoff/registry coverage except after an audited force-release |
| `TerminalClean` | spec 002 v1.1.2: terminal `resolved` (and `idle`) hold no registry locks |
| `ReviewerSeparation` | spec 014 Pilot Scope: owner and reviewer separation on active lanes |
| `ActiveHasLocks` | designated active-lane lock requirement (spec 014 v0.1.9) |
| `PrFlowRetention` | spec 002 v1.1.2: locks retained through `ready-for-pr`, `pr-review`, `ready-to-merge` |
| `RepairBudgetBounded` | spec 014 designation of spec 006 FR-18: repair resolves only after the escalation budget is exhausted (structural guard on `RepairResolve`); terminal lanes carry a reset count |
| `PrFlowNeedsPeerApproval` | spec 002 v1.1.2 review routing: no lane sits in the PR flow without a peer approval by a reviewer distinct from the owner |
| `RepairOwnerAssigned` | spec 006 FR-7: a `repair-needed` lane always carries a responsible actor, and it is the lane's owner or reviewer (the most recent canonical workflow actor); outside repair none is assigned |
| `LastActorIsLaneAgent` | spec 006 FR-7 support: the recorded canonical actor of an active lane is always a lane agent, never GitHub, the watchdog, or an override requester |
| `LinkedLaneStaysActive` | spec 002 PR-flow states and actors: a lane with a linked PR never reaches a terminal status except through `PrTerminal` or a post-escalation `RepairResolve`; `AbandonResolve` is guarded on `~prLinked` |
| `RepairResolveNeedsEscalation` (action property) | spec 014 designation of FR-18: the step repair-needed → resolved requires `repairCount >= MaxRepair` before it; this is what makes the `RepairResolve` guard checkable rather than structural |
| `RepairClearByResponsibleActor` (action property) | spec 006 FR-15: the actor who clears repair-needed is the recorded repair owner |
| `RepairEnterAssignsLastActor` (action property) | spec 006 FR-7: entering repair assigns the most recent canonical actor |
| `PrFlowEntryByReviewer` (action property) | spec 002 v1.1.2: entry to `ready-for-pr` happens only from `needs-review` by the assigned reviewer, distinct from the owner; `PrFlowNeedsPeerApproval` now also checks the recorded `approver` |
| `TypeOK` | state-space sanity, no prose claim |

### Verification hygiene

The baseline run includes mutation checks that remove or swap a GUARD (not
merely the field an invariant reads), so the properties are load-bearing:
removing `NoConflictWithOthers` from `Claim` violates `Exclusivity`; deleting
`repairCount[l] >= MaxRepair` from `RepairResolve` violates
`RepairResolveNeedsEscalation`; changing `PeerResolve`'s guard to `IsOwner`
violates `PrFlowNeedsPeerApproval` and `PrFlowEntryByReviewer`; changing
`RepairClear`'s guard to `IsLaneAgent` violates
`RepairClearByResponsibleActor`; assigning `owner[l]` instead of
`lastActor[l]` in `RepairEnter` violates `RepairEnterAssignsLastActor`.

### Actor authority

`RepairClear` is guarded on `IsRepairOwner`, the actor `RepairEnter` copied
from `lastActor` (spec 006 FR-7/FR-15). `RepairResolve` stays `IsLaneAgent`:
the FR-18 escalation is a human decision, and either lane agent may carry out
the terminal disposition, matching `test/formal/lane-lock-model.mjs`
`resolve()`. `Rescope` has no `repair-needed` branch: FR-20 reserves repair
rescoping for a guardian or human, neither of which is in the agent pool, and
the harness transcription rejects agent-pool repair rescopes the same way.

### Known gaps

- FR-18 is modeled as a per-lane `repairCount` (0..2) without reason
  identity; distinct-reason repair sequences share one budget in the model.
- Prose conflict to reconcile before the model leaves pilot: spec 002
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
  Known differences, each an undesignated prose question (spec 016 WS4):
  (a) the harness accepts `pr-poll` `clear` and `waiting` from PR-flow
  `changes-requested` (changes-requested → ready-to-merge / pr-review); the
  model has no such action and routes PR feedback back through
  `ToNeedsReview` → `PeerResolve` → `LinkPr`, which also voids
  `peerApproved`. Whether local approval survives GitHub feedback is not
  decided in prose. (b) the harness's contract-mode `resolve()` lets a lane
  agent terminal-resolve PR-flow `changes-requested` with a linked PR; the
  model forbids it (`AbandonResolve` requires `~prLinked`,
  `LinkedLaneStaysActive`). The harness must tighten to `~prLinked` when the
  spec 002 line 77 reconciliation lands. (c) `Claim` with reviewer = owner is
  rejected by the model and silently reassigned to a distinct peer by the
  harness; reachable states are equivalent.
- Crash windows between the handoff write and the registry write are not
  modeled; the writes are atomic in the model.
- TLC trace validation against harness-emitted traces is future work
  (spec 014 authority chain, link 4).
