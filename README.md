# btrain

**A file-backed handoff protocol for multi-agent AI coding.**

btrain coordinates task handoffs between AI coding agents — one writes, one reviews — using structured markdown files in your repo. Supports concurrent work lanes so both agents stay productive. No database. No cloud service. No lock-in.

Built for teams using Claude Code, OpenAI Codex, Antigravity, or any combination of AI coding assistants on the same codebase.

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org) [![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue)](#) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## The Problem

When you use two or more AI coding agents on the same repo, things break fast:

- **Context desync** — Agent A edits files that Agent B already has cached in context
- **Review confusion** — No clear protocol for who reviews what, or when
- **Status ambiguity** — Both agents think they're the one working
- **File conflicts** — Two agents edit the same file simultaneously
- **No audit trail** — You can't see what happened three handoffs ago

These problems get worse the more capable the agents get. GPT-5 and Claude Opus 4 can each do excellent work in isolation, but pointing both at the same codebase without coordination produces chaos.

### What Exists Today

| Tool | Approach | Limitation |
|---|---|---|
| **Claude Squad** | tmux multiplexer + git worktrees | Parallel isolation, not sequential handoff |
| **Manual relay** | Copy-paste between agent chats | No audit trail, doesn't scale |
| **CrewAI / AutoGen** | Python frameworks for agent pipelines | Built for LLM API chains, not coding IDE agents |

None of these solve the core problem: **structured, auditable, sequential handoffs between IDE-embedded coding agents sharing one repo.**

---

## How btrain Works

### Single-Lane Mode (Default)

```
┌──────────────┐     HANDOFF.md      ┌──────────────┐
│  Claude Code │ ◄──────────────────► │   Codex CLI  │
│  (writes)    │    1 file, git-     │  (reviews)   │
│              │    tracked, human-  │              │
└──────────────┘    readable         └──────────────┘
                         │
                    ┌────┴────┐
                    │  Human  │
                    │ (types  │
                    │  bth)   │
                    └─────────┘
```

### Multi-Lane Mode (Concurrent)

```
┌──────────────┐  HANDOFF_A.md  ┌──────────────┐  HANDOFF_B.md  ┌──────────────┐
│  Claude Code │ ◄────────────► │    Human     │ ◄────────────► │   Codex CLI  │
│  owns lane A │  locks.json    │  (types bth) │  locks.json    │  owns lane B │
│  reviews B   │                │              │                │  reviews A   │
└──────────────┘                └──────────────┘                └──────────────┘
```

Both agents work simultaneously on separate lanes with file-level locking. When one finishes, the other reviews — nobody idles.

1. **Structured files** — `HANDOFF.md` (single) or `HANDOFF_A.md` + `HANDOFF_B.md` (lanes)
2. **CLI-driven** — `btrain handoff claim|update|resolve` manages transitions
3. **Agent-agnostic** — Works with Claude, Codex, Antigravity, or any tool that can read files and run shell commands
4. **Git-native** — The handoff file is tracked in git, giving you full history
5. **Human-in-the-loop** — You type `bth` in each agent's chat to relay the handoff
6. **File locking** — `--files` flag + pre-commit hook prevent cross-lane collisions

### The bth Command

`bth` is shorthand for "run `btrain handoff` and immediately act on what it says." When an agent sees `bth`:

1. It runs `btrain handoff` to read the current state
2. If it's the **owner** and status is `in-progress` → it does the work
3. If it's the **reviewer** and status is `needs-review` → it reviews the code
4. It only transitions to `needs-review` after real completed work exists, reviewer context is filled in, and the handoff is ready for review
5. When done, it runs `btrain handoff update` or `btrain handoff resolve` to transition the state

Empty handoffs are protocol violations. Do not flip a lane to `needs-review` with placeholder context, no concrete work, or no verification notes.

The human just types `bth` in each agent window. The agents handle the rest.

---

## Quick Start

```bash
# Install
git clone https://github.com/codeslp/btrain.git
cd btrain && npm link

# Bootstrap a repo
btrain init /path/to/your/repo

# Claim a task (single-lane)
btrain handoff claim --task "Implement auth middleware" \
  --owner "Claude" --reviewer "GPT-5 Codex"

# Check state (or type bth in an agent chat)
btrain handoff

# Owner finishes real work → hand to reviewer
btrain handoff update --status needs-review --actor "Claude"

# Reviewer resolves
btrain handoff resolve --summary "Approved. Clean implementation." --actor "GPT-5 Codex"
```

### Multi-Lane Quick Start

```bash
# Add [lanes] to .btrain/project.toml, then re-init
btrain init .

# Both agents claim separate lanes with file locks
btrain handoff claim --lane a --task "Auth module" \
  --owner "Claude" --reviewer "Codex" --files "src/auth/"

btrain handoff claim --lane b --task "Scoring engine" \
  --owner "Codex" --reviewer "Claude" --files "src/scoring/"

# Each works on their lane, then swaps for review
btrain handoff update --lane a --status needs-review --actor "Claude"
btrain handoff resolve --lane a --summary "Approved" --actor "Codex"

# Check locks
btrain locks
```

---

## Recommended Pairing: Spec Kit

btrain was built and spec'd using [Spec Kit](https://github.com/the-spec-kit/spec-kit), a spec-driven planning tool for AI coding projects. We recommend using them together:

- **Spec Kit** handles planning — constitution, specs, plans, tasks
- **btrain** handles execution — who works on what, when, and how the handoff flows

The workflow: `/speckit.specify` → `/speckit.plan` → `/speckit.tasks` → `btrain handoff claim` → `bth` relay

**Planned integration**: `btrain handoff claim --from-spec specs/001-feature/tasks.md` — auto-create a handoff from the next unchecked task in a Spec Kit tasks file.

---

## Requirements

- **Node.js 18+** — ESM, built-in modules only
- **Zero npm dependencies** — no external packages
- **Python 3 + `anthropic` + `openai`** — only needed for automated review modes (`parallel` / `hybrid`)
- **macOS** — only needed for the optional persistent launchd history watcher

---

## ⚠️ Security Configuration

btrain coordinates agents that have access to your filesystem. Understand these trust boundaries:

### Agent Permission Models

Each agent CLI has its own permission/sandbox model. btrain does **not** bypass these.

| Agent | Permission Model | Recommended Setting |
|---|---|---|
| **Claude Code** | Tool allowlist via `.claude/settings.json` | Use default or custom allowlist; avoid `--permission-mode bypassPermissions` in production |
| **Codex CLI** | Sandbox mode (`--full-auto` vs default) | Default sandbox blocks network; `--full-auto` is more permissive — use with caution |
| **Antigravity** | IDE-embedded, inherits VS Code permissions | Standard VS Code file access rules apply |

> [!CAUTION]
> Running agents with `--permission-mode bypassPermissions` (Claude) or `--full-auto` (Codex) gives them unrestricted filesystem and network access. Only use these modes in isolated environments or when you fully trust the task.

### Locked Files

When claiming a task, specify `--files` to declare which files the owner is editing. In multi-lane mode, `--files` also acquires locks in `.btrain/locks.json` — other lanes are blocked from claiming overlapping files.

### Pre-Commit Hook

```bash
btrain init . --hooks
```

Installs a git pre-commit hook that:
- Blocks commits when any `HANDOFF` file shows `needs-review` and non-handoff files are staged
- In multi-lane mode, blocks commits touching files locked by another lane

Bypass with `git commit --no-verify` when needed.

### Review Mode Trust

| Mode | What Happens | Trust Level |
|---|---|---|
| `manual` | Human reviews in agent chat | Full human oversight |
| `parallel` | 3 LLM reviewers run independently | Automated — review the report before merging |
| `hybrid` | Parallel + sequential chain for sensitive paths | Automated with routing — still review before merging |

> [!IMPORTANT]
> Automated review modes (`parallel`, `hybrid`) are decision-support tools, not replacements for human judgment. Always read the generated report in `.btrain/reviews/` before acting on automated review results.

---

## Commands

All commands accept `--repo <path>` to target a specific repo. Without it, `btrain` walks up from the current working directory looking for `.btrain/project.toml`.

### `btrain init <repo-path> [--hooks]`

Bootstrap a repo for agent collaboration.

- Creates `.btrain/project.toml`, `.btrain/reviews/`, `.claude/collab/HANDOFF.md`
- Writes a managed `## Brain Train Workflow` block into `AGENTS.md` and `CLAUDE.md`
- Registers the repo in the global registry
- `--hooks`: installs a pre-commit guard (see Security)

Safe to re-run — only the managed block is updated.

### `btrain handoff [--repo <path>]`

Read the current state and print guidance for the calling agent.

### `btrain handoff claim --task <text> --owner <name> --reviewer <name>`

Claim a new task. Sets status to `in-progress`, resets reviewer context and review response.

With lanes: `--lane <id>` targets a specific lane, `--files <paths>` acquires file locks.

### `btrain handoff update [--status <status>] [--actor <name>] [...]`

Patch any subset of handoff fields. Use `--actor` to stamp `Last Updated`. Do not use `update --status needs-review` for empty handoffs; only hand off when real work and reviewer context are ready.

With lanes: `--lane <id>` targets a specific lane.

### `btrain handoff resolve --summary <text> [--next <text>] --actor <name>`

Resolve the current handoff. Updates status, writes review response, appends to history. In multi-lane mode, auto-releases file locks for the resolved lane.

With lanes: `--lane <id>` targets a specific lane.

### `btrain locks [--repo <path>]`

List all active file locks across lanes.

### `btrain locks release --path <path>`

Force-release a specific file lock.

### `btrain locks release-lane --lane <id>`

Release all locks for a lane.

### `btrain loop [--repo <path>] [--dry-run] [--max-rounds <n>] [--timeout <sec>]`

Relay handoffs automatically between configured agent runners.

- Reads `[agents.runners]` from `.btrain/project.toml`
- Supports `notify` (wait for manual action) and CLI dispatch (`claude -p`, `codex`)
- `--dry-run` shows what would happen without executing
- Streams live progress from Claude and Codex CLIs

> [!NOTE]
> **Current limitation**: Agent CLI sandboxes (Codex's `sandbox-exec`, Claude's permission model) often block the nested subprocess calls that `btrain loop` needs. The loop logic works correctly — dispatching, polling, timeouts, and dry-run are all tested and functional — but real-world use requires agents to have sufficient permissions to run `btrain` commands as subprocesses. For now, the manual `bth` relay is more reliable. See [Loop Status](#loop-status) below.

### `btrain review run [--mode <manual|parallel|hybrid>]`

Run automated review. `parallel` runs 3 independent reviewers. `hybrid` adds a sequential chain for sensitive paths/patterns.

### `btrain review status`

Show review mode, config flags, and latest review artifact.

### `btrain status [--repo <path>]`

Show handoff state across all registered repos. In multi-lane mode, shows per-lane status.

### `btrain doctor [--repo <path>]`

Check registry and repo health. Reports missing files, stale entries, managed block drift. In multi-lane mode, also checks lane handoff files, `locks.json` validity, and stale/overlapping locks.

### `btrain sync-templates [--repo <path>]`

Re-sync the managed btrain block in `AGENTS.md` and `CLAUDE.md`.

### `btrain hooks [--repo <path>]`

Install the pre-commit guard on an already-initialized repo.

### `btrain repos`

List all registered repos.

---

## Loop Status

`btrain loop` was built to automate the `bth` relay — watch `HANDOFF.md`, dispatch the right agent CLI, repeat until resolved. The implementation is complete and tested (29/29 tests pass, including streaming, dry-run, max-rounds guards, and notify-mode fallback).

**Why it doesn't fully work in practice:**

Both Claude Code and Codex CLI have sandbox/permission models that block nested subprocess calls:

- **Codex** (`--full-auto`): Its sandbox uses `sandbox-exec` which blocks child processes from running `btrain` commands. Error: `sandbox_apply: Operation not permitted`
- **Claude Code** (`-p`): Requires explicit permission flags (`--permission-mode bypassPermissions`) which is not safe for production use
- **Antigravity**: IDE-embedded, no CLI to dispatch at all — uses `notify` mode (loop waits for manual action)

**Current recommendation**: Use `bth` manually in each agent's chat window. The loop infrastructure exists and will become practical as agent CLI tools improve their headless/orchestration support.

**What still works from the loop feature:**
- `btrain loop --dry-run` — shows what would happen
- `[agents.runners]` config in `project.toml` — documents your agent setup
- Streaming progress parsing for Claude and Codex JSON output
- The full test suite validates the dispatch/poll/timeout logic

---

## Project Config (`.btrain/project.toml`)

```toml
name = "your-repo"
repo_path = "/absolute/path/to/your-repo"
handoff_path = ".claude/collab/HANDOFF.md"
default_review_mode = "manual"

[agents]
writer_default = ""
reviewer_default = ""

[agents.runners]
"Claude" = "claude -p"     # CLI dispatch
"Opus 4.6" = "notify"      # IDE-only (Antigravity)
"GPT-5 Codex" = "codex"    # CLI dispatch

[reviews]
parallel_enabled = true
hybrid_path_triggers = ["routes", "auth", "middleware"]
hybrid_content_triggers = ["(password|secret|token)"]

[lanes]                      # Optional: enable concurrent work
enabled = true

[lanes.a]
handoff_path = ".claude/collab/HANDOFF_A.md"

[lanes.b]
handoff_path = ".claude/collab/HANDOFF_B.md"

[instructions]
project_notes = ""
```

---

## HANDOFF.md Format

`.claude/collab/HANDOFF.md` (or `HANDOFF_A.md`/`HANDOFF_B.md` in lane mode) is the source of truth. Always use `btrain handoff claim|update|resolve` — never edit directly.

```markdown
## Current

Task: <short description>
Owner: <agent doing the work>
Reviewer: <agent reviewing>
Status: idle | in-progress | needs-review | resolved
Review Mode: manual | parallel | hybrid
Lane: a | b                          # Only in multi-lane mode
Locked Files: <comma-separated, or empty>
Next Action: <what happens next>
Last Updated: <agent name + ISO timestamp>

## Context for Reviewer
<owner fills this before handing to reviewer>

## Review Response
<reviewer writes their response>

## Previous Handoffs
- YYYY-MM-DD — <task> (<agent>): <outcome>
```

---

## File Layout

```
your-repo/
  AGENTS.md                         # Managed btrain block + custom instructions
  CLAUDE.md                         # Same — auto-loaded by Claude Code
  .btrain/
    project.toml                    # Repo config
    reviews/                        # Review reports from automated runs
    locks.json                      # File lock registry (multi-lane only)
  .claude/
    collab/
      HANDOFF.md                    # Collaboration state (single-lane)
      HANDOFF_A.md                  # Lane A state (multi-lane)
      HANDOFF_B.md                  # Lane B state (multi-lane)

$BRAIN_TRAIN_HOME/                  # Default: ~/.btrain
  repos.json                        # Registry of all bootstrapped repos
  templates/                        # Seed templates (auto-updated)
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRAIN_TRAIN_HOME` | No | `~/.btrain` | Override global config directory |
| `HANDOFF_HISTORY_PATH` | Watcher only | — | Path to the history log file |

---

## How Agents Use btrain

1. At session start, the agent runs `btrain handoff`
2. The CLI prints the current state and plain-English guidance
3. The agent follows the guidance:
   - `idle` / `resolved` → claim a task (with `--lane` and `--files` if lanes are enabled)
   - `in-progress` (owner) → do the work, fill in reviewer context, and only then run `btrain handoff update --status needs-review`
   - `needs-review` (reviewer) → review, then `btrain handoff resolve --summary "..."`
   - Not your turn → work on your other lane, or wait
4. The human types `bth` in each agent window to trigger the relay

Always use CLI subcommands. Never edit handoff files directly.

---

## License

MIT
