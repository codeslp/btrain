# 015 — Lane Transition Contract as a Guarded-Action List

**Status**: Draft
**Version**: 0.1.2
**Author**: btrain
**Date**: 2026-09-01
**Updated**: 2026-09-01 (v0.1.2: fixes for checklist `specs/checklists/015-transition-contract.md` CHK001–CHK035 and two independent reviews)

## Decision

Replace the scattered status guards in `src/brain_train/core.mjs` and
`src/brain_train/pr-flow.mjs` with one explicit, hand-authored guarded-action
list that every lane mutation passes through. Do this in two separately
reviewable halves:

- **Structural half (no semantic impact).** Introduce the list and a single
  `applyTransition` gate, route every writer through it, and have the list
  reproduce today's accepted behavior exactly. In Phase A the gate is an
  additional check in front of the existing in-function guards, which all
  stay in place; the rows therefore need only be a superset of what the code
  accepts today, and the existing rejections (no `resolved` via `update`,
  active status needs locks, reason codes on `changes-requested` and
  `repair-needed`) keep firing from where they fire now. The scattered guards
  are removed only in the semantic half, row by row, as each row's rejection
  becomes the gate's. Rows that encode behavior the
  designated prose forbids are marked `legacy` so nobody mistakes them for
  contract. Spec 014 classifies this as a no-semantic-impact change that touches
  a modeled entry point: pin check plus focused implementation validation.
- **Semantic half (semantic impact).** Retire each `legacy` row only after the
  owning prose designates the rule, following the spec 014 order: prose, then
  model, then code. Each retirement is its own formal-impact declaration. The
  per-finding designation decisions are recorded below so the semantic half can
  start as soon as PR #35 merges and the pinned sections reopen.

Do not adopt LangGraph or any other graph runtime, for the core or for
`btrain loop`. The list is a graph *description*; btrain exports it for docs,
the loop's actor routing, and dashboards, but nothing executes it between
steps. Zero runtime dependencies stays a pillar.

Do not make this spec the semantic owner of any transition. Specs 002, 005,
006 and the spec 014 designations own the rules. Every row cites its owner;
where no owner text exists the row is marked `undesignated` and stays lenient
until prose lands.

## Summary

