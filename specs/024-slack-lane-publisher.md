# 024 — Slack Lane Publisher

**Status**: Draft
**Version**: 0.4.1
**Author**: btrain (claude)
**Date**: 2026-11-23

## Decision

btrain publishes lane progress to Slack itself. The code path that records a
lane change also queues a Slack post, and plain code renders and sends it. No
agent writes, formats, or remembers to send a status message.

Slack is an output. btrain never reads Slack, and nothing posted there
changes lane state. The publisher is off by default and a Slack failure never
blocks, delays, or fails a lane transition.

This spec covers publishing only. Taking commands from Slack, and a model
that talks to the operator there, are spec 025.

## Why

- **Agents should not spend context on status posts.** A model that must
  post to Slack has to load the instructions, compose the message, and spend
  a turn on it. A model that forgets, or describes the state loosely, leaves
  the channel wrong.
- **The channel must match the lane.** A post that is produced by the state
  change cannot disagree with it.
- **btrain cannot reach the operator away from the Mac.** Its only
  notification today is `pushAgentPrompt` (`core.mjs`), which writes
  `~/.btrain/pending/<agent>.md` and raises a macOS notification through
  `osascript`.
- **Every workflow event already passes through one function.**
  `appendWorkflowEvent` (`core.mjs`) has eight callers on `main` at
  `95b6294`: handoff updates, overrides, history compaction, repair
  dispositions, and the watchdog. That is the seam.
- **An incoming webhook is not enough.** Slack's webhook returns the plain
  text `ok` and no message timestamp, cannot delete a message, cannot
  override its channel, and documents no way to update a message. The
  publisher must update a lane's card in place and reply in its thread, which
  needs `chat.postMessage` and `chat.update` with a bot token.

## What the operator sees

One thread per lane task, in the channel the repository is mapped to. A
channel belongs to a project and usually carries several repositories.

**The card** is the thread's top message. btrain rewrites it on every change,
so it always shows the lane's current state:

```
btrain · lane e · in-review
dev: brian
task: Draft spec 023: cross-lab review routing with a 15-minute fallback
owner: claude    reviewer: codex-reviewer (other-lab)
pr: none    locks: 2 files
updated: 2026-11-23 18:42 UTC
```

**Replies** in the thread record each change, one line each:

```
claude claimed lane e
sent to review · reviewer codex-reviewer
codex-reviewer picked up the review
codex-reviewer requested changes · missing-verification · "no test for the timeout path"
sent to review · reviewer codex-reviewer
approved · ready for PR
PR #114 opened
PR #114 clear · ready to merge
merged · lane resolved after 3h 10m, 2 review rounds
```

**The board** is one pinned message for each developer in each channel. It
lists that developer's active lanes in every repository mapped to the
channel, one line each, and btrain updates it in place.

**Mentions.** btrain mentions a person in two cases only (FR-15): a problem
that automatic handling could not clear, and a PR that is being merged,
with its link.

## Configuration

Secrets and workspace identifiers live in the user's global btrain home,
never in a repository:

```json
// ~/.btrain/slack.json  (mode 0600, owned by the user)
{
  "botToken": "xoxb-...",
  "label": "brian",
  "operator": "U0XXXXXXXXX",
  "mention": ["U0XXXXXXXXX"],
  "defaultChannel": "C0CCCCCCCCC",
  "channels": {
    "/Users/dev/code/btrain": "C0AAAAAAAAA",
    "/Users/dev/code/shop-web": "C0BBBBBBBBB",
    "/Users/dev/code/shop-api": "C0BBBBBBBBB",
    "/Users/dev/code/shop-docs": "C0BBBBBBBBB"
  }
}
```

`.btrain/project.toml` holds only the toggle and the content options:

```toml
[features]
slack = true

[slack]
task_chars = 300
summary_chars = 200
inline_timeout_ms = 2000
```

## Functional Requirements

### FR-1: A feature toggle, off by default

