# TLA+ Models (spec 014 Phase 1)

This directory holds the formal models of designated btrain contracts, their
TLC configurations, cached verdicts, and pin headers.

## Setup

TLC needs Java 17+ and the official `tla2tools.jar`:

```bash
mkdir -p ~/.local/lib
gh release download v1.7.4 --repo tlaplus/tlaplus --pattern tla2tools.jar --dir ~/.local/lib
export TLC_JAR=~/.local/lib/tla2tools.jar
```

Pinned tool version: tla2tools **v1.7.4** (TLC2 2.19),
sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.

## Run

```bash
cd specs/tla
java -cp "$TLC_JAR" tlc2.TLC -config LaneLock.cfg -workers auto LaneLock.tla
```

Expected: `Model checking completed. No error has been found.` The structured
verdict is cached at `.tlc-results/LaneLock.json`, keyed by the `.tla`
content hash. Baseline: 2,724,433 states generated, 277,681 distinct,
depth 19, ~2 seconds.

## Pin check

Every `.tla` carries `\* Pinned to:` and `\* Pinned-hash:` header lines that
tie it to designated prose sections. The deterministic drift check:

```bash
python3 scripts/tla_pin.py --check                       # all models
python3 scripts/tla_pin.py --show-range specs/tla/LaneLock.tla
python3 scripts/tla_pin.py --repin specs/tla/LaneLock.tla
```

A stale pin blocks handoff (spec 014 FR-5). Re-pin only after classifying
the prose change; never re-pin to silence the check.

## LaneLock.tla

Models the designated lane/lock contract. The model encodes INTENDED
behavior only — designated implementation drift (close-without-merge to
`repair-needed`, unaudited release, the `--final` bypass) does not exist in
the model. The FR-6 harness (`test/formal/`) covers the code side.

Pilot bounds (in-module, per the tla-author skill): 2 lanes, 3 agents,
3 abstract paths with one nesting conflict, 4 claimable lock sets. Small by
design; widen only after the small model passes.

### Invariant-to-prose mapping

| Invariant | Designated prose |
| --- | --- |
| `Exclusivity` | spec 002 v1.1.2 Lock Enforcement: no two lanes hold conflicting paths |
| `CoverageForActive` | spec 002/014: active lanes have matching handoff/registry coverage except after an audited force-release |
| `TerminalClean` | spec 002 v1.1.2: terminal `resolved` (and `idle`) hold no registry locks |
| `ReviewerSeparation` | spec 014 Pilot Scope: owner and reviewer separation on active lanes |
| `ActiveHasLocks` | designated active-lane lock requirement (spec 014 v0.1.9) |
| `PrFlowRetention` | spec 002 v1.1.2: locks retained through `ready-for-pr`, `pr-review`, `ready-to-merge` |
| `TypeOK` | state-space sanity, no prose claim |

### Verification hygiene

The baseline run includes a mutation check: removing `NoConflictWithOthers`
from `Claim` makes TLC report `Invariant Exclusivity is violated`, so the
invariants are load-bearing, not vacuous.

### Known gaps

- Repair-attempt counting and the spec 006 FR-18 one-retry escalation bound
  are not modeled (no counter variable yet).
- The model pins spec 014's Normative-source prerequisite section, which
  names the spec 002/005/006 ranges by reference; the upstream sections are
  not directly pinned.
- Crash windows between the handoff write and the registry write are not
  modeled; the writes are atomic in the model.
- TLC trace validation against harness-emitted traces is future work
  (spec 014 authority chain, link 4).
