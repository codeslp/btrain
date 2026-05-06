# Claude Agent SDK & GitHub Actions Integration — Scoping Research

> **Date:** 2026-05-05
> **Status:** Research / Pre-spec scoping
> **Scope:** Identify which Claude Agent SDK and `claude-code-action@v1` capabilities should become btrain features. btrain is meta — it *is* the workflow tool other repos use, so integrations here have leverage that integrations elsewhere don't.

This document is intentionally pre-spec. It frames *what should be spec'd*, not *how to build it*. The companion ai_sales doc (`closr/ai_sales/research/2026-05-05-claude-sdk-and-gha-integrations.md`) carries the platform context — refer to it for SDK and action background.

---

## 1. Decision Summary

Two candidate features fall out of these releases for btrain. They are related but should be spec'd separately because their failure modes and validation paths differ.

1. **`claude-code-action@v1` as a btrain reviewer** — install the action and wire workflows that take over the structural review work (`pre-handoff` skill semantics, locked-files diff check, reviewer-context completeness) when a PR is opened or a lane flips to `needs-review`. Mostly a meta-test of btrain's own review semantics.
2. **Agent-driven btrain in agentchattr** — a long-running agent participant in agentchattr chat that owns part of the btrain operator role: claims lanes, updates status, drives writer ↔ reviewer handoffs based on detected events (push to lane branch, locked file changes, stale `in-progress` lanes). High-leverage but high-risk because it touches the integrity surface btrain itself enforces.

Recommended order: **(1) → (2)**. (1) is bounded (action runs in a sandboxed runner, can only post comments / push to its branch) and validates btrain's review semantics in an automated context. (2) is unbounded — an autonomous agent driving lane state is the most consequential automation in this entire workspace and deserves a separate, careful spec.

---

## 2. Existing Surface in btrain

What already exists that these features extend or interact with:

- **Node.js 18+, zero dependencies** core. Adding `@anthropic-ai/sdk` or wrapping the Agent SDK in btrain's CLI would break the zero-dep promise; if SDK use is needed, it should live in adjacent surfaces (agentchattr, GH Actions runners), not in the CLI itself.
- **Lane status machine**: `idle → in-progress → needs-review → ready-for-pr → pr-review → ready-to-merge → resolved`, plus feedback loops (`changes-requested`, `repair-needed`). Any agent-driven automation must respect every state transition the watchdog enforces.
- **Active research at 013-unified-trace-discovery.md**, with prior docs covering multi-lane handoffs (002), governance (004), review-findings rework (005), workflow resilience and guardian (006), agentchattr-btrain implementation plan (007), agent orchestration foundations (008), meta-harness (009/010), multi-repo dashboard (011/012). Significant prior thinking on agent ↔ btrain interaction; the agent-driver candidate below builds on (008) and (006) directly.
- **agentchattr** companion repo: a Python-based local chat server with built-in support for Claude Code, Codex, Gemini, Kimi, Qwen, Kilo, MiniMax, and any MCP-compatible agent. Multi-channel; @-mentions auto-inject prompts into agent terminals. This is the natural runtime for an agent-driver participant.
- **Watchdog + guardian** (research doc 006) enforces invalid state transitions. Any agent automation must be subject to the same enforcement, not granted bypass privileges.

---

## 3. Candidate Feature: `claude-code-action@v1` as a btrain Reviewer

### What it is
Install `claude-code-action@v1` and ship workflows that invoke btrain's review semantics on PRs and lane transitions:

1. **`claude.yml`** — interactive `@claude` mention bot for ad-hoc PR/issue questions.
2. **`claude-btrain-review.yml`** — triggered on PR open / `synchronize`. Prompt explicitly invokes the `pre-handoff` checklist semantics: real diff in locked files? Reviewer context complete (Base, Pre-flight review, Files changed, Verification run, Remaining gaps, Why this was done, Specific review asks)? Posts a structured review comment naming any gap.
3. **(stretch) `claude-handoff-watch.yml`** — repository_dispatch or workflow_dispatch triggered when `btrain handoff update --status needs-review` runs in CI mode. Validates handoff completeness *before* notifying the human reviewer. Reduces "this lane was sent for review with no diff" failures.

### Why now
- `pre-handoff` is currently advisory — invoked when an agent remembers to. As an action gate, it becomes enforced before merge.
- btrain's own development uses btrain. Auto-reviewing btrain PRs is a meta-test: if Claude can correctly run `pre-handoff` on a btrain PR, the skill is well-specified enough to ship.
- The `claude-handoff-watch` use case is unique to btrain — it would not make sense in any other repo, because btrain owns the handoff semantics.

