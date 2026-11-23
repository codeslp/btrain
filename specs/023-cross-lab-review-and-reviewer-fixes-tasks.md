# 023 — Cross-lab review and reviewer fixes tasks

Tasks for the [implementation plan](023-cross-lab-review-and-reviewer-fixes-implementation-plan.md).
Each numbered workstream (WS) in the plan is one lane and one PR, except WS5
and WS7, which are two PRs each: prose and model first, then code. A task is
done when its code and its tests are merged.

Before claiming a workstream, run `btrain locks` from a session that is not
lane-scoped. Three open pull requests hold files these tasks need: PR #108
(`transitions.mjs`, `test/formal/*`, spec 015), PR #112 (`pr-flow.mjs`,
spec 002, `CLAUDE.md`), and PR #113 (`core.mjs`). Lane c holds `cli.mjs`.

**Status 2026-11-23:** nothing is started. T001 to T006 and T009 need no file
another lane holds. Two lanes never hold one file at once, so the tasks that
edit `core.mjs` or `pr-flow.mjs` land one workstream at a time, in order.

## Phase 1: Foundations that change no behavior (WS0, WS1, WS2)

- [ ] T001 [WS0] Write the fake runner in `test/helpers/fake-runner.mjs`: an executable a test names in `[agents.runners]`, driven by a scenario file. It can run `btrain handoff`, print lines at given times, stay silent, exit with a code and text, commit a file with or without the `Btrain-Agent` trailer, and run a verdict or `handoff fix`.
- [ ] T002 [WS0] Write `test/helpers/fake-clock.mjs`: `now` and `sleep` for the request loop, so a 15-minute window runs in milliseconds.
- [ ] T003 [WS0] Add the thirteen invariant tests of the plan to `test/review-invariants.test.mjs`, each skipped and naming the workstream that enables it. Every test that creates a repository sets `BRAIN_TRAIN_HOME` to a temporary directory. `npm test` gives the same result as `main`.
- [ ] T004 [WS1] Write `src/brain_train/review/labs.mjs`: `resolveAgentLab` in the FR-1 order, `authorLabs`, `tierOf`, and `orderCandidates`. The agent name is never read. Test each source of a lab, each runner shape that yields none, `reviewer_order`, and `reviewer_default` in `test/review-labs.test.mjs`.
- [ ] T005 [WS1] Write `src/brain_train/review/review-config.mjs`: `[review]`, `[review.fixes]`, `[review.signals.<executable>]`, and `[pr_flow].bot_pending_timeout` with the spec's defaults and duration parsing. A duration that does not parse yields the default and a doctor error.
- [ ] T006 [WS1] Write `src/brain_train/review/runner-table.mjs`: for `claude`, `codex`, and `gemini`, the lab, the presence probe, the fresh-session flags, and the rejected flags; and `classifyExit`. Capture a real sample of each quota, authentication, and refusal message under `test/fixtures/runner-signals/` and ship only patterns that have a sample. Test each pattern against its sample, and that an exit with no pattern is `failed`.
- [ ] T007 [WS1] Write `src/brain_train/review/doctor.mjs` and append its findings in `doctorRepo`: every agent's resolved lab, a warning for each agent with none, and a warning when an owner has no other-lab agent with a `cli` runner. A missing lab never changes the exit code. Held on 2026-11-23: `core.mjs` (lane h).
- [ ] T008 [WS2] Export `appendWorkflowEvent`, `readWorkflowEvents`, and `detectCurrentAgent` from `src/brain_train/core.mjs`, regenerate `specs/020-ws2-export-baseline.json`, and in `test/decomposition_inventory.test.mjs` change the four 69s to 72 and the export block's 68 to 71. Say in the commit that the surface change is intended.
- [ ] T009 [WS2] Write the fold in `src/brain_train/review/record.mjs`: the events since the lane's last claim to the review record of the plan's data model. Test a fold over each event sequence, and that events before the last claim are ignored, in `test/review-record.test.mjs`.
- [ ] T010 [WS2] Write `src/brain_train/review/activity.mjs` and call its helper after `resolveRepoRoot` in each lane-scoped handler of `src/brain_train/cli.mjs`: `handoff`, `review`, and `pr`. The helper uses `detectCurrentAgent`. When the agent is verified and is the reviewer of the lane's open attempt, `btrain handoff` writes `review-pickup` once and any other command writes `review-progress`, at most once a minute. It also writes the pickup of the owner of a `fix-confirmation` lane. Each write takes the lane's handoff lock with `withFileLock`. Test that the dispatched reviewer writes one pickup, that `btrain review code --lane <id>` writes one progress event, and that another agent, an unverified actor, `btrain pr status`, and the startup snapshot write none.
- [ ] T011 [WS2] Add the display state, the reviewer, the time since dispatch or pickup, the tier, and the fallback reason to `buildLaneGuidance` and `getStatus`, and show them in `scripts/serve-dashboard.js`. Test that after pickup `btrain status` shows `in-review` while the handoff file holds `needs-review`. Remove the skip from invariant 5.

