<!-- btrain:managed:start -->
## Brain Train Workflow

This repo uses the `btrain` collaboration workflow.

- **Always use CLI commands** (`btrain handoff`, `handoff claim`, `handoff update`, `handoff resolve`) to read and update handoff state. Do not read or edit `HANDOFF_*.md` files directly.
- When handing work to a reviewer, always fill the structured handoff fields: `Base`, `Pre-flight review`, `Files changed`, `Verification run`, `Remaining gaps`, `Why this was done`, and `Specific review asks`.
- If the repo provides a `pre-handoff` skill, run it immediately before `btrain handoff update --status needs-review`.
- Run `btrain handoff` before acting so btrain can verify the current agent and tell you whose turn it is.
- Before editing, do a short pre-flight review of the locked files, nearby diff, and likely risk areas so you start from known problems.
- Run `btrain status` or `btrain doctor` if the local workflow files look stale.
- Repo config lives at `.btrain/project.toml`.

### Collaboration Setup

- Active collaborating agents: not configured yet. Add `active = ["Agent A", "Agent B"]` under `[agents]`.
- Current lane target: 4 lane(s) (2 per collaborating agent): `a`, `b`, `c`, `d`
- Change `[agents].active` or `[lanes].per_agent`, then run `btrain init`, `btrain agents set`, or `btrain agents add` to scaffold missing lanes and refresh docs.

### Multi-Lane Workflow

When `[lanes]` is enabled in `project.toml`, agents work concurrently on separate lanes:

- Use `--lane <id>` (e.g. `a`, `b`, `c`, `d`) with `handoff claim|update|resolve`.
- Lock files with `--files "path/"` when claiming to prevent cross-lane collisions.
- Run `btrain locks` to see active file locks.
- When your lane is done, hand it to a peer reviewer while you continue on other work.

<!-- btrain:managed:end -->

# Agent Instructions

This file exists because Claude Code auto-loads `CLAUDE.md`. Keep it aligned with `AGENTS.md`.

## btrain Repo Notes

- Source of truth for product behavior: `README.md`, `src/brain_train/core.mjs`, `src/brain_train/cli.mjs`, `test/core.test.mjs`, and `test/e2e.test.mjs`.
- If you change `init`, handoff behavior, lane logic, or reviewer selection, update the runtime, tests, `README.md`, `examples/project.toml`, and `docs/index.html` in the same change.
- The bundled `.claude/skills/` tree is part of the shipped product. Keep every bundled skill project-agnostic. Do not add repo-specific names, paths, or assumptions.
- `src/brain_train/dashboard.mjs`, `src/brain_train/assets/`, and `docs/index.html` are upstream `btrain` assets. Keep links and examples pointed at `https://github.com/codeslp/btrain`.
- Do not edit tracked handoff state files in `.claude/collab/` unless the task is explicitly about dogfooding or workflow fixtures.
