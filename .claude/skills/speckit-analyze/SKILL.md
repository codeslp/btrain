---
name: speckit-analyze
description: Perform cross-artifact consistency analysis across spec.md, plan.md,
  and tasks.md. Use after task generation to identify gaps, duplications, and inconsistencies
  before implementation.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: templates/commands/analyze.md
---

# Speckit Analyze

## User Input

```text
$ARGUMENTS
```

## Goal

Identify inconsistencies, duplications, ambiguities, and underspecified items across `spec.md`, `plan.md`, `tasks.md` before implementation. Run only after `/speckit.tasks` has produced a complete `tasks.md`.

## Constraints

- **STRICTLY READ-ONLY** — no file writes. Output a structured report. Offer remediation only with explicit user approval.
- **Constitution is non-negotiable**. Violations of `.specify/memory/constitution.md` principles are automatically CRITICAL. The principle must stand; the spec/plan/tasks must adjust. Changing a principle requires a separate explicit constitution update.

## Steps

1. **Initialize**: run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` once. Parse for `FEATURE_DIR` and derive absolute paths: SPEC, PLAN, TASKS. Abort with instructions if any required file is missing.

2. **Load artifacts** (progressive, not full dumps):
   - spec.md: overview, functional + non-functional requirements, user stories, edge cases.
   - plan.md: architecture/stack, data model refs, phases, technical constraints.
   - tasks.md: task IDs, descriptions, phase groupings, `[P]` parallel markers, referenced file paths.
   - constitution: principle names, MUST/SHOULD statements.

3. **Build semantic models** internally (don't echo raw content):
   - Requirements inventory with stable slug keys (e.g. "User can upload file" → `user-can-upload-file`).
   - User story/action inventory with acceptance criteria.
   - Task coverage mapping — tasks → requirements/stories via keyword or explicit ID references.
   - Constitution rule set.

4. **Detection passes** (high-signal only, limit 50 findings total, overflow summarized):
   - **Duplication**: near-duplicate requirements; mark lower-quality phrasing for consolidation.
   - **Ambiguity**: vague adjectives (fast, scalable, secure, intuitive, robust) without measurable criteria; unresolved placeholders (TODO, TKTK, ???, `<placeholder>`).
   - **Underspecification**: requirements missing objects or measurable outcomes; stories missing acceptance criteria; tasks referencing undefined files/components.
   - **Constitution alignment**: anything conflicting with a MUST principle; missing mandated sections or gates.
   - **Coverage gaps**: requirements with zero tasks; tasks with no mapped requirement; non-functional requirements (performance, security) not reflected in tasks.
   - **Inconsistency**: terminology drift; entities in plan but absent in spec (or vice versa); task ordering contradictions; conflicting requirements (e.g., one says Next.js, another Vue).

5. **Assign severity**:
   - **CRITICAL**: constitution MUST violation, missing core artifact, zero-coverage requirement blocking baseline functionality.
   - **HIGH**: duplicate/conflicting requirement, ambiguous security/performance attribute, untestable acceptance criterion.
   - **MEDIUM**: terminology drift, missing non-functional coverage, underspecified edge case.
   - **LOW**: wording/style, minor redundancy.

6. **Report** as Markdown (no file writes):

   ```markdown
   ## Specification Analysis Report

   | ID | Category | Severity | Location(s) | Summary | Recommendation |
   |----|----------|----------|-------------|---------|----------------|
   | A1 | Duplication | HIGH | spec.md:L120-134 | ... | ... |

   ### Coverage Summary
   | Requirement Key | Has Task? | Task IDs | Notes |
   |-----------------|-----------|----------|-------|

   ### Constitution Alignment Issues
   ### Unmapped Tasks
   ### Metrics
   - Total Requirements / Total Tasks / Coverage % / Ambiguity Count / Duplication Count / Critical Count
   ```

   IDs should be stable across re-runs (prefix by category initial).

7. **Next Actions block**:
   - CRITICAL present → resolve before `/speckit.implement`.
   - Only LOW/MEDIUM → may proceed; list improvement suggestions.
   - Concrete command hints: `/speckit.specify` refinement, `/speckit.plan` adjustment, manual tasks.md edit.

8. **Ask**: "Would you like concrete remediation edits for the top N issues?" — do NOT apply automatically.

## Operating Principles

- Deterministic: identical input produces identical IDs and counts.
- Never hallucinate missing sections — report their absence accurately.
- Cite specific instances over generic patterns.
- Report zero issues gracefully with a success summary.
