# 021 — Jev decision plane tasks

The numbered workstreams in the [implementation plan](021-jev-decision-plane-implementation-plan.md) are independent release gates. Completing a code task does not promote a family. Data policy, labels, shadow runs, and a human promotion record remain separate prerequisites.

## Phase 1: Offline foundation (WS0–2)

- [x] T001 [US1] Record prospective PR source snapshots and pending outcomes in `src/brain_train/handoff/pr-comments.mjs` and `src/brain_train/jev/evidence.mjs`; mark polling-time heads separately from event-time heads.
- [x] T002 [US1] Test deduplication, reviewed commits, unknown historical heads, and append-only outcomes in `test/jev/evidence.test.mjs` and `test/handoff-pr-comments.test.mjs`.
- [x] T003 [US1] Validate two independent labels, adjudication, PR/template group isolation, and frozen source hashes in `src/brain_train/jev/manifest.mjs` and `test/jev/manifest.test.mjs`.
- [x] T004 [US3] Build off-by-default typed offline decision gateway, closed family policies, fake provider, and redacted traces in `src/brain_train/jev/decision.mjs` and `test/jev/decision.test.mjs`.
- [x] T005 [US4] Implement deterministic replay with separate skip, abstain, failure, class, coverage, latency, and cost metrics in `src/brain_train/jev/replay.mjs` and `test/jev/replay.test.mjs`.
- [x] T006 Document how to capture, label, freeze, and replay without a hosted call in `experiments/jev-btrain/README.md`.

**Independent check:** Frozen synthetic cases reproduce identical metrics; malformed or ineligible model output never changes a workflow state; historical heads remain unknown.

## Phase 2: Measured PR and handoff seams (WS3–4)

- [x] T007 [US3] Reconcile current-head PR candidate selection with source snapshots for offline replay in `src/brain_train/pr-flow.mjs` and its tests; preserve the existing semantic decision trace and live authority behavior.
- [ ] T008 [US1] Assemble at least 200 independently labeled provenance-complete PR cases and freeze train/calibration/test groups in `experiments/jev-btrain/`.
- [ ] T009 [US2] Add a bounded, nonblocking handoff evidence warning after hard preflight checks in `src/brain_train/core.mjs` with composition tests.
- [ ] T010 [US4] Freeze the G4 handoff benchmark and compare warning quality and reviewer time in `experiments/jev-btrain/`.

**Independent check:** PR gates are unchanged on provider failure; owner and reviewer may inspect handoff warnings; no warning approves or rejects a handoff.

## Phase 3: Additive families (WS5–8)

- [ ] T011 [US5] Implement catalog-only verification suggestions and G5 controls in `src/brain_train/jev/` and `test/jev/`.
  - [x] Offline catalog prototype and synthetic authority controls in `verification.mjs` and its tests.
  - [ ] Freeze 100 independently labeled real changes, including at least 30 missing-check cases, and evaluate the G5 thresholds before any live use.
- [ ] T012 [US5] Implement independent G6-R, G6-T, and G6-V policies and frozen evaluations in `src/brain_train/jev/` and `experiments/jev-btrain/`.
  - [x] Separate offline diff-rule, turn-rule, and review-risk policies, citation/mandatory-review controls, frozen-record binding, and independent paired accounting in `rules.mjs`, `review-risk.mjs`, and `experiments/jev-btrain/rules-risk.mjs`.
  - [ ] Freeze each independent real G6 dataset (100 diff cases, 100 turn cases, and 100 review cases) and evaluate its own gate before live use.
- [ ] T013 [US5] Implement pinned-item context selection and separate transcript selection evaluations in `src/brain_train/jev/` and `experiments/jev-btrain/`.
- [ ] T014 [US5] Implement eligibility-first routing and source-linked memory warnings in `src/brain_train/jev/` and `test/jev/`.
  - [x] Offline routing and memory prototypes, frozen-record binding, synthetic authority controls, and separate paired accounting in `routing.mjs`, `memory.mjs`, and `experiments/jev-btrain/routing-memory.mjs`.
  - [ ] Freeze 100 independently labeled routing decisions and 100 versioned memory claims (at least 30 superseded), and evaluate G8 before any live use.

**Independent check:** Suggestions only add permitted actions. Every family passes its own frozen gate before benchmark-backed broad advisory or assist; T019 records the user-authorized live PR exception.

## Phase 4: Optional expansions and promotion (WS9–11)

- [ ] T015 [US5] Add supervisor signals only after durable cursor, acknowledgement, retry, and restart recovery exist in the owning supervisor implementation.
- [ ] T016 [US5] Add authorized local history prefilter and read-only typed rerank in `src/brain_train/jev/` and `test/jev/`.
  - [x] Offline principal/source ACL and lexical prefilter, typed relevance rerank, redacted traces and paired query accounting in `history.mjs`, its tests, and `experiments/jev-btrain/history-search.mjs`.
  - [ ] Freeze 50 independently judged real queries with source-access roles and evaluate G10; a live reader must enforce authoritative access before exposing any search results.
- [ ] T017 [US4] Compare pinned Jev and eligible alternative backends on the same frozen family suites in `experiments/jev-btrain/`.
- [ ] T018 [US4] Record privacy approval, preregistered shadow run, live benefit and harm, human sign-off, and rollback for each promoted family in a versioned promotion record.

**Independent check:** The same family policy, model, code revision, and repository pass offline and shadow gates; an operator can disable one family immediately.

## Dependencies

T001–T006 precede T007–T010. T011–T014 depend on T004–T005 and each family’s data gate. T015 depends on the durable supervisor. T018 depends on the relevant family’s frozen benchmark and completed shadow run. Synthetic controls never count toward real-case quotas.

## Operator-directed runtime activation (2026-10-01)

- [x] T019 Enable the existing live PR interpreter in default feedback-only assist, load private
  per-user credentials with environment precedence, verify the actual CLI/provider path and
  deterministic fallback, record the user directive, and install the locally reviewed runtime.

This task supersedes the prior off-by-default PR requirement. It does not mark real-data,
shadow, or other family integration tasks complete.

Activation verification: two independent local reviewers passed; the serial suite passed
1,008 tests with 15 skips and no failures. The installed `btrain` resolves to the runtime
worktree and ordinary `btrain pr status` reports `assist` enabled without mode/key
environment variables. A real hosted synthetic PR classification used `jev-1.13.0`,
returned feedback, and applied the permitted feedback signal in 294 ms. This smoke is
connectivity/composition evidence, not a completed quality benchmark or shadow window.
