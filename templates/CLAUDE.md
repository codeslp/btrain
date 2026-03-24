# CLAUDE.md — btrain Collaboration Template for Claude Code

Copy this file into your repo root. Claude Code auto-loads `CLAUDE.md` at session start.

This file mirrors `AGENTS.md`. Keep them in sync.

## Multi-Model Collaboration Protocol

Before starting any work, run `btrain handoff` from the repo root to check the current state.

- If `status: needs-review` and you are the **reviewer**, do the review first, then run:
  ```
  btrain handoff resolve --summary "..." --actor "<your name>"
  ```
- If `status: in-progress` and you are the **owner**, continue the task. Only mark `needs-review` after real completed work exists and the reviewer context is filled in. Then run:
  ```
  btrain handoff update --status needs-review --actor "<your name>"
  ```
- If `status: resolved` or `idle`, claim the next task:
  ```
  btrain handoff claim --task "..." --owner "..." --reviewer "..."
  ```
- **Never edit `HANDOFF.md` directly.** Always use `btrain handoff claim|update|resolve`.

### Chat Shorthand

If the user sends a bare `bth` message, run `btrain handoff` from the repo root and immediately follow the printed guidance — do the review, continue working, or claim the next task. Do not stop after printing status.

### One Writes, One Reviews

One model writes, the other reviews. Never edit a file the other model is actively working on. The `Locked Files` field in `HANDOFF.md` lists files currently under edit.

Do not create empty handoffs. Placeholder reviewer context, no code changes, or no verification notes are not valid reasons to move a task to `needs-review`.
