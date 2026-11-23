# 023 — Cross-Lab Review and Reviewer Fixes Implementation Plan

**Status:** Draft
**Spec:** [023 — Cross-Lab Review by Default and Reviewer-Applied Fixes](023-cross-lab-review-and-reviewer-fixes.md)
**Date:** 2026-11-23

## Plan decision

Build the two rules in ten workstreams. Put the new logic in new modules under
`src/brain_train/review/` and reach it from `core.mjs`, `cli.mjs`, and
`pr-flow.mjs` through calls inside functions that already exist. Land the
parts that change no behavior first (labs, the review record, the display),
then the legacy-row enforcement the invariant depends on, then the request
loop, then the fix path. Each workstream is one lane and one PR, except the
two with semantic formal impact, which are two PRs each: prose and model
first, then code.

Seven constraints shape the design:

- **No new function in `core.mjs`.** `scripts/decomposition_inventory.mjs` and
  `specs/020-ws2-module-assignment.json` account for every function in that
  file, and the JSON is locked by another lane.
  `node scripts/decomposition_inventory.mjs --stages` exits non-zero when
  `core.mjs` holds a function the JSON does not assign.
- **`patchHandoff` and `runLoop` are each edited once.**
  `test/decomposition_inventory.test.mjs` pins `patchHandoff` at 585 lines and
  `runLoop` at 422. The test's own comment calls the two numbers anchors for
  the scanner, not a budget. `patchHandoff` builds the gate's input as a
  fixed object in two places, so a new guard fact cannot reach
  `btrain handoff update` without a line there. WS4 adds one spread line to
  each of the two objects, 585 becomes 587, and later facts ride on that
  spread with no further edit. `runLoop` gains a few lines in WS5. Each PR
  changes its pinned number and says so in its handoff.
- **Three functions that already exist in `core.mjs` become exports.**
  `appendWorkflowEvent`, `readWorkflowEvents`, and `updateHandoff` are
  private today. `specs/020-ws2-export-baseline.json` lists the 69 exported
  names and says to regenerate it only when a surface change is intended.
  This one is: WS2 exports the first two and WS7 the third. Each PR
  regenerates the baseline, changes the three count assertions in
  `test/decomposition_inventory.test.mjs` (69 to 71, then 72), and says so
  in its commit.
- **The review record is a fold over the lane's workflow event log.** No new
  state file. Attempts, pickup, fallback, fixes, and late reviews are events
  in `.btrain/events/lane-<id>.jsonl`, the log `appendWorkflowEvent` already
  writes and the local review gate of PR #112 already reads. The Slack
  publisher of spec 024 sees them through its existing hook on
  `appendWorkflowEvent`.
- **The lane's recorded reviewer is always the reviewer of the active
  attempt.** The request loop starts an attempt and sets the reviewer in one
  write. A reviewer change by a lane agent ends the open attempt. The
  transition gate, the pre-commit hook, and the guidance text then keep
  reading one field, and need no attempt lookup to know who may act.
- **Every review event is written under the lane's handoff lock.** That is
  the lock `updateHandoff` already takes, and `withFileLock` is exported. A
  verdict command reads the review record again inside that lock, after the
  point where `resolveHandoff` and `requestChangesHandoff` already read the
  lane again, and applies only when the attempt it was computed for is still
  the active one. An attempt cannot end, or a new one start, between that
  check and the write.
- **Prose, then model, then code** for every semantic change (spec 015
  FR-10). The lanes that add `fix-confirmation` and the system reassignment
  edit pinned prose, re-pin, change `LaneLock.tla` and its mirror, run TLC,
  and only then change the gate.

Three open pull requests hold files this plan needs and one is assumed by the
spec:

| PR | Lane | What it gives this plan | Files it holds |
| --- | --- | --- | --- |
| #108 (draft) | g | The `enforced` field on a legacy row and `TransitionRejection`, which retire a row or one slice of it | `transitions.mjs`, `test/formal/*`, `test/transitions.test.mjs`, spec 015 |
| #112 | a | `local_review.mjs`: an approval bound to a head and a base through `Reviewed-Head` and `Reviewed-Base` trailers, read from the event log. Spec 023 assumes this gate | `pr-flow.mjs`, `repo_mode.mjs`, spec 002, `CLAUDE.md`, `AGENTS.md` |
| #113 | h | The Cursor Agent runner, the first runner in this repository that can run a model from a third lab | `core.mjs`, `README.md`, `test/core.test.mjs`, `test/reviewer-dispatch.test.mjs` |

