# 025 — Slack Orchestrator Implementation Plan

**Status:** Draft
**Spec:** [025 — A Local Orchestrator in Slack](025-slack-orchestrator.md)
**Depends on:** [the spec 024 plan](024-slack-lane-publisher-implementation-plan.md)
**Date:** 2026-11-23

## Plan decision

Build the listener as more modules in `src/brain_train/slack/`, on top of the
publisher's modules. Write the pure parts first: the command grammar, the verb
table, the rule for which messages are heard, and the handling of a model's
reply. Then the state file and the lease, then the poll loop, then the model
run, then commands. Each workstream is one lane and one PR. Nothing listens
until a developer turns `slack_listen` on and starts `btrain slack listen`.

Six decisions shape the design:

- **Every verb except `pause` runs as a child `btrain` process.** The listener
  starts the same CLI file it was started from, with `execFile` and a fixed
  argument template for each verb. It never calls a lane function in process.
  A command from Slack then passes through the same guards as a command typed
  at the machine, and the poll loop never waits on one.
- **The listener picks the lane for `start`.** `btrain handoff claim` with no
  `--lane` picks a free lane itself and prints no single lane ID to parse. The
  listener needs the ID for the `btrain loop` that follows. It picks the lane
  with the same rule, passes `--lane`, and reports a lost race as a failed
  command.
- **The model's input goes in on standard input.** `--tools` in the `claude`
  CLI takes a list, so a prompt given as an argument after `--tools ""` can be
  read as a tool name. Standard input also keeps the snapshot out of the
  process list.
- **One writer for the state file.** Only the listener writes `inbox.json`.
  `--stop`, `--resume`, and `pause` use small flag files, so no second process
  ever rewrites the state.
- **The same hard constraints as the spec 024 plan.** No new function in
  `core.mjs`, no added line in `patchHandoff` or `runLoop`, `slack/` never
  imports `core.mjs`, zero runtime dependencies, and no usage-billed service.
  This plan adds two lines to one unpinned core function, `claimHandoff`.
- **No model run in a test.** Tests use the fake Slack `fetch` of spec 024
  WS0, extended for the two read calls, and a fake runner executable.

The repo has numbered flat specs and no `.specify/` script or template
directory. This plan uses that established format and records the design, data
model, contracts, and quality gates here.

Review of the spec against the code found places where it could not be built
as written. This lane amends spec 025 for each one, and the spec 024 plan for
what this plan needs from it. Both lists are below.

## Current integration points

| Surface | Existing state | Planned change |
| --- | --- | --- |
| `src/brain_train/slack/` | Does not exist on `main`. The spec 024 plan creates it in its WS1 to WS5 | Twelve new modules. Three spec 024 modules gain exports (see "What the spec 024 plan must provide") |
| The `slack` block in `cli.mjs` | Planned by spec 024 WS2. It delegates to `slack/cli.mjs` | Pass four more values into it: `listRepos`, `findAvailableLane`, a config reader, and the path of the running CLI file. Add `listen` and `whois` to the help text |
| `claimHandoff` in `core.mjs` (line 5959) | Takes the named `--owner` as the transition's actor and does not check who is calling. With no `--lane` it picks a lane with `findAvailableLane`. Its claim event records `task`, `lockedFiles`, and cgraph data. Not a pinned function | One conditional line in each of its two `eventDetails` objects, to record a `--requested-via` value. No other core change |
| `findAvailableLane`, `readAllLaneStates`, `readProjectConfig`, `listRepos` in `core.mjs` | All four are exported | Passed to the listener by `cli.mjs`. Not imported by `slack/` |
| `parseOptions` in `cli.mjs` (line 288) | An argument that starts with `--` is always read as a flag, even in a value position | Unchanged. The listener rejects any field value that starts with `-` before it builds an argument list |
| `btrain loop` in `cli.mjs` (line 2363) | Requires the `loop` feature. Runs `runLoop`, which sends each round to the owner or the reviewer by lane status (`getLoopActorForState`). A round's default timeout is 10 minutes. Exit code 1 on `failed`, `timed-out`, or `max-rounds-exceeded` | Unchanged. Started as a child for `start` and `retry-review` |
| `buildLoopRunnerEnv` in `core.mjs` (line 8982) | Spreads the whole of `process.env` into the agent runner and adds the agent and lane pins | Unchanged. The listener removes the Slack token and every btrain pin from the environment it gives a `btrain` child, so neither reaches a lane agent through the loop |
| `executeLoopCliRunnerWithStreaming` in `core.mjs` (line 9042) | Starts the runner in its own process group, sends `SIGTERM` to the group on timeout, then `SIGKILL` after one second, and closes its pipes | Not called. `slack/runner.mjs` uses the same pattern for the orchestrator run. Sharing one helper is a follow-up |
| `runPrPoll` in `pr-flow.mjs` (line 1142) | With `--apply` it writes the PR outcome to the lane through the `pr-poll` event. Legacy row L5 in `transitions.mjs` accepts that event from any status | Unchanged. The listener checks the lane's stored status before it starts the child |
| `LANE_LOCKED_ALLOWED_COMMANDS` in `cli.mjs` (line 1593) | Eight commands. `slack` and `loop` are not among them | Unchanged, and `slack` must stay out. A lane-pinned agent then cannot start, stop, or resume a listener |
| `FEATURES` in `repo_mode.mjs` | Thirteen toggles. Spec 024 WS2 adds `slack` and the `explicitOnly` flag | Add `slack_listen` with `localDefault: false` and `explicitOnly: true` |
| `doctorRepo` in `core.mjs` | Spec 024 WS4 appends the findings of `slack/doctor.mjs` | No core change. `slack/doctor.mjs` returns more findings |
| `~/.btrain/slack.json` | Holds the token, label, operator, mention list, poll interval, and channel map. Nothing reads it yet | `slack/config.mjs` also reads the `orchestrator` object |
| `~/.btrain/slack/` | Planned by spec 024 for `boards.json` | Add `inbox.json`, the lease, two flag files, the runner check result, and a `runs/` log directory |
| `scripts/install-handoff-history-launch-agent.sh` | Writes a launchd agent for another btrain helper | Used as the model for the plist text. `--install` writes its own file from Node |

## Architecture and invariants

### Modules

