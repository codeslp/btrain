---
name: tla-run-tlc
description: Invoke the TLC model checker on a specs/tla/*.tla file, parse output into a structured verdict (pass / counterexample / state_space_exhausted), and cache the result for downstream skills and CI. TRIGGER when the user says "run TLC", "model check", "check the TLA spec", "check invariants", "verify <name>.tla", "does the spec hold", when CI needs to validate a .tla, when a .tla has just been authored or edited, or when pre-handoff needs TLC confirmation. Do NOT trigger for pin management (use tla-pin-sync) or for narrating a counterexample to a reviewer (use tla-trace-explain).
---

# TLA+ Run TLC

Use this skill whenever a `.tla` in `specs/tla/` needs to be model-checked — after authoring, after refactoring, during CI, or when investigating a suspected counterexample.

## Goal

Produce a structured, reviewer-ready verdict on whether the invariants in a TLA+ spec hold under its `.cfg` bounds, with a full trace when they don't.

## Workflow

1. Confirm TLC is reachable: `which tlc` or `java -cp "$TLC_JAR" tlc2.TLC -help`. If neither resolves, stop and point the user at `specs/tla/README.md` for setup — do not "try something" and emit a misleading verdict.
2. Locate the target `.tla` and its sibling `.cfg`. If the `.cfg` is missing, fail fast with the path — TLC without CONSTANTS and INVARIANT declarations produces nonsense.
3. Run TLC with bounded, deterministic options:
   - `-config <file>.cfg`
   - `-workers auto`
   - `-deadlock` only when the spec declares natural termination; otherwise leave default
   - 5-minute wall clock by default; override with `--timeout <sec>` only when the spec header documents the reason
   - capture stdout and stderr separately
4. Parse the output into exactly one of three verdicts:
   - **pass** — "Model checking completed. No error has been found." → `{status: "pass", states_explored, distinct_states, depth}`
   - **counterexample** — "Error: Invariant <name> is violated." → extract the trace as an ordered list of `{step, action, state_delta}` plus the violated invariant name
   - **state_space_exhausted** — wall clock hit before completion or memory exhausted → `{status: "state_space_exhausted", states_explored, depth_reached, reason}`
5. On counterexample, add a one-line summary: e.g. `"AdvisoryLifecycle: NoLostSignal violated after 7 steps — resolve on lane b dropped under concurrent status call."` This line is what a reviewer reads first.
6. Cache the structured verdict at `specs/tla/.tlc-results/<tla-name>.json`, keyed by the `.tla` content hash, so pre-handoff, CI, and `tla-trace-explain` consume it without re-running TLC.
7. Return the verdict and the cache path. Exit codes match spec 002 §5.4:
   - 0 on pass
   - 1 on counterexample (CI blocks)
   - 124 on state_space_exhausted (CI warns, does not block)

## Constraints

- Do not run TLC without a `.cfg`. Unconfigured runs waste wall clock and produce misleading "deadlock" errors.
- Do not silently override the timeout. If a spec needs longer, document it in the `.tla` header and the CI config.
- Do not parse TLC stdout with brittle regex. Use the documented output markers ("Model checking completed.", "Error: ", "Invariant ... is violated.", "Finished in ...").
- Do not discard the trace on counterexample. The trace IS the value of this skill's output.
- Do not re-run TLC when a fresh `.tlc-results/<name>.json` already exists for the current `.tla` content hash. Cache by content hash and invalidate on edit.
- Do not conflate state-space exhaustion with failure. Exhaustion is a bound problem, not a correctness problem; narrate as warning and exit 124.

## Default Output

- Verdict: pass / counterexample / state_space_exhausted
- Counts: states_explored, distinct_states, depth
- On counterexample: ordered trace, violated invariant name, one-line summary
- On state_space_exhausted: cause (timeout / memory), depth reached, suggested bound reduction
- Path to the cached structured result under `specs/tla/.tlc-results/`

## Failure mode to avoid

Running TLC, ignoring the output format, and telling the user "it passed" because the process exited 0 (TLC can exit 0 on fatal config errors too). Always parse the structured markers; never trust the exit code alone.