`cli.mjs` and `specs/020-ws2-module-assignment.json` are held by lane c
(PR #110). Run `btrain locks` from a session that is not lane-scoped before
claiming each workstream.

The repo has numbered flat specs and no `.specify/` script or template
directory. This plan uses that established format and records the design, data
model, contracts, and quality gates here.

This lane also amends spec 023 where writing the plan showed a gap: the
reason recorded when the loop moves to the next other-lab reviewer (FR-7),
what happens when a PR is linked and row 20 refuses a reassignment (FR-7),
where quota and authentication signals are defined (FR-4), which progress
signals survive the dispatching process (FR-4), and `fix-confirmation` as a
target of legacy row L4 (the declaration table).

## Current integration points

| Surface | Existing state | Planned change |
| --- | --- | --- |
| `inferPeerReviewer` in `core.mjs` | Returns the first candidate that is not the owner: the named reviewer, the current reviewer, then configured agents in order. Three callers: `claimHandoff` and two in `patchHandoff` | Unchanged. `claimHandoff` passes it the configured agents already ordered by tier |
| `claimHandoff` in `core.mjs` | Sets a missing reviewer to `any-other`, calls `applyTransition` for row 1, and only then calls `inferPeerReviewer` with `configuredAgents`. Row 1 guard is "files; conflicts; distinct reviewer" | Resolve the reviewer before the gate call, from candidates ordered by `review/labs.mjs`. Reject an explicit same-lab reviewer (FR-3) unless a `same-lab-review` override is consumed. Pass `reviewerLabAllowed` to the gate |
| `patchHandoff` in `core.mjs` | Builds the gate input as a fixed object at its two `applyTransition` calls, one for a lane and one for a repository without lanes. Pinned at 585 lines. Skips `validateNeedsReviewTransition` when an override ID is given | One spread line in each object, for the gate facts that `resolveReassignInputs` returns |
| `resolveReassignInputs` in `core.mjs` | Called from both `patchHandoff` paths. Computes `ownerChanged`, `reviewerIsPriorAuthor`, `distinctReviewer` and the responsible actor for row 20 | Add the FR-3 check for `--reviewer`. Return a `gateFacts` object: `reviewerLabAllowed` in WS4, `commitAfterFixHead` in WS7 |
| `applyWatchdogRepairs` in `core.mjs` | The pattern for a system event: `applyTransition` with the system actor, then `updateHandoff` with `eventType` and `eventDetails`. It does not check which row matched | Unchanged. The system reassignment of FR-7 copies this pattern and adds the check: it writes only when the matched row is 20. Without it a refused row 20 falls to legacy row L10, which accepts any actor |
| `actorMatches` in `transitions.mjs` | `reassign authority` accepts the owner for an owner change and either lane agent for a reviewer change | Also accept `input.systemEvent === true` when `ownerChanged` is not true |
| `dispatchNeedsReviewReviewer` in `core.mjs` | Reads the lane's reviewer and runs `runLoop` for one round with a 10-minute default (`DEFAULT_LOOP_TIMEOUT_MS`). Skips a `notify` runner | Call `runReviewRequest` from `review/request.mjs` with the functions it needs passed in |
| `finishPatchWithReviewerDispatch` in `core.mjs` | Throws when dispatch failed or timed out. The lane stays `needs-review` | Map the request outcome: verdict, same-lab dispatch, or no reviewer at any tier |
| `executeLoopCliRunnerWithStreaming` in `core.mjs` | Spawns the runner in its own process group with one timeout. The stream observer calls `onEvent` for output | Take an optional `AbortSignal` that stops the process group the way the timeout does |
| `buildLoopRunnerEnv` in `core.mjs` | Copies `process.env` and sets `BTRAIN_AGENT`, `BRAIN_TRAIN_AGENT`, `BTRAIN_LOOP_ACTIVE`, and the lane variables | Take an optional allowlist, used for a same-lab reviewer (FR-8) |
| `normalizeLoopCliRunner` in `core.mjs` | Normalizes Claude and Codex runner arguments | For a same-lab attempt, add the fresh-session flags and reject the resume flags from `review/runner-table.mjs` |
| `runLoop` in `core.mjs` | Each round dispatches `getLoopActorForState(current)`. Pinned at 422 lines | A `needs-review` round asks the request loop for one attempt instead of dispatching the recorded reviewer directly. One round is still one dispatch |
| `getLoopActorForState` in `core.mjs` | Hand-written map from status to owner, reviewer, or repair owner | Add `fix-confirmation`, which routes to the owner |
| `requestChangesHandoff` and `resolveHandoff` in `core.mjs` | Check the actor against the recorded reviewer. L8 and L15 accept another actor with an advisory | Pass `attemptMatches` to the gate. Hand a verdict from an ended attempt to `review/late.mjs`. Reject a resolve over the reviewer's own unconfirmed fix commits |
| `checkHandoff` in `core.mjs` | Returns guidance and `agentCheck`. Called by `btrain handoff`, PR flow, review context, and the startup snapshot | Unchanged. The `btrain handoff` command in `cli.mjs` passes the returned `agentCheck` to `review/activity.mjs` |
| `buildLaneGuidance` in `core.mjs` | One guidance block per stored status | Guidance for `fix-confirmation`; the display states and the review tier line |
| `renderPreCommitHook` in `core.mjs` | During `needs-review`, blocks a commit to the lane's locked files unless `BTRAIN_AGENT` is the recorded reviewer | During `fix-confirmation`, block unless it is the owner |
| `managedHookSpecs` in `core.mjs` | Two managed hooks: `pre-commit` and `pre-push` | A third, `commit-msg`, rendered by `review/commit-trailer-hook.mjs` |
| `VALID_OVERRIDE_ACTIONS` and `grantOverride` in `core.mjs` | Four actions. `needs-review` requires `--lane`; `push` refuses it | Add `same-lab-review`, which requires `--lane` |
| `VALID_HANDOFF_STATUSES`, `ACTIVE_LANE_STATUSES` in `core.mjs`; `ACTIVE_STATUSES` in `transitions.mjs` | Seven active statuses | Add `fix-confirmation`. Rows 13 and L3 use `ACTIVE_STATUSES` as their source list and must exclude it |
| `TRANSITION_ROWS` in `transitions.mjs` | Twenty designated rows and sixteen legacy rows, all legacy rows advisory on `main` | Three new rows; rows 3, 4, 5 gain the attempt guard; row 20 gains the system case; L8, L9, and L15 retired; L4 narrowed |
| `getPrFlowConfig` in `core.mjs` | Loads `[pr_flow.bots.<id>]` for the ids in `required_bots` only | Load every configured bot, with `lab`; read `bot_pending_timeout` |
| `classifyPrReviewState` in `pr-flow.mjs` | `ready-to-merge` when every required bot is clear on the head | Also require one outside-lab bot to be clear, when one is configured |
| `buildPrBody` in `pr-flow.mjs` | Lane, owner, reviewer, objective | Add the review tier, the fallback reason, and a fix line |
| `runPrCreate` in `pr-flow.mjs` | Validates the transition, pushes, and opens the PR | Refuse while a late request for changes is unacknowledged |
| `doctorRepo` in `core.mjs` | Collects `issues` and `warnings` per repository | Append the findings returned by `review/doctor.mjs` |
| `getStatus` in `core.mjs`; `scripts/serve-dashboard.js` | `dashboard.mjs` only starts and stops the dashboard process. The page is drawn by `scripts/serve-dashboard.js` from the JSON of `btrain status` | `getStatus` adds the display state, the tier, and the fallback reason to each lane. The page shows them |
| Handoff routing in `cli.mjs` | `claim`, `update`, `resolve`, `request-changes`, `wait`, `show-next`, `pull-pr` | Add `fix` and `confirm-fix`; route `update --ack-late-review` |
| `INTERNAL_ONLY_OPTIONS` in `internal_options.mjs` | Four options the CLI refuses, `transitionEvent` among them. PR flow passes `transitionEvent` to `patchHandoff` and `viaPrOutcome` to `resolveHandoff`. `resolveHandoff` does not read `transitionEvent` today | No new option. WS7 makes `resolveHandoff` read `transitionEvent` for its terminal transition, and `confirmFixHandoff` passes it |
| The export list of `core.mjs` | 69 names, checked against `specs/020-ws2-export-baseline.json`. `test/decomposition_inventory.test.mjs` asserts the count 69 in three places | Add `appendWorkflowEvent`, `readWorkflowEvents`, and `updateHandoff`, and change the three assertions |
| `appendWorkflowEvent` and `readWorkflowEvents` in `core.mjs` | The append is one `fs.appendFile` with no lock. The read drops a line that does not parse | Unchanged. Review events are appended only while the lane's handoff lock is held |
| Command entry in `cli.mjs` | Resolves the repository and the lane before each command | One call to `review/activity.mjs` for a lane-scoped command |
| `specs/tla/LaneLock.tla`, `test/formal/lane-lock-model.mjs` | 14 variables, 16 invariants, 5 properties. `Authors(l)` is the owner and one prior owner; `ASSUME Cardinality(Agents) <= 3` | The changes the spec's Formal-Impact Declaration lists |

## Architecture and invariants

### Modules

All under `src/brain_train/review/`.

| Module | Responsibility | Pure | Imports `core.mjs` |
| --- | --- | --- | --- |
| `labs.mjs` | Lab of an agent; author labs of a lane; tier of a candidate; candidates in order | Yes | No |
| `review-config.mjs` | `[review]` and `[review.fixes]` with defaults; duration parsing | Yes | No |
| `runner-table.mjs` | For each runner executable: presence probe, quota and authentication patterns, refusal patterns, fresh-session flags, flags to reject | Yes | No |
| `record.mjs` | Fold a lane's events since its claim into the review record | Yes | No |
| `activity.mjs` | Record a pickup or a progress signal for the reviewer of the open attempt; open an attempt for a recorded reviewer that was not dispatched | No | No |
| `request-lock.mjs` | One heartbeat lock per lane request | No | No |
| `request.mjs` | The attempt loop | No | No. `core.mjs` passes in what it needs |
| `late.mjs` | Classify a verdict from an ended attempt; the acknowledgement | No | No |
| `fix-rules.mjs` | The FR-11 checks over git facts given as arguments | Yes | No |
| `fixes.mjs` | `fixHandoff`, `confirmFixHandoff` | No | Yes, as `pr-flow.mjs` does |
| `commit-trailer-hook.mjs` | Text of the managed `commit-msg` hook | Yes | No |
| `doctor.mjs` | Findings for `btrain doctor` | Yes | No |

`core.mjs` imports `labs.mjs`, `review-config.mjs`, `runner-table.mjs`,
`record.mjs`, `request.mjs`, `late.mjs`, `commit-trailer-hook.mjs`, and
`doctor.mjs`. None of those imports `core.mjs`, so the import adds no cycle.
`fixes.mjs` imports `core.mjs` and is imported only by `cli.mjs`.
`activity.mjs` is called by `cli.mjs`, which passes it the exported core
functions it needs.

`runReviewRequest` receives `readEvents`, `writeEvent`, `readLane`,
`startAttempt`, `runAttempt`, `now`, and `sleep`. Tests replace all seven.
`writeEvent` and `startAttempt` go through `updateHandoff`, so each write is
under the lane's handoff lock. `runAttempt` starts the runner and returns at
once with a handle: a promise for its exit, its output tail, and the time of
its last output. The loop keeps polling while the runner is alive.

### Invariants

Each one is a test. WS0 adds them skipped, and the workstream that makes one
pass removes its skip.

1. While an other-lab agent with a `cli` runner is configured, a same-lab
   reviewer is assigned only by a consumed override, or when the window has
   passed, every other-lab reviewer has had an attempt or failed its probe,
   and none has shown progress within `silence_limit`.
2. Elapsed wall time alone never assigns a same-lab reviewer. With no btrain
   process running, the lane does not change.
3. A verdict changes the lane only when it comes from the reviewer of the
   active attempt and the lane's head is that attempt's head.
4. While a lane is `needs-review` with an open request, its recorded reviewer
   is the reviewer of the active attempt.
5. The stored status is never `in-review` or `confirming-fix`.
6. A lane enters `ready-for-pr` only by row 4 or by `ConfirmFix`. No
   `handoff update --status` enters a PR-flow status or `fix-confirmation`,
   and none leaves `fix-confirmation` except the owner's hand-off to
   `needs-review`.
7. The agent that confirms a fix is not in the lane's `fixAuthors`.
8. A system reassignment changes the reviewer only, and the canonical actor
   after it is a lane agent.
9. An attempt that ends without a verdict leaves the status `needs-review`.
   A runner failure is never an approval.
10. A same-lab review always has a recorded reason and the attempts that led
    to it, and `btrain handoff`, `btrain status`, and the PR body show the
    tier.
11. `handoff fix` is refused, with its own message, for each FR-11 condition
    that fails.
12. `core.mjs` gains no function. The `patchHandoff` pin changes once, in
    WS4, and the `runLoop` pin once, in WS5.
13. A verdict with no open attempt is refused. A recorded reviewer that was
    not dispatched gets an attempt at its pickup, at the request's head.

### Data model

**Review events.** New event types in the lane's workflow event log. Each has
`laneId`, `type`, `actor`, `recordedAt`, and a `details` object.

| Type | Written when | `details` |
| --- | --- | --- |
| `review-request` | The lane enters `needs-review`, or the owner moves the lane's branch while it is there | `requestId`, `branch`, `head`, `requestedAt`, `otherLab` and `sameLab` candidate lists |
| `review-attempt` | Before each dispatch, and at the pickup of a recorded reviewer that was not dispatched. Written by `updateHandoff` in the same write that sets the lane's reviewer | `attemptId`, `requestId`, `reviewer`, `previousReviewer`, `reason`, `tier`, `head`, `startedAt`, `opened` (`dispatch` or `pickup`) |
| `review-pickup` | The attempt's reviewer first runs `btrain handoff` for the lane | `attemptId`, `at` |
| `review-progress` | Any other lane-scoped btrain command by the attempt's reviewer, at most once a minute | `attemptId`, `at` |
| `review-attempt-ended` | The attempt stops without a verdict | `attemptId`, `outcome`, `detail` |
| `review-escalation` | No reviewer at any tier, a second same-lab request for changes, or a linked PR that blocks reassignment | `requestId`, `reason` |
| `late-review` | A verdict arrives from an ended attempt and is not applied | `attemptId`, `verdict`, `head`, `summary` |
| `late-review-ack` | The owner acknowledges it | `attemptId` |
| `fix-applied` | `handoff fix` | `attemptId`, `fixBase`, `fixHead`, `commits`, `round`, `files`, `changedLines` |
| `fix-confirmed` | `handoff confirm-fix`, or the owner's hand-off from `fix-confirmation` | `how` (`confirm-fix` or `amend`), `fixHead`, `confirmedCommits` |

`outcome` is one of `tool_unavailable`, `policy_blocked`, `unresponsive`,
`failed`, `stopped-at-max`, or `superseded`. A fallback is not its own event
type. It is a `review-attempt` whose `reviewer` differs from
`previousReviewer`: the row 20 reassignment and the new attempt are one
write. Its `reason` is one of the four FR-7 reasons, and the fold supplies
the attempts that led to it. A `review-attempt` that keeps the reviewer has
an empty `reason`.

An `update` event by a lane agent that changes the reviewer during an open
request ends the open attempt as `superseded` in the fold.

The existing `resolve` and `request-changes` events gain `attemptId` and
`tier` in their details.

**Review record.** `record.mjs` folds the events since the lane's last `claim`
into:

```json
{"request": {"id": "...", "head": "<sha>", "requestedAt": "<ISO>"},
 "attempts": [{"id": "...", "reviewer": "codex-reviewer", "tier": "other-lab",
               "head": "<sha>", "startedAt": "<ISO>", "pickedUpAt": null,
               "lastProgressAt": null, "outcome": null}],
 "activeAttemptId": "...", "tier": "other-lab", "fallbackReason": "",
 "sameLabChangeRequests": 0,
 "fix": {"base": "<sha>", "head": "<sha>", "round": 1, "confirmed": false},
 "fixAuthors": ["codex-reviewer"], "fixRounds": 1,
 "lateReviews": [{"attemptId": "...", "verdict": "request-changes", "acknowledged": false}],
 "display": "in-review"}
```

`display` is `in-review` from pickup to the verdict or the attempt's end,
`confirming-fix` after the owner picks up a `fix-confirmation` lane, and
empty otherwise.

**Request lock.** `<state root>/.btrain/reviews/lane-<id>.lock`: an exclusive
create, a random nonce, and a 60-second liveness rule. It is the design of
the spec 024 delivery lock, with the same bounds: a process that finds a
lock under 60 seconds old does not dispatch; one that finds an older lock
removes it and creates its own; and the holder reads the nonce again before
every dispatch and stops if it is not its own. The holder touches the lock
on a 15-second timer for the whole life of the loop, also while a runner is
alive, so a long attempt never looks abandoned. It makes one process the
dispatcher of a request. It is not lane state: removing it loses nothing.
The handoff lock, not this one, is what orders attempts against verdicts.

**Head.** `review-request` records the branch the owner's checkout was on,
as a full ref, and its commit as a full object ID. Later checks resolve that
ref, which every checkout of the repository shares, so a reviewer that runs
a verdict from another worktree sees the same head. With a detached
checkout, `branch` is empty and the head is `HEAD` of the checkout the
command runs in. PR #112 binds an approval to a full object ID through the
`Reviewed-Head` trailer. The attempt's `head` uses the same full ID, and the
verdict check requires the trailer, the attempt's head, and the branch's
current commit to agree.

### Review request loop

`runReviewRequest` is one function with injected time. Each pass reads the
record and applies these rules in order.

1. **Verdict.** If the lane is no longer `needs-review`, stop and return the
   new state.
2. **New head.** If the owner has moved the head, write a new
   `review-request`, end the open attempt as `superseded`, and start again.
   A commit by the active attempt's reviewer is not a new head (FR-4).
3. **Open attempt.** Watch it. Stream output reported by the runner handle,
   the pickup, and a `review-progress` event each reset the silence clock. End
   the attempt as `unresponsive` when it has no pickup within
   `silence_limit` of its start, or no signal for `silence_limit` after
   pickup. End it as `stopped-at-max` at `attempt_max`. Ending an attempt
   aborts its runner through the `AbortSignal`.
4. **Runner exit.** Classify the exit with `runner-table.mjs`: a quota or
   authentication pattern is `tool_unavailable`, a refusal pattern is
   `policy_blocked`, any other non-zero exit is `failed`.
5. **Next other-lab reviewer.** If an other-lab candidate has had no attempt
   in this request, or the last pass over the list ended at least
   `silence_limit` ago, probe it and call `startAttempt`: one write that
   sets the lane's reviewer and records `review-attempt` (reason
   `next-other-lab` when the reviewer changes, or `other-lab-recovered` when
   the lane was on a same-lab reviewer). Then dispatch. The lane's current
   reviewer goes first when it is an other-lab candidate.
