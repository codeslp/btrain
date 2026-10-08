# btrain typed-decision experiments

## Spec 021 offline foundation

`btrain handoff pull-pr` now stores append-only source snapshots under
`.btrain/jev/evidence/`. Each snapshot has the source repository, PR, comment URL and ID,
author, event and capture times, reviewed commit when GitHub supplies one, a body hash,
and the PR head observed during the pull. The event-time head stays `unknown`: polling
cannot prove what the head was when an earlier comment was written. Later outcomes are
appended separately through `appendSourceOutcome`; `readEvidence` includes an initial
`pending` outcome for every snapshot. These local records contain no comment body.
Version 2 snapshot IDs bind the comment identity, edit timestamp (or creation time), and
body hash. Repeated observations deduplicate; edits append a new immutable version.
Legacy snapshots remain readable.

Use `annotationCandidates` from `src/brain_train/jev/manifest.mjs` to export source
references for independent labeling. Set `requireEventHead: true` for an exact-head PR
evaluation; current polling snapshots are excluded until a true event-time source exists.
`freezeLabeledManifest` requires two distinct annotators, adjudication, pinned model and
policy metadata, and one split per PR and normalized template group. It returns canonical
source metadata, a source hash, and a dataset hash. Replay checks both hashes, so a changed
source URL, reviewed commit, event head, or label fails before a provider call. Keep raw text
and candidate fixtures inside their source repository.
Freezing and replay share corpus grouping validation: duplicate case sources and PR or
template groups crossing splits are rejected even when a caller recomputes the dataset
hash. Replay validates every candidate before making calls and copies the frozen manifest
before awaiting a provider.

`decideCandidate` from `src/brain_train/jev/decision.mjs` defaults to `off`. In `offline`
mode an injected local fake provider can replay private fixtures without a hosted call.
Create a `createDecisionRun(family)` token for each independent case and pass it as `run`;
reuse that token across retries so the gateway enforces the family's call budget.
Providers receive an abort signal when a call times out. Failed responses retain sanitized
billed usage when the provider returns it.
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
Persisted failure and skipped traces have no prediction, probabilities, or suggested
action; abstentions have no suggested action. Every non-decision record has `actionTaken: none`.
Successful records require a typed SHA256 input hash, and decision choices must be nonempty
strings before constructing a family. Imported corpus source URLs with credentials, query
parameters or fragments fail validation; prospective capture strips those fields first.
Regression tests cover the persisted record and freeze boundaries, since gateway-generated
happy paths alone do not exercise malformed imported records.

The shared experimental family gateway stays offline. Separately, the existing live PR
interpreter now defaults to feedback-only assist under the explicit 2026-10-01 user instruction.
This does not claim that the larger benchmark or shadow gates passed. Other family adapters
need their own live hooks and evaluations.

These experiments compare btrain's current deterministic heuristics with a local,
Jev-compatible System One model. They do not change workflow state.

## Offline routing and memory prototypes (T014)

`rankEligibleRoutes` and `inspectMemoryClaim` accept a serialized JSON source record,
its frozen single-source proof, and an injected local provider. They default to `off`;
`offline` requires a model pin, code revision, and matching content hash. The adapters
derive their entire input from that frozen record and copy the proof before any call.
Provider input contains only validated fields; source references must be bounded URL
strings. Nested extra metadata is excluded so provider mutation cannot change later
comparisons or warning citations under the same frozen proof.
Hosted private calls remain denied. Neither adapter is connected to live workflow commands.

Routing records contain `{kind, objective, requiredCapabilities, candidates}`. Kinds are
`task`, `lane`, `reviewer`, `runner`, and `skill`. Each candidate has an ID, actor ID,
description, capability list, and explicit boolean `authorized`, `available`, and
`lockCompatible` observations from the deterministic catalog. Missing observations exclude
the candidate. Reviewer records require `ownerId`; that actor is excluded. Optional
`separateFrom` actor IDs enforce additional role separation. Only eligible candidates reach
the provider. Their original catalog order is the baseline. High-confidence scores may
rank at most 16 candidates; ties preserve baseline order. An incomplete ranking, provider
failure, or oversized eligible catalog preserves the complete baseline. Returned IDs are
proposals over a historical eligibility snapshot. Any future live caller must recompute
authorization, availability, locks, role separation, and capabilities before dispatch.

