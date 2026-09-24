# btrain typed-decision experiments

These experiments compare btrain's current deterministic heuristics with a local,
Jev-compatible System One model. They do not change workflow state.

The frozen datasets cover:

- PR review signals: clear, actionable feedback, reviewer unavailable, and no verdict.
- Handoff packet quality: accept, repair, and uncertain.

Audit whether captured PR-comment history can support a larger corpus before adding cases:

```sh
node experiments/jev-btrain/audit-corpus.mjs \
  --before 2026-09-24T22:00:00Z \
  --author 'chatgpt-codex-connector[bot]' \
  --author 'unblocked[bot]' \
  --repo btrain=/path/to/btrain \
  --repo ai_sales=/path/to/ai_sales
```

The audit emits aggregate counts and a fingerprint of every raw JSONL source record, never comment
bodies. It counts reviewer-bot issue/review text as an upper bound before current-head,
latest-signal, and deterministic filters. The cutoff freezes the source population as the logs
grow. Commit IDs and the recognized Codex help footer are normalized only for a diversity
diagnostic; substantive details blocks and status-card content are preserved. Core-message
families are not gold labels.
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
