---
name: speckit-implement
description: Execute all tasks from the task breakdown to build the feature. Use after
  task generation to systematically implement the planned solution following TDD approach
  where applicable.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: templates/commands/implement.md
---

# Speckit Implement

## User Input

```text
$ARGUMENTS
```

## Steps

1. Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` from repo root. Parse `FEATURE_DIR` and `AVAILABLE_DOCS`. Use absolute paths.

2. **Check checklists** (if `FEATURE_DIR/checklists/` exists): scan each `.md` file, count `- [ ]` vs `- [X]`/`- [x]`, render a status table (Checklist | Total | Completed | Incomplete | Status). PASS if all zero-incomplete; FAIL otherwise. If any FAIL: show the table and ask "Some checklists are incomplete. Proceed anyway? (yes/no)" — wait for response. Halt on no/wait/stop; continue on yes/proceed/continue.

3. **Load context** (absent files are skipped, not errors):
   - Required: `tasks.md` (task list + execution plan), `plan.md` (stack, architecture, file layout).
   - Optional: `data-model.md`, `contracts/`, `research.md`, `quickstart.md`.

4. **Verify ignore files**. Check which are relevant to this project and ensure each exists with appropriate patterns:
   - `.gitignore` if `git rev-parse --git-dir` succeeds.
   - `.dockerignore` if a `Dockerfile*` exists or Docker is in plan.md.
   - `.eslintignore` or the `ignores` field in `eslint.config.*` if ESLint is configured.
   - `.prettierignore` if Prettier is configured.
   - `.terraformignore`, `.helmignore`, `.npmignore` as applicable.

   If an ignore file is missing: create it with standard patterns for the detected stack and universal entries (`.DS_Store`, `.env*`, IDE directories). If it exists: append only missing critical patterns.

5. **Parse tasks.md**:
   - Phases: Setup, Tests, Core, Integration, Polish.
   - Dependencies: sequential vs `[P]` parallel.
   - Details: ID, description, file paths, parallel markers.

6. **Execute phase-by-phase**:
   - Complete each phase before the next.
   - Sequential tasks in order; `[P]` tasks may run together; tasks touching the same file stay sequential regardless.
   - TDD: test tasks run before their implementation tasks.
   - Validate phase completion before advancing.

7. **Execution order within phases**:
   - Setup → structure, dependencies, configuration.
   - Tests → contract, entity, integration.
   - Core → models, services, CLI, endpoints.
   - Integration → database, middleware, logging, external services.
   - Polish → unit tests, perf, docs.

8. **Progress & errors**:
   - Report after each completed task.
   - Halt on any non-parallel failure.
   - For `[P]` failures: continue successful ones, report failures with context.
   - Mark completed tasks as `[X]` in tasks.md.

9. **Completion check**: all required tasks done; implementation matches spec; tests pass; coverage meets requirements; final status summary.

If tasks.md is incomplete or missing, suggest running `/speckit.tasks` first.
