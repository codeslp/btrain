---
name: feedback-triage
description: >
  Triage user feedback into minor fixes, bugs, or spec changes, then drive test-first resolution.
  TRIGGER when: user pastes app feedback, says "feedback", "user reported", "triage", "user issue",
  mentions the feedback log, or describes a problem a real user encountered.
  DO NOT TRIGGER when: developer finds a bug themselves during coding (use bug-fix skill instead),
  or when discussing hypothetical improvements not from user feedback.
---

# Feedback Triage

Systematically process user-reported feedback: assess, log, reproduce with a test, fix.

## Goal

Turn raw user feedback into a triaged log entry, a failing reproduction test, and a verified fix — or flag it for speckit if it requires a spec change.

## Workflow

### Step 1: First Pass Assessment

1. Read the raw feedback the user pasted
2. Search relevant source files to understand the affected area
3. Assess **category**:
   - `MINOR` — cosmetic, copy, small UX tweak, no behavior change
   - `BUG` — broken behavior vs what the spec/app should do
   - `SPEC` — feature gap, new capability, or behavior that requires a spec update
4. Assess **complexity**:
   - `low` — 1-2 files touched
   - `medium` — 3-5 files touched
   - `high` — 6+ files, cross-cutting concerns
5. Present assessment to the user with reasoning (which files, why this category)
6. **Do NOT write tests or code yet**

### Step 2: Append to Feedback Log

1. Read `.claude/collab/FEEDBACK_LOG.md` to find the next sequential number (or create the file if missing — use the template in `references/log-template.md`)
2. Append a new entry using the format in `references/entry-format.md`
3. ID format: `FB-<CATEGORY>-<NNN>` where NNN is globally sequential
4. Set status to `new`

### Step 3: Wait for User Confirmation

1. User confirms or overrides the category
2. If category changes, update the tag in the ID (keep same sequential number)
3. Update status to `triaged`

### Step 4: Branch by Category

**If MINOR or BUG:**

1. Write a failing reproduction test FIRST — pick test type by issue location:
   - Pick the test layer that matches the issue location (E2E for UI/interaction, integration for API/backend, unit/component for rendering logic, DB-level for data issues)
   - Prefer the project's existing test conventions and directory structure
   - Check for existing test infrastructure before creating new patterns
2. Update log: set `Repro test` to file path, status to `test-written`
3. Fix the code to make the test pass
4. Update log: set `Fix` to changed file paths + commit hash (or branch name / "pending commit" if not yet committed), status to `fixed`
5. Run full test suite to confirm no regressions
6. Update status to `verified`

**If SPEC:**

1. Update status to `blocked-spec`
2. Do NOT write tests or code
3. Tell the user: "This requires a spec update. Use `/speckit-specify` to start the speckit flow."
4. Only proceed after user explicitly runs the speckit workflow

## Constraints

- `.claude/collab/FEEDBACK_LOG.md` is the single source of truth — never duplicate items elsewhere
- Every MINOR/BUG fix gets a failing test before any code change
- Items stay `new` until user explicitly confirms triage
- SPEC items get no tests or fixes until speckit completes
- Always link fixes back: file paths changed + commit hash or branch reference in the log entry (a pending branch state is acceptable if the commit hasn't landed yet)
- If reclassified, update the category tag but keep the sequential number stable
- Do not batch multiple feedback items into one log entry — one entry per issue

## Anti-Pattern

Do NOT skip the reproduction test and jump straight to fixing. The test is the proof the bug exists and the proof the fix works. A fix without a test is unverified.

## Default Output

After Step 1 (first pass):
- Category + complexity assessment with reasoning
- Relevant code paths identified
- Entry appended to feedback log as `new`
- Waiting for user confirmation

After full workflow:
- Feedback log entry updated through `verified`
- Failing test written, now passing
- Fix linked in log (commit hash, branch reference, or pending state)

## Validation Prompts

1. "A user said the checkout form freezes after submitting" → should trigger, assess as BUG, search checkout code
2. "I think we should add a dark mode" → should NOT trigger (not user-reported feedback, use speckit)
3. "Triage this: user couldn't log in with their email" → should trigger on "triage" keyword, assess login code
