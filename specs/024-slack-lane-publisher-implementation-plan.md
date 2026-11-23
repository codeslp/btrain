# 024 — Slack Lane Publisher Implementation Plan

**Status:** Draft
**Spec:** [024 — Slack Lane Publisher](024-slack-lane-publisher.md)
**Date:** 2026-11-23

## Plan decision

Build the publisher as a new module tree, `src/brain_train/slack/`, and wire it
into btrain at three small seams. Write the pure parts first (text handling,
event classification, rendering), then the outbox and the Slack client, then
the wiring. Each workstream is one lane and one PR. The feature stays off until
the pilot in WS6, and every PR before that is inert in a repository that has
not enabled it.

Three constraints shape the order:

- **No new function in `core.mjs`.** `scripts/decomposition_inventory.mjs` and
  `specs/020-ws2-module-assignment.json` account for every function in that
  file, and the JSON is locked by another lane. Core changes are limited to an
  import and call sites inside existing functions.
- **Other lanes hold the files the wiring needs.** On 2026-11-23, `core.mjs`
  and `README.md` are locked by lane h, `cli.mjs` by lane c, and
  `repo_mode.mjs` by lane a. WS1 and WS3 touch none of them and can start at
  once. WS2, WS4 and WS5 wait for those locks.
- **Zero runtime dependencies and no usage-billed service.** HTTP uses the
  built-in `fetch`, as `system-one.mjs` does. IDs use `node:crypto`.

The repo has numbered flat specs and no `.specify/` script or template
directory. This plan uses that established format and records the design, data
model, contracts, and quality gates here.

## Current integration points

| Surface | Existing state | Planned change |
| --- | --- | --- |
| `appendWorkflowEvent` in `core.mjs` | Appends one JSONL line to the lane's event log. Eight callers | After the append, one call to `offerWorkflowEvent` from the new module. No new core function |
| `finishPatchWithReviewerDispatch` in `core.mjs` | Throws a `BtrainError` when reviewer dispatch fails or times out. No event is written | Offer a `dispatch-failed` item before the throw |
| `checkHandoff` in `core.mjs` | Prints lane guidance for `btrain handoff` | One extra line with the lane's Slack thread when the toggle is on (FR-12) |
| `doctorRepo` in `core.mjs` | Collects issues and warnings per repository | Append the publisher's findings from `slack/doctor.mjs` |
| Command routing in `cli.mjs` | One `if (command === "...")` block per command | A `slack` block that delegates to `slack/cli.mjs`, and one delivery call after a command's result is written |
| `FEATURES` in `repo_mode.mjs` | Thirteen toggles; `agentchattr` and `handoff_history` have `localDefault: false` | Add `slack` with `localDefault: false` |
| `SECRET_PATTERNS` in `review/code-rules.mjs` | Module-private list of seven patterns | Export it, and add Slack webhook URL and `github_pat_` patterns |
| `loadSystemOneRuntimeConfig` in `system-one.mjs` | Reads `~/.btrain/jev.json` with no-follow, size, owner and mode checks | Unchanged. The same checks are written once in `slack/credentials.mjs`; sharing one helper is a follow-up |
| `withFileLock` in `core.mjs` | Waits up to 5 seconds, then throws; steals a lock older than 30 seconds | Not used. The outbox has its own try-once lock |
| Lane state | Holds `prNumber`, not a PR URL | Store the URL when PR flow learns it, so the merge announcement can link it |
| `~/.btrain` via `getBrainTrainHome` | Registry, templates, `jev.json`, `dashboard.json` | Add `slack.json` and `slack/boards.json` |
| `<state root>/.btrain/` | Locks, events, overrides, PR comments. Ignored by git except `project.toml` | Add `slack/` for the outbox and the thread map |

## Architecture and invariants

### Modules

