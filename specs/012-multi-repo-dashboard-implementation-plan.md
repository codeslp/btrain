# Implementation Plan: Multi-Repo Agentchattr Dashboard

**Spec**: `specs/011-multi-repo-agentchattr-dashboard.md`
**Date**: 2026-04-17
**Status**: Draft

## Technical Context

### Current Architecture

- **Server**: FastAPI + uvicorn, single-process, background threads for btrain polling, agent triggering, cleanup
- **Config**: TOML (`config.toml` + `config.local.toml`), loaded at startup by `config_loader.py`
- **Poller**: Single `_refresh_btrain_state()` function in `app.py:544`, runs in one background thread, caches to `_btrain_cache` dict protected by `_btrain_lock`
- **Broadcast**: `_broadcast_btrain_lanes()` sends `{"type": "btrain_lanes", "data": {"lanes": [...], "repurposeReady": [...]}}` over WebSocket
- **UI**: `static/chat.js` — `renderLanesPanel()` reads `btrainLanes.lanes` and renders lane cards in the left rail
- **Triggers**: `agents.trigger_sync()` writes to `data/{agent}_queue.jsonl`; wrapper's `_queue_watcher` polls and injects into agent terminal
- **Channels**: Flat string names (`general`, `agents`, lane IDs `a`-`i`). Stored in `MessageStore` keyed by channel string.

### Key Files to Modify

| File | Change | Risk |
|------|--------|------|
| `config.toml` | Add `[[repos]]` array-of-tables | Low — additive |
| `config_loader.py` | Parse `[[repos]]` section, build repo list | Low |
| `app.py` (poller) | Loop over repos, per-repo cache, per-repo triggers | Medium — core logic |
| `app.py` (broadcast) | Tag lane data with repo name/path | Low — additive |
| `app.py` (channels) | Prefix channels with repo slug | Medium — routing change |
| `static/chat.js` | Group lane cards by repo, repo filter tabs | Medium — UI rework |
| `wrapper.py` | Register with repo context | Low — additive field |
| `registry.py` | Store repo context on instances | Low — additive field |

## Workstreams

### Workstream 1: Multi-repo config (FR-1, FR-8)

**Goal**: Config supports multiple repos while remaining backward-compatible with single-repo `[btrain]` section.

**Config format**:
```toml
# New multi-repo format
[[repos]]
label = "btrain"
path = "/Users/bfaris96/btrain"
poll_interval = 5

[[repos]]
label = "cgraph"
path = "/Users/bfaris96/cgraph"
poll_interval = 5

[[repos]]
label = "closr"
path = "/Volumes/zombie/closr"
poll_interval = 5

[[repos]]
label = "mech_ai"
path = "/Users/bfaris96/mech_ai"
poll_interval = 10
```

**Backward compatibility**: If `[[repos]]` is absent but `[btrain].repo_path` exists, synthesize a single-entry repos list from it. This means existing configs work unchanged.

**Files**: `config_loader.py`, `config.toml`

**Tasks**:
1. Add `get_repos(cfg)` to `config_loader.py` — returns list of `{"label": str, "path": str, "poll_interval": int}`. Falls back to `[btrain].repo_path` if no `[[repos]]`.
2. Add `[[repos]]` entries to `config.toml` for the 4 current repos.
3. Test: config with `[[repos]]` returns all repos. Config with only `[btrain]` returns one repo. Config with neither returns empty list.

### Workstream 2: Per-repo btrain polling (FR-2, FR-6)

**Goal**: One poller thread per repo, each with its own cache, each triggering the correct agent.

**Data model change**:
```python
# Before (single repo)
_btrain_lock = threading.Lock()
_btrain_cache: dict = {}
_btrain_prev_tasks: dict[str, str] = {}
_btrain_prev_statuses: dict[str, str] = {}

# After (multi-repo)
_btrain_lock = threading.Lock()
_btrain_repos: dict[str, dict] = {}  # keyed by repo label
# Each entry: {"cache": {}, "prev_tasks": {}, "prev_statuses": {}, "path": str}
```

**Trigger routing** (baseline, not deferred): When the poller for repo X fires a notification, the `@agent` target must resolve to the wrapper instance registered for repo X. Without this, multi-repo polling would actively misroute triggers — a cgraph lane transition could wake btrain's claude wrapper. This requires:
- Registry stores `repo` on each instance (from Workstream 4, pulled into Phase 1)
- `trigger_sync` caller passes repo label; agent lookup prefers the instance whose `repo` matches
- Fallback: if no repo-matched instance exists, trigger any available instance (single-repo compat)

