# Spec: Meta-Harness Optimization for btrain

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-04-15

## Summary

`btrain` should treat its orchestration and context machinery as a harness that can be measured, tuned, and eventually optimized automatically.

This spec introduces four concrete capabilities:

1. explicit, configurable harness surfaces
2. compact bootstrap context for the first agent turn
3. artifact-backed harness traces and evals
4. constrained outer-loop search over approved harness surfaces

The first implementation slice is not full autonomous search. It is the plumbing that makes harness engineering measurable and safe.

## Why This Exists

`btrain` already changes agent behavior through code, not just through model choice:

- lane-context injection in `agentchattr`
- `bth` dispatch and delegation-packet formatting
- review routing and review prompts
- workflow guidance and completion framing
- notification and re-entry behavior

Those choices are part of the system harness. Today they are mostly tuned by hand. That means:

- useful improvements are easy to miss
- regressions are hard to localize
- prompt and context changes are hard to compare fairly
- “better” often means anecdotal instead of measured

Recent harness-engineering work shows that simple harness changes can create real gains when optimization is grounded in full execution traces rather than only summaries or scalar scores. `btrain` already has the workflow state needed to benefit from that approach if it adds the right trace and eval surfaces.

## External Guidance

This spec is informed by two sources of external guidance:

- Meta-Harness argues that harness code should be optimized end to end, using full source, scores, and raw execution traces from prior candidates rather than aggressively compressed summaries.
- OpenAI eval and tracing guidance emphasizes end-to-end evaluation, executable or pass/fail scoring where possible, and rich metadata on traces so failures are diagnosable instead of merely averaged.

These ideas fit `btrain` well because `btrain` already has:

- explicit workflow state
- deterministic lane transitions
- durable handoff artifacts
- a review surface
- compact places to inject context without changing model weights

## Repo-Local Grounding

The first implementation slice should anchor itself to seams that already exist in this checkout:

- `src/brain_train/core.mjs` already owns loop dispatch, delegation packets, review mode, handoff state, and lock-aware workflow guidance.
- `src/brain_train/cli.mjs` already defines the human-facing CLI surface and is the natural home for startup/eval/compare commands.
- `agentchattr/wrapper.py` and `agentchattr/btrain/context.py` already inject lane context into launched agents.
- `agentchattr/btrain/notifications.py` plus the btrain poller described in `docs/architecture.md` already provide notification and delivery surfaces that can be traced.
- `README.md`, `docs/architecture.md`, and `research/implementation_plan.md` are the repo-local guidance documents currently present for bootstrap and startup work in this checkout.

## Goals

- Make the main `btrain` harness surfaces explicit and configurable.
- Reduce wasted first-turn exploration with compact bootstrap context.
- Capture enough trace data to explain why a harness variant helped or failed.
- Add a repeatable benchmark for orchestration quality, not just model quality.
- Enable constrained automated search over approved harness surfaces.
- Support valid non-diff work such as research, investigation, and coordination tasks.
- Improve adoption when agents or users forget to start from `btrain`.

## Non-Goals

- Free-form autonomous code mutation anywhere in the repository.
- Replacing `btrain` as the workflow authority.
- Optimizing only for token count while ignoring task success or review quality.
- Making harness search mandatory for normal repo use.
- Training or fine-tuning models.
- Assuming all workflow gates can be made perfect up front.

## Clarifications

### Session 2026-04-15

- Q: Should the first version include automated search immediately? -> A: No. First make the harness measurable through explicit surfaces, traces, and evals.
- Q: Should search be allowed to edit arbitrary repo files? -> A: No. Search is restricted to allowlisted harness surfaces and template/config files.
- Q: What should count as “better”? -> A: End-to-end workflow outcomes first, then efficiency metrics such as turns, tokens, and latency.
- Q: Should traces store only summaries? -> A: No. They should store compact summaries plus raw artifacts needed for diagnosis.
- Q: Does this replace manual harness tuning? -> A: No. Manual tuning remains possible; this work makes it measurable and auditable.
- Q: Does this need a DB for performance data? -> A: No. Use file-backed artifacts and indexes first; revisit only if scale or query complexity proves it necessary.
- Q: Can the benchmark assume all valid work ends in a code diff? -> A: No. Research, investigations, and coordination work need artifact-based evidence paths.
- Q: Can scoring assume every gate is perfectly articulated? -> A: No. Use hard gates for a small core, plus soft signals, exception paths, and human overrides.
- Q: What if delegation transport is unreliable? -> A: Treat wakeup delivery and acknowledgement as part of the harness and trace it explicitly.
- Q: What if agents or users forget to use `btrain`? -> A: Add a startup/init path and first-touch nudges so correct behavior is easier than skipping it.

