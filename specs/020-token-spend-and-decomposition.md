# 020 — Token Spend, cgraph Repair, and core.mjs Decomposition

**Status**: Draft
**Version**: 0.1.0
**Author**: btrain
**Date**: 2026-09-14

## Decision

Cut btrain token spend at its measured source, and repair the code-graph
integration that the measurement exposed as broken.

The measurement changed the target. Token spend in btrain is not a payload
problem. It is a context-growth problem. Compression tools shrink fresh input,
which is 0.1 percent of cost. Cache reads are about 70 percent. Cache reads scale
with context size multiplied by turn count, so the levers are smaller context
and fewer turns.

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

Measured from the local session transcripts under
`~/.claude/projects/-Users-bfaris96-btrain/`. Figures below are the
**2026-09-15 03:30Z** run: 51 sessions, 6,713 assistant turns.

| Bucket | Tokens | Share of cost |
|---|---:|---:|
| Cache reads | 2,008,317,478 | 70.7% |
| Output | 8,984,968 | 15.8% |
| Cache creation | 30,461,504 | 13.4% |
| Fresh input | 163,965 | 0.1% |

Cache hit ratio is 98.5 percent. Prompt caching already works. Any change that
risks the hit ratio costs more than it saves.

Cost share is a weighting, not a bill. The script applies fixed per-MTok rates
(input 3.00, cache write 3.75, cache read 0.30, output 15.00) to compare buckets
against each other. These sessions ran Fable 5 and 5.1, so the absolute dollar
figure is indicative. The **proportions** are what the spec relies on, and they
hold across any pricing where output costs several times input and cache reads
are discounted an order of magnitude.

Five sessions produce 82.9 percent of all cache reads:

| Session | Turns | Cache reads | Mean context per turn |
|---|---:|---:|---:|
| 628702f4 | 1,347 | 699,118,027 | 519,018 |
| c3729997 | 805 | 345,420,632 | 429,093 |
| cf17490d | 519 | 242,836,248 | 467,892 |
| 37a4e562 | 551 | 191,271,769 | 347,135 |
| 91d9953f | 793 | 186,471,391 | 235,146 |

The median session runs at 30,202 tokens of context per turn. The top three run
between 429,000 and 519,000, and session 628702f4 held a near-full 1M window for
over a thousand turns across eight hours.

Output splits as follows, by assistant content-block type:

| Output component | Share of characters |
|---|---:|
| `tool_use` inputs | 83.7% |
| Prose text | 11.2% |
| Thinking | 5.0% |
| Fenced code in text | 0.2% |

### These numbers drift, including from the act of measuring

The corpus includes the sessions that do the analysis. An earlier run on
2026-09-14 reported the top-five share as 89.9 percent; the same script now
reports 82.9 percent, because the session doing the work has since added
hundreds of turns to the denominator. Nothing was miscounted. Re-run the script
rather than quoting these figures, and record the date whenever you do.

The ratios that drive every decision in this spec are stable across both runs:
cache reads stay near 70 percent, fresh input stays at 0.1 percent, and the cache
hit ratio stays above 98 percent.

### Reproduction

This script derives **every** figure above, including the cost weighting, the
session table, and the output composition. Save and run it:

