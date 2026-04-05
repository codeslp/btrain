---
name: code-simplifier
description: Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise.
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
3. Apply refinements that:
   - Reduce nesting and consolidate related logic
   - Improve naming for clarity
   - Remove dead code and unused imports
   - Align with project-specific conventions (check `AGENTS.md`, `AGENTS.md`, and existing patterns)
   - Preserve all public interfaces, API contracts, and behavioral outcomes
4. Verify each change preserves functionality:
   - Run existing tests (`npm test`, `npx playwright test`, etc.)
   - Confirm no type errors (`npx tsc --noEmit`)
5. Document only significant changes that affect understanding.

## Constraints

- ❌ Do NOT change what the code does — only how it does it
- ❌ Do NOT remove helpful abstractions that improve organization
- ❌ Do NOT create overly clever solutions that are hard to understand
- ❌ Do NOT prioritize "fewer lines" over readability (no dense one-liners)
- ❌ Do NOT combine too many concerns into single functions or components
- ❌ Do NOT modify files outside the recently changed scope unless explicitly asked
- ✅ Prefer `function` keyword over arrow functions for top-level declarations
- ✅ Use explicit return type annotations for exported functions
- ✅ Choose clarity over brevity — explicit code is better than compact code
- ✅ Keep refactoring commits separate from feature commits when possible
