---
name: tla-author
description: Draft a skeleton TLA+ specification from a prose spec section under TLC feedback, never blind generation. TRIGGER when the user says "draft a .tla for §X", "formalize this section", "write a TLA spec for the advisory lifecycle", "turn this into TLA+", "start the §6.6 spec", "author the handoff state machine", or when spec 002 phase 1+ needs a new .tla and none exists for the target section. Do NOT trigger for pin management (use tla-pin-sync) or for narrating a counterexample (use tla-trace-explain). For editing an existing .tla, re-invoke this skill with the existing file as starting point — the same TLC feedback loop applies.
---

# TLA+ Author

Use this skill to draft the first version of a `.tla` + `.cfg` pair for an eligible prose spec section per spec 002 §3.

## Goal

Translate prose state-machine claims into a TLA+ skeleton with named invariants, sized for TLC to reach a verdict in under a minute. Every draft is validated against TLC before handoff — this skill is never blind generation.

## Workflow

1. Confirm the target section qualifies per spec 002 §3 (state transitions, temporal claims, multi-actor concurrency, or chain-of-guarantee reasoning). If it does not, stop and suggest the prose stays prose.
2. Extract from the prose, in order:
   - **State variables.** Everything the prose refers to as a persistent fact (advisory table, lock holder, handoff status, etc.).
   - **Actions.** Every verb with a state delta: `Surface`, `SuppressDup`, `Resolve`, `Claim`, `Update`.
   - **Invariants.** Every "never", "always", "at most one", "at least one", "eventually" claim. Phrase each as a single predicate with a name that mirrors the prose phrasing.
   - **Actors / concurrency.** Every distinct caller or process that can interleave. Two is enough for a pilot; add more only if the prose explicitly requires it.
3. Draft a `.tla` skeleton with:
   - MODULE header including the `Pinned to` + `Pinned-hash` block so `tla-pin-sync` can protect the file.
   - VARIABLES declaration matching step 2's state variables.
   - Init predicate covering all variables.
   - One action predicate per step-2 action, with explicit `UNCHANGED` clauses for variables the action does not touch.
   - Next relation as a disjunction of actions.
   - Invariant definitions, one per step-2 invariant, with names that read back to the prose.
   - Spec definition as `Init /\ [][Next]_vars`. Add `WF_vars(Next)` (weak fairness) only when the prose explicitly contains liveness claims ("eventually", "must happen", "is guaranteed to complete"). Safety-only specs (invariants, "never", "at most one") do not need fairness.
4. Draft a matching `.cfg`:
   - CONSTANTS sized for pilot bounds (e.g. 2 actors, 3 conditions) — small enough to finish fast.
   - INVARIANTS listing every invariant declared in the `.tla`.
   - SPECIFICATION line pointing at `Spec`.
5. Run `tla-run-tlc` on the draft. Iterate based on the verdict:
   - **counterexample** — read the trace. Either tighten the action predicate (the draft was under-constrained) or mark the prose as wrong (the claim was false). Never alter invariants to dodge a real counterexample.
   - **state_space_exhausted** — reduce CONSTANTS and re-run. Document the bound choice as a comment in the `.cfg`.
   - **pass** — continue to step 6.
6. Re-pin with `tla-pin-sync --repin` so the header reflects the final prose range.
7. Write the summary for handoff: which invariants were proved, under which bounds, and which prose paragraph each invariant maps to.

## Constraints

- Do not invent invariants the prose does not state. If a claim feels implied but is not written down, edit the prose first and then author the invariant.
- Do not ship a `.tla` that has not been run through TLC. Spec 002 decision 2 makes feedback-loop authorship the contract.
- Do not author a `.tla` for a section that does not qualify per spec 002 §3. Ineligible sections stay prose.
- Do not use giant CONSTANTS to "be thorough". Pilot bounds are small by design; widen only after the small model passes.
- Do not omit the `Pinned to` / `Pinned-hash` header. Without it, `tla-pin-sync` cannot protect the file from drift.

## Default Output

- Draft `.tla` + `.cfg` under `specs/tla/`
- Invariant-to-prose mapping table: invariant name → paragraph or bullet it encodes
- TLC verdict from the final run
- Chosen CONSTANTS bounds + one-line rationale
- Any prose edits proposed along the way (counterexamples that revealed prose gaps)

## Anti-example

Author writes a 400-line `.tla` in one shot, runs TLC once, hits state_space_exhausted, pushes anyway. Reviewer cannot tell whether invariants hold. **Correct approach:** write the smallest `.tla` that captures the prose, prove the invariants under tight bounds, then widen only if needed.
