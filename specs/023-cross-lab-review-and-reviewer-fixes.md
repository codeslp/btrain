# 023 — Cross-Lab Review by Default and Reviewer-Applied Fixes

**Status**: Draft
**Version**: 0.2.0
**Author**: btrain (claude)
**Date**: 2026-11-23

## Decision

Two rules, one invariant.

**Rule 1: cross-lab review by default.** btrain assigns every review to an
agent whose model comes from a different lab than the agents that wrote the
work. A same-lab reviewer is used only when every other-lab reviewer has been
unavailable or unresponsive for 15 minutes after the review was requested.
That fallback runs in a fresh session, is recorded on the lane with its
reason, and is visible wherever the lane is shown. No operator toggle is
needed to reach it and it never happens silently.

**Rule 2: reviewers may apply small fixes.** A reviewer who finds a small,
unambiguous defect commits the fix and hands the lane to the original author
to confirm only those fix commits. The author does not redo the work and the
reviewer does not re-review. Larger, ambiguous, or test-changing findings
still go back to the author through `handoff request-changes`.

**The invariant both rules serve:** every commit that reaches a pull request
was approved by an agent that did not write it, and that agent came from a
different lab whenever one answered within 15 minutes.

"Lab" means the organization that trained the model doing the work, not the
harness that runs it. A Cursor agent running an Anthropic model is an
Anthropic reviewer.

## Why

Evidence from `main` at `95b6294`:

- **Reviewer choice ignores the lab.** `inferPeerReviewer` (`core.mjs`)
  returns the first configured agent that is not the owner. Nothing in btrain
  records which lab an agent's model comes from.
- **Same-lab review is the current norm.** `.btrain/project.toml` defaults to
  writer `codex` and reviewer `codex-reviewer`. Its own comment records that
  every lane since PR #92 has been owned by `claude` and reviewed by
  `claude-reviewer`. PR #113 states its local review was done by
  `claude-reviewer` for owner `claude`.
- **There is no fallback on silence.** `dispatchNeedsReviewReviewer` runs one
  round with a 10-minute default timeout (`DEFAULT_LOOP_TIMEOUT_MS`). When the
  reviewer runner fails or times out, `finishPatchWithReviewerDispatch` throws
  and the lane stays `needs-review`. No other reviewer is tried.
- **A failed review costs two hops even for a one-line fix.** The reviewer
  runs `handoff request-changes`, the owner fixes and re-hands off, and the
  reviewer reviews again. `research/harness-handoff-audit.md` measured a full
  handoff at 32,343 bytes of output and noted that repair rounds repeat the
  objective and verification narrative.
- **Spec 017 covers part of Rule 1 but is not built and has different
  defaults.** It requires an explicit `btrain solo on` with an expiry (FR-1),
  waits 4 hours for a human tier, and retries an unavailable tier after 6
  hours (FR-8).

## Terms

- **Lab**: a lowercase label for the organization that trained a model, for
  example `anthropic`, `openai`, `google`. Compared as an exact string.
- **Author set of a commit range**: the labs of every agent that committed in
  that range. For the owner's work this is the lane's author history
  (`authorHistorySinceClaim`). For a reviewer fix it is the reviewer.
- **Other-lab agent**: a configured agent with a known lab that is not in the
  author set of the range under review.
- **Review attempt**: one dispatch of one reviewer for one lane at one head
  commit.
- **Review tier**: `other-lab` or `same-lab`, recorded per attempt.

## How it works

### Rule 1 flow

1. **Claim.** `handoff claim` picks the first available other-lab agent as
   reviewer. An explicit `--reviewer` that names a same-lab agent is rejected
   while an other-lab agent is configured (FR-3).
2. **Request.** `handoff update --status needs-review` records a review
   request for the current head and starts the 15-minute window.
3. **Attempts.** btrain dispatches other-lab reviewers in order. A reviewer
   that is out of quota, unauthenticated, or refused by policy is skipped at
   once. A reviewer that picks the lane up is recorded, and the lane shows
   as `in-review` from then on (FR-5). A reviewer that does not pick up
   within 5 minutes, or goes silent for 5 minutes afterwards, is stopped and
   the next one is tried. When the list is exhausted before the window ends, btrain probes
   it again every 5 minutes.
4. **Verdict.** The first accepted `handoff resolve` or
   `handoff request-changes` for the current head ends the request.
