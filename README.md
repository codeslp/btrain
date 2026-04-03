# btrain

**A file-backed handoff protocol for multi-agent AI coding.**

btrain coordinates task handoffs between AI coding agents — one writes, one reviews — using a single structured markdown file in your repo. No database. No cloud service. No lock-in.

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

```
┌──────────────┐     HANDOFF_A.md    ┌──────────────┐
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

1. **State files** — `.claude/collab/HANDOFF_A.md` (and related lanes) hold the entire collaboration state
2. **CLI-driven** — `btrain handoff claim|update|resolve` manages transitions
3. **Agent-agnostic** — Works with Claude, Codex, Antigravity, or any tool that can read files and run shell commands
4. **Git-native** — The handoff file is tracked in git, giving you full history
5. **Human-in-the-loop** — You type `bth` in each agent's chat to relay the handoff

### The bth Command

`bth` is shorthand for "run `btrain handoff` and immediately act on what it says." When an agent sees `bth`:

1. It runs `btrain handoff` to read the current state
2. If it's the **owner** and status is `in-progress` → it does the work
3. If it's the **reviewer** and status is `needs-review` → it reviews the code
4. When done, it runs `btrain handoff update` or `btrain handoff resolve` to transition the state

The human just types `bth` in each agent window. The agents handle the rest.

By default, `btrain init` also scaffolds this repo's bundled, project-agnostic skill pack into `.claude/skills/` in the target repo. That bundle includes collaboration helpers such as `pre-handoff`, `code-simplifier`, `test-writer`, `secure-by-default`, Speckit skills, `webapp-testing`, and `yeet`. The excluded `create-multi-speaker-static-recordings-using-tts` skill is never copied. Pass `--core-only` to skip bundled skills and initialize only the core `btrain` files.

---

## Quick Start

```bash
# Install
git clone https://github.com/codeslp/ai-sales-brain-train.git
cd btrain && npm link

# Bootstrap a repo and declare the active collaborators
btrain init /path/to/your/repo \
  --agent "Claude" \
  --agent "GPT-5 Codex"

# Add --core-only if you want only the core btrain files/docs
# and do not want the bundled .claude/skills pack

# Claim a task
btrain handoff claim --task "Implement auth middleware" \
  --owner "Claude" --reviewer "GPT-5 Codex"

# Check state (or type bth in an agent chat)
btrain handoff

# Before handing off, run the repo's pre-handoff skill if it has one

# Owner finishes → hand to reviewer
btrain handoff update --status needs-review --actor "Claude" \
  --base feat/auth-middleware \
  --preflight \
  --changed "src/api/auth.ts — tighten token validation" \
  --changed "README.md — document new auth behavior" \
  --verification "node --test test/core.test.mjs" \
  --gap "Did not re-run full browser login flow" \
  --why "Auth verification and docs drifted; reviewer should confirm both code and docs stay aligned." \
  --review-ask "Verify the new auth path does not break existing login flows" \
  --review-ask "Check that the README example matches runtime behavior"

# Reviewer resolves
btrain handoff resolve --summary "Approved. Clean implementation." --actor "GPT-5 Codex"
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

### API Keys

btrain itself does **not** use API keys. However, the agents it coordinates do.

- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are used by `btrain review run` (the automated review script)
- These keys are read from your environment — btrain never stores, logs, or transmits them
- **Risk**: If an agent edits `.bashrc`, `.zshrc`, or `.env` files, it could exfiltrate keys. Use your agent's permission model to block writes to dotfiles.

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

When claiming a task, specify `--files` to declare which files the owner is editing. The reviewer and other agents should respect this lock. btrain logs locked files in the active lane's handoff file but does not enforce locking at the filesystem level — enforcement relies on agents reading and respecting the handoff state.

### Pre-Commit Hook

```bash
btrain init . --hooks
```

Installs a git pre-commit hook that blocks commits when the handoff file shows `needs-review` and non-handoff files are staged. This prevents the owner from committing while the reviewer is working. Bypass with `git commit --no-verify` when needed.

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

### `btrain init <repo-path> [--hooks] [--agent <name>]... [--lanes-per-agent <n>] [--core-only]`

