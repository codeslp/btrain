# 021 — Jev Decision Plane for btrain

**Status:** Draft
**Version:** 0.1.0
**Date:** 2026-09-24
**Owner:** btrain

## Decision

Add a versioned, optional semantic decision plane to btrain. It may classify, rank, or flag
bounded evidence for a human or for a deterministic policy. It does not become the workflow
authority. Each use case advances from data collection to offline evaluation, shadow observation,
and only then to a separately approved, reversible assist action. A use case can stop at any phase.
G4 and G6 may run a limited opt-in advisory label-gathering pilot before their quality benchmark
passes, subject to the privacy and safety prerequisites in FR-10.

This spec covers the btrain opportunities identified in
[`research/jev-typesafe-repo-assessment.md`](../research/jev-typesafe-repo-assessment.md).
Applications in ai_sales and mech_ai retain their own data, authorization, evaluation, and product
specs. A btrain result does not validate a model for those products.

## Evidence and current state

The [`Jev pilot`](../research/jev-btrain-experiment-results.md) measured 14 held-out PR signals:
Jev classified 14/14, the deterministic baseline 7/14, and Kev-0.6B 9/14. On nine held-out
handoff packets, Jev classified 8/9 and the baseline 6/9. Jev's handoff miss accepted a packet
whose verification omitted a required negative path. These are small, partly controlled datasets
with one labeler; the results show candidate usefulness, not production accuracy.

The subsequent [`corpus audit`](../experiments/jev-btrain/corpus-audit-2026-09-24.json) found
2,523 captured comment rows and 658 reviewer-bot issue/review text rows before head and
deterministic filters, but only 84 normalized message families. Historical PR-head snapshots and
independent labels are missing. The proposed 200-case PR evaluation and two-week live shadow were
deferred. No new model-accuracy claim follows from the 658-row upper bound.

`src/brain_train/system-one.mjs` already has a bounded System One client. `pr-flow.mjs` already has
off, shadow, and feedback-only assist modes. This spec extends and evaluates those seams; it does
not prescribe a second PR classifier or immediate activation.

## User scenarios

1. **Researcher builds a defensible corpus.** A researcher can identify the exact PR event,
   reviewed commit, head at the event, eventual outcome, and label provenance for each candidate.
   Backfilled or repeated bot templates cannot silently become independent examples.
2. **Owner prepares a handoff.** The owner sees an advisory warning when packet claims contradict
   the diff or supplied verification. The owner can inspect and correct it; the peer reviewer still
   decides whether the handoff passes.
3. **Reviewer handles ambiguous PR text.** For an eligible current-head bot signal unresolved by
   exact rules, a typed decision and uncertainty are visible alongside the deterministic result.
   A provider failure leaves the existing PR state unchanged.
4. **Operator tunes a workflow.** The operator can compare a candidate decision with the existing
   baseline and human outcomes, see coverage and failures separately, and disable one decision
   family without disabling btrain.
5. **Agent receives focused guidance.** Later, a decision may add a verification check, suggest an
   eligible skill or reviewer, flag a stale memory, or choose context to include. It cannot remove
   mandatory evidence or select an ineligible action.

## Scope and priority

| Family | Potential value | Current evidence | Earliest permitted use |
| --- | --- | --- | --- |
| PR review-signal interpretation | Catch actionable feedback missed by regex | Small positive pilot; corpus gate failed | Offline after provenance repair, then shadow |
| Handoff evidence lint | Expose vague, contradictory, or unsupported packets | Small positive pilot with one important miss | Advisory to owner and reviewer |
| Verification and risk planning | Add missing negative, integration, security, or formal checks | Hypothesis | Advisory suggestions |
| Repository-rule and end-of-turn checks | Flag semantic rule violations in focused diffs and bounded turn evidence | Hypothesis | Advisory findings with rule citation |
| Context curation and transcript compaction selection | Reduce repeated context cost while preserving essentials | Token-cost problem measured; Jev benefit unmeasured | Shadow selection, then reversible omission |
| Review-risk triage | Focus deeper review on likely risk | Hypothesis | Advisory prioritization |
| Task, lane, reviewer, runner, and skill routing | Reduce misrouting and idle time | Hypothesis | Suggestion from an eligible catalog |
| Workflow memory invalidation | Detect summaries superseded by new events | Hypothesis | Advisory stale-memory warning |
| Supervisor observation | Detect stuck, off-track, or incomplete work | Hypothesis; highest intervention risk | Shadow signals only until supervisor exists |
| Semantic history search | Find relevant trace/event records | Hypothesis | Read-only ranking over prefiltered records |

