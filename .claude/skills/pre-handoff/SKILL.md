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
4. **Audit gate** — run the hard-violation audit scoped to the lane's changed files:
   ```
   kkg audit --scope lane --require-hard-zero --format summary
   ```
   `--scope lane` uses the same file set as `--scope session` (all changes since last commit plus untracked files), which matches the btrain lane isolation boundary.
   - If `kkg` is not available or the project has no KuzuDB store, skip with a `--gap` noting the audit was not run.
   - If the command exits **2** (hard violations found), **stop**. Fix the hard violations before proceeding. Do not hand off with known hard violations.
   - If the command exits **0** (hard_zero confirmed), record `kkg audit --scope lane --require-hard-zero passed` as a `--verification` bullet.
   - If the command exits **1** (audit could not connect / other error), note it as a `--gap` and proceed — do not block on infra issues, but flag them for the reviewer.
5. **Context check (Unblocked)** — surface prior PRs, open issues, and prior decisions that touch this lane so the reviewer doesn't have to dig. Use the shared helper, which always emits a JSON object (even when the CLI is missing or unauthed):
   ```
   .claude/scripts/unblocked-context.sh research \
     "<lane task title> <one or two locked file paths>" \
     --effort low --limit 5
   ```
   - For each relevant prior PR or open issue in the result, add a `--review-ask` like `Confirm this doesn't conflict with <title> (<url>)`.
   - If a source surfaces design rationale or a rejected alternative, fold it into `--why` and cite the URL.
   - If the JSON contains a `_skipped` field (CLI missing / unauthed / errored), record one `--gap` noting `Unblocked context check skipped: <reason>` and proceed. Do not block the handoff on it.
   - For deeper synthesis on novel or risky changes, escalate to `--effort medium`. Skip on routine work — `low` is the default budget.
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
10. Prefer repeatable `btrain` flags over one large prose blob:
    - one `--changed` per file or logical file group
    - one `--verification` per command
    - one `--gap` per remaining risk
    - one `--review-ask` per concrete reviewer check
11. Only then run `btrain handoff update --status needs-review`.

## Constraints

- Do not read or edit `HANDOFF_*.md` files directly.
- Do not move a lane to review with placeholder text.
- Do not move a lane to review with an empty or no-op diff.
- Do not move a lane to review when `kkg audit --scope lane --require-hard-zero` exits 2 (hard violations present). Fix the violations first.
- Do not omit `Base` or `Specific review asks`.
- Do not hand off superseded work. Resolve it stale and claim a real slice instead.
- Do not silently skip the simplification pass on a multi-file code change.
- Do not collapse the whole reviewer context into a single paragraph when repeatable `btrain` flags would make the review sharper.

## Default Output

- Base
- Pre-flight review
- Audit gate result (hard_zero pass / fail / skipped)
- Context check (Unblocked sources cited, or skip reason)
- Changed files
- Verification run
- Remaining gaps
- Why this was done
- Specific review asks

## Persistent Note

If the failure pattern keeps recurring, update the repo's durable process or contributor notes.