6. **Fallback.** If the window has passed, every other-lab candidate has had
   an attempt or failed its probe, and none has shown progress within
   `silence_limit`: unless the lane already has two same-lab requests for
   changes since its claim, start an attempt for the first same-lab
   candidate outside the author history (reason `other-lab-unavailable`),
   and dispatch it with the fresh-session flags and the environment
   allowlist.
7. **No candidate.** With no reviewer at any tier, or with two same-lab
   requests for changes already on the lane, write `review-escalation` and
   return. The lane stays `needs-review`. No third same-lab round starts.
8. **Wait.** Sleep for the poll interval and repeat.

`startAttempt` copies `applyWatchdogRepairs`: `applyTransition` for row 20
with actor `btrain-system`, `systemEvent`, the author-history and
distinct-reviewer facts, and the PR link, then `updateHandoff`. It writes
only when the matched row is 20. Any other match, which today would be
legacy row L10, is a refusal: the loop writes `review-escalation` and
returns. It passes the reviewer and nothing else, so it cannot change the
owner.

The loop has two callers. `dispatchNeedsReviewReviewer` runs it until a
verdict, an escalation, or the end of a same-lab dispatch: that is the
foreground window of FR-4. `runLoop` asks it for one attempt and returns
when that attempt ends, so `btrain loop --lane <id> --max-rounds 1` is still
one dispatch, which spec 025's `retry-review` relies on. The one attempt is
the one the rules above choose, so it can be a same-lab attempt when rule 6
holds.

