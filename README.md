# btrain

**A Kanban board with mandatory peer review gates and mechanical integrity enforcement, designed for concurrent AI agents.**

btrain coordinates Claude Code, Codex, Gemini, and other AI agents working in the same repo. Lanes are WIP-limited work items moving through status columns (`idle` -> `in-progress` -> `needs-review` -> `ready-for-pr` -> `pr-review` -> `ready-to-merge` -> `resolved`), with feedback loops (`changes-requested`, `repair-needed`) that route work back to the writer or escalate to a human. Work is pulled, not pushed — agents claim lanes when capacity opens. File locks provide branch-level isolation without actual git branches, because AI agents share a single worktree. A watchdog auto-detects invalid state transitions, every active lane carries a structured delegation packet, and every handoff requires structured reviewer context (files changed, verification run, review asks) — essentially a PR description plus a worker contract built into the workflow.

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
  ready-for-pr     --> create/link a GitHub PR
  pr-review        --> wait for bot feedback, poll PR status
  ready-to-merge   --> merge the PR, then resolve
  changes-requested --> fix findings, re-handoff
  repair-needed   --> fix workflow state
```

The source of truth is `.claude/collab/HANDOFF_*.md` (one per lane). Never edit these directly — always use the CLI.

PR flow is opt-in per repo:

```toml
[pr_flow]
enabled = true
base = "main"
required_bots = ["codex", "unblocked"]
```

---

## Quick Start

```bash
# Install
git clone https://github.com/codeslp/btrain.git && cd btrain && npm link

# Bootstrap a repo
btrain init /path/to/repo --agent "claude" --agent "codex" --agent "gemini"

# Launch the chat UI with all agents
btrain-chat all /path/to/repo

# Or launch a single agent
btrain-chat codex /path/to/repo
btrain-chat claude /path/to/repo

# Claim work
btrain handoff claim --lane a --task "Add auth middleware" \
  --owner "claude" --reviewer "codex" --files "src/auth/"

# Check guidance
btrain handoff

# Hand off for review (poller auto-notifies the reviewer in #agents)
btrain handoff update --lane a --status needs-review --actor "claude" \
  --preflight --changed "src/auth/index.ts" --verification "npm test" \
  --why "Auth logic drifted" --review-ask "Check unauth flows"

# Reviewer approves
btrain handoff resolve --lane a --summary "Approved." --actor "codex"

# In repos with [pr_flow].enabled = true, local approval moves to ready-for-pr:
btrain pr create --lane a --bots all
btrain pr poll --lane a --apply

# If bots request changes, fix/push and request them again
btrain pr request-review --lane a --bots all

# When the PR is merged, poll once more to release locks and resolve the lane
btrain pr poll --lane a --apply

# Or requests changes
btrain handoff request-changes --lane a \
  --summary "Need verification pass" --reason-code missing-verification \
  --actor "codex"
```

---

## What's Included

### btrain CLI

| Command | What it does |
|---------|-------------|
| `btrain init <repo>` | Bootstrap handoff files, lanes, config, skills, dashboard, and agentchattr |
| `btrain handoff` | Print current state and what to do next |
| `btrain handoff claim` | Claim a lane with task, owner, reviewer, file locks, and a delegation packet |
| `btrain handoff update` | Update status, delegation packet fields, and reviewer context |
| `btrain handoff resolve` | Approve local review; in PR-flow repos this advances to `ready-for-pr` |
| `btrain handoff request-changes` | Return review findings to the writer |
| `btrain pr create` | Push the branch, create a GitHub PR, link it to the lane, and request bot reviews |
| `btrain pr status` | Classify current PR bot review state |
| `btrain pr poll` | Fetch PR comments, classify feedback, and optionally update lane status |
| `btrain pr request-review` | Re-request configured bot reviews |
| `btrain status [--json]` | Show all lane states (JSON output for integrations) |
| `btrain doctor [--repair] [--skip-feedback]` | Health check; `--repair` fixes stale locks and workflow integrity |
| `btrain locks` | List active file locks across lanes |
| `btrain harness list` | List bundled and repo-local harness profiles plus the configured active profile |
| `btrain harness inspect` | Inspect one harness profile, its source path, and its probe-first metadata |
| `btrain startup` | Print a compact repo/bootstrap snapshot for a newly launched agent |
| `btrain hooks` | Install managed pre-commit + pre-push guards |
| `btrain override grant` | Human-confirmed override for blocked actions |
| `btrain hcleanup` | Trim handoff history |

## Harness Discovery

Use the probe-first harness commands before changing workflow prompts or context wiring:

```bash
btrain harness list --repo .
btrain harness inspect --repo . --profile default
```

`btrain harness list` shows the configured active profile and every bundled or repo-local profile the loader can see. `btrain harness inspect` shows the selected profile's description, purpose, dispatch prompt, source path, and the registry/schema metadata behind it.

Repo-local overrides live under `.btrain/harness/`:

```text
.btrain/harness/
├── registry.json
└── profiles/
    └── <profile>.json
