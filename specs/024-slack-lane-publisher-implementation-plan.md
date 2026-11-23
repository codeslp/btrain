# 024 — Slack Lane Publisher Implementation Plan

**Status:** Draft
**Spec:** [024 — Slack Lane Publisher](024-slack-lane-publisher.md)
**Date:** 2026-11-23

## Plan decision

Build the publisher as a new module tree, `src/brain_train/slack/`, and wire it
into btrain at a few small seams. Write the pure parts first (text handling,
event classification, rendering), then the outbox and the Slack client, then
the wiring. Each workstream is one lane and one PR. The feature stays off until
the pilot in WS6, and every PR before that is inert in a repository that has
not turned it on.

Four constraints shape the design:

- **No new function in `core.mjs`, and no added line in two pinned functions.**
  `scripts/decomposition_inventory.mjs` and
  `specs/020-ws2-module-assignment.json` account for every function in that
  file, and the JSON is locked by another lane.
  `node scripts/decomposition_inventory.mjs --stages` exits non-zero when
  `core.mjs` holds a function the JSON does not assign.
  `test/decomposition_inventory.test.mjs` also pins `patchHandoff` at 585 lines
  and `runLoop` at 422. Core changes are an import and single call lines inside
  three other functions.
- **`slack/` never imports `core.mjs`.** `core.mjs` imports one entry point
  from `slack/index.mjs`. Anything the publisher needs from core, such as a
  lane-state reader, is passed in by `cli.mjs`. This avoids an import cycle.
- **Other lanes may hold the files the wiring needs.** A `btrain locks`
  snapshot on 2026-11-23, taken from a session that was not lane-scoped,
  showed `core.mjs` and `README.md` locked by lane h, `cli.mjs` by lane c, and
  `repo_mode.mjs` by lane a. That will change. Run `btrain locks` again before
  claiming each workstream, from an unscoped session: a lane-scoped session
  sees only its own lane's locks. WS1 and WS3 touch none of those files and
  can start at once.
- **Zero runtime dependencies and no usage-billed service.** HTTP uses the
  built-in `fetch`, as `system-one.mjs` does. IDs use `node:crypto`.

The repo has numbered flat specs and no `.specify/` script or template
directory. This plan uses that established format and records the design, data
model, contracts, and quality gates here.

This lane also amends spec 024 where review of this plan showed the spec could
not be built as written: FR-1 (how "on" is decided), FR-3 and FR-4 (the outbox
is a directory of entry files with a heartbeat lock), and FR-10 (errors that
drop one entry).

## Current integration points

| Surface | Existing state | Planned change |
| --- | --- | --- |
| `appendWorkflowEvent` in `core.mjs` | Appends one JSONL line to the lane's event log. Eight callers. Not a pinned function | After the append, one call to `offerWorkflowEvent` |
| `finishPatchWithReviewerDispatch` in `core.mjs` | Throws a `BtrainError` when reviewer dispatch fails or times out, after `updateHandoff` has already written the event | One call to `offerDispatchFailure` before the throw |
| `doctorRepo` in `core.mjs` | Collects `issues` and `warnings` per repository | Append the findings returned by `slack/doctor.mjs` |
| `patchHandoff` and `runLoop` in `core.mjs` | Pinned at 585 and 422 lines by the inventory test | Not touched |
| The last statement of `cli.mjs` | `run().catch(...)` prints the error and sets exit code 1. `run()` is a chain of `if` blocks that return, and commands set `process.exitCode`; nothing calls `process.exit` | Replace with `try { await run() } catch { print; set exit code } finally { await deliverAfterCommand() }` |
| `printHandoffState` in `cli.mjs` | Prints the guidance string that `checkHandoff` returns. `checkHandoff` itself prints nothing and is also called by PR flow and the startup snapshot | Print the FR-12 thread line here, so only `btrain handoff` shows it |
| Command routing in `cli.mjs` | One `if (command === "...")` block per command | A `slack` block that delegates to `slack/cli.mjs` |
| `isFeatureEnabled` and `FEATURES` in `repo_mode.mjs` | Thirteen toggles. A missing `[features]` table or a missing key means enabled, so legacy repositories keep everything on. `localDefault: false` only affects the table written for a new repository | Add `slack` with `localDefault: false` and a new `explicitOnly: true` flag. `isFeatureEnabled` returns true for an explicit-only feature only when its key is exactly `true` |
| `SECRET_PATTERNS` in `review/code-rules.mjs` | Module-private list of seven patterns. It does not match a Slack webhook URL or `github_pat_` | Export it and add those two patterns |
| `loadSystemOneRuntimeConfig` in `system-one.mjs` | Reads `~/.btrain/jev.json` with no-follow, size, owner and mode checks | Unchanged. The same checks are written once in `slack/credentials.mjs`; sharing one helper is a follow-up |
| `withFileLock` in `core.mjs` | Waits up to 5 seconds, then throws; steals a lock older than 30 seconds | Not used. Delivery has its own lock |
| Lane state | Holds `prNumber`, not a PR URL | Unchanged. The link is built from the `origin` remote and the PR number |
| `~/.btrain` via `getBrainTrainHome` | Registry, templates, `jev.json`, `dashboard.json` | Add `slack.json` and `slack/boards.json` |
| `<state root>/.btrain/` | Locks, events, overrides, PR comments. Ignored by git except `project.toml` | Add `slack/` for the outbox and the thread map |