Three cases shorten the loop:

- **No other-lab agent configured.** Rule 6 applies at once with reason
  `no-other-lab-configured`.
- **A PR is linked.** Row 20 refuses a reassignment. The loop dispatches only
  the recorded reviewer, retries it at each `silence_limit`, and writes
  `review-escalation` with reason `pr-linked` when the window ends.
- **A `notify` runner.** It is never dispatched and never a candidate for a
  tier, as today.

**A reviewer that was not dispatched.** A session started by hand, and a
`notify` reviewer, get their attempt from `activity.mjs`: when the lane's
recorded reviewer runs `btrain handoff` for a `needs-review` lane with no
open attempt, it writes `review-attempt` with `opened: pickup` at the
request's head, then the pickup. The loop, if one is running, then finds an
open attempt and watches it. With dispatch off, this is the only way an
attempt starts, and a verdict with no open attempt is refused with the
command to run first.

**A request whose process ended.** A later `btrain loop --lane <id>` or
`handoff update` takes the request lock and continues. Stream output from the
old process is gone, so for an open attempt the later process counts only the
persisted signals: pickup and `review-progress`. An open attempt with no
persisted signal within `silence_limit` is ended as `unresponsive` with
detail `dispatcher-lost`.

### Runner table

One entry for each executable basename that runs one lab's models.

| Executable | Lab | Presence probe | Fresh-session flags | Rejected flags |
| --- | --- | --- | --- | --- |
| `claude` | `anthropic` | `claude --version` | `--no-session-persistence` in print mode | `--resume`, `-r`, `--continue`, `-c`, `--fork-session`, `--from-pr` |
| `codex` | `openai` | `codex --version` | `exec --ephemeral` | `resume` and `fork` subcommands, any `--session*` flag |
| `gemini` | `google` | `gemini --version` | a fresh `--session-id` for each dispatch | `-r`, `--resume` |

The fresh-session columns are spec 017 FR-3, which spec 023 FR-8 adopts.
`agent` and `cursor-agent` have no entry for a lab and none for a fresh
session: they get a lab only from `[agents.labs]`, and they are not
dispatched at the same-lab tier until the table names their flags.
`btrain doctor` reports that gap.

Quota, authentication, and refusal patterns are matched against the runner's
exit code and the last lines of its output. The table ships patterns observed
in this repository, and `[review.signals.<executable>]` can add more:

| Executable | Observed text | Class |
| --- | --- | --- |
| `codex` | "You've hit your usage limit" | `tool_unavailable` |
| `codex` | `model_not_found` | `tool_unavailable` |
| `agent` | "is not included in your weekly usage" | `tool_unavailable` |

WS1 confirms each pattern against a captured sample before it ships and adds
the Claude ones the same way. No sample, no pattern.

### Transition changes

| Row | Change |
| --- | --- |
| `ReviewerFix` (new) | Event `handoff fix`, `needs-review` to `fix-confirmation`, actor `reviewer`, guard `fixAllowed` and `attemptMatches`, locks retained |
| `ConfirmFix` (new) | Event `handoff confirm-fix`, `fix-confirmation` to `ready-for-pr` or `resolved`, actor `owner`, guard `fixHeadMatches`, `reviewerApprovalRecorded`, `actorNotFixAuthor`, `laneCovered`. It is the primary row of `fix-confirmation` in `PRIMARY_STATUSES_BY_ACTION` |
| `AmendFix` (new) | Event `handoff update --status`, `fix-confirmation` to `needs-review`, actor `owner`, guard `reviewContextComplete`, `diffPresent`, and `commitAfterFixHead` |
| 1 | Guard gains `reviewerLabAllowed` |
| 3, 4, 5 | Guard gains `attemptMatches` |
| 13 | Source list excludes `fix-confirmation` |
| 20 | Actor accepts `systemEvent` when the owner does not change; guard gains `reviewerLabAllowed` |
| L3 | Source list excludes `fix-confirmation` |
| L4 | Retired for the targets `ready-for-pr`, `pr-review`, `ready-to-merge`, and `fix-confirmation`, and for the source `fix-confirmation` |
| L8, L9, L15 | Retired whole |

A fact on a new row is required: `ReviewerFix`, `ConfirmFix`, and `AmendFix`
match only when each of their facts is passed and true. A fact added to an
existing row (`reviewerLabAllowed`, `attemptMatches`) follows the gate's
rule for optional facts, because the formal harness and older callers reach
those rows without it: a caller that does not pass it is not refused for
it. The production callers always pass it. `claimHandoff` and
`resolveReassignInputs` also refuse a same-lab reviewer directly, before
the gate. `fixes.mjs` checks `ReviewerFix` and `ConfirmFix` with
`applyTransition` itself before it writes, the way
`validatePrCreateTransition` does in `pr-flow.mjs`.

`AmendFix` is reached through `patchHandoff`, so `commitAfterFixHead` comes
from the `gateFacts` spread. `validateNeedsReviewTransition` is not the
place for it: `patchHandoff` skips that function when an override ID is
given.

L9 accepts the reviewer's approval of a lane whose lock coverage is
suspended, with an advisory, after row 4 has refused it. With L9 retired
that approval is refused until the owner restores coverage (row 17), which
is what `ConfirmFix` already requires.

PR #108 retires a legacy row by source status. L4 needs retirement by target
as well. WS3 extends the `enforced` field to hold source and target slices.

Each retirement follows spec 015 FR-5: at least 14 days in advisory, which
L3, L4, L8, L9, and L15 have had since spec 016 WS3 and WS4 merged, and no
`transition-advisory` event for the row in the last 7 days across the
registered repositories. WS3 runs that audit and records it in the ledger in
`test/formal/README.md`.

### CLI contract

| Command | Effect | Exit code |
| --- | --- | --- |
| `btrain handoff fix --lane <id> --summary <text> --actor <reviewer>` | Checks FR-11, records `fix-applied`, moves the lane to `fix-confirmation`, dispatches the owner | 0, or 1 with the failed condition named |
| `btrain handoff confirm-fix --lane <id> --summary <text> --actor <owner>` | Records `fix-confirmed`, moves the lane to `ready-for-pr` or `resolved` | 0, or 1 |
| `btrain handoff update --lane <id> --status needs-review --actor <owner>` from `fix-confirmation` | Records `fix-confirmed` with `how: amend`, starts a new request | 0, or 1 |
| `btrain handoff update --lane <id> --ack-late-review` | Records `late-review-ack` for every unacknowledged late review on the lane. Owner only. Not combined with another change | 0, or 1 |
| `btrain override grant --action same-lab-review --lane <id> ...` | A human-confirmed override that one claim or reassignment consumes | 0, or 1 |
| `btrain handoff`, `btrain status` | Show the display state, the reviewer, the time since dispatch or pickup, the tier, and the fallback reason | unchanged |
| `btrain doctor` | Lists each agent's lab; warns for an agent with none, for no other-lab agent, for no outside-lab bot or only one, for an unacknowledged late review, and for a runner with no fresh-session entry | unchanged |
| `btrain loop --lane <id>` | Continues an open review request or a pending fix confirmation before its normal rounds | unchanged |

