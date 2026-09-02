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
- [ ] FR-3 proves that `normalizeLoopCliRunner` receives a `#review` identity, returns the per-runner fresh flag, and returns no reject flag.
- [ ] FR-3 rejects resume or session-reuse flags for each supported runner.
- [ ] FR-3 blocks unknown runners without a fresh-session profile.
- [ ] FR-3 makes `btrain doctor` report every enabled solo runner that has no fresh-session profile.
- [ ] FR-3 uses an environment allowlist and applies `env_deny` last.
- [ ] FR-3 proves that writer session values do not reach the reviewer.

## Selection and failure handling

- [ ] FR-8 selects other-model, human, same-model, and pending in that order.
- [ ] FR-8 records the selected tier on the lane and in workflow events.
- [ ] FR-8 classifies quota and authentication failures as `tool_unavailable`.
- [ ] FR-8 classifies provider refusal as `policy_blocked`.
- [ ] FR-8 proves that quota, authentication, and provider-refusal dispatch results mark the current tier unavailable and try the next tier within the same handoff invocation.
- [ ] FR-8 proves that presence and authenticated-probe failures persist the unavailable result and immediately try the next tier.
- [ ] FR-8 proves that an all-unavailable claim persists with its owner and locks intact, review tier `pending`, and no fake reviewer identity.
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

- [ ] FR-5 renders solo mode, reviewer identity, tier, and unavailable reasons in handoff output.
- [ ] FR-5 renders the same fields in status, dashboard, and PR bodies.
- [ ] FR-5 proves that solo mode and review tier are distinguishable in the workflow event log.
- [ ] FR-6 verifies that the `solo adopt --lane` actor is the available runtime.
- [ ] FR-6 replaces an unavailable owner with the verified actor and selects the replacement reviewer through the FR-8 tier order.
- [ ] FR-6 tests that the owner, reviewer, and registry lock-owner labels change atomically.
- [ ] FR-6 records the actor and the previous and new owner and reviewer in the `solo-adopt` event.
- [ ] `solo retry` clears eligible backoff and reruns the selector.
- [ ] `solo retry` writes a `solo-retry` event with the actor, lane, and cleared tiers.
- [ ] `solo retry` does not increase, reset, or bypass the loop round budget for a later dispatch.
- [ ] Expiry stops new solo assignments and preserves active assignments.
- [ ] Doctor lists grandfathered lanes and unavailable-reviewer warnings.

## Formal and end-to-end verification

- [ ] FR-7 records no semantic impact for toggle, identity, and runner work.
- [ ] FR-7 designates Spec 015 row 20 before adopt or fallback lands.
- [ ] Semantic changes pass the pin check, focused harness, and TLC checks.
- [ ] The one-runtime lifecycle completes claim → needs-review → request-changes → re-handoff → approval to ready-for-pr.
- [ ] The lifecycle retains locks through PR flow and releases them only at termination.
- [ ] The required GitHub bot list remains unchanged.
- [ ] All error messages contain a direct recovery command.
- [ ] The managed `CLAUDE.md` Handoff Gate sentence includes the time-boxed solo-mode exception.
- [ ] Spec 017 leaves Draft only after all checklist items pass.
