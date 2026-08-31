# 014 — Specula Formal Verification Pilot

**Status**: Draft
**Version**: 0.1.5
**Author**: btrain
**Date**: 2026-08-29
**Updated**: 2026-08-31

## Decision

Create a new numbered specification for the Specula integration. Do not extend
specs 004–007 and do not run the literal `speckit-specify` workflow yet.

The integration introduces a distinct governance surface:

- formal-impact declarations for behavioral changes
- ownership of intended prose, TLA+ models, invariants, and validation harnesses
- focused verification before peer review
- deterministic formal verification on the exact PR head
- independent review of substantive model changes
- distinct outcomes for counterexamples, conformance mismatches, exhausted state
  spaces, and tool or provider failures
- a bounded rollout and resource policy for Specula

The repository currently uses flat, Spec Kit-style files under `specs/`. The
repo-local `speckit-specify` skill requires a `.specify/` directory, which this
repository does not have, and spec 004 leaves full Spec Kit bootstrap unresolved.
Spec 014 therefore follows the existing flat convention. Migrating it into a
full `.specify/` feature directory is a separate governance decision.

## Summary

Pilot formal verification on one bounded btrain workflow state machine: lane
status, actor ownership, file-lock ownership, review and rework routing, PR
lifecycle, and repair-attempt escalation.

The intended behavior remains authoritative. Specula may analyze the code,
propose model or harness changes, and test conformance, but it must not silently
regenerate the intended model from the current implementation. A passing model
is useful only when reviewers agree that it describes the intended workflow and
the implementation-validation harness connects real behavior to that model.

## Existing Specification Ownership

Spec 014 owns the formal-verification lifecycle, not the underlying workflow
semantics.

| Surface | Existing owner | Spec 014 relationship |
| --- | --- | --- |
| Lane and lock basics | spec 002 | Pins only reconciled normative claims |
| AgentChatTR and btrain authority | spec 004 | Preserves btrain as workflow authority |
| Review-return behavior | spec 005 | Verifies the approved `changes-requested` contract |
| Repair behavior and retry bound | spec 006 | Verifies the approved `repair-needed` contract |
| Implementation sequence | spec 007 | Adds a later formal-integration workstream; does not rewrite it |
| Harness traces and eval artifacts | specs 009 and 013 | Reuses storage and discovery where compatible; does not delegate formal verdict policy |

### Normative-source prerequisite

No TLA+ model may be treated as authoritative until conflicting prose is
reconciled and exact normative ranges are designated.

Lock release is designated in spec 002 v1.1.2 (2026-08-30):

- Terminal `resolved` releases the lane's locks.
- When `[pr_flow].enabled` is true, peer `handoff resolve` is local approval
  and advances to `ready-for-pr`. Locks are retained through `ready-for-pr`,
  `pr-review`, and `ready-to-merge`, and released when the PR merges or closes
  (or via `btrain locks release-lane`).
- Close without merge is terminal `resolved` plus lock release. It is not
  `repair-needed`. Spec 006 retention applies to workflow-integrity repair, not
  GitHub close. Current JS that routes close to `repair-needed` is drift, not
  the contract.
- `btrain locks release` / `release-lane` suspend matching coverage only
  after a verified spec 006 FR-2c/FR-2d override (request, reason, human
  confirm, consume). An unaudited CLI release is drift, not a valid
  uncovered trace (spec 002 Force-release override).
- Specula must pin this designated contract. It must not choose whichever
  behavior the implementation currently exhibits if that later drifts.

Exact normative ranges for the first model:

- spec 002 v1.1.2, sections Lock Enforcement, PR-flow states and actors,
  Force-release override, and CLI Commands: lock acquisition, exclusivity,
  PR-flow retention, terminal release, PR-feedback return to
  `changes-requested`, `ready-for-pr` / `pr-review` / `ready-to-merge` /
  merge / close actors, and force-release
- spec 005 v0.1.0, section Proposed Status Model and FR-1 through FR-11: the
  `changes-requested` local review-return contract, covering status semantics,
  active lane and lock treatment, canonical findings, reviewer identity,
  next-actor routing, and the same-lane rework loop
- spec 006 v0.1.0, FR-2c, FR-2d, FR-4, FR-5, FR-7, FR-15, FR-18, and FR-20:
  the `repair-needed` workflow-integrity contract, covering state entry,
  lane-local freeze, repair ownership, clearing, the one-retry
  human-escalation bound, lock retention, and the audited override
  (not GitHub close)

