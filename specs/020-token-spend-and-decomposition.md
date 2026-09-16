# 020 — Token Spend, cgraph Repair, and core.mjs Decomposition

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-09-14

## Decision

Cut btrain token spend at its measured source, and repair the code-graph
integration that the measurement exposed as broken.

The measurement changed the target, but not in the way an earlier draft of this
spec claimed. That draft argued that compression tools shrink fresh input, that
fresh input is 0.1 percent of cost, and therefore that payload size does not
matter. **That reasoning is wrong, and review caught it.**

A payload is billed as fresh input only on the turn it arrives. After that it
becomes cache-creation tokens, and then it is re-read as part of the prompt on
every later turn of the session. The 0.1 percent figure is what a payload costs
*once*; its real cost is the share of the ~70 percent cache-read bucket it
occupies for the rest of the session. Payload size therefore drives cache reads
directly, and shrinking what enters context is exactly the right lever.

The reproduction script groups provider billing buckets. It does **not**
attribute cached tokens back to the payloads that produced them, so it cannot
measure how much of the cache-read bucket any given source owns. Treat the
bucket shares as a map of where money goes, not as evidence about which content
is responsible.

What survives from the original analysis is the shape of the problem: cache reads
are ~70 percent of cost and scale as context size multiplied by turn count. Both
factors are levers. Smaller payloads reduce the first, and fewer or shorter
sessions reduce the second.

This spec covers six workstreams:

1. Repair cgraph on btrain. The call graph is empty, and `blast-radius`
   reports success on an empty graph.
2. Decompose `src/brain_train/core.mjs`.
3. Enforce a context budget per lane in btrain.
4. Adopt `ccusage` for token-spend observability.
5. Adopt `ast-grep` as a CLI structural-search tool.
6. Adopt Serena, scoped to the `core.mjs` decomposition.

Workstream 1 is a correctness fix, not a token optimization. Treat it as such.

The spec also records one rejection. Output-style compression skills, such as
Caveman, do not earn a place here. See "Rejected: output-style compression".

## Evidence

### Scope: these are Claude-session figures, and Claude is not the whole bill

The reproduction reads only Claude Code transcripts. `.btrain/project.toml`
activates `claude`, `codex`, `gemini`, and `app-developer`, so the figures below
are **not** btrain's total token spend.

An earlier revision tried to close this by measuring Codex and reported 11.2 M
tokens, about half a percent of Claude's volume, and concluded that the
Claude-only view "does not misstate where the money goes". **That was wrong and
the conclusion was backwards.** Codex transcripts carry two usage fields per
record: `last_token_usage` for that turn, and `total_token_usage` as a running
per-session counter. The earlier measurement summed the per-turn field across
sessions, which undercounts by roughly 78x.

Corrected, over the same 118 Codex sessions whose `cwd` is this repo:

| Runtime | Tokens | Scope |
|---|---:|---|
| Claude | 2,243,726,548 cache reads | this repo |
| Codex | **873,872,347** total | this repo |
| Gemini | 56,447,870 total | whole machine, not repo-scoped |

Codex is therefore about **39 percent** of Claude's volume on this repo, not half
a percent. Any conclusion about total spend has to account for it, and the
figures below do not.

Gemini was also described earlier as "not measurable locally at all". Also wrong:
`npx ccusage@latest gemini` returns a populated table. This spec's own script
finds nothing under `~/.gemini`, but `ccusage` reads the accounting from
somewhere that search did not cover. The Gemini figure above is machine-wide
because `ccusage gemini` does not scope by repository, so it is not comparable to
the other two rows and is shown only to establish that the data exists.

**Use `ccusage` for any cross-runtime question.** Verified on this machine: one
`npx ccusage@latest session` lists `Claude`, `Codex`, and `Gemini CLI` rows
together, and provider subcommands narrow it to one runtime. The script below is
a Claude-only instrument and should be read as one.

Measured from the local session transcripts Claude Code writes under
`~/.claude/projects/<encoded repo path>/`. Figures below are the
**2026-09-15 21:30Z** run: 51 sessions, 7,158 assistant turns.

| Bucket | Tokens | Share of cost |
|---|---:|---:|
| Cache reads | 2,243,726,548 | 72.0% |
| Output | 9,330,076 | 15.0% |
| Cache creation | 32,409,845 | 13.0% |
| Fresh input | 164,855 | 0.1% |

Cache hit ratio is 98.6 percent. Prompt caching already works. Any change that
risks the hit ratio costs more than it saves.

Cost share is a weighting, not a bill. The script applies fixed per-MTok rates
(input 3.00, cache write 3.75, cache read 0.30, output 15.00) to compare buckets
against each other. These sessions ran Fable 5 and 5.1, so the absolute dollar
figure is indicative. The **proportions** are what the spec relies on, and they
hold across any pricing where output costs several times input and cache reads
are discounted an order of magnitude.

Five sessions produce 83.8 percent of all cache reads:

| Session | Turns | Cache reads | Mean context per turn |
|---|---:|---:|---:|
| 628702f4 | 1,347 | 699,118,027 | 519,018 |
| b75d2356 | 1,078 | 402,242,645 | 373,137 |
| c3729997 | 805 | 345,420,632 | 429,093 |
| cf17490d | 519 | 242,836,248 | 467,892 |
| 37a4e562 | 551 | 191,271,769 | 347,135 |

The median session runs at 30,202 tokens of context per turn. The top three run
between 373,000 and 519,000. Session 628702f4 is the heaviest at a **519,018**
token mean over 1,347 turns — roughly half of a 1M window, sustained, not the
"near-full 1M" an earlier revision claimed. The mean is what the table measures;
individual turns at the top of that session may have run higher, and this spec
does not measure the peak.

