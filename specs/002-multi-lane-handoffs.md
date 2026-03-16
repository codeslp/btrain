# Spec: Multi-Lane Handoffs with File Locking

**Status**: Implemented
**Version**: 1.0.0
**Author**: btrain
**Date**: 2026-03-15

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
2. **On resolve**: `btrain handoff resolve --lane` auto-releases that lane's locks
3. **Pre-commit hook**: Blocks commits touching files locked by another lane

## CLI Commands

All `handoff` subcommands accept `--lane <id>`:

| Command | Behavior |
|---|---|
| `btrain handoff` | Shows all lanes' status and guidance |
| `btrain handoff claim --lane a` | Claims a task on lane A |
| `btrain handoff update --lane a` | Updates lane A's state |
| `btrain handoff resolve --lane a` | Resolves lane A, releases its locks |
| `btrain locks` | Lists all active file locks |
| `btrain locks release --path <p>` | Force-releases a specific lock |
| `btrain locks release-lane --lane <id>` | Releases all locks for a lane |
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