## Goals

- Establish an owned, reviewable formal-verification lifecycle for btrain.
- Bootstrap one small TLA+ model and a code-to-model validation harness.
- Make formal impact explicit for relevant changes.
- Run focused TLC and implementation validation before substantive behavioral
  changes are handed to a peer.
- Re-run deterministic checks on the exact PR head in CI.
- Keep substantive model changes independently reviewed.
- Distinguish verification failures from infrastructure or provider failures.
- Gather pilot evidence before any hard, repository-wide formal gate is adopted.

## Non-Goals

- Modeling all of btrain, AgentChatTR, Git, GitHub, subprocesses, or coding-agent
  behavior in one state space.
- Treating Specula, TLC, or any single coding agent as an oracle.
- Regenerating committed TLA+ files from scratch after every code change.
- Requiring the complete Specula assessment and bug-confirmation pipeline on
  every PR.
- Proving arbitrary JavaScript correctness from TLC alone.
- Bootstrapping the repository's full `.specify/` structure in this pilot.
- Making CI depend on interactive Codex credentials during the pilot.

## Authority and Artifact Ownership

The authoritative chain is:

```text
approved intended behavior in prose
    -> pinned, peer-reviewed TLA+ model and invariants
    -> deterministic TLC result
    -> implementation-validation harness and traces
    -> conventional tests
```

Each link answers a different question:

- Prose answers what btrain should do.
- TLA+ makes the selected state-machine claims precise.
- TLC explores the bounded model and checks its invariants.
- The Specula-generated harness tests whether real implementation traces conform
  to the approved model.
- Conventional tests cover implementation details outside the model boundary.

Committed prose, TLA+ files, configurations, instrumentation mappings, and
validation harnesses are btrain-owned artifacts. Specula may create the first
version and assist with incremental edits, but it may not replace those files
without a reviewable diff.

## Pilot Scope

### In scope

- valid lane-status transitions
- the actor permitted to perform each transition
- owner and reviewer separation
- lock acquisition, exclusivity, retention, rescoping, and release
- `needs-review` to approval or `changes-requested` routing
- PR-flow states from local approval through merge or closure
- `repair-needed` ownership and one-attempt escalation behavior
- crash or failure windows between separate handoff and lock-registry writes

### Abstract external events

GitHub results, filesystem failures, subprocess outcomes, provider availability,
and agent actions are represented initially as nondeterministic external events.
The pilot verifies how btrain responds to those outcomes, not the internals of
the external systems.

### Excluded from the first model

- dashboard rendering
- prompt wording and token efficiency
- Git transport and merge implementation
- bot natural-language review quality
- full event-history compaction
- Cgraph and Unblocked advisory content
- multi-repository dashboard aggregation

These may be tested conventionally or modeled later if evidence justifies the
added state space.

## Formal-Impact Declaration

Every change touching the modeled prose, implementation entry points, model,
or harness must declare one of two outcomes in its review packet.

### No semantic impact

The author records a short rationale, keeps the approved model stable, and runs
the prose-to-model pin check. The remaining evidence depends on what the change
touches:

- Code-free edits require the pin check only. Examples include prose
  formatting, comment changes, documentation edits, and test-only changes that
  do not alter observed modeled behavior.
- Changes that touch a modeled implementation entry point, such as equivalent
  refactors, must also run focused implementation validation before review.
  The pin check never exercises code. Validation is what detects a mistakenly
  non-equivalent refactor.

### Semantic impact

The author must update the intended prose first, then update the TLA+ model and
invariants, implementation, and validation harness as required. A semantic
change is not review-ready until focused TLC, implementation validation, and
conventional tests have run or an explicit infrastructure gap has been recorded
under the failure policy below.

An implementation change without an intended-behavior change keeps the model
stable. Its primary formal question is whether the new implementation still
conforms to the approved model. Focused implementation validation answers that
question before review.

## Lifecycle

### One-time bootstrap

```text
scoped Specula assessment
    -> modeling brief
    -> reconcile and designate normative prose
    -> TLA+ model and invariants
    -> implementation-validation harness
    -> baseline TLC and trace validation
    -> independent peer review of model and evidence
```

The bootstrap must use a pinned Specula version and `--keep-original`. Setup or
harness changes produced in Specula's private source copy are reviewed as a
patch before any selective adoption into btrain.

### Per behavioral change