| Module | Responsibility | Pure |
| --- | --- | --- |
| `slack/inbound.mjs` | Decide whether a Slack message is heard: operator typed it, top level or thread reply, mentions the bot | Yes |
| `slack/grammar.mjs` | Undo Slack's text encoding, find the command, parse it, check it, render canonical text | Yes |
| `slack/verbs.mjs` | The verb table as data: keys, value checks, approval rule, argument template | Yes |
| `slack/reply.mjs` | Split a model's reply into prose and at most one proposal, and prepare the prose for posting | Yes |
| `slack/decide.mjs` | Given state, one message, and the time, return what to do. All policy and all limits | Yes |
| `slack/snapshot.mjs` | Build the text a model run reads | Yes |
| `slack/inbox.mjs` | Read and write `inbox.json` | No |
| `slack/lease.mjs` | The listener lease, the stop flag, the pause flag | No |
| `slack/read-client.mjs` | `conversations.history` and `conversations.replies`, paging, the read budget | No |
| `slack/runner.mjs` | Runner profiles, the run itself, the profile check | No |
| `slack/commands.mjs` | Pre-checks, argument lists, child processes, loop tracking, results | No |
| `slack/listen.mjs` | The cycle that ties these together | No |
| `slack/install.mjs` | Launch agent and systemd unit text | No |

Spec 024 modules this plan uses unchanged: `credentials.mjs`, `lock.mjs`,
`outbox.mjs`, `threads.mjs`, `deliver.mjs`, `render.mjs`. Modules it extends:
`config.mjs` (orchestrator settings), `cli.mjs` (`listen`, `whois`),
`doctor.mjs` (listener findings), `text.mjs` and `client.mjs` (new exports).

`decide.mjs` is where every rule of FR-3, FR-5, FR-6, FR-7, FR-10, and FR-13
lives. It reads no file and makes no call. `listen.mjs` only carries out what
it returns. A test can then put any message against any state with no fake
network.

### Invariants

Each one is a test. WS0 adds them skipped, and the workstream that makes one
pass removes its skip.

1. A repository with `slack_listen` off, or with no `[features]` table, is not
   served. No read call is made for a channel that maps only such
   repositories.
2. A message is acted on only when its `user` is the operator and it has no
   `app_id` and no `bot_id`. Every other message gets no reply, no model run,
   and no command.
3. A message's `ts` is in the handled set, and the state file is renamed into
   place, before any child process or post for that message starts. No `ts`
   causes an action twice, across restarts.
4. The text a command runs from is the stored canonical text, and the stored
   text is exactly what was posted.
5. `start` runs from a proposal only after the operator's typed `approve` in
   that proposal's thread. `pause` never runs from a proposal.
6. Every `btrain` child is started without a shell, from one of the fixed
   templates in the verb table. Each value is one argument and does not start
   with `-`. No template names a command in the FR-4 list.
7. An orchestrator run starts with exactly its profile's arguments, in an
   empty temporary directory, with only the allowed environment names. A
   runner with no profile, or with a failed profile check, is never started.
8. Nothing a model wrote is posted before the text handling of spec 024 FR-8.
   A model's text cannot produce a mention or a link.
9. The Slack token is in no model input, no child's environment, no state
   file, no log line, and no reply.
10. A poll cycle never waits for a child process.
11. The listener starts no child with an agent identity or a lane pin in its
    environment, and reads lane state only through the reader functions.
12. One listener runs for each btrain home.
13. `core.mjs` gains no function, and `patchHandoff` and `runLoop` keep their
    line counts. The gates are those of the spec 024 plan's invariant 8.

### Data model

All files are in `~/.btrain/slack/`, moved by `BRAIN_TRAIN_HOME`. Each is
written to a temporary name and renamed, with mode 0600.

**`inbox.json`**, written only by the listener:

```json
{
  "version": 1,
  "channels": {"C0FAKE0001": {"cursor": "1700000000.000100"}},
  "threads": {"C0FAKE0001:1700000000.000100": {
    "lastOperatorTs": "1700000050.000200", "replyCursor": "1700000050.000200",
    "busy": false, "queued": [], "pending": "1700000060.000300"}},
  "handled": {"C0FAKE0001:1700000050.000200": "<ISO time first seen>"},
  "proposals": {"C0FAKE0001:1700000060.000300": {
    "thread": "1700000000.000100", "repo": "<registered path>",
    "canonical": "btrain> start owner=codex\ntask: ...",
    "source": "orchestrator", "sourceTs": "1700000050.000200",
    "expiresAt": "<ISO>", "state": "pending"}},
  "results": {"<registered path>": [
    {"at": "<ISO>", "verb": "retry-review", "lane": "e", "source": "operator",
     "outcome": "ran", "detail": "exit 0"}]},
  "windows": {"commands": {"<registered path>": ["<ISO>"]},
              "retryReview": {"<registered path>#e": ["<ISO>"]},
              "turns": ["<ISO>"]},
  "loops": [{"repo": "<registered path>", "lane": "e", "verb": "start",
             "pid": 12345, "startedAt": "<ISO>", "log": "<path>",
             "channel": "C0FAKE0001", "thread": "1700000000.000100"}],
  "outgoing": [{"channel": "C0FAKE0001", "thread": "1700000000.000100",
                "text": "...", "attempts": 0, "nextTryAt": "<ISO>"}]
}
```

- `handled` entries are removed after 24 hours. Each read asks Slack for
  messages from 60 seconds before the cursor, and the handled set drops the
  repeats. A message that Slack lists late is then still seen once.
- `proposals` states are `pending`, `approved`, `rejected`, `expired`, and
  `cancelled`. Only `pending` can be approved.
- `results` keeps the last 20 for each repository.
- `windows` holds the times of the last hour, for the limits of FR-10.
- `outgoing` holds a reply whose post failed with a transient error. It is
  tried again for up to 5 attempts and then dropped with a log line.
- No message text from Slack is stored. A model run reads its thread from
  Slack again.

**`listen.lock`**: the lease. It holds a nonce, the process ID, the operator
ID, and the start time. The listener touches it every cycle. It is the
delivery lock of spec 024 with another path: under 60 seconds old means live.

**`listen.stop`**: written by `btrain slack listen --stop`. The listener
checks for it every cycle, removes it, releases the lease, and exits.

**`listen.paused`**: written by the listener when the operator types
`btrain> pause`. Removed by `btrain slack listen --resume`. While it exists
the listener makes no read call. When it goes away, the listener sets every
channel cursor to the current time, so nothing sent during the pause is
handled.

**`runner-check.json`**: the last profile check: the runner string, the
profile version, the CLI's version string, the verdict, and the reason.

**`runs/`**: one log file for each loop the listener starts, mode 0600,
removed after 7 days. Agent output goes here and is never posted.

### The cycle

Every `pollSeconds`, in this order:

1. Touch the lease. Exit if the stop flag exists.
2. Collect finished children. For each one, record the result, write the
   state, and queue its reply.
