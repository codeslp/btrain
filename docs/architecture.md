# btrain + agentchattr Architecture

## Overview

**btrain** is a Node.js CLI for multi-agent coordination in shared Git repositories.
**agentchattr** is a FastAPI chat UI and agent lifecycle manager that integrates with btrain's lane-based workflow.

Together they enable multiple AI agents (Claude, Codex, Gemini, etc.) to work concurrently on separate lanes of the same codebase, hand work off for peer review, and coordinate through a real-time chat interface.

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser UI                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Chat     │  │ Lane     │  │ Rules &  │  │ Sessions & │  │
│  │ Channels │  │ Panels   │  │ Jobs     │  │ Schedules  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       └──────────────┴─────────────┴──────────────┘         │
│                         WebSocket                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
              ┌───────────▼────────────┐
              │   agentchattr server   │
              │    FastAPI :8300       │
              │                        │
              │  ┌────────────────┐    │
              │  │ Message Store  │    │     ┌──────────────────┐
              │  │ Rule Store     │    │     │  Agent Wrappers  │
              │  │ Job Store      │    │     │                  │
              │  │ Session Engine │◄───┼────►│  claude wrapper  │
              │  │ Registry       │    │     │  codex  wrapper  │
              │  │ Router         │    │     │  gemini wrapper  │
              │  │ Presence       │    │     └───────┬──────────┘
              │  └────────────────┘    │             │
              │         │              │             │
              │    btrain poller       │     ┌───────▼──────────┐
              │      (15s cycle)       │     │   Agent CLIs     │
              └───────┬────────────────┘     │                  │
                      │                      │  claude code     │
              ┌───────▼────────────┐         │  codex           │
              │     btrain CLI     │         │  gemini          │
              │                    │         └──────────────────┘
              │  Handoff state     │
              │  Lane management   │
              │  File locks        │
              │  Git hooks         │
              │  Event history     │
              └────────────────────┘
```

---

## System Components

### 1. btrain CLI (Node.js)

**Entry point:** `src/brain_train/cli.mjs` -> `core.mjs`

The CLI manages the collaboration state machine. All state is file-based (no database).

#### Key Commands

| Command | Purpose |
|---------|---------|
| `btrain init <repo> [--hooks]` | Bootstrap repo with lanes, handoff files, git hooks |
| `btrain handoff` | Check state, print per-agent guidance |
| `btrain handoff claim --lane a --task "..." --owner "..." --reviewer "..."` | Claim a task on a lane |
| `btrain handoff update --lane a --status needs-review` | Transition lane status |
| `btrain handoff resolve --lane a --summary "..."` | Approve and close review |
| `btrain handoff request-changes --lane a --summary "..."` | Send findings back to writer |
| `btrain status [--json]` | All lanes (JSON for integrations) |
| `btrain locks` | Active file locks |
| `btrain doctor [--repair]` | Health check |
| `btrain override grant/consume/list` | Human-confirmed push overrides |

#### File Layout

```
.btrain/
├── project.toml          # Config: agents, lanes, review mode
├── locks.json            # Active file lock registry
├── events/
│   ├── lane-a.jsonl      # Per-lane event streams
│   ├── lane-b.jsonl
│   └── ...
├── history/
│   ├── lane-a.md         # Archived handoff summaries
│   └── ...
├── overrides/
│   └── ovr_*.json        # Pending audited overrides
└── reviews/              # Review artifacts (parallel/hybrid mode)

.claude/collab/
├── HANDOFF_A.md          # Live handoff state (source of truth)
├── HANDOFF_B.md
└── ...
```

### 2. agentchattr Server (FastAPI + Python)

**Entry point:** `agentchattr/run.py` -> `app.py`

The server provides the chat UI, agent lifecycle management, and real-time coordination.

#### Core Modules

| Module | Responsibility |
|--------|---------------|
| `app.py` | FastAPI routes, WebSocket, background threads |
| `run.py` | Server startup, config loading, session token |
| `store.py` | Message persistence (JSONL) |
| `wrapper.py` | Wraps agent CLI processes, injects context |
| `registry.py` | Agent instance registration, tokens, slots |
| `router.py` | @mention parsing, hop-count loop guard |
| `agents.py` | Queue-file trigger for agent wrappers |
| `presence.py` | Online/offline/active tracking (heartbeat) |
| `rules.py` | Shared working-style guidelines |
| `jobs.py` | Bounded work conversations (threaded) |
| `session_store.py` | Multi-agent session templates |
| `session_engine.py` | Turn-flow orchestration for sessions |
| `schedules.py` | Recurring scheduled prompts |
| `summaries.py` | Per-channel summaries |
| `readiness.py` | Pre-flight checks (binary, auth, cwd) |

#### Configuration

```toml
# agentchattr/config.toml
[server]
port = 8300
host = "127.0.0.1"
data_dir = "./data"

