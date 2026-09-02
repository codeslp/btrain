# Plan: Implement Solo Mode (Spec 017)

**Status**: Draft
**Version**: 0.1.0
**Date**: 2026-09-02
**Source**: [017-solo-mode-internal-review.md](017-solo-mode-internal-review.md)

## Summary

This plan implements Spec 017 in small, testable phases. Solo mode keeps the
normal lane, lock, review, and PR rules. It changes reviewer selection and
runner dispatch when peer runtimes are unavailable.

The implementation must land after Spec 015 Workstream 2. PR #42 owns the
shared `src/brain_train/` and `test/` files until it merges.

## Context receipt

- **Context tier**: deep.
- **Question**: Which identity, runner, audit, expiry, and failure rules must
  the implementation preserve?
- **Sources**: Spec 017 and the current `core.mjs`, `cli.mjs`, `pr-flow.mjs`,
  reviewer-dispatch tests, and workflow event code. Related repositories
  confirm the externalized-state and fresh-context pattern.
- **Constraints**: btrain remains the state owner. All mutations use btrain
  commands. A runner failure is never approval. PR locks remain until merge
  or close.
- **Gap**: Related-repository results are supporting evidence only. The open
  required-bot-unavailable policy remains outside this plan.
- **Durable writeback**: this plan and the Spec 017 checklist.

## Technical context

- Runtime: Node.js ESM.
- Configuration: `.btrain/project.toml`.
- State: handoff files, `.btrain/locks.json`, and append-only workflow events.
- Main implementation: `src/brain_train/core.mjs` and
  `src/brain_train/cli.mjs`.
- PR rendering: `src/brain_train/pr-flow.mjs`.
- Dashboard rendering: `src/brain_train/dashboard.mjs` and dashboard assets.
- Unit and integration tests: `test/core.test.mjs`,
  `test/reviewer-dispatch.test.mjs`, `test/pr-flow.test.mjs`, and dashboard
  tests.
- Formal impact: Phase A has no semantic impact. Reassignment and tier
  fall-through have semantic impact under Spec 014 and Spec 015 row 20.

## Design boundaries

1. Do not add a lane status.
2. Do not relax a handoff or review gate.
3. Do not add `#review` to `[agents].active`.
4. Derive a suffixed reviewer runner from the base runner.
5. Start every same-runtime review in a fresh model session.
6. Keep the writer environment out of the reviewer process.
7. Keep required GitHub bots unchanged.
8. Record every toggle, assignment, fallback, timeout, and adoption event.

## Data model

### Repository solo configuration

`[solo]` contains:

- `enabled`: Boolean. Default `false`.
- `runtime`: Base agent identity.
- `until`: Required UTC timestamp when enabled.
- `reason`: Required non-empty audit reason when enabled.
- `human_reviewer`: Optional agent with a `notify` runner.
- `human_timeout`: Optional duration. Default four hours.
- `retry_after`: Optional duration. Default six hours.
- `env_allow`: Optional environment variable names.
- `env_deny`: Optional environment variable names.

### Lane review metadata

Each lane can record:

- `reviewTier`: `other-model`, `human`, `same-model`, or `pending`.
- `soloReviewer`: The selected reviewer identity.
- `soloUnavailable`: Structured tier and reason records.
- `soloSameModelRounds`: Same-model request-changes count.
- `soloAssignedAt`: Assignment timestamp.

These fields do not replace `owner` or `reviewer`. They explain how btrain
selected the reviewer.

### Workflow events

Add these event types:

- `solo-on`
- `solo-off`
- `solo-reviewer-assigned`
- `solo-tier-unavailable`
- `solo-human-timeout`
- `solo-adopt`
- `solo-retry`

Each event records the lane when applicable, the actor, the tier, the reason,
the previous roles, and the new roles. `solo-on` and `solo-off` also record
the configured expiry. The `solo-off` event keeps that expiry even when the
command removes or replaces the active configuration.

## CLI contracts

### `btrain solo on`

Required options:

- `--reason <text>`
- `--until <ISO timestamp>`

Optional option:

- `--runtime <agent>` when btrain cannot select one configured runtime.

The command rejects an invalid or elapsed timestamp. It writes configuration
and a `solo-on` event.

### `btrain solo off`

The command disables new solo assignments and writes a `solo-off` event. It
does not rewrite active lanes.

### `btrain solo adopt --lane <id>`