### Configuration

As the spec's Configuration section gives it, plus the optional
`[review.signals.<executable>]` table. Defaults apply when a key is missing:
`other_lab_window` 15 minutes, `silence_limit` 5 minutes, `attempt_max` 45
minutes, `reviewer_order` empty, fixes enabled with 3 files, 60 changed
lines, and 2 rounds, and `bot_pending_timeout` 30 minutes. A repository with
no `[agents.labs]` table still gets labs for `claude`, `codex`, and `gemini`
runners from the runner table.

## Workstreams and order

| WS | First artifact | Files other lanes held on 2026-11-23 | Depends on | Formal impact | Done when |
| --- | --- | --- | --- | --- | --- |
| 0 Harness and invariants | A fake runner, a fake clock, and the thirteen invariant tests, skipped | None | — | none | The fake runner can pick up, print, go silent, exit with any text, and commit; `npm test` matches `main` |
| 1 Labs, config, runner table | `labs.mjs`, `review-config.mjs`, `runner-table.mjs`, `doctor.mjs` | `core.mjs` (lane h) for the doctor call | WS0 | none | `btrain doctor` lists every agent's lab; no lane behaves differently |
| 2 Review record and display | `record.mjs`, `activity.mjs`; pickup and progress; the display states in `handoff`, `status`, and the dashboard | `core.mjs` (h), `cli.mjs` (c) | WS0, and WS1 for `core.mjs` | none | A dispatched reviewer's first `btrain handoff` shows the lane as `in-review` |
| 3 Legacy-row enforcement | Row 4 enforced; L8, L9, and L15 retired; L4 narrowed | `transitions.mjs`, `test/formal/*`, spec 015 (g) | PR #108 | semantic | `handoff update --status ready-for-pr` is refused for every actor |
| 4 Reviewer choice | Other-lab reviewer at claim; FR-3 rejection; the `same-lab-review` override; the gate-facts spread in `patchHandoff` | `core.mjs` (h) | WS1, WS2 | validation | The first Rule 1 acceptance criteria pass |
| 5 Request loop | `request.mjs`, `request-lock.mjs`; attempts, failure classes, fallback; verdicts bound to attempts; the system reassignment | `core.mjs` (h and d), `transitions.mjs` and `test/formal/*` (g), spec 005 | WS2, WS3, WS4, and the `withFileLock` fix of lane d | semantic | A silent other-lab reviewer is replaced, and a same-lab reviewer is assigned only under invariant 1 |
| 6 Late verdicts | `late.mjs`; the `pr create` block; `--ack-late-review` | `pr-flow.mjs` (a), `cli.mjs` (c) | WS5, PR #112 | validation | A late request for changes blocks `btrain pr create` until acknowledged |
| 7 Reviewer fixes | `fix-confirmation`, three rows, `fix-rules.mjs`, `fixes.mjs`, the hooks, the trailer | `core.mjs` (h), `cli.mjs` (c), `transitions.mjs` and `test/formal/*` (g), specs 002 and 005 | WS3, WS5 | semantic | Every Rule 2 acceptance criterion passes and TLC passes with `FixSeparation` |
| 8 PR bot gate | Bot `lab`; the outside-lab requirement; the second bot after `bot_pending_timeout` | `pr-flow.mjs` (a), `core.mjs` (h) | WS1, WS6 for `pr-flow.mjs`, PR #112 | validation | A `codex` lane does not reach `ready-to-merge` on `gh-codex` alone when another lab's bot is configured |
| 9 Visibility, docs, rollout | Tier in PR bodies; the managed block text; this repository's `[agents.labs]` | `CLAUDE.md`, `AGENTS.md` (a), `README.md` (h) | WS5, WS7 | none | Every consuming repository gets the new Handoff Gate text on `btrain sync-templates` |

WS0, and the pure modules of WS1 and WS2, can start today. Everything that
edits `core.mjs` waits for PR #113. WS3 waits for PR #108. WS6 and WS8 wait
for PR #112.

Two lanes never hold one file at once. WS1, WS2, WS4, WS5, WS7, and WS8 all
edit `core.mjs`, and WS6 and WS8 both edit `pr-flow.mjs`, so those edits land
one workstream at a time in the order of the table. WS8's `core.mjs` edit is
in `getPrFlowConfig` only, and it can go in after WS4 if WS5 and WS7 are not
open.

### WS0: harness and invariants

1. `test/helpers/fake-runner.mjs`: an executable a test names in
   `[agents.runners]`. A scenario file tells it to run `btrain handoff`,
   print lines at given times, stay silent, exit with a code and text,
   commit a file with or without the trailer, and run a verdict or
   `handoff fix`.
2. `test/helpers/fake-clock.mjs`: `now` and `sleep` for `runReviewRequest`,
   so a 15-minute window runs in milliseconds.
3. One test for each invariant, written against the planned interfaces and
   marked skipped with the workstream that will enable it. `npm test` stays
   the same as `main`.
4. Every test that creates a repository sets `BRAIN_TRAIN_HOME` to a
   temporary directory.

### WS1: labs, config, runner table

1. `labs.mjs`: `resolveAgentLab(config, agent)` in the FR-1 order: an
   `[agents.labs]` entry, else the runner table's lab for the executable
   basename, else none. A wrapper, a multi-model harness, and a `notify`
   runner yield none. The agent name is never read.
2. `labs.mjs`: `authorLabs(authors, config)`, `tierOf(candidate, ...)`, and
   `orderCandidates(config, { owner, authorHistory })`, which returns the
   other-lab list in `reviewer_order` then configured order, and the
   same-lab list of agents outside the author history. Both lists hold only
   agents with a `cli` runner.
3. `review-config.mjs`: the keys and defaults of the Configuration section.
   A duration that does not parse is a `btrain doctor` error and the default
   applies.
4. `runner-table.mjs`: the table above, and
   `classifyExit({ executable, exitCode, tail, extraSignals })`.
5. `doctor.mjs` and one call in `doctorRepo`: the resolved lab of every
   agent, a warning for each agent with none, and a warning when no
   other-lab agent with a `cli` runner exists for some configured owner.
6. Tests:
   - Each FR-1 source of a lab, and each runner shape that yields none.
   - `agent -p` with no `[agents.labs]` entry is never in the other-lab list,
     and `btrain doctor` names it.
   - An agent named `claude-gpt` with a `codex` runner is `openai`.
   - `reviewer_order` is honored, and an unknown name in it is a doctor
     warning.
   - `reviewer_default` is used only when it is other-lab for the owner.
   - Each shipped signal pattern against its captured sample, and an exit
     with no pattern is `failed`.
   - A missing lab is a warning and `btrain doctor` still exits 0 for it.

### WS2: review record and display

1. `record.mjs`: the fold described in the data model. It reads only events
   after the lane's last `claim`.
2. Export `appendWorkflowEvent` and `readWorkflowEvents` from `core.mjs`,
   regenerate the export baseline, and change the three count assertions in
   `test/decomposition_inventory.test.mjs` from 69 to 71.
3. `activity.mjs` and one call in `cli.mjs`. For `btrain handoff`, the call
   passes the `agentCheck` that `checkHandoff` returns: when it is
   `verified`, the lane has an open attempt, and the agent is that attempt's
   reviewer, write `review-pickup` once. For any other lane-scoped command
   by that reviewer, write `review-progress`, at most once a minute. For
   those commands the agent is the `BTRAIN_AGENT` variable, which a
   dispatched runner always has, matched against the configured agents.
   Each write takes the lane's handoff lock with `withFileLock`. PR flow,
   review context, and the startup snapshot call none of this.
4. The same call records the owner's pickup of a `fix-confirmation` lane.
5. `buildLaneGuidance` and `getStatus`: add the display state, the reviewer,
   the time since dispatch or pickup, the tier, and the fallback reason.
   `scripts/serve-dashboard.js` shows them. The stored status is printed
   unchanged wherever a command takes it as input.
