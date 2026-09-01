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

What is not being done: no new statuses, no new lock semantics, no change to
the transition rules in spec 015, no change to the formal model's invariants.
Solo mode is off by default and has an expiry.

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

1. Does the GitHub bot requirement need a matching "bot unavailable" policy,
   or is editing `required_bots` by hand acceptable? (`[pr_flow]` is spec
   002's; this spec does not decide it.)