The command reassigns unavailable roles. It uses the same tier selector as a
new claim. It re-registers lock ownership and records the old and new roles.

### `btrain solo retry [--lane <id>]`

The command clears eligible availability backoff and reruns reviewer
selection. It does not bypass the loop round limit.

## Workstreams

### Workstream 0: Spec 015 prerequisite

**Goal**: enforce reviewer identity on approval before solo mode can claim
owner/reviewer separation.

Tasks:

- Complete Spec 015 row 4 enforcement.
- Retire legacy row L8.
- Add a regression that rejects owner approval from `needs-review`.

**Blocked by**: PR #42 and the Spec 015 semantic phase.

### Workstream 1: Configuration and audited toggle

**Goal**: add solo mode without changing reviewer selection.

Tasks:

- Add red-first parser tests for valid and invalid `[solo]` values.
- Add `getSoloConfig` with defaults and timestamp validation.
- Add CLI parser tests for `solo on|off`.
- Implement `solo on|off` with atomic configuration writes.
- Write `solo-on` and `solo-off` events.
- Add doctor warnings for enabled, expired, and malformed configurations.
- Render repo-level solo state in `handoff` and `status`.

**Independent check**: toggling solo mode changes configuration, history, and
status output. It does not change any lane role.

**Formal impact**: none.

### Workstream 2: Identity and runner derivation

**Goal**: represent a distinct reviewer identity on the base runtime.

Tasks:

- Add unit tests for parsing and normalizing `<agent>#review`.
- Reserve `#review` and reject all other suffixes.
- Make `canonicalizeAgentName` preserve the suffix.
- Make runner lookup strip the suffix after identity validation.
- Pass the lane to `resolveVerifiedActor`.
- Accept a suffixed actor only while solo mode is active or the lane records
  that reviewer.
- Add grandfathering tests for an expired or disabled solo mode.
- Add doctor checks that reject suffixed roster entries and dedicated
  suffixed runner entries.

**Independent check**: `claude` and `claude#review` compare as different
actors but resolve to the same configured runner.

**Formal impact**: none. Agent identities remain opaque values.

### Workstream 3: Fresh-session runner profiles

**Goal**: guarantee a fresh review context for supported runtimes.

Tasks:

- Add table-driven tests for Claude fresh and rejected flags.
- Add table-driven tests for Codex fresh and rejected flags.
- Add table-driven tests for Gemini session IDs and rejected flags.
- Reject unknown runners without a declared fresh-session profile.
- Add fresh-session normalization to `normalizeLoopCliRunner`.
- Add `buildSoloReviewerEnv` with the Spec 017 allowlist and deny list.
- Add tests that remove session variables and retain required credentials.
- Pass `BTRAIN_AGENT=<base>#review` to the reviewer process.
- Record the normalized command and review identity in the trace bundle.

**Independent check**: a fake writer session value cannot reach a fake
reviewer runner. Each dispatch receives a new session identity.

**Formal impact**: none.

### Workstream 4: Family and availability model

**Goal**: select reviewers by configured model family and operational state.

Tasks:

- Add `[agents.families]` parser tests.
- Resolve known direct executable families.
- Require explicit families for wrappers and unknown executables.
- Treat `notify` as the `human` family.
- Add doctor output for every resolved family.
- Define runner probe and failure-pattern configuration.
- Classify quota and authentication signals as `tool_unavailable`.
- Classify provider refusals as `policy_blocked`.
- Classify same-model loop timeout or round-budget exhaustion as
  `tool_unavailable`, with retry backoff and a visible lane warning.
- Keep other non-zero exits as review failures.
- Persist availability failures with retry timestamps.

**Independent check**: a quota failure moves selection to the next tier and
never changes the lane to an approved status.

**Formal impact**: none until the selector changes a recorded reviewer.

### Workstream 5: Tier selector and claim integration

**Goal**: choose `other-model`, `human`, `same-model`, or `pending`.

Tasks:

- Add pure selector tests for every tier and fallback order.
- Prefer an available different-family CLI runner.
- Use the configured human only when it has a `notify` runner.
- Use `<runtime>#review` only after the first two tiers are unavailable.
- Return `pending` when every tier is unavailable.
- Update `inferPeerReviewer` to use the selector in solo mode.
- Record the tier on claims and reviewer assignments.
- Render `review tier` and unavailable reasons in handoff guidance.