`slack` joins `FEATURES` in `repo_mode.mjs` with `localDefault: false`, like
`agentchattr` and `handoff_history`. It is on only when `[features].slack` is
exactly `true`. This differs from the older toggles: `isFeatureEnabled`
treats a missing `[features]` table or a missing key as enabled, so that
legacy repositories keep everything on. That rule would switch the publisher
on in every existing repository, so `slack` is marked explicit-only, and
`btrain features` shows and writes it the same way. With the
toggle off, btrain writes no outbox, makes no network call, and prints
nothing about Slack.

### FR-2: Credentials never enter a repository

The bot token is read from `BTRAIN_SLACK_BOT_TOKEN`, else from
`~/.btrain/slack.json` (`BRAIN_TRAIN_HOME` moves it). The file is read under
the rules `loadSystemOneRuntimeConfig` already applies to `jev.json`: opened
without following symlinks, at most 4096 bytes, owned by the current user,
and not readable by group or other. A file that fails a check is reported as
`insecure-credential-file` or `invalid-credential-file` and the publisher
stays off.

The channel for a repository comes from `channels` in the same file, keyed
by the repository's registered path. Registered names are not unique: two
repositories can share one, and a lookup by that name then fails. The operator's Slack user ID comes from
`operator`, and the people to mention from `mention`. None of these appears
in `project.toml`. Channel mapping is FR-16.

`btrain slack setup` writes the file. It reads the token from standard input,
never from an argument, so the token does not reach shell history or the
process list.

The file is the dependable source. The reviewer environment allowlist that
spec 017 FR-3 proposes would drop `BTRAIN_SLACK_BOT_TOKEN`, and the btrain
process an agent starts would still find the file through `HOME`.

### FR-3: Every workflow event is offered to the publisher

`appendWorkflowEvent` offers each event to the publisher after the event is
written. The publisher writes one file for each entry into
`<state root>/.btrain/slack/outbox/`. A file is written under a temporary
name and renamed into place, and it is removed when its entry is done.
Nothing appends to a shared file, so two btrain processes cannot lose each
other's entries. An entry looks like this:

```json
{"id": "<uuid>", "queuedAt": "<ISO time>", "laneId": "e",
 "kind": "sent-to-review",
 "fields": {"actor": "claude", "reviewer": "codex-reviewer"}}
```

`fields` holds only the values the entry's message needs, already scrubbed
(FR-8). The workflow event itself is not copied into the outbox. It stays in
the event log.

`id` comes from `crypto.randomUUID()`. The state change and the event are
complete before the entry is queued. An error while queuing is logged and
swallowed. Text is scrubbed for secret patterns (FR-8) before the entry is
written, so no outbox entry ever holds a secret.

State changes that are recorded outside the workflow log are offered the same
way when they exist: reviewer dispatch outcomes today, and the attempt,
pickup, fallback, and fix events of spec 023 when it lands.

### FR-4: Delivery is opportunistic and bounded

btrain has no daemon, and this spec adds none.

- **Delivery comes last.** A command queues its entries and finishes its own
  work first: the state change, the event, and its printed result. Only then
  does it try to deliver, with a total budget of 2 seconds
  (`[slack].inline_timeout_ms`). What it cannot send stays queued. No
  delivery step runs before a transition.
- Any btrain command that changes state drains older entries in that same
  final step, as do `btrain loop`, `btrain handoff wait`, and
  `btrain slack flush`.
- **The delivery lock never waits.** A process that finds the outbox lock
  held skips delivery and leaves the queue to the holder. It does not use
  `withFileLock`, which waits up to 5 seconds and then throws. The holder
  touches the lock before every Slack call. A lock is taken over only when
  it has not been touched for 60 seconds, so a long flush never looks
  abandoned. A holder checks before every send that the lock is still its
  own, and stops if it is not.
- **Delivery never sleeps and never throws.** A Slack error, a timeout, or a
  `Retry-After` records the earliest next try on the entry and returns.
- Entries for one lane are sent in order. A failing entry holds back later
  entries for that lane only.