[agents.claude]
command = "claude"
cwd = ".."
color = "#da7756"

[agents.codex]
command = "codex"
cwd = ".."
color = "#10a37f"

[btrain]
repo_path = ".."
poll_interval = 15

[routing]
default = "none"        # "none" = @mention only, "all" = route to everyone
max_agent_hops = 4
```

### 3. Agent Wrappers

**Entry point:** `agentchattr/wrapper.py`

Each wrapper runs a real agent CLI (claude, codex, gemini) in an interactive terminal and bridges it to the chat server.

---

## Data Flow Diagrams

### Message Flow: User -> Agent -> Response

```
User types "@claude fix the auth bug" in browser
    │
    ▼
WebSocket message arrives at agentchattr server
    │
    ▼
store.add(sender="user", text="@claude fix the auth bug", channel="a")
    │
    ▼
Router parses @claude mention
    │
    ▼
AgentTrigger writes to data/claude_queue.jsonl
    │
    ├──────────────────────────────────────────┐
    │                                          │
    ▼                                          ▼
WebSocket broadcasts message              claude wrapper detects
to all browser clients                    queue entry
    │                                          │
    │                                          ▼
    │                                     wrapper fetches btrain
    │                                     lane context for claude
    │                                          │
    │                                          ▼
    │                                     wrapper injects prompt
    │                                     into claude CLI process
    │                                          │
    │                                          ▼
    │                                     claude CLI processes
    │                                     request, does the work
    │                                          │
    │                                          ▼
    │                                     wrapper POST /api/send
    │                                     with Bearer token
    │                                          │
    │         ┌────────────────────────────────┘
    │         │
    │         ▼
    │    store.add(sender="claude", text="response", channel="a")
    │         │
    │         ▼
    └────►WebSocket broadcasts response to all clients
```

### btrain Handoff Lifecycle

```
                    ┌──────┐
                    │ idle │ ◄─────────────────────────────────┐
                    └──┬───┘                                   │
                       │                                       │
            btrain handoff claim                               │
            --task "..." --owner "Claude"                      │
            --reviewer "GPT" --files "src/"                    │
                       │                                       │
                       ▼                                       │
                ┌─────────────┐                                │
           ┌───►│ in-progress │◄────────────┐                  │
           │    └──────┬──────┘             │                  │
           │           │                    │                  │
           │  btrain handoff update         │                  │
           │  --status needs-review         │                  │
           │  --changed "..." --why "..."   │                  │
           │           │                    │                  │
           │           ▼                    │                  │
           │   ┌──────────────┐             │                  │
           │   │ needs-review │             │                  │
           │   └───┬──────┬───┘             │                  │
           │       │      │                 │                  │
           │       │      │  btrain handoff │                  │
           │       │      │  request-changes│                  │
           │       │      │                 │                  │
           │       │      ▼                 │                  │
           │       │ ┌───────────────────┐  │                  │
           │       │ │ changes-requested │──┘                  │
           │       │ └───────────────────┘                     │
           │       │   (writer fixes, re-handoffs)             │
           │       │                                           │
           │       │  btrain handoff resolve                   │
           │       │  --summary "Approved. ..."                │
           │       │                                           │
           │       ▼                                           │
           │  ┌──────────┐                                     │
           │  │ resolved │─────────────────────────────────────┘
           │  └──────────┘   (lane recycled, locks released)
           │
           │  ┌───────────────┐
           └──┤ repair-needed │  (workflow integrity issue)
              └───────────────┘
```

### btrain Lane Context Injection

When an agent is triggered via chat, the wrapper injects lane context:

```
wrapper.py detects queue entry for "claude"
    │
    ▼