Bootstrap a repo for agent collaboration.

- Creates `.btrain/project.toml`, `.btrain/reviews/`, `.claude/collab/HANDOFF_A.md`
- Writes a managed `## Brain Train Workflow` block into `AGENTS.md` and `CLAUDE.md`
- Scaffolds the bundled, project-agnostic `.claude/skills/` pack unless `--core-only` is passed
- Registers the repo in the global registry
- `--agent <name>` is repeatable. It seeds `[agents].active`
- `--lanes-per-agent <n>` sets `[lanes].per_agent`
- `--core-only` skips bundled skill scaffolding and writes only the core btrain config/docs/handoff files
- `--hooks`: installs a pre-commit guard (see Security)

Safe to re-run — it refreshes the managed block, updates `[agents].active` and `[lanes].per_agent` when those flags are passed, scaffolds any missing lane sections/files, and adds only missing bundled skill files without overwriting existing skill content.

### `btrain agents set --repo <path> --agent <name>... [--lanes-per-agent <n>]`

Replace the active agent list for an existing repo, then refresh the managed docs and scaffold any missing lane sections/files. This command does not change bundled skills.

### `btrain agents add --repo <path> --agent <name>... [--lanes-per-agent <n>]`

Append one or more active agents without retyping the whole list. This also refreshes the managed docs and scaffolds any additional lanes/files required by the new collaborator count. This command does not change bundled skills.

### `btrain handoff [--repo <path>]`

Read the current state and print guidance for the calling agent.

### `btrain handoff claim --task <text> --owner <name> [--reviewer <name|any-other>]`

Claim a new task. Sets status to `in-progress`, resets reviewer context and review response.

- `--reviewer <name|any-other>` is optional and defaults to picking any configured agent except the owner
- If `--reviewer` matches the owner and another configured agent exists, btrain snaps the reviewer to a peer automatically

### `btrain handoff update [--status <status>] [--actor <name>] [...]`

Patch any subset of handoff fields. Use `--actor` to stamp `Last Updated`.

Common reviewer-context flags:

- `--base <ref>` sets the branch or commit under review
- `--preflight [text]` marks or describes the pre-flight review
- `--changed <text>` is repeatable and adds one changed-file bullet
- `--verification <text>` is repeatable and adds one verification bullet
- `--gap <text>` is repeatable and adds one remaining-gap bullet
- `--why <text>` explains why the change was made
- `--review-ask <text>` is repeatable and adds one specific review ask

If the repo defines a `pre-handoff` skill, run it immediately before `btrain handoff update --status needs-review` so the structured fields are complete and non-placeholder.

You can also pass `--reviewer any-other` here when moving to `needs-review` if you want btrain to keep or infer any valid peer reviewer other than the acting owner.

### `btrain handoff resolve --summary <text> [--next <text>] --actor <name>`

Resolve the current handoff. Updates status, writes review response, appends to history.

### `btrain hcleanup [--repo <path>] [--keep <n>]`

Trim the `## Previous Handoffs` section in each lane's handoff file.

- Keeps the most recent `<n>` entries per lane (default: 3)
- Archived entries are appended to `~/agent_collab_history/<repo>_agents_collab/<repo>.md`
- Iterates all configured lanes, not just a–d

### `btrain register <repo-path>`

Register an existing repo in the global registry without running the full `init` bootstrap. Useful when a repo was already initialized but moved or re-cloned.

### `btrain review run [--mode <manual|parallel|hybrid>]`

Run automated review. `parallel` runs 3 independent reviewers. `hybrid` adds a sequential chain for sensitive paths/patterns.

### `btrain review status`

Show review mode, config flags, and latest review artifact.

### `btrain status [--repo <path>]`

Show handoff state across all registered repos.

### `btrain doctor [--repo <path>]`

Check registry and repo health. Reports missing files, stale entries, and managed block drift.

### `btrain sync-templates [--repo <path>]`

Re-sync the managed btrain block in `AGENTS.md` and `CLAUDE.md`.

### `btrain hooks [--repo <path>]`

Install the pre-commit guard on an already-initialized repo.

### `btrain repos`

List all registered repos.

---

## Loop Status

