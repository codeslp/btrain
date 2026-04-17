# BranchFS Evaluation for btrain Lane Isolation

**Date**: 2026-04-16
**Status**: Research / tracking
**Source**: [multikernel/branchfs](https://github.com/multikernel/branchfs) | [Paper (arXiv)](https://arxiv.org/abs/2602.08199)

## What BranchFS Is

BranchFS is a FUSE-based filesystem written in Rust (MIT license, ~3,400 LOC) by Multikernel Technologies. It provides lightweight, atomic copy-on-write branching on top of any existing filesystem. Designed explicitly for AI agent workflows.

- **Created**: February 2026
- **Last activity**: March 2026
- **Maturity**: Experimental. Presented at the Agentic OS Workshop at ASPLOS 2026.
- **Adoption**: ~44 GitHub stars. Minimal HN engagement. No known production deployments.

## How It Works

When a file is first modified on a branch, BranchFS copies the entire file from the base (or nearest ancestor branch) into a per-branch **delta directory**. Unmodified files resolve by walking up the branch chain. Deletions use tombstone markers.

All branches are simultaneously accessible via `/@branch-name/` virtual paths through a single FUSE mount. No "switching" needed.

**Three core operations:**

| Operation | Latency | Notes |
|-----------|---------|-------|
| Create branch | ~300 us | Constant-time regardless of base size (tested up to 10K files) |
| Commit | 300 us - 2 ms | Merges delta into parent atomically; proportional to changed data |
| Abort | Near-zero | Discards the delta directory; parent/siblings unaffected |

**Nested branches** form a tree. Only leaf branches can be committed or aborted (children must be resolved first). This maps well to btrain's lane model where work feeds back into a shared base.

## Relevance to btrain

btrain currently uses a **shared worktree** model with metadata-only locks (`.btrain/locks.json`). Isolation is enforced procedurally through the CLI and git hooks. This works but has known limitations:

### Problems BranchFS would solve

| Current problem | BranchFS solution |
|----------------|-------------------|
| Locks are advisory -- agents can still edit locked files | Each lane gets a filesystem branch; agents physically can't see each other's uncommitted writes |
| Stale lock accumulation after agent crashes | Abort discards the delta dir; no lock registry to corrupt |
| Shared package managers, caches, env vars can interfere | Each branch has its own file state |
| Lock mismatch between `locks.json` and handoff metadata | No lock registry needed -- branches *are* the isolation |
| No atomic apply/reject for a lane's work | `commit` merges atomically; `abort` discards cleanly |
| Cross-lane drift when agents touch unlocked files | Agents can't see uncommitted changes from other branches |

### Integration sketch

```
btrain handoff claim --lane a --task "..."
  -> branchfs create --name lane-a --base /repo
  -> agent works at /@lane-a/ (sees full repo, writes go to delta only)

btrain handoff resolve --lane a
  -> branchfs commit --name lane-a  (merges delta into base atomically)
  -- or --
  -> branchfs abort --name lane-a   (zero-cost discard on rejection)
```

### Companion tooling

- **BranchContext** ([github.com/multikernel/branching](https://github.com/multikernel/branching)) -- Python library (`pip install BranchContext`) with composable agent exploration patterns: speculate, best-of-N, reflexion, tree-of-thoughts, beam search, tournament, cascaded.
- **Sandlock** ([github.com/multikernel/sandlock](https://github.com/multikernel/sandlock)) -- companion process-level sandbox using Landlock + seccomp for combined filesystem isolation + process confinement.

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Linux | Full support | FUSE3; passthrough mode reaches 82% native read throughput |
| macOS | Partial | Requires macFUSE (system extension approval; Recovery Mode on Apple Silicon). No passthrough mode -- FUSE reads at ~19% native. Write-based control interface instead of ioctl. |
| Windows | Not supported | Theoretically possible via WinFSP but no work has been done |

## Performance

Benchmarks from the paper (AMD Ryzen 5 5500U, 8GB DDR4, 240GB NVMe, Linux 6.17):

**Sequential I/O throughput (50 MB file, 64 KB blocks):**

| Mode | Read (MB/s) | Write (MB/s) |
|------|-------------|-------------|
| Native | 8,800 | 576 |
| BranchFS (FUSE) | 1,655 | 631 |
| BranchFS (passthrough, Linux only) | 7,236 | 719 |

The authors argue FUSE overhead is negligible for agent workloads where LLM API latency (100 ms - 10 s) dominates wall-clock time. This is correct for btrain's use case.

## Comparison with Alternatives

| Feature | Git Worktrees | OverlayFS | Btrfs/ZFS | BranchFS |
|---------|--------------|-----------|-----------|----------|
| Portable across filesystems | Yes | Yes | No | Yes |
| Nested branches | No | No | Yes | Yes |
| Commit-to-parent | No (merge) | No | No | Yes |
| No root privileges | Yes | No | No | Yes |
| Battle-tested | Yes | Yes | Yes | No |
| macOS support | Yes | No | No | Partial |
| Windows support | Yes | No | No | No |

**Git worktrees** remain the most practical near-term option: zero dependencies, cross-platform, well-understood. They only isolate git-tracked files (no env/cache isolation), but that covers the majority of btrain's collision surface.

## Concerns

1. **macOS UX** -- macFUSE requires kernel extension approval, potentially Recovery Mode on Apple Silicon. This is the primary development platform for btrain.
2. **Project maturity** -- fewer than 3 months old, ~44 stars, no known production users. Too early to depend on.
3. **No multi-branch merge** -- only single-winner commit-to-parent. If two lanes modify the same file, conflict resolution still falls outside BranchFS.
4. **File-level COW** -- entire file copied on first write. Fine for source code; expensive if agents touch large generated files.
5. **FUSE dependency** -- btrain currently has zero OS-level requirements. Adding FUSE increases the install/support surface significantly.
6. **Non-filesystem state** -- network connections, IPC, device I/O are not rolled back on abort. Only filesystem state is branched.

## Recommendation

**Track, don't adopt yet.**

BranchFS is a strong conceptual fit for btrain's lane model -- it would replace soft metadata locks with real filesystem isolation. But the blockers are practical:

- macOS support is rough (FUSE kernel extension friction)
- Project is too young to depend on for a workflow tool
- Git worktrees solve most of the same problems with zero new dependencies

**Near-term** (now): Continue with the shared-worktree + lock model. Consider git worktrees as the spec-008 "worktree-per-lane" optional mode.

**Medium-term**: If btrain targets Linux-first environments (CI runners, cloud agent sandboxes), BranchFS becomes a compelling isolation backend -- especially paired with Sandlock for process confinement.

**Trigger to revisit**: BranchFS reaches v1.0, macFUSE friction is resolved (or Apple ships native FUSE support), or btrain's user base shifts toward Linux-hosted agents.

## References

- [BranchFS GitHub](https://github.com/multikernel/branchfs)
- [BranchContext Python library](https://github.com/multikernel/branching)
- [Sandlock sandbox](https://github.com/multikernel/sandlock)
- [Paper: "Fork, Explore, Commit" (arXiv 2602.08199)](https://arxiv.org/abs/2602.08199)
- [ASPLOS 2026 AgenticOS Workshop](https://os-for-agent.github.io/)
- [Multikernel blog](https://multikernel.io/blog/)