| Module | Responsibility | Pure |
| --- | --- | --- |
| `slack/text.mjs` | Escape, defang URLs, cut to length, scrub secrets | Yes |
| `slack/events.mjs` | Turn a workflow event into a kind, a reply decision, and a mention decision | Yes |
| `slack/render.mjs` | Card, reply line, and board text from lane state | Yes |
| `slack/config.mjs` | Toggle, `[slack]` options, channel for a repository, mention list | No |
| `slack/credentials.mjs` | Token from the environment or the private file, with the file checks | No |
| `slack/outbox.mjs` | Append an entry, rotate, read pending, record progress, try-once lock | No |
| `slack/client.mjs` | `chat.postMessage`, `chat.update`, `pins.add`, `auth.test` over an injected `fetch`; error classes | No |
| `slack/threads.mjs` | Thread map in the state root; board map in the global home | No |
| `slack/deliver.mjs` | Drain: order, budget, card from current state, board | No |
| `slack/doctor.mjs` | Findings for `btrain doctor` | No |
| `slack/cli.mjs` | `setup`, `test`, `status`, `flush`, `refresh`, `channels` | No |
| `slack/index.mjs` | `offerWorkflowEvent`, `offerDispatchFailure`, `deliverAfterCommand` | No |

### Invariants

Each one is a test in WS0 and stays in the suite.

1. With the toggle off, no file is created under `.btrain/slack/` and `fetch`
   is never called.
2. A command's state change, its event, and its printed result are complete
   before any Slack call.
3. No Slack outcome throws into a lane command or changes its exit code.
4. The outbox, the thread map, logs, and command output never contain the token
   or a string that matches a secret pattern.
5. Agent-written text cannot produce a mention or a link.
6. A card and a board are functions of current lane state. Sending one twice
   leaves Slack unchanged.
7. A process that finds the delivery lock held skips delivery and returns.
8. `core.mjs` gains no function.

### Data model

**Outbox entry**, one JSON line in `<state root>/.btrain/slack/outbox.jsonl`:

```json
{"id": "<uuid>", "queuedAt": "<ISO>", "laneId": "e", "claimKey": "<claim time>",
 "kind": "sent-to-review", "reply": true, "mention": false,
 "fields": {"actor": "claude", "reviewer": "codex-reviewer", "summary": "..."}}
```

`fields` holds only what a template needs, already scrubbed. The full workflow
event is not copied into the outbox.

**Rotation.** Appenders only ever append to `outbox.jsonl`. The process that
holds the delivery lock renames it to `outbox.<time>.jsonl` and works through
the rotated segments in order. A segment is deleted when its last entry is
done. Progress inside a segment lives in `delivery-state.json`, written to a
temporary file and renamed. No process rewrites a file that another may be
appending to.

**`delivery-state.json`**: per segment, the index of the last entry that is
done; per entry still pending, `attempts`, `nextTryAt`, and `lastError`; and a
`paused` object with the reason when a configuration error stops delivery.

**`threads.json`**, in the state root: `"<laneId>@<claimKey>"` to
`{channel, cardTs}`.

**`boards.json`**, in `~/.btrain/slack/`: channel to `{ts, pinned, repos}`,
where `repos` maps a registered path to its last rendered lines and the time
they were read.

**`slack.json`**, in `~/.btrain/`: as the spec's Configuration section gives
it. `channels` is keyed by registered repository path.

### Event kinds

`slack/events.mjs` maps a workflow event's `type` and its `before` and `after`
snapshots to one kind. Anything not listed refreshes the card and posts no
reply.

