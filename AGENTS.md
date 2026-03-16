<!-- btrain:managed:start -->
## Brain Train Workflow

This repo uses the `btrain` collaboration workflow.

- **Always use CLI commands** (`btrain handoff`, `handoff claim`, `handoff update`, `handoff resolve`) to read and update handoff state. Do not read or edit `HANDOFF.md` directly.
- Run `btrain status` or `btrain doctor` if the local workflow files look stale.
- Repo config lives at `.btrain/project.toml`.

### Multi-Lane Workflow

When `[lanes]` is enabled in `project.toml`, agents work concurrently on separate lanes:

- Use `--lane a` or `--lane b` with `handoff claim|update|resolve`.
- Lock files with `--files "path/"` when claiming to prevent cross-lane collisions.
- Run `btrain locks` to see active file locks.
- When your lane is done, the other agent reviews it while continuing their own work.

<!-- btrain:managed:end -->

## Project-Specific Instructions

Add repo-specific agent instructions below. `btrain init` only updates the managed block above.