## Architecture and invariants

### Modules

| Module | Responsibility | Pure |
| --- | --- | --- |
| `slack/text.mjs` | Scrub secrets, cut to length, escape, defang URLs | Yes |
| `slack/events.mjs` | Turn a workflow event into a kind, a reply decision, and a mention decision | Yes |
| `slack/render.mjs` | Card, reply line, and board text | Yes |
| `slack/config.mjs` | The explicit toggle, `[slack]` options, channel for a repository, mention list | No |
| `slack/credentials.mjs` | Token from the environment or the private file, with the file checks | No |
| `slack/outbox.mjs` | Write an entry file, list pending entries, remove a finished one, record retry state | No |
| `slack/lock.mjs` | The delivery lock with a heartbeat | No |
| `slack/client.mjs` | `chat.postMessage`, `chat.update`, `pins.add`, `auth.test` over an injected `fetch`; error classes | No |
| `slack/threads.mjs` | Thread map in the state root; board map in the global home | No |
| `slack/deliver.mjs` | Drain: order, budget, card from current state, board | No |
| `slack/doctor.mjs` | Findings for `btrain doctor` | No |
| `slack/cli.mjs` | `setup`, `test`, `status`, `flush`, `refresh`, `channels` | No |
| `slack/index.mjs` | `offerWorkflowEvent`, `offerDispatchFailure`, `deliverAfterCommand` | No |

`offerWorkflowEvent(repoRoot, config, event)` gets everything it needs as
arguments. `deliverAfterCommand` takes a `readLanes` function from `cli.mjs`,
which is how delivery reads current lane state without importing core.

### Invariants

Each one is a test. WS0 adds them skipped, and the workstream that makes one
pass removes its skip.

1. With the toggle off, no file is created under `.btrain/slack/` and `fetch`
   is never called. A repository with no `[features]` table has the toggle
   off.
2. A command's state change, its event, and its printed result or error are
   complete before any Slack call.
3. No Slack or delivery outcome throws into a lane command or changes its exit
   code.
4. The outbox, the thread map, logs, and command output never contain the token
   or a string that matches a secret pattern.
5. Agent-written text cannot produce a mention or a link.
6. A card and a board are functions of current lane state. Sending one twice
   leaves Slack unchanged.
7. A process that finds a live delivery lock skips delivery and returns.
8. `core.mjs` gains no function, and `patchHandoff` and `runLoop` keep their
   line counts. The gates are `node scripts/decomposition_inventory.mjs
   --stages` and `test/decomposition_inventory.test.mjs`.

### Data model

**Outbox**: a directory, `<state root>/.btrain/slack/outbox/`, with one file for
each entry, named `<queuedAt>-<id>.json`. An entry is written under a temporary
name and renamed into place, so a reader never sees half an entry and two
writers never share a file. Delivery lists the directory in name order and
removes a file when its entry is done. Nothing appends to a shared file.

```json
{"id": "<uuid>", "queuedAt": "<ISO>", "laneId": "e", "claimKey": "<claim time>",
 "kind": "sent-to-review", "reply": true, "mention": false,
 "fields": {"actor": "claude", "reviewer": "codex-reviewer", "summary": "..."}}
```