**Independent check:** `btrain doctor` lists every agent's lab, and a dispatched reviewer's first `btrain handoff` shows the lane as `in-review`. No reviewer is chosen or dispatched differently from `main`.

## Phase 2: The enforcement the invariant needs (WS3)

Starts when PR #108 has merged. This is spec 019 Workstream 0, extended.
Retiring a legacy row is a semantic change (spec 015 FR-10): inside the PR
the order is the spec 015 table and the ledger, the mirror and the harness
with a TLC run, then the gate.

- [ ] T012 [WS3] Run the spec 015 FR-5 audit for L4, L8, L9, and L15 over every registered repository: no `transition-advisory` event for the row in the last 7 days. Record it in the ledger in `test/formal/README.md`.
- [ ] T013 [WS3] Extend the `enforced` field of a legacy row in `src/brain_train/transitions.mjs` to hold target slices as well as source slices, with a rejection message for each new slice.
- [ ] T014 [WS3] Retire L8 and L15. An approval or a request for changes by an actor that is not the recorded reviewer, or with no recorded reviewer, is refused. Remove the advisory branches for both rows in `resolveHandoff` and `requestChangesHandoff`. Retire L9: the reviewer's approval of a lane whose lock coverage is suspended is refused until the owner's resync.
- [ ] T015 [WS3] Retire L4 for the targets `ready-for-pr`, `pr-review`, and `ready-to-merge`. Row 7 and row 12 keep working.
- [ ] T016 [WS3] Update the row table in `specs/015-lane-transition-contract.md` and the mirror in `test/formal/lane-lock-model.mjs`. Test in `test/transitions.test.mjs` and a CLI test: the owner's `handoff resolve` from `needs-review` is refused; `handoff update --status ready-for-pr` is refused for the owner, the reviewer, and an unconfigured actor; `btrain pr create`, `btrain pr poll --apply`, and row 12 still work; a resolve on a force-released lane is refused and succeeds after the resync; TLC passes and the formal harness reports no new candidate finding.

**Independent check:** no command moves a lane into the PR flow without the recorded reviewer's approval.

## Phase 3: Rule 1, cross-lab review (WS4, WS5, WS6)

