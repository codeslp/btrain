# 017 — Solo Mode: Internal Subagent Review When Peers Are Unavailable

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-09-01

## Decision

Add a repo-level **solo mode** to btrain. When it is on, the lane, lock,
review, and PR protocol runs unchanged, but every role that would normally go
to a different agent runtime is filled by a **fresh-context subagent of the
runtime that is available**. The subagent acts under a distinct btrain
identity, so owner/reviewer separation stays an enforceable rule rather than a
waived one.

Solo mode changes one governing rule and leaves the rest of the protocol
intact. Nothing about what a handoff must contain, what a reviewer must
check, when locks release, or how a PR terminates a lane is relaxed. The rule
that changes, explicitly and only while solo mode is on: btrain's handoff gate today says
"one model writes, the other reviews" (`CLAUDE.md`, Handoff Gate). Solo mode
migrates that rule to "one context writes, a different context reviews, with a
different model preferred". While solo mode is on, the same model may fill
both roles only when no other model family or human is available (FR-8), and
every such review is labeled so the weaker guarantee is visible. The
same-model tier is last and labeled because it gives something up: a
different model brings decorrelated blind spots (training, tool habits, the
same misreading of a spec), and a fresh session of the same model removes
self-approval but does not restore that independence. This is a declared,
time-boxed exception with an audit trail.

