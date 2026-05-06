<!-- btrain:managed:start -->
## Brain Train Workflow

This repo uses the `btrain` collaboration workflow.

- **Always use CLI commands** (`btrain handoff`, `handoff claim`, `handoff update`, `handoff resolve`) to read and update handoff state. Do not read or edit `HANDOFF_*.md` files directly.
- Keep the lane `Delegation Packet` current for active work: `Objective`, `Deliverable`, `Constraints`, `Acceptance checks`, `Budget`, and `Done when`.
- When handing work to a reviewer, always fill the structured handoff fields: `Base`, `Pre-flight review`, `Files changed`, `Verification run`, `Remaining gaps`, `Why this was done`, and `Specific review asks`.
- When `[pr_flow].enabled` is true, peer `handoff resolve` means local review approval and advances the lane to `ready-for-pr`; use `btrain pr create|poll|request-review` until GitHub bot feedback is clear and the PR is merged.
- If the repo provides a `pre-handoff` skill, run it immediately before `btrain handoff update --status needs-review`.
- Run `btrain handoff` before acting so btrain can verify the current agent and tell you whose turn it is.
- Before editing, do a short pre-flight review of the locked files, nearby diff, and likely risk areas so you start from known problems.
- Use `rtk` (Rust Token Killer) to execute shell commands when available to minimize token usage.
- Run `btrain status` or `btrain doctor` if the local workflow files look stale.
- Repo config lives at `.btrain/project.toml`.
- Use the `feedback-triage` skill when processing user-reported issues. It logs entries to `.claude/collab/FEEDBACK_LOG.md` and drives test-first resolution.
- Use the `bug-fix` skill for developer-found bugs. Write a failing reproduction test before editing production code.

### Collaboration Setup

- Active collaborating agents: `claude`, `codex`
- Current lane target: 6 lane(s) (3 per collaborating agent): `a`, `b`, `c`, `d`, `e`, `f`
- Change `[agents].active` or `[lanes].per_agent`, then run `btrain init`, `btrain agents set`, or `btrain agents add` to scaffold missing lanes and refresh docs.

### Multi-Lane Workflow

When `[lanes]` is enabled in `project.toml`, agents work concurrently on separate lanes:

- Use `--lane <id>` (e.g. `a`, `b`, `c`, `d`, `e`, `f`) with `handoff claim|update|resolve`.
- Lock files with `--files "path/"` when claiming to prevent cross-lane collisions.
- Run `btrain locks` to see active file locks.
- When your lane is done locally, hand it to a peer reviewer while you continue on other work. In PR-flow repos, keep the lane locks through `ready-for-pr`, `pr-review`, and `ready-to-merge` until the PR merges or closes.

<!-- btrain:managed:end -->

# Agent Instructions

`CLAUDE.md` mirrors this file so Claude Code auto-loads it. The managed block above is maintained by `btrain init`.

## Source of Truth

Project knowledge lives in the research docs. Read them; don't duplicate conclusions.

| What | Where |
| --- | --- |
| Research scope and index | `research/00-research-overview.md` |
| Recommendation and phased strategy | `research/07-recommendation.md` |
| Harness evaluation | `research/09-harness-evaluation.md` |
| Harness recommendations | `research/10-harness-recommendations.md` |
| Session continuity | `.claude/projects/*/memory/MEMORY.md` |

## Agent Rules

- No hardcoded API keys or paths — use env vars.
- Edit over create. Don't touch `.claude/settings*.json` unless asked.
- Research-first: ground recommendations in the docs above.
- Runtime alias: collaborator `GPT` → Codex runtime via `[agents.runners]` in `.btrain/project.toml`.

## Proactivity

When the user or a workflow signal (handoff, lane status, delegation packet, review request) names a concrete next step, **do it**. Do not summarize the step as a "next actionable item" and stop to ask permission. Ask only when the request is genuinely ambiguous, destructive, or out of scope.

## After `btrain handoff` (and `bth`)

`btrain handoff` tells you whose turn it is. Execute — don't just print the status.

- **needs-review, you are reviewer** → do the review now, then `btrain handoff resolve --lane <id> --summary "..." --actor "..."`. In PR-flow repos this local approval moves to `ready-for-pr`, not final `resolved`.
- **ready-for-pr, you are owner** → run `btrain pr create --lane <id> --bots all` or link an existing PR and move to `pr-review`.
- **pr-review** → run `btrain pr poll --lane <id> --apply`; address bot feedback, push, and run `btrain pr request-review --lane <id> --bots all` until clear.
- **ready-to-merge** → merge the PR, then run `btrain pr poll --lane <id> --apply` so btrain final-resolves and releases locks.
- **in-progress, you are owner** → keep working on the task. Only flip to `needs-review` after real completed work exists, reviewer context is filled in, and the `pre-handoff` skill has run.
- **resolved or idle** → `btrain handoff claim --lane <id> --task "..." --owner "..." --reviewer "..."` and start working immediately.
- `bth` in agent chat means the same thing: run `btrain handoff`, then do the work it points to. Never print status and stop.

## Handoff Gate

One model writes, the other reviews. Never edit a file the other model is actively working on.

- **Claim**: replace placeholder reviewer context with a real in-progress summary immediately.
- **needs-review**: locked files must contain a real diff (or pass `--no-diff` for docs-only). The handoff must name changed files, what changed, verification run, and remaining gaps. Run the `pre-handoff` skill first.
- If the fix is already present, the diff is empty, or the user already made the change, mark the lane stale/superseded — don't send a no-op to review.
- If `HANDOFF_HISTORY_PATH` is set, keep `npm run collab:watch-handoff-history` running, or install the shared launchd agent via `npm run collab:install-handoff-history-agent`. Register new repos with `npm run collab:register-handoff-watch -- /abs/path/to/repo`.

## Context Window

Prompt the user to clear context at natural stopping points when the window fills. Write current state to `MEMORY.md` first; resume by reading `MEMORY.md` plus the research docs.

## Skills

Project skills live in `.claude/skills/` and are auto-surfaced by the harness with trigger descriptions — don't duplicate them here. `btrain init` scaffolds the bundled pack; pass `--core-only` to skip.
