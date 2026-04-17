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
