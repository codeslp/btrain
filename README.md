# btrain

**A file-backed handoff workflow for human-guided multi-agent coding.**

btrain gives agents one shared protocol for:

- who is working right now
- who reviews next
- which files are locked
- what changed, why it changed, and what the reviewer should check

It works with Claude Code, Codex, Antigravity, or any mix of agents that can read files and run shell commands.

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org) [![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-blue)](#) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What btrain gives you

- A git-tracked handoff file per lane in `.claude/collab/`
- Plain CLI commands for claim, update, resolve, locks, review, and status
- Lane scaffolding derived from active collaborators and `lanes.per_agent`
- Structured review context instead of vague "please review this"
- Reviewer selection that can pick `any-other` configured peer automatically
- A bundled, project-agnostic `.claude/skills/` pack on `init`
- Optional history cleanup and automated review helpers
- A local console dashboard HUD for lane status, reviewers, and file locks

## Console Dashboard

The current local HUD lives in `scripts/serve-dashboard.js`. It polls `btrain status --repo .` and reads the current repo's handoff files so you can see:

- lane state and current task summary
- who is in the hot seat right now
- active file locks without opening the markdown by hand

If you are working in this repo, the shortest path is:

```bash
# from the btrain repo root
npm link
node scripts/serve-dashboard.js
# then visit http://localhost:3333
```

If you want to point the HUD at another bootstrapped repo, run the script from that repo's working directory so `btrain status --repo .` and the local `.btrain/project.toml` resolve against the repo you want to inspect. For example:

```bash
cd /path/to/your/repo
node /path/to/your/btrain/checkout/scripts/serve-dashboard.js
```

## Quick Start

```bash
# install locally
git clone https://github.com/codeslp/btrain.git
cd btrain
npm link

# bootstrap a repo with two collaborators
btrain init /path/to/your/repo \
  --agent "Claude" \
  --agent "GPT-5 Codex"

# skip bundled skills if you only want the core btrain files
btrain init /path/to/your/repo --core-only

# optional: open the local console dashboard when working in btrain itself
node scripts/serve-dashboard.js

# claim a lane
btrain handoff claim \
  --repo /path/to/your/repo \
  --lane a \
  --task "Implement auth middleware" \
  --owner "Claude" \
  --reviewer any-other \
  --files "src/auth/"

# check guidance
btrain handoff --repo /path/to/your/repo

# hand work to review with real reviewer context
btrain handoff update \
  --repo /path/to/your/repo \
  --lane a \
  --status needs-review \
  --actor "Claude" \
  --base feat/auth-middleware \
  --preflight \
  --changed "src/auth/index.ts - tighten token validation" \
  --verification "npm test" \
  --gap "Did not re-run the full browser auth flow" \
  --why "Auth logic and docs had drifted" \
  --review-ask "Check unauthenticated flows for regressions"

# reviewer resolves
btrain handoff resolve \
  --repo /path/to/your/repo \
  --lane a \
  --summary "Approved. Clean implementation." \
  --actor "GPT-5 Codex"
```

## Core Workflow

1. The human types `bth` in an agent chat.
2. The agent runs `btrain handoff`.
3. btrain prints the current state plus plain-English guidance.
4. The agent follows the guidance:
   - `idle` or `resolved`: claim a task
   - `in-progress`: continue the task if you are the active agent
   - `needs-review`: review if you are the peer reviewer
   - otherwise: wait
5. The agent updates state with `claim`, `update`, or `resolve`.

The source of truth is `.claude/collab/HANDOFF_A.md` plus any additional lane files such as `HANDOFF_B.md`, `HANDOFF_C.md`, and so on. Do not edit those files directly. Always use the CLI.

## Lanes, Agents, and Reviewers

Lane count is derived from:

- `[agents].active`
- `[lanes].per_agent`

Defaults:

- If no collaborators are configured yet, btrain scaffolds for 2 collaborators
- Default `per_agent` is `2`
- That means a fresh repo gets lanes `a` through `d`

Examples:

- 1 agent, `per_agent = 3` -> lanes `a` through `c`
- 2 agents, `per_agent = 3` -> lanes `a` through `f`
- 3 agents, `per_agent = 2` -> lanes `a` through `f`

You can change the active collaborators later:

```bash
# replace the active list
btrain agents set --repo /path/to/repo \
  --agent "Claude" \
  --agent "GPT-5 Codex" \
  --lanes-per-agent 3

# append more collaborators
btrain agents add --repo /path/to/repo --agent "Gemini 3.1"
```

Reviewer selection rules:

- `--reviewer any-other` means "pick any configured agent except the owner"
- if the requested reviewer matches the owner and another peer exists, btrain snaps to a peer automatically
- if there is no alternate reviewer, btrain errors instead of creating a self-review

## What `btrain init` Writes

`btrain init` creates or refreshes:

- `AGENTS.md`
- `CLAUDE.md`
- `.btrain/project.toml`
- `.btrain/reviews/`
- `.claude/collab/HANDOFF_A.md` plus any additional lane files required by config
- `.claude/skills/` unless `--core-only` is passed

The bundled skill pack is portable and repo-agnostic. It includes helpers such as:

- `pre-handoff`
- `code-simplifier`
- `test-writer`
- `secure-by-default`
- Speckit skills
- `tessl__webapp-testing`
- `tessl__yeet`

The excluded `create-multi-speaker-static-recordings-using-tts` skill is never copied.

Re-running `init`, `agents set`, or `agents add` is safe. Missing lane files and missing bundled skill files are scaffolded. Existing skill content is not overwritten.

## Review-Ready Handoffs

Every `needs-review` handoff should include:

- `Base`
- `Pre-flight review`
- `Files changed`
- `Verification run`
- `Remaining gaps`
- `Why this was done`
- `Specific review asks`

That is why `btrain handoff update` supports:

- `--base`
- `--preflight`
- `--changed`
- `--verification`
- `--gap`
- `--why`
- `--review-ask`

The active handoff template uses the current labels:

```md
## Current

Lane: a
Task: Implement auth middleware
Active Agent: Claude
Peer Reviewer: GPT-5 Codex
Status: in-progress
Review Mode: manual
Locked Files: src/auth/
Next Action: Continue implementation and prepare reviewer context.
Base: feat/auth-middleware
Last Updated: Claude 2026-04-02T12:00:00.000Z
```

## Key Commands

```bash
btrain init <repo> [--hooks] [--agent <name>]... [--lanes-per-agent <n>] [--core-only]
btrain agents set --repo <path> --agent <name>... [--lanes-per-agent <n>]
btrain agents add --repo <path> --agent <name>... [--lanes-per-agent <n>]
btrain handoff [--repo <path>]
btrain handoff claim --lane <id> --task <text> --owner <name> [--reviewer <name|any-other>] --files <paths>
btrain handoff update --lane <id> [--status <status>] [review-context flags...]
btrain handoff resolve --lane <id> --summary <text> --actor <name>
btrain locks [--repo <path>]
btrain status [--repo <path>]
btrain doctor [--repo <path>]
btrain hcleanup [--repo <path>] [--keep <n>]
```

## Example Config

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
"Claude" = "claude -p"
"GPT-5 Codex" = "codex"
"Antigravity" = "notify"

[reviews]
parallel_enabled = true
sequential_enabled = false
sequential_triggers = []
parallel_script = ""

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

## Agent Identity Verification

btrain can verify which agent is speaking.

- It uses `BTRAIN_AGENT` or `BRAIN_TRAIN_AGENT` if set.
- Otherwise it looks at runtime hints and `[agents.runners]`.
- `btrain handoff` prints an `agent check:` line so the agent can confirm its identity before acting.

That means a repo can use short collaborator labels. For example:

```toml
[agents.runners]
"GPT" = "codex"
```

In that setup, `btrain handoff` can report `agent check: GPT (runtime hints (codex))`.

## Loop and Cleanup

- `btrain loop` can relay `bth` between configured runners, but real-world support still depends on what each agent CLI allows.
- `btrain hcleanup` trims old `## Previous Handoffs` entries into `~/agent_collab_history/<repo>_agents_collab/<repo>.md`.

## Environment Variables

| Variable | Description |
| --- | --- |
| `BRAIN_TRAIN_HOME` | Override the global btrain home directory |
| `BTRAIN_AGENT` | Pin the current agent identity |
| `BRAIN_TRAIN_AGENT` | Alias for `BTRAIN_AGENT` |
| `ANTHROPIC_API_KEY` | Required for automated review modes that call Anthropic |
| `OPENAI_API_KEY` | Required for automated review modes that call OpenAI |
| `HANDOFF_HISTORY_PATH` | Output file used by the handoff history watcher |

## License

MIT
