---
name: speckit-formal
description: Orchestrate the full TLA+ gate across specs/tla/ — pin sync, TLC runs, and trace narration — and produce one consolidated verdict for CI or review packets. TRIGGER when the user says "run formal checks", "verify the spec", "check all TLA", "run the spec gate", "formal verdict", "does the spec pass", or when CI runs the spec-verification job. Do NOT trigger from pre-handoff (pre-handoff runs tla-pin-sync --check only per spec 002 §5.3). Do NOT trigger when only one .tla is in question (use the specific skill — tla-pin-sync, tla-run-tlc, or tla-trace-explain) or when specs/tla/ is empty (phase 0; this skill is a no-op).
---

# Speckit Formal

Use this skill to run the full TLA+ gate over every `.tla` under `specs/tla/` and produce a single consolidated verdict. Wraps `tla-pin-sync`, `tla-run-tlc`, and `tla-trace-explain`.

## Goal

Single-command answer to "does the formal surface of the spec pass right now, and if not, where?" — suitable for CI exit codes and reviewer review-packets. Pre-handoff uses `tla-pin-sync --check` only (spec 002 §5.3).

## Workflow

1. Run `tla-pin-sync` across all `.tla` under `specs/tla/`. If any pin is stale, stop and return the stale list. Do not proceed to TLC — a stale pin means the `.tla` may be checking a spec that no longer matches its current prose, and a passing verdict would be misleading.
2. For each `.tla`, run `tla-run-tlc`. Collect the per-spec verdicts.
3. Aggregate:
   - Counts: total pass / counterexample / state_space_exhausted.
   - For each counterexample: run `tla-trace-explain` and attach the narrative.
   - For each state_space_exhausted: attach the depth reached and the bound-reduction suggestion.
4. Produce a consolidated output:
   - **Top line:** overall status — `pass` (all TLAs pass), `fail` (any counterexample), or `warn` (no counterexamples but at least one exhaustion).
   - **Per-TLA table:** name, verdict, invariants checked, states explored.
   - Counterexample narratives inline under the table.
5. Exit codes, matching spec 002 §5.4:
   - 0 on overall `pass`
   - 1 on overall `fail` (CI blocks)
   - 124 on overall `warn` (CI comments but does not block)
6. Cache the consolidated result at `specs/tla/.tlc-results/_aggregate.json` so pre-handoff, CI comments, and review packets consume the same artifact.

## Constraints

- Do not duplicate logic from `tla-pin-sync`, `tla-run-tlc`, or `tla-trace-explain`. This is an orchestrator; delegate.
- Do not treat state-space exhaustion as failure. Per spec 002 decision 4, exhaustion warns, counterexample blocks.
- Do not skip the pin-sync step. Running TLC on a stale-pin `.tla` is worse than not running TLC — a passing verdict against the wrong prose silently misleads review.
- Do not run this skill when `specs/tla/` is empty (spec 002 phase 0). It is a no-op and should report "no formal surface yet".
- Do not write anywhere outside `specs/tla/.tlc-results/`. All side effects land in that directory.

## Default Output

- Overall status: pass / fail / warn
- Per-TLA verdict table
- Counterexample narratives for any failures
- Warnings for any exhaustions with bounds reached
- Path to `specs/tla/.tlc-results/_aggregate.json`

## Relationship to other skills

- `pre-handoff` runs `tla-pin-sync --check` only (spec 002 §5.3). Pre-handoff does NOT run the full formal gate — that is a phase 4 consideration once three real `.tla` files have shaped the workflow.
- CI calls `speckit-formal` directly on PRs that touch `specs/` or `specs/tla/` (spec 002 §5.4). Counterexample blocks the PR; stale pin blocks; state-space exhaustion warns.
- Review packet includes the aggregate result so a reviewer opens the PR already knowing the formal verdict.

## Failure mode to avoid

Treating `warn` as equivalent to `pass` silently. Exhaustion means TLC did not finish exploring — the invariants might still fail at greater depth. Surface the warning, name the bound reached, and log the suggested bound reduction so the next author can resolve it instead of sweeping it under the rug.