5. **Fallback.** At 15 minutes with no verdict and no other-lab reviewer
   making progress, btrain reassigns the lane to a same-lab agent that is not
   in the author history, dispatches it in a fresh session, and records
   `review tier: same-lab` with the reason and the attempts that failed.

### Rule 2 flow

1. The reviewer finds a defect that meets the fix limits (FR-11).
2. The reviewer commits the fix on the lane's branch, inside the lane's
   locked files, and runs `btrain handoff fix`.
3. The lane moves to the new status `fix-confirmation`. The owner is the
   next actor.
4. The owner reads only the fix range and runs `btrain handoff confirm-fix`.
   The lane moves to `ready-for-pr` (PR flow) or `resolved` (no PR flow).
5. If the owner disagrees, the owner amends or reverts and moves the lane
   back to `needs-review`. That is the normal bounce, started by the owner.

```
needs-review ──reviewer: handoff fix──▶ fix-confirmation
fix-confirmation ──owner: handoff confirm-fix──▶ ready-for-pr | resolved
fix-confirmation ──owner: handoff update --status needs-review──▶ needs-review
```

### Configuration

```toml
[agents.labs]
"claude" = "anthropic"
"claude-reviewer" = "anthropic"
"codex" = "openai"
"codex-reviewer" = "openai"
# A multi-model harness has no default. Name the lab of the model it is
# pinned to.
"cursor-gemini" = "google"

[review]
other_lab_window = "15m"   # no same-lab review before this has passed
silence_limit = "5m"       # no progress for this long ends one attempt
attempt_max = "45m"        # hard cap on one attempt that keeps progressing
reviewer_order = []        # optional preference among other-lab agents

[review.fixes]
enabled = true
max_files = 3
max_changed_lines = 60
max_rounds = 2

[pr_flow]
bot_pending_timeout = "30m"   # new key: wait before asking the next bot

[pr_flow.bots.gh-codex]
lab = "openai"                # new key
```

## Functional Requirements

### Rule 1: cross-lab review

#### FR-1: Every agent has a declared lab

Each configured agent's lab comes from, in order: an explicit `[agents.labs]`
entry, else the basename of the executable in its `[agents.runners]` value
when that executable runs one lab's models only (`claude` is `anthropic`,
`codex` is `openai`, `gemini` is `google`). A multi-model harness (`agent`,
`cursor-agent`), a wrapper (`npx ...`, `env ...`, a shell script), and a
`notify` runner yield no lab. The agent name is never used to infer a lab.

An agent with no lab is never an other-lab reviewer. `btrain doctor` lists
the resolved lab of every agent and warns for each agent that has none. It is
a warning, not an error, so existing repositories keep working.

This is spec 017 FR-9 with four changes: the table is named for what is
compared; an executable that can run several labs' models never yields a
default; a missing lab is a `btrain doctor` warning where 017 made it an
error; and a `notify` runner has no lab where 017 gave it the family
`human`.

#### FR-2: Other-lab reviewer first

Reviewer inference at claim and at review request picks from configured
agents in this order:

1. `other-lab`: agents with a known lab outside the author set, with a `cli`
   runner, in `[review].reviewer_order` and then configured order.
2. `same-lab`: agents not in the lane's author history, with a `cli` runner.

`[agents].reviewer_default` applies only when it names an other-lab agent
for the lane's owner.

#### FR-3: An explicit same-lab reviewer needs a reason

`handoff claim --reviewer <agent>` and `handoff update --reassign` are
rejected when the named reviewer is same-lab and at least one other-lab agent
with a `cli` runner is configured. The error names the other-lab agents and
the fix: name one of them, pass `--reviewer any-other`, or attach a
human-confirmed override (`btrain override grant --action same-lab-review
--lane <id>`, a new override action added by this spec). This keeps spec 015
FR-9 intact: inference still never replaces
a valid reviewer, and "valid" now includes the lab rule.

#### FR-4: The 15-minute window

The window starts when the lane enters `needs-review` at a head commit. A
new head commit by the owner starts a new window. A commit by the reviewer of
the active attempt does not: it is a fix in progress (FR-11), and the attempt
keeps the head it was dispatched for.

During the window btrain tries other-lab reviewers one at a time:

- An attempt that fails its probe, or ends with a configured quota or
  authentication signal, is `tool_unavailable`. A provider refusal is
  `policy_blocked`. btrain tries the next reviewer immediately. These are the
  failure classes of spec 017 FR-8.