3. If the pause flag is absent: read each served channel and each open
   thread, inside the read budget. Take new messages oldest first. For each
   one, ask `decide.mjs` what to do, add the `ts` to the handled set, write
   the state, and only then start the action.
4. Expire proposals and close conversations that have passed their time.
5. Send queued replies.
6. Drain the outbox of each served repository through `deliver.mjs`, with a
   budget of half the poll interval. This step also runs while paused.
7. Every sixth cycle, read the registry and each repository's toggles again,
   so a change takes effect without a restart.

A model run, a `btrain` child, and a loop are started and not awaited. Step 2
of a later cycle picks them up.

### Which messages are heard

`inbound.mjs` applies these rules in order to one message from a read call:

| Rule | Result |
| --- | --- |
| `user` is not the operator, or `app_id` or `bot_id` is present | Ignored. One local log line with the `ts` and the author fields, no text |
| Has a `subtype` other than `thread_broadcast` | Ignored |
| From `conversations.history`, and `thread_ts` is present and differs from `ts` | Ignored. This is a reply shown in the channel, for example under a lane card |
| From `conversations.history`, top level, and the text has a command | An operator command |
| From `conversations.history`, top level, and the text has `<@BOT>` | A new conversation |
| From `conversations.history`, anything else | Ignored |
| From `conversations.replies` for an open thread, and the whole text is `approve` or `reject` | An approval reply |
| From `conversations.replies`, and the text has a command | An operator command |
| From `conversations.replies`, anything else | The next turn of the conversation |

`<@BOT>` is the bot user ID that `auth.test` returns at start. The listener
calls `conversations.replies` only for threads it opened, so a reply in any
other thread is never read. The parent message, which that call returns
first, is skipped by its `ts`.

A message that would have started something, and whose `ts` is more than
`approvalMinutes` old when first seen, gets one reply that says it was
skipped for its age. It is added to the handled set like any other.

A channel with no saved cursor starts at the current time. A saved cursor
more than 24 hours old is moved to 24 hours ago.

### Command grammar

`grammar.mjs` works in four steps.

1. **Undo Slack's encoding** of an operator's message. Decode `&amp;`,
   `&lt;`, and `&gt;`. Replace link markup `<url|label>` with `label` and
   `<url>` with `url`: a Slack client can turn a file name such as
   `README.md` into a link. Remove a code fence around the command. Reject a
   command that still holds a user, channel, or special mention token. A
   model's reply is not encoded and skips this step.
2. **Find the command.** A line that starts with `btrain>`. Two such lines
   reject the message. Lines after it, up to the first blank line, are
   fields.
3. **Check it** against `verbs.mjs`: a known verb, only that verb's keys,
   every required key, and each value's check.
4. **Render canonical text**: the verb line with its short arguments in table
   order, then the fields in table order, one space after each colon, no
   trailing space.

Value checks that apply to every key: one line, no control character, not
empty, and the first character is not `-`. The last one matters because
`parseOptions` reads any argument that starts with `--` as a flag.

| Key | Check |
| --- | --- |
| `repo` | Exactly one served repository of this channel has that name, or the value is a registered path of one of them |
| `lane` | A lane ID in that repository's configuration |
| `owner`, `reviewer` | An active agent in that repository whose `[agents.runners]` value is set and is not `notify` |
| `task` | At most 2,000 characters |
| `files` | A comma list of 1 to 50 relative paths. No `..` segment, no leading `/` or `~`, no backslash, and each resolves inside the repository |
| `objective`, `deliverable`, `acceptance`, `done-when` | At most 500 characters |

A proposal has one more check. The canonical text is rejected when the scrub
step, the cut step, or the URL rewrite of spec 024 FR-8 would change it. Only
the escape step is applied when it is posted, inside a code block, and that
step changes nothing the operator sees.

### Verb table

`<cli>` is `process.execPath` followed by the path of the running CLI file.
Every child runs with the repository's registered path as its working
directory.

| Verb | Checks before it runs | Child | From a proposal |
| --- | --- | --- | --- |
| `status` | None | `<cli> slack refresh` | Runs when on the `auto` list |
| `flush` | None | `<cli> slack flush` | Runs when on the `auto` list |
| `poll-pr lane=<id>` | `pr_flow` feature on. Stored status is `pr-review` or `ready-to-merge`, or `changes-requested` with a PR number | `<cli> pr poll --lane <id> --apply` | Runs when on the `auto` list |
| `retry-review lane=<id>` | `loop` feature on. Stored status is `needs-review`. Fewer than `max_active` loops alive. For a proposal, fewer than `retry_review_per_hour` unapproved runs for this lane in the last hour | `<cli> loop --lane <id> --max-rounds 1`, detached | Runs when on the `auto` list |
| `start owner=<agent>` | `loop` feature on. The value checks above. Fewer than `max_active` loops alive. A free lane exists | `<cli> handoff claim --lane <picked> --owner <agent> --task <text> --files <list>`, with `--reviewer`, `--objective`, `--deliverable`, `--acceptance`, and `--done-when` when given, and `--requested-via <text>`. Then `<cli> loop --lane <picked> --max-rounds <max_rounds>`, detached | Waits for `approve` |
| `pause` | Typed by the operator | None. Writes the pause flag | Never |

Every verb also counts against `max_commands_per_hour` for its repository.
`start` and `pause` are refused in `[slack.orchestrator].auto` when the
configuration is read, and `btrain doctor` reports the bad entry.

`verbs.mjs` also holds the list of FR-4 as data: `merge`, `resolve`,
`request-changes`, `fix`, `confirm-fix`, `override`, `locks`, `doctor`,
`features`, `init`, `agents`. A test asserts that no template contains one.

The free lane is picked by `findAvailableLane` over `readAllLaneStates`, both
passed in by `cli.mjs`. If another process takes the lane first, the claim
fails its own guard and the listener reports that. In a repository without
lanes, `--lane` is left out of both children.

`--requested-via` carries `slack <channel> <ts> <operator|orchestrator>`.

**Child environment.** A `btrain` child gets the listener's environment with
these names removed: `BTRAIN_SLACK_BOT_TOKEN`, `BTRAIN_AGENT`,
`BRAIN_TRAIN_AGENT`, `BTRAIN_LANE`, `BTRAIN_LANE_LOCKED`, `BTRAIN_REPO`, and
`BTRAIN_LOOP_ACTIVE`. The last six are the names `npm test` already clears.
A child that needs to deliver to Slack reads the credential file.

**Loops.** A loop child is detached, with its output sent to a file in
`runs/`. It keeps running if the listener stops. The listener records its
process ID and counts it as active while that process exists. A loop that
ends while the listener is down is reported with "exit code unknown".