### Likely in scope
- `.github/workflows/claude*.yml` workflows
- `.github/CLAUDE.md` augmentation describing btrain's review priorities (state-transition correctness, locked-file integrity, reviewer-context completeness)
- Mapping between `pre-handoff` skill steps and the action's prompt
- Optional: a JSON output schema for structured review verdicts the action posts as a comment

### Likely out of scope
- Modifying btrain's CLI to know about the action — keep the CLI Anthropic-agnostic
- Using Claude review to *replace* the human reviewer — Claude is a first pass, humans still gate
- Bedrock/Vertex auth

### Key decisions to surface to a spec
- Should the action run on every PR or only PRs that touch lane state files (`HANDOFF_*.md`, `.btrain/project.toml`)? Path-filter is cheap and reduces noise.
- Does the action call the `pre-handoff` skill or paraphrase its checklist into the workflow prompt? Calling the skill is more faithful but unproven in the action runtime.
- When the action finds a gap (e.g., empty reviewer context), should it block the PR or just comment? Blocking aligns with btrain's strict semantics; commenting respects the human's autonomy.
- How does the action authenticate so its commits/comments don't break btrain's identity expectations? (btrain validates active agent identity; a workflow-driven Claude commit needs a recognized identity.)

### Risks
- **Skill-paraphrase drift** — if the workflow prompt restates `pre-handoff` and the skill evolves, the workflow goes stale silently. Mitigation: prompt references the skill file path, and a CI check fails if the file's hash changes without the workflow being touched.
- **Self-review weakness** — Claude reviewing Claude's writing is a known failure mode. Mitigation: identity rotation (codex writes, claude reviews, etc.), surfaced as a configuration in `.btrain/project.toml`.
- **False rejection cost** — a rejected handoff round-trips through the writer ↔ reviewer loop, which costs tokens and time. Mitigation: action runs in advisory mode for an explicit shakedown period before any blocking behavior.

---

## 4. Candidate Feature: Agent-Driven btrain in agentchattr

### What it is
A long-running agent participant in agentchattr that owns part of the btrain operator role. Concrete behaviors:

- **Lane claiming**: when a writer model has bandwidth and the lane state is `idle` or `resolved`, the agent claims the next eligible lane on that writer's behalf with structured Delegation Packet.
- **Status driving**: when writer pushes a commit to a lane branch with reviewable changes, the agent flips status to `needs-review` and notifies the reviewer model in the chat.
- **Reviewer routing**: when the reviewer model finishes a review, the agent translates the review verdict into the right `btrain handoff` command (`resolve` / `update --status changes-requested` / etc.).
- **Stale-lane sweep**: on a timer, the agent identifies lanes that have been `in-progress` for more than N hours with no new commits and posts a nudge into the chat.
- **Conflict guard**: the agent never bypasses btrain's watchdog. It uses `btrain handoff …` CLI commands like any other actor; the watchdog still validates every transition.

### Why now
- Research docs 006 (workflow resilience) and 008 (agent orchestration foundations) already framed the need; this is the operationalizing step.
- agentchattr's @mention auto-prompt mechanism is exactly the substrate this agent needs — it's already a participant model, not a new runtime.
- The Agent SDK's session memory and tool registration are a natural fit. Without it, the operator role would be a polling loop with hand-rolled state.

### Likely in scope
- A new agent-type in agentchattr's registry (`btrain-operator` or similar)
- A small toolset implemented in the SDK: `read_handoff_state`, `claim_lane`, `update_lane_status`, `resolve_lane`, `list_locks`, `notify_chat` (these wrap the existing `btrain` CLI; they do not bypass it)
- Trigger sources: agentchattr chat events (a model in the chat finishing a turn), file-system watchers on lane branch directories, a periodic timer for stale-lane sweep
- Per-action human-approval gates (configurable): which actions require a human-typed approval in chat before they execute? Default: claim and resolve require approval; status updates within an active claim do not.
- Audit log of every action the agent takes, written to a btrain-managed file

### Likely out of scope
- Code review itself — the agent operates lane *state*, not lane *content*. It does not approve or reject reviews.
- Bypassing the watchdog or guardian. The agent is subject to all integrity enforcement btrain provides to humans and other models.
- Cross-repo coordination — operate within one repo's btrain state per agent instance.
- Replacing the human operator. The agent reduces the human's per-event cost; it does not eliminate them.