- An entry older than 24 hours is not sent as a reply. Its lane gets one
  reply, "N updates were not delivered", and a card refresh.

### FR-5: One thread per lane task

A claim creates the card with `chat.postMessage` and stores the channel and
the returned `ts` in `<state root>/.btrain/slack/threads.json`, keyed by lane
and claim time. Later events for that claim reply with that `ts` as
`thread_ts` and update the card with `chat.update`. A new claim on the same
lane starts a new thread. When the publisher is enabled while a lane is
already active, the card is created on that lane's next event.

### FR-6: The card is rendered from current state

The card is rendered from the lane's state at delivery time, not from the
event that triggered it. Sending the same card twice is harmless, and a card
is correct even when replies were dropped or delayed.

Card fields, in fixed order: repository, lane and display status, developer
label (FR-14), task, owner, reviewer and review tier, PR, lock count, last
update time. The display status is the
stored status, or the display state of spec 023 (`in-review`,
`confirming-fix`) when that spec is implemented.

### FR-7: Replies only for changes worth reading

A reply is posted when one of these changes: status, owner, reviewer, linked
PR, or lock coverage; and for override grants and consumption, repair
dispositions, watchdog repairs, and reviewer dispatch failures. Any other
update, such as new reviewer context or a changed next action, refreshes the
card and posts no reply.

Each reply is one line built from a fixed template per event kind. No model
writes or edits it.

### FR-8: Text is escaped, cut, and scrubbed

Lane text is written by agents and is untrusted.

- `&`, `<`, and `>` are converted to `&amp;`, `&lt;`, and `&gt;` in every
  agent-written field, so agent text cannot produce a mention or a
  channel-wide notification.
- Slack turns a bare URL into a link even in escaped text. In every
  agent-written field the scheme separator `://` is rewritten to `[:]//`, so
  agent text cannot produce a link.
- `link_names` is never sent, so Slack does not turn plain `@here` or
  `@channel` text into a notification.
- `unfurl_links` and `unfurl_media` are sent as `false`.
- The task is cut to `[slack].task_chars` and a review summary to
  `[slack].summary_chars`. Every message stays under 4,000 characters.
- The secret patterns of `btrain review code` (`review/code-rules.mjs`) are
  applied before text is queued. A match is replaced with `[redacted]`. This
  spec adds two patterns that the list lacks today: Slack webhook URLs and
  GitHub fine-grained tokens (`github_pat_`).
- Diffs, file contents, environment values, and the full reviewer context
  are never posted. Only the fields named in FR-6 and FR-7 are.

The only mentions btrain writes are the configured `mention` IDs, in the two
cases of FR-15.

### FR-9: The board

Each channel has one board for each developer. It lists that developer's
active lanes in every repository mapped to that channel, grouped by
repository: lane, display status, owner, reviewer, PR. A board spans
repositories, so its message `ts` is stored in the developer's global btrain
home, not in one repository's state. It is updated in place on each change
and btrain pins it to the channel with `pins.add`, so a person can always
find it. If the pin fails, the board still works and `btrain slack status`
reports that it is not pinned.

The board is rendered from a read of each repository's lane state. A
repository whose state cannot be read at that moment, because of a lock or
an error, keeps its last rendered lines with a "not refreshed" note. One
repository never blocks the board for the others.

### FR-10: Failures are classified and never block a lane

- `ratelimited`, HTTP 429, `internal_error`, `service_unavailable`,
  `fatal_error`, `request_timeout`, and network errors are transient. The
  entry stays queued. A 429 is retried no earlier than its `Retry-After`.
  The publisher sends at most one message per second to a channel.
- `invalid_auth`, `token_revoked`, `token_expired`, `account_inactive`,
  `missing_scope`, `not_allowed_token_type`, `channel_not_found`,
  `not_in_channel`, `no_permission`, and `is_archived` are configuration
  errors. The publisher pauses for that repository, keeps queuing, and stops
  calling Slack until `btrain slack test` succeeds.
