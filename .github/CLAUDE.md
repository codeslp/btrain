# btrain Review Priorities

This file guides Claude Code GitHub Actions when reviewing btrain PRs.

## What btrain is

btrain is a multi-agent collaboration workflow tool. It coordinates handoffs
between AI coding agents (Claude, Codex, Gemini) using lane-based state
machines with file locking, structured reviewer context, and deterministic
code-review gates.

## Review priorities (ordered)

1. **State-transition correctness** -- btrain enforces a strict lane state
   machine. Invalid transitions (e.g., jumping from `in-progress` to
   `resolved` without review) are hard failures.

2. **Locked-file integrity** -- each lane locks specific files. Changes
   outside locked files are scope violations. `.btrain/locks.json` must
   stay consistent with `HANDOFF_*.md` lane state.

3. **Reviewer-context completeness** -- every `needs-review` handoff must
   include: Base, Pre-flight review, Files changed, Verification run,
   Remaining gaps, Why this was done, and Specific review asks. Placeholders
   or empty fields are failures.

4. **No hardcoded secrets** -- API keys, tokens, passwords, or credentials
   must never appear in source. Use environment variables.

5. **Test coverage** -- new features should have tests. The test runner is
   `node --test test/<file>.test.mjs`. All tests must pass.

6. **Zero external dependencies** -- btrain's CLI is zero-dep Node.js.
   Do not add npm dependencies to the core CLI. Test-only or
   tooling-only deps are acceptable.

## What NOT to flag

- Handoff markdown formatting (HANDOFF_*.md) -- these are machine-managed
- Lock file timestamps -- these are auto-generated
- Research docs (research/*.md) -- these are prose, not code
- agentchattr/ changes -- separate project, different conventions
