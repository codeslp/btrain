# 022 — Local-Only Init and Feature Toggles

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain (app-developer)
**Date**: 2026-09-24

## Decision

`btrain init` defaults to **local storage**. Every file btrain generates for a
repo lives under one dot folder, `.btrain/`, and init adds `.btrain/` to the
repo's `.gitignore`. After init, git sees one change from btrain: the
`.gitignore` line. Lanes, locks, handoffs, instructions, skills, and helper
tools never enter a commit.

The pre-022 layout stays available as **tracked storage** behind
`btrain init --tracked` (alias `--shared`). Existing repos are detected and
never migrated.

Init also asks which optional subsystems to spin up and which agents to start
with. The choices persist in a `[features]` table in `.btrain/project.toml`.
Every optional subsystem honors its toggle.

## Why

Brian asked for btrain to be usable in a repo without any btrain file ever
being committed, "only the actual code from the repo", and for init to let
him turn off the parts of btrain he does not want (formal checks, cgraph,
and others).

## Audit: what init wrote before this spec

`btrain init <repo>` (tracked, the only mode before 022) created or modified:

| Path | Notes |
|------|-------|
| `.btrain/project.toml` | Committed (`!.btrain/project.toml` in `.gitignore`). |
| `.btrain/locks.json`, `.btrain/reviews/` | Ignored by `.btrain/*`. Commands later add `events/`, `history/`, `overrides/`, `handoff-notes/`, `artifacts/`. |
| `.claude/collab/HANDOFF_<LANE>.md` | One per lane (`HANDOFF_A.md` when lanes are off). Ignored by `.claude/collab/`. |
| `.claude/collab/FEEDBACK_LOG.md` | Unless `--core-only`. |
| `AGENTS.md`, `CLAUDE.md` | Created from the stub, or the managed block replaced in place. Tracked. |
| `GEMINI.md` | Symlink to `CLAUDE.md`. Tracked. |
| `.codex/prompts/AGENTS.md` | Symlink to `../../AGENTS.md`. Tracked. |
| `.claude/skills/*`, `.agents/skills/*` | 30 bundled skills each. Tracked. |
| `scripts/serve-dashboard.js`, `scripts/handoff-history-*.{mjs,sh}`, `scripts/register-handoff-watch-path.sh` | Dev tools. Tracked. |
| `.claude/scripts/unblocked-context.sh`, `.claude/scripts/zvec-context.sh` | Helpers. Tracked. |
| `agentchattr/` | Chat sidecar tree. Tracked (runtime dirs ignored). |
| `.gitignore` | Appends the btrain, agentchattr, and zvec entries. Tracked. |
| `.git/hooks/pre-commit`, `.git/hooks/pre-push` | Only with `--hooks`. Untracked. |
| `~/.btrain/repos.json`, `~/.btrain/templates/`, `~/.btrain/history/` | Outside the repo. |

Hardcoded state paths found in the code: `DEFAULT_HANDOFF_RELATIVE_PATH`, the
lane default in `getLaneConfigs`, `buildLaneSections`, the `project.toml`
template, both hook templates (`.claude/collab/HANDOFF*.md`), `getRepoPaths`
(skills, feedback log, AGENTS/CLAUDE), the managed-block feedback text, the
startup note, `btrain go`, the doctor feedback warning,
`CORE_GITIGNORE_ENTRIES`, and the unblocked helper lookup. The needs-review
diff gate already excludes `.btrain/`. The dashboard reads state through
`btrain status --json`, so it follows the resolver. `scripts/handoff-history-watcher.mjs`
and `scripts/test-push.mjs` still assume `.claude/collab/` (see Follow-ups).

## Storage modes

