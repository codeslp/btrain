# Spec: Multi-Lane Handoffs with File Locking

**Status**: Partially implemented
**Version**: 1.1.2
**Author**: btrain
**Date**: 2026-03-15
**Updated**: 2026-08-31

The multi-lane lock baseline through v1.1.1 is implemented. Version 1.1.2 is the designated contract, including close-without-merge as terminal `resolved` and audited force-release. Those two paths remain CLI drift and are not yet delivered.

## Summary

Concurrent work lanes allow multiple agents to work simultaneously on separate tasks with file-level isolation enforced by a lock registry and pre-commit hook.

## Configuration

Enabled via `[lanes]` in `.btrain/project.toml`:

```toml
[lanes]
enabled = true

[lanes.a]
handoff_path = ".claude/collab/HANDOFF_A.md"

[lanes.b]
handoff_path = ".claude/collab/HANDOFF_B.md"
```

When `[lanes]` is absent or `enabled = false`, btrain operates in single-handoff mode (backward compatible).

## Architecture

### Lane Files

Each lane has its own independent handoff file with the standard `## Current` section. Lanes are identified by single-letter IDs (`a`, `b`).

### Lock Registry

`.btrain/locks.json` stores file-level locks:

```json
{
  "version": 1,
  "locks": [
    {
      "path": "src/auth/",
      "lane": "a",
      "owner": "Claude",
      "acquired_at": "2026-03-15T21:00:00Z"
    }
  ]
}
```

### Lock Enforcement

1. **On claim**: `btrain handoff claim --files` acquires locks; conflicts with other lanes are rejected
2. **On terminal resolve**: `btrain handoff resolve --lane` auto-releases that lane's locks only when the lane actually becomes `resolved`
3. **Pre-commit hook**: Blocks commits touching files locked by another lane

When `[pr_flow].enabled` is true, peer `handoff resolve` means local review approval and advances the lane to `ready-for-pr`. It does **not** release locks. Locks stay held through `ready-for-pr`, `pr-review`, and `ready-to-merge`, and are released when the PR merges or closes (or via `btrain locks release-lane` after a spec 006 audited override). Close without merge is terminal `resolved` plus lock release; it is not `repair-needed`.

This PR-flow retention contract is the intended behavior for PR-flow-enabled repositories, including this one. Spec 002's original resolve-releases rule still applies only to terminal `resolved` (no PR-flow, or after the PR has merged or closed).

### PR-flow states and actors

These statuses and actors are the designated contract for the spec 014 first model. GitHub is an external event source; btrain's response is what is specified.

| Status | Meaning | Who may enter it | Locks |
|---|---|---|---|
| `ready-for-pr` | Local peer approved; a PR may be opened or relinked | Assigned reviewer via `handoff resolve`. The owner acts next (opens or relinks the PR) after the lane is already in this status. | retained |
| `pr-review` | A GitHub PR is linked and waiting on GitHub review/CI | Owner via `btrain pr create`, or owner via `handoff update --status pr-review --pr` to relink | retained |
| `ready-to-merge` | GitHub review/CI disposition is mergeable | `btrain pr poll --apply` (PR-flow), not a peer `handoff resolve` | retained |
| `changes-requested` (PR-flow) | GitHub review returned findings | `btrain pr poll --apply` when overall status is feedback; then the writer acts (spec 005) | retained |
| `resolved` after merge | PR merged | `btrain pr poll --apply` on merge | released |
| `resolved` after close without merge | PR closed unmerged; the lane is abandoned or replaced | `btrain pr poll --apply` on close, or a human/owner intentionally resolving | released |

Close without merge is a **terminal lock-release** event. It is not `repair-needed`. Spec 006 `repair-needed` is for workflow-integrity failures and retains locks; GitHub close is an external completion event. The lane becomes `resolved` and locks release.

Current `applyPrStatusToHandoff` sending `overall === "closed"` to `repair-needed` (`src/brain_train/pr-flow.mjs`) is implementation drift and a candidate counterexample. The model must pin this designated contract, not the current branch.

### Force-release override

`btrain locks release --path` and `btrain locks release-lane` may drop lock-registry coverage without resolving the lane, but only as a spec 006 FR-2c/FR-2d audited override:

- an agent or guardian requests the override
- a reason is recorded
- a human confirms before execution
- the override is granted and consumed in canonical workflow history

Matching lock coverage is suspended **only after** that verified override event. The model must record an uncovered/override flag; the handoff locked-file list is stale until the next claim or rescope.

A CLI call that releases locks from `--path` or `--lane` alone, without grant/consume and human confirmation, is implementation drift and a candidate counterexample. The conformance harness must not treat that unaudited path as a valid uncovered trace.

The default invariant "every active lane has exclusive, matching lock coverage" holds on every trace that has not completed a verified spec 006 override.

## CLI Commands

All `handoff` subcommands accept `--lane <id>`:

| Command | Behavior |
|---|---|
| `btrain handoff` | Shows all lanes' status and guidance |
| `btrain handoff claim --lane a` | Claims a task on lane A |
| `btrain handoff update --lane a` | Updates lane A's state |
| `btrain handoff resolve --lane a` | Local approval or terminal resolve. Releases locks only when the lane becomes `resolved`; in PR-flow, local approval keeps locks through merge or close. |
| `btrain locks` | Lists all active file locks |
| `btrain locks release --path <p>` | Force-releases a specific lock after a spec 006 audited override |
| `btrain locks release-lane --lane <id>` | Releases all locks for a lane after a spec 006 audited override |
| `btrain status` | Shows per-lane breakdown when lanes enabled |
| `btrain doctor` | Checks lane files, locks.json validity, stale locks, lock overlaps |

If `--lane` is omitted on `claim`, btrain auto-selects the first idle or resolved lane.

## Health Checks (`btrain doctor`)

When lanes are enabled, doctor validates:

- Lane handoff files exist
- `locks.json` exists and is valid JSON
- No stale locks (locks on resolved/idle lanes)
- No cross-lane lock overlaps

## Backward Compatibility

- Repos without `[lanes]` in `project.toml` work identically to before
- The original `HANDOFF.md` is preserved and still used for single-lane mode
- All existing tests (29) pass unchanged