- An error about one message's content, such as `msg_too_long`, drops that
  entry and is counted and logged. An error btrain does not recognize is
  retried for 5 attempts and then dropped the same way. No entry is retried
  forever, so one bad entry cannot hold a lane's later entries.
- No Slack outcome changes the exit code or the output of the btrain command
  that queued the entry, apart from one warning line when the publisher is
  paused.

A reply can be sent twice when a process stops between Slack's response and
the removal of its entry file. Replies are therefore at-least-once. The card and the
board are rewritten whole, so they are always correct.

### FR-11: Commands

- `btrain slack setup [--channel <id>] [--operator <id>]`: write or update
  `~/.btrain/slack.json`; token from standard input.
- `btrain slack test`: call Slack with the token, post one test message to
  the repository's channel, and clear a pause on success.
- `btrain slack status`: toggle, credential source, channel, queue depth, age
  of the oldest entry, pause reason, last error.
- `btrain slack flush`: drain the queue now.
- `btrain slack refresh`: re-render and update the board and every active
  card from current lane state.
- `btrain slack channels`: print the repository-to-channel map (FR-16).

`btrain doctor` reports a paused publisher, a missing token or channel while
the toggle is on, and a queue whose oldest entry is over an hour old.

### FR-12: Agents can find the thread

When the toggle is on, `btrain handoff --lane <id>` prints one extra line
with the lane's channel and thread `ts`, and the guidance "btrain posts lane
status; post in this thread only to ask the operator a question or report a
blocker". An agent that has its own Slack access can then post in the right
thread. btrain does not post for agents and does not read what they post.

The managed block in `CLAUDE.md` and `AGENTS.md` is not changed. A template
change marks every consuming repository as drifted, and the handoff line
reaches the agent at the moment it matters.

### FR-13: One fixed layout

The card and the board use labeled lines (`owner:`, `reviewer:`, `pr:`) with
the same labels and order every time, so a person can scan them and a tool
can parse them without guessing. Current state is always in a top-level
message, never only in a thread reply.

### FR-14: Any developer can set it up, and several can share a channel

Nothing about one person, machine, or Slack workspace is built in.

- **No identifiers in the code or the repository.** The token, workspace,
  channel IDs, and operator ID come only from the developer's own
  `~/.btrain/slack.json` or environment. A repository that enables the
  toggle works for a developer who has not set Slack up: the publisher stays
  off for them and `btrain slack status` says what is missing.
- **A shipped app manifest.** `docs/slack-app-manifest.json` describes the
  Slack app (name, bot user, its two scopes). A developer creates
  the app from it in their workspace, installs it, and runs
  `btrain slack setup`. The README documents those steps.
- **A developer label on everything.** Lane state is local to each machine,
  so two developers on one repository each have their own "lane e". Every
  card, reply, and board carries the developer's `label` (default: the OS
  user name). Each developer's btrain keeps its own threads and its own
  board, and mentions only that developer's `operator`.
- **Shared channel, separate state.** Several developers can publish to one
  channel with one shared app token or one app each. No publisher reads or
  edits another's messages, and each thread map lives in that developer's
  local state.
- **No macOS dependency.** The publisher uses `fetch` only. The
  credential-file ownership and mode checks are skipped on Windows, as
  `loadSystemOneRuntimeConfig` does.

### FR-15: A person is mentioned only after automatic handling, and on merge

btrain mentions the `mention` IDs in two cases.

**A problem that automatic handling could not clear.** A problem first goes
to the process that exists to handle it. The mention is sent when that
process gives up, not when the problem appears.