| | local (default) | tracked (`--tracked`) |
|--|--|--|
| Config | `.btrain/project.toml` with `storage = "local"` | `.btrain/project.toml`, no `storage` key |
| Handoffs | `.btrain/collab/HANDOFF_<LANE>.md` | `.claude/collab/HANDOFF_<LANE>.md` |
| Locks, events, history, overrides | `.btrain/` | `.btrain/` |
| Agent instructions | `.btrain/AGENTS.md` (one file) | managed blocks in `AGENTS.md`, `CLAUDE.md`, plus `GEMINI.md` and `.codex/prompts/AGENTS.md` symlinks |
| Skills | `.btrain/skills/`, `.btrain/agent-skills/` | `.claude/skills/`, `.agents/skills/` |
| Dev tools | `.btrain/tools/<same relative path>` | repo root |
| Ignore | `.btrain/` in `.gitignore`, or `.git/info/exclude` with `--exclude-local` | the pre-022 entries |
| Git hooks | `.git/hooks`, glob `.btrain/collab/HANDOFF*.md` | `.git/hooks`, glob `.claude/collab/HANDOFF*.md` (byte-identical to pre-022) |

### Why `.btrain/`

`.btrain/` already holds config, locks, events, history, overrides, and review
artifacts, and `findRepoRoot` already keys on `.btrain/project.toml`. Moving
handoffs, instructions, and skills into it means one folder, one ignore line,
and no change to repo discovery. A second folder (for example `.btrain-local/`)
would split state and need two resolvers.

### One resolver

`getStorageMode(config)` in `src/brain_train/repo_mode.mjs` reads `storage`.
`getModeRepoPaths(repoRoot, mode)` returns the mode-specific paths, and
`getRepoPaths(repoRoot, mode)` / `getConfiguredRepoPaths(repoRoot, config)` in
`core.mjs` merge them. Lane handoff defaults, hooks, doctor, register,
sync-skills, sync-templates, startup, and `go` all resolve through these.
Readers that already used `handoff_path` from config needed no change.

### Ignore target

The `.gitignore` edit is itself a tracked change: git shows `?? .gitignore` or
`M .gitignore` until someone commits it. `btrain init --exclude-local` writes
`.btrain/` to `.git/info/exclude` instead and leaves nothing for git to
commit. `.gitignore` stays the default because Brian asked for it and because
it protects teammates who also run btrain in the repo. Recommendation: use the
default in repos you own, and `--exclude-local` in repos where you do not want
any diff at all (third-party or client repos). Both edits are idempotent: an
existing `.btrain/`, `.btrain`, `/.btrain/`, or `/.btrain` line is left alone.

### Agent discovery in local mode

Local mode does not write managed blocks into tracked `AGENTS.md` or
`CLAUDE.md`. It writes `.btrain/AGENTS.md` (the same stub and managed block)
and init prints a one-line hint: tell the agent to read `.btrain/AGENTS.md`
and run `btrain startup`. `btrain startup` and `btrain go` list
`.btrain/AGENTS.md` first. This keeps the repo's own instruction files
untouched. Writing untracked files that agents auto-load (`CLAUDE.local.md`,
`AGENTS.override.md`) was rejected: they live outside `.btrain/`, and
`AGENTS.override.md` replaces the repo's `AGENTS.md` for Codex rather than
adding to it. The trade-off is that agents do not pick up btrain on their own.
This needs Brian's call (see Open questions).

### Detection and migration

- A repo with `.btrain/project.toml` keeps its mode. A missing `storage` key
  means tracked, so the btrain repo and every pre-022 repo behave exactly as
  before on `btrain init`, `agents set`, hooks, and every workflow command.
- A repo with no `project.toml` but committed legacy files
  (`.claude/collab/HANDOFF*.md`, or a btrain managed block in `AGENTS.md` /
  `CLAUDE.md`) is initialized as tracked, and init says so.
- `--local` on a tracked repo, or `--tracked` on a local repo, is refused with
  an explanation. Init never moves handoffs, locks, or instruction files.
- `BTRAIN_INIT_STORAGE=tracked` changes the default for new repos.

