---
name: tla-pin-sync
description: Keep specs/tla/*.tla pinned-hash headers in sync with the prose sections they track so formal specs never silently drift from prose. TRIGGER whenever a spec .md section with a corresponding .tla is edited, a .tla is authored or modified, pre-handoff runs on a lane that locks specs/ or specs/tla/, or the user says "check TLA pins", "re-pin", "pin drift", "update the pin", "TLA sync", "stale pin", "pin check". Also trigger when tla-author or tla-run-tlc finish so the pin stays tight with the work just landed.
---

# TLA+ Pin Sync

Use this skill whenever a prose spec section covered by a `.tla` file changes, whenever a `.tla` file is edited, or as part of `pre-handoff` on any lane that touches `specs/` or `specs/tla/`.

## Goal

Prevent prose-to-TLA+ drift. Either the `.tla` moves with the prose, or the author re-pins to explicitly acknowledge the edit was semantically neutral.

## Workflow

0. **Existence guard.** Check that `specs/tla/` contains at least one `.tla` file and that `scripts/tla_pin.py` exists. If either is missing (phase 0 or prose-only lane), report "no TLA artifacts — nothing to check" and stop. Do not error; this is a clean no-op.
1. Run `scripts/tla_pin.py --check` to list every `.tla` whose pinned hash no longer matches its target prose range.
2. For each stale pin, inspect the prose diff:
   - `scripts/tla_pin.py --show-range specs/tla/<file>.tla` prints the currently pinned range and its prose content.
   - `git diff -- <spec.md>` shows what changed in the prose.
3. Classify the prose change:
   - **Semantic change** (new state, transition, invariant, actor, concurrency claim): update the `.tla` first, then re-pin.
   - **Semantically neutral** (typo, formatting, clarification, reordering, link update): re-pin only.
4. Re-pin with `scripts/tla_pin.py --repin specs/tla/<file>.tla`. The script rewrites the header's `Pinned-hash:` line to the current range hash.
5. If the prose edit moved the pinned section up or down the file, update the pinned line range as part of the re-pin, not as a separate edit.
6. Re-run `scripts/tla_pin.py --check` and confirm zero stale pins before handoff.
7. If a `.tla` was edited but the pinned prose did not change, verify the edit still reflects the prose intent — a drifted `.tla` with a fresh pin passes sync but fails semantics. TLC via `tla-run-tlc` is the backstop.

## Constraints

- Do not re-pin without reading the prose diff. "Re-pin to make it green" is how stale specs ship.
- Do not edit the `Pinned-hash:` line by hand. Use `scripts/tla_pin.py --repin` so the hash is deterministic.
- Do not silently ignore `--check` failures during pre-handoff. Stale pins block the handoff per spec 002 §5.3.
- Do not widen or narrow the pinned range during re-pin unless the prose sections actually moved. Range changes are a separate edit.
- Do not run this skill when no `.tla` files exist yet (spec 002 phase 0). It is a no-op and should report "no specs/tla/ artifacts".

## Default Output

- Stale pin list (may be empty)
- Per-stale-pin: prose diff excerpt, semantic-vs-neutral classification, action taken
- Post-action `--check` result (must report zero stale pins)
- Remaining gaps if any `.tla` was re-pinned without a corresponding semantic review

## Failure mode to avoid

Re-pinning a `.tla` to make the check pass when the prose change was actually semantic. This defeats the purpose of the sync check. If you re-pin, you must be able to say in one sentence why the prose change does not affect the state machine.
