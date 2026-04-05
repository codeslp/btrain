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

- Active collaborating agents: `Claude`, `GPT`, `Gemini`
- Current lane target: 9 lane(s) (3 per collaborating agent): `a`, `b`, `c`, `d`, `e`, `f`, `g`, `h`, `i`
- Change `[agents].active` or `[lanes].per_agent`, then run `btrain init`, `btrain agents set`, or `btrain agents add` to scaffold missing lanes and refresh docs.

### Multi-Lane Workflow

When `[lanes]` is enabled in `project.toml`, agents work concurrently on separate lanes:

- Use `--lane <id>` (e.g. `a`, `b`, `c`, `d`, `e`, `f`) with `handoff claim|update|resolve`.
- Lock files with `--files "path/"` when claiming to prevent cross-lane collisions.
- Run `btrain locks` to see active file locks.
- When your lane is done, hand it to a peer reviewer while you continue on other work.

<!-- btrain:managed:end -->

# AI Sales Brain Train - Agent Instructions

Instructions for all AI agents working on this project. `CLAUDE.md` mirrors this file for Claude Code auto-loading.

## Source of Truth

All project knowledge lives in the research documents. Do not duplicate conclusions here - read these files instead:

| What | Where |
| --- | --- |
| Research scope, goals, and document index | `research/00-research-overview.md` |
| Final recommendation and phased strategy | `research/07-recommendation.md` |
| Harness evaluation | `research/09-harness-evaluation.md` |
| Prioritized harness recommendations | `research/10-harness-recommendations.md` |
| Current state and session continuity | `.claude/projects/*/memory/MEMORY.md` |

## Agent Rules

- **No hardcoded API keys or paths** - use environment variables
- **Edit over create** - modify existing docs/files when possible; only create new files when necessary
- **Do not modify** `.claude/settings.json` or `.claude/settings.local.json` unless the user explicitly asks
- **Be concise** - keep meaning intact, no fluff
- **Research-first** - keep recommendations grounded in the documents above instead of inventing new canon
- **Chat shorthand** - if the user sends a bare `bth` message in agent chat, run `btrain handoff` from the repo root and immediately follow the printed guidance. Do not stop after printing status.
- **Runtime alias** - in this repo, collaborator label `GPT` maps to the Codex runtime / GPT-5 Codex via `[agents.runners]`, so `agent check: GPT (runtime hints (codex))` is the expected `btrain handoff` identity.

## Multi-Model Collaboration Protocol

Before starting any work, run `btrain handoff` from the repo root to check the current handoff state.

`bth` means "run `btrain handoff`, then immediately start doing the work it tells you to do." Do not just print the status and stop. After running the command:
- If it says to review, start reviewing the code now
- If it says to continue a task, start working on it now
- If it says to claim, claim the next task and start working

- If `status: needs-review` and you are the reviewer, **do the review first**, then run `btrain handoff resolve --lane <id> --summary "..." --actor "<your name>"`.
- If `status: in-progress` and you are the owner, **continue the task**. Only mark `needs-review` after real completed work exists and the reviewer context is filled in. If the repo provides a `pre-handoff` skill, run it immediately before `btrain handoff update --lane <id> --status needs-review --actor "<your name>"`.
- If `status: resolved` or `idle`, claim the next task with `btrain handoff claim --lane <id> --task "..." --owner "..." --reviewer "..."`.
- **Never edit `HANDOFF_*.md` directly.** Always use `btrain handoff claim|update|resolve` to change handoff state.
- If `HANDOFF_HISTORY_PATH` is set, keep `npm run collab:watch-handoff-history` running during paired work so review-ready handoffs are archived automatically.
- On this machine, the preferred persistent setup is the shared `launchd` agent installed by `npm run collab:install-handoff-history-agent`.
- To add another repo to the archive service, register its repo root or configured handoff path with `npm run collab:register-handoff-watch -- /abs/path/to/repo`.

