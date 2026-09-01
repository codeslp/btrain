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

Solo mode is a routing change, not a protocol change. Nothing about what a
handoff must contain, what a reviewer must check, when locks release, or how a
PR terminates a lane is relaxed. The only thing that changes is who is asked.

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

The rule the protocol exists to enforce is that **the context that wrote a
change does not approve it**. Two runtimes are one way to get that. A second,
fresh context in the same runtime is another. Solo mode makes the second way
explicit, auditable, and reversible.

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
   reviewer runner as it does today (spec 007 reviewer dispatch), but with
   `BTRAIN_AGENT=<runtime>#review`, a fresh process, no shared conversation
   or scratch state, and the review prompt that the reviewer role receives
   in multi-agent mode. `btrain loop` selects the same identity when the
   lane's status routes to the reviewer.

5. **Review.** The subagent reviews from the handoff packet and the diff and
   ends with `handoff resolve` or `handoff request-changes` under its own
   identity. Both commands record `mode: solo` in the event. Every gate that
   applies to a peer reviewer applies to the subagent: reviewer context must
   be complete, the diff must be real, the reviewer must not be the owner.

6. **PR flow.** Unchanged. The GitHub bot list in `[pr_flow].required_bots`
   is not touched by solo mode. If a required bot is the runtime that is
   unavailable, the operator edits `required_bots` deliberately; solo mode
   does not do it for them.

7. **Expiry.** When `until` passes, solo mode turns off. Lanes whose reviewer
   is a `#review` identity keep working until they resolve; new claims go
   back to inferring a distinct configured agent. `btrain doctor` warns while
   solo mode is on and reports how many lanes were reviewed under it.

## Functional Requirements

### FR-1: Explicit, audited toggle

Solo mode is entered and left through `btrain solo on|off`. Both write a
workflow event with actor, reason, and expiry. An `until` value is required.
Solo mode never turns itself on.

### FR-2: Distinct identities, same runtime

The reviewer subagent acts as `<runtime>#review`. Every owner/reviewer
separation check compares identity strings and therefore holds. Runner
resolution maps `<runtime>#review` to the same runner as `<runtime>`.

### FR-3: Fresh context

The reviewer subagent runs in a new process with no access to the writer's
conversation, scratch files, or environment beyond the repository and the
handoff packet. The dispatcher must not pass the writer's session or
transcript to it.

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
unavailable runtime: the owner becomes the available runtime, the reviewer
becomes `<runtime>#review`, locks re-register under the new owner, and the
event records the previous roles. This replaces the sequence of
`handoff update --owner/--reviewer` edits the operator performed by hand.

### FR-7: Model compatibility

`LaneLock.tla` and `lane-lock-model.mjs` treat identities as opaque agents. A
`#review` identity is one more element of `Agents`. No invariant changes.
Spec 014 formal impact for enabling solo mode: none. Formal impact for FR-6
(`adopt` changes owner and reviewer of an active lane): semantic, because
spec 015 row 20 (Reassign) is undesignated; FR-6 designates it for solo mode
only.

### FR-8: Rate and budget guard

The reviewer subagent runs under the same `btrain loop` timeout and round
budget as a peer reviewer. Solo mode does not add rounds. If the available
runtime also runs out of budget, the dispatch fails as `tool_unavailable`
(spec 014 failure classes) and the lane stays `needs-review`.

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
- **Spec 007**: reviewer dispatch gains the identity environment variable and
  the fresh-process requirement.
- **Spec 014**: no new invariants. `adopt` is a semantic-impact change to the
  Reassign row and follows prose, model, code.
- **Spec 015**: rows 2 through 5 apply unchanged with suffixed identities.
  Row 20 (Reassign) gets its first designated case from FR-6.

## Acceptance Criteria

- With solo mode on and one runtime configured, a lane can be claimed, handed
  off, reviewed by a fresh-process `#review` subagent, returned with
  `request-changes`, re-handed off, approved to `ready-for-pr`, and taken
  through PR flow, with every existing gate firing as it does for peers.
- `ReviewerSeparation` and the spec 015 cross-check test pass with `#review`
  identities in the agent set.
- A solo-mode review is distinguishable in the event log, `btrain handoff`,
  and the PR body.
- Solo mode cannot be on without an expiry, and `btrain doctor` reports it.

## Open questions

1. Should `#review` subagents be allowed to `request-changes` more than once
   on the same lane, or should a second return escalate to a human because
   the same runtime is now arguing with itself?
2. Should solo mode be per lane rather than per repo, so one unavailable
   runtime does not switch every lane at once?
3. Does the GitHub bot requirement need a matching "bot unavailable" policy,
   or is editing `required_bots` by hand acceptable?