6. Tests:
   - A fold over each event sequence in the data model.
   - `btrain handoff --lane <id>` by the dispatched reviewer writes one
     pickup; a second run writes none.
   - The same command by another agent, by an unverified actor, and through
     `btrain pr status` or the startup snapshot writes none.
   - After pickup, `btrain status` shows `in-review` and the handoff file
     still holds `needs-review` (invariant 5).
   - After the attempt ends `unresponsive`, the display is `needs-review`.
   - Events from before the last claim are ignored.
   - `btrain review code --lane <id>` by the attempt's reviewer writes one
     `review-progress`, and a second run within a minute writes none.
   - A lane-agent `handoff update --reviewer` during an open request ends
     the open attempt in the fold.

### WS3: legacy-row enforcement

This is spec 019 Workstream 0, extended as spec 023 FR-5 requires.

Spec 015 FR-10 makes the retirement of a legacy row a semantic change, in
the order prose, model, code. The pinned prose already forbids each of these
rows, so the prose step is the spec 015 table and the ledger. The order
inside the PR is the one PR #108 used: spec 015 and the ledger, the mirror
and the harness with a TLC run, then the gate.

1. Run the spec 015 FR-5 audit for L4, L8, L9, and L15 across the registered
   repositories and record it in the ledger.
2. Extend the `enforced` field of PR #108 to hold target slices.
3. Retire L8 and L15. An approval or a request for changes by an actor that
   is not the recorded reviewer is refused, with the fix text
   `resolveHandoff` and `requestChangesHandoff` already print. Retire L9: an
   approval of a lane whose coverage is suspended is refused, and the fix
   text names the owner's resync.
4. Narrow L4: refuse `handoff update --status` to `ready-for-pr`,
   `pr-review`, and `ready-to-merge`. Row 7 still moves `ready-for-pr` to
   `pr-review` for the owner with a PR number, and row 12 still returns
   `changes-requested` to `pr-review`.
5. Update the spec 015 table and the mirror in `lane-lock-model.mjs` so the
   transcription cross-check (spec 015 FR-7) agrees.
6. Tests:
   - The owner's `handoff resolve` from `needs-review` is refused.
   - `handoff request-changes` with no recorded reviewer, or by an unverified
     actor, is refused.
   - `handoff update --status ready-for-pr` is refused for the owner, the
     reviewer, and an unconfigured actor.
   - `btrain pr create`, `btrain pr poll --apply`, and row 12 still work.
   - The reviewer's `handoff resolve` on a lane whose locks were
     force-released is refused, and succeeds after the owner's resync.
   - TLC passes and the formal harness reports no new candidate finding.

### WS4: reviewer choice

1. `claimHandoff`: resolve the reviewer before the row 1 gate call. Today
   the gate runs first and inference second. Build the candidate order with
   `orderCandidates` and pass it to `inferPeerReviewer` as the configured
   list. That changes the result for a claim with no `--reviewer` and for
   `--reviewer any-other`, which both skip the named reviewer.
2. `claimHandoff` and `resolveReassignInputs`: when the named reviewer is
   same-lab, or has no lab, and an other-lab agent with a `cli` runner is
   configured, refuse with the FR-3 text, unless a `same-lab-review`
   override for the lane is consumed.
3. Add `same-lab-review` to `VALID_OVERRIDE_ACTIONS`, require `--lane` for
   it in `grantOverride`, and record its consumption on the claim or
   reassignment event.
4. Rows 1 and 20: the `reviewerLabAllowed` guard input. `claimHandoff`
   passes it to its own gate call. For `btrain handoff update`,
   `resolveReassignInputs` returns it in `gateFacts`, and `patchHandoff`
   gains one spread line, `...reassign.gateFacts`, in each of its two gate
   inputs. Change the pinned 585 in `test/decomposition_inventory.test.mjs`
   to 587 and state both numbers in the handoff.
5. The two `inferPeerReviewer` calls in `patchHandoff` are not changed. They
   keep the lane's current reviewer, and when a lane has none they may pick
   a same-lab agent. The request loop of WS5, not inference, decides who is
   dispatched, so that pick is replaced at the first attempt.
6. Tests:
   - Owner `claude` with `codex-reviewer` and `claude-reviewer` configured:
     a claim with no `--reviewer` records `codex-reviewer`.
   - A reviewer with a `notify` runner and no lab needs the override when an
     other-lab agent is configured.
   - `handoff update --reviewer <same-lab>` in a repository without lanes is
     refused too: the second gate input carries the fact.
   - `--reviewer claude-reviewer` is refused with the FR-3 text, and
     succeeds with the override, which is then spent.
   - With no other-lab agent configured, a same-lab reviewer is accepted
     with no override.
   - `handoff update --reviewer <same-lab>` follows the same rule, and a
     reassignment that makes a lane author the reviewer is still refused.
   - A valid explicit other-lab reviewer is never replaced by inference
     (spec 015 FR-9).

### WS5: request loop

Two PRs. The first is prose and model: spec 005 FR-5 gains the system
reassignment, the pin is refreshed, and TLC runs. In `LaneLock.tla`, `Next`
quantifies every action's actor over `Agents`, and the owner can already
change the reviewer, so a system case inside `Reassign` would add nothing.
The model gains a separate action with no agent parameter, quantified the
way `Resync` is for `Doctor`: the owner stays the owner, the reviewer
changes under the row's guards, and `lastActor` becomes the owner. The
mirror gets the same action. The second PR is code.

1. `request-lock.mjs` and `request.mjs`, as described above.
2. `executeLoopCliRunnerWithStreaming`: the optional `AbortSignal`.
   `buildLoopRunnerEnv`: the optional allowlist. `normalizeLoopCliRunner`:
   the fresh-session flags for a same-lab attempt.
3. `dispatchNeedsReviewReviewer`: call `runReviewRequest`. `runAttempt`
   resolves the runner, starts it with the signal, and returns the handle.
   `startAttempt` is described under "Review request loop". It never goes
   through `patchHandoff`, so no caller option can ask for a system
   reassignment.
4. `actorMatches`: `reassign authority` returns true for `systemEvent` only
   when `ownerChanged` is not true. `startAttempt` checks that the matched
   row is 20 before it writes, because a refused row 20 otherwise matches
   legacy row L10. The event records `btrain-system` as the actor and the
   owner as the responsible actor, as a reviewer that replaces itself does
   today.
5. `requestChangesHandoff` and `resolveHandoff`: pass `attemptMatches`, true
   when an attempt is open, the actor is its reviewer, and the lane's head
   is the attempt's head. Both functions already read the lane again inside
   the handoff lock before they publish. Read the review record there too
   and refuse when the attempt has ended or changed since the first check.
   A verdict by a reviewer that has committed since the attempt's head is
   refused with the two exits the spec names. A verdict with no open
   attempt is refused with the command that opens one.
6. `activity.mjs`: when the lane's recorded reviewer runs `btrain handoff`
   for a `needs-review` lane with no open attempt, write `review-attempt`
   with `opened: pickup` at the request's head, under the handoff lock, and
   then the pickup. The reviewer does not change, so this is an append and
   needs no transition.
7. Two same-lab requests for changes on one lane stop the same-lab tier:
   rule 6 is skipped, rule 7 writes `review-escalation`, and no third
   same-lab round starts.
8. `runLoop`: a `needs-review` round asks the request loop for one attempt.
   Update the pinned line count in `test/decomposition_inventory.test.mjs`
   and state the old and new numbers in the handoff.
9. `finishPatchWithReviewerDispatch`: the foreground command returns when
   there is a verdict, an escalation, or a same-lab dispatch has ended.
