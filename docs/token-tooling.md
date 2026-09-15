# Token tooling

Two command-line tools that btrain uses to see and reduce token spend. Neither
is a btrain dependency, and neither sits in the model request path.

Spec 020 measured where btrain's tokens actually go. Cache reads are about 70
percent of cost and scale with context size multiplied by turn count, so the
useful tools are the ones that measure spend or keep context small.

A payload is billed as fresh input only on the turn it arrives; after that it is
re-read as part of the prompt on every later turn. Payload size therefore feeds
the cache-read bucket rather than sitting apart from it, and shrinking what
enters context helps twice. See
[spec 020](../specs/020-token-spend-and-decomposition.md).

## ccusage — see the spend

`ccusage` reads the local session transcripts and reports token use and cost.
Run it with no install:

```bash
npx ccusage@latest daily
```

Useful subcommands:

| Command | What it shows |
|---|---|
| `ccusage daily` | Usage grouped by date |
| `ccusage monthly` | Usage grouped by month |
| `ccusage session` | Usage grouped by session — finds the expensive outliers |
| `ccusage blocks` | Usage grouped by billing block |

Verified on this machine: one `ccusage session` call lists `Claude`, `Codex`, and
`Gemini CLI` rows together, which covers the runtimes in `[agents].active`.
Provider-specific subcommands (`ccusage codex`, `ccusage gemini`) narrow it to
one runtime. Use `ccusage session` first: spec 020 found that
five sessions produced most of the cache reads, so the distribution matters more
than the total.

Do not add `ccusage` to `package.json`. btrain ships zero runtime dependencies,
and `npx` is enough.

## ast-grep — structural search

`ast-grep` matches code by syntax tree instead of by text. Install it once:

```bash
brew install ast-grep
```

It parses `.mjs` through the JavaScript grammar, so it works on all of `src/`.

```bash
ast-grep run --lang js --pattern 'failOpen($$$)' src/brain_train/
```

### When it helps, and when it does not

Measured on the files each query names. Row 1 reads **both**
`src/brain_train/core.mjs` and `src/brain_train/cgraph_adapter.mjs`; rows 2 and 3
read `core.mjs` only. Confirm neither input has moved since these counts were
taken:

```bash
git log -1 --format=%h -- src/brain_train/core.mjs           # 9150811
git log -1 --format=%h -- src/brain_train/cgraph_adapter.mjs
```

Pinning every file a count depends on, rather than the commit that wrote this
doc, means the reference survives a rebase and catches drift in either input. The two tools count
different things, so read the table with that in mind:

- `grep -c` counts **lines that contain the text**, including comments, strings,
  the definition itself, and unrelated words that share a substring.
- `ast-grep --json` counts **true structural matches**. Use `--json`, not piped
  line counting: a multi-line match prints several output lines, so counting
  lines overstates matches. That mistake is how an earlier draft of this file
  reported 13 swallowed-error matches when the real answer is 2.

```bash
agcount() { ast-grep run --lang js --pattern "$1" --json=compact "${@:2}" \
  | python3 -c "import json,sys;print(len(json.loads(sys.stdin.read() or '[]')))"; }

# 1. Rare exact identifier - ast-grep drops the definition and export lines.
#    `grep -c` prints one count PER FILE (2 and 14 here), so pipe the matching
#    lines into wc -l to get the single figure the table quotes.
grep -h "failOpen" src/brain_train/core.mjs src/brain_train/cgraph_adapter.mjs | wc -l
agcount 'failOpen($$$)' src/brain_train/core.mjs src/brain_train/cgraph_adapter.mjs

# 2. Common word - grep over-matches comments, strings and unrelated code
grep -c "status" src/brain_train/core.mjs
agcount 'metadata.status = $_' src/brain_train/core.mjs

# 3. Structural - grep cannot express this at all
grep -c "catch" src/brain_train/core.mjs
agcount 'try { $$$ } catch { return null }' src/brain_train/core.mjs
```

| Query | grep raw occurrences | ast-grep true matches |
|---|---:|---:|
| 1. Call sites of a rare name (`failOpen`) | 16 lines | 13 |
| 2. Occurrences of a common word (`status`) | 326 lines | **3** |
| 3. `catch` blocks that return null | 42 `catch` lines | **2** |

Row 1 is close, and grep is the simpler tool there. Rows 2 and 3 are where
ast-grep earns its place: `status` appears on 326 lines but is assigned in 3
places, and the swallowed-error question cannot be written as a text pattern at
all, so grep leaves 42 `catch` occurrences for an agent to read in order to find
2.

These counts move as `core.mjs` changes. Treat the *pattern* as the finding, not
the exact numbers.

### Pattern reference

| Goal | Pattern |
|---|---|
| Calls to a function | `myFunc($$$)` |
| Async function definitions | `async function $NAME($$$) { $$$ }` |
| Assignment to a field | `obj.field = $_` |
| Swallowed errors | `try { $$$ } catch { return null }` |
| Await on a method | `await $OBJ.method($$$)` |

`$NAME` captures one node. `$$$` captures any number. `$_` matches one node
without capturing it.

## What is deliberately not here

- **Payload compression proxies.** Not because compression is pointless — a
  smaller payload is re-read on every later turn, so it does help. They are
  rejected because `rtk` already shapes tool output *before* it enters context,
  and because a proxy in the model path puts the existing 98%+ cache hit ratio
  at risk for a gain rtk largely already captures. Full reasoning in
  [research/ponytail-headroom-evaluation.md](../research/ponytail-headroom-evaluation.md).
- **Output-style compression.** Most output is tool-call payload rather than
  prose, so restyling prose moves almost nothing. Spec 020 has the breakdown.