Provider comparison is a cross-cutting experiment, not a reason to adopt a local backend.
Kev-0.6B failed the pilot and is excluded from assist use. A stronger local model must pass the
same frozen benchmark before consideration.

### Adjacent product opportunities

The same research identified separate pilots outside btrain. In ai_sales: rep-performance
scoring, retrieval reranking after authorization and eligibility filters, and versioned coaching
rubric checks. In mech_ai: evidence sufficiency, citation support or contradiction, unsafe or
instruction-like passages, ingest metadata, and query-class selection. Their existing product
golden sets, tenant boundaries, and authorization rules govern those pilots. This spec records
them for roadmap completeness; implementation requires product-owned specs and gates.

## Functional requirements

### FR-1 — Deterministic authority

btrain MUST keep identity, authorization, lane transitions, locks, exact PR head, review freshness,
formal review state, hard pre-handoff gates, test outcomes, deadlines, budgets, overrides, push,
merge, deployment, and destructive actions deterministic. A semantic answer cannot approve work,
release a lock, satisfy a required review, or suppress a mandatory check. Any future change to a
lane transition requires its owning workflow spec and Spec 014 formal-impact process first.

### FR-2 — Source evidence and labels

Prospective PR evidence MUST record source repository and PR, event URL/ID/surface, author, event
time, capture time, reviewed commit when available, contemporaneous PR head or an explicit
`unknown`, formal state, deterministic disposition, and eventual outcome. It MUST preserve the
distinction between an observed head and a head inferred later. The label set, annotators,
adjudication, and source-template group MUST be recorded with each frozen case. Raw private comment
text stays in its source repository unless a separate data-policy decision authorizes transfer.

### FR-3 — Reproducible evaluation

Every evaluation MUST pin the source snapshot, labels, train/calibration/test split, question
version, thresholds, model identifier, baseline, and code revision. Repeated templates and cases
from one PR MUST remain in exactly one of train, calibration, or test. Report per-class support,
confusion matrix, skipped candidates, valid-answer abstentions, valid-prediction coverage,
provider and response-shape failures, latency, and cost separately. Failures have no prediction
and cannot count as correct `uncertain` cases. Synthetic controls form a separate stratum.

### FR-4 — Bounded typed decisions

Each decision family MUST declare a closed question schema, bounded inputs, eligible action set,
privacy class, version, time and call budget, and deterministic fallback. An out-of-catalog or
malformed answer MUST be a `failure` with reason `invalid-answer` and no prediction. Only a
schema-valid answer that has no sufficiently strong permitted action may `abstain`. Scores and
probabilities are evidence for thresholding, not proof of correctness. Model text MUST NOT be
treated as an executable instruction. Deterministically ineligible or policy-denied candidates
MUST be `skipped` before a provider call, not counted as a model failure or abstention.

### FR-5 — Traceability and privacy

Each attempted decision MUST produce a local trace with family and question versions, source
references, input hash, provider/model identifier, outcome, probabilities when valid, latency,
failure class, baseline result, action actually taken, and later human outcome when known. No
credential or unrelated private text may enter a trace. A hosted call with private source content
requires an explicit data-policy approval and an enabled family-specific configuration.

### FR-6 — PR review signals

The PR family MUST receive only the latest eligible current-head text after deterministic bot,
surface, state, timestamp, and commit checks. It may label `clear`, `feedback`, `unavailable`, or
`uncertain`. `clear` is informational and never satisfies a review or merge gate. Any feedback
assist action MUST preserve the original source reference and remain reversible; timeout,
uncertainty, or conflicting evidence preserves the deterministic result.

### FR-7 — Handoff and rule findings

Handoff and rule families MUST ask focused questions over supplied task, packet, changed surface,
and verification evidence. End-of-turn checks MUST use bounded turn evidence and only applicable
versioned repository rules. They may flag a possible mismatch, missing coverage, or contradiction
for an owner or reviewer to inspect. A finding MUST identify its source rule or claim and the
supplied evidence slice; a model-generated assertion alone cannot become a blocking finding.
The linter cannot waive pre-handoff requirements or replace peer review.

