# btrain

**A Kanban board with mandatory peer review gates and mechanical integrity enforcement, designed for concurrent AI agents.**

btrain coordinates Claude Code, Codex, Gemini, and other AI agents working in the same repo. Lanes are WIP-limited work items moving through status columns (`idle` -> `in-progress` -> `needs-review` -> `resolved`), with feedback loops (`changes-requested`, `repair-needed`) that route work back to the writer or escalate to a human. Work is pulled, not pushed — agents claim lanes when capacity opens. File locks provide branch-level isolation without actual git branches, because AI agents share a single worktree. A watchdog auto-detects invalid state transitions, and every handoff requires structured reviewer context (files changed, verification run, review asks) — essentially a PR description built into the workflow.

The closest human equivalent: a team using a Kanban board where every card requires a PR approval before moving to "done", with automated integrity enforcement that a human board can't provide.

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org) [![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue)](#) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

```
Human types "bth" in agent chat
       |
       v
btrain handoff   <-- prints state + guidance
       |
       v
Agent follows instructions:
  idle/resolved   --> claim a task
  in-progress     --> continue working
  needs-review    --> review (if you're the reviewer)
  changes-requested --> fix findings, re-handoff
  repair-needed   --> fix workflow state
```

The source of truth is `.claude/collab/HANDOFF_*.md` (one per lane). Never edit these directly — always use the CLI.

---

## Quick Start

```bash
# Install
git clone https://github.com/codeslp/btrain.git && cd btrain && npm link

# Bootstrap a repo
btrain init /path/to/repo --agent "Claude" --agent "GPT" --agent "Gemini"

# Claim work
btrain handoff claim --lane a --task "Add auth middleware" \
  --owner "Claude" --reviewer "GPT" --files "src/auth/"

# Check guidance
btrain handoff

# Hand off for review
btrain handoff update --lane a --status needs-review --actor "Claude" \
  --preflight --changed "src/auth/index.ts" --verification "npm test" \
  --why "Auth logic drifted" --review-ask "Check unauth flows"

# Reviewer approves
btrain handoff resolve --lane a --summary "Approved." --actor "GPT"

# Or requests changes
btrain handoff request-changes --lane a \
  --summary "Need verification pass" --reason-code missing-verification \
  --actor "GPT"
```

---

## What's Included

### btrain CLI

| Command | What it does |
|---------|-------------|
| `btrain init <repo>` | Bootstrap handoff files, lanes, config, skills, dashboard, and agentchattr |
| `btrain handoff` | Print current state and what to do next |
| `btrain handoff claim` | Claim a lane with task, owner, reviewer, file locks |
| `btrain handoff update` | Update status, fill reviewer context fields |
| `btrain handoff resolve` | Approve and close a review |
| `btrain handoff request-changes` | Return review findings to the writer |
| `btrain status [--json]` | Show all lane states (JSON output for integrations) |
| `btrain doctor [--repair] [--skip-feedback]` | Health check; `--repair` fixes stale locks and workflow integrity |
| `btrain locks` | List active file locks across lanes |
| `btrain hooks` | Install managed pre-commit + pre-push guards |
| `btrain override grant` | Human-confirmed override for blocked actions |
| `btrain hcleanup` | Trim handoff history |

### Console Dashboard

`btrain init` scaffolds a local dashboard entrypoint into the target repo at `scripts/serve-dashboard.js`.

A local HUD at `http://localhost:3333` with live lane status, hot seat indicators, and file locks:

```bash
node scripts/serve-dashboard.js    # from the bootstrapped repo root
```

Features: PixiJS train animation, status-colored lane cards with hop/chug/squish animations, hot seat agent badges, expandable card details, and hazard-tape styling for repair-needed lanes.

### agentchattr

A chat UI that lets agents collaborate in real-time with live btrain integration:

```bash
cd agentchattr && ./macos-linux/start_claude.sh   # from the bootstrapped repo root
```

Features:
- **Split-pane layout** — lanes panel (left) + chat window (right)
- **Mini lane pills** — status-colored summary bar at top with dashboard animations
- **Lane cards** — status badge, LANE ID, W// R// agent meta with neon colors, hot seat designation
- **Live btrain state** — 15s polling via `btrain status --json`, WebSocket broadcasts
- **Auto-archive** — lane messages archived when task changes
- **Resizable/collapsible** lanes panel with grip drag
- **Click-to-switch** — master-detail: click a lane card to switch the chat channel

Supported agents:

| Agent | CLI | Auth | Launcher |
|-------|-----|------|----------|
| Claude | `claude` (`@anthropic-ai/claude-code`) | Subscription login | `start_claude.sh` |
| Codex | `codex` (`@openai/codex`) | Subscription login | `start_codex.sh` |
| Gemini | `gemini` (`@google/gemini-cli`) | Subscription login | `start_gemini.sh` |

Pre-flight readiness checks (`GET /api/btrain/readiness`) validate binary, auth, and working directory before launch.

---

## Lanes and Agents

Lane count = `len(active agents)` x `per_agent`:

```
1 agent,  per_agent=3  -->  lanes a, b, c
2 agents, per_agent=3  -->  lanes a, b, c, d, e, f
3 agents, per_agent=3  -->  lanes a, b, c, d, e, f, g, h, i
```

Config lives in `.btrain/project.toml`:

```toml
[project]
name = "your-repo"

[agents]
active = ["Claude", "GPT", "Gemini"]
writer_default = "Claude"
reviewer_default = "GPT"

[lanes]
enabled = true
per_agent = 3

[handoff]
# require_diff = false   # Allow needs-review without a diff (docs-only repos)

[feedback]
# enabled = false         # Opt out of feedback log scaffold and doctor warnings
```

Manage agents:

```bash
btrain agents set --repo . --agent "Claude" --agent "GPT" --lanes-per-agent 3
btrain agents add --repo . --agent "Gemini"
```

Reviewer selection: `--reviewer any-other` picks any configured peer except the owner.

---

## Handoff Lifecycle

### States

| Status | Who acts | Description |
|--------|----------|-------------|
| `idle` | Anyone | Lane is free — claim a task |
| `in-progress` | Owner (writer) | Work underway |
| `needs-review` | Reviewer | Ready for peer review |
| `changes-requested` | Owner (writer) | Reviewer sent it back |
| `repair-needed` | Repair owner | Workflow integrity issue |
| `resolved` | Anyone | Review approved — lane recyclable |

### Review Context Fields

Every `needs-review` handoff must include:

| Field | CLI flag | Purpose |
|-------|----------|---------|
| Base | `--base` | Branch or commit reference |
| Pre-flight review | `--preflight` | What you checked before handoff |
| Files changed | `--changed` (repeatable) | What files and why |
| Verification run | `--verification` (repeatable) | Tests or checks that passed |
| Remaining gaps | `--gap` (repeatable) | Unverified paths or known issues |
| Why this was done | `--why` | Motivation for the change |
| Specific review asks | `--review-ask` (repeatable) | What the reviewer should focus on |

btrain rejects `needs-review` transitions with placeholder context or empty diffs. Pass `--no-diff` to skip the diff gate for non-code changes (docs, config), or set `require_diff = false` under `[handoff]` in project.toml to disable it repo-wide.

### Reason Codes

`changes-requested`: `spec-mismatch`, `regression-risk`, `missing-verification`, `security-risk`, `integration-breakage`

`repair-needed`: `invalid-handoff`, `unreviewed-push`, `lock-mismatch`, `ownership-conflict`, `state-conflict`, `invalid-transition`, `actor-mismatch`, `contradictory-state`

---

## Feedback Tracking

btrain scaffolds a `.claude/collab/FEEDBACK_LOG.md` during init and monitors it via `btrain doctor`.

**feedback-triage skill** — Triages user-reported feedback: assess category (MINOR/BUG/SPEC) and complexity, log to the feedback log, wait for user confirmation, then drive test-first resolution or route to speckit.

**bug-fix skill** — Test-first workflow for developer-found bugs: define the bug, write a failing reproduction test, fix against it, prove it passes.

`btrain doctor` warns on:
- Missing feedback log (on initialized repos)
- Stale entries (`new` or `triaged` for >7 days)
- Entries missing required fields (Category, Status)

### Escape Hatches

| Mechanism | Scope | Effect |
|-----------|-------|--------|
| `[feedback] enabled = false` in project.toml | Per-repo | Skips feedback log scaffold and all doctor warnings |
| `--skip-feedback` on `btrain doctor` | Per-run | Suppresses feedback warnings for one invocation |
| `--core-only` on `btrain init` | Per-repo | Skips bundled skills, local dashboard + agentchattr, feedback log, and feedback guidance in managed docs |

---

## Bundled Skills

`btrain init` scaffolds these skills into `.claude/skills/` (skip with `--core-only`):

| Skill | Purpose |
|-------|---------|
| `feedback-triage` | Triage user-reported feedback into log, drive test-first resolution |
| `bug-fix` | Test-first bug investigation for developer-found bugs |
| `pre-handoff` | Quality gate before `needs-review` — catches placeholders, empty diffs |
| `reflect` | Post-failure reflection to turn incidents into prevention steps |
| `secure-by-default` | Trust-boundary check for auth, permissions, mutating endpoints |
| `integration-test-check` | Composition check when fixes span multiple components |
| `deploy-debug` | Classify deployment failures before debugging |
| `code-simplifier` | Simplify and refine code after implementation |
| `test-writer` | Write or expand unit, integration, and component tests |
| `skill-creator` | Create or revise repo-local skills |
| `frontend-tokens` | Validate CSS custom property usage |
| `speckit-*` | Spec-driven development workflow (specify, clarify, plan, tasks, analyze, checklist, implement, taskstoissues) |

---

## Git Guards

`btrain hooks` or `btrain init --hooks` installs:

- **pre-commit** — blocks commits while a lane is waiting on review
- **pre-push** — blocks pushes while unresolved handoff state exists

Override: `btrain override grant --action push --requested-by <agent> --confirmed-by <human> --reason "..."`

---

## Agent Identity

btrain verifies which agent is speaking:

1. Checks `BTRAIN_AGENT` or `BRAIN_TRAIN_AGENT` env var
2. Falls back to runtime hints + `[agents.runners]` in config
3. Prints `agent check:` line so agents can confirm identity

```toml
[agents.runners]
"Claude" = "claude -p"
"GPT" = "codex"
"Gemini" = "gemini"
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BTRAIN_AGENT` | Pin the current agent identity |
| `BRAIN_TRAIN_HOME` | Override the global btrain home directory |
| `HANDOFF_HISTORY_PATH` | Output file for the handoff history watcher |

---

## Project Structure

```
btrain/
  src/brain_train/
    cli.mjs          # CLI entry point
    core.mjs         # State machine, locks, events, watchdog
  scripts/
    serve-dashboard.js    # Console HUD (port 3333)
  agentchattr/
    app.py           # FastAPI server (port 8300)
    wrapper.py       # Agent CLI launcher + queue watcher
    readiness.py     # Pre-flight binary/auth/cwd checks
    static/          # Chat UI (HTML/CSS/JS)
    macos-linux/     # Launcher scripts per agent
  specs/             # Design specs (004-007)
  test/              # Node.js test suite
  .btrain/           # Config, events, history, locks
  .claude/collab/    # Handoff files (HANDOFF_A.md, etc.) + FEEDBACK_LOG.md
  .claude/skills/    # Bundled + custom skills
```

---

## License

MIT
