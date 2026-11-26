# 024 — Slack lane publisher tasks

Tasks for the [implementation plan](024-slack-lane-publisher-implementation-plan.md).
Each numbered workstream (WS) in the plan is one lane and one PR. A task is
done when its code and its tests are merged. The publisher stays off in every
repository until T029, so each PR before that is inert.

Before claiming a workstream, run `btrain locks` from a session that is not
lane-scoped. The files other lanes held on 2026-11-23 are named on the tasks
that need them.

**Status 2026-11-24:** WS0 (T001, T002) merged in PR #117 and WS1 (T003 to
T006) in PR #120; invariant 5 runs unskipped. WS3 (T011 to T015) and the two
WS2 modules that need no held file (T008, T009) are in lane f. T007
(`repo_mode.mjs`, lane a) and T010 (`cli.mjs`, lane h) wait for those lanes,
and so does all of WS4. WS1 added one file outside `slack/` and
`review/code-rules.mjs`: `review/secret-patterns.mjs`, which holds the secret
list with no imports, because `code-rules.mjs` imports `core.mjs` and `slack/`
must not reach it. `config.mjs` decides the toggle for `slack/` itself; T007
puts the same explicit-only rule into `repo_mode.mjs`.

**Status 2026-11-25:** WS3 merged in PR #126. Two WS5 tasks run ahead of
WS4, because neither needs a file lane a holds. T027 is done:
`test/slack-no-real-ids.test.mjs` scans every tracked file, and a finding
masks its value. T023 is partly done: `slack/remote.mjs` takes the text of
`git config --get-regexp` and returns the PR link, in the order
`resolveBaseRemote` uses and in the shape `render.mjs` accepts. Passing that
link to the `ready-to-merge` reply belongs to WS4's `index.mjs`, which waits
for lane a.

T024 and T025 are done, and T022 is done except its report. `deliver()`
now ends each run with the developer's board in the channel
(`slack/board.mjs`): it posts the board once some lane is active, pins it
once, updates it in place, and keeps a repository's last lines marked "not
refreshed" when its state cannot be read. A failed pin is recorded and
blocks nothing; `boardStatus` returns it for `btrain slack status`, which
T010 writes in `slack/cli.mjs` and which waits for lane a. Every reply now
starts with the repository name and the developer label. A first
`repair-needed` has no mention; its escalation has one.

## Phase 1: Harness and pure parts (WS0, WS1)

- [x] T001 [WS0] Write the fake Slack `fetch` in `test/helpers/fake-slack.mjs` and its preload in `test/helpers/fake-slack-preload.mjs`. It records every call, returns a `ts` for a post, and on demand returns any Slack error, an HTTP 429 with `Retry-After`, a network error, or never resolves. Scripted responses are keyed by Slack method name. Test it in `test/slack-fake-harness.test.mjs`.
- [x] T002 [WS0] Add the eight invariant tests of the plan to `test/slack-invariants.test.mjs`, each skipped and naming the workstream that enables it. Every test that creates a repository sets `BRAIN_TRAIN_HOME` to a temporary directory. `npm test` gives the same result as `main`.
- [x] T003 [WS1] Write the text pipeline in `src/brain_train/slack/text.mjs` as one exported function: scrub, cut, escape `&`, `<`, `>`, rewrite `://` to `[:]//`. Export each step on its own as well, returning the text and whether it changed. Add the 3,999-character cap for a finished message. Test in `test/slack-text.test.mjs`: `<!channel>`, `<@U123>`, `&`, a bare URL, a webhook URL, a `github_pat_` token, a secret that crosses the cut point, and a message built from maximum-length fields.
- [x] T004 [WS1] Export `SECRET_PATTERNS` from `src/brain_train/review/code-rules.mjs` and add a Slack webhook URL pattern and a GitHub fine-grained token pattern. Add a case for each to `test/review-code-rules.test.mjs`. State in the handoff that `btrain review code` now reports both.
- [x] T005 [WS1] Write the kind table as data and the classifier in `src/brain_train/slack/events.mjs`: a workflow event to `{kind, reply, mention, fields}`, first matching row wins. Test every row of the plan's kind table from a real event shape, a metadata-only update (card refresh, no reply), and a status change no named row covers (`status-changed`) in `test/slack-events.test.mjs`.
- [x] T006 [WS1] Write the card, one template for each kind, and the board grouped by repository in `src/brain_train/slack/render.mjs`. Templates are data. Test in `test/slack-render.test.mjs` that no template uses a field that skipped the text pipeline. Remove the skip from invariant 5.

**Independent check:** every kind and every text rule has a test, and agent-written text cannot produce a mention or a link. No file outside `slack/`, `review/code-rules.mjs`, and `test/` changes.

## Phase 2: Configuration and delivery (WS2, WS3)

WS2 and WS3 do not depend on each other. WS3 tests inject the channel and the
token.

