# zvec-grep Evaluation

**Date:** 2026-09-04  
**Repository revision:** `06f931c`  
**zvec-grep version:** `0.2.1`  
**Decision:** Continue only as an optional semantic-search pilot. Do not add it as a required btrain dependency or replace native `rg`.

## Question

Would [zvec-grep](https://github.com/zvec-ai/zvec-grep) improve repository discovery for btrain agents enough to justify integration?

## Summary

The trial found a useful but narrow role. zvec-grep gave strong, compact results for two architecture and policy questions. Measured as precision at the configured `--limit 5`: one question returned five relevant passages, one returned four relevant results plus one unrelated (two of the four were duplicate mirrors), two returned relevant policy passages but missed the production implementation, and one followed the wrong retry concept entirely. The scoped `rg` baseline for the same questions averaged 19.4 candidate files in the trial run and 30.6 files in the reproducible baseline recorded below. Exact-symbol lookup was faster and more precise with `rg`.

The measured result supports an optional semantic scout for questions whose terminology or location is unknown. It does not support a core dependency, automatic use on every task, or replacement of exact search.

## Trial boundaries

- The trial used an isolated copy under `/tmp`, not the working repository.
- The copy excluded `.git`, `.btrain`, `.claude/collab`, `.claude/launch.json`, and `node_modules`.
- The index included hidden workflow files because `.claude/skills/` is part of btrain's operational context.
- The trial used `local/potion-code-16m-v2`. No repository content or query text went to a remote embedding provider.
- The trial did not run `zg install`, start the server, or modify global Codex, Claude, or MCP configuration.
- The comparison used five natural-language discovery questions and one exact-symbol control. This was a retrieval trial, not a full paired-agent benchmark.

## Setup and index cost

| Measurement | Result |
| --- | ---: |
| Node.js | `v25.9.0` |
| Initial visible-file scan | 194 files, 3,130 entities |
| Initial index work | 5.812 seconds |
| Initial wall time, including startup and model preparation | 9.12 seconds |
| Hidden-file rebuild | 295 files, 3,803 entities |
| Hidden-file rebuild work | 3.327 seconds |
| Hidden-file rebuild wall time | 6.56 seconds |
| Index size after the trial | 25 MiB |
| Failed indexed files | 0 |
| Truncated fragments | 0 |
| Incremental update after one changed file | 1.766 seconds of index work, 4.36 seconds wall time |

The local model cache occupied 33 MiB after the trial. The trial did not establish how much of that cache existed before the run, so the 33 MiB is an upper bound on what this trial added.

## Search comparison

The `rg` baseline in the table used short, hand-authored regular expressions and excluded `.zvec-grep`, `agentchattr/.venv`, and runtime log data. Its file counts therefore represent a reasonably scoped exact-search attempt, not an intentionally noisy baseline. The trial run did not preserve those regular expressions; the [Reproducible `rg` baseline](#reproducible-rg-baseline) section below records a second, fully reproducible set of commands and counts at the same revision.

| Question | zvec-grep result | Scoped `rg` candidates | Assessment |
| --- | --- | ---: | --- |
| How does btrain prevent simultaneous edits to overlapping files across lanes? | Ranked the exact lock guidance first and returned the main lock-failure spec in the top five. | 21 | Strong discovery result. One result was unrelated and two top results duplicated managed guidance. |
| What evidence shows that a formal-verification result is valid for the current implementation? | All five results were directly relevant sections of Spec 014. | 18 | Strong policy and architecture result. It did not surface the verification scripts. |
| How is a failed delegated wake-up detected and retried? | Ranked solo-review provider fallback first. It did not surface `agentchattr/btrain/notifications.py`. | 9 | Miss. The semantic similarity between two retry mechanisms led to the wrong subsystem. |
| How does btrain gather prior decisions without blocking when the provider is unavailable? | Ranked both mirrored copies of `context-scout` first and found relevant workflow guidance. It did not rank `src/brain_train/unblocked/context.mjs` in the top five. | 19 | Useful orientation, incomplete implementation discovery. Duplicate mirrors consumed result slots. |
| Where does btrain reject incomplete or placeholder review context? | Ranked both pre-handoff skill mirrors and the governing spec. It did not rank `src/brain_train/core.mjs` in the top five. | 30 | Useful policy discovery, weak answer to the implementation-location question. |

Across these five questions, zvec-grep produced two strong results, two orientation-only results, and one miss. It consistently favored explanatory prose over production code. That behavior helps when an agent must understand intent, but it can mislead an agent that asks where behavior is implemented.

The five direct-mode semantic queries, run with `--refresh off` as in the reproduction command, took 0.85 to 0.94 seconds each, with a mean of about 0.89 seconds. The scoped `rg` searches took 0.00 to 0.01 seconds each. The semantic latency is acceptable for a focused probe, but it is too expensive and unnecessary for known identifiers.

## Exact-search control

The exact query `collectNeedsReviewContextIssues` demonstrated the correct routing boundary:

- `rg` returned the definition and call site immediately.
- zvec-grep, with `--refresh off`, also returned the correct definition and call site, with useful structural context, but took 0.81 seconds.

Agents should continue to use native `rg` for identifiers, paths, quotations, configuration keys, regular expressions, and exhaustive searches.

## Freshness behavior

The trial added a file with a unique phrase after indexing.

- `--refresh off` reported `possibly_stale`, served the current index, and did not find the new file.
- `--refresh wait` indexed the change, ranked the new file first, and took 4.68 seconds.
- A later explicit incremental index updated one changed file successfully.

This behavior was correct and visible. An integration would still need an explicit freshness policy. Silent stale results would be unsafe for review or verification work.

## Usability and operational findings

1. `zg query` derives the workspace from the current directory. An appended root path becomes another query rather than a workspace argument. The first batch exposed this mistake through an unexpected second query group.
2. Mirrored content such as `AGENTS.md` and `CLAUDE.md`, or `.claude/skills` and `.agents/skills`, can consume several top-ranked slots.
3. Default file discovery successfully excluded the copied Python virtual environment and other common noise that required explicit `rg` exclusions.
4. A repository index and local model occupied about 58 MiB after this trial: 25 MiB for the index and 33 MiB for the observed model cache, of which the pre-existing share is unknown. Model caches can be shared across workspaces.
5. Direct mode avoided a daemon and global agent configuration. Repeated searches still paid about 0.9 seconds of process and model startup per query.

## Recommendation

Do not add zvec-grep to btrain's required installation, startup path, or exact-search workflow.

If btrain runs a larger evaluation, test this restricted policy:

1. Use native `rg` first when the agent knows an identifier or exact term.
2. Allow one focused zvec-grep query when terminology or location is unknown, or when the task requires cross-file policy and architecture synthesis.
3. Follow semantic results with exact source inspection before making a code claim.
4. Future work: index one copy of mirrored guidance, or deduplicate results by content hash. The current helper offers only repeatable `--glob` scoping and performs no deduplication.
5. Require strict freshness (`--refresh wait`) for review, security, migration, and formal-verification tasks. Permit eventual freshness (`--refresh off`) only for low-risk orientation.
6. Keep installation, indexing, and remote embedding explicit and optional.

The next evidence threshold should be a paired btrain harness benchmark with 10 to 20 held-out tasks. It should compare task correctness, files opened, input tokens, tool calls, wall time, false-subsystem selections, and index-preparation cost. Product integration is justified only if the semantic route improves end-to-end task outcomes, not merely retrieval compactness.

## Reproduction outline

The following commands summarize the successful direct-mode path. Run them from an isolated copy if the repository must remain unchanged.

```bash
npx --yes --package @zvec/zvec-grep@0.2.1 zg index \
  --embedding local/potion-code-16m-v2 \
  --mode direct \
  --hidden

npx --yes --package @zvec/zvec-grep@0.2.1 zg query \
  "How does btrain prevent simultaneous edits to overlapping files across lanes?" \
  --mode direct \
  --refresh off \
  --preview short \
  --limit 5
```

## Reproducible `rg` baseline

Added at review because the trial run did not record its `rg` regular expressions. These commands were run on 2026-09-08 against a detached checkout of `06f931c` with ripgrep 15.1.0. The patterns are independent of the trial's and are deliberately broad recall-oriented regexes, so the counts are higher than the table above for four of the five questions; question 3 diverges most between the two pattern sets (9 files in the trial, 30 here). These counts calibrate what a broad exact-search sweep costs at this revision; they neither support nor undercut the zvec-grep results above.

Shared flags for every command: `--hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!agentchattr/.venv/**' --glob '!agentchattr/data/**' --glob '!.zvec-grep/**'`, invoked as `rg -l -i <shared flags> -e '<pattern>' .`

| Question | Pattern | Files |
| --- | --- | ---: |
| 1. Simultaneous edits to overlapping files across lanes | `lock(ed)? files?\|file locks?\|overlapping (files\|locks)\|cross-lane` | 39 |
| 2. Formal-verification result valid for the current implementation | `exact.head\|pin(ned)? hash\|stale pin\|counterexample\|state.space exhaust` | 24 |
| 3. Failed delegated wake-up detected and retried | `wake.?up\|retry\|retries\|backoff` | 30 |
| 4. Prior decisions gathered without blocking on an unavailable provider | `unblocked.*(unavailable\|fail\|soft)\|soft gap\|provider (failure\|unavailable)\|context receipt` | 17 |
| 5. Incomplete or placeholder review context rejected | `placeholder\|fill this in\|none yet\|needs-review.*context\|reviewer context` | 43 |

Mean: 30.6 files. Exact control: `rg -n <shared flags> 'collectNeedsReviewContextIssues' .` returns exactly `src/brain_train/core.mjs:3336` (definition) and `src/brain_train/core.mjs:3491` (call site). Five timed runs of the question 3 command each took under 0.03 seconds on the review machine (an independent re-run on the same checkout measured 0.009 to 0.012 seconds; the figure is machine-dependent).

## Context receipt

**Context tier:** targeted

**Question researched:** Has btrain already established constraints that govern optional local semantic search and harness evaluation?

**Sources:**

- `specs/009-meta-harness-for-btrain.md`
- zvec-grep README, agent integration, retrieval pipeline, architecture, embedding, roadmap, and benchmark documentation
- Direct measurements from zvec-grep `0.2.1` against the isolated `06f931c` checkout

**Constraints discovered:** btrain keeps autonomous search optional, evaluates end-to-end outcomes before efficiency, prefers local-first artifacts, and keeps exact search available.

**Context gaps:** The repo-local Unblocked helper returned no organizational sources. This trial did not run paired agents, test the MCP server, measure memory use, or test another operating system or embedding model. All measurements used plain semantic `zg query`; the helper on `codex/zvec-grep-context` invokes `zg query --hybrid`, so hybrid-mode relevance and latency are untested. The trial's own `rg` regular expressions were not preserved; the reproducible baseline above was added at review.

**Durable writeback:** This evaluation document.
