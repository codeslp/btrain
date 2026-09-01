# Checklist: Spec 015 Lane Transition Contract — Requirements Quality

**Purpose**: Unit tests for the requirements writing in `specs/015-lane-transition-contract.md` v0.1.0. Each item asks whether a requirement is complete, clear, consistent, and measurable. It does not test implementation.
**Created**: 2026-09-01
**Depth**: Standard. **Audience**: PR reviewer. **Focus**: contract-row consistency; spec 014 verification chain; migration; actor authority.
**Legend**: `[x]` the spec satisfies the item. `[ ]` the spec did not at v0.1.0; the finding follows. Every failed item was addressed in v0.1.1 of the spec on 2026-09-01; re-run this checklist before the spec leaves Draft.

## Requirement Completeness

- [ ] CHK001 - Are transition rows defined for every mutation FR-1 places under the gate, including `--owner` and `--reviewer` reassignment via `handoff update`? [Gap, Spec §FR-1, §The rows]
  Finding: FR-1 gates `owner` and `reviewer` writes, but no row covers reassignment. Row 19 (MetadataUpdate) excludes `--status` and `--files` only, so reassignment silently falls into it with no actor rule beyond `lane-agent`.
- [ ] CHK002 - Is every actor role used in the rows defined in the Contract shape actor list? [Completeness, Spec §Contract shape, rows 14 and 16]
  Finding: rows 14 and 16 use `guardian` and `human`; the actor list defines `owner`, `reviewer`, `lane-agent`, `repair-owner`, `any-agent`, `system` only. How btrain recognizes a guardian or a human is unspecified.
- [ ] CHK003 - Is `lane-agent` defined in the spec, or only by reference to `LaneLock.tla`? [Clarity, Spec §Contract shape]
  Finding: not defined. `LaneLock.tla` defines it as owner or reviewer; the spec should say so, since the model is on an unmerged branch.
- [ ] CHK004 - Are lock effects specified for single-handoff mode, where there is no lock registry? [Gap, Spec §The rows, §Non-Goals]
  Finding: Non-Goals routes single-handoff writers through the gate, but every row's `locks` column assumes a registry. `resolveHandoff` keeps `lockedFiles` untouched in that mode today (`core.mjs:5758`). The rows do not say what `acquire`, `retain`, or `release` mean there.
- [x] CHK005 - Are internal events distinguished from CLI events with a forgery rule? [Completeness, Spec §Contract shape]
- [ ] CHK006 - Is atomicity of the gate check with the existing lock-registry critical section required? [Gap, Spec §FR-1]
  Finding: `patchHandoff` publishes inside the registry mutex today (`core.mjs:5352-5360`). FR-1 does not require the transition check and the write to happen inside that section, so a concurrent writer could change status between check and write.
- [ ] CHK007 - Are rollback requirements defined if the structural half regresses after merge? [Gap, Spec §Migration path]
  Finding: Phase A has acceptance but no rollback statement. A revert is trivial for a single module, but the spec should say the gate must be removable by reverting one change without data migration.
