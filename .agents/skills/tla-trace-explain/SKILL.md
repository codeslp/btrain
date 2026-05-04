---
name: tla-trace-explain
description: Narrate a TLC counterexample trace in prose that maps each step back to the spec paragraph it contradicts, so a non-TLA-fluent reviewer can act on the finding. TRIGGER when tla-run-tlc returns a counterexample, when CI posts a TLC trace to a PR, when the user says "explain this trace", "what did TLC find", "why did the invariant break", "narrate the counterexample", "walk me through the trace", or when a reviewer asks for the prose interpretation of a failed model check. Do NOT trigger for authoring a .tla (use tla-author), for pin management (use tla-pin-sync), or for running TLC (use tla-run-tlc).
---

# TLA+ Trace Explain

Use this skill whenever a TLC counterexample needs to be communicated to a reviewer who may not read TLA+ fluently.

## Goal

Turn a raw TLC trace into a step-by-step narrative that points at the exact prose claim it breaks, so the reviewer can decide whether the spec is wrong or the `.tla` is.

## Workflow

1. Load the structured verdict at `specs/tla/.tlc-results/<name>.json` produced by `tla-run-tlc`. If it is not present, run `tla-run-tlc` first — this skill never narrates from a raw run.
2. Read the `.tla` header to resolve which prose file and line range the spec is pinned to. If the file is unpinned, stop and point the user at `tla-pin-sync` — you cannot map to prose without a pin.
3. Read the prose section so every action name in the trace maps back to a prose verb. Build a map inline: "action `Surface`" → "§5.1 bullet 3: 'surface the advisory'".
4. For each step in the trace, write one line:
   - **Step N** — Action name fired.
   - State delta: which variable changed, from what to what.
   - Prose anchor: which paragraph or bullet this step is supposed to cover.
   - Intent-vs-reality note when the step exposes a prose gap.
5. Write the post-mortem: which invariant failed, at what step, and which prose paragraph claimed the behaviour that did not hold.
6. Produce three recommendations, in order of confidence:
   - **Tighten prose.** Add the missing precondition, clarification, or ordering guarantee the trace exposed. Most counterexamples land here.
   - **Tighten `.tla`.** If the prose was correct and the `.tla` under-constrained the action, narrow the action predicate.
   - **Change the invariant.** Only if the prose claim was actually wrong — rare, flag explicitly.
7. Output the narrative as a PR comment or pre-handoff review ask. Keep it under 30 lines so a reviewer reads it in one breath.

## Constraints

- Do not paste the raw TLC trace without narration. A reviewer who wanted the raw trace would read it directly.
- Do not conclude "the invariant is wrong" without explicitly checking the prose. Most counterexamples expose prose gaps, not invariant errors.
- Do not invent prose anchors. If a step has no matching prose paragraph, say so — that itself is a finding.
- Do not narrate traces from specs that are not pinned. Resolve the missing pin first.
- Do not drop steps to shorten the narrative. Every step in the trace is a step TLC needed to reach the counterexample; omitting one loses the thread.

## Default Output

- One-line summary: which invariant failed, at what step, under which conditions.
- Step-by-step narrative with prose anchors.
- Three-option recommendation (tighten prose / tighten `.tla` / change invariant).
- Proposed edits as diff-style snippets when the fix is small.

## Failure mode to avoid

Paraphrasing the trace without actually reading the prose. Reviewer gets a pretty story that does not land on the real claim. **Correct approach:** every step has a prose anchor or an explicit "no matching prose" finding, and the post-mortem names the paragraph the invariant came from.
