# A2A, LangGraph, and LangSmith Evaluation for btrain

**Date**: 2026-04-19
**Status**: Research / recommendation
**Scope**: Evaluate what `btrain` and `agentchattr` should adopt from A2A, LangGraph, and LangSmith without replacing `btrain` as the workflow authority.
**Sources**: [A2A Protocol](https://a2a-protocol.org/latest/) | [A2A v1.0 release](https://github.com/a2aproject/A2A/releases/tag/v1.0.0) | [A2A v1.0 announcement](https://a2a-protocol.org/latest/announcing-1.0/) | [LangChain overview](https://docs.langchain.com/oss/python/langchain/overview) | [LangChain multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent) | [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) | [LangSmith tracing quickstart](https://docs.langchain.com/langsmith/observability-quickstart) | [LangSmith evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts) | [docs/architecture.md](/Users/bfaris96/btrain/docs/architecture.md) | [specs/009-meta-harness-for-btrain.md](/Users/bfaris96/btrain/specs/009-meta-harness-for-btrain.md)

## Bottom Line

`btrain` should not be replaced by A2A, LangGraph, or LangSmith.

Those systems solve adjacent problems:

- **A2A** solves agent-to-agent interoperability across systems and vendors.
- **LangGraph** solves programmable orchestration for long-running, stateful agent workflows.
- **LangSmith** solves tracing, evaluation, and observability.
- **btrain** solves repo-local workflow governance: lanes, file locks, review gates, repair routing, and handoff integrity.

The right move is to steal selective ideas:

1. take A2A's task, capability, and async-delivery ideas
2. take LangGraph's explicit state-machine discipline as a design influence
3. take LangSmith's trace/eval model as a likely observability target
4. keep `btrain` as the authority for lane state and workflow rules

## What A2A Gets Right

As of **2026-03-12**, A2A `v1.0.0` is the current stable release. It is strongest where `btrain` is intentionally narrow:

- **Capability discovery** via Agent Cards
- **Task-centered interaction** instead of ad hoc prompts and mentions
- **Async task lifecycle** with get/list/cancel/subscribe patterns
- **Streaming and push delivery** instead of pure polling
- **Explicit auth and trust-boundary vocabulary** for cross-service communication
- **Artifacts as first-class outputs** rather than chat text being the only durable result

That is useful, but it does not replace repo-local workflow governance. A2A does not give `btrain`'s lane discipline, file-lock intent, handoff packet validation, or review gating.

## What To Steal From A2A Now

### 1. Local Agent Cards

Add a compact repo-local capability document for each registered agent instance.

Useful fields:

- agent id / display name
- provider and runtime
- repo path
- lane affinity or current lane
- skills or roles
- supported actions
- transport endpoints
- auth mode
- availability / readiness

This would improve routing in `agentchattr` and make instance behavior more explicit than pure name-based matching.

### 2. Task and Artifact Model

Model more of the system around explicit task objects rather than only chat messages plus handoff files.

Good candidates:

- lane work items
- review requests
- repair-needed incidents
- research tasks
- harness eval runs
- notification delivery attempts

Each task should be able to point at durable artifacts:

- handoff summaries
- changed-file lists
- verification output
- review findings
- trace bundles
- rendered reports

This fits the direction already described in [specs/009-meta-harness-for-btrain.md](/Users/bfaris96/btrain/specs/009-meta-harness-for-btrain.md).

### 3. Subscription and Push Semantics

`agentchattr` currently uses polling for part of the `btrain` integration. A2A's subscribe/push model is worth copying conceptually.

Near-term improvement:

- keep local WebSocket fanout in `agentchattr`
- add a clearer event stream from `btrain`
- reduce dependence on periodic polling where event-driven delivery is possible
- treat delivery acknowledgement as a first-class traceable event

### 4. Trust Boundary Vocabulary

If `agentchattr` ever moves beyond localhost or single-operator use, A2A's explicit auth and discovery model becomes relevant.

Near-term, this only needs lightweight adoption:

- declare which endpoints are local-only
- separate trusted local wrappers from remote integrations
- make remote-agent support an explicit mode, not an accidental side effect

## What Not To Steal Yet

Do not adopt the full A2A surface area inside `btrain` right now.

Defer:

- full protocol compatibility as a core requirement
- multi-binding support (`JSON-RPC`, gRPC, REST)
- signed public cards and extended-card flows
- broad OAuth-style integration work
- generic remote-agent abstractions replacing local CLI wrappers

Those are worthwhile only if `btrain` starts orchestrating agents across machines, orgs, or external platforms. Today they would add complexity faster than they add value.

## Where LangGraph Fits

LangGraph is relevant, but mostly as an architectural reference unless `btrain` grows a much larger orchestrator runtime.

What is attractive:

- explicit state graphs
- durable execution
- interrupts / human-in-the-loop checkpoints
- resumable long-running workflows
- subgraphs for reusable workflow fragments

Those ideas map well to:

- `changes-requested` loops
- `repair-needed` recovery
- harness evaluation runs
- startup/bootstrap flows
- notification retry logic

What does **not** follow from that: `btrain` should be rewritten in LangGraph now.

Current recommendation:

- keep the core lane state machine in `src/brain_train/core.mjs`
- continue expressing workflow rules directly in repo code
- borrow LangGraph-style design constraints when adding new orchestration surfaces
- revisit a deeper LangGraph integration only if the current implementation becomes difficult to evolve or if orchestration logic expands well beyond the current CLI/state model

## Where LangSmith Fits

LangSmith is the most immediately useful external idea in this set.

The repo already has the right instinct in [specs/009-meta-harness-for-btrain.md](/Users/bfaris96/btrain/specs/009-meta-harness-for-btrain.md): make harness behavior measurable with traces, artifacts, and evals.

LangSmith's strongest ideas for `btrain` are:

- end-to-end traces
- nested spans for tool calls and workflow steps
- experiment comparison
- offline and online evaluation loops
- explicit datasets and scoring criteria

### High-value trace targets

- `bth` and loop dispatch
- lane-context injection
- review handoff generation
- review resolution or change request paths
- repair routing
- notification delivery and acknowledgement
- cold-start bootstrap behavior
- diffless work outcomes such as research or investigation

### High-value eval targets

- writer flow from claim to review-ready
- reviewer ability to catch seeded defects
- repair flow recovery accuracy
- bootstrap quality on the first turn
- adherence to file-lock and lane constraints
- notification reliability
- token and latency cost per completed task

### Main caution

LangSmith is an observability platform, not a workflow authority. It should not become a second source of truth for lane state.

For `btrain`, the right posture is:

- keep canonical workflow state local and file-backed
- make traces exportable
- support LangSmith as an optional observability backend, not a mandatory dependency

## Proposed Adoption Plan

### Phase 1: Repo-local concepts first

Implement the concepts locally before taking on third-party protocol or platform dependencies.

- define a repo-local Agent Card schema for `agentchattr` instances
- introduce a clearer task/artifact envelope for lane work, reviews, repairs, and harness runs
- document a first-party event stream model for `btrain`

### Phase 2: Local traces and evals

Build the local harness trace model already envisioned by spec 009.

- store traces and artifacts under `.btrain/harness/`
- capture delivery and acknowledgement events
- add simple experiment comparison commands
- keep the file-backed format understandable and diffable

### Phase 3: Optional LangSmith exporter

Once local traces exist, add an optional export or mirror path to LangSmith.

- default remains local-only
- opt-in via env vars and config
- redact or suppress sensitive prompt/code payloads when needed
- use LangSmith for experiment comparison, dashboards, and operational debugging

### Phase 4: Optional A2A edge adapter

If remote agent interoperability becomes important, add an A2A adapter at the edge.

- keep `btrain` authoritative for lane state
- expose selected tasks and artifacts through an adapter layer
- do not make the internal workflow depend on A2A semantics
- treat A2A as an interoperability boundary, not the repo's core workflow engine

## Recommendation

Adopt ideas, not replacements.

- **Steal now**: Agent Cards, task/artifact thinking, async delivery semantics, trace/eval discipline
- **Steal carefully**: LangGraph's state-machine and interrupt model as architecture guidance
- **Defer**: full A2A compliance, full LangGraph migration, mandatory SaaS observability
- **Preserve**: `btrain` as the workflow authority and `agentchattr` as the local coordination surface

The highest-leverage next step is not a protocol migration. It is to make `btrain`'s current orchestration more explicit, traceable, and comparable while keeping the authority model simple.

## References

- [A2A Protocol](https://a2a-protocol.org/latest/)
- [A2A Protocol specification](https://a2a-protocol.org/latest/specification/)
- [A2A v1.0.0 release](https://github.com/a2aproject/A2A/releases/tag/v1.0.0)
- [A2A v1.0 announcement](https://a2a-protocol.org/latest/announcing-1.0/)
- [LangChain overview](https://docs.langchain.com/oss/python/langchain/overview)
- [LangChain multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent)
- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangSmith tracing quickstart](https://docs.langchain.com/langsmith/observability-quickstart)
- [LangSmith evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts)
- [docs/architecture.md](/Users/bfaris96/btrain/docs/architecture.md)
- [specs/009-meta-harness-for-btrain.md](/Users/bfaris96/btrain/specs/009-meta-harness-for-btrain.md)
