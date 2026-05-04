---
name: bug-fix
description: >
  Handle developer-found bugs and regressions with a test-first workflow. Use when a developer
  discovers a bug during coding, testing, or code review — NOT for user-reported feedback (use
  feedback-triage instead). Triggered by developer observations like "this is broken", "I found a
  regression", "this test is failing", or "something broke during my change". Do not start by
  editing product code. First write the smallest automated test or repro harness that fails for the
  reported bug, then fix against that proof and show it passes.
---

# Bug Fix

Use this skill when a developer discovers a bug or regression during their own work.
Do NOT use it for user-reported feedback — use the `feedback-triage` skill instead.

## Goal

Turn a bug report into a failing repro first, then land the smallest fix and prove the regression is covered.

## Workflow

1. Define the bug before touching code:
   - restate the expected behavior and the actual behavior
   - identify the narrowest stable test layer that can catch it
   - prefer extending an existing test file before creating a new one
2. Write the repro before the fix:
   - add the smallest automated regression test, or the smallest deterministic repro harness if a normal test is not possible yet
   - run it and confirm it fails for the right reason
   - do not edit production code until the repro exists unless the blocker is missing test infrastructure
3. Fix against the repro:
   - make the smallest change that turns the repro green
   - keep the new test focused on the reported behavior, not broad refactors or speculative edge cases
4. Use subagents only after the repro is red:
   - if the user explicitly asked for subagents, delegation, or parallel work and the environment supports it, spawn bounded workers after the failing repro exists
   - give each worker a concrete ownership boundary and require them to run or preserve the repro test
   - do not delegate vague "go investigate the bug" tasks
5. Prove the fix:
   - rerun the reproducing test
   - rerun nearby tests, build steps, or targeted integration checks as needed
   - report what failed before, what passes now, and what still is not covered

## Constraints

- Do not start with speculative fixes.
- Do not claim success without a failing-before / passing-after proof.
- Do not widen the test beyond the reported bug unless the contract clearly requires it.
- Do not use subagents unless the user explicitly permits delegation or parallel work in that turn.
- If the bug cannot be reproduced in an automated way, say that plainly and build the smallest durable probe you can instead of guessing.

## Anti-Example

No: "This looks like CSS. I'll tweak a few styles and see if it helps."

Yes: "I added a focused regression test that reproduces the mobile overflow, confirmed it fails, fixed the cascade, and reran the test to prove it passes."

## Default Output

- Reproducing test or repro harness added or updated
- Failing command and the reason it failed before the fix
- Fix summary
- Passing command after the fix
- Remaining gaps or unverified paths

## Trigger Prompts

1. "This checkout flow is broken again."
   Pass: write a focused failing regression test before changing app code.
2. "The recent responsive layout fix still is not working on the settings page."
   Pass: add a failing component, integration, or browser repro first, then fix against it.
3. "Search results regressed and the sorting is wrong."
   Pass: capture the regression in a test, make it fail, then fix it and prove it passes. Only use subagents if the user explicitly asked for parallel work.
