---
name: speckit-tasks
description: Break down implementation plans into actionable task lists. Use after
  planning to create a structured task breakdown. Generates tasks.md with ordered,
  dependency-aware tasks.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: templates/commands/tasks.md
---

# Speckit Tasks

## User Input

```text
$ARGUMENTS
```

## Steps

1. **Setup**: Run `.specify/scripts/bash/check-prerequisites.sh --json` from repo root. Parse `FEATURE_DIR` and `AVAILABLE_DOCS`. Use absolute paths.

2. **Load design docs** from `FEATURE_DIR`:
   - Required: `plan.md` (stack, libraries, structure), `spec.md` (user stories with priorities).
   - Optional: `data-model.md`, `contracts/`, `research.md`, `quickstart.md`.

3. **Generate tasks** organized by user story:
   - Extract stack + structure from plan.md.
   - Extract user stories with priorities (P1, P2, …) from spec.md.
   - Map entities (data-model.md) and contracts (contracts/) to the stories they serve.
   - Use research.md decisions for setup tasks.
   - Build a dependency graph showing story completion order.
   - Identify parallel opportunities within each story.
   - Verify each user story has all needed tasks and is independently testable.

4. **Write** `tasks.md` using `.specify/templates/tasks-template.md` as the skeleton:
   - Phase 1: Setup (project initialization).
   - Phase 2: Foundational (blocking prerequisites for all stories).
   - Phase 3+: One phase per user story in priority order. Each phase contains: story goal, independent test criteria, tests (only if requested), implementation tasks.
   - Final Phase: Polish & cross-cutting concerns.
   - Include a Dependencies section and per-story parallel-execution examples.
   - Include an Implementation Strategy section favoring MVP first + incremental delivery.

5. **Report**: path to tasks.md, total task count, per-story counts, parallel opportunities, suggested MVP scope (typically US1), and format validation confirmation.

## Task Format (strict)

```
- [ ] [TaskID] [P?] [Story?] Description with file path
```

- **Checkbox** `- [ ]`: always.
- **Task ID**: sequential (T001, T002 …) in execution order.
- **[P]**: include only when the task touches different files and has no dependency on an incomplete task.
- **[Story]** label: `[US1]`, `[US2]` … required for user-story-phase tasks only. Setup, Foundational, and Polish phases have NO story label.
- **Description**: action verb + exact file path.

Example: `- [ ] T012 [P] [US1] Create User model in src/models/user.py`

Rejects: missing ID, missing checkbox, missing story label on a user-story task, missing file path.

## Rules

- Tasks MUST be grouped by user story so each story is independently implementable and testable.
- Tests are **optional** — generate test tasks only if the spec or user explicitly requests TDD.
- Shared infrastructure → Setup. Blocking prerequisites → Foundational. Story-specific setup → within that story's phase.
- Entities serving multiple stories → earliest story or Setup, not duplicated.
- Each task must be specific enough that an LLM can complete it without re-reading the spec.