- [ ] T007 [WS2] Add `slack` to `FEATURES` in `src/brain_train/repo_mode.mjs` with `localDefault: false` and `explicitOnly: true`. Honor the flag in `isFeatureEnabled`, `getAllOnFeatureMap`, `getEffectiveFeatureMap`, and `getNewRepoFeatureBase`. Change the `btrain features` line that says every feature is on. Exempt explicit-only ids in the `test/local-init.test.mjs` case that asserts the legacy rule. Test that a repository with no `[features]` table has the publisher off, and that `btrain features disable formal` there writes no `slack = true`. Held on 2026-11-23: `repo_mode.mjs` (lane a), `cli.mjs` (lane c).
- [x] T008 [WS2] Write `src/brain_train/slack/credentials.mjs`: the environment variable first, else `~/.btrain/slack.json` with the no-follow, size, owner, and mode checks, and the two failure reasons the spec names. Windows skips the owner and mode checks. Test each rejected file shape in `test/slack-credentials.test.mjs`.
- [x] T009 [WS2] Write `src/brain_train/slack/config.mjs`: `[slack]` options with defaults, the channel for a repository by registered path, else `defaultChannel`, else none, and the mention list. Test two registered repositories with one name, an unmapped repository with and without `defaultChannel`, in `test/slack-config.test.mjs`.
- [ ] T010 [WS2] Write `setup`, `status`, `channels`, and `test` in `src/brain_train/slack/cli.mjs`, and add the `slack` command block to `src/brain_train/cli.mjs`, which hands `slack/cli.mjs` one object of reader functions. `setup` reads the token from standard input, writes the file with mode 0600, and for an unmapped repository offers an existing project channel, then the catch-all, then a new channel ID. No command prints the token. Test the toggle on with no credentials: every lane command succeeds with no network call and `status` names the missing token. Remove the skip from invariant 1.
- [x] T011 [WS3] Write `src/brain_train/slack/outbox.mjs`: write an entry under a temporary name and rename it to `<stamp>-<id>.json`, list in name order, remove, and read and write `delivery-state.json`. Test that a name holds no colon and that a half-written entry never appears in a listing, in `test/slack-outbox.test.mjs`.
- [x] T012 [WS3] Write `src/brain_train/slack/lock.mjs`, with the lock's path as an argument: exclusive create with a nonce, touch, the 60-second liveness rule, the nonce check before a send, release. Test a fresh lock (the second process skips), a lock older than 60 seconds (taken over), a failed removal (skip), and two processes that both judge a lock stale, in `test/slack-lock.test.mjs`.
- [x] T013 [WS3] Write `src/brain_train/slack/client.mjs`: `auth.test`, `chat.postMessage`, `chat.update`, and `pins.add` over an injected `fetch`, a 10-second timeout through `AbortController`, and the four error classes. Export the low-level call, which can send a GET with query parameters as well as a JSON POST. Test that every post sends `unfurl_links` and `unfurl_media` as false and never `link_names`, in `test/slack-client.test.mjs`.
- [x] T014 [WS3] Write `src/brain_train/slack/threads.mjs`: the thread map in the state root and the board map in the global home, each written to a temporary file and renamed.
- [x] T015 [WS3] Write the drain in `src/brain_train/slack/deliver.mjs`, with the time budget and the repository given by the caller: reply then card for each lane in order, stop a lane at its first entry that must wait, honor `nextTryAt`, stop at the time budget and abort the call in flight, collapse entries older than 24 hours, one message a second to a channel, touch the lock before every call, catch every error. Test each case the plan lists for WS3 in `test/slack-deliver.test.mjs`: order, a 429 not retried early, `channel_not_found` pausing and a test call clearing it, `msg_too_long` dropping one entry, an unknown error dropped after five attempts, the 24-hour collapse, a crash between Slack's response and the entry's removal, the 2-second budget with a call that never returns, and a flush longer than 60 seconds keeping the lock.

**Independent check:** a developer can run `btrain slack setup` and `btrain slack test` against a real workspace, and hand-written entries drain to the fake in order with retry times, pause, and drop. No lane command behaves differently yet.

## Phase 3: Wiring (WS4)

Held on 2026-11-23: `core.mjs` (lane h), `cli.mjs` (lane c).

- [ ] T016 [WS4] Write `offerWorkflowEvent`, `offerDispatchFailure`, and `deliverAfterCommand` in `src/brain_train/slack/index.mjs`. Add one call to `offerWorkflowEvent` after the append in `appendWorkflowEvent`, and one call to `offerDispatchFailure` before the throw in `finishPatchWithReviewerDispatch`, in `src/brain_train/core.mjs`. Both return at once when the toggle is off and catch every error. `slack/` imports nothing from `core.mjs`.
- [ ] T017 [WS4] Replace the last statement of `src/brain_train/cli.mjs` with `try { await run() } catch { print the error; set the exit code } finally { await deliverAfterCommand() }`. `cli.mjs` passes the lane-state reader in. `deliverAfterCommand` has the 2-second budget, cannot throw, and prints one warning line after the command's own output when delivery is paused.
- [ ] T018 [WS4] Add `btrain slack flush` (no time budget, prints counts) and `btrain slack refresh` (re-renders the board and every active card) to `src/brain_train/slack/cli.mjs`.
- [ ] T019 [WS4] Write `src/brain_train/slack/doctor.mjs` and append its findings in `doctorRepo`: a paused publisher, the toggle on with no token, the toggle on with no channel, and an oldest entry over an hour old.
- [ ] T020 [WS4] Print the thread line and the one-sentence guidance of FR-12 in `printHandoffState` in `src/brain_train/cli.mjs`. `btrain pr` commands and the startup snapshot do not show it.
- [ ] T021 [WS4] Add the composition test `test/slack-composition.test.mjs`: claim, review request, request-changes, approval, PR link, and merge through the real CLI in a temporary repository, asserting the fake's calls. Add the WS4 tests the plan lists: the result printed before the first call, a failing or hanging fetch leaving output and exit code unchanged, exactly one paused warning line, each doctor finding, the thread line in `btrain handoff` and not in `btrain pr status`, and no token in any entry file, log line, or command output. Confirm `node scripts/decomposition_inventory.mjs --stages` exits 0 and `test/decomposition_inventory.test.mjs` passes with no change to `specs/020-ws2-module-assignment.json`. Remove the skips from invariants 2, 3, 4, 6, 7, and 8.

