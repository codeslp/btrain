---
name: speckit-specify
description: Create or update feature specifications from natural language descriptions.
  Use when starting new features or refining requirements. Generates spec.md with
  user stories, functional requirements, and acceptance criteria following spec-driven
  development methodology.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: templates/commands/specify.md
---

# Speckit Specify

## User Input

```text
$ARGUMENTS
```

The text the user typed after `/speckit.specify` **is** the feature description. Assume it's available even if `$ARGUMENTS` appears literally. Don't ask them to repeat unless empty.

## Steps

1. **Generate a 2-4 word short name** for the branch in `action-noun` form. Preserve technical terms (OAuth2, API, JWT). Examples: `user-auth`, `oauth2-api-integration`, `fix-payment-timeout`.

2. **Find the next feature number** for this short name — check remote branches (`git fetch --all --prune` first), local branches, and `specs/` directories. Use max(N) + 1, or 1 if none exist.

3. **Create the feature** by running once:
   ```
   .specify/scripts/bash/create-new-feature.sh --json --number <N+1> --short-name "<short-name>" "$ARGUMENTS"
   ```
   Parse the JSON output for `BRANCH_NAME` and `SPEC_FILE`.

4. **Load** `.specify/templates/spec-template.md` for required section structure.

5. **Author the spec** following this flow:
   - Parse description; extract actors, actions, data, constraints.
   - For unclear aspects: make informed guesses from context and industry standards. Only mark `[NEEDS CLARIFICATION: <question>]` when the choice materially affects scope/security/UX and no reasonable default exists. **Max 3 markers total**, prioritized: scope > security/privacy > UX > technical detail.
   - Fill User Scenarios & Testing. If no clear user flow, abort with error.
   - Generate Functional Requirements — each one testable. Document assumptions in an Assumptions section.
   - Define Success Criteria: measurable, technology-agnostic, verifiable (e.g. "Users complete checkout in under 3 minutes", NOT "API responds in <200ms").
   - Identify Key Entities when data is involved.

6. **Write the spec** to `SPEC_FILE` using the template's section order and headings.

7. **Quality check** against the template's checklist (`FEATURE_DIR/checklists/requirements.md`, created if absent). Items include: no implementation leakage, no unresolved clarifications, testable requirements, measurable success criteria, scope bounded, dependencies identified. If items fail (excluding `[NEEDS CLARIFICATION]`): update spec, re-run; max 3 iterations before escalating remaining issues in notes.

8. **Resolve clarifications** (if any markers remain, max 3): present each as a numbered question with context, suggested answers as a 3-option + Custom table, and wait for user responses. Markdown table cells must have spaces around content (`| A |` not `|A|`). Replace markers with chosen answers, then re-validate.

9. **Report**: branch name, spec path, checklist pass/fail, suggested next command (`/speckit.clarify` or `/speckit.plan`).

## Guidelines

- Focus on **WHAT** and **WHY**, not HOW (no stacks, frameworks, APIs).
- Written for business stakeholders.
- Mandatory sections must be completed; omit optional sections that don't apply (don't leave "N/A").
- Reasonable defaults — don't ask about these: standard data retention, standard web/mobile performance expectations, user-friendly error handling, session-based or OAuth2 auth, domain-appropriate integration patterns.
