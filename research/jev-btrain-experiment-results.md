# JEV Payoff Experiments for btrain

**Date:** 2026-09-20  
**Status:** Small offline pilot. No production behavior changed.  
**Models:** hosted `jev-1.13.0` and local `jaredpalmer/kev-0.6b`  
**Artifacts:** [`experiments/jev-btrain/`](../experiments/jev-btrain/)

## Result

Hosted Jev shows enough value to justify a larger shadow experiment for two btrain tasks:

1. Interpret current-head PR review comments that deterministic rules cannot classify.
2. Check handoff packets for semantic mismatch, hidden failures, and unresolved evidence.

Kev-0.6B does not reproduce Jev's results. It is not accurate enough for either btrain task in
this pilot. The two models agreed on only 57.1% of all PR cases and 50.0% of all handoff cases.

The result applies only to Kev-0.6B. The Kev project recommends Kev-4B as its best accuracy per
byte, but it documents a 32 GB Mac requirement. The test machine has 16 GB, so this pilot did not
run Kev-4B.

## Experiment design

The pilot froze labels before either model ran.

| Dataset | Labels | Calibration | Held-out test | Total |
| --- | --- | ---: | ---: | ---: |
| PR review signals | `clear`, `feedback`, `unavailable`, `uncertain` | 14 | 14 | 28 |
| Handoff packet quality | `accept`, `repair`, `uncertain` | 9 | 9 | 18 |

The PR dataset mixes real btrain bot-comment shapes with controlled paraphrases. The handoff
dataset covers coherent packets, placeholders, objective/change mismatches, weak verification,
hidden failures, contradictions, honest uncertainty, and incomplete investigations.

The deterministic PR baseline mirrors the regular expressions in `src/brain_train/pr-flow.mjs`.
The deterministic handoff baseline checks field presence and placeholder text. Every model call
used the same state, question text, option descriptions, and ordering.

The PR request included a separate `hasVerdict` Noul. Code changed a forced `clear` or `feedback`
choice to `uncertain` when the Noul probability was below 0.5. This separates coverage from
Choice confidence.

## Held-out results

### Accuracy

| Task | Deterministic baseline | Kev-0.6B | Jev 1.13.0 |
| --- | ---: | ---: | ---: |
| PR signals, 14 cases | 50.0% | 64.3% | **100.0%** |
| Handoff packets, 9 cases | 66.7% | 33.3% | **88.9%** |

The PR baseline detected operational failures reliably but missed semantic paraphrases. It had
zero recall for the held-out `feedback` class. Jev classified all four classes correctly.

Jev missed one held-out handoff case. It accepted a packet that tested only the allowed side of a
cross-lane guard and omitted a negative-path test. This miss matters because it shows that a Jev
handoff result cannot replace risk-based deterministic verification requirements.

Kev-0.6B classified every handoff packet as `accept`. The additional atomic Noul scores did not
provide a clean enough boundary to repair this behavior without overfitting the nine calibration
cases.

### Model agreement

| Task | Held-out agreement | Agreement over all cases | Mean absolute probability difference, held-out |
| --- | ---: | ---: | ---: |
| PR signals | 64.3% | 57.1% | 0.157 |
| Handoff packets | 44.4% | 50.0% | 0.229 |

The answer to “do Kev and Jev give the same results?” is **no** for Kev-0.6B. Most disagreements
were useful Jev corrections. On the held-out PR set, Jev recovered three feedback paraphrases,
one clear paraphrase, and one review request that Kev incorrectly treated as clear. On the held-out
handoff set, Jev detected three repair cases and two uncertain cases that Kev accepted.

### Repeatability

The pilot ran hosted Jev three times on the same 46 inputs.

- Top-choice agreement was 100% across all three runs.
- PR probability vectors had a mean absolute difference of 0.000 in both repeat comparisons.
- Handoff probability vectors differed by 0.019 and 0.011 on average.
- Accuracy was unchanged across all three runs.

This is a useful stability signal, not a calibration proof.

### Latency and estimated input cost

| Task | Kev-0.6B local p50 / p95 | Jev hosted p50 / p95 |
| --- | ---: | ---: |
| PR signals | 113 / 118 ms | 171 / 385 ms |
| Handoff packets | 186 / 189 ms | 228 / 298 ms |

The Jev run processed 23,368 input tokens. At the `$0.042 / million input tokens` rate recorded by
the existing ai_sales connectivity test on 2026-09-16, the 46-call run cost approximately
`$0.00098` in input charges. This estimate is not a current pricing guarantee.

Local Kev was faster after its 1.19 GB checkpoint loaded. It was not accurate enough for the
measured tasks, so its latency advantage has no practical value yet.

## Payoff ranking

### 1. PR review-signal interpreter: graduate to a larger shadow test

This is the clearest payoff.