### Guards

The pre-commit hook in local mode reads `.btrain/collab/HANDOFF*.md` and
filters staged `.btrain/` paths (which only appear with `git add -f`). It
still blocks a non-reviewer commit that touches files locked by a lane in
`needs-review`. Ignored btrain files are never staged, so they never cause a
block. The pre-push hook blocks while a local handoff is active, same as
tracked. `btrain doctor` prints the storage mode, warns when git tracks files
under `.btrain/` in local mode, and warns when `.btrain/` is not ignored.

## Feature toggles

### Inventory

"Core" is always on. Toggleable features are listed with their new-repo
default.

| Subsystem | What it scaffolds or needs | Toggle | Default |
|--|--|--|--|
| Lanes, locks, handoffs, overrides, doctor, status, registry | `project.toml`, `locks.json`, handoff files | core | on |
| Harness profiles, traces | bundled profiles; `.btrain/harness/` | core | on |
| Context budget (spec 020 WS3) | `[context_budget]`; reads Claude session logs | core (own config) | on |
| Git guards | `.git/hooks/pre-commit`, `pre-push` | `hooks` | on |
| Workflow skills | pre-handoff, bug-fix, bug-rca, test-writer, context-scout, reflect, and others | `skills` | on |
| Spec-kit | `speckit-*` skills | `speckit` | on |
| Formal checks (TLA+/Specula) | `tla-author`, `tla-run-tlc`, `tla-pin-sync`, `tla-trace-explain`, `speckit-formal` skills | `formal` | off |
| Feedback log | `feedback-triage` skill, `collab/FEEDBACK_LOG.md`, doctor checks | `feedback` | on |
| cgraph | `[cgraph]` section; review packets, audits, advisories | `cgraph` | off |
| Unblocked context | `unblocked-context.sh`; `handoff claim --unblocked-context` | `unblocked` | off |
| zvec-grep | `zvec-context.sh` | `zvec` | off |
| PR flow and bot reviews | `[pr_flow]`; `btrain pr ...` | `pr_flow` | off |
| Reviewer dispatch | `btrain loop`; auto-dispatch on `needs-review` | `loop` | on |
| Dashboard | `scripts/serve-dashboard.js`; `btrain dashboard`, auto-start | `dashboard` | on |
| agentchattr | `agentchattr/` sidecar | `agentchattr` | off |
| Handoff history watcher | `scripts/handoff-history-*` | `handoff_history` | off |

The fast-check formal harness (`test/formal/`) and the formal-advisory CI
workflow belong to the btrain repo itself. Init never scaffolds them into a
target repo, so `formal` controls only the skills that target repos receive.

### Behavior

- `[features]` in `project.toml` holds one boolean per feature. A missing
  table, or a missing key, means enabled, so pre-022 repos keep everything on.
- New local repos get the defaults above. New tracked repos without feature
  flags or prompt answers get the pre-022 output with no `[features]` table
  (feature choices for a tracked repo start from all-on).
- Disabled features are not scaffolded. Commands for a disabled feature exit
  non-zero with `the "<id>" feature (...) is disabled for this repo. Enable it
  with: btrain features enable <id>`. This covers `btrain loop`,
  `btrain dashboard start|open`, and `handoff claim --unblocked-context`.
  Reviewer auto-dispatch returns `skipped: feature-disabled`. Dashboard
  auto-start, cgraph (every call site and the adapter), feedback checks, and
  PR flow (`getPrFlowConfig().enabled`) are silently off.
- `btrain features list|enable|disable <ids> [--repo <path>]` changes toggles
  later. `enable` scaffolds the missing skills or tools for that feature;
  `enable cgraph` and `enable pr_flow` also set `enabled = true` in their
  sections; `enable hooks` installs the hooks. `disable` edits config only,
  except `disable hooks`, which removes the btrain-managed hooks (hooks
  without the btrain marker are never touched). Files already scaffolded for
  a disabled feature are left in place.