- [ ] T017 [WS4] In `claimHandoff`, resolve the reviewer before the row 1 gate call (today the gate runs first), order the candidates with `orderCandidates`, and pass that list to `inferPeerReviewer`. Test that owner `claude` with `codex-reviewer` and `claude-reviewer` configured gets `codex-reviewer`, and that a valid explicit other-lab reviewer is never replaced.
- [ ] T018 [WS4] Refuse an explicit reviewer that is same-lab or has no lab in `claimHandoff` and `resolveReassignInputs` when an other-lab agent with a `cli` runner is configured, with the FR-3 text. Add the `reviewerLabAllowed` guard input to rows 1 and 20. `resolveReassignInputs` returns it in a `gateFacts` object, and `patchHandoff` gains one spread line in each of its two gate inputs; change the pinned 585 in `test/decomposition_inventory.test.mjs` to 587 and state both numbers in the handoff. Test the refusal, `--reviewer any-other`, the case with no other-lab agent, a `notify` reviewer with no lab, the same refusal in a repository without lanes, and that a reassignment making a lane author the reviewer is still refused.
- [ ] T019 [WS4] Add `same-lab-review` to `VALID_OVERRIDE_ACTIONS`, require `--lane` for it in `grantOverride`, and consume it on the claim or reassignment it permits. Test that the override is spent after one use.
- [ ] T020 [WS5, PR 1] Prose and model for the system reassignment: add it to spec 005 FR-5, re-pin with `python3 scripts/tla_pin.py`, add a separate system reassignment action to `specs/tla/LaneLock.tla` and `test/formal/lane-lock-model.mjs`, with no agent parameter, quantified the way `Resync` is for `Doctor`: the owner stays, the reviewer changes under row 20's guards, and `lastActor` becomes the owner. Run TLC.
- [ ] T021 [WS5] Write `src/brain_train/review/request-lock.mjs`: one heartbeat lock for each lane request, with the 60-second liveness rule, a touch on a 15-second timer for the whole life of the loop, and a nonce the holder reads again before every dispatch. Test that a second process finds a live lock and does not dispatch, and that a ten-minute attempt keeps the lock.
- [ ] T022 [WS5] Write the attempt loop `runReviewRequest` in `src/brain_train/review/request.mjs` with injected `readEvents`, `writeEvent`, `readLane`, `startAttempt`, `runAttempt`, `now`, and `sleep`, applying the plan's eight rules in order and its three short cases. `runAttempt` starts the runner and returns a handle, so the loop polls while it runs. The loop can be asked for one attempt only.
- [ ] T023 [WS5] In `core.mjs`: give `executeLoopCliRunnerWithStreaming` an optional `AbortSignal` that stops the process group, give `buildLoopRunnerEnv` an optional allowlist, and make `normalizeLoopCliRunner` add the fresh-session flags and reject the resume flags for a same-lab attempt.
- [ ] T024 [WS5] Make `dispatchNeedsReviewReviewer` call `runReviewRequest`. `startAttempt` sets the lane's reviewer and records `review-attempt` in one `updateHandoff` write, with the owner as the event's actor and `btrain-system` in its details: it calls `applyTransition` for row 20 with actor `btrain-system` and `systemEvent`, and writes only when the matched row is 20, because a refused row 20 otherwise matches legacy row L10. Make `reassign authority` in `actorMatches` accept `systemEvent` only when the owner does not change, and make `getCanonicalWorkflowActor` read a `review-attempt` that changed the reviewer.
- [ ] T025 [WS5] Bind verdicts to attempts: add an optional `precondition` to `updateHandoff`, called inside the handoff lock before the write. `requestChangesHandoff` and `resolveHandoff` pass `attemptMatches` to rows 3, 4, and 5, pass a precondition that requires the attempt to still be the active one, and record `attemptId` and `tier` on the verdict event. The lane's head is the branch recorded on `review-request`, so a verdict from another worktree works. A reviewer that has committed since the attempt's head cannot resolve or request changes, and a verdict with no open attempt is refused with the command to run. In `review/activity.mjs`, open an attempt at pickup, at the request's head, for a recorded reviewer that was not dispatched, only when a dispatch of that reviewer would be allowed, and for a request from a detached checkout only from a checkout at the recorded commit.
- [ ] T026 [WS5] Write `review-escalation` when no reviewer is available at any tier, when the lane already has two same-lab requests for changes (the fallback rule is then skipped, so no third same-lab round starts), and when a linked PR blocks reassignment at the window's end.
- [ ] T027 [WS5] Make a `needs-review` round of `runLoop` ask the request loop for one attempt, so `btrain loop --max-rounds 1` is still one dispatch, and update the pinned line count in `test/decomposition_inventory.test.mjs`, stating the old and new numbers in the handoff. Map the request outcome in `finishPatchWithReviewerDispatch`.
- [ ] T028 [WS5] Add `test/review-request.test.mjs` with the fake runner and the fake clock: every WS5 test the plan lists. Remove the skips from invariants 1, 2, 3, 4, 8, 9, 10, and 13.
- [ ] T029 [WS6] Write `src/brain_train/review/late.mjs`: a verdict from an attempt that ended `unresponsive` is applied, with a reassignment back to that reviewer, when the lane is still `needs-review` at the attempt's head. Otherwise it is recorded as `late-review` and no transition is applied.
- [ ] T030 [WS6] Refuse `btrain pr create` in `runPrCreate` while a late request for changes is unacknowledged. Add `btrain handoff update --lane <id> --ack-late-review`, owner only, refused with any other change. Show an unacknowledged late review in `btrain handoff` and `btrain doctor`. Test each case the plan lists for WS6. Starts when PR #112 has merged.