- An attempt with no pickup (FR-5) within `[review].silence_limit` of its
  dispatch, or with no progress signal for `silence_limit` after pickup, is
  `unresponsive`. btrain stops its runner and tries the next reviewer.
- A progress signal is the pickup itself, output on the runner's stream, or
  a lane-scoped btrain command run under the reviewer's identity.
- Any other non-zero exit is `failed`. It is reported as a review failure and
  the next reviewer is tried.
- When every other-lab reviewer has been tried, btrain probes the list again
  at each `silence_limit` interval until the window ends.

btrain assigns a same-lab reviewer only when all three are true: the window
has passed; every configured other-lab reviewer has had at least one attempt
in this request, or failed its probe; and no other-lab attempt has shown
progress within the last `silence_limit`. An other-lab reviewer that is still
making progress when the window ends keeps the lane, up to
`[review].attempt_max` for that attempt. When an attempt is stopped at
`attempt_max`, any other-lab reviewer not yet tried is tried before the
same-lab tier.

**What keeps the clock running.** btrain has no daemon. The attempt loop runs
in the process that requested the review, as reviewer dispatch does today,
and that command stays in the foreground until a verdict or the same-lab
dispatch. Attempt records are persisted (FR-5), so `btrain loop --lane <id>`
or a running Slack listener (spec 025) can continue a request whose process
ended. With no process running, nothing advances. The next process to pick
the request up applies the three conditions above. Elapsed wall time alone
never sends a review to the same lab.

When no other-lab agent with a `cli` runner is configured at all, there is
nothing to wait for. The same-lab tier applies at once with reason
`no-other-lab-configured`, and `btrain doctor` warns on every run.

#### FR-5: Attempts are recorded and verdicts are bound to them

Before each dispatch btrain persists an attempt record: attempt id, lane,
reviewer, tier, head commit, and request time. A verdict is accepted only
from the reviewer of the lane's active attempt, and:

- `handoff resolve` and `handoff request-changes` require the lane's head to
  equal the attempt's head. A reviewer that has committed since then cannot
  resolve. Its exits are `handoff fix`, or removing its commits.
- `handoff fix` requires `fixBase` to equal the attempt's head (FR-11).

A duplicate verdict changes nothing.

**Pickup.** The attempt records a pickup time the first time its reviewer
runs `btrain handoff --lane <id>` under its own verified identity. A read by
any other process, such as the Slack listener of spec 025, is not a pickup. Every dispatched
reviewer already runs that command first, so pickup needs no extra step from
the agent. From pickup until the verdict, `btrain handoff`, `btrain status`,
and the dashboard show the lane as `in-review`, with the reviewer and the
time since pickup. Before pickup they show `needs-review` with the reviewer
that was dispatched and how long ago.

`in-review` is a display state derived from the attempt record. The stored
lane status stays `needs-review`, so the transition table, the hooks, and the
formal model are unchanged by pickup. Pickup says a reviewer is working; it
changes nothing about who may move the lane or which locks are held. If the
attempt is later marked `unresponsive`, the display returns to `needs-review`
with no transition to undo.

The same record applies to a fix confirmation (FR-12): the lane shows as
`confirming-fix` once the owner picks it up.

This requires three spec 015 legacy rows to be enforced. While L8 and L15
are advisory, a verdict from an actor that is not the recorded reviewer is
accepted with an advisory. While L4 is advisory, `btrain handoff update
--status ready-for-pr` moves a lane into the PR flow with no verdict at all;
the caller rejects only `--status resolved` today. Until L4 stops accepting
`ready-for-pr`, `pr-review`, and `ready-to-merge` as targets, and L8 and L15
are retired, the invariant in the Decision does not hold.

#### FR-6: Late verdicts

A verdict from an other-lab attempt that was marked `unresponsive`:

- **Lane still `needs-review` at the same head.** The other-lab verdict
  wins. btrain restores that reviewer (FR-7, reason `other-lab-recovered`),
  stops the same-lab attempt, and applies the verdict.
- **Lane has moved on, or the head changed.** btrain applies no transition.
  It records a `late-review` event with the verdict and shows it in
  `btrain handoff` and `btrain doctor`. A late request for changes blocks
  `btrain pr create` until the owner acknowledges it with `btrain handoff update --lane <id>
  --ack-late-review`. Once a PR exists, a late review is a warning only.

#### FR-7: Fallback is a system reassignment