Dependencies: rows and invariants cited below live in spec 015 (PR #37) and
`specs/tla/LaneLock.tla` (PR #35). Until those merge, the references point
at the PRs; this spec does not merge before them. One further prerequisite
for the separation claim below: today `resolveHandoff` compares no actor
(spec 015 legacy row L8), so owner/reviewer separation is enforced only on
`handoff request-changes` (`core.mjs:5595-5600`). Solo mode's identity rule
becomes enforceable at approval time only once spec 015 row 4 (reviewer,
distinct from owner, enters `ready-for-pr`) is implemented and L8 retired.
Until then this spec's guarantee is: separation enforced on request-changes,
labeled but not enforced on approval.

What is not being done: no new statuses, no new lock semantics, and no change
to the formal model's invariants. This spec designates one transition that
spec 015 currently leaves undecided: expiry restoration from
`ready-to-merge` to `pr-review`. The implementation must add that transition
to the spec 015 ledger and the formal model. Solo mode is off by default and
has an expiry.

## Summary

On 2026-09-01 the codex runtime ran out of tokens with two of its lanes in
`changes-requested` and two of claude's lanes waiting on codex review. The
operator's only options were to wait, or to reassign every role to claude and
waive reviewer separation lane by lane. The second option worked but left no
trace in the protocol of why the rule was waived, put the same context that
wrote the change in charge of reviewing it, and required an operator to
hand-edit lane roles.

The handoff rule does two jobs: it keeps **the context that wrote a change
from approving it**, and it brings **a different model's judgment** to the
review. Two runtimes deliver both. A fresh context in the same runtime
delivers only the first. Solo mode keeps the first job intact at every tier,
prefers tiers that also deliver the second, and makes the loss explicit,
auditable, and reversible when only the last tier is left.

## How it works

1. **Enable.** `btrain solo on --reason "codex out of tokens" --until <ISO
   date>` records a solo-mode event in canonical workflow history with the
   actor, the reason, and the expiry. `btrain solo off` ends it. `btrain
   handoff`, `btrain status`, and the dashboard show `mode: solo` while it is
   on. Configuration lives in `.btrain/project.toml`:

   ```toml
   [solo]
   enabled = true
   runtime = "claude"
   until = "2026-09-08T00:00:00Z"
   reason = "codex out of tokens"
   ```

2. **Identities.** The available runtime gets role-suffixed identities:
   `claude` (the writer) and `claude#review` (the reviewer subagent). The
   suffix form `<agent>#<role>` is reserved by this spec. `#review` is the
   only suffix in the first version. `resolveVerifiedActor` accepts a suffixed
   identity when `BTRAIN_AGENT` carries it and solo mode is on. Identities
   are distinct strings for every separation check (spec 015 rows 2, 3, 4,
   5; `ReviewerSeparation` in `LaneLock.tla`), and the same runtime for
   runner resolution.

3. **Claim.** `handoff claim` in solo mode infers the reviewer as
   `<runtime>#review` when no distinct configured agent has an available
   runner. `inferPeerReviewer` treats `#review` identities as candidates only
   in solo mode.

4. **Dispatch.** `handoff update --status needs-review` dispatches the
   reviewer runner as it does today (`dispatchNeedsReviewReviewer` in
   `core.mjs`; routing per spec 005 FR-11), but with
   `BTRAIN_AGENT=<runtime>#review`, a fresh process, no shared conversation
   or scratch state, and the review prompt that the reviewer role receives
   in multi-agent mode. `btrain loop` selects the same identity when the
   lane's status routes to the reviewer.

5. **Review.** The subagent reviews from the handoff packet and the diff and
   ends with `handoff resolve` or `handoff request-changes` under its own
   identity. Both commands record `mode: solo` in the event. Every gate that
   applies to a peer reviewer applies to the subagent: reviewer context must
   be complete, the diff must be real, and the reviewer must not be the owner
   wherever that check exists today (see the prerequisite in the Decision).

6. **PR flow.** Unchanged. The GitHub bot list in `[pr_flow].required_bots`
   is not touched by solo mode. If a required bot is the runtime that is
   unavailable, the operator edits `required_bots` deliberately; solo mode
   does not do it for them.

7. **Expiry.** When `until` passes, solo mode stops assigning `#review`
   identities to new claims and new handoffs; new claims infer a distinct
   configured agent again. Lanes already assigned a `#review` reviewer are
   grandfathered: `resolveVerifiedActor` keeps accepting that identity for
   those lanes until each resolves, and the runner map keeps resolving it, so
   an active lane never loses its reviewer or its locks at expiry. `btrain
   doctor` warns while solo mode is on, lists grandfathered lanes after it
   ends, and reports how many lanes were reviewed under it.

## Functional Requirements

### FR-1: Explicit, audited toggle

Solo mode is entered and left through `btrain solo on|off`. Both write a
workflow event with actor, reason, and expiry. An `until` value is required.
Solo mode never turns itself on.

### FR-2: Distinct identities, same runtime

The reviewer subagent acts as `<runtime>#review`. Every owner/reviewer
separation check compares identity strings and therefore holds wherever such a
check exists (see the prerequisite in the Decision). The reviewer runner is
derived from the base runner (FR-3); there is no separate runner entry for the
`#review` identity, so `btrain agents set` cannot prune it and FR-2 cannot
drift from the base runner. `#review` identities never enter `[agents].active`
or the configured-agent roster, so runtime detection (which strips the token
`review` when tokenizing) is unaffected. A `#review` identity assigned to a
lane while solo mode was on stays valid for that lane after solo mode ends
(grandfathering); only new assignments stop.

Verification of a `#review` actor is lane-scoped. `resolveVerifiedActor`
gains the lane (from `--lane` or `BTRAIN_LANE`) and accepts `<runtime>#review`
only when solo mode is on, or when that lane records it as reviewer. In every
other case the identity is rejected with the fix "solo mode is off and lane
<id> has no #review assignment".

### FR-3: Fresh context

The reviewer subagent runs in a fresh model session, not merely a new OS
process, inside the repository (it must read the diff and run `btrain`
commands there). The reviewer runner is the base runner from
`[agents.runners]` normalized per runner by btrain's runner table; no entry is
used verbatim and no dedicated `#review` entry exists:

- `claude`: run in print mode with `--no-session-persistence`; reject
  `--resume`, `-r`, `--continue`, `-c`, `--fork-session`, `--from-pr`.
- `codex`: run `exec --ephemeral`; reject the `resume` and `fork` subcommands
  and any `--session*` flag. Note `-c` is codex's `--config` and stays
  allowed.
- `gemini`: no persistent-session flag is needed; reject `-r` and
  `--resume`; btrain supplies a fresh random `--session-id` per dispatch so a
  workspace-keyed store cannot resume.
- any other runner: no dispatch until the runner table names its fresh and
  reject flags; `btrain doctor` reports the gap.

The reviewer's environment is an allowlist, never the writer's environment.
Always included: everything `buildLoopRunnerEnv` sets today (`BTRAIN_AGENT`,
`BRAIN_TRAIN_AGENT`, `BTRAIN_LANE`, `BTRAIN_LANE_LOCKED`, `BTRAIN_LOOP_ACTIVE`,
`BTRAIN_REPO`), `PATH`, `HOME`, `TMPDIR`, `TERM`, `LANG`, `SHELL`, `USER`,
proxy variables, any name ending in `_API_KEY` or `_API_TOKEN`, and the
runner configuration names `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_APPLICATION_CREDENTIALS`, plus names listed in `[solo].env_allow`.
Removed: any name matching `*SESSION*` that is not in the allowlist above, and
names in `[solo].env_deny`. The writer's transcript, scratch files, and
conversation are never passed.

### FR-4: No protocol relaxation

Every gate that applies to a peer reviewer applies unchanged: reviewer-context
completeness, reviewable diff, `pre-handoff`, `btrain review code`, PR-flow
retention, and the spec 015 transition rules. A solo review that fails a gate
fails exactly as a peer review would.

### FR-5: Visible everywhere

`btrain handoff`, `btrain status`, `bth`, the dashboard, and PR bodies created
by `btrain pr create` show that the lane was reviewed in solo mode and by which
identity.

### FR-6: Reassignment is a command, not a hand edit

`btrain solo adopt --lane <id>` reassigns a lane whose owner or reviewer is an
unavailable runtime: the owner becomes the available runtime, the reviewer is
chosen by the same FR-8 preference order a claim uses (a different model
family first, then an opted-in human, then `<runtime>#review`), locks
re-register under the new owner, and the event records the previous roles and
the review tier that applied.

### FR-7: Model compatibility

`LaneLock.tla` and `lane-lock-model.mjs` treat identities as opaque agents. A
`#review` identity is one more element of `Agents`. No invariant changes.
Spec 014 formal impact for enabling solo mode: none. Formal impact for FR-6
(`adopt` changes owner and reviewer of an active lane) and for FR-8 tier
fall-through (the system changes a lane's reviewer after a probe failure,
`tool_unavailable`, or a human timeout): semantic, because spec 015 row 20
(Reassign) is undesignated. This spec designates row 20 for exactly those two
cases: actor `lane-agent` for `adopt`, actor `system` with the reason recorded
for fall-through. Both are explicit reassignments in the sense of spec 005
FR-5, which otherwise preserves the reviewer identity.

### FR-8: Different model first

When solo mode assigns a reviewer, it tries tiers in order and records which
one applied on the lane and in the workflow event, rendered as `review tier:
other-model | human | same-model`:

1. A configured agent of a different model family (FR-9) whose runner is
   operationally available.
2. A human, only when the repository opts in with `[solo].human_reviewer =
   "<agent with a notify runner>"`. A `notify` runner executes nothing and can
   never fail a probe, so it is not "available" by default. When opted in, the
   lane waits `[solo].human_timeout` (default 4h) for a `request-changes` or
   `resolve` from that identity, then falls to tier 3 with the timeout
   recorded.
3. The same-runtime `<runtime>#review` subagent. This is the explicit
   exception this spec declares; it is never silent.

Operational availability is decided per runner from the runner table, not from
executable presence. Each runner entry names: a presence probe (`<runner>
--version`), an optional cheap authenticated probe command, and the exit codes
and stderr patterns that mean quota or authentication failure. A dispatch that
ends with one of those signals is classified `tool_unavailable`; a provider
refusal pattern is `policy_blocked` (the spec 014 failure classes, which this
spec brings into the dispatch classifier alongside `completed`, `failed`, and
`timed-out`). Any other non-zero exit is a real review failure and is reported
as such, not as unavailability.

A tier that fails its probe or ends `tool_unavailable` or `policy_blocked` is
marked unavailable, the reason is recorded on the lane, and btrain
immediately tries the next tier. An unavailable tier is retried after
`[solo].retry_after` (default 6h) or on `btrain solo retry`. When every tier
is unavailable the lane stays `needs-review` with a `no reviewer available`
warning in `btrain handoff` and `btrain doctor`, and new claims still succeed
with the reviewer marked `pending`; nothing is silently approved.

### FR-9: Model family is configured, not inferred from names

FR-8 compares model families, so btrain needs a trustworthy source for them.
Each configured agent's family comes from, in order: an explicit
`[agents.families]` entry, else the basename of the executable in its
`[agents.runners]` value only when that basename is a known runtime
(`claude`, `codex`, `gemini`). A wrapper or launcher (`npx codex`,
`env ... codex`, a shell script) yields no family, and `btrain doctor` errors
until `[agents.families]` names it explicitly; the agent name is never used as
a family. Two identities with the same family are the same model for FR-8
even when their names differ. Example: a repository that configures an agent
named `GPT` with runner `codex` (the scaffold heuristic
`inferDefaultAgentRunner` produces exactly that) has `GPT` in the `codex`
family, so `GPT` and `codex` are never each other's other-model reviewer. A
`notify` runner has family `human`. `btrain doctor` lists the resolved family
of every configured agent so an operator can see and correct the mapping.

### FR-10: Rate and budget guard

The reviewer subagent runs under the same `btrain loop` timeout and round
budget as a peer reviewer. Solo mode does not add rounds. If the last tier
also runs out of budget, the dispatch is classified `tool_unavailable` (FR-8)
and the lane stays `needs-review` with the `no reviewer available` warning
until a tier recovers or `btrain solo retry` succeeds.

A second `request-changes` on the same lane under the same-model tier is an
escalation, not a third round: when `[solo].human_reviewer` is set the lane is
reassigned to that human (`review tier: human`); when it is not, the lane stays
`needs-review` with an `escalation required` warning in `btrain handoff` and
`btrain doctor`, and a third same-model dispatch is blocked until an operator
runs `btrain solo adopt --lane <id>` or `btrain solo retry`. One model does not
argue with itself indefinitely.

## Non-Goals

- Replacing multi-agent review as the default. Solo mode is a fallback with an
  expiry.
- Letting the writer's own context approve its work. The subagent is a
  different process by requirement, not by convention.
- Changing GitHub bot requirements automatically.
- Modeling subagent dispatch in `LaneLock.tla`. Dispatch is an external event
  there, as in spec 014.
- A general role-suffix system. Only `#review` exists in the first version.

## Relation to other specs

- **Spec 002**: lane and lock rules are untouched. `adopt` uses the existing
  registry write path so the owner label on locks follows the new owner.
- **Spec 005**: `changes-requested` routing is untouched; the writer is still
  the owner identity, the reviewer is still the `#review` identity.
- **Reviewer dispatch** (`dispatchNeedsReviewReviewer` in `core.mjs`; routing
  per spec 005 FR-11): gains the identity environment variable, the
  per-runner fresh-session normalization, and the environment allowlist.
- **Spec 014**: no new invariants. `adopt` is a semantic-impact change to the
  Reassign row and follows prose, model, code.
- **Spec 015** (PR #37, unmerged at the time of writing): rows 2 through 5
  apply unchanged with suffixed identities. Row 20 (Reassign) gets its first
  designated cases from FR-6 and FR-8 fall-through (FR-7).
- **`LaneLock.tla`** (PR #35, unmerged at the time of writing): the
  `ReviewerSeparation` invariant compares agent identities; `#review` is one
  more element of `Agents`.
- **`CLAUDE.md` Handoff Gate**: the sentence "One model writes, the other
  reviews" gains the solo-mode exception described in the Decision. That edit
  ships with the implementation lane, not with this spec.

## Acceptance Criteria

- With solo mode on and one runtime configured, a lane can be claimed, handed
  off, reviewed by a fresh-session `#review` subagent, returned with
  `request-changes`, re-handed off, approved to `ready-for-pr`, and taken
  through PR flow. The gates that must fire exactly as for peers: reviewer
  context completeness, reviewable diff, `pre-handoff`, `btrain review code`,
  the request-changes reviewer check, PR-flow lock retention, and every spec
  015 row.
- `canonicalizeAgentName` treats `claude` and `claude#review` as distinct
  (case-insensitive compare); the runner lookup strips the `#review` suffix and
  returns the base `claude` runner value; and `normalizeLoopCliRunner` for a
  `#review` identity yields the per-runner fresh flag with no reject flag
  present. All three are unit tests.
- A dispatch whose runner exits with a configured quota or auth signal is
  recorded `tool_unavailable` and the next tier is tried within the same
  handoff.
- A solo-mode review is distinguishable in the event log, `btrain handoff`,
  and the PR body, with its tier.
- Solo mode cannot be on without an expiry; `btrain doctor` reports it and
  lists grandfathered lanes after expiry.

## Open questions

Decided in this revision: a second `request-changes` under the same-model
tier escalates to a human (FR-10); solo mode is per repository, with
`solo adopt` acting per lane, and a per-lane toggle is out of scope for the
first version.

Still open:

### OQ-1: Required-bot unavailability policy

**Context.** `[pr_flow].required_bots` names GitHub bots whose review is
mandatory before merge. Solo mode handles *reviewer agent* unavailability
(FR-8 tiers) but does not touch the GitHub bot gate. When the unavailable
runtime also provides a required bot (e.g. `gh-codex` is powered by the codex
runtime), the lane reaches `ready-for-pr` or `pr-review` and stalls because
the bot cannot post its review. This question asks whether btrain should
provide a structured mechanism, or leave the operator to edit TOML.

**Failure classes.** A required bot can be unavailable for the same reasons
FR-8 classifies for reviewer dispatch:

| Class | Local runner signal (FR-8) | Bot-originated PR-flow signal | Example |
|---|---|---|---|
| Unknown/timeout | — | Review not posted within `bot_pending_timeout` | Bot did not respond; root cause undetermined |
| Outage | Presence probe fails | Documented provider-specific signal ¹ | Local CLI probe fails; bot status unknown until timeout |
| Quota | Configured quota exit code/pattern | Documented provider-specific signal ¹ | Token budget exhausted, rate limit |
| Authentication | Configured auth exit code/pattern | — | API key expired, OAuth token revoked (local runner) |
| Policy refusal | `policy_blocked` pattern | Documented provider-specific signal ¹ | Provider content policy, model refusal |

¹ A bot may document provider-specific signals (a status-check annotation,
a label, or a comment body pattern) that btrain can classify as quota,
outage, or policy refusal. Absent such documentation, the bot's silence is
classified unknown/timeout. Authentication failures are local runner
concerns; a bot authenticates through its own GitHub App credential, which
the operator cannot diagnose from the PR-flow side.

**Request-path errors.** `btrain pr request-review` uses `gh pr comment` to
deliver the review request. HTTP errors from that call describe the
caller's credentials, the repository, or the comment request — the bot has
not received anything yet. These are request-path failures, never
bot-unavailability signals, and never trigger automatic deferral:

| HTTP | Meaning | btrain response |
|---|---|---|
| 403 | Caller token lacks scope or is revoked | `request-path-blocked`; operator must repair credentials |
| 404 | Repository or PR not found for the caller | `request-path-blocked`; operator must repair reference |
| 422 | Unprocessable comment request | `request-path-blocked`; operator must repair request format |
| 5xx | GitHub API infrastructure error | `request-path-retry`; btrain retries with exponential backoff up to `[pr_flow].request_delivery_retries` (default 3) over `[pr_flow].request_delivery_timeout` (default 5 min); undelivered after all retries → `request-delivery-failed` warning; `bot_pending_timeout` does not start until delivery succeeds |

Request-path errors are surfaced in `btrain handoff` and `btrain doctor`
with repair guidance. They do not enter the bot-unavailability failure
classes and do not trigger Options D or E.

Recovery timelines differ: unknown/timeout resolves when the bot posts a
review or the root cause is identified and reclassified; outages resolve
externally; quota may reset on a schedule; authentication requires operator
action; and policy refusal may be permanent. These differences may warrant
class-dependent responses.

**Detection contract.** The failure classes above describe *why* a bot is
unavailable, but not *how btrain knows*. Local runner probes (FR-8) detect
runner unavailability on the operator's machine; they do not prove a GitHub
review bot is unavailable. A runner and its corresponding bot are separate
systems: the local `codex` CLI exhausting its token quota does not imply that
`gh-codex` (which runs in GitHub's infrastructure under a different account
and budget) is also down. `[pr_flow].bot_agent_map` records the operator's
assertion that a runtime powers a bot, but the causal link is not guaranteed.

Any option that acts automatically on bot unavailability (D, E) must name
three things:

1. **Authoritative signal**: the observable event that btrain treats as
   evidence the bot is unavailable. Candidates:
   - *GitHub API poll*: `btrain pr poll` already queries the PR's review
     state. A required bot that has not posted a review within a configurable
     `[pr_flow].bot_pending_timeout` (default: 30 min after the review was
     requested) is classified `unknown/timeout` — the absence of a review
     proves only that the bot did not respond, not why. HTTP errors (403,
     404, 422, 5xx) returned by the review-request call (`gh pr comment`)
     are request-path failures describing the caller, repository, or request
     format; they are not bot-unavailability signals and never trigger
     automatic deferral (see Request-path errors above).
   - *Runner probe as weak hint*: a failed local runner probe is not
     authoritative but may shorten the pending window (skip straight to the
     configured response rather than waiting the full timeout) when
     `bot_agent_map` links the runner to the bot.
2. **Pending window**: the duration between "review request successfully
   delivered" and "classified unavailable." `bot_pending_timeout` starts
   only after the review-request call (`gh pr comment`) returns a success
   response; a 5xx retry loop does not start the clock (see Request-path
   errors). During this window the lane stays in its current PR-flow status
   with a `bot-pending` annotation visible in `btrain handoff` and `btrain
   doctor`. The window is `[pr_flow].bot_pending_timeout` (default 30 min),
   shortened to `[pr_flow].bot_probe_shortcut` (default 5 min) when the
   mapped runner's local probe also fails.
3. **Late-review behavior**: if the bot was available but slow, the
   deferral fires and the bot posts its review after the gate already
   evaluated without it. The late review is recorded as a `bot-late-review`
   event. Behavior depends on the review verdict and merge state:

   - **Late approval before merge**: for Options B and C
     (operator-initiated), the late approval is informational — the operator
     chose to exempt. For Options D and E (automatic), the late approval
     restores the bot requirement for the lane: the deferral is lifted, the
     bot's approval is recorded, and `btrain doctor` warns the operator to
     increase `bot_pending_timeout`.
   - **Late `CHANGES_REQUESTED` before merge**: the exemption or deferral
     is revoked regardless of option. For B and C the lane moves to
     `changes-requested` with reason `pr-review-feedback`. For D and E the
     automatic deferral is revoked and the lane moves to
     `changes-requested` with the same reason. The owner must address the
     bot's requested changes and explicitly return the lane to `pr-review`
     before the gate re-evaluates. A `CHANGES_REQUESTED` verdict is never
     informational while the PR is open.
   - **After merge**: no retroactive mutation. Neither approval nor
     `CHANGES_REQUESTED` mutates the lane or the bot requirement. The merge
     stands; the late review is recorded as a `bot-late-review`
     audit/warning event with the verdict. `btrain doctor` warns so the
     operator can inspect the bot's feedback on the next lane or follow-up
     PR. A post-merge `CHANGES_REQUESTED` does not reopen the lane or
     revert the merge — the event provides an audit trail and the operator
     decides the response.

4. **Expiry restoration transition**: Options B, C, and D designate
   `BotRequirementRestore` as a new protocol transition. An exemption or
   deferral expiry, early revocation, or early restoration raises the internal
   event. The transition has these fields:

   - **From/to**: `ready-to-merge` to `pr-review`.
   - **Actor**: `system`.
   - **Guard**: the lane has an open linked PR, and its merge gate reached
     `ready-to-merge` while the expiring or revoked exemption or deferral was
     active.
   - **Locks**: retain.

   The implementation must add this designated transition to the spec 015
   ledger and both formal-model representations before it enforces any option
   that uses expiry restoration. The event restores the bot requirement and
   re-evaluates the gate. It does not imply that the bot approved the PR.

#### Option A — Manual edit only (status quo)

The operator edits `[pr_flow].required_bots` in `project.toml` by hand.

- **Status**: No new lane or PR status. The lane stays in `pr-review` until
  the operator removes the bot from `required_bots` and re-requests review.
- **Command**: Direct TOML edit, then
  `btrain pr request-review --lane <id> --bots all`.
- **Event**: No dedicated workflow event. The change is visible only in git
  history of `project.toml`.
- **Expiry**: None. The edit persists until manually reverted.
- **Safety**: Relies on operator discipline to restore the bot entry after
  recovery. No mechanism prevents forgetting.
- **PR-flow effects**: The bot is removed from the gate entirely; there is no
  distinction between "temporarily excused" and "permanently removed."

#### Option B — Per-lane audited exemption

A new command temporarily exempts a named bot from one lane's PR gate.

- **Status**: The lane stays in its current PR-flow status. The gate
  evaluates without the exempted bot for that lane only.
- **Command**: `btrain pr exempt-bot --lane <id> --bot <name> --reason "..."
  --until <ISO>` to grant.
  `btrain pr unexempt-bot --lane <id> --bot <name>` to revoke early.
- **Event**: `bot-exempted` and `bot-unexempted` events in canonical workflow
  history, recording: actor, bot name, lane, reason, failure class, expiry,
  and whether solo mode was active.
- **Expiry**: Required (`--until`). On expiry or early revocation
  (`unexempt-bot`), btrain re-evaluates every affected open lane: a lane
  in `ready-to-merge` whose merge gate cleared under the exemption and has
  not yet merged returns to `pr-review` so the restored requirement takes
  effect before merge. `btrain doctor` warns while exemptions are active
  and lists expired ones.
- **Safety**: Scoped to one lane — other lanes still require the bot.
  `required_bots` in TOML is never edited. The exemption and its reason are
  shown in the PR body and `btrain handoff`.
- **PR-flow effects**: The lane's merge gate evaluates as if the exempted bot
  is absent from `required_bots` until expiry or early revocation. All other
  required bots still apply.

#### Option C — Repo-wide audited deferral

Same mechanism as B but scoped to the repository rather than a single lane.

- **Status**: All lanes currently in PR-flow evaluate the gate without the
  deferred bot.
- **Command**: `btrain pr defer-bot --bot <name> --reason "..." --until <ISO>`
  to grant. `btrain pr undefer-bot --bot <name>` to revoke.
- **Event**: `bot-deferred` and `bot-undeferred` in workflow history with the
  same fields as B.
- **Expiry**: Required. On expiry or early revocation, btrain re-evaluates
  every affected open lane. Any lane in `ready-to-merge` whose gate cleared
  under the deferral and has not merged returns to `pr-review`, so the
  restored bot requirement applies before merge. The same `btrain doctor`
  warnings as B apply.
- **Safety**: Broader blast radius than B — all lanes and new PRs are
  affected. The deferral is visible in `btrain status` and every affected PR
  body. `required_bots` in TOML is never edited.
- **PR-flow effects**: Same gate relaxation as B, applied to all current and
  future PR gate evaluations until expiry.

#### Option D — Automatic deferral tied to solo-mode scope

When solo mode is on and the unavailable runtime maps to a required bot (via
a new `[pr_flow].bot_agent_map`), btrain starts the bot's pending and detection
flow. The mapping and solo mode do not defer the bot. Automatic deferral begins
only after the selected D-i or D-ii signal below. The deferral inherits the
solo-mode expiry, and no separate operator command is needed. The policy owner
must choose one scope:

- **(D-i) Per-lane timeout deferral.** Each lane has its own `bot-pending`
  window. A timeout defers the bot only for that lane. A different lane where
  the bot responded normally keeps the requirement.
- **(D-ii) Repo-wide signal deferral.** A lane timeout is not enough to defer
  the bot repository-wide. Repo-wide deferral requires a documented,
  authoritative bot-originated outage, quota, or policy signal whose contract
  explicitly states repository-wide scope.

- **Status**: The bot enters a `bot-pending` window when solo mode is on and
  the bot-agent mapping exists. Under D-i, deferral begins for that lane only
  after its pending timeout expires (`unknown/timeout`) or a documented signal
  scoped to that lane fires. Under D-ii, deferral begins repository-wide only
  after a documented authoritative repo-wide signal fires; one lane's
  `unknown/timeout` cannot waive the bot for other lanes.
  A local runner probe failure is a weak hint that may shorten the pending
  window (per `bot_probe_shortcut`) but never triggers or sustains a deferral
  on its own. HTTP errors from the review-request call are request-path
  failures and never trigger deferral.
- **Command**: `btrain solo on` starts detection when the mapping exists.
  Deferral is implicit only after the selected D-i or D-ii signal.
  `btrain solo off` or expiry restores the requirement.
- **Event**: `bot-pending` when solo-on detects the mapping and a lane has
  an open review request for the mapped bot. `bot-auto-deferred` when the
  D-i pending window expires (`unknown/timeout`) or a bot-originated
  documented signal classifies the bot as unavailable. Each event records
  `scope: lane | repo`; D-ii requires the repo-wide signal before recording
  repo scope. `bot-auto-restored`
  on solo-off, expiry, late approval from the bot before merge, or when
  the GitHub API poll confirms the bot posted a review before merge. After
  merge, a late review (approval or `CHANGES_REQUESTED`) is recorded as a
  `bot-late-review` audit event without restoring or revoking the deferral.
- **Expiry**: Inherits solo mode's `until` and cannot outlive it. On solo-off,
  expiry, or early restoration, btrain re-evaluates every affected open lane.
  Any uncleared lane in `ready-to-merge` whose gate used the deferral returns
  to `pr-review` before the restored bot requirement is evaluated.
- **Safety**: Requires an explicit `[pr_flow].bot_agent_map` entry — the
  mapping is never inferred from bot or agent names. Only fires when the
  mapped runtime is the one solo mode replaces. `btrain doctor` warns while
  active.
- **Detection**: D-i fires for one lane after its bot is classified
  `unknown/timeout` or by a bot-originated signal scoped to that lane. D-ii
  fires repository-wide only from a documented authoritative repo-wide
  signal; a single lane timeout is insufficient. Neither path fires on a
  local runner probe or on
  review-request HTTP errors (which are request-path failures). When
  `bot_agent_map` links the runner to the bot and the runner's local probe
  fails, the pending window shortens per `bot_probe_shortcut`, but the
  runner probe never classifies bot-unavailable, triggers deferral, or
  emits `bot-unavailable` — the GitHub poll (or a bot-originated signal)
  is the authoritative gate. A runner outage with a healthy bot (different
  infrastructure, different quota) results in a `bot-pending` annotation
  that expires without deferral when the bot posts its review in time.
- **PR-flow effects**: Same gate relaxation as B for D-i or C for D-ii,
  scoped to the solo-mode lifetime and the specific bot-agent mapping.

#### Option E — Failure-class-dependent policy table

Different failure classes get different default responses, configured in TOML:

```toml
[pr_flow.bot_unavailable]
unknown   = "defer-lane"    # per-lane deferral, retry after bot_pending_timeout
outage    = "defer-lane"    # per-lane deferral; requires bot-documented outage signal
quota     = "defer-lane"    # requires bot-documented provider-specific signal; otherwise unknown/timeout
auth      = "block"         # lane blocked; requires bot-documented auth signal (none currently defined ¹)
policy    = "block"         # lane blocked, requires human decision; requires bot-documented signal
```

- **Status**: `defer-lane` acts like Option B. The deferral ends only when
  the GitHub API poll confirms the bot posted a review or a documented
  provider-specific recovery signal fires. `block` halts the lane with a
  dedicated `bot-blocked` warning. `block` fires only on bot-documented
  auth or policy signals, never on local runner signals or review-request
  HTTP errors.
- **Command**: `btrain pr bot-status --lane <id>` to inspect. The operator
  can override any class with `btrain pr exempt-bot` (Option B's mechanism).
- **Event**: `bot-unavailable` with the failure class (classified from the
  response timeout or a bot-originated documented signal — never from a
  local runner signal or review-request HTTP errors); `bot-recovered` when
  the GitHub API poll confirms the bot posted a review or a documented
  provider-specific recovery signal fires. A runner probe failure may
  shorten the next pending window but does not emit `bot-recovered`.
- **Expiry**: Deferrals are retried on `[pr_flow.bot_unavailable].retry_after`
  (default 6h) and on `btrain pr retry-bot --lane <id>`. They lapse when the
  GitHub API poll confirms the bot posted a review. `block` has no automatic
  recovery. The retry timer is independent of `[solo].retry_after` because
  this option is usable when solo mode is off.
- **Detection**: Same GitHub API poll as the detection contract above. A
  `defer-lane` response fires when the pending timeout expires
  (`unknown/timeout`) or on a bot-originated documented signal. Quota is
  classified `unknown/timeout` unless the bot documents a provider-specific
  quota signal; the `quota` class in the policy table is available for repos
  that configure such a signal. When `bot_agent_map` exists and the runner
  probe fails, `bot_probe_shortcut` applies but the runner signal never
  classifies bot-unavailable, triggers `defer-lane` or `block`, or emits
  `bot-unavailable` — it only shortens the pending window. `block` fires
  only on bot-documented auth or policy signals — never on local runner
  signals or review-request HTTP errors (403, 422), which are request-path
  failures requiring operator repair. Late-review behavior follows the
  detection contract: late approval before merge restores the requirement;
  late `CHANGES_REQUESTED` before merge moves the lane to
  `changes-requested`; after merge both verdicts are recorded as
  audit/warning events without lane or requirement mutation.
- **Safety**: Auth and policy failures default to blocking, so credential
  issues and content-policy refusals never silently waive the gate. Outage
  and quota are deferrable because they resolve externally.
- **PR-flow effects**: Deferred bots are skipped in gate evaluation until the
  GitHub API poll confirms the bot posted a review. Blocked bots stall the
  lane. An operator can always escalate from `defer-lane` to `block` or from
  `block` to `defer-lane` with an explicit command.

#### Comparison

| Criterion | A (manual) | B (per-lane) | C (repo-wide) | D (auto/solo) | E (class table) |
|---|---|---|---|---|---|
| Audit trail | git only | full | full | full | full |
| Operator effort | high | moderate | low | none | low after config |
| Blast radius | repo-wide | per-lane | repo-wide | D-i per-lane; D-ii repo-wide | configurable |
| Silent-approval risk | discipline | command req'd | command req'd | mapping req'd | class defaults |
| Solo-mode coupling | none | none | none | tight | works with or without |
| Bot ≠ runtime risk | n/a | n/a (operator) | n/a (operator) | `bot_agent_map` required; probe is weak hint | GitHub poll authoritative; `bot_agent_map` optional shortcut |
| Handles all failure classes | same response | same response | same response | same response | class-dependent |

**Options can be combined.** For example: B as the per-lane mechanism,
E's failure-class defaults to decide when to auto-invoke B vs. block, and
C or D as an optional broader scope.

#### Decision inputs needed

To choose, the owner of this policy needs to decide:

1. **Is audit-trail-free manual editing acceptable?** If no, eliminate A.
2. **Should different failure classes get different responses?** If yes,
   E is required as a layer; otherwise any single-response option (B–D)
   suffices.
3. **Should bot unavailability couple to solo mode?** If yes, D. If the
   policy should apply independently of solo mode (e.g. a bot goes down
   while multi-agent review is otherwise healthy), B/C/E are more general.
4. **Per-lane or repo-wide default scope?** B and E default to per-lane; C is
   repo-wide. D requires an explicit choice between D-i and D-ii; it has no
   safe default because one lane's timeout is not a repo-wide outage signal.
5. **Should auth and policy failures ever auto-defer?** E defaults them to
   `block`, reflecting that they may require human intervention; the other
   options treat all classes identically.