1. Declare formal impact.
2. Update intended prose first when behavior changes.
3. Update the model, invariants, and harness incrementally when needed.
4. Implement the code change.
5. Before `needs-review`, run the pin check, focused TLC for affected models,
   focused code-to-model validation, and conventional tests.
6. Give the peer reviewer the code, model changes, validation evidence, bounds,
   and remaining gaps.
7. Create the PR only after local peer approval.
8. CI reruns deterministic formal checks on the exact PR head.

### Audit cadence

- Every relevant change: formal-impact declaration and pin check.
- Implementation change touching a modeled entry point: focused implementation
  validation before review.
- High-risk semantic change: focused TLC, focused Specula validation, and
  independent model review before handoff.
- Every PR affecting a committed model or modeled behavior: exact-head pin,
  TLC, trace validation, and conventional checks in CI once the pilot gate is
  enabled.
- Nightly or explicit audit: broader Specula analysis, bug hunting, and
  confirmation as resources and credentials allow.

The complete Specula pipeline is not an unconditional every-PR step.

## Review Independence

The same agent may propose implementation, prose, model, and harness changes,
but it may not be the only substantive reviewer of a TLA+ semantic change.

Peer review must check:

- the model expresses the intended behavior rather than current accidental code
- invariants are meaningful and not weakened to make TLC pass
- abstraction boundaries do not assume away the failure being investigated
- harness events and fields map honestly to implementation behavior
- TLC bounds and any exhaustion warning are visible
- a current result corresponds to the exact reviewed commit

The independent reviewer should be a different model family or a human for
substantive model changes. Formatting-only model edits still require the normal
btrain peer-review path but do not require an additional formal-methods reviewer.

## Verification Outcomes

Formal tooling must produce machine-readable and human-readable outcomes.

| Outcome | Meaning | Pilot policy |
| --- | --- | --- |
| `pass` | Pins are current, TLC completed without a counterexample, and validation matched | Eligible for review or merge |
| `stale_model` | Pinned prose changed without an acknowledged model decision | Block |
| `counterexample` | An invariant failed in the bounded TLA+ model | Block |
| `validation_mismatch` | A real implementation trace does not conform to the approved model | Block |
| `state_space_exhausted` | TLC did not complete within configured resource bounds | Warn and require explicit reviewer disposition during pilot |
| `tool_unavailable` | A required binary, credential, provider, or service was unavailable | Report as infrastructure failure; never relabel as a correctness failure or pass |
| `policy_blocked` | A provider refused or could not perform a phase | Report separately from verification evidence and route to an approved alternative or human |

When the pilot becomes a required gate, its policy must explicitly decide
whether `state_space_exhausted` and `tool_unavailable` block merging. The
decision must not be hidden in shell exit-code handling.

## Pre-Review and CI Evidence

The review packet for a formal-impact change must include:

- formal-impact classification and rationale
- authoritative prose range or decision record
- changed model and harness files
- Specula version and isolated-run identifier
- TLC configuration, bounds, states explored, depth, and verdict
- trace-validation command and verdict
- conventional test command and verdict
- unverified paths and tool/provider failures
- specific questions for the independent reviewer

CI must verify evidence against the exact PR head. Cached results are reusable
only when keyed by all semantic inputs: source commit, prose range/hash, TLA+
content, TLC configuration, instrumentation mapping, harness version, and trace
set.

## Operational and Security Policy

- Pin the Specula version used for repeatable checks.
- Use `--keep-original` for assessments and confirmation runs.
- Review generated setup changes and `changes.patch` before adoption.
- Do not expose repository or CI secrets to unreviewed generated harness code.
- Start with one target and one model; do not run parallel full assessments.
- Bound TLC memory and worker usage explicitly on shared systems.
- Preserve exact logs and evidence for failures; do not retry until a failure is
  indistinguishable from a pass.
- Keep interactive provider credentials out of required CI. Prefer committed,
  deterministic TLC and harness commands in CI; keep agent-driven analysis in
  explicit or scheduled jobs until noninteractive authentication is approved.

## Current Bootstrap Gaps

The bundled formal skills are currently phase-zero scaffolding, not a working
gate:

- `speckit-formal`, `tla-author`, and related skills cite nonexistent sections
  of spec 002
- `specs/tla/` does not exist
- `scripts/tla_pin.py` does not exist
- `tla-pin-sync` therefore cleanly no-ops
- pre-handoff does not currently run a TLA pin or focused formal check
- PR CI does not currently contain a formal-verification job

The pilot must repair these ownership and implementation gaps before claiming
that btrain already has a complete formal gate.

