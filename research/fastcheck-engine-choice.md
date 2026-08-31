# FR-6 Validation-Harness Engine Choice: fast-check

**Date**: 2026-08-31
**Supports**: spec 014 FR-6 (code-to-model validation)
**Decision**: fast-check is the pilot harness engine; replacing it is a spec 014 policy change.

## Question

Spec 014 FR-6 requires an executable harness that drives btrain's lane/lock
implementation with generated command sequences and validates the resulting
traces against the approved model. btrain is a Node.js/ESM codebase tested
with `node:test`. Which engine should generate, execute, shrink, and
reproduce those sequences?

## Candidates evaluated

The evaluation started from the Antithesis ecosystem survey (2026-08-31,
conversation-driven; sources below) and widened to the JS property-based
testing field.

### fast-check (chosen)

- MIT, mature (7+ years, de-facto standard for JS/TS PBT), zero runtime deps.
- First-class model-based testing (`fc.commands`) and arbitrary composition;
  we hand-roll the command interpreter for trace control, which it supports
  cleanly via `fc.array` of tagged records.
- Deterministic seeded runs (`seed`, `path`) — satisfies FR-6's
  reproducibility requirement and spec 014's credential-free CI constraint.
- Integrated shrinking: found minimal 2–3 command counterexamples for every
  divergence in the baseline runs.
- `fc.scheduler()` exists for the phase-2 interleaving/crash-window work.
- Risk: none material. Single-maintainer cadence is the usual OSS caveat.

### @hegeldev/hegel (Hypothesis-for-TS, Antithesis)

- MIT, built by the Hypothesis authors at Antithesis; protocol-based design
  with Hypothesis-grade shrinking; TS package needs Node 20.11+.
- Beta, weeks old at evaluation time, breaking changes announced as likely.
  Stateful/model-based testing story not yet established.
- Upside deferred, not lost: tests written for Hegel gain guided exploration
  if btrain ever runs inside the Antithesis platform. Revisit at 1.0.
- Verdict: comparison trial only, not a foundation for a governance-bearing
  harness.

### Bombadil (Antithesis)

- MIT, property-based testing for web and terminal UIs, TypeScript spec DSL
  over linear temporal logic (Quickstrom successor).
- Targets the UI layer, which spec 014 explicitly excludes from the first
  model. Version 0.x, experimental.
- Verdict: out of scope for FR-6; a candidate for later dashboard-layer
  properties.

### Antithesis SDKs / platform

- SDKs are MIT but deliberately no-op outside the proprietary hypervisor
  platform; the platform is commercial (per-core pricing, OSS grant program).
- Verdict: not usable as a standalone OSS engine; keep as a future option.

### jsverify / testcheck-js (legacy JS PBT)

- Both effectively unmaintained; no reason to prefer them over fast-check.

## Decision criteria applied

| Criterion | fast-check | hegel | bombadil |
| --- | --- | --- | --- |
| Maturity for a governance gate | strong | beta | 0.x |
| Model-based command sequences | yes | not yet | n/a (UI) |
| Seeded deterministic repro | yes | yes | partial |
| Credential-free CI | yes | yes | yes |
| Fits `node:test` / ESM | yes | yes | separate runner |

## Baseline evidence

A prototype harness built on fast-check (2026-08-31, developed in lane d and
landing as a separate change — not part of the spec revision this document
accompanies) reproduced the designated close-without-merge drift as a shrunk
5-step counterexample, surfaced six previously unrecorded candidate findings
(actor-authorization and source-status gaps), and ran 60 property executions
in ~0.5s with full seed reproduction. The lane d change adds `test/formal/`
with the harness, its contract model, and the findings ledger; until it
merges, the numbers here are working-tree measurements. They are the
empirical basis for making the engine choice policy rather than preference.

## Revisit conditions

- Hegel reaches a stable 1.0 with a stateful testing API, or btrain adopts
  the Antithesis platform (Hegel then buys guided exploration for free).
- fast-check becomes unmaintained or blocks a needed capability
  (interleaving exploration is the one to watch in phase 2).

## Sources

- Antithesis docs: https://antithesis.com/docs/introduction/welcome/
- Hegel announcement and repos: https://antithesis.com/blog/2026/hegel/,
  https://github.com/hegeldev/hegel-typescript
- Bombadil: https://github.com/antithesishq/bombadil, Wickström,
  "From Quickstrom to Bombadil" (2026-01-28)
- fast-check: https://github.com/dubzzz/fast-check