`fields` holds only what a template needs, already scrubbed. The workflow event
is not copied into the outbox.

**`delivery-state.json`**, written to a temporary file and renamed, only by the
lock holder: for each entry that has failed, `attempts`, `nextTryAt`, and
`lastError`; a `paused` object with the reason when a configuration error stops
delivery; and counters for sent, dropped, and collapsed entries.

**`threads.json`**, in the state root: `"<laneId>@<claimKey>"` to
`{channel, cardTs}`.

**`boards.json`**, in `~/.btrain/slack/`: channel to `{ts, pinned, repos}`,
where `repos` maps a registered path to its last rendered lines and the time
they were read.

**`slack.json`**, in `~/.btrain/`: as the spec's Configuration section gives
it. `channels` is keyed by registered repository path.

### The delivery lock

`<state root>/.btrain/slack/delivery.lock`, created with an exclusive open.

- The holder touches the file before every Slack call. Each call has a
  10-second timeout.
- A process that finds the lock checks its modification time. Under 60 seconds
  old, the lock is live and the process skips delivery. Older, the holder is
  gone and the process removes the lock and takes it.
- A long flush therefore never looks abandoned while it is working, and two
  live processes never both hold the lock.

### Text pipeline

One exported function handles every agent-written field, in this order:

1. Scrub: replace each secret match in the whole field with `[redacted]`.
2. Cut to the field's length on a character boundary.
3. Escape `&`, `<`, and `>`.
4. Rewrite `://` to `[:]//`.

Scrubbing comes first so that a cut cannot leave the start of a secret behind.
The configured mention IDs and the PR link are added by the renderer after
this function, because btrain writes them itself. The finished message is cut
to 3,999 characters.

### Event kinds

`slack/events.mjs` maps a workflow event's `type` and its `before` and `after`
snapshots to one kind. The first matching row wins.

| Kind | Trigger | Mention |
| --- | --- | --- |
| `claimed` | `claim` event | No |
| `sent-to-review` | status becomes `needs-review` | No |
| `changes-requested` | status becomes `changes-requested` | No |
| `approved` | status becomes `ready-for-pr`, or `resolved` from `needs-review` | No |
| `pr-linked` | `prNumber` changes to a new value | No |
| `returned-to-pr` | status becomes `pr-review` from `changes-requested` | No |
| `ready-to-merge` | status becomes `ready-to-merge` | Yes, with the PR link |
| `merged` | status becomes `resolved` from a PR-flow status | No |
| `abandoned` | status becomes `resolved` from `in-progress` or `changes-requested` | No |
| `repair-needed` | status becomes `repair-needed` | Only when `repairEscalation` is `human` |
| `repair-cleared` | status becomes `in-progress` from `repair-needed` | No |
| `repair-resolved` | status becomes `resolved` from `repair-needed` | No |
| `repair-disposition` | `repair-disposition` event | No |
| `roles-changed` | owner or reviewer changes | No |
| `locks-changed` | lock coverage changes | No |
| `override` | `override-granted` or `override-consumed` | No |
| `watchdog` | `watchdog-repair` | No |
| `dispatch-failed` | offered by `finishPatchWithReviewerDispatch` | Yes, until spec 023 lands |
| `status-changed` | any other change of status | No |

Every row above posts a reply. An event that matches none of them, such as a
change to reviewer context or the next action, refreshes the card and posts no
reply. `status-changed` is a generic template with the old and new status, so
a status that this table does not name is never silent.

### Slack contract

| Call | When | Arguments that matter | On success |
| --- | --- | --- | --- |
| `auth.test` | `btrain slack test`, `btrain slack status` | Token | Report workspace and bot user |
| `chat.postMessage` | New card, reply, new board | `channel`, `text`, `thread_ts` for a reply, `unfurl_links: false`, `unfurl_media: false`. Never `link_names` | Store the returned `ts` for a card or board |
| `chat.update` | Card or board refresh | `channel`, `ts`, `text` | Nothing to store |
| `pins.add` | Once, after a new board | `channel`, `timestamp` | Mark the board pinned |

Errors fall into four classes:

| Class | Errors | Effect |
| --- | --- | --- |
| Transient | `ratelimited`, HTTP 429, `internal_error`, `service_unavailable`, `fatal_error`, `request_timeout`, network errors | Set `nextTryAt`. A 429 waits at least its `Retry-After` |
| Configuration | `invalid_auth`, `token_revoked`, `token_expired`, `account_inactive`, `missing_scope`, `not_allowed_token_type`, `channel_not_found`, `not_in_channel`, `no_permission`, `is_archived` | Pause delivery for the repository until `btrain slack test` succeeds |
| Entry | `msg_too_long`, `invalid_arguments`, and other errors about one message's content | Drop that entry, count it, log the error name |
| Unknown | Any other error name | Treat as transient for 5 attempts, then drop the entry and log it |

No entry is retried forever, so one bad entry cannot hold a lane's later
entries.

A live check on 2026-11-23 with the real app confirmed that a post and an
in-place update succeed with `chat:write`.

### CLI contract

| Command | Output | Exit code |
| --- | --- | --- |
| `btrain slack setup [--channel <id>] [--operator <id>]` | Reads the token from standard input and writes `~/.btrain/slack.json` with mode 0600. For an unmapped repository it asks where to publish, offering in order: an existing project channel, with the repositories each carries; the catch-all; a new channel ID | 0, or 1 on an invalid token or a failed file check |
| `btrain slack test` | Calls `auth.test`, posts one message, clears a pause | 0 on success, 1 otherwise |
| `btrain slack status` | Toggle, credential source, channel, pending count, oldest entry age, pause reason, last error, board pinned or not | 0 always |
| `btrain slack flush` | Drains the queue with no time budget; prints counts | 0 always |
| `btrain slack refresh` | Re-renders the board and every active card | 0 always |
| `btrain slack channels` | The path-to-channel map and the catch-all | 0 always |

No command prints the token.

## Workstreams and order

| WS | First artifact | Files other lanes held on 2026-11-23 | Depends on | Done when |
| --- | --- | --- | --- | --- |
| 0 Harness and invariants | A fake Slack `fetch` and the eight invariant tests, skipped | None | — | The harness records calls and can fail, hang, and rate-limit on demand; `npm test` matches `main` |
| 1 Text, events, rendering | `slack/text.mjs`, `events.mjs`, `render.mjs`; exported secret patterns | None | WS0 | Every kind and every text rule has a test; invariant 5 passes |
| 2 Config, credentials, setup | `slack/config.mjs`, `credentials.mjs`; the explicit toggle; `setup`, `status`, `channels`, `test` | `repo_mode.mjs` (lane a), `cli.mjs` (lane c) | WS0 | A developer can set up and run `btrain slack test` against a real workspace; invariant 1 passes |
| 3 Outbox, lock, client, delivery | `slack/outbox.mjs`, `lock.mjs`, `client.mjs`, `threads.mjs`, `deliver.mjs` | None | WS0, WS1 | Hand-written entries drain to the fake in order, with retry times, pause, and drop |
| 4 Wiring | The offer call, delivery after a command, `flush`, `refresh`, doctor findings, the handoff thread line, the paused warning | `core.mjs` (lane h), `cli.mjs` (lane c) | WS1, WS2, WS3 | A lane's life in a temporary repository produces the expected card and replies in the fake; invariants 2, 3, 4, 6, 7 and 8 pass |
| 5 Board, mentions, sharing | Board with pin, merge announcement with link, escalation mentions, shared channels, catch-all, app manifest, README | `README.md` (lane h) | WS4 | Two repositories and two developer labels share one fake channel correctly |
| 6 Pilot | Toggle on in the btrain repository only | None | WS5 | One week of real lanes, with the measures below reported |
| 7 Spec 023 kinds | Attempt, pickup, fallback and fix kinds; display states; the spec 023 mention conditions | Depends on spec 023's lanes | Spec 023 | Each new kind has a template and a test |

WS1 and WS3 can start today. WS3 does not need WS2: its tests inject the
channel and the token. WS2 can be split so that the modules land first and the
`repo_mode.mjs` and `cli.mjs` edits follow when their lanes resolve.

### WS0: harness and invariants