Changing the lane's reviewer for fallback or recovery is spec 015 row 20
(Reassign) with actor `system`. The event records the reason
(`other-lab-unavailable`, `other-lab-recovered`, `no-other-lab-configured`),
the previous reviewer, the new reviewer, and the attempts that led to it.
Spec 017 FR-7 proposes the same designation. The row's existing guards still
apply: owner and reviewer differ, the reviewer is not in the author history,
and no PR is linked.

#### FR-8: Same-lab reviews run in a fresh session and are labeled

A same-lab reviewer runs under spec 017 FR-3: a fresh model session, the
per-runner fresh-session flags, and the environment allowlist. Its identity
is a distinct configured agent such as `claude-reviewer`. Spec 017's
`<runtime>#review` identities are needed only in a repository that configures
a single agent, and are a later phase of this spec.

`btrain handoff`, `btrain status`, the dashboard, and PR bodies written by
`btrain pr create` show the review tier, the fallback reason, and the
reviewer for every lane.

A second `request-changes` from a same-lab reviewer on the same lane does not
start a third same-lab round. The lane stays `needs-review` with an
`escalation required` warning until an other-lab reviewer or a human takes it
(spec 017 FR-10).

#### FR-9: The PR bot gate is lab-aware

Each `[pr_flow.bots.<id>]` entry gains an optional `lab`. For a lane to reach
`ready-to-merge`, at least one configured bot whose lab is outside the lane's
author set must be clear on the current head. A bot from an author's lab can
stay in `required_bots`, but it does not satisfy this requirement.

When no bot with an outside lab is configured, the gate behaves as it does
today and `btrain doctor` warns.

A silent bot is answered with another bot, never with an exemption. When the
first outside-lab bot has not reviewed the current head within
`[pr_flow].bot_pending_timeout`, btrain requests the next configured
outside-lab bot. That key is new in this spec, with a default of 30 minutes.
Spec 017 OQ-1 proposed the name, and it exists nowhere in the code today. A clear from any one of them satisfies the
requirement. When every outside-lab bot is silent past the window, the lane
stays `pr-review` and the problem escalates to a person (spec 024 FR-15). A
repository that wants this protection configures at least two outside-lab
bots, and `btrain doctor` warns when it has only one.

### Rule 2: reviewer-applied fixes

#### FR-10: New status and commands

`fix-confirmation` is a new active status. Locks are retained. The owner is
the responsible actor.

- `btrain handoff fix --lane <id> --summary <text> --actor <reviewer>`:
  the reviewer's approval of the owner's work at the reviewed head, plus the
  fix commits that follow it. Moves `needs-review` to `fix-confirmation`.
  btrain records `fixBase` (the reviewed head) and `fixHead`.
- `btrain handoff confirm-fix --lane <id> --summary <text> --actor <owner>`:
  the owner's approval of `fixBase..fixHead`. Moves `fix-confirmation` to
  `ready-for-pr` when PR flow is enabled, else to `resolved` and releases
  locks.
- `btrain handoff update --lane <id> --status needs-review --actor <owner>`
  from `fix-confirmation`: the owner changed or reverted the fix. The usual
  review-context and diff guards apply, and a new review window starts.

`btrain handoff` guidance for `fix-confirmation` tells the owner to review
`git diff <fixBase>..<fixHead>` only, and prints both exits.

#### FR-11: When a reviewer may fix

`handoff fix` is accepted only when all of these hold. btrain checks each one.

- The review tier of the active attempt is `other-lab`. A same-lab reviewer
  cannot apply fixes.
- `[review.fixes].enabled` is true.
- `fixBase` is the head of the active attempt, `fixHead` descends from it,
  and every commit in the range was made after the attempt started.
- Every path changed in the range is in the lane's locked files.
- The range changes at most `max_files` files and `max_changed_lines` lines.
- The range removes or changes no existing line in a test file or test
  configuration. Adding tests is allowed. The weakened-test rules of
  `btrain review code` report no hard violation on the range.
- The lane has had fewer than `max_rounds` reviewer fixes since its claim.

Reviewer guidance adds the judgment conditions that btrain cannot check: fix
only when the defect and its correction are unambiguous and the reviewer is
confident in the finding. A design disagreement, an unclear requirement, or
any doubt goes through `handoff request-changes`. The owner's right to amend
(FR-10) is the backstop when a reviewer misjudges.

