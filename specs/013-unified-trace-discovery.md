# 013 — Unified Trace Discovery

## Problem

Decision traces from btrain land in four separate places today:

| Source | Path | Format |
| --- | --- | --- |
| Handoff lifecycle events | `.btrain/events/lane-<id>.jsonl` | JSONL per lane |
| Lane history archive | `.btrain/history/lane-<id>.md` | Markdown per lane |
| Harness run bundles | `.btrain/harness/runs/<run_id>/` | bundle dir (summary.json + events.jsonl + artifacts/ + prompts/) |
| Spilled Next Action bodies | `.btrain/handoff-notes/` | Markdown |
| Agentchattr routing decisions | **not captured** | — |

There is no single surface to answer "what has btrain decided for me recently, across all of this?" — you have to know which folder to `ls` and which schema to read. The user needs decision tracing to be _findable_ for anything run with btrain.

## Goal

A unified, discoverable view over every btrain decision record, without migrating existing storage. Add one new surface where it's missing (agentchattr routing), leave everything else in place, and expose a single CLI + library that aggregates.

## Non-goals

- Do not move or rewrite existing `.btrain/events/` / `.btrain/history/` / `.btrain/harness/runs/` data.
- Do not add compression or archival policy in this spec (future, separate work).
- Do not change the handoff CLI contract.
- Do not add new remote storage or external services.

## Design

### Folder layout (after this change)

```
.btrain/
  events/             # unchanged — handoff lifecycle JSONL per lane
  history/            # unchanged — lane history markdown per lane
  handoff-notes/      # unchanged — spilled Next Action bodies
  harness/runs/       # unchanged — harness trace bundles
  traces/             # NEW — agentchattr + future sources
    agentchattr-<YYYY-MM-DD>.jsonl
    index.jsonl       # append-only catalog of non-handoff/non-harness events
```

`.btrain/traces/` is for sources that don't have a natural home today. Handoff events stay in `.btrain/events/` because core.mjs owns that schema; harness bundles stay in `.btrain/harness/runs/` because trace-bundle.mjs owns that schema. The discovery layer reads all three.

### Record schema (unified view)

The discovery library normalizes every source into one record shape for listing:

```
{
  kind: "handoff" | "harness" | "agentchattr",
  id: string,              // stable id: run_..., lane-a-<ts>, agentchattr-<ts>-<nonce>
  lane?: string,           // a..f if applicable
  actor?: string,          // claude, codex, or an agent label
  ts: string,              // ISO timestamp
  outcome?: string,        // resolved, needs-review, in-progress, pass, fail, error
  summary: string,         // one line
  sourcePath: string       // absolute path to the canonical record
}
```

Clients consuming the list can `cat sourcePath` for the raw record. `show` extracts full detail per kind.

### Agentchattr emitter

New module `agentchattr/btrain/trace_emitter.py`:

```python
def emit_routing_decision(repo_root, *, agent, route, lane=None, repo=None, reason, context=None)
def emit_startup(repo_root, *, config, agents, lanes)
def emit_context_fetch(repo_root, *, agent, lane, ok, note=None)
```

Each writes a line to `.btrain/traces/agentchattr-<YYYY-MM-DD>.jsonl` with schema:

```
{ "ts": "...", "kind": "agentchattr", "event": "routing_decision" | "startup" | "context_fetch",
  "agent": "...", "route": "...", "lane": "...", "repo": "...", "reason": "...", "context": {...} }
```

It also appends a compact index line to `.btrain/traces/index.jsonl` for fast listing:

```
{ "ts": "...", "kind": "agentchattr", "event": "routing_decision", "lane": "a", "summary": "routed @claude to lane a" }
```

Emission is **best-effort** — a write failure logs a warning but never breaks routing. The router continues to work with tracing disabled (missing repo root, read-only filesystem, etc.).

Hook site: `agentchattr/router.py` at the decision point where a route is chosen. One call, one record, synchronous append.

### Harness-side discovery library