1. `test/helpers/fake-slack.mjs`: a `fetch` replacement that records every
   call, returns a `ts` for posts, and can be told to return any Slack error,
   an HTTP 429 with `Retry-After`, a network error, or to never resolve.
2. One test for each invariant, written against the planned module interfaces
   and marked skipped with the workstream that will enable it. `npm test`
   stays the same as `main`.
3. Every test that creates a repository sets `BRAIN_TRAIN_HOME` to a temporary
   directory, so no test registers a repository in the developer's real
   registry or reads the real `slack.json`.

### WS1: text, events, rendering

1. `text.mjs`: the pipeline above, as one exported function.
2. Export `SECRET_PATTERNS` from `review/code-rules.mjs` and add two patterns:
   a Slack webhook URL and a GitHub fine-grained token. `btrain review code`
   then reports those two as hardcoded secrets as well. Add cases to
   `test/review-code-rules.test.mjs` for both.
3. `events.mjs`: the kind table as data, and one function from a workflow
   event to `{kind, reply, mention, fields}`.
4. `render.mjs`: the card with the spec's field order, one template per kind,
   and the board grouped by repository. Templates are data, so a test can
   assert that no template uses a field that skipped the text pipeline.
5. Tests:
   - Each kind from a real event shape, including every row of the kind table.
   - A metadata-only update yields a card refresh and no reply.
   - A status change that no named row covers yields `status-changed`.
   - Text with `<!channel>`, `<@U123>`, `&`, a bare URL, a webhook URL, and a
     `github_pat_` token: no mention, no link, both secrets redacted.
   - A secret that crosses the cut point is fully redacted.
   - A message built from maximum-length fields is at most 3,999 characters.

### WS2: config, credentials, setup

1. Add `slack` to `FEATURES` with `localDefault: false` and
   `explicitOnly: true`. `isFeatureEnabled` returns true for it only when
   `[features].slack` is exactly `true`. `btrain features` reports it the same
   way.
2. `credentials.mjs`: environment variable first, else the private file with
   the no-follow, size, owner, and mode checks, and the same two failure
   reasons the spec names. Windows skips the owner and mode checks.
3. `config.mjs`: `[slack]` options with defaults; channel for a repository by
   registered path, else `defaultChannel`, else none.
4. `slack/cli.mjs`: `setup` with the token from standard input and the channel
   prompt of the CLI contract; `status`; `channels`; `test`.
5. Tests:
   - A repository with no `[features]` table has the publisher off.
   - Each rejected credential-file shape.
   - The toggle on with no credentials: every lane command succeeds with no
     network call, and `status` names the missing token.
   - An unmapped repository uses `defaultChannel`. With none set it makes no
     call, and `status` says no channel is mapped.
   - Two registered repositories with one name map to their own channels by
     path.
   - `setup` offers an existing channel first, then the catch-all, then a new
     ID.

### WS3: outbox, lock, client, delivery

1. `outbox.mjs`: write an entry file by temporary name and rename; list in
   name order; remove; read and write `delivery-state.json`.
2. `lock.mjs`: exclusive create, touch, the 60-second liveness rule, release.
3. `client.mjs`: the four calls, a 10-second timeout through
   `AbortController`, and the four error classes.
4. `threads.mjs`: thread map and board map.
5. `deliver.mjs`: for each lane in order, post the reply, then render and send
   the card from current state; stop a lane at its first entry that must wait;
   honor `nextTryAt`; stop when the time budget is spent; collapse entries
   older than 24 hours into one reply; send at most one message a second to a
   channel; touch the lock before every call. Every error is caught here.
6. Tests:
   - Order within a lane, and a failing entry on one lane does not hold
     another lane.
   - A 429 with `Retry-After` is not retried early.
   - `channel_not_found` pauses delivery; a later successful test call clears
     the pause.
   - `msg_too_long` drops one entry and the lane's later entries still send.
   - An unknown error is retried five times and then dropped.
   - Entries older than 24 hours collapse to one reply.
   - A crash between Slack's response and the entry's removal produces at most
     one duplicate reply and a correct card.
   - Two live processes: the second skips while the first holds a fresh lock,
     and each entry is delivered once.
   - A flush of more entries than fit in 60 seconds keeps the lock, because of
     the heartbeat.
   - A lock older than 60 seconds is taken over.
   - An entry file that is half-written never appears in a listing.

