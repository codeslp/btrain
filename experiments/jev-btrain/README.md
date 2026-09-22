# btrain typed-decision experiments

These experiments compare btrain's current deterministic heuristics with a local,
Jev-compatible System One model. They do not change workflow state.

The frozen datasets cover:

- PR review signals: clear, actionable feedback, reviewer unavailable, and no verdict.
- Handoff packet quality: accept, repair, and uncertain.

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

The comparison excludes rows where either provider has no prediction. It reports the
excluded failure count and comparison coverage with the classification metrics.

The runner writes machine-readable results beside the fixtures. A separate Noul coverage
question reduces forced-choice errors but does not prevent them. The saved Kev
`uncertain-request` case still predicts `clear` with a verdict probability of 0.6.
All predictions remain advisory and cannot approve a PR or change workflow state.

Each request has a 10-second deadline, including response parsing. Set
`SYSTEM_ONE_TIMEOUT_MS` to change it within 100–60,000 ms. A timeout records a model
error with no prediction, excludes the case from classification metrics, records reduced
coverage and a failure count, and then continues to the next case.
Run the offline timeout regressions with `node --test experiments/jev-btrain/run.test.mjs`.
