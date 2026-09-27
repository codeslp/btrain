# btrain typed-decision experiments

## Spec 021 offline foundation

`btrain handoff pull-pr` now stores append-only source snapshots under
`.btrain/jev/evidence/`. Each snapshot has the source repository, PR, comment URL and ID,
author, event and capture times, reviewed commit when GitHub supplies one, a body hash,
and the PR head observed during the pull. The event-time head stays `unknown`: polling
cannot prove what the head was when an earlier comment was written. Later outcomes are
appended separately through `appendSourceOutcome`; `readEvidence` includes an initial
`pending` outcome for every snapshot. These local records contain no comment body.

Use `annotationCandidates` from `src/brain_train/jev/manifest.mjs` to export source
references for independent labeling. Set `requireEventHead: true` for an exact-head PR
evaluation; current polling snapshots are excluded until a true event-time source exists.
`freezeLabeledManifest` requires two distinct annotators, adjudication, pinned model and
policy metadata, and one split per PR and normalized template group. It returns canonical
source metadata, a source hash, and a dataset hash. Replay checks both hashes, so a changed
source URL, reviewed commit, event head, or label fails before a provider call. Keep raw text
and candidate fixtures inside their source repository.

`decideCandidate` from `src/brain_train/jev/decision.mjs` defaults to `off`. In `offline`
mode an injected local fake provider can replay private fixtures without a hosted call.
It returns `skipped`, `decision`, `abstain`, or `failure` traces and only *suggests* an
allowed action. `appendDecisionTrace` requires the matching family and a source manifest proof,
then writes an allowlisted
local trace without the input text. Trace source references and provider/model IDs are opaque
hashes; source URLs and pinned model names remain inspectable in the local evidence and frozen
manifest. `replayManifest` requires candidate source content, hash, and URL to match the frozen
source before any provider call. It compares the pinned manifest
with a deterministic baseline and reports skips, valid abstentions, provider failures,
class metrics, coverage, latency, and observed cost separately. The focused executable
examples are `test/jev/*.test.mjs`.

This foundation does not enable live Jev use. Family-specific benchmarks, privacy and
retention decisions, shadow evidence, and human promotion records are still required by
Spec 021 before broad advisory or assist behavior.

These experiments compare btrain's current deterministic heuristics with a local,
Jev-compatible System One model. They do not change workflow state.

The frozen datasets cover:

- PR review signals: clear, actionable feedback, reviewer unavailable, and no verdict.
- Handoff packet quality: accept, repair, and uncertain.

Reproduce the saved PR-comment corpus audit from the local btrain and ai_sales checkouts:

```sh
node experiments/jev-btrain/audit-corpus.mjs \
  --manifest experiments/jev-btrain/corpus-source-manifest-2026-09-24.json \
  --author 'chatgpt-codex-connector[bot]' \
  --author 'unblocked[bot]' \
  --repo btrain=/path/to/btrain \
  --repo ai_sales=/path/to/ai_sales
```

The committed source manifest pins each file's JSONL prefix by line count and SHA-256 hash. The
audit verifies those prefixes and ignores later appended rows and new files, even when their
timestamps predate the cutoff. A changed or missing pinned prefix fails reproduction. To capture a
new manifest, run `audit-corpus.mjs --capture-manifest --before <ISO timestamp> --repo ...` and
save its JSON output; the timestamp selects the initial prefixes but cannot freeze them alone.

The audit emits aggregate counts and a fingerprint of every raw JSONL source record, never comment
bodies. It counts reviewer-bot issue/review text as an upper bound before current-head,
latest-signal, and deterministic filters. Commit IDs and the recognized Codex help footer are
normalized only for a diversity diagnostic; substantive details blocks and status-card content
are preserved. Core-message families are not gold labels.
The 2026-09-24 run is saved in `corpus-audit-2026-09-24.json` and explained in the research results
report. It found too little diverse, independently labeled evidence to run the proposed 200-case
comparison yet.

Run the deterministic baseline:

```sh
node experiments/jev-btrain/run.mjs --baseline-only
```

Run the local decision model after starting a compatible System One server:

```sh
KEV_BASE_URL=http://127.0.0.1:8009 node experiments/jev-btrain/run.mjs
```

Run hosted Jev with an existing environment file that defines `JEV_API_KEY`:

```sh
SYSTEM_ONE_BASE_URL=https://api.typesafe.ai \
SYSTEM_ONE_MODEL=jev-latest \
RESULT_SLUG=jev \
node --env-file=/path/to/private.env experiments/jev-btrain/run.mjs
```

Compare the two saved runs:

```sh
node experiments/jev-btrain/compare.mjs results-kev-0.6b.json results-jev.json
```

The comparison excludes missing or changed fixtures and rows where either provider has an
invalid prediction. It reports each exclusion class and coverage with the metrics.
It also rejects runs whose decision-configuration hashes differ. Run
`node experiments/jev-btrain/run.mjs --print-config-hashes` to inspect the current hashes.
Probability-distance metrics report separate coverage when a run lacks a valid vector.

The runner writes machine-readable results beside the fixtures. A separate Noul coverage
question reduces forced-choice errors but does not prevent them. The saved Kev
`uncertain-request` case still predicts `clear` with a verdict probability of 0.6.
All predictions remain advisory and cannot approve a PR or change workflow state.

Each request has a 10-second deadline, including response parsing. Set
`SYSTEM_ONE_TIMEOUT_MS` to change it within 100–60,000 ms. A timeout records a model
error with no prediction, excludes the case from classification metrics, records reduced
coverage and a failure count, and then continues to the next case.
Run the offline timeout regressions with `node --test experiments/jev-btrain/run.test.mjs`.