**Independent check:** a silent other-lab reviewer is replaced by the next one; a same-lab reviewer is assigned only after the window with every other-lab reviewer tried and none progressing; with no btrain process running, nothing changes.

## Phase 4: Rule 2, reviewer fixes (WS7)

- [ ] T031 [WS7, PR 1] Prose and model for the fix path: edit spec 002 `CLI Commands` and `PR-flow states and actors` and spec 005 `Proposed Status Model` and FR-5, re-pin, and in `LaneLock.tla` and the mirror add `fix-confirmation`, `ReviewerFix`, `ConfirmFix`, `AmendFix`, `fixAuthors`, and `FixSeparation`, and restate `PrFlowEntryByReviewer`. Exclude `fix-confirmation` from `RepairEnter`. `ReviewerFix` sets `peerApproved` and `approver`, and `ConfirmFix` leaves both. Run TLC and record the state count and run time before and after.
- [ ] T032 [WS7] Add `fix-confirmation` to the status sets in `core.mjs` and `transitions.mjs` and the three rows to `TRANSITION_ROWS`, with `ConfirmFix` as the status's primary row. Exclude it from the sources of rows 13 and L3, and retire L4 for it as a source and as a target.
- [ ] T033 [WS7] Write `src/brain_train/review/fix-rules.mjs`: one check and one message for each FR-11 condition. Test each refusal in `test/review-fix-rules.test.mjs`.
- [ ] T034 [WS7] Export `updateHandoff` from `core.mjs`, regenerate the export baseline, and change the four 72s to 73 and the 71 to 72 in the inventory test. Write `fixHandoff` and `confirmFixHandoff` in `src/brain_train/review/fixes.mjs`, and route `btrain handoff fix` and `btrain handoff confirm-fix` to them in `cli.mjs`. `resolveHandoff` reads the internal `transitionEvent` option for its terminal transition, so `confirm-fix` with PR flow off writes `fix-confirmed` and then resolves the lane and releases its locks.
- [ ] T035 [WS7] The owner's hand-off from `fix-confirmation`: `resolveReassignInputs` adds `commitAfterFixHead` to `gateFacts`, so `AmendFix` requires a commit after `fixHead` also when an override ID skips `validateNeedsReviewTransition`; `finishPatchWithReviewerDispatch` writes `fix-confirmed` with `how: amend`, and the new attempt reviews the commits after `fixHead`.
- [ ] T036 [WS7] Make `resolveHandoff` refuse when the head holds a commit that `fix-applied` recorded for the resolving reviewer and no `fix-confirmed` covers it.
- [ ] T037 [WS7] Hooks: `renderPreCommitHook` lets only the owner commit to the locked files during `fix-confirmation`. Write `src/brain_train/review/commit-trailer-hook.mjs` and add the managed `commit-msg` hook to `managedHookSpecs`. It appends `Btrain-Agent: <BTRAIN_AGENT>` when the variable is set and the trailer is absent.
- [ ] T038 [WS7] Route `fix-confirmation` to the owner in `getLoopActorForState`, write its guidance in `buildLaneGuidance` with both exits, add the FR-11 judgment conditions to reviewer guidance, and write `review-escalation` with reason `fix-unconfirmed` when the owner has not picked the lane up within `other_lab_window`. `fixHandoff` waits for that after its one loop round returns, and the `loop` command in `cli.mjs` makes the same check for a `fix-confirmation` lane. `runLoop` is not edited for it.
- [ ] T039 [WS7] Add `test/review-fixes.test.mjs`: one test for each Rule 2 acceptance criterion in the spec, and the WS7 tests the plan lists. TLC passes with `FixSeparation`, and the transcription cross-check agrees. Remove the skips from invariants 6, 7, 11, and 12.

