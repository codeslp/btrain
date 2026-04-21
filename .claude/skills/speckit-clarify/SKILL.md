---
name: speckit-clarify
description: Structured clarification workflow for underspecified requirements. Use
  before planning to resolve ambiguities through coverage-based questioning. Records
  answers in spec clarifications section.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: templates/commands/clarify.md
---

# Speckit Clarify

## User Input

```text
$ARGUMENTS
```

## Goal

Detect and reduce ambiguity in the active feature spec and record resolutions directly in the spec file. Run BEFORE `/speckit.plan`. If the user is running an exploratory spike and wants to skip, warn that downstream rework risk increases, then proceed.

## Steps

1. Run `.specify/scripts/bash/check-prerequisites.sh --json --paths-only` once. Parse `FEATURE_DIR`, `FEATURE_SPEC` (and optionally `IMPL_PLAN`, `TASKS`). If JSON parse fails, abort and tell the user to re-run `/speckit.specify` or verify the feature branch.

2. Load the spec. Run an internal ambiguity & coverage scan across these taxonomy categories, marking each Clear / Partial / Missing:
   - **Functional scope**: user goals, out-of-scope declarations, roles/personas.
   - **Domain & data model**: entities, attributes, relationships, identity, lifecycle, scale.
   - **Interaction/UX**: journeys, error/empty/loading states, a11y, localization.
   - **Non-functional**: performance, scalability, reliability, observability, security/privacy, compliance.
   - **Integration**: external services, failure modes, formats, protocols.
   - **Edge cases**: negative flows, rate limiting, conflict resolution.
   - **Constraints & tradeoffs**: technical constraints, rejected alternatives.
   - **Terminology**: canonical terms, avoided synonyms.
   - **Completion signals**: testable acceptance criteria, DoD.
   - **Placeholders**: TODO markers, unquantified adjectives (robust, intuitive).

   Skip candidate questions that wouldn't change implementation or that are better deferred to planning.

3. Build an internal prioritized queue (max 5 questions). Each must be answerable by EITHER 2-5 mutually-exclusive multiple-choice options OR a ≤5-word short answer. Only include questions that materially impact architecture, data modeling, task decomposition, test design, UX, ops, or compliance. Balance category coverage — prefer one high-impact unresolved area over two low-impact ones. If >5 categories remain, rank by (Impact × Uncertainty).

4. **Interactive questioning** — one question at a time:
   - **Multi-choice**: first state your recommended option with 1-2 sentence reasoning — `**Recommended:** Option [X] — <why>`. Then render the full options table:
     ```
     | Option | Description |
     |--------|-------------|
     | A | ... |
     | B | ... |
     | Short | Provide a different short answer (≤5 words) |
     ```
     Close with: `Reply with the option letter, say "yes"/"recommended" to accept, or provide your own short answer.`
   - **Short-answer**: state `**Suggested:** <answer> — <reasoning>`, then `Format: ≤5 words. Say "yes"/"suggested" to accept, or provide your own.`
   - Validate each response; if ambiguous, ask a quick disambiguation (same question, doesn't advance count). Record accepted answers in working memory — don't write to disk yet.
   - Stop when: all critical ambiguities resolved early, user signals completion ("done", "good", "no more"), or 5 asked.
   - Never reveal queued questions in advance.

5. **Integrate each accepted answer immediately** (atomic write per answer):
   - Ensure `## Clarifications` section exists just after the overview/context section. Under it, ensure `### Session YYYY-MM-DD`.
   - Append `- Q: <question> → A: <answer>` under the session heading.
   - Apply the clarification to the right section:
     - Functional → Functional Requirements.
     - Actor/role → User Stories / Actors.
     - Data → Data Model (add fields, types, relationships in order).
     - Non-functional → Quality Attributes (convert vague adjectives to metrics).
     - Edge case → Edge Cases / Error Handling.
     - Terminology → normalize the term across the spec; optionally note `(formerly "X")` once.
   - Replace obsolete contradictory statements — don't leave both.
   - Preserve formatting and section order. Only new headings allowed: `## Clarifications`, `### Session YYYY-MM-DD`.

6. **Validate** after each write and at the end:
   - Exactly one bullet per accepted answer (no duplicates).
   - ≤5 accepted questions total.
   - No lingering vague placeholders that the answer resolved.
   - No contradictory leftovers.
   - Consistent canonical terminology across updated sections.

7. **Write** the updated spec back to `FEATURE_SPEC`.

8. **Report**:
   - Questions asked/answered count.
   - Updated spec path.
   - Sections touched.
   - Coverage table per category: Resolved / Deferred / Clear / Outstanding.
   - If Outstanding/Deferred remain, recommend whether to proceed to `/speckit.plan` or re-run `/speckit.clarify` later.

## Rules

- No meaningful ambiguities → say so ("No critical ambiguities detected worth formal clarification") and suggest proceeding.
- Spec missing → instruct user to run `/speckit.specify` first; don't create one here.
- Never exceed 5 total accepted questions.
- Respect "stop", "done", "proceed" signals.