Output splits as follows, by assistant content-block type:

| Output component | Share of characters |
|---|---:|
| `tool_use` inputs | 83.6% |
| Prose text | 11.5% |
| Thinking | 4.8% |
| Fenced code in text | 0.2% |

### These numbers drift, including from the act of measuring

The corpus includes the sessions that do the analysis, and the table above now
demonstrates it. Session `b75d2356` in the top five **is the session that wrote
this spec**: it did not exist in the first run, and it is now the second-largest
consumer of cache reads in the repository.

Three runs of the same script, hours apart: the top-five share read 89.9, then
82.9, then 83.8 percent, and cache reads read 69.8, then 70.7, then 72.0 percent.
Nothing was miscounted. Re-run the script rather than quoting these figures, and
record the date whenever you do.

The ratios that drive every decision in this spec are stable across both runs:
cache reads stay near 70 percent, fresh input stays at 0.1 percent, and the cache
hit ratio stays above 98 percent.

### Reproduction

This script derives the billing-bucket table, the cache hit ratio, the session
table, the median context per turn, and the output composition. It does **not**
derive the Codex or Gemini figures above (it reads only Claude transcripts), the
eight-hour session span, or the peak-context claims, which come from separate
commands named where they appear. Save and run it:

```python
import json, glob, collections, os, sys

# Per-MTok rates used only to weight buckets against each other.
RATE = {"input_tokens": 3.00, "cache_creation_input_tokens": 3.75,
        "cache_read_input_tokens": 0.30, "output_tokens": 15.00}
# Transcript location. Claude Code encodes the repo path into the directory
# name, so derive it from the repo rather than hardcoding one machine's home.
# Override with BTRAIN_TRANSCRIPTS when the transcripts live elsewhere.
REPO = os.environ.get("BTRAIN_REPO") or os.getcwd()
GLOB = os.environ.get("BTRAIN_TRANSCRIPTS") or os.path.join(
    os.path.expanduser("~/.claude/projects"),
    "-" + os.path.abspath(REPO).strip("/").replace("/", "-"),
    "*.jsonl",
)

tot, turns, sessions = collections.Counter(), 0, []
comp = collections.Counter()
for f in glob.glob(GLOB):
    cr = n = 0
    for line in open(f, errors="ignore"):
        try: d = json.loads(line)
        except ValueError: continue
        m = d.get("message") or {}
        u = m.get("usage")
        if u:
            turns += 1; n += 1
            for k in RATE: tot[k] += u.get(k, 0) or 0
            cr += u.get("cache_read_input_tokens", 0) or 0
        if m.get("role") == "assistant" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if not isinstance(b, dict): continue
                if b.get("type") == "text":
                    for i, part in enumerate((b.get("text") or "").split("```")):
                        comp["fenced code" if i % 2 else "prose"] += len(part)
                elif b.get("type") == "tool_use":
                    comp["tool_use inputs"] += len(json.dumps(b.get("input", {})))
                elif b.get("type") == "thinking":
                    comp["thinking"] += len(b.get("thinking") or "")
    if n: sessions.append((cr, n, os.path.basename(f)[:8]))

cost = {k: tot[k] / 1e6 * r for k, r in RATE.items()}
total_cost = sum(cost.values())
print(f"sessions {len(sessions)}   assistant turns {turns:,}\n")
print(f"{'bucket':32s}{'tokens':>16s}{'cost share':>12s}")
for k in sorted(RATE, key=lambda k: -cost[k]):
    print(f"  {k:30s}{tot[k]:>16,}{cost[k]/total_cost*100:>11.1f}%")
reads, creates = tot["cache_read_input_tokens"], tot["cache_creation_input_tokens"]
print(f"\ncache hit ratio  read/(read+creation) : {reads/(reads+creates)*100:.1f}%")

sessions.sort(reverse=True)
allcr = sum(s[0] for s in sessions)
print(f"\ntop 5 sessions by cache read ({sum(s[0] for s in sessions[:5])/allcr*100:.1f}% of all reads):")
for cr, n, name in sessions[:5]:
    print(f"  {name:10s} {n:>6,} turns  {cr:>15,} reads  {cr//n:>9,} mean ctx/turn")
