# Feedback Log Template

Use this to create `.claude/collab/FEEDBACK_LOG.md` if it doesn't exist:

```markdown
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

```