| Kind | Trigger | Reply | Mention |
| --- | --- | --- | --- |
| `claimed` | `claim` event | Yes | No |
| `sent-to-review` | status becomes `needs-review` | Yes | No |
| `changes-requested` | `request-changes` event, or PR feedback | Yes | No |
| `approved` | status becomes `ready-for-pr`, or `resolved` from `needs-review` | Yes | No |
| `pr-linked` | `prNumber` goes from empty to set | Yes | No |
| `ready-to-merge` | status becomes `ready-to-merge` | Yes | Yes, with the PR link |
| `merged` | status becomes `resolved` from a PR-flow status | Yes | No |
| `roles-changed` | owner or reviewer changes | Yes | No |
| `locks-changed` | lock coverage changes | Yes | No |
| `repair-needed` | status becomes `repair-needed` | Yes | Only when `repairEscalation` is `human` |
| `override` | `override-granted` or `override-consumed` | Yes | No |
| `watchdog` | `watchdog-repair` | Yes | No |
| `dispatch-failed` | offered by `finishPatchWithReviewerDispatch` | Yes | Yes, until spec 023 lands |

Spec 023's kinds (attempt, pickup, unresponsive, fallback, fix applied, fix
confirmed, late review) are WS7.

### Slack contract

| Call | When | Arguments that matter | On success |
| --- | --- | --- | --- |
| `auth.test` | `btrain slack test`, `btrain slack status` | Token | Report workspace and bot user |
| `chat.postMessage` | New card, reply, new board | `channel`, `text`, `thread_ts` for a reply, `unfurl_links: false`, `unfurl_media: false`. Never `link_names` | Store the returned `ts` for a card or board |
| `chat.update` | Card or board refresh | `channel`, `ts`, `text` | Nothing to store |
| `pins.add` | Once, after a new board | `channel`, `timestamp` | Mark the board pinned |

Error classes, from the spec's FR-10: `ratelimited`, HTTP 429,
`internal_error`, `service_unavailable`, `fatal_error`, `request_timeout`, and
network errors are transient and set `nextTryAt`. `invalid_auth`,
`token_revoked`, `token_expired`, `account_inactive`, `missing_scope`,
`not_allowed_token_type`, `channel_not_found`, `not_in_channel`,
`no_permission`, and `is_archived` pause delivery for the repository. An
unknown error is treated as transient and logged with its name.

A live check on 2026-11-23 with the real app confirmed that a post and an
in-place update succeed with `chat:write`.

### CLI contract

| Command | Output | Exit code |
| --- | --- | --- |
| `btrain slack setup [--channel <id>] [--operator <id>]` | Reads the token from standard input, writes `~/.btrain/slack.json` with mode 0600, lists existing channels for an unmapped repository | 0, or 1 on an invalid token or a failed file check |
| `btrain slack test` | Calls `auth.test`, posts one message, clears a pause | 0 on success, 1 otherwise |
| `btrain slack status` | Toggle, credential source, channel, queue depth, oldest entry age, pause reason, last error, board pinned or not | 0 always |
| `btrain slack flush` | Drains the queue with no time budget; prints counts | 0 always |
| `btrain slack refresh` | Re-renders the board and every active card | 0 always |
| `btrain slack channels` | The path-to-channel map and the catch-all | 0 always |

No command prints the token.

## Workstreams and order

| WS | First artifact | Files other lanes hold | Depends on | Done when |
| --- | --- | --- | --- | --- |
| 0 Harness and invariants | A fake Slack `fetch` and the eight invariant tests, failing or skipped | None | — | The harness records calls, can fail, hang, and rate-limit on demand |
| 1 Text, events, rendering | `slack/text.mjs`, `events.mjs`, `render.mjs`; exported secret patterns | None | WS0 | Every template and every text rule has a test; invariant 5 passes |
| 2 Config, credentials, setup | `slack/config.mjs`, `credentials.mjs`; the `slack` toggle; `setup`, `status`, `channels`, `test` | `repo_mode.mjs` (lane a), `cli.mjs` (lane c) | WS0 | A developer can set up and run `btrain slack test` against a real workspace |
| 3 Outbox, client, delivery | `slack/outbox.mjs`, `client.mjs`, `threads.mjs`, `deliver.mjs` | None | WS0, WS1 | A hand-written outbox drains to the fake in order, with rotation, retry times, and pause |
| 4 Wiring | `offerWorkflowEvent` call, delivery after a command, `flush`, `refresh`, doctor findings, the handoff thread line | `core.mjs` (lane h), `cli.mjs` (lane c) | WS1, WS2, WS3 | A lane's life in a temp repository produces the expected card and replies in the fake; invariants 1, 2, 3, 7 and 8 pass |
| 5 Board, mentions, sharing | Board with pin, merge announcement with PR URL, escalation mentions, shared channels, catch-all, app manifest, README | `core.mjs` and `README.md` (lane h) | WS4 | Two repositories and two developer labels share one fake channel correctly |
| 6 Pilot | Toggle on in the btrain repository only | None | WS5 | One week of real lanes, with the measures below reported |
| 7 Spec 023 kinds | Attempt, pickup, fallback and fix kinds; display states | Depends on spec 023's lanes | Spec 023 | Each new kind has a template and a test |