```python
import json, glob, collections, os, sys

# Per-MTok rates used only to weight buckets against each other.
RATE = {"input_tokens": 3.00, "cache_creation_input_tokens": 3.75,
        "cache_read_input_tokens": 0.30, "output_tokens": 15.00}
GLOB = os.path.expanduser("~/.claude/projects/-Users-bfaris96-btrain/*.jsonl")

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

Indexing is not slow. The graph is empty for a different reason.

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

**Conclusion: merge the fork. The spike says it works.**

Run 2026-09-14 against upstream 0.6.13, installed in an isolated virtualenv with
an isolated `HOME` and its own KuzuDB, so the working 0.4.2 install and the
4.8 GB production graph were untouched. Same btrain checkout, same
`scip-typescript`, same `tsconfig.json`.

| Metric | kkg 0.4.2 (fork) | upstream 0.6.13 |
|---|---:|---:|
| **CALLS edges** | **0** | **22,979** |
| Function nodes | — | 3,988 |
| Class nodes | — | 249 |
| Files scanned | 226 | 294 (`.mjs` 51, `.py` 52, `.js` 8) |
| Index wall time | 47 s | **1,612 s (26.9 min)** |

The call graph is real on upstream. The 47-second fork index was fast because it
did no call resolution at all.

Two consequences:

1. **The merge is justified.** It is 847 upstream commits against 56 fork-only
   commits, and a trial merge produced 45 conflicts — 22 in `docs/` and
   `website/`, 6 in tests, and **15 in real source**, including
   `tools/graph_builder.py` and `tools/indexing/persistence/writer.py`. That is a
   real merge, not a rebase, and it needs its own spec.
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

1. **Done.** `tsconfig.json` added to the btrain root.
2. **Superseded.** A two-line cherry-pick is not enough. Causes 1 and 4 both
   need upstream code, and cause 5 is undiagnosed. Do the fork merge.
3. **Done.** `javascript` added to `SCIP_LANGUAGES`.
4. Reinstall kkg with the embeddings extra. `kkg search` currently raises
   `ModuleNotFoundError: No module named 'sentence_transformers'` and exits.
5. Clear the cgraph registry. It holds 43 entries. 33 are throwaway fixtures
   under `/private/tmp/cgc_test/`. Four are individual btrain files registered
   as projects. Register the btrain root as one project.
6. **Done.** `.cgcignore` added to `.gitignore`.
7. Add `agentchattr/.venv/` to `.cgcignore` so language detection stops counting
   vendored Python. This does not help on 0.4.2, which ignores `.cgcignore`
   during detection, but it is correct for the merged version.

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
about 92,000 tokens. It defines 352 top-level functions behind 2 exports. It is
56 percent of the source tree.

An agent that reads this file spends about half of a 200,000-token window. The
file then stays in context, and btrain pays for it again as cache reads on every
later turn. This file is the largest single contributor to the measured cost.

Tasks:

1. Group the 352 functions by responsibility. Use the existing module names as
   the seed: lane state, locks, handoff rendering, transitions, events,
   reviewer dispatch.
2. Extract one group per change. Keep every public export stable.
3. Run `npm test` after each extraction.
4. Record the Spec 014 formal impact for each extraction. A pure move has no
   semantic impact. Any guard change has semantic impact.

Acceptance: no file in `src/brain_train/` exceeds 2,000 lines. `npm test`
passes. The public export surface does not change.

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
   `core.mjs`: ast-grep returns the *same* 16 lines as grep for a rare exact
   identifier, so a blanket rewrite would buy nothing and add a dependency to
   every search. It wins only when a text search over-matches (`status`: 326 grep
   hits against 3 assignment hits) or when the query is structural (`catch`
   blocks returning null: 13 matches against 42 occurrences to read by hand).
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
2. Merge upstream 0.6.13 into `codeslp/cgraph`. The trial merge on the other
   fork showed the shape: 45 conflicts, of which 37 are upstream's own
   `docs/`, `website/`, and `tests/` and resolve to upstream wholesale. The
   btrain command surface lives entirely in `codegraphcontext_ext/`, which
   upstream does not have, so it merges with **zero** conflicts. Only three
   files carry `codegraphcontext_ext` wiring and need hand-resolution:
   `cli/main.py`, `cli/cli_helpers.py`, and `server.py`.
3. Pick one CLI name and keep the others as deprecated aliases, so the adapter's
   four-name probe can shrink.
4. Archive `codeslp/keplerkg` once its three fixes have landed.
5. Only then enable `[cgraph]` in btrain, with the inconclusive fix already in.

This is its own spec. It is not part of spec 020's budget.

## Rejected: output-style compression

Caveman and similar skills compress agent output by constraining style. This
spec rejects them for btrain, on measured grounds rather than taste.

Output is about 16 percent of cost, and the Evidence section breaks it down by
content-block type: `tool_use` inputs are 83.7 percent of output characters and
prose is 11.2 percent.

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

The real output lever is `tool_use` payload, not prose. Workstreams 5 and 6
address that. Note one counter-effect: the Serena evaluation reports that
symbolic editing sends **more** payload than a plain text edit for small,
single-file changes, because the caller must supply the full symbol body. Scope
Serena to navigation and cross-file refactoring, and keep plain edits for small
changes.

## Dependency order

0. The fork merge now blocks the cgraph half of Workstream 1. The adapter
   correctness fix does not wait on it and has landed.
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

1. Does the fail-open adapter treat an empty graph as a clean pre-lock collision
   check today, in the judgment of the reviewer? This spec states that it does.
2. Who owns the fork merge, and does it get its own spec? The spike settled
   whether it is worth doing: upstream produces 22,979 CALLS edges on btrain
   where the fork produces 0. Open questions are ownership, and whether the
   27-minute index is acceptable or forces indexing out of the request path.

## References

- [research/ponytail-headroom-evaluation.md](../research/ponytail-headroom-evaluation.md)
- Spec 005, which introduced `cgraph_adapter.mjs`
- cgraph-research note `006-token-efficiency-integration-plan.md`
- Serena: https://github.com/oraios/serena
- ast-grep: https://github.com/ast-grep/ast-grep
- ccusage: https://github.com/ccusage/ccusage