One model writes, the other reviews. Never edit a file the other model is actively working on.

Do not create empty handoffs. Placeholder reviewer context, no code changes, or no verification notes are not valid reasons to move a task to `needs-review`.

Mandatory handoff gate:

- Right after `btrain handoff claim`, replace any placeholder reviewer context with a real in-progress summary. Never leave "Fill this in before handoff" text on an active lane.
- Before `btrain handoff update --status needs-review`, confirm the locked files contain real reviewable work. A current diff in the locked files or a specific authored commit must exist.
- Every `needs-review` handoff must name the changed files, summarize what changed, list the verification that was run, and call out any remaining gaps or unverified paths.
- If pre-flight review shows the intended fix is already present, the diff is empty, or the user already made the change, do not send the lane to the reviewer as a no-op. Mark it stale or superseded in context and move on.

## Context Window Management

- Prompt the user to clear context at natural stopping points when the window is getting full
- Use `MEMORY.md` to capture current state before suggesting a clear
- On resume, read `MEMORY.md` plus the research docs above to pick up where work left off

## Project Skills

Project-specific skills live in `.claude/skills/`.

`btrain init` scaffolds this bundled, project-agnostic skill pack into new repos by default. Pass `--core-only` to skip bundled skill scaffolding and keep the bootstrap limited to core `btrain` files.

### Bundled skills

- `speckit-specify` - Create or refine feature specs in repos that use spec-kit (`.specify/`)
- `speckit-clarify` - Resolve ambiguities before planning in spec-kit repos
- `speckit-plan` - Generate implementation plans and design artifacts in spec-kit repos
- `speckit-tasks` - Break plans into ordered implementation tasks in spec-kit repos
- `speckit-analyze` - Run read-only cross-artifact consistency analysis in spec-kit repos
- `speckit-checklist` - Generate requirements-quality checklists in spec-kit repos
- `speckit-implement` - Execute planned implementation tasks in spec-kit repos
- `speckit-taskstoissues` - Convert `tasks.md` items into GitHub issues in spec-kit repos
- `tessl__webapp-testing` (`webapp-testing`) - Use Playwright-based local webapp testing workflows
- `tessl__yeet` (`yeet`) - Stage, commit, push, and open a draft PR, but only when the user explicitly asks for that full flow
- `secure-by-default` - Server-side trust-boundary check for auth, permissions, entitlements, and mutating endpoints
- `pre-handoff` - Quality gate before moving a lane to `needs-review`; catches placeholder context, empty diffs, and stale handoffs
- `frontend-tokens` - Validate CSS custom property usage; catches undefined tokens, bad aliases, and semantic misuse
- `integration-test-check` - Composition check when a fix spans multiple components sharing state or resources
- `deploy-debug` - Classify deployment failures before debugging
- `code-simplifier` - Simplify and refine code for clarity and consistency after implementation
- `reflect` - Post-failure reflection to turn incidents into durable prevention steps
- `skill-creator` - Create or revise repo-local skills under `.claude/skills/`
- `test-writer` - Write or expand unit, integration, and component tests

### Usage rules

- Use the Speckit skills only in repos that actually have `.specify/` and follow spec-kit workflow.
- Use `tessl__webapp-testing` / `webapp-testing` for local UI/browser validation instead of ad hoc browser workflows.
- Use `tessl__yeet` / `yeet` only for explicit commit/push/PR requests; do not invoke it for normal local edits.
- Use `secure-by-default` when touching auth, permissions, rate limits, payments, or mutating endpoints.
- Use `pre-handoff` before every `btrain handoff update --status needs-review`.
- Use `code-simplifier` after completing a feature or multi-file change, before handoff.
- Use `reflect` after meaningful failures or regressions.
- Use `skill-creator` when adding or revising skills instead of writing `SKILL.md` from scratch.
- Use `test-writer` when adding tests, expanding coverage, or writing regression tests for bug fixes.
