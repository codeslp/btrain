---
name: code-simplifier
description: Simplifies recently changed code and surfaces architecture-deepening opportunities while preserving behavior. Use before handoff, after implementation, or when code feels shallow, over-coupled, hard to test, or hard for agents to navigate.
---

# Code Simplifier

Analyze recently modified code and apply behavior-preserving refinements. When the friction is architectural, surface deepening opportunities that improve module depth, locality, leverage, testability, and agent navigability.

## Goal

Produce code that is readable, explicit, maintainable, and easier to test through real interfaces. Prefer clarity over compactness. Default to preserving behavior and public interface contracts; only propose interface changes as architecture candidates unless the user explicitly asks you to implement the refactor.

## Trigger

- End of a feature implementation or long coding session
- Before handoff or PR
- User explicitly asks to simplify or clean up code
- User asks for architecture cleanup, refactoring opportunities, deeper modules, better testability, or better codebase navigability

## Workflow

1. Identify the work scope:
   - Recently modified files via `git diff --name-only` against the branch base or recent commits.
   - Any domain docs that already exist: `CONTEXT.md`, `CONTEXT-MAP.md`, and relevant `docs/adr/` entries. If absent, proceed silently.
   - **Prior implementation context (Unblocked)**: before adding or reshaping abstractions, search for existing helpers, rejected refactors, and code patterns in nearby repos:
     ```bash
     .claude/scripts/unblocked-context.sh search-code \
       "<changed modules> helper abstraction adapter pattern" --limit 8
     ```
     If local shape is unclear, run a broader pass:
     ```bash
     .claude/scripts/unblocked-context.sh research \
       "<changed modules> simplification refactor architecture decision" \
       --effort low --limit 5
     ```
     If either result has `_skipped`, proceed with local code reading and record the skip reason in remaining gaps.
2. Use the architecture vocabulary consistently:
   - **Module**: anything with an interface and implementation.
   - **Interface**: everything callers must know: types, invariants, ordering, error modes, config, and performance expectations.
   - **Depth**: leverage at the interface. Deep modules hide substantial behavior behind a small interface; shallow modules make callers learn nearly as much as the implementation knows.
   - **Seam**: where an interface lives and behavior can vary without editing callers.
   - **Adapter**: concrete code satisfying an interface at a seam.
   - **Leverage**: what callers gain from depth.
   - **Locality**: what maintainers gain when change, bugs, knowledge, and verification concentrate in one place.
3. For each file or module, analyze for local cleanup issues:
   - Unnecessary complexity and deep nesting
   - Redundant code, pass-through modules, and shallow abstractions
   - Unclear variable/function names
   - Inconsistent patterns compared to the rest of the codebase
   - Unnecessary comments that describe obvious code
   - Nested ternary operators (replace with `if`/`else` or `switch`)
4. Also analyze for architecture-deepening friction:
   - Understanding one concept requires bouncing across many small modules.
   - A module is shallow: its interface is nearly as complex as its implementation.
   - Logic was extracted only for testability, while the real behavior is in how callers orchestrate it.
   - Tests reach past the interface into private implementation details.
   - A seam has only one adapter, making the seam hypothetical rather than real.
   - Tightly coupled modules leak implementation details across seams.
   - Domain concepts are named inconsistently with `CONTEXT.md` vocabulary.
5. Apply safe local refinements that:
   - Reduce nesting and consolidate related logic
   - Improve naming for clarity
   - Remove dead code and unused imports
   - Remove pass-through helpers when the deletion test says they are not earning their keep
   - Align with project-specific conventions (check `AGENTS.md`, `CLAUDE.md`, and existing patterns)
   - Preserve all public interfaces, contracts, and behavioral outcomes
6. For architectural changes that would move seams or alter interfaces, present numbered deepening candidates before editing:
   - **Files**: modules involved
   - **Problem**: why the current shape causes friction
   - **Solution**: plain-English change
   - **Benefits**: locality, leverage, and how tests improve
   - **Risks**: interface changes, migration cost, or ADR conflicts
7. Verify each change preserves functionality:
   - Run existing tests (`npm test`, `npx playwright test`, etc.)
   - Confirm no type errors (`npx tsc --noEmit`)
8. Document only significant changes that affect understanding.

## Architecture Checks

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was pass-through. If complexity reappears across callers, it was earning its keep.
- **Interface is the test surface**: callers and tests should cross the same seam. If tests need to reach past the interface, the module shape is suspect.
- **Adapter count**: one adapter is a hypothetical seam; two adapters make the seam real.
- **Internal seams stay internal**: do not expose private implementation seams just because tests use them.
- **Dependency strategy**: in-process code can be tested directly through the deep module; local stand-ins can stay behind internal seams; owned remote dependencies need ports plus production/test adapters; true external dependencies need injected ports and mock adapters.
- **ADR discipline**: do not re-litigate recorded decisions unless real friction warrants reopening them. Mark conflicts explicitly.
- **Domain language**: use `CONTEXT.md` terms when they exist; if a future architecture discussion resolves a fuzzy domain term, update or propose updating the context doc.

## Constraints

- Do not change behavior during a cleanup pass.
- Do not remove deep abstractions that provide locality or leverage.
- Do not introduce a seam unless real variation exists or the user has chosen to explore that architecture.
- Do not extract helpers merely to lower line counts if the result is shallow and caller orchestration stays complex.
- Do not optimize for fewer lines over readability.
- Do not combine too many concerns into one module just to avoid indirection.
- Do not modify files outside the recent-change scope unless explicitly asked or the chosen deepening candidate requires it.
- Prefer `function` keyword over arrow functions for top-level declarations.
- Use explicit return type annotations for exported functions.
- Choose clarity over brevity. Explicit code is better than compact code.
- Keep refactoring commits separate from feature commits when possible.

## Default Output

- Local simplifications applied, with verification run.
- Unblocked implementation-pattern sources or skip reason.
- Architecture candidates surfaced when the safe local cleanup would not solve the underlying friction.
- Any ADR or context-language conflict called out clearly.
- Remaining gaps or unverified behavior.