10. Tests, all with the fake runner and the fake clock:
   - A runner that exits with a quota signal is `tool_unavailable`, and the
     next other-lab reviewer is dispatched at once.
   - With every other-lab reviewer silent, nothing is dispatched to the same
     lab before 15 minutes. At 15 minutes the reviewer is a same-lab agent
     outside the author history and the event has reason
     `other-lab-unavailable` and the attempts.
   - Progress at minute 14 keeps the reviewer at minute 15. It is replaced
     at `attempt_max`, and an untried other-lab reviewer is tried before the
     same lab.
   - A first reviewer silent past 15 minutes and a second never tried: no
     same-lab reviewer until the second has had an attempt.
   - No pickup within `silence_limit` ends the attempt and stops the runner's
     process group.
   - A verdict from a reviewer that is not the active attempt's, or at
     another head, changes nothing.
   - Zero other-lab agents: same-lab at once, reason
     `no-other-lab-configured`.
   - A linked PR: no reassignment, and an escalation at the window's end.
   - A killed dispatcher: `btrain loop --lane <id>` takes the lock, ends the
     orphaned attempt as `unresponsive`, and continues.
   - Two processes on one request: the second finds a live lock and does not
     dispatch.
   - No btrain process running for an hour: no event and no state change
     (invariant 2).
   - A same-lab attempt's command has the fresh-session flags and its
     environment has no variable outside the allowlist.
   - The owner pushes a new head during a request: a new window starts.
   - A system reassignment that names a new owner is refused and writes
     nothing. So is one whose row 20 guard fails: the L10 match is not
     accepted.
   - A verdict computed before the attempt was ended, and published after,
     is refused: the check inside the handoff lock sees the ended attempt.
   - An attempt that runs for ten minutes with steady output keeps the
     request lock, and a second process does not take it.
   - Two same-lab requests for changes, then a third request: no same-lab
     dispatch, one escalation.
   - `btrain loop --lane <id> --max-rounds 1` on a `needs-review` lane makes
     exactly one dispatch.
   - A reviewer started by hand: `btrain handoff` opens an attempt at the
     request's head, and its `handoff resolve` is accepted. The same resolve
     with no pickup is refused. A reviewer that commits and then picks up
     cannot resolve, because the branch has moved past the request's head.
   - A verdict run from another worktree of the repository is accepted when
     the lane's branch has not moved.
   - TLC passes; the harness reports no new candidate finding.

### WS6: late verdicts

1. `late.mjs`: a verdict from an attempt that ended `unresponsive`.
   - The lane is still `needs-review` at the attempt's head: reassign to that
     reviewer (reason `other-lab-recovered`), end the same-lab attempt as
     `superseded`, and apply the verdict.
   - Otherwise: write `late-review`, apply no transition, and print that the
     verdict was recorded and not applied.
2. `runPrCreate`: refuse while the lane has an unacknowledged late request
   for changes. Once a PR is linked, the late review is a warning.
3. `cli.mjs`: `handoff update --ack-late-review`, owner only, refused with
   any other change.
4. `btrain handoff` and `btrain doctor` show an unacknowledged late review.
5. Tests:
   - A late other-lab `resolve` at the same head while `needs-review` moves
     the lane and records `review tier: other-lab`.
   - A late request for changes after the lane moved on changes no state,
     blocks `btrain pr create`, and stops blocking after the
     acknowledgement.
   - A late approval after the lane moved on is recorded and blocks nothing.
   - With a PR linked, a late request for changes is a warning only.
   - The reviewer cannot acknowledge.

### WS7: reviewer fixes

Two PRs. The first is prose and model: spec 002 `CLI Commands` and
`PR-flow states and actors`, spec 005 `Proposed Status Model` and FR-5, the
re-pin, the status, the three actions, `fixAuthors`, `FixSeparation`, the
restated `PrFlowEntryByReviewer`, the mirror, and TLC. Two details the model
must get right: `RepairEnter` takes any status in `ActiveStatuses` except
`repair-needed`, so it must also exclude `fix-confirmation`; and
`ReviewerFix` sets `peerApproved` and `approver`, and `ConfirmFix` leaves
both alone, so `PrFlowNeedsPeerApproval` holds without change. The second
PR is code.

1. Add `fix-confirmation` to the status sets and the three rows to
   `TRANSITION_ROWS`. Exclude it from the sources of rows 13 and L3, and
   retire L4 for it as a source and a target.
2. `fix-rules.mjs`: each FR-11 condition as its own check with its own
   message: tier, feature enabled, `fixBase` is the attempt's head and
   `fixHead` descends from it, every commit is later than the attempt's
   start and carries the reviewer's `Btrain-Agent` trailer, every path is in
   the locked files, the file and line limits, no existing line of a test
   file or test configuration removed or changed, no hard weakened-test
   finding from `btrain review code` on the range, and the round limit.
3. `fixes.mjs`: `fixHandoff` gathers the git facts, runs the checks, calls
   `applyTransition` for `ReviewerFix`, moves the lane with `updateHandoff`
   using event type `fix-applied`, and dispatches the owner through
   `runLoop` for one round. `confirmFixHandoff` checks the head, the
   recorded approval, the actor, and lock coverage, and calls
   `applyTransition` for `ConfirmFix`. With PR flow on it moves the lane to
   `ready-for-pr` with `updateHandoff` and event type `fix-confirmed`. With
   PR flow off it writes `fix-confirmed` first and then calls
   `resolveHandoff` with the internal `transitionEvent` option set to
   `handoff confirm-fix`, so the existing resolve path releases the locks
   and records its own `resolve` event. `resolveHandoff` reads that option
   for its terminal transition; that line and step 5 are its only edits
   here. Export `updateHandoff`, regenerate the baseline, and change the
   three count assertions from 71 to 72.
4. `AmendFix`: `resolveReassignInputs` adds `commitAfterFixHead` to
   `gateFacts` when the lane is `fix-confirmation`, true when the lane's
   branch holds a commit after `fixHead`. It reaches the gate through the
   spread WS4 added, also when an override ID skips
   `validateNeedsReviewTransition`. `finishPatchWithReviewerDispatch`: on
   that hand-off, write `fix-confirmed` with `how: amend` for the fix
   commits still in the head. The new attempt reviews the commits after
   `fixHead`.
5. `resolveHandoff`: refuse when the head holds a commit that `fix-applied`
   recorded for the resolving reviewer and no `fix-confirmed` covers it.
6. `renderPreCommitHook`: during `fix-confirmation`, only the owner may
   commit to the locked files. `commit-trailer-hook.mjs` and
   `managedHookSpecs`: a managed `commit-msg` hook that appends
   `Btrain-Agent: <BTRAIN_AGENT>` when the variable is set and the trailer
   is absent. `findStaleManagedHooks` reports a repository that lacks it.
7. `getLoopActorForState` and `buildLaneGuidance`: route `fix-confirmation`
   to the owner, tell the owner to read `git diff <fixBase>..<fixHead>`
   only, and print both exits. Reviewer guidance gains the judgment
   conditions of FR-11.
8. The confirmation deadline. `runLoop` returns when its one round ends, so
   `fixHandoff` itself then waits, polling the record, until the owner's
   pickup or `other_lab_window`. At the window with no pickup it writes
   `review-escalation` with reason `fix-unconfirmed`. The `btrain loop`
   command in `cli.mjs` makes the same check before it calls `runLoop` for a
   `fix-confirmation` lane. `runLoop` is not edited for this. The lane stays
   `fix-confirmation`.
9. Tests: every Rule 2 acceptance criterion in the spec, one test each, and:
   - Each FR-11 refusal has its own message.
   - A fix by the reviewer does not add the reviewer to the author history,
     and the reviewer can review the owner's next change on the lane.
   - `handoff update --status fix-confirmation` and
     `handoff update --status in-progress` from `fix-confirmation` are
     refused for every actor.
   - Row 13 refuses `fix-confirmation` as a source.
   - A commit made with `--no-verify` in the fix range makes `handoff fix`
     fail on the missing trailer.
   - With PR flow off, `confirm-fix` resolves the lane, releases its
     locks, and the log holds `fix-confirmed` before `resolve`.
   - The owner's `handoff update --status needs-review` from
     `fix-confirmation` with no commit after `fixHead` is refused, also with
     a `needs-review` override ID.
   - In TLC, no step enters `repair-needed` from `fix-confirmation`.
   - TLC passes with `FixSeparation` and the restated
     `PrFlowEntryByReviewer`, and the transcription cross-check agrees.

### WS8: PR bot gate

1. `getPrFlowConfig`: load every `[pr_flow.bots.<id>]`, with `lab`, and
   `bot_pending_timeout`.