**Repo-qualified lane key**: All internal references to lanes use `{repo_label}/{lane_id}` when multi-repo is active. This prevents collisions between `btrain/a` and `cgraph/a` in channels, archives, UI, validator, and API surfaces. Single-repo mode uses bare lane IDs for backward compat.

**Files**: `app.py` (configure function, `_refresh_btrain_state`, `_btrain_poller`, `_broadcast_btrain_lanes`)

**Tasks**:
1. Replace single `_btrain_cache` with `_btrain_repos` dict keyed by repo label.
2. Extract `_refresh_btrain_state` to take a repo config dict parameter instead of reading from closure.
3. Spawn one `_btrain_poller` thread per repo entry from `get_repos(cfg)`.
4. Update `_broadcast_btrain_lanes` to aggregate all repos into the new `repos` array format.
5. Tag all lane references with repo label — notification channels use `{repo}/agents`, archive paths use `{repo}_{lane}`, dedup fingerprints include repo.
6. Update the notification/trigger block to pass repo label to `trigger_sync`; agent lookup prefers the instance whose `repo` matches (falls back to any instance in single-repo mode).
7. Test: 2 repos configured, each gets its own poller thread, lane data broadcast includes both. Trigger for repo A routes to repo-A-registered wrapper, not repo B's.

### Workstream 3: Unified dashboard UI (FR-3, FR-4)

**Goal**: Left rail shows lane cards grouped by repo with collapsible sections. Chat area shows repo-scoped channels.

**WebSocket protocol change** (additive):
```json
{
  "type": "btrain_lanes",
  "data": {
    "repos": [
      {"name": "btrain", "path": "...", "lanes": [...], "repurposeReady": [...]},
      {"name": "cgraph", "path": "...", "lanes": [...], "repurposeReady": [...]}
    ]
  }
}
```

**Left rail layout**:
```
[btrain]                    ← collapsible repo header
  Lane A  IN-PROGRESS       ← existing lane card
  Lane B  NEEDS-REVIEW
[cgraph]                    ← second repo header
  Lane A  IDLE
  Lane B  IN-PROGRESS
[closr]                     ← third repo
  ...
```

**Files**: `static/chat.js` (`renderLanesPanel`, `connectWebSocket` btrain_lanes handler), `static/style.css`

**Tasks**:
1. Update `connectWebSocket` handler: if `data.repos` exists, use multi-repo path; if `data.lanes` exists (old format), wrap in single-repo for backward compat.
2. Update `renderLanesPanel` to iterate `repos`, render a collapsible header per repo, then lane cards under each.
3. Add CSS for repo section headers (`.lp-repo-header`): bold label, lane count badge, collapse/expand chevron.
4. Store active repo filter in `btrainLanes.activeRepo` (null = show all). Clicking a repo header sets the filter.
5. Update channel tabs to show repo-prefixed channels when multi-repo is active.
6. Test: WS message with 2 repos renders grouped lane cards. Collapse/expand works. Single-repo message still renders correctly.

### Workstream 4: Repo-scoped channels and routing (FR-5, FR-6)

**Goal**: Messages and notifications are scoped to the repo they originate from.

**Channel naming**: `{repo_label}/agents`, `{repo_label}/{lane_id}`. When only one repo is configured, channels remain unprefixed for backward compatibility.

**Wrapper registration**: Add `repo` field to `/api/register` body and store on the registry instance. Wrappers launched for a specific repo pass their repo root. The server can then match triggers to the correct wrapper.

**Multi-instance deregistration fix**: The wrapper startup (`wrapper.py:364-375`) calls `POST /api/deregister/{agent}` by base family name before registering. This means starting `claude` for cgraph deregisters btrain's `claude` instance. Two changes are required:

1. **Wrapper startup** (`wrapper.py:368`): Change the pre-registration deregister call to include `repo` as a query parameter: `POST /api/deregister/{agent}?repo={cwd}`. This scopes the eviction to the same-repo instance only.

2. **Deregister endpoint** (`app.py /api/deregister/{name}`): Accept optional `repo` query param. When present, only remove the instance matching both name/family AND repo. When absent (backward compat), remove by name only as today.

