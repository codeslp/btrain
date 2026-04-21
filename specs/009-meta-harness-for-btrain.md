# Spec: Meta-Harness Optimization for btrain

**Status**: Draft
**Version**: 0.2.0
**Author**: btrain
**Date**: 2026-04-19

## Summary

`btrain` should treat its orchestration and context machinery as a harness that can be measured, tuned, and eventually optimized automatically.

This spec introduces four concrete capabilities:

1. explicit, configurable local harness surfaces
2. compact bootstrap context and repo-startup flow for the first agent turn
3. artifact-backed local traces, evals, and comparison for orchestration behavior
4. repo-local capability and task/artifact structures that improve communication, memory, context loading, and monitoring

The first implementation slice is intentionally local-first and useful-now. It should improve `btrain`'s token efficiency and coordination behavior without introducing hosted observability, external protocol dependencies, or autonomous search as required parts of normal use.

It should also make the harness easier to discover, inspect, and extend by introducing a canonical local registry, layout, and authoring contract instead of scattering harness behavior across implicit code paths.

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

This spec is informed by external harness-engineering guidance plus adjacent agent-system ideas:

- Meta-Harness argues that harness code should be optimized end to end, using full source, scores, and raw execution traces from prior candidates rather than aggressively compressed summaries.
- OpenAI eval and tracing guidance emphasizes end-to-end evaluation, executable or pass/fail scoring where possible, and rich metadata on traces so failures are diagnosable instead of merely averaged.
- A2A contributes useful ideas for compact capability discovery, task-centered outputs, and explicit acknowledgement semantics without requiring first-version protocol adoption.
- LangGraph contributes useful ideas for explicit state transitions, interrupts, and resumable workflow structure without requiring a rewrite around its runtime.

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
- Make agent communication, memory, context loading, and monitoring more token-efficient.
- Add compact repo-local capability and task/artifact structures that reduce repeated prompt explanation.
- Make harness discovery, inspection, and authoring more explicit through a local registry, canonical layout, and probe-first commands.
- Reduce wasted first-turn exploration with compact bootstrap context.
- Capture enough trace data to explain why a harness variant helped or failed.
- Add a repeatable benchmark for orchestration quality, not just model quality.
- Support local comparison of harness profiles before any automated search work.
- Support valid non-diff work such as research, investigation, and coordination tasks.
- Improve adoption when agents or users forget to start from `btrain`.

## Non-Goals

- Free-form autonomous code mutation anywhere in the repository.
- Replacing `btrain` as the workflow authority.
- Making LangSmith or any hosted observability backend a required dependency for first-version traces or evals.
- Implementing full A2A compatibility in the first version.
- Rewriting `btrain` orchestration around LangGraph or any other external runtime.
- Building a public harness marketplace or separate package ecosystem in the first version.
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

### Session 2026-04-19

- Q: Should the immediate implementation focus on repo-local features that help `btrain` now? -> A: Yes. Prioritize local capability manifests, task/artifact envelopes, startup/bootstrap context, delivery acknowledgements, and file-backed traces/evals/comparison.
- Q: Should LangSmith be part of the first implementation slice? -> A: No. Keep traces and evals local-first. LangSmith is an optional, later exporter or mirror once local artifacts already exist.
- Q: Should A2A or LangGraph become first-version runtime dependencies? -> A: No. Borrow their ideas, but keep the implementation repo-local and file-backed.
- Q: Should the harness adopt a CLI-Anything-style registry and authoring structure? -> A: Yes, but only locally: add a canonical registry, self-describing profiles, authoring docs, probe-first inspection commands, and benchmark fixture manifests without adopting a public hub or per-harness packaging model.

## Feature 1: Explicit Harness Surfaces

`btrain` should make the main prompt and orchestration surfaces explicit so they can be inspected, compared, and evolved deliberately.

### First-Version Surfaces

- local harness registry and canonical harness layout metadata
- loop dispatch prompt construction
- local agent capability card schema and routing-relevant metadata
- task/artifact envelope schema for lane work, review work, repairs, and diffless evidence
- self-describing harness profile metadata and inspection output
- lane-context injection
- startup/init prompt construction for a newly started agent
- bootstrap snapshot formatting
- review-router configuration
- review prompt templates
- completion and “done” guidance used by the loop
- delegation transport, acknowledgement, and retry policy
- benchmark fixture manifest definitions