**Independent check**: one-runtime solo claim assigns
`<runtime>#review` with `review tier: same-model`.

**Formal impact**: reviewer assignment is semantic when a fallback reassigns
an active lane. Update Spec 015 row 20 and formal evidence first.

### Workstream 6: Review dispatch and protocol integration

**Goal**: run a complete review without a peer runtime.

Tasks:

- Dispatch the derived reviewer runner from `needs-review`.
- Keep existing pre-handoff, diff, code-review, lock, and actor checks.
- Start the configured `[solo].human_timeout` deadline when the human tier is
  assigned.
- On human timeout, record `solo-human-timeout`, mark that tier unavailable,
  and rerun the selector so the lane can fall through to the same-model tier.
- Record solo mode and tier on resolve and request-changes events.
- On the second same-model request-changes, atomically reassign the reviewer
  to `[solo].human_reviewer` with `review tier: human` when it is configured,
  and record a `solo-reviewer-assigned` event with the previous and new
  reviewer, tier, and escalation reason.
- When no human reviewer is configured, leave the lane in `needs-review` and
  render the `escalation required` warning.
- Block a third same-model review without `adopt` or `retry`.
- Keep PR-flow state changes and lock retention unchanged.
- Add an end-to-end lifecycle test through `ready-for-pr`.

**Independent check**: a fresh same-runtime reviewer can request changes,
review the revised diff, and approve without acting as the owner.
An unresponsive human assignment falls through after the configured timeout
and does not leave the lane assigned to that human indefinitely.
With a configured human reviewer, a second same-model request-changes
reassigns the lane to that human, records the reassignment, and does not
dispatch a third same-model review.
Without a configured human reviewer, the lane stays in `needs-review`, renders
the `escalation required` warning, and does not dispatch a third same-model
review.

### Workstream 7: Adopt, retry, expiry, and visibility

**Goal**: support recovery and make solo use visible.

Tasks:

- Implement `solo adopt --lane` through the Spec 015 transition gate.
- Re-register lock owner labels in the registry critical section.
- Implement `solo retry` and retry-backoff clearing.
- Stop new suffixed assignments after expiry.
- Preserve suffixed reviewers on grandfathered active lanes.
- Add doctor output for grandfathered lanes and review counts.
- Add dashboard fields and rendering for mode, reviewer identity, and tier.
- Add PR-body fields for solo mode, reviewer identity, and tier.
- Add integration tests for status, dashboard JSON, event history, and PR body.

**Independent check**: expiry blocks a new suffixed assignment but does not
orphan an existing lane or release its locks.

**Formal impact**: `adopt` and system fallback are semantic changes to Spec
015 row 20. Run pin, harness, and TLC checks before review.

### Workstream 8: Final acceptance and rollout

**Goal**: enable solo mode as an opt-in fallback.

Tasks:

- Run the full unit and integration suite.
- Run the Spec 014 risk-matched formal checks.
- Run a one-runtime end-to-end smoke test.
- Verify all new error messages have direct recovery commands.
- Update the managed handoff rule with the time-boxed solo exception.
- Update README and dashboard documentation.
- Change Spec 017 from Draft only after every acceptance check passes.

## Dependency order

1. Merge PR #42.
2. Complete Workstream 0.
3. Implement Workstreams 1 through 3.
4. Implement Workstream 4.
5. Designate Spec 015 row 20.
6. Implement Workstreams 5 through 7.
7. Complete Workstream 8.

Workstreams 1 and 2 can share one code lane after PR #42. Workstream 1 must
land before Workstream 3 because runner environment filtering uses the parsed
solo configuration. Workstream 3 should remain separate because it changes
process environment and runner commands. Workstream 4 should land before
reviewer selection changes. Within step 6, Workstream 5 lands before
Workstream 6, and Workstream 6 lands before Workstream 7.

## Rollback points

- After Workstream 1, disable `[solo].enabled`. No lane roles depend on it.
- After Workstream 3, revert runner normalization. No role selector uses it.
- After Workstream 5, disable solo mode and preserve existing assigned
  reviewers until their lanes resolve.
- After Workstream 7, keep the event history and revert only the command and
  rendering changes.

## Decision gate

Spec 017 leaves one question open: required GitHub bot unavailability. This
plan keeps the current rule. Solo mode does not edit `required_bots`.

A separate Spec 002 decision can add a bot-unavailable policy later. That
decision does not block local solo review or Workstreams 1 through 7.