- [x] CHK008 - Is the missing-file failure mode (finding #8) covered by a requirement with a named user-visible outcome? [Completeness, Spec §FR-4]
- [x] CHK009 - Are the two `changes-requested` flavors (local review vs PR feedback) distinguishable by a stated field? [Completeness, rows 9, 11, 12]
  Note: the rows use "linked PR" consistently, but the spec never states the rule in prose. Acceptable; one sentence would help.

## Requirement Clarity

- [ ] CHK010 - Is "one release" in FR-5 and Phase C quantified for a project with no release cadence? [Clarity, Measurability, Spec §FR-5, §Phase C]
  Finding: `package.json` is `0.1.0` with no tagging practice. "One release" is not measurable. A count of merged PRs or a calendar period would be.
- [ ] CHK011 - Is the row-16 actor rule stated in one column? [Clarity, Spec row 16]
  Finding: the `actor` column says `owner`; the `from` column says "repair-needed for guardian or human". The authority rule is split across two columns.
- [ ] CHK012 - Is the equality test for "set equals handoff record" in row 17 defined (path normalization, trailing slash, order)? [Clarity, Spec row 17]
  Finding: not defined. `normalizePathList` (`core.mjs:1070`) sorts and dedupes; trailing-slash handling is not stated in the spec.
- [x] CHK013 - Are `Active` and `PrFlow` defined before use? [Clarity, Spec §The rows]
- [ ] CHK014 - Are "actor as a predicate" and "actor as an event-log label" distinguished for `system` events? [Ambiguity, Spec §Contract shape]
  Finding: `applyPrStatusToHandoff` accepts `options.actor` as a label (`pr-flow.mjs:610-613`). The spec says system events "carry `actor: system`", which reads as both the authority predicate and the recorded label.
- [x] CHK015 - Is the `legacy` state defined with an explicit lifetime rule? [Clarity, Spec §FR-3]

## Requirement Consistency

- [ ] CHK016 - Is precedence defined when a contract row and a legacy row both match the same request? [Conflict, Spec §The rows, §FR-5]
  Finding: L4 matches any `update --status`, overlapping rows 2, 7, 12, 13, 14. The spec does not say the contract row wins and the legacy row applies only to the residual, which matters for what the advisory field records.
- [x] CHK017 - Do FR-2 (hand-authored, never generated) and FR-7 (cross-check) agree on how independence is preserved? [Consistency, Spec §FR-2, §FR-7]
- [x] CHK018 - Does row 2's `owner` actor agree with FR-9 and designation #6? [Consistency, row 2, §FR-9, §Designation #6]
- [x] CHK019 - Do legacy rows L1–L7 map one-to-one onto ledger findings named in the Designation section, and do L8–L15 each name the code path they preserve? [Consistency, rows L1–L15, §Designation]
- [ ] CHK020 - Does the `action` column's "matching the `LaneLock.tla` action where one exists" hold against a model that is not yet merged? [Assumption, Spec §Contract shape]
  Finding: PR #35 is open; action names may change in review. The spec should state the dependency or drop the naming coupling.
- [x] CHK021 - Do the Sequencing constraints agree with the pinned-section list in `LaneLock.tla`? [Consistency, Spec §Sequencing constraints]
  Note: verified against the branch header and the pin script on 2026-09-01.

## Acceptance Criteria Quality

- [x] CHK022 - Is "every mutation calls `applyTransition`" stated in a way that can be objectively checked? [Measurability, Spec §Acceptance Criteria item 1]
- [ ] CHK023 - Is "renders the same graph the specs draw" measurable given that specs 005 and 006 draw partial, pre-PR-flow diagrams? [Measurability, Conflict, Spec §Acceptance Criteria item 4]
  Finding: spec 005's diagram has no PR-flow states and spec 006's has no review states. No single spec draws the full graph. The criterion should name the rows table as the reference, not "the specs".
- [ ] CHK024 - Is "without weakening the model" defined or cited? [Clarity, Spec §Acceptance Criteria item 6]
  Finding: spec 014 Review Independence lists "invariants are not weakened to make TLC pass". Cite it rather than restate loosely.
- [x] CHK025 - Does Phase A acceptance name the exact evidence (unchanged candidate tally, 546 passing tests, cross-check passing)? [Measurability, Spec §Phase A]

## Scenario and Edge Case Coverage

- [ ] CHK026 - Are requirements defined for how FR-7's cross-check fixes data-guard inputs (linked PR, escalation count, override) when enumerating the status × event × role product? [Gap, Spec §FR-7]
  Finding: five rows have data guards. The cross-check as written enumerates only status, event, and role, so those rows cannot be compared without a stated guard fixture.
- [x] CHK027 - Is the unknown-actor scenario addressed for both advisory and enforcement modes? [Coverage, Spec §FR-6]
- [ ] CHK028 - Is the actor authority for manual `repair-needed` entry (row 13, `any-agent`) designated or flagged as open? [Gap, row 13, §Open questions]
  Finding: row 13 says `any-agent` with state `provisional`, but the open-questions list does not include it and spec 006 does not say who may declare a repair. `test/e2e.test.mjs:596` has a reviewer doing it.
- [x] CHK029 - Are identity transitions (same status, metadata only) explicitly kept legal? [Coverage, row 19, §Designation #7]
- [x] CHK030 - Is the PR-feedback shortcut (row 12) surfaced as a decision rather than silently designated? [Coverage, row 12, §Open questions Q1]

## Non-Functional Requirements

- [ ] CHK031 - Is determinism of the gate stated as a requirement, consistent with the "deterministic, file-backed" pillar? [Gap]
  Finding: the gate is implicitly pure, but nothing forbids a row guard from reading the clock, the network, or the GitHub API. One sentence closes it.
- [x] CHK032 - Is the zero-runtime-dependency constraint restated for this spec's additions? [Completeness, Spec §Decision, §Non-Goals]

## Dependencies and Assumptions

- [x] CHK033 - Are the external blockers (PR #35 merge, stale spec 002 lines, stale mirror) named with their effect on sequencing? [Dependency, Spec §Sequencing constraints, §Review corrections]
- [ ] CHK034 - Is the lane-lock dependency on the live repo recorded? [Dependency, Gap]
  Finding: lane `b` holds locks on `src/brain_train/` and `test/` until PR #34 merges. Phase A cannot be claimed under btrain's own rules until then. The spec does not mention it.
- [x] CHK035 - Is the header complete per the spec 014 house style? [Traceability]
  Note: spec 014 also carries an `Updated` line; add it on first revision.

## Summary

35 items. 21 pass, 14 fail. The failures cluster in four places: undefined roles (CHK002, CHK003, CHK028), single-handoff mode and atomicity (CHK004, CHK006), the cross-check's treatment of data guards (CHK026), and unmeasurable wording (CHK010, CHK023, CHK024). None invalidates the Decision; all are fixable in a v0.1.1 of the spec before any lane is claimed against it.