- Jev improved held-out accuracy from 50.0% to 100.0%.
- The input is short.
- Latency is below the existing multi-second reviewer workflow cost.
- Provider failure can return `uncertain` without changing lane state.
- btrain already has real comment logs and eventual lane outcomes for a larger dataset.

The implementation must keep these checks deterministic:

- bot identity
- exact-head matching
- timestamps and newest-signal ordering
- GitHub formal review state
- inline-comment presence
- positive reaction markers
- merged, closed, and draft PR state

Jev should only classify unresolved current-head text as `clear`, `feedback`, `unavailable`, or
`uncertain`. It must not advance a lane directly.

### 2. Semantic handoff linter: continue as an advisory experiment

Jev improved held-out accuracy from 66.7% to 88.9%. It detected mismatched changes, hidden test
failures, undisclosed gaps, and honest uncertainty that the placeholder check missed.

It also accepted a packet that omitted a necessary negative-path test. Keep this feature advisory.
Use it to request packet repair or focus reviewer attention. Do not let it approve a handoff, waive
mandatory checks, or replace the peer reviewer.

The next dataset should use real packets paired with reviewer outcomes:

- approved without packet feedback
- returned because the packet was vague or unsupported
- returned because a claimed verification did not cover the risk
- accepted research or diagnosis with explicit uncertainty

### 3. Kev-0.6B local routing: stop

Do not integrate Kev-0.6B into btrain. It missed seven of eight PR feedback cases across the full
dataset and accepted all 18 handoff packets.

A future Kev comparison should use Kev-4B or a newer released checkpoint on suitable hardware. It
must use this same frozen dataset before any question rewrite or threshold change.

### 4. Context curation and supervisor signals: not measured yet

This pilot does not establish payoff for transcript compaction, context selection, stuck detection,
or completion detection. Those tasks need different labels and stronger safety analysis. The PR
classifier should run in shadow mode first because it has a clearer baseline and lower behavioral
risk.

## Recommended next gate

Build a 200-case PR corpus from btrain and ai_sales comment logs. Freeze it before the next Jev
run. Include at least 30 examples in each class and explicit negative controls for requests,
progress updates, quota failures, author replies, and social comments.

Proceed to a two-week live shadow only if the frozen test meets all of these conditions:

- at least 95% overall accuracy
- at least 95% recall for `feedback`
- zero false `clear` decisions on feedback, unavailable, or uncertain controls
- 100% agreement with deterministic stale-head and identity filters
- less than 1% provider or response-shape failure
- stable results on a pinned model version

During shadow mode, record the deterministic result, Jev probabilities, model version, latency,
input hash, and eventual human or bot disposition. Do not record credentials or unrelated comment
content.

## Reproduction

Run the baseline:

```sh
node experiments/jev-btrain/run.mjs --baseline-only
```

Run a local System One-compatible server, then run Kev:

```sh
RESULT_SLUG=kev-0.6b node experiments/jev-btrain/run.mjs
```

Run hosted Jev with a private environment file:

```sh
SYSTEM_ONE_BASE_URL=https://api.typesafe.ai \
SYSTEM_ONE_MODEL=jev-latest \
RESULT_SLUG=jev \
node --env-file=/path/to/private.env experiments/jev-btrain/run.mjs
```

Compare saved runs:

```sh
COMPARISON_SLUG=kev-vs-jev \
node experiments/jev-btrain/compare.mjs results-kev-0.6b.json results-jev.json
```

## Evidence and limits

The machine-readable outputs are:

- `results-baseline.json`
- `results-kev-0.6b.json`
- `results-jev.json`
- `results-jev-run2.json`
- `results-jev-run3.json`
- `comparison-kev-vs-jev.json`
- `comparison-jev-repeat-1-2.json`
- `comparison-jev-repeat-1-3.json`

The sample is small. Synthetic cases are intentionally balanced and do not estimate production
prevalence. One researcher wrote the labels. No second blind annotator checked them. The experiment
tests question usefulness and failure shape, not final production accuracy.

Kev is a Jev-compatible reconstruction, not the same model. See the
[`kev` repository](https://github.com/jaredpalmer/kev) for its architecture, checkpoint caveats,
and published evaluation partitions.

## Context receipt

**Context tier:** deep  
**Question:** Which bounded Jev decisions have safe btrain seams, prior calibration evidence, and
real artifacts for evaluation?  
**Sources:** [staff_search PR #2](https://github.com/Rapid-Agency/staff_search/pull/2),
[staff_search PR #4](https://github.com/Rapid-Agency/staff_search/pull/4), local btrain PR comment
logs, `src/brain_train/pr-flow.mjs`, and the needs-review checks in `src/brain_train/core.mjs`.  
**Constraints:** coverage must be separate from Choice confidence; shared evidence belongs in
state; provider failure keeps the deterministic path; typed decisions never override identity,
head, authorization, or verification gates.  
**Gaps:** no Kev-4B run, no production-prevalence corpus, no second labeler, and no live shadow
period.  
**Durable writeback:** this report and the frozen experiment artifacts.