| Problem | Handled first by | A person is mentioned when |
|---|---|---|
| Lane enters `repair-needed` | The repair owner's attempt (spec 006 FR-7) | The repair escalates to a human after its one retry (spec 006 FR-18) |
| Reviewer dispatch fails or times out | The next reviewer, then the same-lab fallback (spec 023 FR-4) | No reviewer is available at any tier, or a same-lab review needs escalation (spec 023 FR-8) |
| Late request for changes | The owner is dispatched to acknowledge it (spec 023 FR-6) | It is still unacknowledged after `[review].other_lab_window` |
| Outside-lab PR bot is silent | The next outside-lab bot is requested (spec 023 FR-9) | Every outside-lab bot is silent past the pending window |
| Stale or inconsistent lane state | The watchdog's safe repairs (spec 006 FR-2) | The lane enters `repair-needed` and that repair escalates |
| Reviewer silent on a lane with a linked PR | The recorded reviewer is tried again; the reviewer cannot be changed while a PR is linked (spec 023 FR-7) | No verdict when `[review].other_lab_window` ends |
| Reviewer fix waiting for the owner | The owner is dispatched to confirm it (spec 023 FR-12) | The owner has not picked it up within `[review].other_lab_window` |
| Lane needs repair while in `fix-confirmation` | Nothing automatic; that status cannot enter `repair-needed` (spec 023) | At once |

Each problem is posted in the lane's thread without a mention when it
happens, so the thread shows the problem and the attempt to fix it.

Until spec 023 is implemented, a failed reviewer dispatch has no automatic
handler, so it mentions a person directly.

**A merge.** When a lane reaches `ready-to-merge`, btrain posts that the PR
cleared review and is being merged, with the PR's link and a mention. The
link is the PR's GitHub URL, which btrain writes itself; agent text is never
placed inside a link. The later "merged" reply has no mention.

Nothing else carries a mention. A publisher that cannot reach Slack cannot
mention anyone; `btrain doctor` and the existing desktop notification cover
that case.

### FR-16: Channels belong to projects, and a person chooses the mapping

A channel covers a project, which usually has several repositories. Several
repositories can map to one channel, and every card, reply, and board line
names its repository.

- btrain never creates a Slack channel and never picks one for a repository.
- A repository with no entry in `channels` publishes to `defaultChannel`,
  the developer's one catch-all channel for repositories that have no
  project channel. With no `defaultChannel` set it publishes nothing, and
  `btrain slack status` says "no channel mapped" and how to map it.
- `btrain slack setup` in an unmapped repository lists the channels already
  in the map, with the repositories each one carries, and asks the developer
  to choose one of them, the catch-all, or a new channel ID. Folding the
  repository into an existing project channel is the first choice offered.
- `btrain slack channels` prints the whole map, so a developer can see how
  many channels are in use before adding one.

## Slack app requirements

- An internal Slack app with a bot token and the `chat:write` and
  `pins:write` scopes, invited to each mapped channel.
  `chat:write.public` is not needed. The manifest in FR-14 creates exactly
  this.
- A person creates the app and the token. btrain does not create Slack apps,
  and no agent is asked to.

## Non-Goals

- Reading Slack, or acting on anything posted there.
- Commands from Slack and a conversational orchestrator. See spec 025.
- A long-running btrain process.
- Posting on behalf of agents.
- Buttons, modals, or other interactive Slack features.
- Direct messages, Slack Connect channels, and more than one workspace.
- Mirroring GitHub directly. Slack shows btrain's lane state. A merge appears
  when `btrain pr poll` records it.

## Risks

- **Any local agent can read the token file.** Agents run as the same OS
  user. The token can only post as the btrain app in channels the app was
  invited to. Keep its scopes to the ones this spec names.
- **Posts can become context for other agents.** Any assistant app that is
  added to the channel may read btrain's posts. Task text written by one
  agent can then reach another agent's prompt. FR-8 limits what is posted
  and how long it is. The orchestrator of spec 025 does not read the
  channel for lane state; it reads btrain directly.

## Relation to other specs

- **Spec 002, 005, 015**: no change. The publisher runs after a transition is
  committed and cannot affect it.
- **Spec 017 FR-3**: the reviewer environment allowlist is why FR-2 prefers
  the credential file over the environment variable.
- **Spec 022**: adds one feature toggle and follows its rule that every
  optional subsystem honors its toggle.