Memory records contain `{asOfSequence, claim, events}`. A claim has an ID, key, positive
version, text, source reference, `observedSequence`, and `leaseUntilSequence`. Events have
IDs, keys, positive versions, sequences, text, source references, and an explicit `authorized`
boolean. Only authorized events with the same key, a higher version, and a sequence after
the claim observation and at or before `asOfSequence` are compared. At most 16 comparisons
are attempted. A high-confidence supersession answer returns a `possibly-stale` warning
citing the supplied claim and event versions and references. It never edits memory or event
history. The comparator marks an expired sequence lease as stale. This prototype assumes
positive integer claim versions; nonmonotonic or content-addressed version schemes need a
separate deterministic ordering adapter.

`experiments/jev-btrain/routing-memory.mjs` accounts for paired routing outcomes and memory
supersession labels. Routing kinds and real, synthetic, and unknown origins are reported
separately. It measures ineligible proposals, routing success change, and precision/recall
against the age baseline. It always reports `gateReady: false`: paired measurements alone
do not prove independent labels, frozen splits, or promotion readiness. G8 still requires
100 real routing decisions plus 100 real memory claims with at least 30 superseded, the
gateway failure/coverage floors, and privacy/shadow/human promotion gates.
Routing measurements retain the first eligible catalog destination as the deterministic
baseline; an absent baseline is valid only when the eligible catalog is empty. Real-case
source hashes must be strings, so coercible metadata cannot enter the real-case counts.

Run the synthetic authority and paired accounting controls:

```sh
rtk env -- node --test test/jev/routing-memory.test.mjs experiments/jev-btrain/routing-memory.test.mjs
```

Every returned gateway trace keeps `actionTaken: none`. Offline traces compose with
`appendDecisionTrace(root, trace, family, sourceProof)` even for excluded routing entries: every catalog entry has
a trace, and exclusions never consume provider calls. Paired measurements for the same
baseline and suggested destination must agree on success; identical routes cannot create
an apparent benefit from contradictory labels.
The writer saves redacted local evidence. Default-off traces omit frozen provenance
and are not persisted by that writer.
Frozen record adapters deeply copy the complete supplied source proof, preserving all
canonical metadata used by the source snapshot hash through later caller mutations.

## Offline repository rules, turn rules, and review risk (T012)

`inspectRules` compiles one supplied explicit rule/evidence pair at a time into a closed
`violation`/`conforming`/`uncertain` question. `repositoryRuleFamily` (diff) and
`turnRuleFamily` (turn) have distinct IDs and policy hashes. Records contain
`{kind, rules, artifacts, checks}`. Rules need unique IDs, versions, bounded text, source
references, and explicit boolean `explicit` and `authorized` observations. Artifacts need
unique IDs, matching kind, authorized source references, and bounded text. Checks reference
supplied rule and artifact IDs, have `applicable: true`, and record the current deterministic
baseline choice. Only explicit, authorized, applicable pairs reach the local provider.
Authorization and applicability observations are captured from the deterministic workflow;
this prototype does not infer them from text or fetch sources itself.

At most 16 checks are attempted per run. A high-confidence violation returns a
`possible-rule-violation` candidate citing exactly the supplied rule/version/reference and
artifact/reference. Provider-generated rule IDs, citations, or extra metadata are ignored.
Warnings contain no generated diagnosis and require human review. Invalid answers, uncertainty,
low confidence, and provider failures produce no warning. The independent policies remain
offline; the later G6-R opt-in label pilot is not activated by this code.