**Independent check:** an other-lab reviewer's two-line fix reaches `ready-for-pr` after the owner's `confirm-fix`, and no agent that wrote a fix can confirm it.

## Phase 5: PR bot gate, visibility, rollout (WS8, WS9)

- [ ] T040 [WS8] Make `getPrFlowConfig` load every `[pr_flow.bots.<id>]` with its `lab`, and read `bot_pending_timeout`. Starts when PR #112 has merged.
- [ ] T041 [WS8] In `classifyPrReviewState`, take the lane's author labs: `ready-to-merge` needs every required bot clear and, when an outside-lab bot is configured, at least one of them clear on the head. `btrain pr status` names the bot that satisfies the requirement. Test a `codex` lane with `gh-codex` clear and an `anthropic` bot pending, a bot with no `lab`, and a lane with authors from two labs.
- [ ] T042 [WS8] In `runPrPoll`, request the next outside-lab bot once after `bot_pending_timeout`, and write `review-escalation` with reason `bots-silent` when every one is silent past its window. Add the two bot warnings to `review/doctor.mjs`.
- [ ] T043 [WS9] Add the review tier, the fallback reason, and a line for a confirmed reviewer fix to `buildPrBody`. Test a PR body for a same-lab review.
- [ ] T044 [WS9] Change the managed block template to "one lab writes, another lab reviews" with the two exceptions, update the `pre-handoff` skill and reviewer guidance, and document `[agents.labs]`, `[review]`, `[review.fixes]`, the two commands, and the override action in `README.md`. Call out in the PR that `btrain sync-templates` changes `CLAUDE.md` and `AGENTS.md` in every consuming repository.
- [ ] T045 [WS9] In this repository's `.btrain/project.toml`, add `[agents.labs]` and an other-lab agent that is not Codex.
- [ ] T046 [WS9] After two weeks of lanes, report the spec's measures: time from `needs-review` to the first verdict, the share of lanes at each tier, the share closed by `handoff fix`, and how often an owner amended a fix.

**Independent check:** a lane authored by `codex` does not reach `ready-to-merge` on `gh-codex` alone when another lab's bot is configured, and a PR body names the tier of its local review.

## Dependencies

T001 to T003 come first. T004 to T006 and T009 need only them. T007 edits `core.mjs`, and T008, T010, and T011 follow it, because two lanes never hold that file at once. T012 to T016 need PR #108 and nothing else here. T017 to T019 need T004 to T011. T020 to T028 need T008 to T019, which includes the enforcement of T012 to T016, and the `withFileLock` stale-steal fix that lane d is working on. T029 and T030 need T020 to T028. T031 to T039 need T012 to T016 and T020 to T028. T040 to T042 need T004 to T007 and follow T029 and T030, because both edit `pr-flow.mjs`. T043 to T046 need T020 to T039.

The spec 024 tasks T030 and T031 start after T020 to T039 here.