- **Spec 023**: adds event kinds (dispatch, pickup, unresponsive, fallback,
  fix applied, fix confirmed, late review) and display states. This spec
  works without it and gains those lines when it lands.
- **A future btrain server**: the outbox, the renderer, and the thread map do
  not depend on where delivery runs. A server would run the same relay
  continuously, which removes the "next btrain command" delay of FR-4.

## Formal-Impact Declaration

**No semantic impact.** This spec adds no status, transition, guard, lock
rule, or authority. The transition gate (`applyTransition`) is not touched
and stays a pure function (spec 015 FR-12): the publisher runs after the
gate, after the state write, and after the event append. Evidence for this
draft: `python3 scripts/tla_pin.py --check` reports 1 pin clean, and no
pinned prose is edited. The implementation lane runs the pin check and
`npm run test:formal` and expects the same results as `main`.

## Tests

All tests inject a fake `fetch`, the way `system-one.mjs` accepts
`fetchImpl`. No test calls Slack.

- Toggle off, or no `[features]` table: no outbox entry, no fetch call.
- Claim, review request, request-changes, approval, PR link, and merge each
  produce the expected reply text and a card with the expected fields.
- A metadata-only update refreshes the card and posts no reply.
- A fetch that fails or hangs leaves the lane transition's result and exit
  code unchanged, the command's result is printed before any Slack call, and
  the entry stays queued.
- A held outbox lock makes a command skip delivery. It does not wait or
  throw.
- Agent text with a bare `https://` URL, a Slack webhook URL, and a
  `github_pat_` token is posted with no link and both secrets redacted, and
  neither secret is in any outbox entry.
- Two registered repositories with the same name map to their own channels
  by path.
- A repository whose state cannot be read does not stop the board from
  updating for the others.
- A later command drains the queue in order. A failing entry on lane a does
  not hold back lane b.
- Two concurrent processes deliver each entry once.
- A 429 with `Retry-After` is not retried early.
- `channel_not_found` pauses the publisher, `btrain doctor` reports it, and
  `btrain slack test` clears it.
- Agent text containing `<!channel>`, `<@U123>`, `&`, and a GitHub token
  pattern is posted escaped and redacted, with no `link_names`.
- A credential file that is group-readable, a symlink, or too large is
  rejected and the publisher stays off.
- The token never appears in an outbox entry, a log line, or command output.
- Entries older than 24 hours collapse to one reply.
- The board is created once, pinned, and updated in place. A failed pin is
  reported by `btrain slack status` and blocks nothing.
- A lane entering `repair-needed` posts with no mention. Its escalation to a
  human posts with one.
- `ready-to-merge` posts one message with the PR link and a mention. The
  "merged" reply has none.
- Two repositories of one developer mapped to one channel share that
  developer's board, grouped by repository, and keep separate threads.
- An unmapped repository posts to `defaultChannel`. With none set it makes
  no network call, and `btrain slack status` says no channel is mapped.
- With the toggle on and no credential file, every lane command succeeds
  with no network call, and `btrain slack status` names the missing token.
- Two state roots with different labels publishing to one channel keep
  separate threads and boards, and neither updates the other's messages.
- A repository-wide search finds no Slack token, workspace ID, channel ID,
  or user ID outside test fixtures that use obviously fake values.

## Follow-ups

- Start cloud agents through their own APIs rather than through Slack
  mentions.
- Per-lane and per-day digests, if the thread volume proves too high.

## Decisions (2026-11-23, Brian)

1. Channels belong to projects. Several repositories map to one channel, and
   repositories with no project channel share one catch-all channel (FR-16).
2. A person is mentioned only when automatic handling is exhausted, and when
   a PR is being merged, with its link (FR-15).
3. Task text is posted, cut to 300 characters, escaped, and scrubbed (FR-8).
4. The board is in the first version (FR-9). It is the one message a person
   can open to see every active lane.
5. Another developer must be able to use the publisher with their own
   workspace, app, and configuration (FR-14). One app for a workspace and one
   app for each developer both work.

## Open questions

None.