`handoff fix` is all or nothing. A reviewer with any blocking finding that it
did not fix uses `handoff request-changes` and pushes no commits.

#### FR-12: The owner confirms

Only the lane's owner confirms a fix. The owner did not write the fix range
(FR-13, FR-14), its lab differs from the fixer's because fixes are limited
to the other-lab tier (FR-11), and the owner knows the intent.

The confirmation clock starts when the lane enters `fix-confirmation`. When
the owner's runtime is unavailable, or has not picked the lane up within
`[review].other_lab_window`, the lane stays `fix-confirmation` and the
problem escalates to a person (spec 024 FR-15). No other agent confirms in
this version. Keeping the confirmer inside the lane's two agents keeps the
model's `LastActorIsLaneAgent` invariant true.

#### FR-13: Fix authors are tracked apart from lane authors

`handoff fix` records the commits of the fix range, and the reviewer that ran
it, in the lane's `fixAuthors`, not in its author history. Spec 005 FR-5
keeps rejecting any reassignment that makes a lane author the reviewer. The
reviewer that fixed stays eligible to review the owner's later changes on
the same lane.

btrain cannot prove which agent made a commit: every agent on a machine
commits as the same git user. Authorship of a range rests on the lane
protocol, as it does today for the owner's work. During `needs-review` only
the active reviewer may commit (FR-14), and by running `handoff fix` the
reviewer declares every commit in the range as its own. An owner commit
slipped into the range is a protocol violation that the hook blocks and that
`git commit --no-verify` can bypass. That bypass exists today and is a known
limit of hook enforcement.

#### FR-14: Writes during review

While a lane is `needs-review`, only the reviewer of the active attempt may
commit to the lane's locked files. While it is `fix-confirmation`, only the
owner may. The managed pre-commit hook enforces both.

## Non-Goals

- Moving lane state off the local machine. Storage is unchanged.
- A human review tier with its own timeout. A human can always act through
  the existing commands. Spec 017's human tier is not adopted here.
- Detecting which model a harness really runs. `[agents.labs]` is the
  operator's assertion, and `btrain doctor` prints it.
- Partial fixes: a reviewer fixing some findings and returning the rest. See
  follow-ups.
- Fixes applied by GitHub bots, for example Cursor Bugbot's autofix pushing
  to the PR branch. Keep those off. A bot's commit on a lane branch has no
  confirmation path in this spec.
- Adding new review bots or runners. PR #113 adds the Cursor Agent runner;
  this spec only requires that each such agent declare its lab.

## Relation to other specs

- **Spec 002**: `CLI Commands` gains `handoff fix` and `handoff confirm-fix`.
  `PR-flow states and actors` gains the `fix-confirmation` to `ready-for-pr`
  entry and the FR-9 bot rule. Lock rules are unchanged: the new status
  retains locks.
- **Spec 005**: `Proposed Status Model` gains `fix-confirmation`. FR-5 gains
  system reassignment (FR-7) and `fixAuthors` (FR-13). The
  `changes-requested` loop is unchanged and stays the path for every finding
  outside FR-11.
- **Spec 015**: three new rows and one changed row (see the declaration
  below). FR-9 and FR-12 are preserved: labs, attempts, and fix-range facts
  are gathered by the caller and passed to the gate as guard inputs. The gate
  never reads the clock.
- **Spec 017 and its plan, spec 019**: superseded by this spec (decided
  2026-11-23). This spec takes FR-3 (fresh session), the FR-8 failure
  classes, FR-5 (visibility), and the FR-10 escalation. It replaces the FR-1
  toggle, the FR-8 timings, FR-9's table name, and OQ-1 (FR-9 here). What is
  left of 017 and 019 is listed under "Carried over from specs 017 and 019".
- **Lane A, local review before bot review** (unmerged): this spec assumes
  its gate, so a bot review cannot stand in for the local cross-lab review.
- **`CLAUDE.md` Handoff Gate**: "One model writes, the other reviews" becomes
  "one lab writes, another lab reviews", with the two declared exceptions:
  the labeled same-lab fallback, and reviewer fixes confirmed by the owner.
  The managed block is regenerated in every consuming repository, so that
  edit ships with the implementation lane and its PR must call it out.

## Formal-Impact Declaration

**Semantic impact.** Implementation follows prose, model, code (spec 015
FR-10) and runs TLC, the formal harness, and conventional tests.

Transition-table changes:

