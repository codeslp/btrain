---
name: context-scout
description: >
  Classify and gather organizational context through the repo-local Unblocked helper
  before planning, cross-repo work, unfamiliar subsystem changes, feedback deduplication,
  security or migration work, deploy investigations, incidents, and decisions that depend
  on prior intent. Produce a standard context receipt for btrain. Skip Unblocked when the
  current local code fully answers a mechanical or narrowly scoped question.
---

# Context Scout

Use this skill to decide how much organizational history a task needs and leave a compact,
citable receipt for the next agent. Local reads explain what the checkout does now;
Unblocked adds why it exists, what was tried, and what other systems depend on it.

## Goal

Gather enough prior art to avoid repeating mistakes without turning every edit into a
research project.

## Workflow

1. Classify the task before querying:
   - `none`: formatting, renames, deterministic test additions, or a narrow local change
     whose behavior and intent are fully answered by current files.
   - `targeted`: user feedback, an unfamiliar subsystem, a changed trust boundary, an
     additive migration, a classified deploy failure, or one concrete historical question.
   - `deep`: specs and implementation plans, root-cause analysis, incidents, cross-repo
     contracts, destructive/non-additive migrations, or architecture decisions.
2. Write one complete question per unknown. Include task IDs, paths, routes, dates, or
   component names. Do not submit keyword-only searches.
3. Use `.claude/scripts/unblocked-context.sh`:
   - `targeted`: run one source-specific search or `research ... --effort low --limit 5`.
   - `deep`: run `research ... --effort high --limit 5`, mine identifiers from the result,
     then expand only the strongest sources with a focused search or `get-urls`.
   - When the repository's `owner/repo` slug is known, use
     `get-rules <owner/repo> --task code-generation --paths <path>` for conventions scoped
     to changed files.
4. Verify decisive claims against the local checkout or another primary artifact. Unblocked
   code reflects the indexed/default branch and may not match the current lane.
5. Emit the receipt below. When the helper returns `_skipped`, keep working if safe and
   record the reason as a context gap. Provider availability is a soft gate.
6. For btrain work:
   - Use `btrain handoff claim --unblocked-context` for `targeted` and `deep` lanes.
   - Put the compact receipt in the handoff pre-flight/why context, use `--gap` for missing
     context, and turn constraints into specific `--review-ask` bullets.
   - Reviewers may run `btrain review context --lane <id>` when the receipt is missing,
     stale, or insufficient for the risk.
7. If research establishes a durable decision, write it back to an indexed source such as
   the PR description, issue, spec, ADR, or runbook. A btrain handoff should link to that
   artifact rather than becoming the only record.

## Context Receipt

```text
Context tier: none | targeted | deep
Questions researched:
- <question, or why no external context was needed>
Sources:
- <title + URL + source type, or none>
Constraints discovered:
- <constraint and how the work accounts for it, or none>
Context gaps:
- <unverified area or provider skip reason, or none>
Durable writeback:
- <PR, issue, spec, ADR, or runbook updated, or not needed>
```

## Constraints

- Use the repo-local helper; do not call Unblocked MCP directly when the helper is present.
- Do not use Unblocked to answer a question that a known local file answers faster.
- Do not treat search rank, recency, or a summary as proof of causation.
- Do not block routine work solely because Unblocked is unavailable.
- Do not copy sensitive runtime values, credentials, or customer data into queries.

## Default Output

- Context tier and rationale
- Focused questions
- Cited sources
- Constraints and local verification
- Explicit gaps
- Durable writeback target

## Failure Mode

Do not search for broad terms such as `auth` and paste a list of results into a handoff.
Ask a decision-shaped question, expand the most relevant primary sources, and state what
the evidence changes about the implementation or review.

## Validation Prompts

1. "Rename this private test helper without changing behavior." Pass: `none`, with a brief
   reason and no Unblocked call.
2. "Plan tenant-scoped enrollment across the API and worker repos." Pass: `deep`, broad
   research plus focused source expansion and a context receipt.
3. "A user reports that microphone permission regressed after the last deploy." Pass:
   `targeted` during triage; escalate to `deep` only if root cause remains unclear.
