---
name: reflect
description: Run a concise, blameless post-failure reflection whenever a bug, bad handoff, deploy incident, misleading test, or spec mistake just happened. Use it to turn the failure into concrete workflow changes plus code, test, spec, or doc safeguards, and update the durable process note when needed.
---

# Reflect

Use this skill after a meaningful failure or regression.

## Goal

Turn a failure into specific prevention steps. Avoid generic retrospective language.

## Workflow

1. List the concrete failure(s) with dates, IDs, commands, files, or routes when available.
2. Separate:
   - symptom
   - root cause
   - detection gap
   - process gap
3. Split the prevention changes into:
   - collaboration / workflow
   - code / tests / specs / docs
4. Prefer the smallest durable prevention:
   - one guardrail
   - one test
   - one spec correction
   - one doc update
   - one workflow rule
5. When the failure looks like recurring workflow drift, scan recent handoff history for placeholder text, protocol violations, or stale/no-op entries before writing conclusions.
6. Before adding a new entry to the process doc, check if the failure pattern already exists. Strengthen the existing entry instead of duplicating it.
7. Keep it blameless, concrete, and short.

## Default Output

- What failed
- Why it escaped
- How we should work differently
- What code/tests/spec/docs should change
- What is still unverified

## Persistent Notes

If the user wants a durable artifact, write or update the repo's process, incident, or contributor notes.

If the failure is highly specific and deserves a preserved snapshot, create a dated note under a repo-local process or incidents directory and keep the canonical summary file updated if the repo already has one.