3. **Registry** (`registry.py`): `deregister()` gains an optional `repo` filter. If provided, skip instances whose `repo` doesn't match. The crash-timeout deregistration in the background thread does NOT pass `repo` — it deregisters any dead instance regardless of repo (correct: a crashed wrapper is dead regardless of which repo it served).

**Files**: `app.py` (deregister endpoint, notification writes, channel creation), `registry.py` (repo field on Instance, scoped deregistration), `wrapper.py` (register + deregister calls), `static/chat.js` (channel switching)

**Tasks**:
1. Update `registry.py`: add `repo` field to `Instance` dataclass, accept `repo` in `register()`, expose in `_inst_dict()`.
2. Update `registry.py` `deregister()`: accept optional `repo` param. When set, only remove instances matching both name/family AND repo.
3. Update `wrapper.py:368`: pass `repo=cwd` in the deregister call before registration.
4. Update `wrapper.py` `_register_instance`: pass `repo=cwd` in the register payload.
5. Update chat.js channel tabs: show repo-prefixed channels, allow switching.
6. Test: start `claude` wrapper for cgraph, then start `claude` wrapper for btrain — both remain registered simultaneously. Verify via `/api/status` that two `claude` instances exist with different `repo` values.
7. Test: notification for cgraph lane goes to `cgraph/agents` channel. Trigger routes to cgraph-registered wrapper, not btrain's.

### Workstream 5: Consolidation and migration (FR-7)

**Goal**: btrain's agentchattr is the single canonical install. Other repos' copies are removed.

**Tasks**:
1. Verify btrain's `agentchattr/` has all features from other copies (diff check).
2. Update btrain's `config.toml` with `[[repos]]` entries for all 4 repos.
3. Create per-repo start scripts (or a unified start script that accepts `--repo` args).
4. Update wrapper launch scripts: `start_claude.sh` etc. accept a `--cwd` override so one install can launch wrappers for different repos.
5. Remove `agentchattr/` from cgraph, mech_ai, closr.
6. Update each repo's CLAUDE.md/AGENTS.md references to point to the canonical install.
7. Smoke test: start single server, verify all 4 repos show in dashboard, messages route correctly.

## Implementation Order

```
WS1 (config) ──→ WS2 (pollers + routing) ──→ WS3 (UI)
                        │                         │
                   WS4 (registry + channels) ─────┘
                                                  │
                                             WS5 (consolidation)
```

**Phase 1** (WS1 + WS2 + WS4 registry): Multi-repo config, per-repo polling, repo-scoped trigger routing, repo-qualified lane keys, and wrapper registration with `repo` field + scoped deregistration. This is the minimum viable multi-repo backend — triggers route correctly and wrappers don't evict each other. ~1-2 sessions.

**Phase 2** (WS3 + WS4 channels/UI): UI groups lanes by repo with collapsible sections. Repo-prefixed channels. Channel switching. ~1 session.

**Phase 3** (WS5): Remove copies from cgraph/mech_ai/closr, consolidate to single install, smoke test. ~1 session.

Each phase is independently shippable. Phase 1 is the critical path — without repo-scoped routing, multi-repo polling would misroute triggers.

## Risk Areas

| Risk | Mitigation |
|------|------------|
| Channel name change breaks message history | Phase 2 migrates existing messages or leaves old channels readable |
| Wrapper startup evicts same-family instance from different repo | Scoped deregistration: only evict instances matching both family AND repo (Phase 1) |
| Lane ID collisions across repos (btrain/a vs cgraph/a) | Repo-qualified lane key `{repo}/{lane}` on all internal surfaces (Phase 1) |
| Trigger misrouting without repo-scoped lookup | Registry `repo` field + repo-aware trigger lookup are Phase 1 baseline, not deferred |
| UI performance with 4 repos × 9 lanes = 36 cards | Collapsed-by-default repo sections; only expand active repos |
| Stale repo path in config (drive unmounted) | Poller logs warning and skips; doesn't crash or block other repos |
| Race between pollers writing to shared broadcast | Single `_btrain_lock` protects all repo caches; broadcast aggregates under lock |

## Testing Strategy

- **Unit**: `config_loader.py` repo parsing (single, multi, fallback)
- **Unit**: `_refresh_btrain_state` with mocked subprocess per repo
- **Unit**: Channel name generation (prefixed vs unprefixed)
- **Integration**: Start server with 2 repo configs, verify WS broadcast includes both
- **Integration**: Lane transition in repo A triggers agent registered for repo A
- **E2E**: Browser test — lane cards grouped by repo, collapse/expand, channel switching