New module `src/brain_train/harness/trace-discovery.mjs`:

```js
export async function listTraces(repoRoot, { limit, kind, lane, since } = {})
export async function showTrace(repoRoot, traceId)
```

`listTraces`:
- Reads `.btrain/events/lane-*.jsonl` → emits one record per significant handoff event (claim, update, resolve). Bulk events like lock/unlock are excluded from list view but accessible via show.
- Reads `.btrain/harness/runs/<run_id>/summary.json` → one record per bundle.
- Reads `.btrain/traces/index.jsonl` → one record per agentchattr event.
- Sorts by `ts` desc, applies filters, caps by `limit` (default 50).

`showTrace`:
- Dispatches by id prefix: `run_*` → harness bundle; `lane-*` → handoff event; `ac-*` → agentchattr line.
- Returns the raw canonical record plus optional context (for harness: event count + artifact count; for handoff: linked spilled body if present).

### CLI surface (Phase B, after codex unlocks cli.mjs)

```
btrain traces list [--kind handoff|harness|agentchattr] [--lane a] [--since <iso>] [--limit 50]
btrain traces show <id>
btrain traces tail [--kind ...] [--follow]
```

The CLI delegates entirely to the discovery library. No new state.

## Phases

**Phase A — safe-to-land now (lane b):**
1. This spec.
2. `src/brain_train/harness/trace-discovery.mjs` library with `listTraces` + `showTrace`.
3. `agentchattr/btrain/trace_emitter.py` with three emitter functions.
4. Minimal hook in `agentchattr/router.py` at the decision point.

**Phase B — after codex resolves lane a (unlocks cli.mjs / core.mjs / test/):**
5. `btrain traces list|show|tail` CLI wiring in cli.mjs.
6. Tests: unit tests for the discovery library, integration tests for the emitter, a CLI smoke test.
7. Update README + AGENTS.md mention.

## Acceptance

- `listTraces` returns a deterministic, chronologically-sorted view across all three sources with no data migration.
- `emit_routing_decision` writes both the per-day agentchattr JSONL and a line to `index.jsonl`; failure is logged but non-fatal.
- Router continues to route correctly when the emitter is disabled or its write fails.
- Phase B CLI `btrain traces list` produces the same records as direct library calls.
- All existing tests remain green. New tests (Phase B) cover: empty-repo list, multi-source merge, since-filter, kind-filter, show dispatch per kind, emitter failure tolerance.

## Runtime adapter pins

Triggered by the same Pi lesson ("one integration test per provider to catch contract drift"). Landed alongside trace discovery:

- `src/brain_train/runners/stream-observers.mjs` — extracted the Claude and Codex stream observers from core.mjs (which was locked by another lane) so they have an importable surface. When core.mjs becomes editable again, drop the inline duplicates and import from here.
- `test/runners/claude-stream-observer.pin.test.mjs` — 12 pin tests freezing the Claude `claude-stream-json` contract: assistant text, tool use, tool result (stdout/stderr/interrupted/completed fallbacks), result dispatch (success vs. duplicate suppression vs. error), chunked streaming, malformed JSON handling, flush, stderr capture.
- `test/runners/codex-stream-observer.pin.test.mjs` — 13 pin tests freezing the Codex `codex-json` contract: command started/finished/result, exit-code messages, `-lc '...'` unwrap, agent_message, error, multi-event chunks, split-line chunks, malformed JSON, flush, unknown event types.

If a runtime changes its stream JSON shape, these tests fail first. Updates require touching both the observer and the fixture, forcing explicit acknowledgment of the contract change.

## Why this shape

- **No migration** keeps the blast radius small. We add one folder, not four.
- **Aggregation over write-through** avoids coupling the discovery API to any single source's schema evolution.
- **Best-effort emit** protects routing — tracing failures must not cause handoff failures.
- **Separation of concerns**: handoff events, harness bundles, and agentchattr routing each keep their own writer; only the reader is unified.