**Results.** A result reply is built from fixed text: the verb, the
repository, the lane, and the exit code. For `poll-pr` it adds the status
from the child's `handoff updated:` line, checked against the known status
names. No other child output is posted.

### The orchestrator run

**Profiles.** `runner.mjs` holds one profile for each supported executable,
found by the basename of the runner's first word. The first version has one:

| Field | `claude` |
| --- | --- |
| Extra words allowed in `orchestrator.runner` | `-p` or `--print`, `--model <name>`, `--effort <level>` |
| Arguments added | `--tools ""`, `--safe-mode`, `--restricted`, `--strict-mcp-config`, `--no-session-persistence`, `--permission-prompts none` |
| Input | Standard input |
| Output | Standard output as text |
| Environment | `PATH`, `HOME`, `TMPDIR`, `TERM`, `LANG`, `SHELL`, `USER`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase forms, `CLAUDE_CONFIG_DIR` |
| Platforms | macOS and Linux |

All six flags are in `claude --help` for version 2.1.274, checked on
2026-11-23. A runner string with a word the profile does not allow has no
profile. The listener does not start it and `btrain doctor` reports it. The
runner string is split on spaces and never passed to a shell.

**One run.** Create an empty directory with `mkdtemp`. Start the runner there
in its own process group, with the allowed environment. Write the input to
standard input and close it. Keep at most 64 KB of output. At `turnSeconds`,
send `SIGTERM` to the group and `SIGKILL` one second later. Remove the
directory.

**Outcomes.**

| Outcome | How it is known | Reply |
| --- | --- | --- |
| Reply | Exit code 0 and output that is not empty | The handled reply |
| Timed out | The timer fired | "The orchestrator timed out. Commands still work." |
| Missing | The executable was not found | "The orchestrator is not installed. Commands still work." |
| Out of usage or signed out | Non-zero exit and a profile pattern matches the output | "The orchestrator is out of usage or signed out. Commands still work." |
| Failed | Any other non-zero exit, or empty output | "The orchestrator run failed. Commands still work." |

Reply text for a failure is fixed. The runner's error output goes to the
local log and is never posted.

**Queueing.** One run at a time for a thread. A second message waits in the
thread's `queued` list. At most three runs are alive at once. Each started
run is counted against `maxTurnsPerHour`.

**The input.** `snapshot.mjs` builds one text with four labeled parts, in
this order: the fixed instruction text; the lane snapshot; the thread so
far; and the operator's newest message, marked as the instruction.

- The thread comes from one `conversations.replies` call for that thread. It
  keeps messages the operator typed and messages from the btrain bot that
  carry this developer's label. Everything else is dropped.
- The lane snapshot covers the served repositories of the thread's channel.
  For each active lane it has the card fields of spec 024 FR-6, the next
  action, and the reason code, each cut as spec 024 FR-8 cuts them. It also
  has that repository's last 20 results.
- Every part passes through the scrub step before it is joined.
- The instruction text is a file shipped in `slack/`, so a change to it is a
  reviewed change.

**The reply.** `reply.mjs` takes the raw output. It finds `btrain>` lines.
More than one rejects the proposal part and keeps the prose, with a note. One
is parsed and checked as above. The prose, with the proposal removed, goes
through the full text handling of spec 024 FR-8 and is cut to 3,000
characters. The prose is posted first. A valid proposal is then posted on its
own, as canonical text in a code block with the approval line, and it becomes
pending when that post returns its `ts`.

**The profile check.** `runProfileCheck` starts the runner once with the
profile, the input "Reply with OK", and `--output-format stream-json
--verbose`. It reads the first event of the stream. The check fails when that
event lists any tool, lists any MCP server, or names an API key as the
credential source. It also fails when the event cannot be read. The verdict is
saved in `runner-check.json` with the runner string, the profile version,
and the output of `claude --version`.

The check runs when the listener starts and when `btrain doctor` finds no
saved verdict for the current runner string, profile version, and CLI
version. `btrain doctor` otherwise reports the saved verdict. `btrain doctor`
skips the check in a lane-pinned session and in a repository with
`slack_listen` off.

### Limits

| Limit | Scope | Counted in | Workstream |
| --- | --- | --- | --- |
| `max_active` loops alive | Repository | `loops`, by live process | WS5 |
| `max_commands_per_hour` | Repository | `windows.commands` | WS5 |
| `retry_review_per_hour` unapproved | Lane | `windows.retryReview` | WS6 |
| `maxTurnsPerHour` | Developer | `windows.turns` | WS4 |
| Message age over `approvalMinutes` | Message | The message's `ts` | WS3 |
| One pending proposal | Thread | `threads[].pending` | WS6 |
| Read calls | Channel, and method | In memory | WS3 |

A refused command or run gets one reply with the limit that refused it.

### Slack contract

The listener uses the bot token of spec 024 and adds two read calls.

| Call | When | Arguments that matter | Notes |
| --- | --- | --- | --- |
| `auth.test` | At start | Token | Gives the bot user ID for mention matching and the bot ID for the thread filter |
| `conversations.history` | Each cycle, each served channel | `channel`, `oldest`, `limit` 200, `cursor` | Scopes `channels:history`, and `groups:history` for a private channel. Tier 3, 50 or more a minute. Newest message first. `has_more` and `response_metadata.next_cursor` page it |
| `conversations.replies` | Each cycle, each open thread; once for each model run | `channel`, `ts`, `oldest`, `limit` 200, `cursor` | Same scopes and tier. Earliest message first, with the parent first. Accepts form encoding only, not JSON |
| `chat.postMessage` | Every reply | `channel`, `thread_ts`, `text`, `unfurl_links: false`, `unfurl_media: false`. Never `link_names` | The returned `ts` keys a proposal |

Both read calls are sent as GET requests with query parameters.

Fields the listener reads from a message: `type`, `subtype`, `ts`,
`thread_ts`, `user`, `app_id`, `bot_id`, and `text`. The live check of
2026-11-23 showed that a message the operator typed has `user` and
`client_msg_id`, that a message an app posted for the operator has `user` and
`app_id`, and that a bot's message has `bot_id` and `app_id`. The rule uses
the absence of `app_id` and `bot_id`. It does not require `client_msg_id`.

**Read budget.** At most 30 read calls a minute for each channel, as FR-11
states. Slack counts a limit for each method across the workspace, so the
listener also holds each method to 40 calls a minute over all channels. A
channel read comes before thread reads. Thread reads take turns when the
budget is short. A 429 waits at least its `Retry-After`.

