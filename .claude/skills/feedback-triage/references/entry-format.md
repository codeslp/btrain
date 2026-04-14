# Feedback Log Entry Format

Use this exact format when appending to `.claude/collab/FEEDBACK_LOG.md`:

```markdown
## FB-<CAT>-<NNN>: <short title>
- **Reported:** <YYYY-MM-DD>
- **Raw feedback:** <verbatim or lightly cleaned user feedback>
- **Category:** MINOR | BUG | SPEC
- **Complexity:** low (1-2 files) | medium (3-5 files) | high (6+ files)
- **Repro test:** pending
- **Fix:** pending
- **Status:** new | triaged | test-written | fixed | verified | blocked-spec
- **Notes:** <reasoning about category/complexity, relevant code paths>
```

## Field Rules

- **ID**: `FB-<CAT>-<NNN>` where CAT is MINOR/BUG/SPEC and NNN is globally sequential (not per-category)
- **Sequential number**: Read the last entry in the log to determine the next number. Start at 001.
- **Raw feedback**: Preserve the user's words. Light cleanup for readability is fine, but don't reinterpret.
- **Repro test**: Set to test file path once written (e.g., `e2e/fb-bug-003-nav-crash.spec.ts`)
- **Fix**: Set to changed file paths + commit hash, branch reference, or "pending commit" once fixed (e.g., `src/views/ChatView.tsx, src/routes/api.ts — commit a1b2c3d` or `src/views/ChatView.tsx — branch feat/fix-nav`)
- **Status transitions**: new → triaged → test-written → fixed → verified (or new → triaged → blocked-spec for SPEC items)
- **Reclassification**: If category changes after triage, update the CAT tag in the ID but keep the same NNN
