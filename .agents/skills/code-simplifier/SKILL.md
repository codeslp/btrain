---
name: code-simplifier
description: Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise, and should also check for modularization opportunities when changed files mix responsibilities or are hard to reason about locally.
---

# Code Simplifier

Analyze recently modified code and apply refinements that improve clarity, consistency, and maintainability without changing behavior.

## Goal

Produce code that is readable, explicit, and maintainable. Prefer clarity over compactness. Never change what the code does — only how it does it.

## Trigger

- End of a feature implementation or long coding session
- Before handoff or PR
- User explicitly asks to simplify or clean up code

## Workflow

1. Identify recently modified files (use `git diff --name-only` against the branch base or recent commits).
2. For each file, analyze for:
   - Unnecessary complexity and deep nesting
   - Redundant code and abstractions
   - Unclear variable/function names
   - Inconsistent patterns compared to the rest of the codebase
   - Unnecessary comments that describe obvious code
   - Nested ternary operators (replace with `if`/`else` or `switch`)
   - Mixed responsibilities that make the file hard to reason about locally: for example orchestration mixed with parsing, policy, formatting, or I/O
   - Opportunities to extract a cohesive helper module or package-local module that hides volatile details behind a small interface
3. Apply refinements that:
   - Reduce nesting and consolidate related logic
   - Improve naming for clarity
   - Remove dead code and unused imports
   - Align with project-specific conventions (check `AGENTS.md`, `AGENTS.md`, and existing patterns)
   - Preserve all public interfaces, API contracts, and behavioral outcomes
   - When modularizing, prefer responsibility or information-hiding boundaries over execution-order splits, and keep the calling entry point thin and obvious
   - Only split code across files when the new boundary reduces cognitive load for the next agent instead of forcing more cross-file jumping
4. Verify each change preserves functionality:
   - Run existing tests (`npm test`, `npx playwright test`, etc.)
   - Confirm no type errors (`npx tsc --noEmit`)
5. If you considered modularization, state whether you extracted a module or deliberately kept the code together and why.
6. Document only significant changes that affect understanding.

## Constraints

- ❌ Do NOT change what the code does — only how it does it
- ❌ Do NOT remove helpful abstractions that improve organization
- ❌ Do NOT create overly clever solutions that are hard to understand
- ❌ Do NOT prioritize "fewer lines" over readability (no dense one-liners)
- ❌ Do NOT combine too many concerns into single functions or components
- ❌ Do NOT split code into tiny files or wrapper layers that add indirection without improving local reasoning
- ❌ Do NOT modify files outside the recently changed scope unless explicitly asked
- ✅ Prefer `function` keyword over arrow functions for top-level declarations
- ✅ Use explicit return type annotations for exported functions
- ✅ Choose clarity over brevity — explicit code is better than compact code
- ✅ Keep refactoring commits separate from feature commits when possible
- ✅ Prefer modules with one clear reason to change and a small, readable public surface

## Trigger Prompts

1. "Run code-simplifier on this feature before handoff." → Review the changed files, simplify control flow, and check whether any mixed-responsibility files should be split into clearer modules.
2. "Clean up this patch and see if the file boundaries still make sense." → Apply readability refactors and explicitly evaluate modularization opportunities that would improve local reasoning.
3. "Do a simplification pass on this large edited file." → Look for naming, nesting, and responsibility-boundary improvements, but avoid speculative or fragmentation-heavy refactors.
