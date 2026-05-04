---
name: bug-rca
description: >
  Root-cause analysis BEFORE writing a repro or a fix. Pulls cited evidence from across
  PRs, issues, messages, and incidents (via the Unblocked CLI) and synthesizes a leading
  hypothesis with citations.
  TRIGGER when: user asks "why did this break", "what changed", "find the regression",
  "root cause", "regression bisect", "did anyone touch <file> recently", "is this related
  to <PR|incident>", or any framing that wants the *cause* of a bug rather than its fix.
  DO NOT TRIGGER when: the user already has a hypothesis and just wants the fix written
  (use `bug-fix`); the report is fresh user feedback that hasn't been triaged yet (use
  `feedback-triage` first); the symptom is a deploy / readiness failure (use `deploy-debug`).
---

# Bug RCA

Find the cause before writing the repro. Most bug fixes are weakened by jumping to a fix
against the most-visible symptom. RCA pulls cited prior art — recent PRs touching the
file, related tickets, similar incidents, prior fix attempts — so the subsequent
`bug-fix` (or `feedback-triage`) targets the right thing.

## Goal

Produce a one-page RCA: leading hypothesis (1-2 sentences) + cited evidence + ruled-out
alternatives + suggested next skill. RCA is read-only — it does not edit production code.

## Soft dependency

Calls `.claude/scripts/unblocked-context.sh` (introduced in PR for the helper). If that
script is missing, the workflow degrades to "ask the user for the missing context"
rather than failing — but the skill is meaningfully weaker without it.

## Workflow

1. **Restate the symptom precisely.**
   - What is failing? (1 sentence — the observed behavior, not the root guess)
   - Where? (file path, route, component, or system boundary if known)
   - When did it start failing? (commit hash, deploy time, or "unknown — pre-RCA bisection")
   - Who saw it? (developer, CI, end user, monitor)
   Do not edit any code in this step. Do not write a test yet.

2. **Hypothesis pass — broad synthesis across all sources.**
   ```
   .claude/scripts/unblocked-context.sh research \
     "<one-sentence symptom> <one or two relevant file paths>" \
     --effort medium --limit 5
   ```
   Read the returned summary and top sources. Look for:
   - PRs that recently touched the affected files
   - Issues describing similar symptoms (especially closed-as-fixed → potential regression)
   - Slack / messaging discussions of the symptom
   - Incident reports near the affected component
   If `_skipped` is present, note the reason and proceed without external context (the
   RCA will be weaker; flag it explicitly).

3. **Bisection pass — narrow the regression window with structured PR query.**
   ```
   .claude/scripts/unblocked-context.sh query-prs \
     "PRs touching <file> in the last 30 days" \
     --limit 10
   ```
   If you have a known-good commit / deploy and a known-bad one, scope the query to
   that window. Surface the smallest set of PRs that could plausibly have introduced
   the regression. Do not assume the most recent PR is the cause — surface candidates,
   weight them by relevance.

4. **Expand the top one or two hypotheses.**
   For each leading-candidate PR or issue from steps 2-3:
   ```
   .claude/scripts/unblocked-context.sh get-urls <pr_url> [<issue_url>...]
   ```
   Read the full PR description, review discussion, and linked issues to confirm or
   rule out the hypothesis. This is where the read-only nature of RCA matters most —
   you're consuming context, not modifying state.

5. **Synthesize the one-page RCA.**
   - **Leading hypothesis** — 1-2 sentences. The most likely cause of the symptom, with
     the citation that anchors it.
   - **Evidence** — bulleted list of {source title, URL, source type, why it supports
     the hypothesis}.
   - **Ruled out** — bulleted list of plausible alternatives that the evidence does NOT
     support, with the reason each was ruled out. (Do not skip this. Surfacing what
     was *not* the cause is half the value of RCA.)
   - **Confidence** — `high` / `medium` / `low` with one-sentence justification.
   - **Suggested next skill** — `bug-fix` (developer-found regression to repro + fix),
     `feedback-triage` (user-reported with no existing log entry), or `reflect` (the
     RCA reveals a process / workflow failure, not a code bug).

6. **Hand off, do not fix.**
   The output of this skill is the RCA packet. Do NOT write a regression test or edit
   production code from inside this skill. Print the RCA, then explicitly tell the
   user (or the next skill invocation) which skill should pick up next.

## Constraints

- RCA is read-only. No production edits, no test writing, no log mutations.
- Do not skip the "Ruled out" list. Single-hypothesis RCAs without alternatives are
  weak.
- Do not present the most recent PR as the cause by default. Weight candidates by the
  evidence in step 4.
- Do not invoke `bug-fix` or `feedback-triage` from inside this skill. RCA produces a
  packet; the next skill consumes it.
- If the Unblocked helper returns `_skipped`, say so plainly in the RCA. Do not pretend
  the broad search ran when it didn't.

## Anti-Pattern

No: "The bug is in `foo.ts:42` because that file was changed yesterday in PR #123."
That's a guess anchored to recency, not evidence.

Yes: "Leading hypothesis: PR #123 introduced a NULL handling regression in `foo.ts`
because (a) the PR description acknowledges removing a guard clause, (b) the symptom
matches the code path the guard protected, (c) the timing aligns with onset.
Confidence: high. Ruled out: deploy config drift (no infra changes in the window),
upstream API change (no recent integration PRs), data schema (table unchanged in 90d).
Suggested next: `bug-fix` with PR #123 named as the suspect."

## Default Output

- Symptom restatement (what / where / when / who)
- Leading hypothesis with citation
- Evidence list with URLs and source types
- Ruled-out alternatives with reasons
- Confidence + justification
- Suggested next skill

## Trigger Prompts

1. "The checkout flow started 500ing at 3am — what changed?"
   Pass: hypothesis + bisection passes via Unblocked, RCA names the leading PR with
   citations, suggests `bug-fix`.
2. "Why is the auth middleware rejecting valid tokens?"
   Pass: research + query-prs on auth files, expand top PRs, RCA with confidence.
3. "User reported the dashboard is blank — please investigate."
   Pass: route through `feedback-triage` first (this is fresh user feedback). RCA
   takes over only after triage logs the entry and the cause is unclear.