`prioritizeReviews` reads `{objective, reviews}`. Every review has a unique ID, source
reference, bounded evidence text, an explicit authorization observation, and a nonempty
`requiredChecks` list. Only authorized evidence reaches the provider. It proposes an order
for queues of at most 16 entries, keeps stable ties, and falls back to the entire original
queue when scoring is incomplete, unauthorized, malformed, uncertain, or unavailable.
Every original queue entry and mandatory check remains in `requiredReviews`, including
items classified low risk. This adapter never skips or approves a review.

All three adapters use the frozen serialized-record contract from T014, default to `off`,
and reject live modes. Offline calls require a matching source proof, model pin, code revision,
and a local provider for private inputs. They copy provenance before awaits and expose only
validated scalar fields or copied arrays. Offline traces compose with the redacted writer;
all traces retain `actionTaken: none`.

`experiments/jev-btrain/rules-risk.mjs` reports G6-R and G6-T separately and keeps real,
synthetic, and unknown origins separate. Rule reports compare baseline and semantic warning
precision/recall, audit invented citations, and distinguish skipped candidates, attempted
failures, failures without calls, valid abstentions, and actionable coverage. All three families
retain optional per-attempt `latencyMs` and `cost`: latency reports observed-call count and
nearest-rank p50/p95; cost reports observed-call count and the sum of measured costs.
Missing costs report `total: null`, and measured zero is retained. Invalid negative or
nonfinite measurements and measurements without attempted calls are rejected. G6-V reports
severe findings in the top 30% of the queue (rounded up to whole entries), defect recall,
and total reviewer time relative to baseline. Every review candidate must have one
`gatewayAttempts` entry with its `reviewId`, boolean `eligible` and `attemptedCall`, and
gateway `outcome`. Review reports apply the same failure, abstention, skip and coverage
denominators as rule reports, separated by origin. Missing, duplicate, sparse, invented or
contradictory gateway entries are rejected, so ranking and time gains cannot conceal failed
calls. Incomplete scoring must retain the baseline order, matching the adapter fallback.
A measurement that drops a required queue
entry or invents a labeled finding is rejected. Reports always return `gateReady: false`.
All queue and finding ID lists must be dense arrays with unique supplied IDs; missing
array slots cannot stand in for retained reviews or labeled findings.

Each G6 dataset still needs 100 independently labeled real cases: at least 30 violations
in each diff/turn set and at least 10 severe findings in the review set. Frozen splits,
policy/model/revision pins, gateway quality floors, privacy, shadow evidence, and a human
promotion record remain separate prerequisites. Passing one family never promotes another.

```sh
rtk env -- node --test test/jev/rules-risk.test.mjs experiments/jev-btrain/rules-risk.test.mjs
```

## Original PR and handoff experiment

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

### Offline history search (T016 / WS10)

`searchHistory` in `src/brain_train/jev/history.mjs` accepts a frozen JSON query record
containing `query`, a captured `principal` (`id`, `roles`), explicit `filters`
(`repositories`, `kinds`), and a `records` catalog. Each record names its `id`,
`repository`, `kind` (event/trace/handoff/review), `sourceRef`, bounded `text`, and
source ACL `access` (`principalIds`, `roles`). Empty grants deny access. These are
captured local-reader policy inputs for offline evaluation; they are not proof of
live authorization, and the adapter is not connected to a command or status read.
A future live reader must resolve the authenticated principal and authoritative
source grants itself, and recheck access when returning results.

Source access is checked before structured and lexical selection. The lexical
baseline ranks by distinct query-token overlap with stable ties and retains at
most 16 authorized records. Only query and allowlisted record fields reach a local
provider; ACLs, principal metadata, extra fields, and filtered text are excluded.
Every shortlisted candidate has a gateway outcome. No matches yield a persistable
skipped trace. Reranking requires a confident decision for the entire shortlist;
off mode, private hosted providers, oversized serialized inputs, failed responses,
and abstentions retain the complete lexical order. Results keep captured source
references and no canonical events are written. Each call has a 100 ms timeout;
16 serial calls fit a bounded offline scoring budget, while measured end-to-end
latency remains a separate G10 requirement.