**Independent check:** with the toggle on in a temporary repository, a lane's life produces the expected card and replies in the fake. With it off, no file appears under `.btrain/slack/` and `fetch` is never called. `patchHandoff` and `runLoop` keep their line counts.

## Phase 4: Board, mentions, sharing (WS5)

Held on 2026-11-23: `README.md` (lane h).

- [ ] T022 [WS5] Render one board for each developer in each channel from every mapped repository's lane state, pin it once, and keep a repository's last lines when its state cannot be read. Test that a failed `pins.add` is reported by `btrain slack status` and blocks nothing.
- [ ] T023 [WS5] Write `src/brain_train/slack/remote.mjs`: parse `https://`, `ssh://`, and `git@host:owner/repo.git`, pick the remote in the order `resolveBaseRemote` uses (the one `gh repo set-default` marked, else `upstream`, `github`, `origin`, else the first), and build a link only for a `github.com` host. Use it for the `ready-to-merge` reply, which carries the mention list and the PR link. Test the marked remote and `upstream` preferred over `origin`, an SSH remote, and a host that is not `github.com`, in `test/slack-remote.test.mjs`.
- [x] T024 [WS5] Mention a person for `repair-needed` only when the repair has escalated, and for `dispatch-failed` until WS7. Test that a first `repair-needed` has no mention, its escalation has one, and `merged` has neither a link nor a mention.
- [x] T025 [WS5] Shared channels: the repository name on every card and reply, the developer label on every message, the path-keyed channel map, and the catch-all. Test two repositories of one developer sharing a board with separate threads, and two developer labels in one channel with separate threads and boards.
- [ ] T026 [WS5] Ship `docs/slack-app-manifest.json` and the README section: scopes, setup, the commands, and what is never posted.
- [x] T027 [WS5] Add a test that searches the repository and finds no real Slack token, workspace ID, channel ID, or user ID outside fixtures with obviously fake values.

**Independent check:** two repositories and two developer labels share one fake channel correctly, and another developer can set the publisher up from the README alone.

## Phase 5: Pilot (WS6)

- [ ] T028 [WS6] Turn the toggle on in the btrain repository only, and run normal lanes for one week.
- [ ] T029 [WS6] Report the plan's measures: replies and card updates for each lane, duplicate replies, time from a state change to its post (median and 95th percentile), entries retried, dropped, or collapsed, wall time added to a command after its result, and mentions each day with how many were not worth one. The pilot passes with no blocked or failed lane command traced to the publisher, no secret or mention produced from agent text, and the operator judging the channel readable. Enabling other repositories is the operator's decision after this report.

## Phase 6: Spec 023 kinds (WS7)

Starts after spec 023's request loop and fix path have merged.

- [ ] T030 [WS7] Add kinds and templates for a review attempt, a pickup, an unresponsive reviewer, a same-lab fallback, a fix applied, a fix confirmed, and a late review, in `slack/events.mjs` and `slack/render.mjs`. The card shows the display states `in-review` and `confirming-fix`.
- [ ] T031 [WS7] Implement the spec 023 mention conditions of FR-15, each with a fake-clock test: a late request for changes still unacknowledged after `[review].other_lab_window`; every outside-lab bot silent past its pending window; a reviewer fix the owner has not picked up within the window; a lane that needs repair while in `fix-confirmation`; a reviewer silent on a lane with a linked PR when the window ends; no reviewer at any tier; a same-lab review that needs escalation. `dispatch-failed` stops mentioning.

## Dependencies

T001 and T002 come first. T003 to T006 need T001. T007 to T010 need T001. T011 to T015 need T001 and T003 to T006. T016 to T021 need all of Phase 1 and Phase 2. T022 to T027 need Phase 3. T028 needs Phase 4. T030 and T031 need Phase 3 and the spec 023 tasks T020 to T039.

T007 and T010 wait for the lanes that hold `repo_mode.mjs` and `cli.mjs`. T008 and T009 can merge before them. T016 to T021 wait for the lanes that hold `core.mjs` and `cli.mjs`.