2. `classifyPrReviewState`: take the lane's author labs. `ready-to-merge`
   needs every required bot clear and, when a bot with a lab outside the
   author set is configured, at least one such bot clear on the head.
3. `runPrPoll`: when the first outside-lab bot has not reviewed the head
   within `bot_pending_timeout` of its request, request the next configured
   outside-lab bot. When every one is silent past its window, write
   `review-escalation` with reason `bots-silent`. The lane stays
   `pr-review`.
4. `btrain pr status` shows which bot satisfies the outside-lab requirement,
   or that none does yet.
5. `doctor.mjs`: warn when no bot has an outside lab for some configured
   owner, and when only one does.
6. Tests:
   - A lane authored by `codex` with `gh-codex` clear and an `anthropic` bot
     pending is `waiting`. With that bot clear it is `ready-to-merge`.
   - With no outside-lab bot configured, the result is what `main` gives,
     and `btrain doctor` warns.
   - A bot with no `lab` never satisfies the requirement.
   - The second bot is requested once, after the timeout, and not before.
   - A lane with authors from two labs needs a bot outside both.

### WS9: visibility, docs, rollout

1. `buildPrBody`: the review tier, the fallback reason when there is one,
   and a line for a confirmed reviewer fix.
2. The managed block template: "one lab writes, another lab reviews", with
   the two declared exceptions. `btrain sync-templates` then changes
   `CLAUDE.md` and `AGENTS.md` in every consuming repository. The PR calls
   that out.
3. The `pre-handoff` skill and the reviewer guidance: when to fix and when
   to request changes.
4. `README.md`: the `[agents.labs]`, `[review]`, and `[review.fixes]`
   tables, the two new commands, and the new override action.
5. This repository's `.btrain/project.toml`: an `[agents.labs]` table, and
   an other-lab agent that is not Codex, so a Codex outage does not send
   every review to the same lab.
6. Report after two weeks of lanes: time from `needs-review` to the first
   verdict, the share of lanes at each tier, the share closed by
   `handoff fix`, and how often an owner amended a fix. These are the
   spec's follow-up measures.
7. Tests:
   - A PR body for a same-lab review names the tier and the reason.
   - The rendered managed block holds the new sentence and both exceptions.

## Quality and formal gates

- `npm test` and `npm run test:formal` pass in every workstream.
- **Formal impact** is the column in the workstream table. A `none` lane
  records why. A `validation` lane runs
  `node scripts/formal_advisory.mjs --base <Base> --output <result.json>`
  and records the result. A `semantic` lane edits prose first, runs
  `python3 scripts/tla_pin.py` to re-pin, changes the model and the mirror,
  runs TLC, and lands that before its code PR.
- TLC runs with the bounds in `LaneLock.cfg`: two lanes and three agents.
  `fixAuthors` is a set for each lane and one more status is added. WS7
  records the state count and run time before and after. If the run no
  longer finishes inside the CI job, WS7 narrows `fixAuthors` to one slot,
  the way `priorOwner` narrows the author history.
- `node scripts/decomposition_inventory.mjs --stages` exits 0 with no change
  to `specs/020-ws2-module-assignment.json` in every workstream.
  `test/decomposition_inventory.test.mjs` passes, with its stated changes:
  the export counts in WS2 and WS7, the `patchHandoff` pin in WS4, and the
  `runLoop` pin in WS5.
- The export-surface check passes against the regenerated baseline in WS2
  and WS7, and against the unchanged baseline in every other workstream.
  `test/cli-internal-options.test.mjs` passes with no new internal option.
- `btrain review code` passes on each lane.
- No test starts a real model. Every dispatch in a test is the fake runner.
- Each lane is reviewed by an agent from a different lab when one is
  available, even before this spec enforces it.

## Risks and tradeoffs

| Risk | Design response |
| --- | --- |
| Four open lanes hold the files most workstreams need | WS0 and the pure modules of WS1 and WS2 need none of them. The table names the PR each later workstream waits for |
| The invariant does not hold until L4, L8, and L15 are enforced | WS3 comes before the request loop and the fix path, and neither is claimed as protection before it lands |
| A request loop in the foreground holds a terminal for up to 45 minutes | It is what reviewer dispatch does today for 10. `--no-dispatch` and `BTRAIN_NO_REVIEW_DISPATCH` still skip it, and `btrain loop --lane <id>` continues a request later |
| Two processes dispatch reviewers for one request | The request lock, with the heartbeat and nonce of the spec 024 delivery lock |
| The dispatcher dies and its runner keeps going | The later process ends the orphaned attempt as `unresponsive`. If that reviewer then returns a verdict, it is a late verdict and FR-6 applies |
| A quota message changes and is no longer recognized | The exit is then `failed`, and the next reviewer is still tried. Only the label is wrong. `[review.signals]` adds a pattern without a release |
| A lab is declared wrong in `[agents.labs]` | `btrain doctor` prints every resolved lab. The spec treats the table as the operator's assertion |
| A reviewer's fix is wrong | The limits of FR-11, the owner's confirmation, and the owner's right to amend |
| The trailer can be typed by hand | Accepted by the spec. It catches a bypassed hook, not a deliberate forgery |
| `patchHandoff` and `runLoop` grow and their pins change | Once each, in WS4 and WS5, with the old and new counts in the handoff |
| The handoff lock is `withFileLock`, which steals a lock older than 30 seconds | Every write under it here is short. The stale-steal race that lane d is reproducing must be fixed before WS5 relies on the lock for verdict ordering; WS5 does not start until it is |
| A reviewer started by hand never runs `btrain handoff` | Its verdict is refused with the command to run. It costs one command and keeps the head check |
| The fold over the event log gets slow on a long-lived lane | It uses only events after the last claim. Commands already read the whole lane log through `readWorkflowEvents`, so the fold adds no read |
| TLC's state space grows with `fixAuthors` | Measured in WS7, with a one-slot fallback |
| Every consuming repository's managed block changes | WS9 ships it last and its PR says so |
| A linked PR blocks reassignment during a review | The loop keeps the recorded reviewer and escalates at the window's end |

## Follow-ups

- Partial fixes, the second outside-lab PR bot, and the measures, as the
  spec lists them.
- `<runtime>#review` identities for a repository with one agent, and
  `solo adopt` for a lane whose owner's runtime is down (spec 017, later
  phases of spec 023).
- One shared heartbeat-lock helper for `review/request-lock.mjs` and
  `slack/lock.mjs`.
- Fresh-session and signal entries for `agent`, once PR #113 has merged and
  samples exist.
- The spec 024 kinds for these events (spec 024 plan, WS7).

## Context receipt

**Tier:** deep was attempted in the spec 024 planning lane on the same day
and `.claude/scripts/unblocked-context.sh research` returned no sources. This
plan rests on local evidence.
**Questions:** Where is a reviewer chosen and dispatched today? Which legacy
rows let a lane skip review? What can change without a new function in
`core.mjs`? Which open pull requests hold the files, and which does the spec
assume?
**Primary sources:** [Spec 023](023-cross-lab-review-and-reviewer-fixes.md),
[Spec 015](015-lane-transition-contract.md) FR-5 and its table,
[Spec 017](017-solo-mode-internal-review.md) FR-3 and FR-8,
[Spec 019](019-solo-mode-implementation-plan.md) Workstream 0,
[Spec 020](020-token-spend-and-decomposition.md) and its module assignment,
current `core.mjs`, `transitions.mjs`, `pr-flow.mjs`, `cli.mjs`,
`internal_options.mjs`, `specs/tla/LaneLock.tla`, and
`scripts/formal_contracts.json`, the diffs of PR #108, PR #112, and PR #113
against `main`, and `btrain locks` on 2026-11-23.
**Constraints:** no new function in `core.mjs`, three new exports of
existing functions, prose before model before code, no usage-billed service,
and no new state file.
**Gaps:** no organizational history; the signal patterns have only the
samples seen in this repository; TLC cost with `fixAuthors` is not measured;
PR #108, #112, and #113 are unmerged and may change the seams named here.
**Durable writeback:** this plan and the spec 023 amendments in the same
lane.