_fetch_btrain_context(repo_root, "claude")
    │
    ▼
Runs: btrain handoff --repo <repo>
    │
    ▼
Parses output, finds claude's active lane (priority order):
    │
    ▼
Determines role:
  - Owner + in-progress/changes-requested/repair-needed  →  "writer"
  - Reviewer + needs-review                              →  "reviewer"
  - Owner + needs-review                                 →  "writer-waiting"
    │
    ▼
_format_lane_context() builds a compact single-line block:

  LANE a: in-progress | Fix auth bug
  W=Claude R=GPT lock=src/auth/
  You are writer. When done: btrain handoff update
  --lane a --status needs-review, then @gpt please
  review lane a.

  (reviewer variant):
  LANE a: needs-review | Fix auth bug
  W=Claude R=GPT lock=src/auth/
  You are reviewer. Review then: btrain handoff resolve
  --lane a --summary '...' --actor 'GPT'

  (writer-waiting variant):
  LANE a: needs-review | Fix auth bug
  W=Claude R=GPT lock=src/auth/
  Waiting on @gpt to review.
    │
    ▼
Injects into agent CLI prompt along with chat message
```

### btrain Poller (Server-Side)

```
Background thread (every 15 seconds)
    │
    ▼
Runs: btrain status --json --repo <repo>
    │
    ▼
Parses JSON → lane array with status, owner, reviewer, locks, task
    │
    ▼
Compares with previous poll:
    │
    ├── Task changed on lane X?
    │   └── Archive old channel messages to zip
    │       Insert "Lane X task changed" system message
    │
    └── Cache updated lane state
        │
        ▼
   WebSocket broadcast: { type: "btrain_lanes", data: [...] }
        │
        ▼
   Browser UI updates lane pills, headers, status badges
```

---

## Enforcement Layers

Agent compliance relies on two advisory layers and two hard enforcement gates:

```
Advisory: Instructions + Pre-Handoff Skill (soft)
┌───────────────────────────────────────────────────┐
│  CLAUDE.md / AGENTS.md                            │
│  - Must run `btrain handoff` before starting work │
│  - Must run pre-handoff skill before needs-review │
│  - Must fill all review context fields            │
│                                                   │
│  Pre-handoff skill (.claude/skills/ pre-handoff)  │
│  - Checklist: placeholder context, empty diffs,   │
│    unsimplified code, missing fields              │
│  - Does NOT block — the agent follows guidance    │
└───────────────────────────────────────────────────┘
                       │
                       ▼
Enforcement 1: btrain CLI Validation (hard gate)
┌───────────────────────────────────────────────────┐
│  btrain handoff update --status needs-review      │
│  - Rejects if context has placeholder text or     │
│    missing required fields                        │
│  - Rejects if no reviewable diff in locked files  │
│  - Bypass: --override-id (human-granted override) │
└───────────────────────────────────────────────────┘
                       │
                       ▼
Enforcement 2: Git Hooks (hard gate)
┌───────────────────────────────────────────────────┐
│  .git/hooks/pre-commit                            │
│  - Blocks non-handoff commits while any lane is   │
│    in needs-review (allows HANDOFF*.md changes)   │
│  - Does NOT check file locks                      │
│                                                   │
│  .git/hooks/pre-push                              │
│  - Blocks ALL pushes while any handoff is active  │
│    (in-progress, needs-review, changes-requested, │
│     repair-needed)                                │
│  - Override: btrain override grant + consume      │
└───────────────────────────────────────────────────┘
```

---

## Security Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser                        │
│                                                 │
│  Session token injected via <script> tag        │
│  (same-origin, generated per server start)      │
│                                                 │
│  All API calls include X-Session-Token header   │
│  WebSocket auth via ?token= query param         │
└─────────────────────┬───────────────────────────┘
                      │
          ┌───────────▼───────────────┐
          │   Security Middleware     │
          │                           │
          │  Public (no auth):        │
          │    /                      │
          │    /static/*              │
          │    /uploads/*             │
          │    /api/roles             │
          │                           │
          │  Loopback-only:           │
          │    /api/register          │
          │    /api/deregister/*      │
          │    /api/heartbeat/*       │
          │                           │
          │  Bearer-token (agents):   │
          │    /api/send              │
          │    /api/messages          │
          │    /api/rules/*           │
          │                           │
          │  Session-token gated:     │
          │    All other /api/* paths │
          │    /ws                    │
          │    (fallback for above    │
          │     if no Bearer token)   │
          │                           │
          │  Origin check:            │
          │    Blocks DNS rebinding   │
          │    Allowed origins:       │
          │      http://127.0.0.1:$P  │
          │      http://localhost:$P  │
          │    (port from config)     │
          └───────────────────────────┘
```