| Row | Action | Event | From | To | Actor | Guard | Locks |
|---|---|---|---|---|---|---|---|
| new | ReviewerFix | `handoff fix` | `needs-review` | `fix-confirmation` | reviewer | active other-lab attempt; `fixBase` equals its head; fix limits pass; records the reviewer as approver | retain |
| new | ConfirmFix | `handoff confirm-fix` | `fix-confirmation` | `ready-for-pr` or `resolved` | owner | head equals `fixHead`; a recorded reviewer approval exists; owner not a fix author | retain or release |
| new | AmendFix | `handoff update --status` | `fix-confirmation` | `needs-review` | owner | review context and diff | retain |
| 1 | Claim | unchanged | unchanged | unchanged | unchanged | adds the lab rule of FR-3 | unchanged |
| 3, 4, 5 | verdict rows | unchanged | unchanged | unchanged | reviewer of the active attempt | adds attempt and head match (FR-5) | unchanged |
| 20 | Reassign | unchanged | unchanged | unchanged | adds `system` | reason recorded (FR-7) | unchanged |
| L4, L8, L15 | legacy | unchanged | unchanged | L4 loses `ready-for-pr`, `pr-review`, and `ready-to-merge` as targets | unchanged | L8 and L15 retired, L4 narrowed, before this spec's rows are enforced (FR-5) | unchanged |

`fix-confirmation` joins the active statuses, so rows 13, 17, and 18 cover
it. It is not a PR-flow status.

Model changes in `specs/tla/LaneLock.tla` and `lane-lock-model.mjs`:

- Add the status and the three rows. `ConfirmFix` is the primary row for
  `fix-confirmation` (spec 015 requires one primary row for each status), so
  `getPrimaryTransition` and `getLoopActorForState` route the status to the
  owner.
- `ReviewerFix` sets the lane's approver to the reviewer. The approval covers
  the owner's work at `fixBase`.
- Restate `PrFlowEntryByReviewer`. Today it requires every entry to
  `ready-for-pr` to come from `needs-review` with the reviewer as approver.
  It must also allow entry from `fix-confirmation` when the approver recorded
  by `ReviewerFix` is the reviewer and is not the owner.
- Add `fixAuthors` as a lane-indexed set and the invariant `FixSeparation`:
  the agent that confirms a fix is not in that lane's `fixAuthors`.
- `ReviewerSeparation`, `AuthorSeparation`, and `LastActorIsLaneAgent` are
  unchanged and must still hold.
- Labs, the 15-minute window, pickup, and progress signals are not modeled.
  `in-review` and `confirming-fix` are display states, not statuses. A
  fallback enters the model as a `system` Reassign, the way spec 014 treats
  dispatch as an external event.

Pinned prose that the implementation lane must edit and re-pin: spec 002
`CLI Commands` and `PR-flow states and actors`; spec 005 `Proposed Status
Model` and `FR-5`.

This draft edits no pinned prose. `python3 scripts/tla_pin.py --check`
reports 1 pin clean before and after it.

## Acceptance Criteria

Rule 1:

- With `claude` (anthropic) as owner and `codex-reviewer` (openai) and
  `claude-reviewer` (anthropic) configured, a claim with no `--reviewer`
  records `codex-reviewer`.
- `handoff claim --reviewer claude-reviewer` by owner `claude` is rejected
  with the fix text of FR-3, and succeeds with a `same-lab-review` override.
- A reviewer runner that exits with a configured quota signal is recorded
  `tool_unavailable`, and the next other-lab reviewer is dispatched in the
  same request without waiting.
- With every other-lab reviewer silent, no same-lab dispatch happens before
  15 minutes. At 15 minutes the lane's reviewer is a same-lab agent outside
  the author history, the event carries reason `other-lab-unavailable`, and
  `btrain handoff` shows `review tier: same-lab`.
- An other-lab reviewer that emits progress at minute 14 is not replaced at
  minute 15. It is replaced at `attempt_max`.
- After the dispatched reviewer runs `btrain handoff --lane <id>`, `btrain
  status` shows the lane as `in-review` with that reviewer, and the stored
  status is still `needs-review`.
- A reviewer that never picks up is marked `unresponsive` at `silence_limit`
  and the next reviewer is dispatched. A reviewer that picks up and then goes
  silent is marked `unresponsive` and the lane shows `needs-review` again.
- A verdict from a reviewer that is not the active attempt's reviewer, or for
  a head that is not the attempt's head, changes no lane state.
