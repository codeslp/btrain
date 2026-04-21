---
name: speckit-checklist
description: Generate custom quality checklists for validating requirements completeness
  and clarity. Use to create unit tests for English that ensure spec quality before
  implementation.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: templates/commands/checklist.md
---

# Speckit Checklist

Checklists here are **unit tests for requirements writing**, not for implementation. They validate whether the spec is complete, clear, consistent, measurable, and covers the needed scenarios — they do NOT verify code behavior.

Test the requirements, not the code:
- ❌ "Verify button clicks work"
- ✅ "Are hover state requirements consistently defined for all interactive elements? [Consistency, Spec §FR-003]"

## User Input

```text
$ARGUMENTS
```

You **MUST** consider `$ARGUMENTS` before proceeding.

## Steps

1. **Setup**: Run `.specify/scripts/bash/check-prerequisites.sh --json` from repo root. Parse JSON for `FEATURE_DIR` and `AVAILABLE_DOCS`. Use absolute paths.

2. **Clarify intent** (up to 3 questions, skip if unambiguous): extract signals from `$ARGUMENTS` + spec/plan/tasks, cluster into focus areas, ask only about info that materially changes checklist content. Present options as a compact table (Option | Candidate | Why It Matters), max 5 options. If ≥2 scenario classes (Alternate / Exception / Recovery / Non-Functional) remain unclear, ask up to 2 follow-ups (max 5 total). Defaults if interaction impossible: depth = Standard, audience = Reviewer, focus = top 2 clusters.

3. **Load context**: read `FEATURE_DIR/spec.md` (required), `plan.md` and `tasks.md` if present. Load only what's relevant to active focus areas; summarize long sections.

4. **Generate checklist** at `FEATURE_DIR/checklists/[domain].md` (e.g. `ux.md`, `api.md`, `security.md`). If the file exists, **append** continuing from the last CHK ID; never delete or replace existing content.

5. **Write items** in question form, grouped by quality dimension. Each item must:
   - Ask about the requirement, not the behavior
   - Carry a dimension tag: `[Completeness]`, `[Clarity]`, `[Consistency]`, `[Measurability]`, `[Coverage]`, `[Edge Case]`, `[Ambiguity]`, `[Conflict]`, `[Assumption]`, `[Dependency]`, `[Gap]`
   - Carry a traceability reference — `[Spec §X.Y]` for existing requirements or `[Gap]` for missing ones
   - ≥80% of items must carry at least one traceability reference

   Cover categories: Requirement Completeness, Clarity, Consistency, Acceptance Criteria Quality, Scenario Coverage (Primary/Alternate/Exception/Recovery/Non-Functional), Edge Cases, Dependencies & Assumptions, Ambiguities & Conflicts.

   Prohibited — these test implementation, not requirements:
   - ❌ "Verify / Test / Confirm / Check" + behavior
   - ❌ "Click / navigate / render / load / execute"
   - ❌ References to code, APIs, frameworks

   Required patterns:
   - ✅ "Are [requirement type] defined for [scenario]?"
   - ✅ "Is [vague term] quantified with specific criteria?"
   - ✅ "Are requirements consistent between [section A] and [section B]?"
   - ✅ "Can [requirement] be objectively measured?"

6. **Consolidate**: soft cap ~40 items. Merge near-duplicates. Batch >5 low-impact edge cases into one item.

7. **Format** using `.specify/templates/checklist-template.md` if present. Fallback: H1 title, meta lines, `##` category sections, `- [ ] CHK### <question>` items with globally incrementing IDs starting at CHK001.

8. **Report**: full checklist path, item count, created-vs-appended, one-line summary of focus areas + depth + audience.