**Read errors.** The classes are those of the spec 024 plan. A transient
error skips that read for this cycle. A token error stops all reading and is
a `btrain doctor` finding. `missing_scope` names the listening manifest in
its message. `channel_not_found` and `not_in_channel` stop reading that
channel. `thread_not_found` closes that thread.

**Rate limits depend on the kind of app.** Slack's change of 2025-05-29 cut
both read methods to one call a minute for apps distributed commercially
outside its Marketplace. An internal app that a workspace builds for itself
keeps Tier 3. Each developer's btrain app is created in their own workspace
from the shipped manifest and must stay undistributed.

### CLI contract

| Command | Output | Exit code |
| --- | --- | --- |
| `btrain slack listen` | Runs in the foreground. Prints the operator ID, the served repositories and their channels, the runner and its check verdict, then one line for each action. Never prints message text or the token | 0 when stopped. 1 when it refuses to start: no `operator`, no served repository, or a live lease, in which case it names the holder's process ID and start time |
| `btrain slack listen --stop` | Writes the stop flag and waits up to two poll intervals for the lease to go | 0 when the listener stopped or none was running, 1 when it did not stop |
| `btrain slack listen --resume` | Removes the pause flag | 0 always |
| `btrain slack listen --install` | On macOS, writes a user launch agent that runs `btrain slack listen` with the current `PATH` and `HOME`, and prints the `launchctl` command to load it. On Linux, prints a systemd user unit | 0, or 1 on another platform |
| `btrain slack whois [--channel <id>]` | For the last ten messages of the channel: `ts`, `user`, `bot_id`, `app_id`, whether `client_msg_id` is present, and `subtype`. No message text | 0, or 1 on a Slack error |
| `btrain slack status` (spec 024) | Adds: listener running or not, heartbeat age, paused or not, served repositories, pending proposals, live loops, and the runner check verdict | 0 always |
| `btrain handoff claim --requested-via <text>` | Records the text in the claim event | Unchanged |

`btrain doctor` findings from `slack/doctor.mjs`: `slack_listen` on with
`slack` off; `slack_listen` on with no `operator`; `start` or `pause` in
`auto`; a runner with no profile; a failed runner check; and a listener that
is paused. A listener that is not running is not a finding.

## Workstreams and order

| WS | First artifact | Files other lanes held on 2026-11-23 | Depends on | Done when |
| --- | --- | --- | --- | --- |
| 0 Harness, captures, invariants | The fake Slack extended for reads; a fake runner; live message fixtures; the thirteen invariant tests, skipped | None | 024 WS0 | The fakes page, fail, and hang on demand; fixtures hold real field shapes with fake IDs; `npm test` matches `main` |
| 1 Grammar, verbs, hearing, reply | `slack/inbound.mjs`, `grammar.mjs`, `verbs.mjs`, `reply.mjs`, `decide.mjs` | None | WS0, 024 WS1 | Every parser, verb, and policy rule has a test; invariants 2, 5, and 6 pass at the unit level |
| 2 Toggle, settings, state, lease | `slack_listen`; `slack/inbox.mjs`, `lease.mjs`; orchestrator settings; `whois`; the listening manifest | `repo_mode.mjs` (lane a), `cli.mjs` (lane c) | WS0, 024 WS2 | State survives a restart; a second lease is refused; invariants 1 and 12 pass |
| 3 The poll loop | `slack/read-client.mjs`, `listen.mjs`; stop, pause, resume; the age rule; conversations open and close; outbox drain | None | WS1, WS2, 024 WS3 | A listener against the fake hears only the operator, replies "commands only" to a mention, and drains the outbox; invariants 3 and 10 pass |
| 4 The model run | `slack/runner.mjs`, `snapshot.mjs`; the profile check; doctor findings; turns and their limit | None | WS3, 024 WS1 | A typed mention gets a handled reply from the fake runner; invariants 7, 8, and 9 pass |
| 5 Typed commands | `slack/commands.mjs`; `status`, `flush`, `poll-pr`, `retry-review`, `pause`; results; command limits | None | WS3, 024 WS4 | Each of the five verbs runs from a typed command with its checks and its result reply; invariant 11 passes |
| 6 `start`, proposals, approval | `start`; proposals from a reply; `approve` and `reject`; expiry; `--requested-via` | `core.mjs` (lane h), `cli.mjs` (lane c) | WS4, WS5 | A proposal runs only after a typed `approve`, and runs the stored text; invariants 4 and 13 pass |
| 7 Install and pilot | `--install`; README section; the listener on for the btrain repository only | `README.md` (lane h) | WS6, 024 WS6 | Two weeks of real use with the measures below reported |
| 8 Spec 023 | `retry-review` starts a review attempt; display states in the snapshot; the pickup test | Depends on spec 023's lanes | Spec 023 | The listener's reads record no pickup, shown against the real pickup code |

WS1 can start as soon as spec 024 WS1 has merged `slack/text.mjs`. WS4 and
WS5 do not depend on each other and can run at the same time. Run
`btrain locks` from an unscoped session before claiming each workstream.

### WS0: harness, captures, invariants

1. Extend `test/helpers/fake-slack.mjs` with `conversations.history` and
   `conversations.replies`: a scripted list of messages for each channel and
   thread, paging with `has_more` and `next_cursor`, newest first for history
   and earliest first for replies, and every failure the fake already
   supports. It rejects a JSON body on `conversations.replies`.
2. `test/helpers/fake-orchestrator-runner.mjs`: writes an executable named `claude` into a
   temporary directory. The executable appends its arguments, working
   directory, the listing of that directory, its environment names, and its
   standard input to a file beside it. Its behavior comes from a control file
   beside it: reply text, exit code, error output, delay, or never exit.
   Tests that use it are skipped on Windows.
3. Live captures, by a person, with the real app in a private test channel.
   Save the raw `conversations.history` and `conversations.replies` bodies
   for: a typed mention; a typed command whose `files` field names
   `README.md` and a `.py` file; a typed `approve` reply; a message an app
   posted as the operator; a reply under another thread that was also sent to
   the channel; and a message typed inside a code block. Replace every ID,
   name, and text that is not needed with a fake value, and store them under
   `test/fixtures/slack/`.
4. One real profile probe, by a person: run the `claude` profile once with
   `--output-format stream-json --verbose` and the input "Reply with OK".
   Record the names of the fields in the first event, and whether the run
   used the subscription login. Store the field names as a fixture. If the
   first event does not report tools, MCP servers, and the credential source,
   stop and amend FR-15 before WS4.
5. One test for each invariant, written against the planned interfaces and
   marked skipped with the workstream that will enable it.