WS1 and WS3 can start today. WS2 can be split so that the modules land first
and the `repo_mode.mjs` and `cli.mjs` edits follow when their lanes resolve.

### WS0: harness and invariants

1. `test/helpers/fake-slack.mjs`: a `fetch` replacement that records every
   call, returns a `ts` for posts, and can be told to return any Slack error,
   an HTTP 429 with `Retry-After`, a network error, or to never resolve.
2. One test file per invariant, written against the planned module interfaces.
   They fail or are skipped until their workstream lands.
3. Every test that creates a repository sets `BRAIN_TRAIN_HOME` to a temporary
   directory, so no test registers a repository in the developer's real
   registry or reads the real `slack.json`.

### WS1: text, events, rendering

1. `text.mjs`: HTML-escape `&`, `<`, `>`; rewrite `://` to `[:]//`; cut to a
   length on a character boundary; replace every secret match with
   `[redacted]`. One exported function applies all four in that order.
2. Export `SECRET_PATTERNS` from `review/code-rules.mjs` and add two patterns:
   a Slack webhook URL and a GitHub fine-grained token. `btrain review code`
   then reports those two as hardcoded secrets as well. Add cases to
   `test/review-code-rules.test.mjs` for both.
3. `events.mjs`: the kind table above as data, and one function from a
   workflow event to `{kind, reply, mention, fields}`.
4. `render.mjs`: the card with the spec's field order, one template per kind,
   and the board grouped by repository. Templates are data, so a test can
   assert that no template interpolates an unscrubbed field.
5. Tests: each kind from a real event shape taken from the event log format;
   the adversarial text cases in the spec's Tests section.

### WS2: config, credentials, setup

1. Add `slack` to `FEATURES` with `localDefault: false`.
2. `credentials.mjs`: environment variable first, else the private file with
   the no-follow, size, owner, and mode checks, and the same two failure
   reasons the spec names. Windows skips the owner and mode checks.
3. `config.mjs`: `[slack]` options with defaults; channel for a repository by
   registered path, else `defaultChannel`, else none.
4. `slack/cli.mjs`: `setup` (token from standard input only), `status`,
   `channels`, `test`.
5. Tests: each rejected file shape; a repository with the toggle on and no
   credentials runs every lane command with no network call.

### WS3: outbox, client, delivery

1. `outbox.mjs`: append; rotate under the lock; read segments; record progress
   with a temporary file and a rename; try-once lock with a 25-second holder
   limit.
2. `client.mjs`: the four calls, a per-call timeout through `AbortController`,
   and the error classes.
3. `threads.mjs`: thread map and board map.
4. `deliver.mjs`: for each lane in order, post the reply, then render and send
   the card from current state; stop a lane at its first failing entry; honor
   `nextTryAt`; stop when the time budget is spent; collapse entries older
   than 24 hours into one reply; send at most one message a second to a
   channel.
5. Tests: order within a lane and independence across lanes; a crash between
   Slack's response and the progress write produces at most one duplicate
   reply and a correct card; two processes deliver each entry once; a held
   lock is skipped.

### WS4: wiring

