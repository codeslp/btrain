---
name: context-scout
description: >
  Classify and gather organizational context through the repo-local Unblocked helper
  before planning, cross-repo work, unfamiliar subsystem changes, feedback deduplication,
  security or migration work, deploy investigations, incidents, and decisions that depend
  on prior intent. Optionally use an existing local zvec-grep index for one focused semantic
  discovery probe when wording or location is unknown. Produce a standard context receipt
  for btrain. Skip external context when local evidence fully answers a narrow question.
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
2. Route local workspace discovery before organizational research:
   - Use native `rg` for identifiers, paths, quotations, configuration keys, regular
     expressions, and exhaustive occurrence checks.
   - When the wording or location is unknown, run at most one focused semantic probe if
     `.claude/scripts/zvec-context.sh` and an explicitly created zvec-grep index are available:
     `.claude/scripts/zvec-context.sh search "<complete question>" --root "$PWD" --limit 5`.
   - Add `--glob` scopes when the question names a subsystem. Do not use a broad workspace
     query when a narrower one can answer the question.
   - Add `--freshness strict` for review, security, migration, and formal-verification work.
     The default `eventual` policy is only for low-risk orientation.
   - A missing CLI or index is a soft skip. Continue with `rg` and local reads. Never install
     zvec-grep, create or rebuild an index, start its daemon, or grant remote access for the user.
   - Treat ranked passages as discovery leads. Verify decisive claims against exact source.
3. Write one complete organizational question per unknown. Include task IDs, paths, routes, dates, or
   component names. Do not submit keyword-only searches.
4. Use `.claude/scripts/unblocked-context.sh`:
   - `targeted`: run one source-specific search or `research ... --effort low --limit 5`.
   - `deep`: run `research ... --effort high --limit 5`, mine identifiers from the result,
     then expand only the strongest sources with a focused search or `get-urls`.
   - When the repository's `owner/repo` slug is known, use
     `get-rules <owner/repo> --task code-generation --paths <path>` for conventions scoped
     to changed files.
5. Verify decisive claims against the local checkout or another primary artifact. Unblocked
   code reflects the indexed/default branch and may not match the current lane.
6. Emit the receipt below. Cite useful zvec-grep paths as local sources. When either helper
   skips, keep working if safe and record the reason as a context gap only when that source
   was needed. Provider availability is a soft gate.
7. For btrain work:
   - Use `btrain handoff claim --unblocked-context` for `targeted` and `deep` lanes.
   - Put the compact receipt in the handoff pre-flight/why context, use `--gap` for missing
     context, and turn constraints into specific `--review-ask` bullets.
   - Reviewers may run `btrain review context --lane <id>` when the receipt is missing,
     stale, or insufficient for the risk.
8. If research establishes a durable decision, write it back to an indexed source such as
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
- Do not use zvec-grep when exact or exhaustive native search is sufficient.
- Do not make zvec-grep, its index, its daemon, or an Embedding provider a required btrain dependency.
- Do not silently accept stale indexed evidence for high-risk work.
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