## Feature 1: Explicit Harness Surfaces

`btrain` should make the main prompt and orchestration surfaces explicit so they can be inspected, compared, and evolved deliberately.

### First-Version Surfaces

- loop dispatch prompt construction
- lane-context injection
- startup/init prompt construction for a newly started agent
- bootstrap snapshot formatting
- review-router configuration
- review prompt templates
- completion and “done” guidance used by the loop
- delegation transport, acknowledgement, and retry policy

### First-Version Decisions

- Treat these surfaces as versioned harness inputs, not scattered hidden strings.
- Keep harness surfaces local to `btrain`; they should not modify user repo code.
- Allow named harness profiles so multiple variants can be compared on the same benchmark.
- Keep the default profile stable and human-readable.
- Capture the current inline behavior as a `default` profile before introducing alternative profiles, so candidate comparison starts from a stable baseline.

### Functional Requirements

#### FR-1: Named harness profiles

`btrain` must support a named harness profile that identifies the active prompt, context, and review configuration used for a run.

#### FR-2: Explicit profile loading

The loop, wrapper, and review runner must load their harness behavior from explicit configuration or template files instead of only inline string constants.

#### FR-3: Run metadata

Each trace and eval result must record the active harness profile, candidate id, and relevant model/runner metadata.

## Feature 2: Compact Bootstrap Context and Startup Flow

`btrain` should inject a compact startup snapshot that saves early exploration turns without flooding the model with irrelevant state.

This includes both:

- first-turn context on dispatch
- an explicit repo-startup/init command for a newly launched agent

### Intended Snapshot Content

- repo root and current working directory
- lane id, task, owner, reviewer, and file locks
- delegation packet summary when present
- repo-specific workflow instructions and “what to do first”
- current branch or commit and dirty-file summary
- top-level repo listing or selected workspace hints
- likely test or verification commands when discoverable

### First-Version Decisions

- Bootstrap context is first-turn only by default during normal dispatch.
- `btrain` should also expose an explicit startup/init command that prints the compact repo packet on demand.
- The snapshot must be bounded and deterministic.
- The snapshot should prefer summaries over full file contents.
- Large directories, raw diffs, and sensitive values must be excluded or redacted.
- Bootstrap generation should degrade gracefully when repo-specific docs are missing or stale; it should fall back to currently present repo-local guidance instead of failing hard.

### Functional Requirements

#### FR-4: Startup/init command

`btrain` must support an explicit repo-startup/init command that gives a newly started agent the compact workflow packet before any delegated work begins.

#### FR-5: First-turn injection

Agent dispatch must support a first-turn bootstrap block that is injected automatically when the active harness profile enables it.

#### FR-6: Bounded size

Bootstrap generation must enforce clear size limits and truncation rules so it does not become a hidden context bomb.

#### FR-7: Deterministic generation

Given the same repo state, lane state, and profile, bootstrap output should be stable enough to compare across runs.

## Feature 3: Harness Traces

`btrain` should persist artifact-backed traces for harness runs so candidate evaluation is grounded in evidence.

### Trace Contents

- active harness profile and candidate metadata
- injected bootstrap and lane-context text
- dispatch events and timing
- command history or key workflow actions
- handoff transitions and reviewer outcomes
- review artifacts
- token, latency, and completion metrics when available
- final score summary and failure classification
- delegation wakeup and acknowledgement events
- explicit evidence references for diffless work

### Storage Model

Trace bundles should live under `.btrain/harness/` in a structure that separates:

- run index metadata
- compact summary records
- raw artifacts such as prompts, reports, and event logs

The first version is explicitly file-backed:

- append-only JSONL or JSON summary indexes
- per-run directories for raw artifacts
- candidate metadata stored as local files

A database is out of scope for the initial design.

A representative first-version layout should look roughly like:

```text
.btrain/harness/
├── profiles/
│   └── default/
├── candidates/
│   └── cand_<id>.json
├── index.jsonl
└── runs/
    └── <run-id>/
        ├── summary.json
        ├── prompts/
        ├── events/
        └── artifacts/
```

### Functional Requirements

#### FR-8: Durable trace bundle

Each harness eval run must write a durable trace bundle with both summary metadata and raw supporting artifacts.

#### FR-9: Comparable summaries