btrain's lane state machine is written down as a table twice, in
`specs/tla/LaneLock.tla` (PR #35) and `test/formal/lane-lock-model.mjs`, but
not in production code. Production decides validity with guards spread across
`claimHandoff`, `patchHandoff`, `requestChangesHandoff`, `resolveHandoff`,
`applyPrStatusToHandoff`, and a raw `updateHandoff` write in
`applyWatchdogRepairs`. Two of those paths guard source status and actor
(`claimHandoff` at `core.mjs:4996`, `requestChangesHandoff` at
`core.mjs:5586-5600`). The other four guard partially or not at all (`resolveHandoff` checks
`--final` and the PR-flow status set but never the actor; `patchHandoff`
checks the target name, never the source). Seven of the eight open ledger
findings in `test/formal/README.md` are source-status or actor-authority
omissions in those four paths. The eighth (#8) is an error-handling defect.

The fix is a list of guarded actions, not a flat `(from, event, role)` table.
Five rows need data guards a flat table cannot hold: lock exclusivity and
non-empty sets on claim and rescope, a linked PR on terminal PR outcomes, the
FR-18 escalation state on repair resolve, and the reviewer-context and diff
gate (or a consumed FR-2c/2d override) on entry to `needs-review`.

## Review corrections carried into this spec

These correct the proposal that motivated this spec. Reviewers should not
inherit the original claims.

- **Finding #9 is half repaired.** PR #33 (`fefa915`) added a PR-flow-status
  guard to the merged and closed outcomes (`pr-flow.mjs:618-656`). The
  non-terminal outcomes (`waiting`, `feedback`, `ready-to-merge`) still route
  through `patchHandoff` with no source check (`pr-flow.mjs:660-690`). An
  explicit `--pr` on an `in-progress` lane with a `waiting` outcome moves it to
  `pr-review` without peer approval. The ledger entry must be reworded.
- **The harness implementation mirror is stale.** `lane-lock-model.mjs:377-386`
  still accepts merged and closed outcomes from any status in implementation
  mode. `npm run test:formal` therefore fails the implementation-mode test with
  a `validation_mismatch` that the README (line 42) defines as a regression
  signal. It is not a regression. Fix the mirror before relying on the harness.
- **There are six writers, not four.** `requestChangesHandoff`
  (`core.mjs:5555`) and `applyWatchdogRepairs` (`core.mjs:8717`, a direct
  `updateHandoff` call) also change status. The gate must sit where all six
  converge or the watchdog path stays ungoverned.
- **Two more defects ride on finding #5.** When a lane's handoff file is absent,
  `resolveHandoff` falls back to `readCurrentState(repoRoot)`
  (`core.mjs:5680-5685`), which reads repo-level state, and then writes a
  `Previous Handoffs` entry into a newly created lane file using another lane's
  task text. Reproduced on 2026-09-01.
- **The two existing transcriptions disagree with each other.**
  `lane-lock-model.mjs:262` allows `changes-requested -> in-progress`;
  `LaneLock.tla` has no such action. Neither cites prose for the choice. This is
  exactly the transcription error a third copy would multiply, which is why
  FR-7 below requires a cross-check test rather than trust.
- **Spec 002 line 77 conflicts with the model.** The `resolved after close
  without merge` row permits "a human/owner intentionally resolving". The model
  has no lane-agent exit from a PR-flow status; the only terminal path is a
  GitHub outcome. Spec 014 FR-2 says conflicting prose blocks model approval.
  PR #35 must reconcile this line or record why it does not conflict.
- **The live workflow uses an edge the model lacks.** `buildLaneGuidance`
  (`core.mjs:5856`) and the current lane `b` next-action both instruct the
  owner to run `handoff update --status pr-review` from PR-flow
  `changes-requested`. `LaneLock.tla` routes PR feedback back through
  `needs-review` and `ready-for-pr`. Prose (spec 002 line 75, spec 005 FR-7)
  is silent on the shortcut. This is a designation gap, not code drift.

## Contract shape

A transition is one row:

| Field | Meaning |
| --- | --- |
| `action` | Stable name, matching the `LaneLock.tla` action where one exists |
| `event` | The CLI command or internal event that requests it |
| `from` | Set of source statuses |
| `to` | Target status |
| `actor` | Authority predicate: `owner`, `reviewer`, `lane-agent` (owner or reviewer), `repair-owner` (the lane's recorded repair owner), `any-agent` (any non-empty actor string in Phase A; configured-agent enforcement arrives with advisory mode, since `claimHandoff` accepts an unconfigured `--owner` today and `analyzeLaneIntegrity` reports it afterwards as `actor-mismatch`), `system` (an internal event btrain raised itself), `override` (any agent presenting a consumed spec 006 FR-2c/2d override, which is how a human decision reaches btrain) |
| `guard` | Data predicate evaluated against lane state and inputs; returns ok or a reason |
| `locks` | `acquire`, `retain`, `replace`, `release`, `suspend` |
| `owner` | The prose that designates the row, by spec and section |
| `state` | `designated`, `provisional`, `undesignated`, or `legacy` |

Internal events (`pr-poll`, `pr-create`, `watchdog-repair`, `resync` by
doctor) satisfy the `system` authority predicate and cannot be forged from the
CLI, extending the `viaPrOutcome` pattern at `cli.mjs:1676`. The authority
predicate is separate from the actor label written to the workflow event: a
system event still records the invoking agent or tool name (for example
`btrain doctor`) as its label, as `applyPrStatusToHandoff` does today at
`pr-flow.mjs:610-613`.

Spec 006 names a guardian and a human as override authorities. In this
contract the guardian is `system` (the watchdog and `btrain doctor` paths) and
a human is reached through `override`. No row grants authority to a bare actor
string such as "human".

Precedence: contract rows (1-20) are evaluated first. A legacy row applies only
when no contract row accepts the request. In Phase A a legacy match is silent:
nothing new is persisted, so the structural half writes no new fields and its
rollback claim holds. Only once a row enters advisory mode (FR-5) does a legacy
match record the `transition-advisory` field with the legacy row id that
matched, so the advisory data says which forbidden behavior was exercised.

Single-handoff mode (no `[lanes]`): only the `from`, `to`, `actor`, and
non-lock guards apply. The `locks` column is a no-op and `lockedFiles` is
carried through unchanged, matching `resolveHandoff` today at `core.mjs:5758`.

### The rows

Statuses: `idle`, `in-progress`, `needs-review`, `changes-requested`,
`ready-for-pr`, `pr-review`, `ready-to-merge`, `repair-needed`, `resolved`.
`Active` means every status except `idle` and `resolved`. `PrFlow` means
`ready-for-pr`, `pr-review`, `ready-to-merge`. "Linked PR" means a PR number
recorded on the lane or supplied with `--pr` on the command (`resolveLaneAndPr`
uses `explicitPr || linkedPr`, `pr-flow.mjs:394-420`).

| # | action | event | from | to | actor | guard | locks | owner | state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Claim | `handoff claim` | `idle`, `resolved` | `in-progress` | any-agent | files non-empty; no cross-lane conflict; reviewer distinct from owner | acquire | 002 Lock Enforcement item 1, CLI Commands | designated |
| 2 | ToNeedsReview | `handoff update --status needs-review` | `in-progress`, `changes-requested` | `needs-review` | owner | reviewer context complete; reviewable diff or consumed override | retain | 005 Proposed Status Model, FR-7 | provisional (actor) |
| 3 | RequestChanges | `handoff request-changes` | `needs-review` | `changes-requested` | reviewer (see L15 for the unverified-actor and no-recorded-reviewer cases) | reason code present | retain | 005 FR-8, FR-15 | designated |
| 4 | PeerResolve | `handoff resolve` (PR flow on) | `needs-review` | `ready-for-pr` | reviewer, distinct from owner | none | retain; a lane uncovered by an audited force-release stays uncovered until claim or rescope (002 Force-release override) | 002 Lock Enforcement, PR-flow states row 1 | designated |
| 5 | TerminalResolve | `handoff resolve` (PR flow off) | `needs-review` | `resolved` | reviewer | none | release | 002 Lock Enforcement item 2 (005 FR-9 applies only without PR flow; spec 014 excludes it otherwise) | designated |
| 6 | AbandonResolve | `handoff resolve` | `in-progress`, `changes-requested` | `resolved` | lane-agent | no linked PR (`LaneLock.tla` `AbandonResolve` requires `~prLinked`; 002 lines 62 and 75 retain locks on a linked PR until merge or close) | release | `LaneLock.tla`; 002 Lock Enforcement for the linked case | undesignated (actor); linked case forbidden, see L1 |
| 7 | LinkPr | `pr create`; `handoff update --status pr-review --pr` | `ready-for-pr` | `pr-review` | owner | PR number present | retain | 002 PR-flow states row 2 | designated |
| 8 | PrRepoll | `pr-poll` waiting | `pr-review` | `pr-review` | system | linked PR | retain | 002 PR-flow states | designated |
| 9 | PrFeedback | `pr-poll` feedback | `pr-review`, `ready-to-merge` | `changes-requested` | system | linked PR; reason `pr-review-feedback` | retain | 002 PR-flow states row 4 | designated |
| 10 | PrClear | `pr-poll` clear | `pr-review` | `ready-to-merge` | system | linked PR | retain | 002 PR-flow states row 3 | designated |
| 11 | PrTerminal | `pr-poll` merged or closed | PrFlow, `changes-requested` | `resolved` | system | linked PR | release | 002 PR-flow states rows 5 and 6 | designated |
| 12 | ReturnToPr | `handoff update --status pr-review` | `changes-requested` with linked PR | `pr-review` | owner | linked PR; feedback reason code | retain | none; CLI guidance and live use only | undesignated |
| 13 | RepairEnter | `handoff update --status repair-needed`; `watchdog-repair` | Active minus `repair-needed` for the CLI event; any Active including `repair-needed` for `watchdog-repair` (the watchdog re-writes a `repair-needed` lane whose locks were released, `core.mjs:4530-4536`, `:8717`) | `repair-needed` | any-agent, system (who may declare a repair manually is open question 7) | reason code; FR-18 count and escalation computed | retain | 006 FR-4, FR-20; 014 designation | provisional |
| 14 | RepairClear | `handoff update --status in-progress` | `repair-needed` | `in-progress` | repair-owner, system, or override | none | retain | 006 FR-15; 014 designation | provisional |
| 15 | RepairResolve | `handoff resolve` | `repair-needed` | `resolved` | lane-agent with a recorded human disposition, or override | a recorded human disposition event for this lane after FR-18 escalation, or a consumed FR-2c/2d override; the escalation flag alone is not a decision | release | 014 designation; proposed 006 FR-29 | provisional, product call |
| 16 | Rescope | `handoff update --files` (set differs) | `in-progress`, `changes-requested`, `repair-needed` | same | owner in `in-progress` or `changes-requested`; system or override in `repair-needed` | non-empty; no cross-lane conflict | replace | 014 rescope designation; 006 FR-20 | provisional, product call |
| 17 | Resync | `handoff update --files` (set equals handoff record); doctor repair | Active | same | owner, or system | no cross-lane conflict; equality after `normalizePathList` (trim, dedupe, sort; no slash rewriting) | restore coverage | 006 FR-2 "lock/status resync" (concept only) | undesignated |
| 18 | ForceRelease | `locks release`, `locks release-lane` | Active | same | override | none beyond the override | suspend | 002 Force-release override | designated |
| 19 | MetadataUpdate | `handoff update` without `--status`, `--files`, `--owner`, or `--reviewer` | any | same | lane-agent | none | unchanged | none | undesignated |
| 20 | Reassign | `handoff update --owner` or `--reviewer` | Active | same | lane-agent | new reviewer distinct from owner; new owner distinct from reviewer | unchanged (registry owner label follows the new owner) | 005 FR-5 "unless explicitly reassigned" (reviewer only) | undesignated (owner reassignment) |
| L1 | legacy | `handoff resolve` | PrFlow, and `changes-requested` with a linked PR | `resolved` | any | none | release | forbidden by 002 Lock Enforcement (locks held until merge or close) | legacy (#4) |
| L2 | legacy | `handoff resolve` | `idle` | `resolved` | any | none | none | forbidden by implication of 002 CLI Commands | legacy (#5) |
| L3 | legacy | `handoff update --status needs-review` | any Active | `needs-review` | any | reviewer reassigned to owner when actor is reviewer | retain | forbidden by 005 FR-5, FR-7 | legacy (#6) |
| L4 | legacy | `handoff update --status <X>` | any | `<X>` | any | target name valid | per target | forbidden by 002 PR-flow states, 014 repair exits | legacy (#7) |
| L5 | legacy | `pr-poll` waiting, feedback, clear | any Active with a linked PR (recorded or `--pr`), or an inactive lane whose registry still holds stale locks (`patchHandoff` falls back to `currentLane.lockPaths`) | per outcome | system | none | retain | forbidden by 002 PR-flow states | legacy (#9 residual) |
| L6 | legacy | `handoff update --files` | any status | same | any | non-empty when Active | replace when Active; release both records when `idle` (`core.mjs:5292-5295`); in single-handoff mode set `lockedFiles` only | forbidden by 014 rescope designation | legacy (#10) |
| L7 | legacy | `handoff resolve` | `repair-needed` | `resolved` | any | row 15 guard not met (no recorded human disposition and no consumed override; the escalation flag alone does not satisfy row 15) | release | forbidden by 014 repair designation and 006 FR-29 | legacy (#11) |
| L8 | legacy | `handoff resolve` | `needs-review` | `ready-for-pr` (PR flow on) or `resolved` (off) | any, actor unchecked | none | as rows 4 and 5 | forbidden by 002 PR-flow states row 1 (reviewer enters ready-for-pr) | legacy (#4, actor half) |
| L9 | legacy | `handoff resolve` (PR flow on) | `needs-review`, lane uncovered by force-release | `ready-for-pr` | any | none | re-acquires the handoff paths (`core.mjs:5711`), which can fail if another lane took them | forbidden by 002 Force-release override (coverage stays suspended until claim or rescope) | legacy (new observation, not yet in the ledger) |
| L10 | legacy | `handoff update --owner` or `--reviewer` | any status, including `resolved` and `idle` | same | any, actor unchecked | none | registry owner label follows the new owner | undesignated (open question 8) | legacy (row 20 fallback) |
| L11 | legacy | `handoff resolve` | `in-progress`, `changes-requested` | `resolved` | any, actor unchecked (`resolveHandoff` compares no actor) | none | release | row 6 actor undesignated (open question 5) | legacy (row 6 fallback) |
| L12 | legacy | `handoff update` with only `--task`, `--next`, `--base`, `--pr`, `--mode`, packet or reviewer-context fields | any | same | any, actor unchecked | none | unchanged | row 19 actor undesignated | legacy (row 19 fallback) |
| L13 | legacy | `handoff claim` in single-handoff mode (no `[lanes]`) | any, including `in-progress` and `needs-review` | `in-progress` | any-agent | none; the source guard exists only in the lane branch (`core.mjs:4996`) | none (no registry) | undesignated | legacy (single-handoff claim overwrite) |
| L14 | legacy | `handoff resolve` | `resolved` | `resolved` | any | none | none | undesignated; repeated resolve is accepted today | legacy (repeat resolve) |
| L15 | legacy | `handoff request-changes` | `needs-review` | `changes-requested` | any when the lane records no reviewer or the actor is unverified (`core.mjs:5602` checks only when both are set) | reason code present | retain | 005 FR-8 designates the reviewer; the empty-actor case is undesignated | legacy (row 3 fallback) |
| L16 | system | `watchdog-repair` stale or TTL-expired lock release | any | same | system | lock is stale (lane not active) or past `lockTtlMs` | release registry entries (`core.mjs:8641-8690`) | 006 FR-2 safe auto-repair catalog ("stale lock cleanup") | designated |

Rows 1 through 20 and L16 are the intended contract. Rows L1 through L15
exist only so the structural half is behavior-preserving: every request the
current CLI accepts must match some row in Phase A, and Phase A's acceptance
test is exactly that property, checked against the full existing suite. L16
is a contract row for a system event that carries a lock effect; it is listed
with the legacy rows only because it was found in the same audit. Each legacy row is retired by the
semantic half once its owning prose lands. L9 records a divergence found while
drafting this spec; it is added to the ledger by the structural half.

## Functional Requirements

### FR-1: One gate for every status or lock mutation

Every write that changes a lane's `status`, `lockedFiles`, `owner`, or
`reviewer` must pass through `applyTransition(laneState, event, input)`. This
includes `applyWatchdogRepairs` (`core.mjs:8717`) and the `pr-create` path
(`pr-flow.mjs:937`). A direct `updateHandoff` call that changes those fields
outside the gate is a defect.

The transition check and the resulting handoff and registry writes happen
inside the same lock-registry critical section that `patchHandoff` already
uses (`core.mjs:5352-5360`, `acquireLocks` with `publishInsideLock`). A
transition must not be accepted against state that another writer changed
between the check and the write.

### FR-2: The list is hand-authored from prose, never generated

Each row cites its owning prose. The list must not be generated from
`LaneLock.tla`, and `LaneLock.tla` must not be generated from the list. Both are
independent transcriptions of the same prose. Spec 014 FR-4 and FR-11 continue
to govern the model.

### FR-3: Legacy rows are explicit and temporary

A row that accepts behavior the designated prose forbids carries
`state: legacy` and the ledger finding number. The structural half may add
legacy rows; the semantic half may only remove them. No new legacy row may be
added after the structural half merges.

### FR-4: Rejections are `BtrainError`s with a fix

A rejected transition reports the source status, the requested target, the
acting agent, the reason the row did not match, and the command that would be
legal. A raw filesystem error is never the user-visible result of a transition
request. This closes ledger finding #8 (`core.mjs:5185`): a missing lane
handoff file is a `BtrainError` naming `btrain init` or `btrain agents set`.

### FR-5: Advisory mode precedes enforcement

Retiring a legacy row happens in two steps. First the gate accepts the
transition but records a `transition-advisory` field on the workflow event and
prints a warning. Then it rejects. The advisory step lasts at least 14
calendar days after its merge to `main`, and enforcement may not merge while
any `transition-advisory` event for that row was recorded in the last 7 days
across the registered repositories. This matches spec 014 Phase 2 (advisory)
and Phase 3 (gate). btrain has no release cadence, so the bound is stated in
days and observed events rather than releases.

### FR-6: Unknown actors

When `resolveVerifiedActor` yields an empty actor (`core.mjs:6654`) and the row
requires `owner`, `reviewer`, `lane-agent`, or `repair-owner`, the gate treats
the actor as unknown. In Phase A, before any row is in advisory mode, an
unknown actor, and equally an actor that does not resolve to a configured
agent, satisfies every actor predicate, because that is what the code does
today (`canonicalizeAgentName` returns the raw string for an unconfigured
name and `claimHandoff` proceeds). In advisory mode it warns. In enforcement mode it rejects with the
fix `pass --actor or export BTRAIN_AGENT`. Internal `system` events are never
affected.

### FR-7: Transcription cross-check

The formal harness gains one deterministic test: for every `(from, event,
actor-role, guard-fixture)` in the product of statuses, events, roles, and a
fixed set of guard fixtures, the production list and `lane-lock-model.mjs` in
contract mode must agree on accept or reject, except where the production row
is `legacy`, `provisional`, or `undesignated`: only `designated` rows are
compared, because provisional and undesignated rows (for example row 12, which
neither `LaneLock.tla` nor the mirror has) differ from the model by design
until a decision lands. The test prints the excluded rows so the exclusion
list visibly shrinks as designations arrive. The guard fixtures cover each data guard in both states: PR
linked or not, FR-18 escalation reached or not, override consumed or not,
lock set empty or non-empty, cross-lane conflict present or absent. Guards
that depend on the working tree (the reviewable-diff gate) are fixed to
"satisfied" in this test; the model-based sequences keep exercising them. Disagreement is a transcription
error in one of the two, reported as `validation_mismatch`. This test does not
replace model-based command sequences (spec 014 FR-6); those keep checking that
lock effects, file writes, and registry state match the accepted transition.

### FR-8: Exported graph description

`btrain` exposes the list as data (`btrain transitions --format json|mermaid`).
`describeLoopAgentReason` (`core.mjs:7724`), `defaultNextActionForStatus`
(`core.mjs:951`), and `buildLaneGuidance` (`core.mjs:5781`) derive their
status-to-actor routing from the list rather than from their own `switch`
statements. Spec 005 FR-11 is satisfied by construction.

Because a status has several outgoing rows with different authorities, each
status carries exactly one `primary` row that the routers use for "who acts
next" and default guidance; other rows remain legal transitions but never
drive routing. The primary rows:

| Status | Primary row | Next actor |
| --- | --- | --- |
| `idle`, `resolved` | 1 Claim | any-agent |
| `in-progress` | 2 ToNeedsReview | owner |
| `needs-review` | 4 PeerResolve (PR flow on) or 5 TerminalResolve (off); 3 RequestChanges is the alternate reviewer outcome | reviewer |
| `changes-requested` | 2 ToNeedsReview; row 12 ReturnToPr instead when a PR is linked and row 12 is designated | owner |
| `ready-for-pr` | 7 LinkPr | owner |
| `pr-review` | 8 PrRepoll | system (poll) |
| `ready-to-merge` | 11 PrTerminal | system (merge, then poll) |
| `repair-needed` | 14 RepairClear | repair-owner |

### FR-9: Reviewer inference never overrides a valid reviewer

`inferPeerReviewer` (`core.mjs:6680`) must not replace an existing reviewer
that is distinct from the owner. Once row 2 enforces `actor: owner` the
reassignment in finding #6 is unreachable, but the inference fallback is kept
correct independently so single-handoff mode and future callers cannot
reintroduce it.

### FR-10: Formal-impact declarations

Adding, removing, or changing a row is a spec 014 formal-impact declaration.
Structural-half changes declare no semantic impact and run the pin check and
focused implementation validation. Semantic-half changes declare semantic
impact and run TLC, validation, and conventional tests, in prose-model-code
order.

### FR-11: Ledger and mirror maintenance

The structural half updates `test/formal/README.md` to reword finding #9, add
the missing-file defects to finding #5, and record the stale implementation
mirror as repaired. The implementation mirror in `lane-lock-model.mjs` is
corrected to match the post-#33 terminal-outcome guard before the cross-check
test is enabled.

### FR-12: Deterministic gate

`applyTransition` is a pure function of the lane state it is given, the
request, and the guard inputs passed to it. A row guard must not read the
clock, the filesystem, the network, or GitHub. Callers gather those inputs
before invoking the gate. This keeps the gate model-checkable and preserves
the deterministic, file-backed pillar.

## Designation decisions for ledger findings 4 through 11

Each entry records whether the code or the rule is wrong, the owning spec, the
prose change, whether that prose is inside a section pinned by `LaneLock.tla`
(and so must wait for PR #35), whether the list prevents recurrence, and what
accepted CLI behavior changes.

**#4 `resolveHandoff` checks no actor; plain resolve from PR-flow terminates.**
Code-wrong on both halves. Owner: spec 002. The prose already designates the
reviewer for `ready-for-pr` entry (line 72) and GitHub outcomes for PR-flow
termination (lines 62, 76-77). Prose change: add to the `handoff resolve` row
of CLI Commands that a resolve from a PR-flow status is rejected, and clarify
line 77 so "human/owner intentionally resolving" means `btrain pr poll --apply`
after the PR is closed on GitHub. Both edits are pinned; wait for #35. Prevents
recurrence: yes (rows 4, 5, L1). Blast radius: `test/core.test.mjs:1539`
expects a plain resolve from a PR-flow status to succeed; agents that
plain-resolve a stuck PR-flow lane must close the PR and poll instead; resolves
without a verified actor are rejected in enforcement mode.

**#5 `resolveHandoff` resolves an idle lane.** Code-wrong, plus the missing-file
fallback and fabricated history entry described above. Owner: spec 002 CLI
Commands (pinned). Prose change: one sentence, "resolve requires an active
lane". Prevents recurrence: yes (`idle` has no `resolve` row). Blast radius:
negligible; tests resolve lanes for cleanup only from active states.

**#6 reviewer moving to `needs-review` becomes the reviewer's own owner.**
Code-wrong. Owner: spec 005. FR-7 is outside the `LaneLock.tla` pin but inside
the range spec 014 declares normative (FR-1 through FR-8), so this edit
changes normative prose; it matches the model's existing `ToNeedsReview`
guard (`IsOwner`) and is disclosed here for that reason. FR-7 says the writer
re-handoffs; add
"only the lane owner may move a lane to `needs-review`; btrain rejects other
actors rather than reassigning the reviewer". FR-5 (unpinned) already forbids
silent reassignment. Not pinned; can land now. Prevents recurrence: yes (row 2
actor guard) with FR-9 as defense in depth. Blast radius: a reviewer who
re-handoffs on the writer's behalf is rejected.

**#7 `patchHandoff` ignores source status.** Code-wrong for the listed cases
(`needs-review` from `resolved`, `pr-review` from `in-progress`, direct
`ready-to-merge`). Rule-gap for one case the ledger does not list: PR-flow
`changes-requested -> pr-review` by the owner is what the CLI guidance and the
current lane `b` rely on, and no prose or model action permits it. Owners: spec
002 PR-flow states (pinned) for the PR rows, spec 005 Proposed Status Model
(pinned) for the review rows, spec 014 designation (pinned) for repair exits.
Prose change: spec 002 must decide row 12, either designating the shortcut or
directing PR feedback back through local review. Prevents recurrence: yes, this
finding is the list. Blast radius: `test/core.test.mjs:1495-1503` sets
`ready-to-merge` directly; `test/core.test.mjs:4972` moves `repair-needed` to
`needs-review`, which spec 014 line 111 forbids; identity updates (same status)
must stay accepted.

**#8 raw `ENOENT` on a missing lane file.** Code-wrong; pure error handling.
Owner: none; spec 006 FR-2a covers the spirit. No prose change. Prevents
recurrence: no. A gate evaluated before `readText` would mask it, but the fix is
an existence check with a `BtrainError` (FR-4). Narrower than the ledger says:
`btrain init` scaffolds lane files, so only unscaffolded or deleted files hit
it. Blast radius: none.

**#9 `applyPrStatusToHandoff` from any status.** Half repaired by PR #33.
Residual is code-wrong: non-terminal outcomes from non-PR-flow statuses.
Owner: spec 002 PR-flow states (pinned). Prose change: name the legal source
statuses in rows 2 through 4 of that table (`pr-review` from `ready-for-pr`
and, if row 12 is adopted, from PR-flow `changes-requested`;
`ready-to-merge` from `pr-review`; `changes-requested` from `pr-review` or
`ready-to-merge`). Also decide whether `ready-to-merge -> pr-review` is legal
when a bot re-requests changes; the model has no such edge. Prevents
recurrence: yes (rows 8-11, L5). Blast radius: `test/pr-flow.test.mjs:633`
applies an outcome to a lane already in `pr-review`, so it survives.

**#10 `--files` rescope has no actor or status guard.** Split verdict.
Code-wrong for a third party changing the lock set. Rule-overreaching where
the spec 014 designation (lines 114-128) forbids any `--files` during
`needs-review` and PR-flow, because the same flag is also the resync path:
`patchHandoff` tells the user to pass `--files` to fix a lock mismatch
(`core.mjs:5269-5275`), spec 006 FR-2 lists "lock/status resync" as a safe
repair, and `test/watchdog.test.mjs:122` resyncs a `repair-needed` lane as
`btrain doctor`. Owner: spec 014 designation (pinned) and eventually spec 002.
Prose change: distinguish rescope (set changes; owner; `in-progress` and
`changes-requested`; system or override in `repair-needed`) from resync (set
equals the handoff record; any active status; owner or doctor). Product call:
whether the doctor counts as the guardian for FR-20 purposes. Prevents
recurrence: yes (rows 16, 17, L6) once the two events are distinct. Blast
radius: `test/watchdog.test.mjs:122` needs the doctor to be a permitted resync
actor; the mismatch error text must name the resync form.

**#11 resolve from `repair-needed` before escalation.** Code-wrong under the
spec 014 designation, and the designation is explicitly provisional (lines
100-103). Recommendation: ratify it in spec 006 with one addition. Resolve from
`repair-needed` is legal only with a human record: either the FR-2c/2d
audited, human-confirmed override, or a recorded human disposition event
after FR-18 escalation that names the lane, the reason, and the confirmer.
The escalation flag by itself is a request for a decision, not the decision;
treating it as one would let any lane agent release containment locks the
moment a same-reason re-entry set `repairEscalation: "human"`. That matches FR-15 and FR-20, which already
give a human override authority over clearing and locks, and gives a broken
lane an exit that does not require a second failure. Owner: spec 006, as a new
unpinned FR-29 "repair-needed transitions" (FR-4, FR-15, FR-18, FR-20 are
pinned; a new heading after FR-28 leaves them intact). The spec 014 designation
text must then be updated to point at FR-29, which is pinned and waits for
#35. Also designate whether the FR-18 budget spans re-claims: the model resets
on `Claim`, the implementation counts across the lane's event log (ledger
"Known gaps"). Prevents recurrence: yes, only because rows carry a data guard
(row 15). Blast radius: the habit of "resolve then re-claim" to reset a broken
lane is rejected; the legal paths are `RepairClear` then `AbandonResolve`, or
the override.

**Count.** Seven of eight findings are in scope for the list (4, 5, 6, 7, 9
residual, 10, 11). One (#8) is not. The original proposal counted four. None of
the seven can be enforced before its prose lands, so the list closes zero
ledger entries on the day the structural half merges and closes them one
designation at a time afterward.

## Non-Goals

- Adopting LangGraph, XState, or any state-machine runtime. The prior research
  (`research/a2a-langgraph-langsmith-evaluation.md`) already concluded btrain
  should take LangGraph's explicit state-machine discipline as a design
  influence only. This spec is that influence.
- Restructuring `runLoop` (`core.mjs:8022`). Its in-process state is a round
  counter and elapsed time; the handoff file is its checkpoint, and trace
  bundles already record its steps. It consumes the exported list for actor
  routing (FR-8) and nothing more.
- Changing which spec owns which rule. Rows cite owners; this spec owns the
  shape and the gate.
- Regenerating `LaneLock.tla` or `lane-lock-model.mjs` from the list, or the
  reverse.
- Modeling crash windows between the handoff write and the registry write.
  That remains spec 014 future work.
- Changing single-handoff mode semantics beyond routing its writers through
  the same gate.

## Migration path

### Phase A: structural half (no semantic impact)

1. Fix the stale implementation mirror in `lane-lock-model.mjs` so
   `npm run test:formal` fails only on the candidate gate. Reword ledger #9 and
   extend #5.
2. Add `src/brain_train/transitions.mjs` holding rows 1-20 and L1-L16, with the
   `owner` and `state` fields as data. Add `applyTransition`.
3. Route `claimHandoff`, `patchHandoff`, `requestChangesHandoff`,
   `resolveHandoff`, `applyPrStatusToHandoff`, the `pr-create` status write,
   and `applyWatchdogRepairs` through the gate. Keep every existing error
   message for transitions that are rejected today.
4. Replace the raw `ENOENT` with a `BtrainError` (FR-4).
5. Add the cross-check test (FR-7) with legacy rows excluded.
6. Add `btrain transitions --format mermaid|json` and switch the three
   `switch`-based routers to read the list (FR-8).
7. Declare no semantic impact. Run the pin check, focused implementation
   validation (`npm run test:formal` with the candidate gate still red for the
   same tallies as before), and the full suite (546 passing today).

Acceptance for Phase A: identical CLI behavior on every existing test; the
candidate tally set is unchanged; the cross-check test passes.

Rollback for Phase A: the gate lives in one new module plus call-site edits.
Reverting the merge commit restores the previous behavior with no data
migration, because the structural half writes no new fields to handoff files
or `locks.json`. The `transition-advisory` event field arrives only with
Phase B and is ignored by older readers.

### Phase B: semantic half (semantic impact, per finding)

Order by what is unpinned and can move now:

1. #6 and #8: prose in spec 005 FR-7 (unpinned); no prose for #8. Flip row 2
   to advisory, then enforce; remove L3.
2. #11: add spec 006 FR-29 (unpinned). Implement `btrain repair dispose
   --lane <id> --confirmed-by <human> --reason "..."` and the
   `repair-disposition` workflow event it writes, with a harness fixture;
   `--confirmed-by` is an unverified name, so the audit value rests on the
   event record, not on authentication. Model: add the
   disposition-or-override guard to `RepairResolve`. Flip row 15 to advisory,
   then enforce; remove L7.
3. After PR #35 merges and the pinned sections reopen: #4 (both halves), #5,
   #7, #9, #10 prose in spec 002 and the spec 014 designations, including the
   row 12 and `ready-to-merge -> pr-review` decisions and the spec 002 line
   77 reconciliation. Update `LaneLock.tla` and repin. Flip rows to advisory,
   then enforce; remove L1, L2, L4, L5, L6, L8, and L9 (the force-release
   re-acquire divergence, which the same spec 002 reconciliation designates).
4. Open-question rows: L10 (owner reassignment, Q8), L11 (abandonment
   actor, Q5), L12 (metadata-update actor), L13 (single-handoff claim
   overwrite), L14 (repeat resolve), L15 (request-changes with no verified
   actor or recorded reviewer). Each gets a one-line designation in the
   owning spec (002 CLI Commands for L11-L15, 005 FR-5 for L10) in the same
   lane as step 3, then advisory, then enforcement. Until then they stay as
   legacy rows and Phase C does not start.
5. Retire the `candidate findings absent` gate test once the tally is empty and
   switch spec 014 Phase 3 on for the pilot model.

Each step is its own lane with a semantic-impact declaration, TLC on the
affected model, focused validation, conventional tests, and an independent
model-family review (spec 014 FR-9).

### Phase C: cleanup

Remove `state: legacy` from the schema once no legacy row remains. Remove the
advisory mode once every row has been enforced for at least 30 calendar days.

## Acceptance Criteria

- Every write that changes a lane's `status`, `owner`, `reviewer`, or
  `lockedFiles`, and every registry write that is not the effect of an
  accepted row, calls `applyTransition`; the watchdog's stale and expired lock
  release is row L16. A grep for direct `updateHandoff` calls that set
  `status` outside the gate finds none.
- The list, `LaneLock.tla`, and `lane-lock-model.mjs` are three hand-authored
  transcriptions; the cross-check test proves the first and third agree on
  every non-legacy cell.
- A rejected transition names source, target, actor, reason, and a legal
  command, and is never a raw filesystem error.
- `btrain transitions --format mermaid` renders exactly the rows table above
  (rows 1-20, legacy rows styled distinctly while they exist). The partial
  diagrams in specs 005 and 006 are not the reference.
- Each legacy row is removed only by a change whose review packet cites the
  prose that landed first.
- The ledger candidate tally reaches zero while every spec 014 Review
  Independence check still holds, in particular "invariants are meaningful and
  not weakened to make TLC pass".

## Sequencing constraints

Pinned by `LaneLock.tla` while PR #35 is open (hash verified in sync with
current `main` prose on 2026-09-01): spec 002 `Lock Enforcement`, `PR-flow
states and actors`, `Force-release override`, `CLI Commands`; spec 005
`Proposed Status Model`; spec 006 FR-2c, FR-2d, FR-4, FR-5, FR-7, FR-15, FR-18,
FR-20; spec 014 `Normative-source prerequisite`, which contains the repair-exit
and rescope designations.

Unpinned and edited in this change: spec 002 line 9 and the `handoff resolve
--final` section (lines 83-91), which described repaired drift as live; spec
005 FR-7; the new spec 006 FR-29. `test/formal/README.md` was updated in PR
#34.

Lane locks in this repository: PR #34 merged on 2026-09-01 and lane `b`
released `src/brain_train/` and `test/`, so Phase A can be claimed. Phase B
steps 3 and 4 wait on #35.

Assumption: the `action` names in the rows follow `LaneLock.tla` as it stands
on PR #35. If review renames an action there, the rows follow the model, not
the reverse.

Spec 002 lines 81 and 104 still describe the three drifts PR #33 repaired as
if still open; they are pinned and wait for #35. Lines 9, 87, and 91 are
corrected in this change.

## Open questions for a human

Each question lists the viable options, which contract rows and legacy rows
change, what safety property is affected, and what follow-up work each answer
unlocks. The questions are independent except where noted.

---

### Q1. Row 12 — direct return to `pr-review` from PR-flow `changes-requested`

May the owner return a PR-flow `changes-requested` lane directly to
`pr-review`, as the CLI instructs today, or must PR feedback go back through
local review as the model assumes?

**Option A: Allow the shortcut (designate row 12).**
The owner runs `handoff update --status pr-review` from PR-flow
`changes-requested` and pushes a fix directly. The reviewer sees the fix only
through the GitHub review cycle, not through local `needs-review`.

- Row 12 moves from `undesignated` to `designated`; add one sentence to spec
  002 PR-flow states naming the shortcut.
- L5 residual narrows: the non-terminal outcome guard still applies but row 12
  is a legal source for it.
- `LaneLock.tla` gains a `ReturnToPr` action (`changes-requested` with
  `prLinked` → `pr-review`, `IsOwner`). TLC must recheck all invariants.
- Safety: weaker local review coverage — a bad fix could reach GitHub CI
  without a peer seeing it locally. Acceptable when the PR review is
  substantive (bot-checked repos); risky when GitHub review is rubber-stamp.
- Follow-up: add the TLA action, repin spec 002, update the cross-check
  fixtures; advisory then enforcement for row 12.

**Option B: Require local re-review (reject the shortcut).**
PR feedback goes `changes-requested` → `needs-review` (row 2, owner
re-handoffs with reviewer context) → `ready-for-pr` → `pr-review`. The model
stays as-is.

- Row 12 stays `undesignated` or is removed; the CLI guidance in
  `buildLaneGuidance` is changed to instruct the owner to fix and re-handoff
  locally.
- Removing row 12 alone does not enforce the rejection: legacy row L4 accepts
  `handoff update --status <X>` from any status with any actor, so the
  shortcut still matches L4. L4 must be narrowed to exclude
  `changes-requested` with a linked PR → `pr-review`, or retired entirely, for
  the local-review guarantee to hold.
- No TLA change.
- Safety: stronger local review coverage; slower turnaround on small PR
  feedback.
- Follow-up: update `buildLaneGuidance` and `defaultNextActionForStatus` to
  stop emitting the shortcut instruction; narrow or retire L4 for the
  `ReturnToPr` case (Phase B step 3, alongside the spec 002 designation that
  replaces L4's blanket acceptance). Put the narrowed L4 path into advisory
  mode in the same commit that records the row-12 removal decision. Enforce
  rejection only after the L4 advisory minimum and quiescence checks pass;
  until then, keep accepting and recording the legacy shortcut.

**Affected rows:** 12, L4, L5.
**Safety property:** review coverage (local peer sees every fix before GitHub).
**Dependency:** pinned by spec 002 PR-flow states; lands in Phase B step 3.

---

### Q2. Row 17 — does `btrain doctor` count as the spec 006 guardian for resync?

Does `btrain doctor` count as the spec 006 guardian for resync during
`repair-needed`, `needs-review`, and PR-flow?

**Option A: Doctor is guardian for resync.**
`btrain doctor` may run `--files` resync (same set, restore coverage) in any
active status. Row 17 actor becomes `owner, or system` where system includes
doctor.

- Row 17 state moves from `undesignated` to `designated`.
- `test/watchdog.test.mjs:122` directly invokes `handoff update --files`,
  not `btrain doctor --repair`; it does not test the real doctor resync path.
  Implementation must route `doctor --repair` through `applyTransition` as a
  `system` actor, and new tests must exercise `btrain doctor` end-to-end
  (not via bare `handoff update`) to verify that doctor restores lock
  coverage via row 17.
- Spec 006 FR-2 "lock/status resync" gains a one-line designation: "btrain
  doctor is a guardian actor for resync operations."
- Safety: doctor already runs unattended (`btrain doctor` in CI or cron). If
  it can resync in `needs-review`, a reviewer's lock view could shift
  mid-review, though only to match the handoff record (no new files).
- Follow-up: designate in spec 006 FR-2; update row 17 state.

**Option B: Doctor may resync only in `in-progress`, `changes-requested`, and
`repair-needed`.**
In `needs-review` and PR-flow statuses, the designation must choose one of two
authorities: owner only, or owner with an audited override.

- Row 17 splits: one sub-row for doctor-permitted statuses, one for the rest.
- The restricted-status sub-row uses actor `owner` for owner-only authority.
  If an audited override is allowed, that sub-row must instead name actor
  `owner, or override`; the current row-17 actor cannot support an override
  while it remains `owner` only.
- `test/watchdog.test.mjs:122` directly invokes `handoff update --files`,
  not `btrain doctor --repair`; it does not verify the real doctor resync
  path. Implementation must route `doctor --repair` through
  `applyTransition` as a `system` actor for the permitted statuses, and new
  tests must exercise `btrain doctor` end-to-end to confirm that doctor is
  rejected in `needs-review` and PR-flow statuses.
- Safety: reviewer's lock view is stable during review.
- Follow-up: split row 17 or add a status guard to the doctor path; designate.

**Option C: Doctor is never guardian for resync.**
Doctor and watchdog may only release stale locks (L16), not restore coverage.
The designation must also select the non-doctor authority:

- **(C-i) Owner only.** Row 17 actor stays `owner`; remove override wording
  from the requirement and guidance.
- **(C-ii) Owner or audited override.** Row 17 actor becomes
  `owner, or override`; tests must consume the override before resync.

- `test/watchdog.test.mjs:122` needs rework to use the owner actor.
- Safety: tightest; no unattended lock-coverage changes.
- Follow-up: fix the test; encode C-i or C-ii in row 17 and its actor tests;
  decide whether doctor should prompt the owner to resync instead.

**Affected rows:** 17, L6.
**Safety property:** lock-coverage stability during review.
**Dependency:** spec 006 FR-2 and FR-20 are pinned; the designation text is
not. The row-17 designation can land in Phase B step 3 when the pins lift.

---

### Q3. Row 15 — override exit from `repair-needed`

Accept the audited-override exit from `repair-needed`, or keep the spec 014
designation that only escalation unlocks resolve?

**Option A: Both exits — escalation or override.**
Row 15 guard is: `(recorded human disposition after FR-18 escalation) OR
(consumed FR-2c/2d override)`. Either path is a human decision.

- Row 15 stays as written; state moves from `provisional, product call` to
  `designated`.
- L7 guard is: row-15 guard not met — i.e., neither disposition nor override.
- The override path gives a stuck lane an exit without waiting for a second
  failure to trigger escalation.
- Safety: the override is already audited and human-confirmed (FR-2d), so
  containment integrity is equivalent to the escalation path.
- Follow-up: designate in spec 006 FR-29; implement the override check in the
  gate guard; model: `RepairResolve` gains an `\/ overrideConsumed` disjunct.

**Option B: Escalation only — override cannot resolve `repair-needed`.**
Row 15 guard requires the FR-18 escalation budget to be exhausted and a
recorded disposition. An override can clear (`RepairClear`, row 14) but not
terminate.

- Row 15 guard drops the override disjunct.
- A lane that enters `repair-needed` once and cannot be cleared must fail a
  second time (re-enter `repair-needed` after `RepairClear`) before it can
  resolve. Alternatively the human uses the override to clear (row 14), works
  around the problem, and resolves normally.
- Caveat: an override can take row 14 (`RepairClear`) from `repair-needed` to
  `in-progress`, after which either lane agent can use row 6
  (`AbandonResolve`) to resolve the unlinked lane in two commands, bypassing
  the repair-attempt enforcement. To close this escape, either (a) constrain
  row 6 so that a lane whose most recent `RepairClear` was via override cannot
  be abandoned without a subsequent `needs-review` cycle or a second repair
  entry, or (b) accept the two-step path as a deliberate human exit (the
  override is already audited) and do not claim "forces repair attempt" as
  the safety benefit; the benefit is instead that the override audit trail
  makes the skip visible.
- Safety: stronger repair containment than Option A only if the two-step
  escape is closed (sub-option a); otherwise the safety benefit is audit
  visibility, not enforcement.
- Follow-up: spec 006 FR-29 exit-to-resolved paragraph names only the
  disposition path; no override disjunct. If sub-option (a), add a guard to
  row 6 or a post-override flag on `RepairClear`, then update the formal model
  and harness for that guard. Both sub-options must add an override-consumed
  input and an override-authorized `RepairClear` action to the formal model
  and harness. Sub-option (b) does not add the post-clear abandonment guard,
  but the model must add and check a named reachability witness,
  `OverrideAbandonReachable`, for an override-authorized `RepairClear`
  followed by `AbandonResolve`. The `RepairBudgetBounded` commentary must
  identify that path as an accepted audited exit rather than a containment
  violation.

**Affected rows:** 15, L7.
**Safety property:** repair containment (whether a lane can skip the repair
attempt).
**Dependency:** spec 006 FR-29 is unpinned and already drafted. This can land
in Phase B step 2.

---

### Q4. FR-18 budget — does a fresh claim reset the repair count?

Does a fresh claim on the same lane reset the repair count?

**Option A: Claim resets the count; `RepairClear` does not (model behavior).**
`LaneLock.tla` line 117: `Claim` sets `repairCount' = 0`; line 248:
`RepairClear` leaves `repairCount` `UNCHANGED`. A new task on the same lane
starts with a fresh budget, but clearing a repair within the same task does
not reset the count. This is the current model behavior; only the
implementation needs alignment.

- The implementation must match: the gate limits the FR-18 count to events
  after the most recent claim. `claimHandoff` must retain the cold workflow
  event history for audit, actor attribution, and recovery diagnostics.
- The current implementation counts from the lane's event log across claims
  (`test/formal/README.md` line 116-120, "Known gaps"). Aligning it requires
  scoping the count to the current task without deleting earlier events.
- Safety: a lane with a history of fragile tasks gets a fresh chance each
  time. A systemic problem (e.g., bad file locks on lane `a`) can cycle
  indefinitely through claim-repair-claim without escalating.
- Follow-up: scope the FR-18 count to events after the most recent claim;
  update the Known gaps entry in `test/formal/README.md`.

**Option B: Same-failure count persists across claims.**
The event log is the source of truth. `repair-needed` entries persist across
claims, but each count is keyed by the same unresolved reason or problem. An
unrelated repair reason starts its own count. The model must change to match.

- Removing only Claim's `repairCount' = 0` is not sufficient: every terminal
  transition (`AbandonResolve`, `PrTerminal`, `TerminalResolve`,
  `RepairResolve`) also resets `repairCount` to 0
  (`LaneLock.tla:383-389` requires `repairCount = 0` for resolved lanes via
  `RepairBudgetBounded`). A lane therefore passes through `resolved`
  (count = 0) before it can be re-claimed, making the Claim-only change a
  no-op. Two sub-options:
  - **(B-i) Use a persistent reason-keyed count.** Replace the scalar with a
    map such as `repairCountByReason` from each lane and repair reason to
    `0..MaxRepair`. Each terminal action and `Claim` keeps that map
    `UNCHANGED`. Replace the scalar invariant with
    `RepairBudgetBoundedByReason`, which requires every lane/reason entry to
    remain at or below `MaxRepair` and does not require resolved lanes to have
    zero counts. Counts do not reset unless a later human decision designates
    an explicit audited reset action. TLC must recheck all properties.
  - **(B-ii) Add a dedicated lifetime-history variable.** Keep the existing
    task-scoped `repairCount` and its terminal reset. Add a model variable such
    as `laneRepairHistory` that persists across terminal transitions and
    claims and stores the repair reason with each entry. Use only entries for
    the current reason in the FR-18 escalation guard. Update the implementation
    and harness to use the same reason-keyed lifetime scope. TLC must check the
    resulting cross-claim escalation behavior before this option lands.
- Safety: a lane that repeatedly hits the same failure escalates even if
  different tasks trigger it. An unrelated failure does not inherit the prior
  failure's count.
- Follow-up for B-i: update every terminal action, `Claim`, and
  `RepairBudgetBounded`; rerun TLC and update the harness mirror. Follow-up
  for B-ii: add the lifetime-history variable and its invariants, then update
  every repair-entry and escalation action that reads or writes it. In both
  cases, update the harness mirror and keep the implementation count across
  claims in the event log. Persistent-count behavior cannot land while the
  approved model still resets all escalation state per task.

**Affected rows:** 1 (Claim), 13 (RepairEnter), 14 (RepairClear), 15
(RepairResolve).
**Safety property:** escalation reachability (how quickly a fragile lane
reaches human attention).
**Dependency:** the Known gaps entry in `test/formal/README.md` tracks this.
Can land as a spec 006 FR-18 clarification (unpinned paragraph) in Phase B
step 2.

---

### Q5. Row 6 — who may abandon an `in-progress` lane?

Who may abandon an `in-progress` or `changes-requested` lane (without a linked
PR), owner only or both owner and reviewer?

**Option A: Lane-agent (owner or reviewer), matching the model.**
`LaneLock.tla` `AbandonResolve` uses `IsLaneAgent` (line 205). Either the
owner or the reviewer can resolve an unlinked, un-reviewed lane.

- Row 6 actor stays `lane-agent`; state moves from `undesignated (actor)` to
  `designated`.
- L11 (the legacy fallback with unchecked actor) becomes redundant once row 6
  is enforced, and is retired.
- Safety: a reviewer can unilaterally kill work the owner is mid-flight on.
  Mitigated by the fact that the lane is not in `needs-review`, so the
  reviewer is not the active party.
- Follow-up: add one sentence to spec 002 CLI Commands: "either the owner or
  the reviewer may resolve an active lane that has not entered review or PR
  flow and has no linked PR." Retire L11.

**Option B: Owner only.**
Only the owner can abandon their own in-progress work.

- Row 6 actor changes to `owner`; `LaneLock.tla` `AbandonResolve` changes
  `IsLaneAgent` to `IsOwner`.
- L11 stays until the model is updated; then it narrows to the reviewer case
  only and is retired.
- Safety: prevents a reviewer from discarding in-flight work. The reviewer
  must wait for `needs-review` or ask the owner to abandon.
- Follow-up: update `LaneLock.tla`, rerun TLC (may lose reachable states),
  update the cross-check fixtures, retire L11.

**Affected rows:** 6, L11.
**Safety property:** work-in-progress protection (whether a reviewer can
discard uncommitted owner work).
**Dependency:** spec 002 CLI Commands is pinned; the designation sentence
waits for Phase B step 3. The model change (if option B) can land alongside.

---

### Q6. FR-6 — unverified actor in enforcement mode

In enforcement mode, should an unverified actor be rejected or treated as the
lane owner when only one agent is configured?

**Option A: Reject unverified actors unconditionally.**
If `resolveVerifiedActor` yields empty, the gate rejects with the fix
"pass `--actor` or set `BTRAIN_AGENT`". No exception for single-agent repos.

- FR-6 enforcement is uniform: the fix message is always correct.
- Single-agent repos (e.g., a solo developer) must shell-export
  `BTRAIN_AGENT` (e.g., `export BTRAIN_AGENT=claude` in `.zshrc` or
  `.bashrc`). The CLI does not load `.env`; a shell export is required.
  This is a one-time setup cost.
- Safety: no implicit authority grants. The actor is always known.
- Follow-up: update the advisory-mode warning text to mention the single-
  agent case; add a `btrain init` prompt that reminds the user to
  `export BTRAIN_AGENT=<name>` in their shell profile. FR-6 owns this
  initialization reminder and its acceptance check.

**Option B: Infer the lone agent when exactly one is configured.**
If `resolveVerifiedActor` yields empty and `config.agents.active` has exactly
one entry, treat the actor as that entry. Reject only when there are multiple
configured agents and none can be resolved.

- Row 2, 3, 6, etc. actor predicates pass for the lone agent without
  `--actor`.
- Less friction for solo developers; more implicit behavior to document.
- Safety: safe only when the one-agent invariant holds. If a second agent is
  added later, commands that relied on inference silently start failing,
  which is confusing but not dangerous.
- Follow-up: implement the inference in `resolveVerifiedActor` behind a
  count check; document the behavior in spec 002 CLI Commands; advisory
  warning when inference is used so the user knows it will break if agents
  are added.

**Option C: Reject, but with a better error message for single-agent repos.**
Same as option A, but the rejection message for a single-agent repo says
"`export BTRAIN_AGENT=<the-one-agent>`" with the actual name filled in.

- Uniform rejection, better UX for the common case.
- Follow-up: minor change to the error formatter; no spec change beyond FR-6.

**Affected rows:** all rows with actor predicates (2, 3, 4, 5, 6, 7, 12, 13,
14, 15, 16, 17, 18, 19, 20 and their legacy counterparts).
**Safety property:** actor authority integrity (whether implicit grants exist).
**Dependency:** FR-6 enforcement is Phase B; the decision shapes the error
messages and whether `resolveVerifiedActor` changes. Independent of pins.

---

### Q7. Row 13 — who may declare `repair-needed` manually?

Who may declare `repair-needed` manually: any configured agent, or only the
reviewer, the guardian, and the watchdog?

**Option A: Any configured agent.**
Row 13 actor stays `any-agent` (plus `system` for the watchdog). Any agent
that detects a workflow-integrity problem can flag it.

- `test/e2e.test.mjs:596` (reviewer declares repair) passes without change.
- The owner can self-report a problem on their own lane, which is useful when
  the owner discovers the issue mid-work.
- Safety: lower bar for entering `repair-needed`. A misbehaving agent could
  force lanes into repair, but the reason code is still required and the
  repair taxonomy constrains what qualifies.
- Follow-up: designate in spec 006 FR-4 or FR-29 with one sentence; move
  row 13 from `provisional` to `designated`.

**Option B: Reviewer, guardian (system), and watchdog only — not the owner.**
The owner's path for a self-discovered problem is to request changes on
themselves (not currently possible) or ask the reviewer to declare repair.

- Row 13 actor changes to `reviewer, system`.
- `test/e2e.test.mjs:596` still passes (it uses the reviewer).
- The owner cannot self-report, which adds friction. In practice the watchdog
  or doctor catches most problems, so the owner route is rare.
- Safety: prevents an owner from using `repair-needed` to stall or reset
  review progress, since `RepairClear` returns to `in-progress`, not
  `needs-review`.
- Follow-up: designate; update the row; decide whether the owner should have
  a "request repair" path that asks the reviewer or watchdog.

**Option C: Any configured agent, but advisory warning when the owner declares
repair on their own lane.**
Compromise: the owner can declare, but a separate `self-repair-audit` field
records the declaration so the pattern is visible in the workflow event log.
This field is not a `transition-advisory` and does not count against the FR-5
retirement gate. An accepted self-repair therefore cannot block row 13 from
reaching enforcement.

- No hard rejection. The audit trail flags self-repair declarations without
  classifying them as behavior that enforcement will reject.
- Follow-up: add the `self-repair-audit` workflow-event field for the
  owner-declares-own-repair case; exclude it from FR-5 advisory retirement;
  designate. Use the canonical lane-event JSONL schema owned by
  `core.mjs`, as described in spec 006 FR-9 and spec 013, rather than a
  separate audit file.

**Affected rows:** 13, L4 (which accepts any status, any actor).
**Safety property:** repair-needed entry integrity (whether the owner can
weaponize `repair-needed`).
**Dependency:** spec 006 FR-4 is pinned; a new sentence in FR-29 (unpinned)
can carry this. Phase B step 2.

---

### Q8. Row 20 — owner reassignment by a lane agent

May the owner of a lane be reassigned by a lane agent (via `handoff update
--owner`), or only through a fresh claim (`handoff claim`)?

**Option A: Allow owner reassignment by a lane agent.**
Row 20 stays as written: `lane-agent` may change `--owner` or `--reviewer` in
any active status, with the distinct-from constraint.

- L10 (the legacy fallback that also works on `idle` and `resolved`) is
  retired once row 20 is enforced.
- A reviewer can reassign the owner mid-work, which could disrupt an
  in-progress lane.
- Safety: flexible; enables hand-off of ownership without losing the lane's
  state, locks, and PR linkage. Risk: an agent reassigns ownership to dodge
  review. The distinct-from constraint does not preserve review independence:
  one update can swap the current owner and reviewer while the final identities
  remain distinct. A sequence of individually valid updates can produce the
  same result through an intermediate agent. The lane must therefore retain
  author and review provenance across role changes.
- If Option A is selected, the designation must also choose a swap policy:
  - **(A-i) Reject role reversal without an override.** Record the task's
    authors and prior owners. Reject any update that makes one of those agents
    the reviewer, whether the reversal is simultaneous or occurs through
    intermediate owner and reviewer assignments.
  - **(A-ii) Require an audited override for role reversal.** Apply the same
    provenance check as A-i, but accept the resulting role assignment only
    with a consumed override. The workflow event records the override, the
    prior role history, and both final roles.
  - **(A-iii) Allow role reversal.** The contract explicitly accepts that
    distinct final identities and sequential updates do not guarantee review
    independence.
- For A-i, A-ii, and Option C, the formal follow-up adds
  `authorHistory` as a lane-indexed set of agents and checks the named
  `AuthorSeparation` invariant: a lane's reviewer is not in that lane's
  author history. A-ii adds an explicit consumed-override exception and a
  reachability witness for the audited reversal. A-iii must explicitly remove
  this invariant rather than weakening it implicitly.
- Follow-up: designate Option A and its swap policy in spec 005 FR-5; enforce
  the selected provenance guard for single and paired updates; retire L10.

**Option B: Owner reassignment only through claim.**
Remove `--owner` from `handoff update`. To change the owner, resolve the lane
and re-claim with the new owner.

- Row 20 loses the `--owner` case; only `--reviewer` reassignment remains.
- Forces a clean break: new owner starts with a fresh claim, fresh locks,
  fresh reviewer context.
- Safety: strongest isolation — no mid-stream ownership transfer. The lane
  loses its active reviewer context, PR linkage, and lock state on re-claim.
  It retains audit history: resolve appends a `Previous Handoffs` entry, and
  the workflow event log persists across claims.
- Linked-PR consequence: a lane in `pr-review` or `ready-to-merge` cannot be
  resolved and re-claimed without first closing or merging the PR (row 11
  `PrTerminal` is the only exit from PR-flow to `resolved`). Closing or
  merging the linked PR drives `PrTerminal`, which resolves the lane and
  releases locks. The new owner then claims the lane and opens a new PR.
- Follow-up: remove `--owner` from `patchHandoff`; document the linked-PR
  sequence in spec 002 CLI Commands.
- This option depends on Q5. If Q5 Option B also makes the owner the only
  actor that can abandon work, the decision must choose one of these policies:
  - **(B-i) Disallow the combination.** Q8 Option B cannot be selected with
    Q5 Option B. Otherwise, an unavailable owner on an unlinked active lane
    has no authorized lane-agent exit, so the combination can deadlock until
    an external actor returns.
  - **(B-ii) Add an audited guardian takeover.** When the current owner is
    unavailable, a verified guardian can consume an override and atomically
    assign a takeover owner without releasing locks or losing lane metadata.
    The event records the unavailable-owner evidence, override, prior owner,
    and takeover owner. The takeover owner can then continue the lane or use
    the Q5 owner-only abandon path before a fresh claim. If the takeover also
    changes the locked-file set through row 16, it must consume a separate
    audited rescope override; the one-time takeover override cannot be reused.
- The contract, formal model, and harness must represent the selected
  dependency policy before either dependent option is enforced.

**Option C: Allow reassignment, but only by the current owner (not the
reviewer).**
Row 20 actor for `--owner` changes to `owner` (only the owner can hand off
their own ownership). The reviewer can still be reassigned by either agent.

- Prevents a reviewer from seizing ownership but allows the owner to
  voluntarily transfer.
- Safety: moderate — the owner consents to the transfer. Still allows
  mid-stream changes but only at the owner's initiative. As in Option A, a
  simultaneous or sequential owner-reviewer swap can make an earlier author
  the reviewer. The designation must apply provenance policy A-i, A-ii, or
  A-iii to Option C too.
- Follow-up: split row 20 into two sub-rows (one for `--owner` with actor
  `owner`, one for `--reviewer` with actor `lane-agent`); enforce the selected
  provenance guard for single and paired updates; designate.

**Affected rows:** 20, L10.
**Safety property:** ownership integrity (whether ownership can change without
a clean claim boundary).
**Dependency:** spec 005 FR-5 is unpinned for the reassignment sentence. Can
land in Phase B step 4.
