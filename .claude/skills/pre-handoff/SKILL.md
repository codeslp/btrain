---
name: pre-handoff
description: Run a CLI-only quality gate immediately before any `btrain handoff update --status needs-review`. Use it whenever a lane is about to move to review, especially after docs-only work, multi-file changes, or rushed fixes, to catch placeholder reviewer context, empty diffs, skipped verification, and missing simplification passes.
---

# Pre-Handoff

Use this skill immediately before `btrain handoff update --status needs-review`.

## Goal

Block bad review handoffs before they reach the reviewer.

## Workflow

1. Run `btrain handoff` and confirm the lane is yours, still `in-progress`, and the locked files match the work you actually did.
2. If needed, run `btrain locks` or `btrain status` to confirm lane and lock state. Do not read `HANDOFF_*.md` directly.
3. Check the locked-file diff with `git diff -- <locked files>`. If the diff is empty, whitespace-only, or superseded by a priority change, do not hand it off. Mark it stale or keep working.
4. **Context check (Unblocked)** — surface prior PRs, open issues, and prior decisions that touch this lane so the reviewer doesn't have to dig. Use the shared helper, which always emits a JSON object (even when the CLI is missing or unauthed):
   ```
   .claude/scripts/unblocked-context.sh research \
     "<lane task title> <one or two locked file paths>" \
     --effort low --limit 5
   ```
   - For each relevant prior PR or open issue in the result, add a `--review-ask` like `Confirm this doesn't conflict with <title> (<url>)`.
   - If a source surfaces design rationale or a rejected alternative, fold it into `--why` and cite the URL.
   - If the JSON contains a `_skipped` field (CLI missing / unauthed / errored), record one `--gap` noting `Unblocked context check skipped: <reason>` and proceed. Do not block the handoff on it.
   - For deeper synthesis on novel or risky changes, escalate to `--effort medium`. Skip on routine work — `low` is the default budget.
5. **Code-review gate** — run `btrain review code` against the lane diff:
   ```
   btrain review code --base main
   ```
   - Exit **2** (hard violations) is a **hard block**. Hard rules: `hardcoded-secret`, `cors-wildcard`. Fix the violation in the same lane, then re-run; do not flip to `needs-review` until the gate exits 0.
   - Exit **0** with `warn > 0` (e.g., `unprotected-route`, `env-var-required`, `new-dependency`) is informational. Record each warn as a `--gap` bullet in the handoff packet, or address inline before handoff if appropriate.
   - Exit **0** with `0 hard, 0 warn` — record `btrain review code passed` as a `--verification` bullet.
   - If the subcommand is unavailable (older btrain install), note it as a `--gap` (`btrain review code not available — install latest`) and proceed; do not block on tooling drift.
   - For legitimate exceptions (test fixtures, intentional config), suppress on the violating line with `// btrain-allow: <rule-id>` (or `# btrain-allow: ...` for shells/Python). Document any allow-marker addition in the handoff packet so the reviewer can audit it.
6. Scan the handoff context you are about to submit. Block the handoff if it still contains placeholders like:
   - `Fill this in before handoff`
   - `None yet`
   - empty changed-files, verification, gaps, or review-ask sections
7. Confirm the full `btrain` reviewer-context set is present:
   - `--base` or an explicit `Base`
   - `--preflight`
   - one or more `--changed` bullets
   - one or more `--verification` bullets
   - `--why`
   - one or more `--review-ask` bullets
   - `--gap` bullets for anything still unverified, or an explicit statement that no known gaps remain
8. If the change spans multiple files, confirm you ran the repo's `code-simplifier` skill on the modified scope when available. Treat a missing simplification pass as a warning to fix before handoff, not a hard block.
9. Confirm at least one real verification command was run and record what remains unverified.
10. If this repo has `[cgraph]` enabled, run `btrain status` once before handoff and account for any fresh cgraph tips. Capture unresolved cgraph warnings in `--gap` or turn them into explicit `--review-ask` items.
11. Prefer repeatable `btrain` flags over one large prose blob:
    - one `--changed` per file or logical file group
    - one `--verification` per command
    - one `--gap` per remaining risk
    - one `--review-ask` per concrete reviewer check
12. Only then run `btrain handoff update --status needs-review`.

## Constraints

- Do not read or edit `HANDOFF_*.md` files directly.
- Do not move a lane to review with placeholder text.
- Do not move a lane to review with an empty or no-op diff.
- Do not move a lane to review when `btrain review code` reports hard violations (`hardcoded-secret`, `cors-wildcard`). Fix the violation in the same lane or add a documented `// btrain-allow: <rule-id>` marker first.
- Do not omit `Base` or `Specific review asks`.
- Do not hand off superseded work. Resolve it stale and claim a real slice instead.
- Do not silently skip the simplification pass on a multi-file code change.
- Do not collapse the whole reviewer context into a single paragraph when repeatable `btrain` flags would make the review sharper.

## Default Output

- Base
- Pre-flight review
- Context check (Unblocked sources cited, or skip reason)
- Code-review gate result (hard / warn / skipped)
- Changed files
- Verification run
- Remaining gaps
- Why this was done
- Specific review asks

## Persistent Note

If the failure pattern keeps recurring, update the repo's durable process or contributor notes.
