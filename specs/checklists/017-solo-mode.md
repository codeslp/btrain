# Spec 017 Solo-Mode Requirements Checklist

**Source**: [../017-solo-mode-internal-review.md](../017-solo-mode-internal-review.md)
**Plan**: [../019-solo-mode-implementation-plan.md](../019-solo-mode-implementation-plan.md)

## Protocol and identity

- [ ] FR-1 has tests for `solo on|off`, required expiry, audit reason, and workflow events.
- [ ] FR-1 proves both toggle events retain the configured expiry, including `solo-off` after configuration removal.
- [ ] FR-2 has tests for distinct base and `#review` identities.
- [ ] FR-2 has lane-scoped actor verification and expiry grandfathering tests.
- [ ] FR-2 rejects suffixed roster and runner entries.
- [ ] FR-4 proves that every existing handoff and review gate still runs.
- [ ] Spec 015 row 4 rejects owner approval before solo mode ships.

## Fresh context and environment

- [ ] FR-3 has table-driven fresh-session tests for Claude, Codex, and Gemini.
- [ ] FR-3 rejects resume or session-reuse flags for each supported runner.
- [ ] FR-3 blocks unknown runners without a fresh-session profile.
- [ ] FR-3 uses an environment allowlist and applies `env_deny` last.
- [ ] FR-3 proves that writer session values do not reach the reviewer.

## Selection and failure handling

- [ ] FR-8 selects other-model, human, same-model, and pending in that order.
- [ ] FR-8 records the selected tier on the lane and in workflow events.
- [ ] FR-8 classifies quota and authentication failures as `tool_unavailable`.
- [ ] FR-8 classifies provider refusal as `policy_blocked`.
- [ ] FR-8 moves an unresponsive human tier to same-model after `[solo].human_timeout` and records `solo-human-timeout`.
- [ ] FR-8 never treats a probe or dispatch failure as approval.
- [ ] FR-9 uses explicit family values for wrappers and unknown executables.
- [ ] FR-9 reports every resolved family in `btrain doctor`.
- [ ] FR-10 enforces loop timeout and round budgets.
- [ ] FR-10 classifies exhausted same-model timeout or round budgets as `tool_unavailable` with backoff and a visible warning.
- [ ] FR-10 reassigns the second same-model request-changes to the configured human with `review tier: human` and records the previous and new reviewer in a `solo-reviewer-assigned` event.
- [ ] FR-10 leaves the lane in `needs-review` with an `escalation required` warning when no human reviewer is configured.
- [ ] FR-10 blocks a third same-model review without an operator action.

## Commands, visibility, and recovery

- [ ] FR-5 renders solo mode, reviewer identity, and tier in handoff output.
- [ ] FR-5 renders the same fields in status, dashboard, and PR bodies.
- [ ] FR-6 implements `solo adopt --lane` with atomic lock-owner updates.
- [ ] FR-6 records previous and new roles in the adoption event.
- [ ] `solo retry` clears eligible backoff and reruns the selector.
- [ ] Expiry stops new solo assignments and preserves active assignments.
- [ ] Doctor lists grandfathered lanes and unavailable-reviewer warnings.

## Formal and end-to-end verification

- [ ] FR-7 records no semantic impact for toggle, identity, and runner work.
- [ ] FR-7 designates Spec 015 row 20 before adopt or fallback lands.
- [ ] Semantic changes pass the pin check, focused harness, and TLC checks.
- [ ] The one-runtime lifecycle reaches request-changes and then ready-for-pr.
- [ ] The lifecycle retains locks through PR flow and releases them only at termination.
- [ ] The required GitHub bot list remains unchanged.
- [ ] All error messages contain a direct recovery command.
- [ ] Spec 017 leaves Draft only after all checklist items pass.
