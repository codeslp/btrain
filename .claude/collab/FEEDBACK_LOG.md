# Feedback Log

User-reported feedback. Single source of truth for triage and resolution.

| Status | Meaning |
|--------|---------|
| new | Logged, awaiting user confirmation of triage |
| triaged | User confirmed category, ready for test/fix |
| test-written | Reproduction test exists and fails |
| fixed | Code fix applied, test passes |
| verified | Full test suite passes, no regressions |
| blocked-spec | Requires spec change via speckit before work begins |

---

## FB-BUG-001: Left-rail lane cards do not render
- **Reported:** 2026-04-15
- **Raw feedback:** "Also my lane cards are STILL not showing up in the left rail like they are supposed to"
- **Category:** BUG
- **Complexity:** low (1-2 files)
- **Repro test:** `test/agentchattr-lanes-panel.test.mjs`
- **Fix:** `agentchattr/static/chat.js` — pending commit
- **Status:** fixed
- **Notes:** Confirmed as a front-end bug. `agentchattr/static/chat.js` handled `btrain_lanes` events and updated `btrainLanes`, but the left-rail renderer was not invoked from that path. The repro test also exposed that `renderLanesPanel()` referenced `_esc` and `_truncate`, which were not defined in the shipped script, so the renderer would fail once called. Verification: `node --test test/agentchattr-lanes-panel.test.mjs` and `node --test test/core.test.mjs test/agentchattr-lanes-panel.test.mjs` pass. A broader `npm test` run still hits an unrelated installed-CLI E2E sandbox failure (`listen EPERM 127.0.0.1`).

## FB-BUG-002: Pre-commit needs-review gate blocks disjoint lane commits
- **Reported:** 2026-05-06
- **Raw feedback:** "btrain pre-commit hook over-scopes \"needs-review\" lock — blocks unrelated lane commits"
- **Category:** BUG
- **Complexity:** low (1-2 files)
- **Repro test:** temporary hook repro harness; permanent `test/core.test.mjs` coverage blocked by active lane A `test/` lock
- **Fix:** `src/brain_train/core.mjs` — pending commit
- **Status:** fixed
- **Notes:** The generated pre-commit hook in `src/brain_train/core.mjs` treated any `HANDOFF_*.md` with `Status: needs-review` as a whole-repo reviewer-only gate. The temporary repro created a git repo with lane A in `needs-review` for `lane-a/**`, staged only `lane-c/work.txt`, and confirmed the old hook blocked the commit. The fix scopes blocking to staged paths that match the needs-review lane's `Locked Files:` entries, while still allowing the peer reviewer identified by `BTRAIN_AGENT` or `BRAIN_TRAIN_AGENT`. Verification after the fix: disjoint `lane-c/work.txt` commit passes, matching `lane-a/work.txt` non-reviewer commit blocks, matching `lane-a/review.txt` peer-reviewer commit passes, `node --check src/brain_train/core.mjs` passes, and `node --test --test-name-pattern installPreCommitHook test/core.test.mjs` passes. Dedup check found no matching tracked issue; related message search returned 0 reports.