### WS4: wiring

1. `appendWorkflowEvent`: after the append, one call to `offerWorkflowEvent`.
   It returns at once when the toggle is off, and it catches and logs every
   error.
2. `finishPatchWithReviewerDispatch`: one call to `offerDispatchFailure`
   before the throw.
3. The end of `cli.mjs`: wrap the run as
   `try { await run() } catch { print the error; set the exit code } finally {
   await deliverAfterCommand() }`. Delivery then runs after a command's output
   and after its error message, for commands that return, set
   `process.exitCode`, or throw. `deliverAfterCommand` has the 2-second budget
   and cannot throw.
4. The paused warning of FR-10: when delivery is paused, `deliverAfterCommand`
   prints one line after the command's own output.
5. `flush` and `refresh` commands.
6. `doctorRepo`: paused publisher, toggle on with no token or channel, oldest
   entry over an hour old.
7. `printHandoffState`: the thread line and the one-sentence guidance of
   FR-12. `btrain pr` commands and the startup snapshot do not show it.
8. Tests:
   - A composition test drives claim, review request, request-changes,
     approval, PR link, and merge through the real CLI in a temporary
     repository and asserts the fake's calls.
   - The command's result is printed before the first call, for a command
     that succeeds and for one whose reviewer dispatch fails.
   - A fetch that fails or hangs leaves the command's output and exit code
     unchanged, and the entry stays queued.
   - A paused publisher adds exactly one warning line, and `btrain doctor`
     reports the pause.
   - `btrain handoff` shows the thread line; `btrain pr status` does not.
   - `node scripts/decomposition_inventory.mjs --stages` exits 0 and the
     inventory test passes, with no change to the assignment JSON.
   - The token does not appear in any entry file, log line, or command output.

### WS5: board, mentions, sharing

1. Board: one per developer per channel, rendered from each mapped
   repository's lane state, pinned once, kept for a repository that cannot be
   read.
2. The merge announcement: on `ready-to-merge`, a reply with the mention list
   and the PR link. The link is built from the `origin` remote when it is a
   GitHub remote, plus the PR number. Any other remote gets "PR #N" with no
   link. Lane state and `pr-flow.mjs` are not changed.
3. Mentions for `repair-needed` only when the repair has escalated, and for
   `dispatch-failed` until spec 023 replaces it.
4. Shared channels: repository name on every card and reply; developer label
   on every message; the path-keyed map; the catch-all.
5. Ship `docs/slack-app-manifest.json` and the README section.
6. Tests:
   - Two repositories of one developer share that developer's board and keep
     separate threads.
   - Two developer labels in one channel keep separate threads and boards.
   - A repository whose state cannot be read does not stop the board for the
     others.
   - A first `repair-needed` has no mention; its escalation has one.
   - `ready-to-merge` has the link and a mention; `merged` has neither.
   - A repository-wide search finds no real Slack token, workspace ID, channel
     ID, or user ID outside fixtures with obviously fake values.

### WS6: pilot

Enable the toggle in the btrain repository and run normal lanes for a week.
Report:

- Replies and card updates per lane, and the count of duplicate replies.
- Time from a state change to its post, median and 95th percentile.
- Entries that needed a retry, and entries dropped or collapsed.
- Wall time added to a btrain command after its result was printed.
- Mentions per day, and how many were not worth a mention.

The pilot passes when there are no blocked or failed lane commands traced to
the publisher, no secret or mention produced from agent text, and the operator
judges the channel readable. Enabling it in other repositories is a decision
for the operator after that report.

### WS7: spec 023 kinds

After spec 023 is implemented:

1. Kinds and templates for a review attempt, pickup, an unresponsive reviewer,
   a same-lab fallback, a fix applied, a fix confirmed, and a late review. The
   card shows the display states `in-review` and `confirming-fix`.
2. The mention conditions of spec 024 FR-15 that depend on spec 023:
   - A late request for changes mentions a person only when it is still
     unacknowledged after `[review].other_lab_window`.
   - A silent PR bot mentions a person only when every outside-lab bot is
     silent past its pending window.
   - A reviewer fix waiting for the owner mentions a person when the owner has
     not picked it up within `[review].other_lab_window`.
   - A lane that needs repair while in `fix-confirmation` mentions a person at
     once.
   - No reviewer available at any tier, and a same-lab review that needs
     escalation, mention a person. `dispatch-failed` stops mentioning.
