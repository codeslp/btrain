# Spec 021 — Requirements and Plan Checklist

**Spec:** [021 Jev Decision Plane](../021-jev-decision-plane.md)
**Plan:** [021 Implementation Plan](../021-jev-decision-plane-implementation-plan.md)
**Created:** 2026-09-24
**Purpose:** Check the proposed contract before creating implementation tasks. These are spec
quality checks, not claims that the runtime work is complete.

## Spec quality

- [x] The problem, users, scope, and ten decision families are named.
- [x] Pilot observations are separate from corpus-readiness findings and unmeasured hypotheses.
- [x] Each functional requirement is testable and has a corresponding plan gate.
- [x] Success criteria distinguish evidence readiness, model quality, safety, and operations.
- [x] Existing workflow specs retain ownership of transitions, locks, reviews, and formal checks.
- [x] Privacy, hosted-data approval, trace access, and retention decisions are visible.
- [x] No unresolved clarification is presented as permission to send private text or enable assist.
- [x] The plan identifies an initial artifact and dependency for every decision family.
- [x] The plan distinguishes data collection, offline, shadow, advisory, and assist effects.
- [x] The existing client and PR seam are reused rather than specified as new completed work.

## Requirement-to-plan coverage

| Requirement | Plan coverage | Review question |
| --- | --- | --- |
| FR-1 deterministic authority | Architecture, WS0, quality/formal gates | Can fake model output cross any state or approval gate? |
| FR-2 source evidence and labels | Data model, WS1 | Are backfilled heads marked unknown and split groups preserved? |
| FR-3 reproducible evaluation | WS2–3, evaluation matrix | Are failures excluded from prediction metrics and separately counted? |
| FR-4 bounded decisions | Decision contract, WS0–2 | Does every family have schema, budget, action list, and abstention? |
| FR-5 traceability and privacy | Data model, WS2, quality gates | Can an outcome be audited without leaking private text? |
| FR-6 PR signals | WS3 | Can semantic clear ever satisfy a required review? |
| FR-7 handoff and rule findings | WS4 and WS6 | Is every warning tied to supplied evidence and human review? |
| FR-8 additive guidance | WS5 and WS8 | Can a score remove a required check or rank an ineligible actor? |
| FR-9 context, memory, supervisor, search | WS7–10 | Are pinned context and canonical state protected? |
| FR-10 promotion and rollback | Evaluation matrix, provider comparison | Is approval scoped to family, model, repository, and action? |

## Implementation gates still open

- [ ] Data-policy owner approves or rejects hosted use of private PR and handoff text.
- [ ] Trace retention and access policy is decided before live collection.
- [ ] WS1 yields event-time PR heads and an explicit unknown path for backfills.
- [ ] Two independent labelers and adjudication produce the frozen PR corpus.
- [ ] The 200-case PR gate and family-specific offline gates pass before live shadow or assist.
- [ ] Each assist action receives a human-signed promotion record and a tested rollback.

These unchecked items are intentional implementation gates. They do not block review of the
specification or planning documents.