- **Session token**: 64-char random hex, regenerated each server start, embedded in HTML
- **Bearer tokens**: Per-agent identity tokens issued at registration, used by wrappers for `/api/send`, `/api/messages`, and `/api/rules/*`
- **Registration**: Loopback-only (`127.0.0.1`, `::1`, `localhost`), no external agents can register
- **Origin check**: Allows both `127.0.0.1` and `localhost` at the configured port (not hardcoded to 8300)
- **No CORS headers**: Same-origin only

---

## Agent Registration & Multi-Instance

```
1st claude wrapper registers:
    POST /api/register { base: "claude" }
    → name: "claude", slot: 1, token: <hex>

2nd claude wrapper registers:
    POST /api/register { base: "claude" }
    → 1st instance renamed: "claude" → "claude-1"
    → 2nd instance created: "claude-2", slot: 2, token: <hex>
    → Presence migrates: online/activity/roles "claude" → "claude-1"

Deregistration:
    POST /api/deregister/claude-2
    → 30-second grace period (name reserved)
    → If only one instance remains, "claude-1" renamed back to "claude"
```

---

## Lane-to-Channel Mapping

Each btrain lane maps 1:1 to an agentchattr chat channel:

```
btrain lane a  ←→  agentchattr channel #a
btrain lane b  ←→  agentchattr channel #b
...
btrain lane i  ←→  agentchattr channel #i
(plus)              agentchattr channel #general (cross-lane)
```

When a lane's task changes (detected by poller diff):
1. Old channel messages archived to `data/lane_archives/<lane>_<timestamp>.zip`
2. Channel cleared
3. System message inserted: "Lane X task changed. Previous messages archived."

---

## Background Threads

The agentchattr server runs three background threads alongside the async FastAPI event loop:

| Thread | Interval | Responsibility |
|--------|----------|---------------|
| btrain poller | 15s | `btrain status --json`, detect task changes, broadcast lanes |
| Schedule runner | 30s | Fire due scheduled prompts, add to store |
| Background checks | 3s | Agent recovery flags, online/offline transitions, activity tracking |

All threads use `asyncio.run_coroutine_threadsafe()` to broadcast WebSocket messages from sync context. Each store has its own `threading.Lock` for safe concurrent access.

---

## Key Constants

| Item | Value |
|------|-------|
| Server port | 8300 |
| btrain poll interval | 15s |
| Presence timeout | 10s |
| Activity timeout | 8s |
| Max agent hops (loop guard) | 4 |
| Max active rules | 10 |
| Max image upload | 10 MB |
| Handoff history keep | 3 entries |
| Default lanes per agent | 2 (this repo: 3) |
| Valid handoff statuses | idle, in-progress, needs-review, changes-requested, repair-needed, resolved |

---

## Startup Sequence

```
./chat claude /path/to/repo
    │
    ▼
Ensure Python venv, install deps
    │
    ▼
run.py:
  ├── Load config.toml + config.local.toml
  ├── Generate session token (64 hex chars)
  ├── Inject token into index.html <script> tag
  ├── configure(config, session_token)
  │   ├── Create all stores (MessageStore, RuleStore, JobStore, ...)
  │   ├── Create RuntimeRegistry, Router, AgentTrigger
  │   ├── Start btrain poller thread
  │   ├── Start schedule runner thread
  │   ├── Start background checks thread
  │   └── Install security middleware
  └── uvicorn.run(app, host, port)
         │
         ▼
wrapper.py (per agent):
  ├── POST /api/register → get name + token
  ├── Fork agent CLI process (claude/codex/gemini)
  ├── Start queue watcher thread
  │   └── Polls data/<agent>_queue.jsonl
  └── Start heartbeat thread (5s interval)
```
