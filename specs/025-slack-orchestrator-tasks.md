# 025 — Slack orchestrator tasks

Tasks for the [implementation plan](025-slack-orchestrator-implementation-plan.md).
Each numbered workstream (WS) in the plan is one lane and one PR. A task is
done when its code and its tests are merged. Nothing listens until a developer
turns `slack_listen` on in a repository and starts `btrain slack listen`.

This work builds on the Slack publisher. "024 T0nn" names a task in the
[spec 024 task list](024-slack-lane-publisher-tasks.md). Before claiming a
workstream, run `btrain locks` from a session that is not lane-scoped.

**Status 2026-11-24:** lane i holds WS0 and the WS1 modules that need no live
capture and no held file: T001, T005, T007, T009, T010, and T013 are done, and
invariants 2, 5, and 6 run at the unit level. T006 (`inbound.mjs`) and T008
(`grammar.mjs`) are written and tested against synthetic messages built from
the plan's field rules; their tests on the captured bodies of T003 are
skipped until a person makes those captures, so both stay open. T002 waits
for T004, the real profile probe: its stream shape would be a guess. T003 and
T004 are for a person with the real app and the real CLI.

**Status 2026-11-25:** T016 is done ahead of the order below. The read client
uses only the low-level call of 024 T013 and the fake read calls of T001, so
it does not wait for T006 to T015. Reads the budget defers keep their cursor
and resume, so a long history or thread finishes across minutes instead of
restarting. T014 is done too: `slack/lease.mjs` needs only 024 T012. The lease
file is a JSON record that names its holder (process ID, operator, start
time), so `lock.mjs` now takes an optional `nonce`, which is the lock file's
whole content.

T012 is done: `slack/config.mjs` reads the `slack_listen` toggle by the same
explicit-only rule as `slack`, the listener's settings in `slack.json`, and
`[slack.orchestrator]`, each with the spec's defaults, and computes the
served repositories from the registered ones its caller reads. Adding
`slack_listen` to `FEATURES` in `repo_mode.mjs` stays T011, with lane a.

## Phase 1: Harness and pure parts (WS0, WS1)

- [x] T001 [WS0] Extend `test/helpers/fake-slack.mjs` with `conversations.history` and `conversations.replies`: scripted messages for each channel and thread, paging with `has_more` and `next_cursor`, newest first for history and earliest first for replies, every failure the fake already supports, and a rejection of a JSON body on `conversations.replies`.
- [ ] T002 [WS0] Write `test/helpers/fake-orchestrator-runner.mjs`: it writes an executable named `claude` into a temporary directory. The executable records its arguments, working directory, that directory's listing, its environment names, and its standard input, and takes its first stream event, reply, exit code, error output, and delay from a control file. It writes the stream of JSON events the real CLI does, in the shape T004 captures. Tests that use it are skipped on Windows.
- [ ] T003 [WS0] Live captures, by a person, with the real app in a private test channel: the raw history and replies bodies for a typed mention, a typed command whose `files` field names `README.md` and a `.py` file, a typed `approve`, a message an app posted as the operator, a thread reply also sent to the channel, and a command typed in a code block. Replace every real ID, name, and unneeded text with a fake value and store them under `test/fixtures/slack/`.
- [ ] T004 [WS0] One real profile probe, by a person: run the `claude` profile once with `--output-format stream-json --verbose` and the input "Reply with OK". Store the field names of the first event as a fixture and record whether the run used the subscription login. If the first event does not report tools, MCP servers, and the credential source, stop and amend spec 025 FR-15 before T020.
- [x] T005 [WS0] Add the thirteen invariant tests of the plan to `test/slack-listen-invariants.test.mjs`, each skipped and naming the workstream that enables it. Every test sets `BRAIN_TRAIN_HOME` to a temporary directory. `npm test` gives the same result as `main`.
- [ ] T006 [WS1] Write `src/brain_train/slack/inbound.mjs`: the plan's table of which messages are heard. Test a message with another user's ID, one with the operator's ID and an `app_id`, a bot message, a thread reply shown in the channel, and each fixture from T003, in `test/slack-inbound.test.mjs`. (Written in lane i; the T003 fixture cases are skipped until the captures exist.)
- [x] T007 [WS1] Write `src/brain_train/slack/verbs.mjs`: the six verbs as data with their keys, value checks, approval rule, and argument template, and the FR-4 list. Test that no template holds a word from the FR-4 list and that `start` and `pause` are refused in `auto`.
- [ ] T008 [WS1] Write `src/brain_train/slack/grammar.mjs`: undo Slack's encoding, find the command, check it against the verb table, and render canonical text. Test every rejection the plan lists for WS1, the `README.md` link fixture, a code-fenced command, a value that starts with `-`, and the two-repository `repo=` cases, in `test/slack-grammar.test.mjs`. Needs 024 T003 for the text steps. (Written in lane i; the two captured-fixture tests are skipped until T003.)
- [x] T009 [WS1] Write `src/brain_train/slack/reply.mjs`: split a model's reply into prose and at most one proposal, check the proposal, and prepare the prose with the full text handling of spec 024 FR-8, cut to 3,000 characters. Test a reply with a token pattern, a mention, and a link, and a reply with two `btrain>` lines.
- [x] T010 [WS1] Write `src/brain_train/slack/decide.mjs`: one pure function from state, a classified message, the configuration, and the time to actions and state changes. It holds approval, rejection, expiry, one pending proposal for a thread, the `auto` list, every limit, and the age rule. Test each `decide.mjs` case the plan lists in `test/slack-decide.test.mjs`. Remove the unit-level skips for invariants 2, 5, and 6.