- A late other-lab `resolve` while the lane is still `needs-review` at the
  same head moves the lane and records `review tier: other-lab`.
- With zero other-lab agents configured, the same-lab tier applies at once,
  reason `no-other-lab-configured`, and `btrain doctor` warns.
- A lane authored by `codex` does not reach `ready-to-merge` on a `gh-codex`
  clearance alone when a bot with another lab is configured.
- An agent whose runner is `agent -p` and has no `[agents.labs]` entry is
  never chosen as an other-lab reviewer, and `btrain doctor` names it.

Rule 2:

- A two-line fix inside the locked files by an other-lab reviewer, followed
  by `handoff fix`, moves the lane to `fix-confirmation` with `fixBase` and
  `fixHead` recorded.
- `handoff fix` is rejected, each with its own message, when: the tier is
  `same-lab`; a changed path is outside the locked files; the size limits are
  exceeded; an existing test line is changed or removed; the round limit is
  reached.
- `handoff confirm-fix` by the owner moves the lane to `ready-for-pr`. The
  same command by the reviewer that wrote the fix is rejected.
- A commit after `fixHead` makes `confirm-fix` fail, and the owner's
  `handoff update --status needs-review` succeeds and starts a new window.
- The reviewer that applied a fix can still review the owner's later changes
  on that lane. A reassignment that makes a lane author the reviewer is still
  rejected.
- TLC passes with `FixSeparation` added and `PrFlowEntryByReviewer`
  restated, and the formal harness reports no new candidate finding.
- `btrain handoff update --status ready-for-pr` is rejected for every actor.
- After the reviewer commits during `needs-review`, `handoff resolve` is
  rejected and `handoff fix` is accepted.
- With the first other-lab reviewer silent past 15 minutes and a second one
  never tried, no same-lab reviewer is assigned until the second has had an
  attempt.
- With the owner's runtime unavailable, a lane in `fix-confirmation` stays
  there and escalates. No other agent can run `handoff confirm-fix`.

## Follow-ups

- Partial fixes: let `handoff request-changes` carry a confirmed-on-return
  fix range, so the owner handles the reviewer's small fixes and the
  remaining findings in one hop.
- Choose and configure the second outside-lab PR bot that FR-9 calls for,
  for example Cursor Bugbot or Claude Code Review.
- Measure the change: elapsed time from `needs-review` to first verdict, the
  share of lanes reviewed at each tier, the share of reviews closed by
  `handoff fix`, and how often an owner amends a reviewer's fix.

## Carried over from specs 017 and 019

Spec 017 and its implementation plan (spec 019) are superseded by this spec,
with one exception. These parts are not covered above:

- **Spec 019 Workstream 0 stays in force.** It completes spec 015 row 4
  enforcement, retires legacy row L8, and adds the regression that rejects
  an owner's approval from `needs-review`. Spec 015 names it as the work
  that started L8's advisory period. It is a prerequisite of FR-5 here, and
  this spec extends it to retire L15 and to narrow L4 (FR-5). Until all three
  are enforced, the invariant in the Decision does not hold.

- **Single-agent repositories.** A repository that configures one agent has
  no distinct same-lab identity. Spec 017's `<runtime>#review` identity (its
  FR-2), with lane-scoped verification, fills that gap. It becomes a later
  phase of this spec.
- **Taking over a lane from an unavailable runtime.** Spec 017's
  `solo adopt` (its FR-6) reassigns the owner of a lane whose runtime is
  down. This spec only reassigns reviewers. It becomes a later phase too.
- **The repository-wide toggle** (017 FR-1) is dropped. Fallback here is per
  lane, automatic, and recorded.
- **The human review tier** (017 FR-8 tier 2) is dropped. A person is brought
  in by escalation (spec 024 FR-15), not by a timed tier.

## Decisions (2026-11-23, Brian)

1. A reviewer from another lab that keeps showing progress holds the lane
   past 15 minutes, up to 45 (FR-4).
2. Fix limits are 3 files, 60 changed lines, and 2 rounds per claim (FR-11).
3. A late request for changes from another lab blocks `btrain pr create`
   until the owner acknowledges it, and is a warning once a PR exists (FR-6).
4. `in-review` is a display state, not a stored status (FR-5).
5. Spec 017 is folded into this spec.
6. A silent outside-lab bot is answered with a second outside-lab bot, never
   with an exemption (FR-9).

## Open questions

None.