`evaluateHistoryPairs` in `experiments/jev-btrain/history-search.mjs` validates
paired query measurements with principal/role metadata, authorized and judged
relevant IDs, the same baseline and semantic shortlist, measured end-to-end
`elapsedMs`, and one gateway outcome per shortlisted ID. Inputs are defensively
copied; sparse arrays, duplicate IDs and disguised iterators cannot falsify call
accounting. It reports mean Recall@5, percentage point improvement, nearest-rank
p95 query latency, eligible/attempted/failed/skipped/abstained/actionable counts,
and actionable coverage, separately for real, synthetic and unknown origins.
Provider/shape failure rate uses attempted calls; failures without a call are
reported separately. Valid-prediction coverage includes abstentions over attempts,
while actionable coverage uses deterministic eligibility. Skips cannot dilute the
provider-failure denominator.
Invalid unauthorized or invented result catalogs are rejected as invalid evidence;
the reported zero unauthorized count follows this validation and is not an
independent live access audit. Empty relevance judgments are unsupported.

G10 still requires 50 independently judged real queries with source-access roles,
a frozen evaluation protocol, Recall@5 at least 10 percentage points above the
lexical/structured baseline, p95 at most 2 seconds, zero unauthorized results,
and the universal failure/coverage gates. This prototype always reports
`gateReady: false`; synthetic controls, supplied measurements, and policy tests
do not establish model quality or authorize live read-only search.

Shared gateway repair safeguards: require every captured source to have its own nonempty template group before assigning any evaluation split; reject successful serialized traces without a real attempted call and valid catalog probabilities; measure wall time after provider completion so synchronous work cannot evade the timeout. Timer cancellation alone cannot bound synchronous provider work. Tests must exercise these invariants through freeze/replay and persisted trace paths.

History paired accounting requires the shared trace failure class (`provider` or `response-shape`) on failed gateway rows and reports both categories separately. Publishing this stacked prototype uses an explicit preceding Jev branch as the PR base and `--no-dispatch` for handoff updates, so an automatically dispatched runner cannot choose a different publication target.
G6 paired gateway outcomes require `failureClass` (`provider` or `response-shape`) on failures and no class on nonfailures. Reports preserve both category counts, alongside attempts and failures without a call; imported measurements cannot silently collapse malformed answers into provider outages.
Frozen PR evaluation also validates event identity, author/surface, timestamps and their ordering, explicit event-head knowledge, nullable formal state and deterministic disposition. A hash only establishes content identity; it cannot supply missing provenance. Imported records must meet the same contract as prospective captures. Invalid transport response shapes use the response-shape failure category.

Snapshot schema 3 includes the source host in version identity. Schema 1/2 recaptures deduplicate only within the same host; a foreign-host observation must never suppress valid evidence. Composition tests capture, persist and replay actual snapshots rather than assigning artificial IDs.

## Default live Jev in btrain

Normal `btrain pr status` and `btrain pr poll` use the existing current-head review-text
interpreter in feedback-only `assist` when credentials are available. Jev may identify additional
feedback; it cannot approve, merge or waive a mandatory check. Provider and malformed-answer
failures preserve deterministic results. Set `BTRAIN_JEV_MODE=off` to disable calls, or `shadow`
to retain observational classification without applying feedback.

Credential precedence is `BTRAIN_JEV_API_KEY`, `JEV_API_KEY`, `TYPESAFE_API_KEY`, then a private
user JSON credential containing `apiKey`. Its location is `BTRAIN_JEV_CREDENTIALS_FILE` when
explicitly set, otherwise `jev.json` in `BRAIN_TRAIN_HOME` (default `~/.btrain`). On POSIX the
file must belong to the current user and have no group/other permissions (normally mode0600).
The loader rejects symlinks, nonregular files, oversized/malformed data, and insecure permissions;
it never searches a repository for secrets. No key value is printed or written to decision traces.

This default records the operator's activation instruction. Larger real-data evaluations and
live hooks for the newer offline families remain separate work; test counts are not model
accuracy claims. Runtime composition is covered by `test/jev-runtime.test.mjs`.