### Interactive init

When stdin and stdout are TTYs, `CI` is unset, `--yes`/`-y` is absent, and the
repo has no `project.toml`, init asks with `node:readline`:

1. A numbered feature checklist with the defaults marked. Answers toggle by
   number or name (`4 6`, `formal,cgraph`), force with `+`/`-`
   (`+formal -loop`), or accept `all`/`none`. Enter accepts.
2. Agents to start with (suggested: claude, codex, gemini, app-developer;
   any name works). Default `claude, codex`.
3. The default reviewer. The reviewer becomes `reviewer_default`; the first
   other agent becomes `writer_default`.

Non-interactive equivalents: `--features a,b` (exactly these on),
`--feature x` and `--no-feature x` (repeatable, comma lists allowed),
`--agents a,b` (or repeated `--agent`), `--reviewer <name>`, `--yes`.
Non-TTY runs never prompt.

## Formal-Impact Declaration

**No semantic impact.** This spec changes where handoff files, instructions,
and skills are stored, and which optional subsystems are scaffolded. It does
not change lane statuses, transition guards, lock acquisition or release,
reviewer authority, or override semantics. The hooks read the same header
fields from a different glob. Evidence:

- `python3 scripts/tla_pin.py --check`: 1 pin clean. No modeled prose changed.
- Focused implementation validation: `npm run test:formal` gives the same
  result as `origin/main` (13 pass, 1 fail; the failing
  `candidate findings absent` test is the existing ledger item in
  `test/formal/README.md`).
- Two toggles touch transition-adjacent code without changing the model:
  `loop = false` skips reviewer auto-dispatch (a side effect, not a
  transition), and `pr_flow = false` makes `getPrFlowConfig().enabled` false,
  which selects the existing non-PR-flow resolve path that repos without
  `[pr_flow]` already take.

## Tests

`test/local-init.test.mjs` covers: local init creates only `.btrain/` and the
`.gitignore` line; `git status` after init plus claim, needs-review, and
resolve shows only `?? .gitignore`; idempotent re-init; `--exclude-local`
leaves `git status` empty; the pre-commit lock guard and the pre-push guard in
local mode; doctor mode reporting and tracked-state warnings; `--tracked`
reproduces the committed layout; existing tracked repos stay tracked and
refuse `--local`; legacy-artifact detection; feature flag persistence;
`formal` and `cgraph` toggles disabling their subsystem; disabled `loop`,
`dashboard`, and `unblocked` messages; `features disable hooks`; prompt
answer parsing and scripted interactive runs. Pre-022 suites opt into
tracked storage through `test/helpers/legacy-init.mjs`.

## Follow-ups

- `scripts/handoff-history-watcher.mjs` and its launch-agent scripts assume
  `.claude/collab/HANDOFF_A.md`. Make them read `handoff_path` before
  `handoff_history` is enabled in a local repo.
- A `btrain migrate --to local|tracked` command, if Brian wants one.
- Candidate toggles not added yet: `context_budget` (has its own config),
  harness trace capture, solo mode (spec 017/019, not implemented), and the
  parallel review script (`[reviews].parallel_enabled`).
- The managed block still mentions the `context-scout` skill and
  `--unblocked-context` when those are off. Changing the template would mark
  every existing repo as drifted, so it was left alone.

## Open questions for Brian

1. Is "read `.btrain/AGENTS.md`" plus the printed hint enough for agent
   discovery, or should local mode also write an auto-loaded untracked file
   such as `CLAUDE.local.md`?
2. Are the new-repo defaults right (formal, cgraph, unblocked, zvec, pr_flow,
   agentchattr, and handoff-history off)?
3. Should hooks install by default in every new repo? Today they install on
   first init when a feature map is in play (every new local repo, or a new
   tracked repo initialized with feature flags or prompt answers), or with
   `--hooks`. `--no-hooks` skips them.
