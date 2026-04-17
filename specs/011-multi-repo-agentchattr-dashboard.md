# Spec: Multi-Repo Agentchattr Dashboard

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-04-17

## Summary

Consolidate all agentchattr copies into a single install that polls btrain status from multiple repos simultaneously and displays them in one unified dashboard. One codebase, one server, one port, all repos visible in one browser tab.

## Why This Exists

agentchattr is currently duplicated across 4 repos (btrain, cgraph, mech_ai, closr/ai_sales). Each runs its own server on a separate port. This causes:

1. **Maintenance burden** — bug fixes must be applied to every copy. The trigger_sync fix (2026-04-17) had to be patched in 4 separate `app.py` files.
2. **Fragmented visibility** — operators must open 4 browser tabs and mentally correlate lane activity across repos.
3. **Resource waste** — 4 Python processes, 4 venvs, 4 btrain pollers running identical code.
4. **Drift risk** — copies diverge over time as fixes land in one repo but not others.

## User Scenarios

### US-1: Operator views all repos in one dashboard

An operator opens a single browser tab and sees lane cards from btrain, cgraph, mech_ai, and closr grouped by repo. They can scan which agents are active, which lanes need review, and which repos have idle capacity — all without switching tabs.

### US-2: Operator sends a message scoped to one repo

The operator types `@claude fix the auth bug` while viewing the cgraph repo context. The message routes to the claude wrapper running in cgraph's working directory, not btrain's or mech_ai's.

### US-3: Operator adds a new repo

The operator adds a new repo path to the config file and restarts (or hot-reloads). The dashboard picks it up and starts polling its btrain status alongside the others.

### US-4: Operator removes a stale repo

A repo is removed from the config. Its lanes disappear from the dashboard. No orphaned pollers or stale data remain.

### US-5: Agent receives trigger with correct repo context

When btrain detects a lane transition in cgraph, the notification triggers the correct agent wrapper — the one whose working directory is cgraph, not a wrapper pointed at a different repo.

## Functional Requirements

### FR-1: Multi-repo configuration

The server reads a list of repos from its configuration. Each repo entry includes:
- A human-readable label (e.g. "cgraph", "closr")
- The absolute path to the repo root (where `.btrain/project.toml` lives)
- Optional per-repo overrides (poll interval, agent mapping)

### FR-2: Per-repo btrain polling

The server runs one btrain poller per configured repo. Each poller independently calls `btrain status --repo <path> --json` at its configured interval and caches the result. Pollers run in background threads, same as today.

### FR-3: Unified lane state broadcast

WebSocket clients receive lane data tagged with a `repo` field. The existing `btrain_lanes` message type is extended:

```json
{
  "type": "btrain_lanes",
  "data": {
    "repos": [
      {
        "name": "cgraph",
        "path": "/Users/bfaris96/cgraph",
        "lanes": [...],
        "repurposeReady": [...]
      },
      {
        "name": "closr",
        "path": "/Volumes/zombie/closr",
        "lanes": [...],
        "repurposeReady": [...]
      }
    ]
  }
}
```

### FR-4: Repo-scoped UI

The dashboard left rail groups lane cards by repo. Each repo section has a collapsible header showing the repo name and a summary (e.g. "3 active, 2 idle"). The operator can:
- Expand/collapse repo sections
- Click a repo header to filter the main chat to that repo's channels
- See all repos at once in a compact overview

### FR-5: Repo-scoped chat channels

Each repo gets its own `agents` channel (e.g. `cgraph/agents`, `closr/agents`). Messages and notifications are scoped to the repo they originate from. The operator can switch between repo contexts or view a unified "all repos" feed.

### FR-6: Repo-scoped agent triggering

When the btrain poller for repo X detects a lane transition, it triggers the agent wrapper whose working directory matches repo X. Agent wrappers register with their repo context so the server can route triggers correctly.

This is a baseline requirement, not a follow-up. Without repo-scoped routing, a notification for cgraph lane A would trigger whichever `claude` wrapper registered last, not the one working in cgraph. Multi-repo polling without repo-scoped triggers would actively misroute work.

### FR-9: Repo-qualified lane identity

Lane IDs across repos are not unique (every repo has lanes `a`-`i`). All internal surfaces that reference lanes must use a repo-qualified key: `{repo_label}/{lane_id}` (e.g. `cgraph/a`, `btrain/b`). This applies to:
- Chat channels and channel tabs
- Lane archive filenames and paths
- Left-rail lane cards and DOM IDs
- btrain validator lane references
- REST API lane parameters
- Notification fingerprints and dedup keys

When only one repo is configured, the unqualified lane ID is used for backward compatibility.

### FR-10: Multi-instance wrapper registration

The current wrapper startup deregisters any existing instance of the same agent family before registering a new one. In multi-repo mode, starting `claude` for cgraph would deregister `claude` for btrain. The registration model must support multiple instances of the same agent family, distinguished by their repo context. The `repo` field on the registry instance is the discriminator — deregistration only removes instances matching both family and repo.

### FR-7: Single codebase install

The canonical agentchattr lives in one location (e.g. `~/agentchattr/` or within btrain as the source-of-truth repo). Other repos do not contain copies of agentchattr. They reference the shared install via their btrain or agentchattr config.

### FR-8: Backward compatibility

A config with a single repo (or no explicit multi-repo config) works identically to today's single-repo mode. Existing wrapper scripts, queue files, and API endpoints continue to function without changes.

## Success Criteria

- Operator can monitor lanes across all 4 repos from a single browser tab
- Bug fixes are applied once and take effect for all repos on restart
- Adding or removing a repo requires only a config change and restart
- Message routing delivers triggers to the correct repo-scoped agent wrapper
- No regression in single-repo mode for users who don't need multi-repo

## Scope Boundaries

### In scope
- Multi-repo btrain polling and lane display
- Repo-scoped chat channels and message routing
- Repo-scoped agent trigger routing
- Consolidated single-install model
- Config-driven repo list

### Out of scope
- Cross-repo lane coordination (e.g. moving work between repos)
- Remote/cloud-hosted agentchattr
- Multi-user authentication
- Real-time repo discovery (manual config only)

## Assumptions

- All repos use btrain and have `.btrain/project.toml` at their root
- All repos are accessible from the machine running agentchattr (local filesystem)
- The `btrain` CLI is available on PATH and works for all configured repos
- Agent wrappers are launched separately per repo (agentchattr doesn't manage wrapper lifecycle across repos)

## Dependencies

- btrain `status --json` must include the repo path in its output (already does)
- Agent wrapper registration must include repo context (needs wrapper change)
- WebSocket protocol change (additive — new `repos` field in `btrain_lanes`)

## Migration Path

1. Designate btrain's `agentchattr/` as the canonical install
2. Add `[repos]` section to `config.toml` listing all monitored repos
3. Update the btrain poller to iterate over configured repos
4. Extend the WebSocket broadcast to include repo metadata
5. Update the left-rail UI to group lanes by repo
6. Add repo-scoped channel routing
7. Remove agentchattr copies from cgraph, mech_ai, closr
8. Update each repo's start scripts to point to the canonical install