6. Every test sets `BRAIN_TRAIN_HOME` to a temporary directory, so none reads
   the real `slack.json` or writes the real `inbox.json`.

### WS1: grammar, verbs, hearing, reply

1. `inbound.mjs`: the table under "Which messages are heard".
2. `grammar.mjs` and `verbs.mjs`: the four steps, the value checks, the verb
   table, and the FR-4 list.
3. `reply.mjs`: the split, the proposal check, and the prose handling.
4. `decide.mjs`: one function from state, a classified message, the
   configuration, and the time to a list of actions and state changes. It
   covers approval, rejection, expiry, one pending proposal for a thread, the
   `auto` list, every limit, and the age rule.
5. Export from `slack/text.mjs` what this needs (see "What the spec 024 plan
   must provide"), if spec 024 WS1 did not.
6. Tests:
   - Each verb parses. An unknown verb, an unknown key, a missing key, and
     two `btrain>` lines are each rejected with a reason.
   - Prose around a valid command is ignored. A command that arrives with
     `&gt;` parses.
   - The captured fixture with `README.md` as a link parses to the plain
     file name. A command inside a code fence parses.
   - A field value that starts with `-`, that is empty, or that holds a
     control character is rejected.
   - A `files` value with `..`, an absolute path, or a `~` is rejected. A
     `task` of 2,001 characters is rejected.
   - A message with another user's ID, and one with the operator's ID and an
     `app_id`, are both classified as ignored.
   - A reply shown in the channel from under another thread is ignored.
   - A canonical text that the scrub, the cut, or the URL rewrite would
     change is rejected.
   - No verb template contains a word from the FR-4 list, and the verb table
     has exactly six verbs.
   - `start` and `pause` in `auto` are refused.
   - `decide.mjs`: a proposal for an `auto` verb runs; a `start` proposal
     waits; `approve` with nothing pending yields one "nothing to approve"
     reply and no model turn; a second proposal cancels the first; an
     expired proposal cannot be approved.
   - A model reply with a Slack token pattern, a mention, and a link comes
     out redacted and escaped, with no link.
   - In a channel with two repositories of one name, `repo=` with the name
     is rejected and `repo=` with a registered path is accepted. A command
     with no `repo=` is rejected there, and so is one that names a
     repository mapped to another channel.

### WS2: toggle, settings, state, lease

1. Add `slack_listen` to `FEATURES` with `localDefault: false` and
   `explicitOnly: true`. It needs the flag that spec 024 WS2 adds.
2. `config.mjs`: read the `orchestrator` object from `slack.json` and
   `[slack.orchestrator]` from `project.toml`, with the spec's defaults. An
   empty `runner` means no model. Compute the served repositories: registered,
   both toggles on, and a channel from the map or the catch-all.
3. `inbox.mjs`: load, change, and write the state file; remove old `handled`
   entries and old window times; keep 20 results for each repository.
4. `lease.mjs`: take, touch, and release the lease; the stop flag; the pause
   flag.
5. `slack/cli.mjs`: `whois`. `cli.mjs`: pass the four values into the `slack`
   block and add the help lines.
6. `docs/slack-app-manifest-listen.json`: the publisher's scopes plus
   `channels:history` and `groups:history`.
7. Tests:
   - A repository with no `[features]` table has `slack_listen` off, and
     `btrain features` shows it off.
   - A repository with `slack` on and `slack_listen` off is not served.
   - The state file round-trips, and a file left half-written under its
     temporary name is never read.
   - A second lease for the same btrain home is refused with the holder
     named. A lease untouched for 60 seconds is taken over.
   - `whois` prints author fields and no message text.
   - The listening manifest has exactly the publisher's scopes plus the two
     read scopes.

### WS3: the poll loop

1. `read-client.mjs`: the two calls, paging, the 60-second overlap, and the
   read budget, over the low-level call that `slack/client.mjs` exports.
2. `listen.mjs`: the cycle. In this workstream a mention gets the one-line
   note of FR-1 that the model is off, and a command gets a reply that
   commands are not built yet.
3. Refuse to start with no `operator`, with no served repository, or with a
   live lease.
4. `--stop`, `--resume`, and the pause flag. Reset the cursors on resume.
5. Conversations: open on a typed top-level mention, keep the reply cursor,
   close `conversationMinutes` after the operator's last message.
6. The outbox drain of step 6 of the cycle.
7. Tests:
   - A message from another user or app gets no reply and starts nothing.
   - A mention in a reply under a lane card starts nothing, and no
     `conversations.replies` call is made for that thread.
   - A thread is no longer read after `conversationMinutes`.
   - A message first seen after its expiry starts nothing and gets exactly
     one reply, also after a restart.
   - A `ts` already in the handled set is not acted on when a read returns
     it again.
   - Two listeners with different operators and separate btrain homes, on
     one fake channel, each act only on their own operator's messages.
   - A second listener for the same btrain home exits 1 and names the
     holder.
   - The stop flag ends the listener within two cycles and releases the
     lease.
   - With the pause flag, no read call is made and the outbox still drains.
     After resume, a message sent during the pause is not acted on.
   - With six open threads on one channel, no minute has more than 30 read
     calls for the channel, and every thread is still read in turn.
   - A 429 on a read is not retried before `Retry-After`.
   - A queued spec 024 entry is delivered within one cycle.

### WS4: the model run

1. `runner.mjs`: the profile table, the allowed extra words, the run, the
   timer, and the outcome table.
2. `snapshot.mjs` and the instruction text file.
3. Turns in `listen.mjs`: start a run for a new conversation and for a reply
   in an open thread, one at a time for a thread, counted against
   `maxTurnsPerHour`.
4. Post the handled prose. A proposal in the reply is noted as "not built
   yet" until WS6.
5. `runProfileCheck`, `runner-check.json`, and the `doctor.mjs` findings.
6. Tests:
   - A typed mention starts one run, and the reply is posted in a thread
     under it. A typed reply in that thread starts the next run with no
     mention.
   - The fake runner's record shows exactly the profile's arguments, an
     empty working directory, the input on standard input, and no
     environment name outside the allowed list. No name contains `KEY`,
     `TOKEN`, `BTRAIN`, or `SLACK`.
   - A runner string with `--dangerously-skip-permissions`, and a runner with
     an unknown basename, are not started, and `btrain doctor` reports each.
   - The input holds the operator's messages marked as the instruction and
     the lane snapshot. A message from another author in the thread is not
     in it.
   - A secret pattern in a lane's task or next action is not in the input.
   - A reply with a token pattern, a mention, and a link is posted redacted
     and escaped.
   - A run that exceeds `turnSeconds` is stopped, its process group is gone,
     and the timeout reply is posted.
   - A runner that exits non-zero with the usage pattern gets the
     out-of-usage reply. No other runner or service is started.
   - The thirty-first run in an hour is refused with a reason.
   - A second message in a thread waits for the first reply.
   - The listener completes a cycle while a run is in progress.
   - The profile check fails a first event that lists a tool, one that lists
     an MCP server, and one whose credential source is an API key. A failed
     check stops every run, and `btrain doctor` reports it.
   - With `runner` set to an empty string, a mention gets the one-line note
     and no process starts.
   - The token does not appear in the input, the fake runner's record, the
     state file, or any log line.

### WS5: typed commands

1. `commands.mjs`: the pre-checks, the argument lists, the child environment,
   `execFile` for short children, a detached start for loops, and the loop
   list.
2. `status`, `flush`, `poll-pr`, `retry-review`, and `pause` from a message
   the operator typed.
3. Results: a reply for every command the listener acts on, and the last 20
   for each repository.
4. `max_commands_per_hour` and `max_active`.
5. Tests:
   - Each verb starts the child in its template, with the repository as the
     working directory, through an injected `execFile`.
   - `retry-review` for a lane that is not `needs-review` is rejected.
     `poll-pr` for a lane in `needs-review` or `in-progress` is rejected, and
     for `changes-requested` with no PR number.
   - A composition test: `retry-review` against the real CLI in a temporary
     repository, with a fake reviewer runner, dispatches the reviewer once.
   - The child's environment has none of the seven removed names.
   - An operator's command `ts` runs once across a listener restart.
   - A crash after the `ts` is recorded and before the child starts does not
     run the command on restart.
   - The twenty-first command in an hour for one repository is refused with
     a reason.
   - Every accepted, rejected, and refused command gets exactly one result
     reply.
   - `pause` writes the flag and replies with the local resume command. A
     later typed command gets no reply until a local `--resume`.
   - A loop that ends is reported with its exit code. One that ended while
     the listener was down is reported with "exit code unknown".
   - The listener completes a cycle while a loop child is running.

### WS6: `start`, proposals, approval

1. `start`: the checks, the lane pick, the claim child, then the loop child.
   Reply once when the claim succeeds or fails, and once when the loop ends.
2. `--requested-via` on `btrain handoff claim`: one conditional line in each
   of the two `eventDetails` objects in `claimHandoff`, and one line in the
   help text. `test/cli-internal-options.test.mjs` requires that a handoff
   flag be documented there.
3. Proposals from a model's reply: post the canonical text in a code block,
   store it under the post's `ts`, cancel an earlier one in the thread.
4. `approve`, `reject`, and expiry. A proposal for a verb on the `auto` list
   runs at once. `retry_review_per_hour` applies to those.
5. Tests:
   - A reply with a `start` proposal is posted in canonical form and waits.
     After the operator's typed `approve` it runs, and the child's arguments
     come from the stored text.
   - A check-mark reaction approves nothing: the listener makes no reaction
     call at all. An `approve` with the operator's ID and an `app_id`
     approves nothing.
   - An `approve` that arrives after `approvalMinutes` runs nothing, and the
     thread gets the expiry reply once.
   - A second proposal in a thread cancels the first, and `approve` then
     runs the second.
   - A proposal for `retry-review` runs without approval. The fourth one for
     a lane in an hour is refused with a reason.
   - A proposal for `pause` is rejected.
   - `start` with a path that holds `..`, with an owner that is not
     configured, or with a task over the limit is rejected before any child
     starts.
   - `start` whose task holds `$(...)`, a backtick, `;`, and a quote reaches
     the claim as that literal text, shown by the lane's stored task in a
     composition test against the real CLI.
   - The claim event of a `start` records the Slack channel, the message
     `ts`, and whether a person or an orchestrator run wrote the command.
   - The fourth concurrent `start` in a repository is refused with a reason.
   - A claim that loses the lane to another process is reported as failed
     and starts no loop.
   - With no free lane, `start` is refused before any child starts.
   - `node scripts/decomposition_inventory.mjs --stages` exits 0 and the
     inventory test passes, with no change to the assignment JSON.

### WS7: install and pilot

1. `install.mjs` and `--install`. The plist sets `PATH` and `HOME` from the
   installing shell, because a launch agent starts with a short `PATH` and
   the runner would not be found.
2. The README section: the two toggles, the listening manifest, `whois`,
   `listen`, the verbs, and the warning that an approved `start` runs an
   agent in the repository's registered checkout.
3. Turn `slack_listen` on in the btrain repository only and use it for two
   weeks. Report:
   - Conversations a day, runs a day, and runs refused by a limit.
   - Time from a typed message to its reply, median and 95th percentile.
   - Proposals posted, approved, rejected, expired, and rejected as
     malformed.
   - Commands by verb, and how many were refused and why.
   - Read calls a minute at the busiest time, and any 429.
   - Any message acted on that the operator did not type.
4. Confirm or change the five values under the spec's "Defaults to confirm
   during implementation", and record the result in the spec.

The pilot passes when no action came from a message the operator did not
type, no command ran twice, no reply carried a secret or a mention, and the
operator judges the answers worth their usage.

### WS8: spec 023

After spec 023 is implemented:

1. `retry-review` is described and tested as starting a new review attempt.
2. The snapshot shows the display states `in-review` and `confirming-fix`.
3. A test runs the listener for several cycles against a lane with an active
   attempt and asserts that the attempt has no pickup time and no progress
   signal from the listener.
4. `fix` and `confirm-fix` are in the FR-4 list from WS1. This workstream
   adds a test against the real command names.

## Quality and formal gates

- `npm test` and `npm run test:formal` give the same results as `main` in
  every workstream. The formal harness is not touched.
- **Formal impact: none** for WS0 to WS5, WS7, and WS8. No status,
  transition, guard, lock rule, or actor changes.
  `python3 scripts/tla_pin.py --check` stays at 1 pin clean.
- **WS6 edits `claimHandoff`**, which the formal harness drives. The change
  adds a key to event details and no behavior. That lane classifies it as
  `validation`, runs the formal advisory command from the `pre-handoff`
  skill, and records the result.
- `node scripts/decomposition_inventory.mjs --stages` exits 0 without a
  change to `specs/020-ws2-module-assignment.json`, and
  `test/decomposition_inventory.test.mjs` passes. This is the gate for
  invariant 13 in WS6.
- `btrain review code` passes on each lane.
- No test calls Slack and no test starts a real model. The two live steps of
  WS0 are run by a person and leave only fixtures.
- WS1, WS4, WS5, and WS6 each get the `red-team` skill before review. They
  hold the rules that keep a message or a model from starting work.
- Each lane is reviewed by an agent from a different lab when one is
  available, as spec 023 intends.

## Risks and tradeoffs

| Risk | Design response |
| --- | --- |
| An agent on the machine posts as the operator | Only a message with no `app_id` and no `bot_id` is heard. `whois` shows the fields. The rule was checked live for one connector |
| An agent on the machine runs `btrain slack listen --resume` or `--stop` | A lane-pinned agent cannot: `slack` is not in its allowed commands. An unpinned local process can. The spec's boundary is Slack, not the machine |
| A started owner works in the registered checkout | `btrain loop` starts a runner in the repository path it was given. For the btrain repository that is the live checkout. The README says so, and a `worktree` option is a follow-up |
| A field value is read as a flag | A value that starts with `-` is rejected, and every value is one argument with no shell |
| A lane moves between the status check and the child | The window is one process start. The child's own guards still apply. `poll-pr` only writes what GitHub shows |
| A crash between recording a message and acting on it | That one action is lost and never repeated. The operator sends it again |
| A crash between a proposal's post and its record | The proposal is on screen and not pending. `approve` gets "nothing to approve" |
| The profile check cannot see the credential source | WS0 step 4 finds out before WS4 is built. The environment list still passes no API key, and `--restricted` ignores the settings files that could set one |
| A CLI update renames a profile flag | The check runs again for a new CLI version, and a failed check stops every run |
| `btrain doctor` starts a model run | Only when no verdict is saved for the current runner and CLI version, never in a lane-pinned session, and never with the toggle off |
| The read limit is cut to one call a minute | That applies to apps distributed outside Slack's Marketplace. The app stays an internal app of one workspace, and the README says why |
| Many open threads use up the read budget | Channel reads come first and thread reads take turns. Replies get slower, and nothing is dropped |
| A loop outlives the listener | It is detached on purpose, so a restart does not kill an owner's work. Its process ID is kept and it still counts against `max_active` |
| Slack turns a file name into a link | The grammar undoes link markup, and WS0 captures the real shape first |
| Polling adds up to 10 seconds to every reply | Accepted. A live connection is a follow-up and changes no rule here |
| Two developers share one bot user in one workspace | Each listener hears only its own operator, and the thread filter keeps only replies that carry its own label |
| The wiring lanes wait on other lanes' locks | WS1, WS3, WS4, and WS5 touch none of the held files |

## Spec amendments made with this plan

Spec 025 version 0.5.1 holds these. Each is the smallest change that makes
the spec match what can be built.

1. **FR-1:** `slack_listen` must be explicit-only, as spec 024 FR-1 is. A
   missing `[features]` table otherwise turns listening on in every legacy
   repository.
2. **FR-2:** the listener must also undo Slack's link markup and code fences,
   not only the three entities.
3. **FR-2:** a field value may not start with `-`.
4. **FR-7:** a canonical text that the URL rewrite would change is rejected
   too.
5. **FR-8:** name the flag that carries the request's origin into the claim
   event. The claim command has none today.
6. **FR-8:** say that the listener picks the lane and passes `--lane`, and
   say which checkout the owner's runner works in.
7. **FR-9:** say that the last 20 results are kept for each repository.
8. **FR-11:** the read budget needs a limit for each method across all
   channels. Slack counts by method and workspace, not by channel.
9. **FR-11:** say how `--stop`, `--resume`, and `pause` reach a running
   listener, and that cursors move to the current time on resume.
10. **FR-15:** the profile check's result is saved for a runner and CLI
    version. As written, every `btrain doctor` run starts a model run.
11. **FR-15:** the environment list is for macOS and Linux. Say that Windows
    has no profile in this version.
12. **FR-15:** a runner string may hold only the words its profile allows.

## What the spec 024 plan provides for this one

The spec 024 plan was amended in this lane to state each of these.

1. `slack/text.mjs` exports its steps one by one as well as the whole
   function: scrub, cut, escape, and the URL rewrite, each returning the text
   and whether it changed. The proposal check needs the first, second, and
   fourth alone.
2. `slack/client.mjs` exports its low-level call, with the error classes, and
   that call can send a GET request with query parameters.
   `conversations.replies` does not accept a JSON body.
3. `slack/lock.mjs` takes the lock's path as an argument, so the listener
   lease can use it.
4. `slack/deliver.mjs` takes a time budget from its caller, as its WS3 step
   already says, and can be called for a repository the caller names.
5. The `slack` block in `cli.mjs` hands `slack/cli.mjs` a single object of
   readers, so this plan can add to it without changing the call.
6. `test/helpers/fake-slack.mjs` keeps its scripted responses keyed by method
   name, so two more methods can be added.

## Follow-ups

- A `worktree` option for `start`, so the owner works outside the registered
  checkout.
- One shared helper for starting and stopping a runner in its own process
  group, for `core.mjs` and `slack/runner.mjs`.
- Profiles for other subscription CLIs.
- Slack's live connection in place of polling.
- The follow-ups the spec lists: read access for the model, adopting cloud
  work into a lane, and a daily summary.

## Context receipt

**Tier:** deep was attempted. `.claude/scripts/unblocked-context.sh research`
returned `{"sources": [], "_skipped": "unblocked returned empty output (exit
1)"}`, so no organizational context was available.
**Questions:** How can a Slack message start a btrain command without a new
path around btrain's guards? What does the subscription CLI need to run with
no tools? What do Slack's read calls return, and at what rate?
**Primary sources:** [Spec 025](025-slack-orchestrator.md),
[Spec 024](024-slack-lane-publisher.md) and
[its plan](024-slack-lane-publisher-implementation-plan.md),
[Spec 023](023-cross-lab-review-and-reviewer-fixes.md), current `core.mjs`,
`cli.mjs`, `pr-flow.mjs`, `repo_mode.mjs`, `transitions.mjs`, and
`internal_options.mjs`, `claude --help` for version 2.1.274, `btrain locks`
on 2026-11-23, Slack's documentation for `conversations.history` and
`conversations.replies`, and Slack's rate-limit notice of 2025-05-29.
**Constraints:** zero runtime dependencies, no usage-billed service, no new
function in `core.mjs`, no change to lane authority, and no model run in a
test.
**Gaps:** no organizational history. Not checked on a real run: that the
`claude` profile signs in with the subscription; the fields of the first
stream event; the text the CLI prints when usage runs out; and how a Slack
client encodes a typed file name. WS0 steps 3 and 4 close these before the
code that depends on them.
**Durable writeback:** this plan.