### First-Version Decisions

- Treat these surfaces as versioned harness inputs, not scattered hidden strings.
- Keep harness surfaces local to `btrain`; they should not modify user repo code.
- Treat local capability cards and task/artifact envelopes as repo-local structures first, not as a promise of A2A wire compatibility.
- Keep a canonical local harness registry so humans and agents can discover available profiles, schemas, fixture sets, and supported commands without re-reading implementation details.
- Keep a canonical local harness authoring guide so adding or modifying a harness surface follows one documented structure.
- Allow named harness profiles so multiple variants can be compared on the same benchmark.
- Keep the default profile stable and human-readable.
- Capture the current inline behavior as a `default` profile before introducing alternative profiles, so candidate comparison starts from a stable baseline.
- Favor probe-first commands such as list and inspect before mutation-oriented commands so agents can orient themselves cheaply.

### Preferred Local Harness Structure

The first version should converge on a canonical local structure for harness assets and metadata. Exact paths may evolve, but the system should have stable homes for:

- registry metadata
- profile definitions
- shared schemas
- shared templates
- benchmark fixture manifests
- trace and candidate artifacts
- authoring guidance

The structure should optimize for discoverability, inspection, and local editing, not for external package publishing.

### Functional Requirements

#### FR-1: Named harness profiles

`btrain` must support a named harness profile that identifies the active prompt, context, and review configuration used for a run.

#### FR-2: Explicit profile loading

The loop, wrapper, and review runner must load their harness behavior from explicit configuration or template files instead of only inline string constants.

#### FR-3: Local agent capability cards

`btrain` and `agentchattr` must support a compact repo-local capability manifest for each registered agent instance, including enough metadata to improve deterministic routing and reduce repeated prompt explanation.

#### FR-4: Task and artifact envelope

The first version must define a compact task/artifact envelope that lets lane work, reviews, repairs, delegated wakeups, and diffless outputs point at durable artifacts instead of relying on raw chat history alone.

#### FR-5: Run metadata

Each trace and eval result must record the active harness profile, candidate id, and relevant model/runner metadata.

## Feature 2: Compact Bootstrap Context and Startup Flow

`btrain` should inject a compact startup snapshot that saves early exploration turns without flooding the model with irrelevant state.

This includes both:

- first-turn context on dispatch
- an explicit repo-startup/init command for a newly launched agent

### Intended Snapshot Content

- repo root and current working directory
- lane id, task, owner, reviewer, and file locks
- agent capability card summary when relevant to routing or startup
- delegation packet summary when present
- task and artifact references when they are more compact than replaying history
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
- Bootstrap context should prefer stable summaries and artifact references over replaying long logs or chat history.
- Bootstrap generation should degrade gracefully when repo-specific docs are missing or stale; it should fall back to currently present repo-local guidance instead of failing hard.

### Functional Requirements

#### FR-6: Startup/init command

`btrain` must support an explicit repo-startup/init command that gives a newly started agent the compact workflow packet before any delegated work begins.

#### FR-7: First-turn injection

Agent dispatch must support a first-turn bootstrap block that is injected automatically when the active harness profile enables it.

#### FR-8: Bounded size

Bootstrap generation must enforce clear size limits and truncation rules so it does not become a hidden context bomb.

#### FR-9: Deterministic generation

Given the same repo state, lane state, and profile, bootstrap output should be stable enough to compare across runs.

## Feature 3: Harness Traces

`btrain` should persist artifact-backed traces for harness runs so candidate evaluation is grounded in evidence.

### Trace Contents

- active harness profile and candidate metadata
- agent capability card snapshot when relevant
- injected bootstrap and lane-context text
- dispatch events and timing
- task and artifact references used during the run
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

Hosted observability backends are also out of scope for the initial design. The first version should assume local files are the source of truth for traces and eval artifacts.

A representative first-version layout should look roughly like:

```text
.btrain/harness/
├── registry.json
├── profiles/
│   └── default/
├── schemas/
├── templates/
├── benchmarks/
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

#### FR-10: Durable trace bundle

Each harness eval run must write a durable trace bundle with both summary metadata and raw supporting artifacts.

#### FR-11: Comparable summaries

`btrain` must produce a compact summary view across runs so candidates can be compared without opening every raw artifact.

#### FR-12: Failure taxonomy

Trace summaries must classify failures in a stable way, such as timeout, review miss, routing error, workflow violation, or insufficient context.

## Feature 4: Harness Benchmark, Evals, and Comparison

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

#### FR-13: Local eval command

`btrain` must provide a local eval entrypoint for running benchmark scenarios against one or more harness profiles.

#### FR-14: Held-out scenarios

The benchmark must support held-out scenarios so harness changes are not judged only on the cases used to design them.

#### FR-15: Per-scenario and aggregate results

Eval output must report both aggregate scores and item-level results with links back to trace bundles.

#### FR-16: Diffless evidence path

The benchmark and trace model must support scenarios whose completion proof is an artifact bundle, summary, or command output rather than a source diff.

#### FR-17: Delegation acknowledgement

Delegation-related scenarios must record whether the target agent was actually notified and whether that notification was acknowledged.

#### FR-18: Local comparison command

`btrain` must provide a local comparison view or command that compares two or more harness profiles using benchmark results and trace summaries without requiring any external observability service.

## Feature 5: Constrained Harness Search

After local traces, evals, and comparison exist and prove useful, `btrain` should support constrained outer-loop search over harness profiles.

### Search Model

The proposer reads:

- current harness source or templates
- prior candidate scores
- trace summaries
- raw trace artifacts when needed

It then proposes a new candidate by editing only allowlisted harness surfaces.

### First-Version Decisions

- Search is offline and explicit, not always-on.
- Search is a follow-on capability, not part of the immediate local-first milestone.
- Candidate writes are limited to harness config and template surfaces.
- Promotion to the default harness remains human-controlled.
- Search must compare against a stable baseline on the benchmark before promotion.

### Functional Requirements

#### FR-19: Allowlisted mutation scope

Search must only edit approved harness files or config surfaces.

#### FR-20: Candidate lineage

Each candidate must record parent candidate, changed files, benchmark score, and trace references.

#### FR-21: Human-gated promotion

No candidate becomes the default harness without an explicit promotion action.

## Deferred External Integrations

The following are explicitly deferred beyond the local-first milestone:

- optional LangSmith export or mirroring for traces and experiment results
- optional A2A-compatible edge adapters for remote interoperability
- any hosted, centralized trace or eval service becoming the required source of truth

These may become useful later, but the first version should assume the local file-backed harness artifacts are complete enough to stand on their own.

## Preferred Local-First CLI Surface

The immediate local-first command surface should include:

- `btrain harness list --repo <path>`
- `btrain harness inspect --repo <path> --profile <name>`
- `btrain startup --repo <path> [--agent <name>] [--profile <name>]`
- `btrain harness eval --repo <path> --profile <name>...`
- `btrain harness compare --repo <path> --baseline <name> --candidate <name>`

If the deferred local search phase is later implemented, then add:

- `btrain harness promote --repo <path> --candidate <id>`
- `btrain harness rollback --repo <path> [--to <profile-or-candidate>]`

Exact flag names may evolve, but the immediate surface should stay local, explicit, and readable enough for humans to operate without extra wrapper tooling.

## Rollout Plan

### Phase 1

- define explicit harness surfaces
- add a canonical local harness registry
- add a canonical harness authoring guide
- add local agent capability cards and task/artifact envelopes
- add compact bootstrap context
- add the explicit startup/init path
- add probe-first harness list and inspect commands

### Phase 2

- make delegated wakeups acknowledgeable and traceable
- store local trace bundles for benchmark runs
- add manifest-backed benchmark fixtures
- add the local benchmark and score summaries
- compare named harness profiles on held-out scenarios

### Phase 3 (Deferred but still local)

- add constrained outer-loop search
- support human review and promotion of winning candidates

### Phase 4

- deferred external integrations:
- add optional LangSmith export or mirroring
- add optional A2A edge interoperability where justified

## Review Focus

Review this spec for:

- whether the local capability and task/artifact structures are compact enough to help token efficiency
- whether the registry, layout, and authoring contract are the right amount of structure without turning into a hub/marketplace project
- whether the harness surfaces are the right first allowlist
- whether the bootstrap snapshot is informative without becoming noisy
- whether the trace bundle is rich enough for diagnosis
- whether the benchmark categories reflect real `btrain` outcomes
- whether the search constraints are strict enough for a deferred follow-on
- whether LangSmith and other external integrations are deferred cleanly enough
