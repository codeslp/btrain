# 018 — Agent Identity Namespaces: Local Actors and GitHub Bots

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-09-01

## Decision

btrain has two kinds of named participants that today share one namespace:

- **Local agents**: runtimes that take btrain handoffs, hold lanes and locks,
  and appear as `owner`, `reviewer`, and `--actor`. Configured in
  `[agents].active` and `[agents.runners]`.
- **GitHub bots**: reviewers that exist only on GitHub, are asked through PR
  comments, and are read through PR reviews and reactions. Configured in
  `[pr_flow].required_bots` and `[pr_flow.bots.<id>]`.

Both are called `codex` in this repository. The same word means "the agent
that owns lane b" in one line and "the bot whose feedback lane b must address"
in the next. On 2026-09-01 the lane b next-action read "Address codex feedback"
while lane b's owner was codex.

From this spec on, the two live in separate namespaces:

- A GitHub bot id **must** start with `gh-`. Example: `gh-codex`,
  `gh-unblocked`.
- A local agent id **must not** start with `gh-`. Local ids stay unprefixed
  (`claude`, `codex`, `gemini`); the `#<role>` suffix is reserved for spec
  017 role identities such as `claude#review`.
- No id may appear in both sets. `btrain doctor` reports a collision as an
  error.
- Wherever btrain renders a bot next to a local agent, it labels them:
  `agent claude`, `bot gh-codex`.

What is not being done: local agent identities are not renamed to
`local-<name>`. Those strings are stored in every lane's handoff file as owner
and reviewer and keyed in `[agents.runners]`. Renaming them mid-flight would
flag every active lane as `actor-mismatch` (`analyzeLaneIntegrity` compares
the owner against `[agents].active`) and the watchdog would push it to
`repair-needed`. (The formal model and harness use abstract agents
`alpha`, `beta`, `gamma`, so they are unaffected either way.) The display label gives the same discrimination without
identity churn. If a repository wants `local-` in identifiers, it may use it;
btrain treats any non-`gh-` id as local.

## Summary

Bot ids are labels. GitHub logins are matched through `aliases`
(`src/brain_train/pr-flow.mjs:36`), so the id itself never reaches GitHub
except inside btrain's own review-request marker (`bot=<id>`,
`pr-flow.mjs:490`). The id does reach users: in `btrain pr status` lines
(`pr-flow.mjs:334`), in reason tags on `changes-requested`
(`pr-flow.mjs:668`), and in the generated next-action text
(`pr-flow.mjs:669`). Renaming a bot id is therefore a config change with
three visible effects, all wanted: status lines, reason tags, and next
actions say `gh-codex`.

Underscores are not an option for bot ids because reason tags derive from
them and `REASON_TAG_PATTERN` (`core.mjs:259`) allows lowercase letters,
digits, and hyphens only. `gh_codex` would make every PR-feedback transition
fail validation.

Hyphens are not an option either until one parser bug is fixed.
`parseProjectToml` (`core.mjs:6264`, regex at `:6274`) matches table headers
with `/^\[([A-Za-z0-9_.]+)\]$/` and bare keys with `[A-Za-z0-9_]+`, so the
`[pr_flow.bots.gh-codex]` header is skipped and the entries beneath it are
misattributed to the previous table (`[pr_flow]`); the bot then falls back to
default aliases (`[id]`) and request body (`@gh-codex review`). Real bot
reviews then stop matching and the review-request comment no longer
triggers the bot. This was observed on PR #39 on 2026-09-01. TOML permits
`A-Za-z0-9_-` in bare keys; the parser is wrong, not the config. The fix is
two regexes:

```js
const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(trimmed)
const entryMatch = /^("(?:[^"\\]|\\.)+"|[A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(trimmed)
```

plus a test that a hyphenated bot table round-trips through
`getPrFlowConfig`. The config rename in this spec's lane must not merge
before that fix.

## Functional Requirements

### FR-1: Bot ids carry the `gh-` prefix

`getPrFlowConfig` rejects a `[pr_flow.bots.<id>]` table or a
`required_bots` entry whose id does not start with `gh-`, with a fix that
names the rename. The whole id must match `^gh-[a-z0-9]+(-[a-z0-9]+)*$`: the
reason-tag slug grammar (`REASON_TAG_PATTERN`, `core.mjs:259`) behind the
prefix, because PR feedback copies the id into `--reason-tag`. `gh-Foo`,
`gh--codex`, and a bare `gh-` are rejected at load time rather than failing
later inside a `changes-requested` transition. Aliases are untouched; they
already carry the GitHub login.

### FR-2: Local ids never carry the `gh-` prefix

`[agents].active` entries, `[agents].writer_default`,
`[agents].reviewer_default`, `[agents.runners]` keys, `--owner`, `--reviewer`,
`--actor`, and `BTRAIN_AGENT` values starting with `gh-` are rejected. The
defaults and runner keys are included because `getCollaborationAgentNames`
and `getConfiguredAgentNames` fall back to them when `active` is empty, so a
bot-prefixed name must not be able to enter the local roster through that
path. A bot cannot claim, review, or resolve a lane. Outcomes that a bot's
review produces (feedback, clear, merged, closed) are applied as `system`
events whose details record `bot: <id>`; the bot is attributed in the event
log without ever being an actor.