## Functional Requirements

### FR-1: New formal-governance owner

Spec 014 must remain the authority for formal-impact, review, gate, evidence,
failure, and rollout policy.

### FR-2: Authoritative behavior before modeling

Every committed model must identify reconciled normative prose. Conflicting
prose blocks model approval.

### FR-3: Explicit formal impact

Relevant review packets must declare semantic impact or no semantic impact with
a rationale.

### FR-4: Stable intended model

Implementation-only changes must not automatically rewrite the approved TLA+
model.

### FR-5: Model-to-prose drift protection

Committed TLA+ files must be pinned to owned prose through a deterministic drift
check.

### FR-6: Code-to-model validation

The pilot must include an executable harness that emits traces suitable for
validation against the approved model.

The pilot harness engine is the fast-check property-based testing library, run
in model-based mode under `node --test`. The harness must drive the
implementation entry points with generated command sequences. It must check
each step against an executable transcription of the approved model. It must
record the seed that reproduces each run. Harness runs must not require agent
or provider credentials. Specula may generate and edit harness code, but replacing
the engine is a spec 014 policy change, not an implementation detail.

### FR-7: Focused pre-review verification

Pre-review verification must match the declared formal impact. Semantic-impact
changes must run affected-model TLC and focused implementation validation
before entering `needs-review`. No-semantic-impact changes that touch a
modeled implementation entry point must run focused implementation validation
before entering `needs-review`. Code-free no-semantic-impact edits require
the pin check only.

### FR-8: Exact-head CI verification

CI must rerun deterministic formal checks on the exact PR head for affected
models before merge once the pilot gate is enabled.

### FR-9: Independent semantic review

Substantive TLA+ changes require an independent model-family or human review.

### FR-10: Failure-class fidelity

Tool, credential, provider, exhaustion, counterexample, and validation failures
must remain distinguishable in artifacts, exit handling, and review evidence.

### FR-11: Incremental model maintenance

Established models must be edited incrementally with reviewable diffs. Complete
regeneration requires an explicit replacement rationale and independent review.

### FR-12: Bounded rollout

The first adopted model must remain limited to lane and lock workflow behavior.
Broader models require separate scope decisions based on pilot evidence.

## Acceptance Criteria

- A reviewer can identify the authoritative prose, model, invariants, harness,
  bounds, and exact source commit for every formal verdict.
- A prose edit covered by a committed model cannot silently retain a stale pin.
- A TLA+ counterexample and a code-to-model validation mismatch both block the
  relevant change.
- Infrastructure or provider failure is never reported as a verification pass
  or a model counterexample.
- Model checking and validation run before peer handoff for high-risk semantic
  changes and again on the exact PR head in CI.
- Locks remain exclusive and follow the reconciled PR-flow retention contract in
  every explored pilot trace.
- Reviewer and owner routing follow the reconciled workflow contract in every
  explored pilot trace.
- A repeated repair for the same unresolved reason reaches the specified human
  escalation path within the approved repair bound.
- The complete Specula pipeline remains scheduled or explicit rather than an
  unconditional every-PR dependency.
- The first pilot produces enough timing, memory, state-space, and false-positive
  evidence to decide whether any formal check should become a hard general gate.

## Rollout

### Phase 0: Reconcile and bootstrap

- approve spec 014 (still Draft; this lane produces the reviewable draft)
- lock-release designated in spec 002 v1.1.2: PR-flow retains through merge/close; close-without-merge is terminal resolved (not repair-needed); terminal resolved releases; force-release is an audited override
- fix formal-skill references to point at their real owning specification (out of this lane lock; follow-up)
- modeling brief: `specs/014-specula-modeling-guidance.md`

### Phase 1: One model

- create one lane/lock TLA+ model and small deterministic configuration
- create the instrumentation mapping and focused validation harness
- run baseline TLC and trace validation locally
- obtain independent review of the model and invariants

### Phase 2: Advisory integration

- add formal-impact metadata to review packets
- add focused pre-review commands for affected models
- add exact-head CI in advisory mode
- record timing, memory, exhaustion, mismatch, and infrastructure-failure data

### Phase 3: Selective gate

- block stale pins, counterexamples, and validation mismatches for the pilot model
- adopt an explicit policy for exhaustion and unavailable tooling
- keep broad Specula assessment and confirmation scheduled or explicit

Expansion beyond the lane/lock pilot requires a new scope decision based on the
measured Phase 2 and Phase 3 evidence.