med = sorted(s[0]//s[1] for s in sessions)[len(sessions)//2]
print(f"  median session mean ctx/turn: {med:,}")

ctot = sum(comp.values())
print(f"\noutput composition (chars):")
for k, v in comp.most_common():
    print(f"  {k:22s}{v:>12,}{v/ctot*100:>8.1f}%")
```

### cgraph measurements

Measured on btrain with kkg 0.4.2 on 2026-09-14:

| Operation | Time | Result |
|---|---:|---|
| `kkg index .` (1,092 files) | 47.0 s | 0 CALLS edges |
| `kkg index . --code-only` (226 files) | 47.3 s | 0 CALLS edges |
| `scip-typescript` with a `tsconfig.json` | 0.95 s | 4.7 MB, 10,770 references |

**These timings do not generalize, and an earlier revision drew the wrong
conclusion from them.** It read "indexing is not slow" off the 47-second fork
run. The fork was fast because it did no call resolution at all — that is the
same defect as the 0 CALLS edges beside it, not an independent result. The real
call-resolving index on upstream takes **1,612 seconds (26.9 minutes)**,
measured below, which is over 30x the figure here and is why `TIMEOUTS.index`
at 30 seconds is wrong by two orders of magnitude.

Read this table as evidence that the fork produces no call graph. Do not size
indexing from it.

## Context receipt

- **Context tier**: targeted.
- **Question**: Where does btrain token spend go, and which tools reduce it
  without risking the prompt cache?
- **Sources**: 51 local session transcripts, the installed kkg 0.4.2 package at
  `~/.local/share/uv/tools/codegraphcontext/`, `~/.codegraphcontext/.env`,
  `src/brain_train/cgraph_adapter.mjs`, the Serena repository at commit
  `18fa47b`, and
  [research/ponytail-headroom-evaluation.md](../research/ponytail-headroom-evaluation.md).
- **Prior decisions honored**: the cgraph-research note
  `006-token-efficiency-integration-plan.md` assigns code retrieval to cgraph
  and workflow memory to btrain. This spec keeps that boundary.
- **Constraints**: btrain remains the state owner. btrain keeps zero runtime
  dependencies. No tool enters the model request path.
- **Gap**: The dogfooding results in `cgraph-research` measured Python
  codebases only. No JavaScript measurement existed before this spec.
- **Durable writeback**: this spec.

## Technical context

- Runtime: Node.js ESM.
- Main implementation: `src/brain_train/core.mjs` and `src/brain_train/cli.mjs`.
- cgraph integration: `src/brain_train/cgraph_adapter.mjs`, added under Spec 005.
- cgraph binary: `kkg` 0.4.2, installed as a uv tool. The adapter resolves
  `cgc`, `cgraph`, `kkg`, then `codegraphcontext`.
- cgraph database: KùzuDB at `/Volumes/zombie/cgraph/db`, 4.8 GB.
- Existing token controls: `rtk` shapes shell output. Claude Code tool search
  defers MCP tool definitions.

## Design boundaries

1. Do not place any tool in the model request path.
2. Do not accept a change that lowers the cache hit ratio, currently above 98 percent.
3. Do not add a runtime dependency to the btrain package.
4. Keep the Spec 005 ownership split. cgraph owns code retrieval. btrain owns
   lane state and workflow memory.
5. Keep the cgraph adapter fail-open, but stop reporting an empty graph as a
   clean result.
6. Preserve every public export of `core.mjs` through the decomposition.
7. Land the decomposition when no lane holds a lock on `src/brain_train/`.

## Workstreams

### Workstream 1: Repair cgraph on btrain

> **Code status: pending on this branch.** This section describes the adapter
> and `core.mjs` changes in the past tense because they are written and
> reviewed, but they land on **PR #63**, not here. In the tree you are reading,
> `cgraph_adapter.mjs` still publishes a `blast_radius` block for any `ok`
> response carrying a summary, including an all-zero one, and `core.mjs` does
> the same on its live path. Do not enable `[cgraph]` in `.btrain/project.toml`
> until #63 merges: the false-clean-result bug described below is still present
> and enabling cgraph is exactly what makes it live.


cgraph produces zero CALLS edges on btrain. `blast-radius`, `impact`,
`execution-flow`, and `drift-check` return empty results. Three separate causes
block the SCIP path. All three must be fixed.

cgraph produces zero CALLS edges on btrain. Implementation on 2026-09-14 found
**four** blocking causes, not three. Fixing the first three did not restore the
call graph, so a fifth cause remains inside the kkg 0.4.2 SCIP pipeline.

**Cause 1 — the extension map omits `.mjs`.**
`scip_indexer.py` defines `EXTENSION_TO_SCIP` with `.ts`, `.tsx`, `.js`, and
`.jsx`, and no `.mjs` or `.cjs`. **Upstream 0.6.13 already fixes this** at
`scip_indexer.py:61-62`.

**Cause 2 — the language list omits JavaScript.**
`SCIP_LANGUAGES` did not contain `javascript`. Fixed in
`~/.codegraphcontext/.env`. This change is harmless and stays.

**Cause 3 — `scip-typescript` needs a `tsconfig.json`.**
btrain had none. `--infer-tsconfig` does not cover `.mjs`, and a
`jsconfig.json` is ignored. Fixed by adding `tsconfig.json` to the repo.
Verified: `scip-typescript` then indexes btrain in 0.95 seconds and emits a
4.7 MB index with 10,770 symbol references.

**Cause 4 — language detection counts vendored files.**
`detect_project_lang` counts extensions with a bare `path.rglob`, with no
ignore handling. btrain vendors `agentchattr/.venv`, which holds 1,361 Python
files against 176 JavaScript files, so detection returned `python`.
`scip-python` is not installed, so kkg fell back to Tree-sitter and emitted no
call edges. **Upstream 0.6.13 already fixes this** by filtering through
`file_path_has_ignore_dir_segment`.

**Cause 5 — the SCIP parser duplicates the extension map, and JavaScript
symbols do not resolve.**
Traced on 2026-09-14 by driving the pipeline directly. Each stage in isolation:

| Stage | Result |
|---|---|
| `ScipIndexer.run(btrain, "javascript")` | works — 4.7 MB `index.scip` |
| `ScipIndexParser.parse` | 47 files, 864 functions, 12,182 call edges |
| Language tag on those files | `unknown` for all 47 |
| Callers usable by the writer | **670 of 12,182 (5.5%)** |

Two defects, both in the parser rather than in SCIP:

- `ScipIndexParser._lang_from_path` carries its **own** hardcoded extension map,
  separate from `EXTENSION_TO_SCIP`, and it also omits `.mjs`. Every btrain file
  is tagged `unknown`. **Upstream 0.6.13 fixes this** by reading the shared
  `EXTENSION_TO_SCIP` instead of duplicating it.
- 68.3 percent of the parsed edges carry `caller_symbol` of the form `local N`,
  which matches no function node. **Upstream 0.6.13 skips `local ` symbols
  outright.** Of the 3,864 named callers that remain, `name_from_symbol` resolves
  only 670 to a real function node, because it splits scip-python style symbols
  and leaves scip-typescript parameter suffixes such as
  `resolveBinary().(config)` intact.

So upstream 0.6.13 fixes causes 1, 4, and the first half of 5. `name_from_symbol`
is **unchanged upstream**, so the symbol-resolution quality for TypeScript and
JavaScript is unverified even after a merge.

**Conclusion: the merge is built and verified.**

Run 2026-09-14 against upstream 0.6.13, installed in an isolated virtualenv with
an isolated `HOME` and its own KuzuDB, so the working 0.4.2 install and the
4.8 GB production graph were untouched. Same btrain checkout, same
`scip-typescript`, same `tsconfig.json`.

| Metric | kkg 0.4.2 (fork) | upstream 0.6.13 |
|---|---:|---:|
| **CALLS edges** | **0** | **22,979** (indexer summary — see below) |
| Function nodes | — | 3,988 (indexer summary) |
| Class nodes | — | 249 |
| Files scanned | 226 | 294 (`.mjs` 51, `.py` 52, `.js` 8) |
| Index wall time | 47 s | **1,612 s (26.9 min)** |

The call graph is real on upstream. The 47-second fork index was fast because it
did no call resolution at all.

**The two edge counts in this spec are not a contradiction, and the larger one is
not the one to quote.** The row above reports what the indexer *printed*. The
merged-build section further down reports **11,531**, which came from querying
the persisted database directly:

```
MATCH ()-[r:CALLS]->() RETURN count(r)   -- 11,531
```

Broken down by endpoint type, that is 6,931 `Function`→`Function`, 4,400
`File`→`Function`, 198 `Function`→`Class`, and 2 `File`→`Class`. The parts sum to
11,531.

The indexer's summary counter over-reports persisted edges by roughly 2x: on the
run that produced the surviving database it printed 22,985 CALLS edges and 3,988
function nodes, while the database holds 11,531 and 4,040. The 22,979 above is a
summary figure from a sibling run and carries the same inflation. **Treat any
CALLS figure that came from the summary table as an upper bound**, and query the
database when the number matters. That discrepancy is itself a defect worth a
line in the merge spec; it is not diagnosed here.

Two consequences:

1. **The merge is justified.** It is 847 upstream commits against 78 fork-only
   commits. Recount the conflict set at any time with:

   ```
   git merge-tree --write-tree --name-only 35645cd8 2ef71b05
   ```

   That reports **84 conflicted paths**: 57 under `docs/` and `website/`, 7 root
   and infrastructure files, 6 in tests, and **14 in real source**, including
   `tools/graph_builder.py` and `tools/indexing/persistence/writer.py`. The four
   counts sum to 84. `codegraphcontext_ext/` conflicts on **zero** paths, which
   is why it is the right seam. That is a real merge, not a rebase, and it needs
   its own spec.

   An earlier revision of this spec reported 45 conflicts with a breakdown that
   summed to 43, and a second passage reported the same 45 with an incompatible
   breakdown. Both described a trial merge run against the *other* fork
   (`codeslp/keplerkg`) before the fork divergence was understood. The figures
   above replace them and come from the commit pair that was actually merged.
2. **`TIMEOUTS.index` is wrong.** `cgraph_adapter.mjs:30` budgets 30 seconds for
   an index. The measured index is 27 minutes. Any btrain path that triggers
   indexing through the adapter will time out. Raise the budget, or keep indexing
   out of the adapter entirely and run it from a scheduled job.

Note also that upstream's CLI entry points are `cgc` and `codegraphcontext`.
`kkg` is a fork-only alias, which the adapter already handles.

The local `scip_indexer.py` patch was reverted, so the machine carries no
unmanaged drift, and the fork checkout was restored to its prior branch with the
trial merge aborted.

Tasks:

1. **Pending on this branch.** `tsconfig.json` is written and reviewed, but it
   lands with the WS1 code on PR #63, not with this documentation change. A
   tree search at this commit finds no `tsconfig.json`, so treat the
   prerequisite as unmet until #63 merges.
2. **Superseded.** A two-line cherry-pick is not enough. Causes 1 and 4 both
   need upstream code, and cause 5 is undiagnosed. Do the fork merge.
3. **Done.** `javascript` added to `SCIP_LANGUAGES`.
4. Reinstall kkg with the embeddings extra. `kkg search` currently raises
   `ModuleNotFoundError: No module named 'sentence_transformers'` and exits.
5. Clear the cgraph registry. **Re-measured 2026-09-15**, after the cleanup
   commands were run: `~/.codegraphcontext/config.yaml` holds **26** contexts,
   and **all 26 are throwaway test fixtures** (`journey_cgc_test_unit_*` and one
   `journey_tmp.*`) pointing into per-run temporary directories. Not one of
   those repository paths still exists on disk, so every entry is an orphan. The
   four stray btrain file-level entries an earlier revision reported are gone.
   What remains is to delete the 26 orphans and register the btrain root as one
   project. Recount with:

   ```
   ls ~/.codegraphcontext/contexts | wc -l
   ```
6. **Withdrawn. Adding `.cgcignore` to `.gitignore` is the wrong change**, and
   it blocks task 7. Established after two corrections, both from review:

   - The repository tracks two `.cgcignore` files, `src/brain_train/.cgcignore`
     and `test/.cgcignore`. Both are KeplerKG boilerplate and neither carries
     `agentchattr/.venv/`.
   - A **root** `.cgcignore` exists on the machine this spec was written on and
     does carry that pattern, but it is untracked. `git ls-tree -r HEAD` does
     not list it, so a fresh clone gets nothing. An earlier revision of this
     task said the file "already exists at the repository root", which was true
     only of one working tree.

   Ignoring `.cgcignore` would make the root file permanently uncommittable, so
   the pattern task 7 needs could never reach another checkout. The root file is
   repository configuration and belongs in version control. PR #63 drops the
   `.gitignore` entry and commits the root file instead.
7. Add `agentchattr/.venv/` to the root `.cgcignore` so language detection stops
   counting vendored Python, and commit it, per task 6. This does not help on
   0.4.2, which ignores `.cgcignore` during detection, but it is correct for the
   merged version.

**Correctness fix.** Two facts, both established after the first draft of this
spec and both correcting it.

*The bug is latent, not live.* `.btrain/project.toml` has **no `[cgraph]`
section**, so `isCgraphEnabled()` returns false and btrain never calls cgraph
today. An earlier draft said btrain "reads this as a clean pre-lock collision
check", which overstated it. Nothing is currently reading anything. The fix
still has to land **before** anyone enables `[cgraph]`, because enabling it is
exactly what this workstream is for.

*The first fix was unsound.* `kkg blast-radius` returns `ok: true` with every
array empty, and the first version inferred "the graph has never indexed these
files" from `nodes_in_scope == 0`. Review rejected that, and reading
`codegraphcontext_ext/commands/blast_radius.py` confirms why: it matches
code-entity nodes (`Function`, `Class`, `Variable`, ...) with
`WHERE n.path IN [...]`, never queries `File` nodes, and never expands a
directory to its descendants. So zero nodes has at least three causes:

- the graph has never indexed those files;
- the lock names a directory, and `src/` equals no entity path — which is
  btrain's normal lock shape, so the first fix would have fired on every lane
  against a perfect graph;
- the files hold only imports, comments, or constructs cgraph does not model.

The payload cannot separate these, so btrain does not try. It asserts only what
is true: cgraph returned nothing to reason about, so the collision check is
**inconclusive**, not clean. `ok` and `unavailable` keep their existing meanings
("the call worked", "the binary was missing"); an inconclusive answer is a third
state with its own flag, and cgraph's own explanation reaches the operator.

`buildEventMetadata` also stopped publishing the summary's zeros as a
`blast_radius` block, since that block is what rendered "0 in scope, 0 overlaps"
and made an unchecked lock look checked.

Acceptance: a lane that locks a file with known callers reports those callers. A
run that matches no entities reports degraded with cgraph's reason, and never a
clean collision check. A directory lock is treated as inconclusive rather than
clean.

### Workstream 2: Decompose `core.mjs`

`src/brain_train/core.mjs` holds 10,754 lines and 368,903 characters, which is
about 92,000 tokens. It is 56 percent of the source tree.

It defines 352 top-level functions and exports **68 names** through two `export`
statements. An earlier revision said "behind 2 exports", which counted the
statements and read as though the file were a deep module with a narrow
interface. It is the opposite: 68 exported names is a wide interface, and that
is precisely what makes the split hard. Every extraction has to keep those 68
names resolvable from `core.mjs`, so each stage re-exports what it moves.

An agent that reads this file spends about half of a 200,000-token window. The
file then stays in context, and btrain pays for it again as cache reads on every
later turn.

An earlier draft called it "the largest single contributor to the measured cost".
Review rejected that, correctly: the billing-bucket reproduction records no file
information at all, and the Evidence section says outright that it cannot
attribute cached tokens to sources. So a second measurement was run, over the
`tool_use` arguments in the same transcripts, counting which files agents
actually opened:

| File | Reads | Bytes | Partial reads | Estimated share of read-bytes |
|---|---:|---:|---:|---:|
| `core.mjs` | 50 | 368,903 | 31 | **51.3%** |
| `lane-lock-harness.test.mjs` | 69 | 40,664 | 2 | 7.8% |
| `015-lane-transition-contract.md` | 32 | 77,356 | 6 | 6.9% |
| `lane-lock-model.mjs` | 63 | 31,654 | 1 | 5.5% |
| `cli.mjs` | 19 | 97,855 | 7 | 5.2% |

By **read count** `core.mjs` is only fourth, at 8.3 percent of the 601
file-targeted tool calls. Weighted by file size it is 51.3 percent of read-bytes,
more than the next seven files combined. Both facts matter: it is not the file
agents open most often, it is the file that costs most when they do.

Reproduce that table:

```python
import json, glob, collections, os
REPO = os.environ.get("BTRAIN_REPO") or os.getcwd()
GLOB = os.environ.get("BTRAIN_TRANSCRIPTS") or os.path.join(
    os.path.expanduser("~/.claude/projects"),
    "-" + os.path.abspath(REPO).strip("/").replace("/", "-"), "*.jsonl")

reads, partial = collections.Counter(), collections.Counter()
for f in glob.glob(GLOB):
    for line in open(f, errors="ignore"):
        try: d = json.loads(line)
        except ValueError: continue
        m = d.get("message") or {}
        if m.get("role") != "assistant" or not isinstance(m.get("content"), list): continue
        for b in m["content"]:
            if not isinstance(b, dict) or b.get("type") != "tool_use": continue
            inp = b.get("input") or {}
            p = inp.get("file_path") or inp.get("path") or ""
            if isinstance(p, str) and p.startswith("/"):
                reads[p] += 1
                if inp.get("limit") or inp.get("offset"): partial[p] += 1

rows = []
for p, n in reads.items():
    try: size = os.path.getsize(p)
    except OSError: continue
    rows.append((n * size, n, size, partial[p], os.path.basename(p)))
rows.sort(reverse=True)
tot = sum(r[0] for r in rows)
for w, n, sz, pt, name in rows[:8]:
    print(f"{name:40s} reads={n:<5} bytes={sz:<9,} partial={pt:<4} share={w/tot*100:.1f}%")
print(f"file-targeted tool calls: {sum(reads.values()):,}")
```

Treat 51.3 percent as an **upper bound**. The estimate multiplies read count by
full file size, and 31 of the 50 `core.mjs` reads passed `offset` or `limit`, so
they read part of the file rather than all of it. The byte figures also depend on
the checked-out revision: run the script on `main` to get the numbers above. The claim this supports is the
weaker one: `core.mjs` dominates read-bytes among files agents open. It is not a
measurement of its share of total spend.

Tasks:

1. Group the 352 functions by responsibility. Use the existing module names as
   the seed: lane state, locks, handoff rendering, transitions, events,
   reviewer dispatch.
2. Extract one group per change. Keep every public export stable.
3. Run `npm test` after each extraction.
4. Record the Spec 014 formal impact for each extraction. A pure move has no
   semantic impact. Any guard change has semantic impact.
5. Split `src/brain_train/cli.mjs` as well. At 2,669 lines it is already over
   the acceptance ceiling, so tasks 1-4 could all complete and still leave the
   criterion unmet. It is a quarter the size of `core.mjs` and mostly argument
   parsing and output formatting, so treat it as the smaller, later half of the
   same workstream rather than a separate one. Take it after `core.mjs` is
   under the ceiling, since several of its command handlers will move with the
   functions they call.

Acceptance: no file in `src/brain_train/` exceeds 2,000 lines — which today
means both `core.mjs` (10,754 in this tree, 10,854 once PR #63 merges) and
`cli.mjs` (2,669), not `core.mjs` alone.
`npm test` passes. The public export surface does not change.

### Workstream 3: Enforce a context budget

`CLAUDE.md` tells agents to prompt for a context clear at natural stopping
points. The measurement shows that this does not happen. Three sessions held
context above 340,000 tokens for hundreds of turns each.

btrain enforces review gates mechanically. It can enforce a context ceiling the
same way.

Tasks:

1. Record the context size on each `btrain handoff` call.
2. Warn when a lane session passes a soft ceiling. Default: 200,000 tokens.
3. Refuse to advance a lane to `needs-review` above a hard ceiling without an
   explicit override. Default: 400,000 tokens.
4. Make both ceilings configurable in `.btrain/project.toml`.
5. Write the checkpoint before the warning, so a clear loses no state.

Acceptance: a session above the soft ceiling receives a warning that names the
current size. A session above the hard ceiling cannot reach `needs-review`
without an override, and the override writes a workflow event.

### Workstream 4: Adopt ccusage

btrain has no token-spend visibility. This spec needed a custom script to
produce its own evidence table.

Tasks:

1. **Done.** `npx ccusage@latest` documented in `docs/token-tooling.md` and
   linked from the README. No dependency added. It reports claude, codex and
   gemini separately, covering every runtime in `[agents].active`.
2. Record a monthly spend snapshot next to the lane metrics. Not done.

Acceptance: a developer can read current token spend without writing a script.

### Workstream 5: Adopt ast-grep

`ast-grep` is a Rust CLI under the MIT license. It returns structural matches
instead of line matches, so it returns fewer and more precise results than
`grep`. It is a CLI, so it adds no tool definitions to context. This matches the
`rtk` pattern already in use.

Tasks:

1. **Done.** `ast-grep` 0.45.3 installed, confirmed parsing `.mjs`.
2. **Revised.** An automatic `rtk`-style rewrite is the wrong shape. Measured on
   `core.mjs`, counting ast-grep matches with `--json` rather than piped lines:
   for a rare exact identifier ast-grep returns 13 call sites against grep's 16
   raw occurrence lines, so a blanket rewrite would buy little and add a
   dependency to every search. It wins when a text search over-matches
   (`status`: 326 grep lines against 3 assignments) or when the query is
   structural (`catch` blocks returning null: 2 matches against 42 `catch`
   lines to read by hand). The two tools count different things;
   `docs/token-tooling.md` labels the columns accordingly.
   Documented as a judgement call rather than wired in as a rewrite.
3. **Done.** Pattern reference in `docs/token-tooling.md`.

Acceptance: a structural query over `src/brain_train/` returns matched nodes and
no unrelated lines.

### Workstream 6: Adopt Serena, scoped

Serena provides symbol-level retrieval and editing over the Language Server
Protocol. It keeps an LSP symbol cache, not a graph database, so it has no graph
to rebuild and no graph to drift. It handles `.mjs` through the TypeScript
language server.

Health at commit `18fa47b`: 78 language servers, over 100 contributors, 30
commits in the last 30 days, 797 closed issues, and monthly releases.

Serena does not replace cgraph. cgraph owns `blast-radius`, `drift-check`,
`advise`, and `review-packet`, which are lane-collision primitives built for
btrain. Serena has no equivalent. Serena is stronger at cross-file refactoring,
which is what Workstream 2 needs.

Costs to control:

- Serena exposes 43 MCP tools, which is about 8,000 to 9,000 tokens of tool
  definitions. Claude Code tool search defers these, and `excluded_tools` in
  `project.yml` trims them further.
- The Serena application is licensed GPL-3.0-or-later. SolidLSP is MIT. btrain
  runs Serena as a separate process over MCP, so the GPL terms do not reach
  btrain source. btrain stays MIT.
- Serena issue 2029 reports an unbounded project registry. Audit it on the same
  schedule as the cgraph registry in Workstream 1.

Tasks:

1. Install Serena for the btrain project only.
2. Set `excluded_tools` to leave `find_symbol`, `find_referencing_symbols`, and
   `get_symbols_overview`.
3. Use it for Workstream 2, then review whether to keep it.

Acceptance: `find_referencing_symbols` returns the callers of a `core.mjs`
function without reading the whole file. The tool count stays at or below six.

## Fork drift

The installed tool is 0.4.2. Upstream `CodeGraphContext/CodeGraphContext` is at
0.6.13 and holds 847 commits the fork does not. Upstream carries none of the
btrain commands: a search of its tree for `blast-radius`, `drift-check`,
`advise`, and `review-packet` returns zero hits for each, so a plain
`uv tool upgrade` would delete the lane-collision surface `cgraph_adapter.mjs`
calls. The update has to be a merge.

One prerequisite blocks the tooling. `kkg sync-check` returns
`{"skipped": true, "reason": "no_source_checkout"}` because
`[cgraph].source_checkout` is unset in `.btrain/project.toml`. An `upstream`
remote has since been added to both fork clones, which sync-check also needs.

Which fork to merge into is settled in the next section.

### Merge outcome

Built and verified on 2026-09-15, on `merge/upstream-0.6.13` in
`codeslp/cgraph`, in a git worktree so the working checkout was untouched.

The first attempt kept the fork's CLI against upstream internals. They drifted
until indexing reported success and wrote nothing. The second took upstream
wholesale for every file under `src/codegraphcontext/` and re-attached the fork
through a single `register_extensions(app)` hook. `codegraphcontext_ext` merges
with zero conflicts, so it is the right seam.

Measured on btrain, against the fork's 0 CALLS edges:

| Metric | Fork 0.4.2 | Merged 0.6.13 |
|---|---:|---:|
| CALLS edges | 0 | 11,531 |
| Function nodes | 0 | 4,040 |
| `.mjs` functions | 0 | 919 |
| `core.mjs` functions | 0 | 353 |

Every figure in this table was read from the persisted KuzuDB database, not from
the indexer's summary output. The indexer printed 22,985 edges for this same run.
See the reconciliation note under the 2026-09-14 table for why the database
figure is the one to trust.

An independent `grep` counts 352 top-level functions in `core.mjs`, which is the
strongest evidence that the graph models the JavaScript correctly.

Three gaps surfaced and all three are closed:

- **Storage routing.** `activate_project()` ran on every command and, with no
  `--project`, inferred a slug from the working directory and rewrote
  `KUZUDB_PATH`. Upstream's `index` does not route that way, so the writer and
  every reader used different databases. It now redirects only when a project is
  actually requested.
- **Hardcoded root.** `codegraphcontext_ext/project.py` hardcoded
  `/Volumes/zombie/cgraph/db`, an absolute path to an external volume. It now
  derives from the config directory, with `CGRAPH_DB_ROOT` still overriding.
- **`--code-only`.** Ported onto upstream's discovery pipeline and restored as a
  CLI flag, rather than left inert.

`kkg blast-radius --files src/brain_train/cgraph_adapter.mjs` now returns 50
nodes in scope, 31 transitive callers, and 11 transitive callees.

A **directory** lock still returns 0 nodes, because blast-radius matches entity
paths exactly and does not expand directories. That is the case review raised on
WS1, now confirmed against a real graph, and it is why btrain reads that answer
as inconclusive rather than clean.

## Consolidating the cgraph forks

Investigating the merge turned up the real obstacle: **cgraph exists as two
divergent forks**, and the merge spike was run against the wrong one.

| | `codeslp/cgraph` | `codeslp/keplerkg` |
|---|---|---|
| Checkout | `/Volumes/zombie/cgraph/repo` | `/Volumes/zombie/keplerkg` |
| Last commit | 2026-04-26 | 2026-04-24 |
| Commits | 1,050 | 1,031 |
| btrain advisory contract (Spec 005) | **yes** (`612f1a8`) | no |
| FalkorDB backend | yes | yes |
| `codegraphcontext_ext` package | yes | yes |

They share history at `beb5f5c` and have since diverged **both ways**: 61
commits unique to cgraph, 47 unique to keplerkg. Most of the 47 are the same
changes as cgraph's, landed under different hashes — `--code-only`, the
networkx dependency, the FalkorDB migration, the showcase gallery all appear on
both sides.

**`codeslp/cgraph` is the survivor.** It is the superset: it carries the
cgraph-to-btrain advisory contract that keplerkg lacks, it is newer, and the
installed tool was built from a path named `cgraph`, not `keplerkg`.

keplerkg holds three small fixes that cgraph lacks, all on its
`claude/standards-and-protobuf-fixes` branch:

- `ed8503b` declare the protobuf runtime dependency;
- `7439eda` exclude `.test.` and `.spec.` paths from `circular_imports`;
- `54e0148` restrict `missing_docstring_public` to Python files.

### Naming

One project currently answers to four names: the repo is `cgraph`, the package
is `codegraphcontext`, the product is KeplerKG, and the binary is `kkg` with
`cgc` and `codegraphcontext` as aliases. btrain's adapter probes all four in
order. Upstream ships only `cgc` and `codegraphcontext`, so `kkg` is a
fork-only alias.

### Plan

1. Cherry-pick keplerkg's three fixes into `codeslp/cgraph`.
2. **Done.** Merge upstream 0.6.13 into `codeslp/cgraph`. The real merge
   (`35645cd8` against `2ef71b05`, landed as `76a4e443`) conflicts on 84 paths:
   63 are upstream's own `docs/`, `website/`, and `tests/` and resolve to
   upstream wholesale, 7 are root and infrastructure files, and 14 are real
   source. The btrain command surface lives entirely in `codegraphcontext_ext/`,
   which upstream does not have, so it merges with **zero** conflicts. Three
   files carry `codegraphcontext_ext` wiring and need hand-resolution:
   `cli/main.py`, `cli/cli_helpers.py`, and `server.py`. See the conflict
   breakdown above for the command that reproduces these counts.
3. Pick one CLI name and keep the others as deprecated aliases, so the adapter's
   four-name probe can shrink.
4. Archive `codeslp/keplerkg` once its three fixes have landed.
5. Only then enable `[cgraph]` in btrain, with the inconclusive fix already in.

This is its own spec. It is not part of spec 020's budget.

## Rejected: output-style compression

Caveman and similar skills compress agent output by constraining style. This
spec rejects them for btrain, on measured grounds rather than taste.

Output is 15 percent of cost, and the Evidence section breaks it down by
content-block type: `tool_use` inputs are 83.6 percent of output characters and
prose is 11.5 percent. (These are the 2026-09-15 21:30Z figures. An earlier
revision quoted 83.7 and 11.2 from a prior run and did not update them here.)

Prose is therefore roughly 2 percent of total spend. A style skill that cut prose
by 65 percent would save around 1 percent of total spend, and it would not touch
`tool_use` inputs, where most output tokens go.

The cgraph-research note `006-token-efficiency-integration-plan.md` already
rejected Caveman as a repo default, because style compression removes nuance in
review, debug, and security work. That reasoning stands, and the measurement now
supports it: the token argument for Caveman is worth about one percent.

Keep `ste-writing`, which btrain already adopted on 2026-07-29 and which runs
advisory-only. Keep it for clarity, not for tokens. Its local trial measured
form, not spend, and this spec makes no token claim for it.

One clarification, raised in review. The `tool_use` share above is measured on
**assistant-produced JSON arguments**, which are output tokens: file paths,
patterns, edit bodies. It is not tool *results*. `ast-grep` and Serena mostly
shrink tool results and retrieved context, which arrive as input and then persist
in the cache-read bucket. Workstreams 5 and 6 are therefore **context-input**
reductions, and the output table does not justify them; the cache-read
arithmetic does.

The genuine output lever is the size of the arguments agents write, chiefly edit
payloads. This spec does not measure which argument kinds dominate, so it makes
no recommendation there. Note one counter-effect: the Serena evaluation reports that
symbolic editing sends **more** payload than a plain text edit for small,
single-file changes, because the caller must supply the full symbol body. Scope
Serena to navigation and cross-file refactoring, and keep plain edits for small
changes.

## Dependency order

0. The fork merge now blocks the cgraph half of Workstream 1. The adapter
   correctness fix does not wait on it, but it lives on PR #63 and is NOT in
   this tree. Until #63 merges, `cgraph_adapter.mjs` still publishes a
   `blast_radius` for any `ok` response carrying a summary, all-zero included,
   and `core.mjs` does the same on its live path. Do not enable `[cgraph]`
   before #63 merges: the false-clean collision result this spec describes is
   still live in the code as it stands here.
1. Workstream 4 first. Measure before and after.
2. Workstream 1 next. It is a correctness fix and unblocks graph queries.
3. Workstream 6 next. It supports Workstream 2.
4. Workstream 2 next. It needs an unlocked `src/brain_train/`.
5. Workstreams 3 and 5 run in parallel with the above.

## Rollback points

- Workstream 1: remove `tsconfig.json`, and revert the `.env` change. cgraph
  returns to the current empty-graph behavior. The adapter stays fail-open.
- Workstream 2: each extraction is one reviewable change. Revert one.
- Workstream 3: set both ceilings to zero to disable.
- Workstream 4: remove the documentation line.
- Workstream 5: uninstall `ast-grep`. No btrain code depends on it.
- Workstream 6: remove the MCP server entry.

## Decision gate

Workstream 1 carries a correctness finding that does not depend on the token
work. Confirm two points before implementation starts:

1. Confirm the scope of the WS1 finding as this spec now states it: the adapter
   **would** report an empty graph as a clean pre-lock collision check, but it
   does not do so today, because `.btrain/project.toml` has no `[cgraph]`
   section and `isCgraphEnabled()` returns false. The bug is latent. It becomes
   live the moment anyone enables `[cgraph]`, which is what this workstream
   exists to make safe. (An earlier draft of this gate asked the reviewer to
   confirm the live reading; the spec retracted that above and this item is
   corrected to match.)
2. Who owns the merged fork branch, and does it get its own spec? The work
   itself is done and verified on `merge/upstream-0.6.13` in `codeslp/cgraph`.
   What remains is a human decision: whether to install it over the working
   0.4.2, and whether a ~23-minute index is acceptable or forces indexing out of
   any request path. `TIMEOUTS.index` in `cgraph_adapter.mjs` still budgets 30
   seconds, which is wrong by two orders of magnitude either way.

## References

- [research/ponytail-headroom-evaluation.md](../research/ponytail-headroom-evaluation.md)
- Spec 005, which introduced `cgraph_adapter.mjs`
- cgraph-research note `006-token-efficiency-integration-plan.md`
- Serena: https://github.com/oraios/serena
- ast-grep: https://github.com/ast-grep/ast-grep
- ccusage: https://github.com/ccusage/ccusage