### FR-3: No id in both sets

`btrain doctor` reports an error when any name in the effective local roster
(`getConfiguredAgentNames(config)`, which covers `[agents].active` and the
default and runner-map fallbacks FR-2 lists) equals any bot id, compared
case-insensitively as `getConfiguredAgentNames` itself dedupes, when a bot id
lacks the `gh-` prefix (FR-1), or when a local id carries it (FR-2). The pair `codex` (local) and `gh-codex` (bot) is
legal and is the intended end state of the migration: the prefix is the
discriminator, and FR-4 labels carry the rest. The rule does not treat the
prefixed and unprefixed forms as the same word.

### FR-4: Labeled rendering

Every btrain output that can show a local agent and a bot in the same view
prefixes them: `agent <name>` and `bot <id>`. Today two sites mix kinds: the
PR-feedback next-action text written by `applyPrStatusToHandoff`
(`pr-flow.mjs:669`), and `btrain pr status`, to which this spec adds one
`owner:` line so a reader sees who acts on the bot's feedback. `btrain
status`, the dashboard, and PR bodies show local agents only and omit the
label until they render bot state.

### FR-5: Reason tags and markers use the prefixed id

Reason tags recorded on PR-feedback `changes-requested` transitions and the
`bot=` attribute of the review-request marker use the prefixed id
unchanged. A marker written before the rename does not match the new id;
re-request review after renaming (FR-7).

### FR-6: The formal model is unaffected

`LaneLock.tla` and `lane-lock-model.mjs` model local agents only. GitHub bots
are external events (`PrClear`, `PrFeedback`, `PrTerminal`). No change.

### FR-7: Migration

0. Land the parser fix above (`parseProjectToml` accepts `-` in table headers
   and bare keys) with its test. Steps 1 through 4 depend on it.
1. Move btrain's own defaults to the new namespace in the same change that
   turns FR-1 on: the `required_bots` default in `getPrFlowConfig`
   (`["codex", "unblocked"]` today), the id special cases in
   `normalizePrBotConfig`, the `btrain init` template's `[pr_flow]` block, and
   the harness fixtures. FR-1 rejects only what a repository configures; the
   defaults must already be `gh-codex` and `gh-unblocked`, or every repository
   without a `[pr_flow]` block would fail on `handoff resolve`, which reads
   the PR-flow config unconditionally.
2. Rename each configured `[pr_flow.bots.<id>]` table and `required_bots`
   entry to `gh-<id>`.
3. Immediately, before any `btrain pr poll --apply`, run `btrain pr
   request-review --lane <id> --bots all` once per open PR-flow lane so the
   marker carries the new id. A clear that came only from a +1 reaction to an
   old-id marker is not recognized until the new marker exists.
4. Existing `changes-requested` lanes keep their old reason tag until the
   next transition; no history rewrite.

This repository performs step 2 in this spec's lane. Step 0 is in PR #34;
step 1 ships with the FR-1 code; steps 3 and 4 happen when this lane merges.

## Non-Goals

- Renaming local agent identities.
- Changing how aliases match GitHub logins.
- Introducing a third namespace for humans. A human reaches btrain through
  the spec 006 FR-2c/2d override, not as an actor id.

## Relation to other specs

Merge dependencies: spec 015 (PR #37) for the actor predicates `owner`,
`reviewer`, `lane-agent`, `system`, and spec 017 (PR #36) for the `#<role>`
suffix grammar. Until they merge, this spec relies on exactly those two
contracts as stated here: local actor predicates are the four above, and
`#<role>` is the only reserved suffix on a local id.

- **Spec 002**: `[pr_flow]` configuration gains the prefix rule; the
  PR-flow states table is unchanged.
- **Spec 015**: actor predicates apply to local ids only; `system` covers bot
  events. Row 9 (`PrFeedback`) records the prefixed reason tag.
- **Spec 017**: `#<role>` is the only suffix on local ids; `gh-` is the only
  prefix on bot ids. Neither may combine.

## Acceptance Criteria

- `btrain pr status --lane <id>` prints `bot gh-codex` in the required-bots
  block and `agent <owner>` in the new owner line.
- A `changes-requested` lane created from bot feedback carries reason tag
  `gh-codex` and a next action reading "Address bot gh-codex feedback".
- `btrain doctor` errors when `[agents].active` contains `codex` and
  `[pr_flow.bots]` contains `codex` (FR-1 already rejects the unprefixed bot
  id, so this is the pre-migration state). It passes on `codex` plus
  `gh-codex`, the intended end state: the prefix is the discriminator and
  FR-4 labels do the rest.
- A bot set containing both `codex` and `gh-codex` fails FR-1 (`codex` is an
  unprefixed bot id), not FR-3. A local agent named `gh-anything` fails FR-2.
  FR-3 fires only on an exact string collision between a local id and a bot
  id.

## Open questions

None open. Bot attribution is decided in FR-2 (system events carry
`bot: <id>`; `--actor gh-<id>` is always rejected), and the single FR-3 rule
makes the former migration-window question moot.
