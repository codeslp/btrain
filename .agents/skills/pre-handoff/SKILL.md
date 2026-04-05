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
4. Scan the handoff context you are about to submit. Block the handoff if it still contains placeholders like:
   - `Fill this in before handoff`
   - `None yet`
   - empty changed-files, verification, gaps, or review-ask sections
5. Confirm the full `btrain` reviewer-context set is present:
   - `--base` or an explicit `Base`
   - `--preflight`
   - one or more `--changed` bullets
   - one or more `--verification` bullets
   - `--why`
   - one or more `--review-ask` bullets
   - `--gap` bullets for anything still unverified, or an explicit statement that no known gaps remain
6. If the change spans multiple files, confirm you ran the repo's `code-simplifier` skill on the modified scope when available. Treat a missing simplification pass as a warning to fix before handoff, not a hard block.
7. Confirm at least one real verification command was run and record what remains unverified.
8. Prefer repeatable `btrain` flags over one large prose blob:
   - one `--changed` per file or logical file group
   - one `--verification` per command
   - one `--gap` per remaining risk
   - one `--review-ask` per concrete reviewer check
9. Only then run `btrain handoff update --status needs-review`.

## Constraints

- Do not read or edit `HANDOFF_*.md` files directly.
- Do not move a lane to review with placeholder text.
- Do not move a lane to review with an empty or no-op diff.
- Do not omit `Base` or `Specific review asks`.
- Do not hand off superseded work. Resolve it stale and claim a real slice instead.
- Do not silently skip the simplification pass on a multi-file code change.
- Do not collapse the whole reviewer context into a single paragraph when repeatable `btrain` flags would make the review sharper.

## Default Output

- Base
- Pre-flight review
- Changed files
- Verification run
- Remaining gaps
- Why this was done
- Specific review asks

## Persistent Note

If the failure pattern keeps recurring, update the repo's durable process or contributor notes.