```

## Startup vs Go

Use `btrain startup --repo .` for a compact first-turn packet: current branch and dirty summary, active agents/lanes, active harness profile, the most relevant lane focus, and the next commands to run.

Use `btrain go --repo .` when you need the broader bootstrap inventory of files and directories to read. `startup` is the quick orientation surface; `go` is the deeper file-reading checklist.

### Console Dashboard

`btrain init` scaffolds a local dashboard entrypoint plus the handoff-history helpers into the target repo under `scripts/`.

A local HUD at `http://localhost:3333` with live lane status, hot seat indicators, and file locks:

```bash
node scripts/serve-dashboard.js    # from the bootstrapped repo root
```

Features: PixiJS train animation, status-colored lane cards with hop/chug/squish animations, hot seat agent badges, expandable card details, and hazard-tape styling for repair-needed lanes.

### agentchattr (Multi-Agent Chat)

A chat UI where Claude, Codex, and Gemini collaborate in real-time with live btrain integration.

**Launch agents on any repo:**

```bash
cd agentchattr && ./macos-linux/start_claude.sh   # from the bootstrapped repo root
```

Then open **http://127.0.0.1:8300** — the repo name shows in the header.

**Features:**
- **Split-pane layout** — lanes panel (left) + chat window (right)
- **Mini lane pills** — status-colored summary bar with dashboard animations
- **Lane cards** — status badge, LANE ID, W// R// agent meta, hot seat designation
- **Live btrain state** — 5s polling via `btrain status --json`, WebSocket broadcasts
- **Auto-notify** — poller auto-posts @mentions to `#agents` on handoff transitions
- **Self-healing** — content-hash dedup ensures notifications re-send if lost
- **Auto-archive** — lane messages archived when task changes
- **Resizable/collapsible** lanes panel with grip drag
- **Click-to-switch** — master-detail: click a lane card to switch the chat channel

**Supported agents:**

| Agent | CLI | Install | Auth |
|-------|-----|---------|------|
| Claude | `claude` | `npm i -g @anthropic-ai/claude-code` | Subscription login |
| Codex | `codex` | `npm i -g @openai/codex` | Subscription login |
| Gemini | `gemini` | `npm i -g @google/gemini-cli` | Subscription login |

**Also needed:** `tmux` (`brew install tmux`) and `ripgrep` (`brew install ripgrep`) for Gemini.

Pre-flight readiness checks (`btrain-chat status` or `GET /api/btrain/readiness`) validate binary, auth, and working directory before launch.

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

### Delegation Packet

Every active lane may carry a structured `Delegation Packet` describing the contract for the work:

| Field | CLI flag | Purpose |
|-------|----------|---------|
| Objective | `--objective` | What the lane is trying to achieve |
| Deliverable | `--deliverable` | Expected reviewable output or artifact |
| Constraints | `--constraint` (repeatable) | Scope, safety, or workflow boundaries |
| Acceptance checks | `--acceptance` (repeatable) | What must be true for the lane to count as done |
| Budget | `--budget` | Effort or scope budget for the current pass |
| Done when | `--done-when` | Concrete completion condition |

`btrain handoff claim` seeds these fields with useful defaults, and `btrain handoff update` can refine them as the lane is clarified or re-scoped.

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

`btrain init` scaffolds these skills into `.claude/skills/` and `.agents/skills/` (skip with `--core-only`). Re-run `btrain sync-skills --force --skill <name>` to refresh an existing local mirror from the bundled source; omit `--skill` to sync the whole bundle, and omit `--force` to preserve local edits while restoring missing files.

| Skill | Purpose |
|-------|---------|
| `feedback-triage` | Triage user-reported feedback into log, drive test-first resolution |
| `bug-fix` | Test-first bug investigation for developer-found bugs |
| `pre-handoff` | Quality gate before `needs-review` — catches placeholders, empty diffs |
| `reflect` | Post-failure reflection to turn incidents into prevention steps |
| `secure-by-default` | Trust-boundary check for auth, permissions, mutating endpoints |
| `integration-test-check` | Composition check when fixes span multiple components |
| `deploy-debug` | Classify deployment failures before debugging |
| `code-simplifier` | Simplify recent code and surface architecture-deepening opportunities |
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
  .agents/skills/    # Bundled + custom skills for agents that read .agents
```

---

## Credits

The `agentchattr/` chat UI is built on [agentchattr](https://github.com/bcurts/agentchattr) by [@bcurts](https://github.com/bcurts). btrain extends it with btrain lane integration, auto-notify handoff routing, split-pane lane cards, and multi-agent orchestration.

---

## License

MIT
