# Spec: Agent Orchestration Foundations

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-04-14

## Summary

`btrain` should add a thin orchestration layer that makes delegated work more explicit, auditable, and measurable without turning the workflow into a second agent runtime.

This spec adds three improvements that are clear wins across shared-worktree and future worktree-backed lane modes:

1. structured delegation packets
2. artifact-backed lane memory
3. tracing and evals for orchestration behavior

The first implementation slice in this spec is **structured delegation packets**.

## Why This Exists

`btrain` already enforces lane status, file locks, peer review, and workflow integrity. What it does not yet make explicit is the contract between the orchestrator and the worker:

- what exactly the lane is trying to achieve
- what output shape is expected
- what constraints apply
- what “done” means
- how much effort is warranted before escalating or re-scoping

Without that contract, multi-agent orchestration drifts toward vague tasks, duplicated work, and hard-to-review partial handoffs.

## External Guidance

This spec is informed by recent agent orchestration guidance:

- Anthropic emphasizes simple workflows first, explicit delegation contracts, artifact-based work products, and bounded effort.
- OpenAI emphasizes eval-driven architecture, tracing, safety boundaries, and one clear owner for the final response.

These ideas fit `btrain` well because `btrain` already has a workflow authority, lane lifecycle, and durable local state.

## Goals

- Make delegated lane work explicit and machine-readable.
- Preserve `btrain` as the workflow authority.
- Keep orchestration state local, auditable, and cheap to inspect.
- Improve recovery and review quality without forcing a full worktree-only model.
- Create measurable signals so `btrain` can prove orchestration changes help.

## Non-Goals

- Replacing `btrain` status transitions with an LLM-driven planner.
- Making multi-agent orchestration mandatory for all repos or all tasks.
- Requiring git worktrees for the first version.
- Shipping a full autonomous planner before the lane contract is explicit.

## Clarifications

### Session 2026-04-14

- Q: Should these changes assume lane-to-worktree mapping now? -> A: No. They should work in the current shared-worktree model and remain compatible with an optional worktree mode later.
- Q: Should structured delegation reuse the reviewer-context section? -> A: No. Delegation and peer-review context are different concerns and should have separate sections.
- Q: Should the first slice be mandatory for `needs-review`? -> A: Not yet. First add the contract and surface it through the CLI and status APIs; enforcement can follow once usage stabilizes.
- Q: Where should long-lived lane context live? -> A: In artifact references and cold storage, not only in repeated prose summaries.
- Q: How should orchestration quality be judged? -> A: With traces and evals, not intuition alone.

## Feature 1: Structured Delegation Packets

Each active lane should carry a machine-readable delegation packet with these fields:

- `Objective`
- `Deliverable`
- `Constraints`
- `Acceptance checks`
- `Budget`
- `Done when`

The packet is the contract for the current lane. It should be readable by humans in the handoff markdown and by machines in `btrain status --json`.

### First-Version Decisions

- Add the packet as a dedicated `## Delegation Packet` section in each handoff.
- Expose it through `btrain handoff claim`, `btrain handoff update`, and `btrain status --json`.
- Seed the packet with useful defaults on claim so a fresh lane is never blank.
- Keep the packet optional for transition validation in the first slice.
- Treat packet edits as lane metadata changes, not review-response changes.

### Functional Requirements

#### FR-1: Packet storage

Each lane handoff file must support a dedicated `## Delegation Packet` section with structured headings for the six fields above.

#### FR-2: CLI write path

`btrain handoff claim` and `btrain handoff update` must accept flags for each packet field.

#### FR-3: JSON visibility

`btrain status --json` must expose the packet in a stable nested structure so orchestrators, dashboards, and future guards can consume it.

#### FR-4: Default packet on claim

Lane claim should initialize a usable packet even when explicit packet flags are omitted.

#### FR-5: Backward compatibility

Existing review-context validation and handoff flows must keep working when no explicit packet fields are supplied.

## Feature 2: Artifact-Backed Lane Memory

Large lane outputs should not live only as repeated summaries in handoff prose. `btrain` should add artifact references so a lane can point to durable outputs such as:

- design notes
- test reports
- generated diffs or patch summaries
- review bundles
- investigation logs

### Requirements

- Lane memory should reference artifacts by stable path or URI-like local identifier.
- Artifact references should be cheap to include in active context and detailed enough to reopen later.
- Cold artifacts should stay outside the “hot” handoff summary by default.

### Likely follow-on work

- per-lane artifact directory under `.btrain/`
- artifact summary fields in handoff state
- retention and cleanup rules

## Feature 3: Tracing and Evals

`btrain` should measure orchestration quality directly instead of relying on anecdotal operator feedback.

### Requirements

- Trace claim, update, review, resolve, overrides, and packet changes as first-class workflow events.
- Add eval fixtures for delegation quality and routing quality.
- Measure whether packet completeness correlates with fewer review loops, fewer stale lanes, and better reviewer focus.

### Candidate eval dimensions

- missing or weak packet fields
- task duplication across lanes
- review asks that do not match the claimed objective
- lanes that churn without meeting the declared `Done when`
- override frequency after weak delegation packets

## Rollout Plan

### Phase 1

- ship structured delegation packets
- document the new CLI flags and packet format
- expose packet data in status JSON
- add regression coverage

### Phase 2

- add artifact references and lane-memory helpers
- add compact artifact summaries to active lane state

### Phase 3

- add orchestration traces and eval harnesses
- use eval results to decide whether packet fields should become stricter or required

## Review Focus

Review this spec for:

- whether the packet fields are the right minimum contract
- whether packet defaults are useful or too noisy
- whether artifact memory needs a stronger storage contract up front
- whether the tracing/eval plan is concrete enough to guide follow-on work