3. A test for each condition, with a fake clock.

## Quality and formal gates

- `npm test` and `npm run test:formal` give the same results as `main` in every
  workstream. The formal harness is not touched.
- **Formal impact: none** for every workstream. No status, transition, guard,
  lock rule, or actor changes. `python3 scripts/tla_pin.py --check` stays at
  1 pin clean. WS4 edits `core.mjs` inside existing functions; that lane runs
  the formal advisory command from the `pre-handoff` skill and records the
  result.
- `node scripts/decomposition_inventory.mjs --stages` exits 0 without a change
  to `specs/020-ws2-module-assignment.json`, and
  `test/decomposition_inventory.test.mjs` passes. Together they are the gate
  for invariant 8 in WS4.
- `btrain review code` passes on each lane. WS1 changes what that gate
  reports; its lane states that in the handoff.
- No test calls Slack. The live check is `btrain slack test`, run by a person.
- Each lane is reviewed by an agent from a different lab when one is available,
  as spec 023 intends, even though spec 023 is not yet enforced.

## Risks and tradeoffs

| Risk | Design response |
| --- | --- |
| The wiring lanes wait on other lanes' locks | WS1 and WS3 need none of those files. WS2 can land its modules first |
| A legacy repository turns the publisher on by accident | The toggle is explicit-only: a missing table or key means off |
| Two processes write the queue at once | One file per entry, created by rename. Nothing appends to a shared file |
| A long flush looks abandoned and a second process double-sends | The holder touches the lock before every call; only a lock untouched for 60 seconds is taken |
| A crash between Slack's reply and the entry's removal | Replies are at-least-once in that window; the card and board are rewritten whole |
| One bad entry blocks a lane's later posts | Entry errors drop the entry; unknown errors drop it after 5 attempts |
| A line added to a pinned core function fails the inventory test | The plan touches only `appendWorkflowEvent`, `finishPatchWithReviewerDispatch`, and `doctorRepo` |
| Exporting the secret patterns changes the review gate | Treated as an intended improvement, tested, and called out in WS1's handoff |
| The same file checks exist twice | Accepted for now; one shared helper is a follow-up that touches `system-one.mjs` |
| Delivery adds time to every command | It runs after the output, is bounded at 2 seconds, and returns at once when the toggle is off or nothing is pending |
| A second process is needed for prompt delivery | Out of scope here. Delivery is on the next btrain command until the listener of spec 025 exists |
| Lane text reaches a Slack channel | Scrubbed before it is queued, cut, escaped, defanged; diffs and file contents never posted |

## Follow-ups

- One shared private-file helper for `system-one.mjs` and `slack/credentials.mjs`.
- The listener of spec 025 drains the outbox continuously.
- Per-lane and per-day digests if the pilot shows too many posts.

## Context receipt

**Tier:** deep was attempted. `.claude/scripts/unblocked-context.sh research`
returned `{"sources": [], "_skipped": "unblocked returned empty output"}`, so
no organizational context was available.
**Questions:** Where does a publisher attach without growing `core.mjs`? Which
files are held by other lanes? What does Slack require for an updatable card?
**Primary sources:** [Spec 024](024-slack-lane-publisher.md),
[Spec 020](020-token-spend-and-decomposition.md) and its module assignment,
[Spec 022](022-local-only-init.md), current `core.mjs`, `cli.mjs`,
`repo_mode.mjs`, `system-one.mjs`, and `review/code-rules.mjs`, `btrain locks`
on 2026-11-23, and Slack's API documentation for the four calls.
**Reviews that shaped this plan:** a same-lab lane review (three corrections)
and a cross-lab review by Grok 4.7 through the Cursor CLI (twelve findings).
**Constraints:** zero runtime dependencies, no usage-billed service, no new
function in `core.mjs`, and no change to lane authority.
**Gaps:** no organizational history; the pilot's measures have no baseline;
nothing here has been run against Slack beyond the live check named above.
**Durable writeback:** this plan and the spec 024 amendments in the same lane.