**`btrain loop` does not work in practice.** The code is complete and tested, but every major agent CLI blocks it:

- **Codex** (`--full-auto`): `sandbox-exec` blocks child processes from running `btrain`. Error: `sandbox_apply: Operation not permitted`
- **Claude Code** (`-p`): Requires `--permission-mode bypassPermissions` which is unsafe for production
- **Antigravity**: No CLI at all — always falls back to notify mode (wait for human)

**Use `bth` manually in each agent's chat window.** The loop infrastructure will become practical if/when agent CLIs support better headless orchestration.

`btrain loop --dry-run` works and is useful for seeing the dispatch plan without executing anything.

---

## Multi-Lane Workflow

btrain supports concurrent lanes so two agents can work on independent tasks at the same time, each with its own handoff file and file locks.

### Enabling Lanes

The lane count is derived from `[agents].active` and `[lanes].per_agent`.

- Default: btrain scaffolds **2 lanes per active collaborator**
- If no active agents are configured yet, btrain falls back to a 2-collaborator scaffold
- 1 active agent with `per_agent = 3` → lanes `a` through `c`
- 2 active agents with `per_agent = 3` → lanes `a` through `f`
- 3 active agents with `per_agent = 2` → lanes `a` through `f`
- After changing `[agents].active` or `[lanes].per_agent`, run `btrain init`, `btrain agents set`, or `btrain agents add` to refresh the managed docs and scaffold any missing lanes

For a 2-agent setup, `.btrain/project.toml` looks like:

```toml
[agents]
active = ["Claude", "GPT-5 Codex"]
writer_default = "Claude"
reviewer_default = "GPT-5 Codex"

[lanes]
enabled = true
per_agent = 2

[lanes.a]
handoff_path = ".claude/collab/HANDOFF_A.md"

[lanes.b]
handoff_path = ".claude/collab/HANDOFF_B.md"

[lanes.c]
handoff_path = ".claude/collab/HANDOFF_C.md"

[lanes.d]
handoff_path = ".claude/collab/HANDOFF_D.md"
```

### Lane Commands

All handoff subcommands accept any configured lane id when lanes are enabled:

```bash
# Claim lane A with file locks
btrain handoff claim --lane a --task "Add auth" \
  --owner "Claude" --reviewer "GPT-5 Codex" --files "src/auth/"

# Claim another lane concurrently
btrain handoff claim --lane b --task "Fix tests" \
  --owner "GPT-5 Codex" --reviewer "Claude" --files "test/"

# Update / resolve a specific lane
btrain handoff update --lane a --status needs-review --actor "Claude" \
  --base feat/auth-middleware \
  --preflight \
  --changed "src/auth/index.ts — tighten guard logic" \
  --verification "node --test test/core.test.mjs" \
  --gap "Did not re-run the end-to-end auth smoke test" \
  --why "Reviewer should focus on the lane-specific auth guard changes." \
  --review-ask "Check for regressions in unauthenticated flows"
btrain handoff resolve --lane b --summary "Tests pass" --actor "Claude"
```

### File Locks

Lanes use a lock registry (`.btrain/locks.json`) to prevent cross-lane file conflicts:

```bash
btrain locks                        # List all active locks
btrain locks release-lane --lane a  # Release all locks for lane A
```

If two lanes try to claim overlapping file paths, the second claim will be rejected with a conflict error.

### File Layout

```
.claude/collab/
  HANDOFF_A.md    # Lane A collaboration state
  HANDOFF_<LANE>.md
.btrain/
  locks.json      # Cross-lane file lock registry
```

---

## Project Config (`.btrain/project.toml`)

```toml
name = "your-repo"
repo_path = "/absolute/path/to/your-repo"
handoff_path = ".claude/collab/HANDOFF_A.md"
default_review_mode = "manual"

[agents]
active = ["Claude", "GPT-5 Codex"]
writer_default = "Claude"
reviewer_default = "GPT-5 Codex"

[agents.runners]
"Claude" = "claude -p"     # CLI dispatch
"Opus 4.6" = "notify"      # IDE-only (Antigravity)
"GPT-5 Codex" = "codex"    # CLI dispatch

[reviews]
parallel_enabled = true
hybrid_path_triggers = ["routes", "auth", "middleware"]
hybrid_content_triggers = ["(password|secret|token)"]

[lanes]
enabled = true

[lanes.a]
handoff_path = ".claude/collab/HANDOFF_A.md"

[lanes.b]
handoff_path = ".claude/collab/HANDOFF_B.md"

[lanes.c]
handoff_path = ".claude/collab/HANDOFF_C.md"

[lanes.d]
handoff_path = ".claude/collab/HANDOFF_D.md"

[instructions]
project_notes = ""
```