1. `appendWorkflowEvent`: after the append, call `offerWorkflowEvent`. It
   returns at once when the toggle is off. It catches and logs every error.
2. `finishPatchWithReviewerDispatch`: call `offerDispatchFailure` before the
   throw.
3. `cli.mjs`: after a command's handler has returned and its output is
   written, call `deliverAfterCommand` with the 2-second budget. A command that
   failed still gets the call, because it may have queued entries.
4. `flush` and `refresh` commands.
5. `doctorRepo`: paused publisher, toggle on with no token or channel, oldest
   entry over an hour old.
6. `checkHandoff`: the thread line and the one-sentence guidance of FR-12.
7. Tests: a composition test drives claim, review request, request-changes,
   approval, PR link, and merge through the real CLI in a temporary repository
   and asserts the fake's calls; the timing test asserts the result is printed
   before the first call.

### WS5: board, mentions, sharing

1. Board: one per developer per channel, rendered from each mapped
   repository's lane state, pinned once, kept for a repository that cannot be
   read.
2. Store the PR URL in lane state when `pr create` or `pr poll` learns it.
   Announce `ready-to-merge` with the link and the mention list.
3. Mentions for `repair-needed` only when the repair has escalated, and for
   `dispatch-failed` until spec 023 replaces it.
4. Shared channels: repository name on every card and reply; developer label
   on every message; path-keyed map; the catch-all.
5. Ship `docs/slack-app-manifest.json` and the README section.
6. Tests: the spec's multi-repository and multi-developer cases.

### WS6: pilot

Enable the toggle in the btrain repository and run normal lanes for a week.
Report:

- Replies and card updates per lane, and the count of duplicate replies.
- Time from a state change to its post, median and 95th percentile.
- Entries that needed a retry, and entries dropped for age.
- Wall time added to a btrain command after its result was printed.
- Mentions per day, and how many were not worth a mention.

The pilot passes when there are no blocked or failed lane commands traced to
the publisher, no secret or mention produced from agent text, and the operator
judges the channel readable. Enabling it in other repositories is a decision
for the operator after that report.

## Quality and formal gates

- `npm test` and `npm run test:formal` give the same results as `main` in every
  workstream. The formal harness is not touched.
- **Formal impact: none** for every workstream. No status, transition, guard,
  lock rule, or actor changes. `python3 scripts/tla_pin.py --check` stays at
  1 pin clean. WS4 and WS5 edit `core.mjs` inside existing functions; each of
  those lanes runs the formal advisory command from the `pre-handoff` skill
  and records the result.
- `test/decomposition_inventory.test.mjs` passes without a change to
  `specs/020-ws2-module-assignment.json`.
- `btrain review code` passes on each lane. WS1 changes what that gate
  reports; its lane states that in the handoff.
- No test calls Slack. The live check is `btrain slack test`, run by a person.
- Each lane is reviewed by an agent from a different lab when one is available,
  as spec 023 intends, even though spec 023 is not yet enforced.

## Risks and tradeoffs

| Risk | Design response |
| --- | --- |
| The wiring lanes wait on other lanes' locks | WS1 and WS3 need none of those files. WS2 can land its modules first |
| A queue file is rewritten while another process appends | Appenders only append; the lock holder rotates by rename |
| A crash between Slack's reply and the progress write | Replies are at-least-once; the card and board are rewritten whole |
| Exporting the secret patterns changes the review gate | Treated as an intended improvement, tested, and called out in WS1's handoff |
| The same file checks exist twice | Accepted for now; one shared helper is a follow-up that touches `system-one.mjs` |
| `cli.mjs` delivery adds time to every command | It runs after the result, is bounded at 2 seconds, and is skipped when the toggle is off or the queue is empty |
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
**Constraints:** zero runtime dependencies, no usage-billed service, no new
function in `core.mjs`, and no change to lane authority.
**Gaps:** no organizational history; the pilot's measures have no baseline;
nothing here has been run against Slack beyond the live check named above.
**Durable writeback:** this plan.