**Independent check:** every parser, verb, and policy rule has a test that needs no network and no process. No file outside `slack/` and `test/` changes.

## Phase 2: Toggle, state, and the poll loop (WS2, WS3)

- [ ] T011 [WS2] Add `slack_listen` to `FEATURES` in `src/brain_train/repo_mode.mjs` with `localDefault: false` and `explicitOnly: true`. Test that a repository with no `[features]` table has it off and that `btrain features` shows it off. Needs 024 T007. Held on 2026-11-23: `repo_mode.mjs` (lane a).
- [x] T012 [WS2] Extend `src/brain_train/slack/config.mjs`: the `orchestrator` object of `slack.json`, `[slack.orchestrator]` of `project.toml`, the spec's defaults, and the served repositories (registered, both toggles on, a channel from the map or the catch-all). An empty `runner` means no model. Needs 024 T009.
- [x] T013 [WS2] Write `src/brain_train/slack/inbox.mjs`: load, change, and write `inbox.json` by temporary file and rename with mode 0600; drop `handled` entries after 48 hours and old window times; refuse `approvalMinutes` above 24 hours; keep 20 results for each repository. Test a round trip and that a half-written temporary file is never read.
- [x] T014 [WS2] Write `src/brain_train/slack/lease.mjs` over `slack/lock.mjs`: take and release the listener lease, touch it on a 15-second timer, and read its nonce again with synchronous calls as the last thing before each rename of `inbox.json`; the stop flag; the pause flag. Test that a second lease for one btrain home is refused with the holder named, and that a lease untouched for 60 seconds is taken over. Needs 024 T012.
- [ ] T015 [WS2] Add `btrain slack whois [--channel <id>]` to `slack/cli.mjs` (author fields, no message text), add `listRepos`, `findAvailableLane`, a config reader, `enteredByPrPoll` (the predicate of `enteredChangesRequestedViaPrPoll` over the lane's event log), and the CLI path to the readers object the `slack` block in `cli.mjs` passes, add the help lines, and ship `docs/slack-app-manifest-listen.json` with the publisher's scopes plus `channels:history` and `groups:history`. Remove the skips from invariants 1 and 12. Held on 2026-11-23: `cli.mjs` (lane c).
- [x] T016 [WS3] Write `src/brain_train/slack/read-client.mjs` over the low-level call of `slack/client.mjs`: the two read calls as GET requests, paging, the 60-second overlap, and the read budget of 30 a minute for a channel and 40 a minute for a method. Test six open threads on one channel and a 429 not retried before `Retry-After`. Needs 024 T013.
- [ ] T017 [WS3] Write the cycle in `src/brain_train/slack/listen.mjs` and the `btrain slack listen` command: the seven steps of the plan, record before act, refusal to start with no `operator`, no served repository, or a live lease. In this workstream a mention gets the one-line note that the model is off and a command gets a note that commands are not built yet.
- [ ] T018 [WS3] Add `--stop`, `--resume`, and the pause flag. `pause` drops the rest of what was read, and resume moves every channel cursor and every open thread's reply cursor to the current time. Open a conversation on a typed top-level mention, keep its reply cursor, and close it `conversationMinutes` after the operator's last message. Drain each served repository's outbox every cycle, also while paused. Needs 024 T015.
- [ ] T019 [WS3] Add `test/slack-listen.test.mjs` with every WS3 test the plan lists: other authors ignored, a mention under a lane card ignored with no replies call, a closed thread no longer read, the age rule with exactly one reply across a restart, a handled `ts` not acted on twice, two operators with separate homes on one channel, the stop flag, the pause flag in a channel and in an open thread, a command after `pause` in one read, a 90-second `Retry-After` that keeps the lease, a replaced nonce, 30 hours down, and a queued spec 024 entry delivered within one cycle. Remove the skips from invariants 3 and 10.

**Independent check:** a listener against the fake hears only the operator, answers a mention with the commands-only note, survives a restart without acting twice, and delivers queued publisher posts.

## Phase 3: The model run and typed commands (WS4, WS5)

WS4 and WS5 do not depend on each other.

- [ ] T020 [WS4] Write `src/brain_train/slack/runner.mjs`: the `claude` profile (allowed extra words, added arguments with `--output-format stream-json --verbose`, input on standard input, the environment list, macOS and Linux only), one run in an empty temporary directory in its own process group, the timer, the 64 KB output cap, and the outcome table with fixed reply text. Check the first event of every run: a tool, an MCP server, an API key as the credential source, or an unreadable event stops the run, discards its output, and marks the profile failed.
- [ ] T021 [WS4] Write `src/brain_train/slack/snapshot.mjs` and the instruction text file shipped in `slack/`: the four labeled parts, the thread filtered to the operator's messages and this developer's bot messages, the lane snapshot cut as spec 024 FR-8 cuts it, the last 20 results, and the scrub step on every part.
- [ ] T022 [WS4] Turns in `listen.mjs`: a run for a new conversation and for each reply in an open thread, one at a time for a thread, at most three alive, counted against `maxTurnsPerHour`. Post the handled prose in the thread.
- [ ] T023 [WS4] Write `runProfileCheck` with the same arguments and the same first-event test as an ordinary run, and `runner-check.json`; run the check at listener start, and add the listener findings to `slack/doctor.mjs`: `slack_listen` on with `slack` off, no `operator`, `start` or `pause` in `auto`, a runner with no profile, a failed check, and a paused listener. `btrain doctor` runs the check only when no verdict is saved for the current runner, profile version, and CLI version, never in a lane-pinned session, and never with the toggle off.
- [ ] T024 [WS4] Add `test/slack-runner.test.mjs` with every WS4 test the plan lists. Remove the skips from invariants 7, 8, and 9.
- [ ] T025 [WS5] Write `src/brain_train/slack/commands.mjs`: the pre-checks of the verb table, run when a command is accepted and again just before its child starts, the argument lists, the child environment with the seven names removed, `execFile` for short children, a detached start for loops with output to `runs/`, and the loop list.
- [ ] T026 [WS5] Run `status`, `flush`, `poll-pr`, `retry-review`, and `pause` from a message the operator typed. `poll-pr` accepts a `changes-requested` lane only when `enteredByPrPoll` confirms it. Add `--expect-status <status>` to the `loop` command in `cli.mjs`, passed to `runLoop` as `expectStatus` and checked there on the state it dispatches from; the command exits 1 with no dispatch when the lane's status differs. Change the pinned `runLoop` line count in `test/decomposition_inventory.test.mjs` and state both numbers in the handoff. Pass the flag for `retry-review`. Held on 2026-11-23: `cli.mjs` (lane c), `core.mjs` (lane h). Reply with a result for every command acted on, built from fixed text, and keep the last 20 for each repository. Apply `max_commands_per_hour` and `max_active`. Needs 024 T016 to T021.
- [ ] T027 [WS5] Add `test/slack-commands.test.mjs` with every WS5 test the plan lists, including the composition test that `retry-review` against the real CLI dispatches a fake reviewer once, that a crash after the `ts` is recorded does not run the command on restart, and that a lane leaving `needs-review` before or after the child starts gets no dispatch. Remove the skip from invariant 11.

**Independent check:** a typed mention gets a handled reply from the fake runner with exactly the profile's arguments, and each of the five verbs runs from a typed command with its checks and its result reply. The token is in no input, record, state file, or log line.

## Phase 4: `start`, proposals, approval (WS6)

Held on 2026-11-23: `core.mjs` (lane h), `cli.mjs` (lane c).

- [ ] T028 [WS6] Add `--requested-via <text>` to `btrain handoff claim`: one conditional line in each of the two `eventDetails` objects in `claimHandoff`, and one line in the help text. Classify the lane's formal impact as `validation` and run the formal advisory command.
- [ ] T029 [WS6] Implement `start`: the checks, the lane picked by `findAvailableLane`, the claim child with `--lane` and `--requested-via`, then the detached loop child. Reply once when the claim succeeds or fails and once when the loop ends.
- [ ] T030 [WS6] Proposals from a model's reply: post the canonical text in a code block with the approval line, store it under the post's `ts`, and cancel an earlier one in the thread. A proposal whose post fails keeps its whole record on the `outgoing` entry and becomes pending under the `ts` of the retry that succeeds, unless it has expired or the thread has another pending proposal by then. A new proposal removes the thread's waiting one. `approve` checks the expiry time itself. Reject a proposal that would not fit in one 3,999-character message. Implement `approve`, `reject`, and expiry. A proposal for a verb on the `auto` list runs at once, within `retry_review_per_hour`.
- [ ] T031 [WS6] Add `test/slack-proposals.test.mjs` with every WS6 test the plan lists, including: a reaction approves nothing; an `approve` with an `app_id` approves nothing; an expired `approve` runs nothing; a proposal posted on a retry can be approved, but not after its expiry or after a newer proposal; a 2,000-character task is accepted; `start` and the snapshot work in a repository without lanes; a task holding `$(...)`, a backtick, `;`, and a quote reaches the claim as literal text; the claim event records the Slack channel, the message `ts`, and who wrote the command. Confirm `node scripts/decomposition_inventory.mjs --stages` exits 0 with no change to the assignment JSON. Remove the skips from invariants 4 and 13.

**Independent check:** a `start` proposal runs only after the operator's typed `approve` in its thread, and what runs is the stored text that was shown.

## Phase 5: Install, pilot, and spec 023 (WS7, WS8)

- [ ] T032 [WS7] Write `src/brain_train/slack/install.mjs` and `btrain slack listen --install`: a user launch agent on macOS with `PATH` and `HOME` from the installing shell, and a printed systemd user unit on Linux.
- [ ] T033 [WS7] Write the README section: the two toggles, the listening manifest, `whois`, `listen`, the verbs, that the app must stay an internal app of one workspace, and the warning that an approved `start` runs an agent in the repository's registered checkout. Held on 2026-11-23: `README.md` (lane h).
- [ ] T034 [WS7] Turn `slack_listen` on in the btrain repository only, after the publisher pilot (024 T029), and use it for two weeks. Report the plan's measures. Confirm or change the five values under the spec's "Defaults to confirm during implementation" and record the result in the spec. The pilot passes when no action came from a message the operator did not type, no command ran twice, no reply carried a secret or a mention, and the operator judges the answers worth their usage.
- [ ] T035 [WS8] After spec 023 is implemented: describe and test `retry-review` as starting a new review attempt, show the display states `in-review` and `confirming-fix` in the snapshot, and add a test that runs the listener for several cycles against a lane with an active attempt and asserts no pickup and no progress signal came from the listener. Add a test of the FR-4 list against the real `fix` and `confirm-fix` command names.

## Dependencies

T001 needs 024 T001. T002 to T005 follow it. T006 to T010 need T005 and 024 T003. T011 to T015 need T005 and 024 T007 to T010. T016 to T019 need T006 to T015 and 024 T011 to T015. T020 to T024 need T016 to T019. T025 to T027 need T016 to T019 and 024 T016 to T021. T028 to T031 need T020 to T027. T032 to T034 need T028 to T031 and 024 T028 and T029. T035 needs the spec 023 tasks T020 to T039.

T003 and T004 are done by a person and block T008 and T020: the grammar and the profile check are written against the captured shapes.