`btrain` must produce a compact summary view across runs so candidates can be compared without opening every raw artifact.

#### FR-10: Failure taxonomy

Trace summaries must classify failures in a stable way, such as timeout, review miss, routing error, workflow violation, or insufficient context.

## Feature 4: Harness Benchmark and Evals

`btrain` should evaluate harnesses with repeatable scenarios that measure actual workflow performance.

### Benchmark Categories

- writer flow: claim to review-ready with correct lane discipline
- reviewer flow: identify seeded defects and request changes correctly
- repair flow: recover from stale or contradictory state
- delegation flow: follow delegation packet and respect file locks
- efficiency flow: avoid redundant exploration when bootstrap context is sufficient
- diffless flow: complete research or investigative work with artifact-based proof instead of a code diff
- adoption flow: recover when an agent starts cold or skips `btrain` initially
- delegation-delivery flow: delegated work actually wakes the target agent and yields a visible acknowledgement

### Scoring Model

The benchmark must not pretend every workflow rule is perfectly articulated.

Use three classes of signals:

- hard gates: violations that always fail the scenario, such as lock/scope violations or invalid destructive behavior
- primary outcome metrics: task success, reviewer correctness, routing correctness, and successful recovery
- advisory metrics: turns, tokens, duration, reminder count, and other efficiency signals

Live dynamic repo work should use observational metrics and human review, not direct optimization targets.

### First-Version Metrics

- task success or pass/fail
- review finding precision and recall on seeded cases
- number of handoff loops
- number of turns and major tool actions
- token or context footprint where available
- wall-clock duration
- reminder/recovery rate when `btrain` was initially skipped
- acknowledgement success rate for delegated wakeups
- artifact-evidence completeness for diffless tasks

### Functional Requirements

#### FR-11: Local eval command

`btrain` must provide a local eval entrypoint for running benchmark scenarios against one or more harness profiles.

#### FR-12: Held-out scenarios

The benchmark must support held-out scenarios so harness changes are not judged only on the cases used to design them.

#### FR-13: Per-scenario and aggregate results

Eval output must report both aggregate scores and item-level results with links back to trace bundles.

#### FR-14: Diffless evidence path

The benchmark and trace model must support scenarios whose completion proof is an artifact bundle, summary, or command output rather than a source diff.

#### FR-15: Delegation acknowledgement

Delegation-related scenarios must record whether the target agent was actually notified and whether that notification was acknowledged.

## Feature 5: Constrained Harness Search

After traces and evals exist, `btrain` should support constrained outer-loop search over harness profiles.

### Search Model

The proposer reads:

- current harness source or templates
- prior candidate scores
- trace summaries
- raw trace artifacts when needed

It then proposes a new candidate by editing only allowlisted harness surfaces.

### First-Version Decisions

- Search is offline and explicit, not always-on.
- Candidate writes are limited to harness config and template surfaces.
- Promotion to the default harness remains human-controlled.
- Search must compare against a stable baseline on the benchmark before promotion.

### Functional Requirements

#### FR-16: Allowlisted mutation scope

Search must only edit approved harness files or config surfaces.

#### FR-17: Candidate lineage

Each candidate must record parent candidate, changed files, benchmark score, and trace references.

#### FR-18: Human-gated promotion

No candidate becomes the default harness without an explicit promotion action.

## Preferred First-Version CLI Surface

Preferred first-version command names are:

- `btrain startup --repo <path> [--agent <name>] [--profile <name>]`
- `btrain harness eval --repo <path> --profile <name>...`
- `btrain harness compare --repo <path> --baseline <name> --candidate <name>`
- `btrain harness promote --repo <path> --candidate <id>`
- `btrain harness rollback --repo <path> [--to <profile-or-candidate>]`

Exact flag names may evolve, but the first version should keep this surface local, explicit, and readable enough for humans to operate without extra wrapper tooling.

## Rollout Plan

### Phase 1

- define explicit harness surfaces
- add compact bootstrap context
- store trace bundles for benchmark runs

### Phase 2

- add the local benchmark and score summaries
- compare named harness profiles on held-out scenarios

### Phase 3

- add constrained outer-loop search
- support human review and promotion of winning candidates

## Review Focus

Review this spec for:

- whether the harness surfaces are the right first allowlist
- whether the bootstrap snapshot is informative without becoming noisy
- whether the trace bundle is rich enough for diagnosis
- whether the benchmark categories reflect real `btrain` outcomes
- whether the search constraints are strict enough for a first version
