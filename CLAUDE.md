<!-- btrain:managed:start -->
## Brain Train Workflow

This repo uses the `btrain` collaboration workflow.

- **Always use CLI commands** (`btrain handoff`, `handoff claim`, `handoff update`, `handoff resolve`) to read and update handoff state. Do not read or edit `HANDOFF_A.md` / `HANDOFF_B.md` directly.
- `bth` means run `btrain handoff` and then immediately do the work it directs. Do not stop after printing status.
- Only move a task to `needs-review` after real completed work exists, reviewer context is filled in, and the handoff is ready for review.
- Run `btrain handoff` before acting so btrain can verify the current agent and tell you whose turn it is.
- Before editing, do a short pre-flight review of the locked files, nearby diff, and likely risk areas so you start from known problems.
- Run `btrain status` or `btrain doctor` if the local workflow files look stale.
- Repo config lives at `.btrain/project.toml`.

### Multi-Lane Workflow

When `[lanes]` is enabled in `project.toml`, agents work concurrently on separate lanes:

- Use `--lane a` or `--lane b` with `handoff claim|update|resolve`.
- Lock files with `--files "path/"` when claiming to prevent cross-lane collisions.
- Run `btrain locks` to see active file locks.
- When your lane is done, hand it to a peer reviewer while you continue on other work.

<!-- btrain:managed:end -->

## Project-Specific Instructions

Add repo-specific Claude instructions below. `btrain init` only updates the managed block above.