### Key decisions to surface to a spec
- **Approval gate granularity**: which actions are auto vs. require human OK? Defaults matter because they shape how trustworthy the agent is in practice.
- **Identity model**: does the operator agent run under a distinct btrain agent identity ("claude-operator"), or does it act on behalf of the writer/reviewer models? The watchdog currently expects identity to match the actor of the transition.
- **Failure mode**: when the agent makes a mistake (e.g., claims the wrong lane), how is it rolled back? btrain has no "undo" — the agent must be conservative and reversible.
- **Activation envelope**: does the operator stay running 24/7, or only when a human is also in the agentchattr session? The latter is safer; the former enables overnight progress.
- **Multi-agent contention**: if two writer models are both available, which lane goes to which? Need an assignment rule (round-robin? skill-based? configured per project?).
- **Observability**: what surface does the human use to see what the operator did, retroactively? Probably a feed in agentchattr UI plus a btrain-side audit file.
- **Bootstrapping**: how does the operator agent learn the conventions of a new repo (lane conventions, who-reviews-whom)? Likely from `.btrain/project.toml` plus repo CLAUDE.md.

### Risks
- **Self-amplifying mistakes** — an autonomous operator that makes a bad call can compound it across multiple lanes before a human catches it. Mitigation: hard rate limit (e.g., max N operator actions per hour without human intervention), default to high approval-gate granularity.
- **Trust boundary violation** — if the operator can call `btrain handoff` directly, it can theoretically forge transitions. Mitigation: identity enforcement at the watchdog layer must distinguish operator from writer/reviewer and refuse cross-role transitions.
- **Notification fatigue** — an operator agent that posts every action to chat becomes noise. Mitigation: terse summaries, batched updates, configurable verbosity.
- **agentchattr coupling** — the operator only works inside agentchattr. If a project doesn't use agentchattr, the operator is unavailable. Mitigation: design the operator as an agentchattr extension, not a btrain extension; document the dependency clearly.
- **Watchdog escape hatch** — if the operator is ever granted bypass for "convenience," btrain's integrity guarantee dies. Mitigation: the spec must explicitly forbid bypass and design every operator action as a regular CLI invocation.

---

## 5. Sequencing

```
[1] claude-code-action@v1 as btrain reviewer    (≈ 1 lane, advisory then blocking)
        ↓ validates pre-handoff in automated runner
        ↓ surfaces real-world signal on review-prompt quality
[2] Agent-driven btrain in agentchattr           (≈ 2–3 lanes, requires careful design)
```

Step 2 has hard prerequisites: agentchattr's multi-agent registry must support a non-coding participant role, and the Agent SDK's tool registration ergonomics must be understood from the ai_sales coach-tools work. Do not start (2) before both are in hand.

---

## 6. Open Questions

- **Identity model for the action's commits/comments** — same as ai_sales: dedicated GH App vs. managed?
- **Operator default approval gates** — what's the smallest set of auto-approved actions that still delivers leverage? Probably status updates within an existing claim. Need a real conversation with users (you) before spec'ing.
- **Audit format** — does btrain have an existing audit/event log, or does the operator need to introduce one? Affects scope materially.
- **Conflict with multi-repo dashboard (011/012)** — the dashboard is read-side; the operator is write-side. Are there UI surfaces that need to coordinate?
- **Self-hosting** — will users want to run the operator on their own infrastructure or only in our hosted agentchattr? Affects packaging.

---

## 7. Out of Scope (Explicitly)

- The CLI itself adopting Anthropic SDK as a dependency. Zero-dep is a feature.
- An operator agent that does code review or code writing. It operates *state*, not content.
- Cross-repo operator coordination. One operator instance, one repo.
- Bypassing the watchdog under any circumstance.
- Replacing human operators entirely. The goal is leverage, not autonomy.

---

## 8. Next Steps

1. Review this doc; mark candidates as accepted / rejected / deferred.
2. For each accepted candidate, run `speckit.specify` to create a `specs/NNN-*/` directory and migrate "key decisions" + "open questions" into the formal spec's clarifications block.
3. The agent-driver candidate (4) cross-references prior research docs 006, 007, 008, 011, 012 — its spec should explicitly cite which prior decisions it's operationalizing and which it's revisiting.