### FR-8 — Additive guidance and eligible selection

Verification planning, review-risk triage, and routing may add checks or rank choices only after
deterministic eligibility filters. They cannot remove required tests, authorize an ineligible
reviewer, cross a lane lock, or widen a permission boundary. If no eligible option fits, they
skip the model call and show the existing deterministic path.

### FR-9 — Context, memory, supervisor, and search

Context curation MUST pin user instructions, task, constraints, locks, current state, unresolved
findings, and recent errors. A later transcript-compaction selector may choose which records stay
full, become references, or are candidates for summarization; Jev itself does not generate the
summary. Raw records remain recoverable. Omission or compaction requires a measured benefit and a
reversible fallback.
Memory invalidation MUST preserve source and version links. Supervisor decisions MUST emit signals
to a separate deterministic policy and cannot directly change lane state. Search MUST filter
authorized records locally before any semantic ranking and remain read-only.

### FR-10 — Per-family promotion and rollback

Each family starts off. G4 handoff lint and G6 rule checks may enter a bounded opt-in advisory
pilot before the quality benchmark passes, solely to collect labels and reviewer-time evidence.
That exception requires source-specific privacy clearance, hard-boundary tests, trace access and
retention policy, an explicit operator opt-in and cohort, and human review of every warning. It
cannot block a handoff, alter lane state, or authorize an assist action. All other live promotion
requires a frozen benchmark and family-specific gates in the implementation plan. A human records
the approved threshold and allowed assist action. The operator can return that family to off or
shadow immediately; on provider failure, btrain follows its current deterministic behavior.
Promotion is per family, pinned model, and repository, never inferred from another task or provider.

## Success criteria and gates

- **Evidence readiness:** each PR test case has complete provenance or is explicitly excluded;
  two independent labelers resolve disagreements; at least 200 distinct defensible PR cases with
  at least 30 per class are frozen before repeating the proposed PR comparison. This is a gate,
  not a claim that the current logs meet it.
- **PR offline gate:** at least 95% overall accuracy and feedback recall, zero false `clear` on
  feedback/unavailable/uncertain controls, 100% agreement with deterministic stale-head and
  identity exclusion, under 1% provider/response-shape failure, and stable results on a pinned
  model. Only then may a two-week live shadow begin.
- **New families:** before assist, each family has a preregistered dataset, baseline, negative
  controls, minimum class support, harmful-error definition, threshold, and measured improvement
  on an untouched test split. Only G4/G6 may run the earlier opt-in, nonblocking advisory pilot
  defined in FR-10.
- **Safety:** injected timeout, malformed response, and provider outage never advance a lane,
  approve a PR, omit mandatory evidence, or select an ineligible option.
- **Operations:** an operator can inspect one trace and its source references, distinguish model
  error from a wrong prediction, and disable one family without changing other families.

## Non-goals

- A general autonomous agent or model-controlled workflow engine.
- Replacing human peer review, GitHub reviews, formal verification, or deterministic rules.
- Generating code, prose, or explanations with a typed classifier.
- A full repository semantic scan on every turn or a network call on ordinary state reads.
- Shipping every opportunity in this table as one release.
- Moving ai_sales or mech_ai private data into btrain to enlarge an evaluation corpus.

## Dependencies and assumptions

- Spec 002 owns PR-flow lane semantics; Specs 005, 006, and 015 own review return, repair, and
  transition contracts; Spec 014 owns formal-impact checks. This spec adds no transition.
- Spec 020 measures context cost, but does not establish that Jev curation will reduce it.
- The current System One client and PR semantic seam are starting points, not proof of readiness.
- A contemporaneous head may be unavailable for historical comments; such cases are excluded
  from exact-head evaluation rather than relabeled by guesswork.
- A family with insufficient labeled data remains in research or advisory mode.

## Open decisions before implementation

1. Approve a data policy for hosted requests containing private PR or handoff text. Until then,
   use synthetic, public, or local-only evidence.
2. Name the human owner who signs each family-specific promotion and rollback threshold.
3. Choose a retention period and access policy for source text and trace records before live
   shadow collection.

These decisions do not block this plan or local, non-provider evidence capture. They block the
dependent hosted or live phases.