---

## Handoff File Format

`.claude/collab/HANDOFF_A.md` (and other lanes) is the source of truth. Always use `btrain handoff claim|update|resolve` — never edit directly.

```markdown
## Current

Task: <short description>
Owner: <agent doing the work>
Reviewer: <agent reviewing>
Status: idle | in-progress | needs-review | resolved
Review Mode: manual | parallel | hybrid
Locked Files: <comma-separated, or empty>
Next Action: <what happens next>
Base: <branch or commit under review>
Last Updated: <agent name + ISO timestamp>

## Context for Reviewer
Pre-flight review:
- [x] Checked locked files, nearby diff, and likely risk areas before editing

Files changed:
- `src/engine/synthesizer.ts` — [one-line summary]

Verification run:
- `node --test test/core.test.mjs`

Remaining gaps:
- Full browser auth flow not re-run yet

Why this was done:
[2-3 sentences on intent, not just mechanics]

Specific review asks:
- [ ] Verify X against Y
- [ ] Check that Z doesn't break W

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
  .claude/
    collab/
      HANDOFF_A.md                  # Collaboration state for Lane A
      HANDOFF_<LANE>.md             # Additional lanes derived from [agents].active

$BRAIN_TRAIN_HOME/                  # Default: ~/.btrain
  repos.json                        # Registry of all bootstrapped repos
  templates/                        # Seed templates (auto-updated)

~/agent_collab_history/             # Created by `btrain hcleanup`
  <repo>_agents_collab/
    <repo>.md                       # Archived handoff history entries
```

---

## Agent Identity Verification

btrain can auto-detect which agent is running based on environment hints (e.g. Claude Code sets recognizable env vars, Codex has its own). The `btrain handoff` output includes an `agent check:` line showing the detection result.

Configured collaborator names do not have to match the underlying runtime name exactly. If you prefer a shorter collaborator label, map it through `[agents.runners]`. For example, a repo can use `GPT` as the collaborator name while mapping `"GPT" = "codex"`, so `btrain handoff` will report `agent check: GPT (runtime hints (codex))`.

When multiple agents are configured and the environment is ambiguous, set `BTRAIN_AGENT` to pin the identity:

```bash
export BTRAIN_AGENT="Opus 4.6"
btrain handoff   # agent check: Opus 4.6 (env)
```

If `--actor` is passed to `handoff update` or `handoff resolve`, btrain verifies it matches the detected agent and rejects mismatches to prevent one agent from impersonating another.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRAIN_TRAIN_HOME` | No | `~/.btrain` | Override global config directory |
| `BTRAIN_AGENT` | No | — | Pin the current agent identity for handoff verification |
| `BRAIN_TRAIN_AGENT` | No | — | Alias for `BTRAIN_AGENT` |
| `ANTHROPIC_API_KEY` | Review only | — | Required for `btrain review run` |
| `OPENAI_API_KEY` | Review only | — | Required for `btrain review run` |
| `HANDOFF_HISTORY_PATH` | Watcher only | — | Path to the history log file |

---

## How Agents Use btrain

1. At session start, the agent runs `btrain handoff`
2. The CLI prints the current state and plain-English guidance
3. The agent follows the guidance:
   - `idle` / `resolved` → claim a task
   - `in-progress` (owner) → do the work, fill `Base` and `Context for Peer Review` (including verification and remaining gaps), then `btrain handoff update --status needs-review`
   - `needs-review` (reviewer) → review, then `btrain handoff resolve --summary "..."`
   - Not your turn → wait
4. The human types `bth` in each agent window to trigger the relay

Always use CLI subcommands. Never edit `HANDOFF_*.md` directly.

---

## License

MIT
