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

# 2. Common word
grep -c "status" src/brain_train/core.mjs                          # naive
grep -cE 'metadata\.status[[:space:]]*=[^=]' src/brain_train/core.mjs   # targeted
agcount 'metadata.status = $_' src/brain_train/core.mjs

# 3. Structural
grep -c "catch" src/brain_train/core.mjs                           # naive
grep -A1 "catch" src/brain_train/core.mjs | grep -c "return null"  # targeted
agcount 'try { $$$ } catch { return null }' src/brain_train/core.mjs
```

Measured 2026-09-15 against `main`:

| Query | naive grep | **targeted grep** | ast-grep |
|---|---:|---:|---:|
| 1. Call sites of a rare name (`failOpen`) | 16 | 14 | 13 |
| 2. Assignments to `metadata.status` | 326 | **3** | **3** |
| 3. `catch` blocks that return null | 42 | **2** | **2** |

**Read the middle column before believing the case for ast-grep.** An earlier
revision of this file showed only the outer two columns and reported row 2 as
"326 lines against 3". That is true but not like-for-like: 326 is what you get
searching for the bare word `status`, which is not the query. Against a grep
that actually expresses the same question, ast-grep wins row 2 by nothing, row 3
by nothing, and row 1 by one line.

So the honest case for ast-grep is **not** a smaller result set. It is:

1. The targeted grep needs you to know the exact textual form in advance —
   `metadata.status = x` and `metadata . status = x` need different regexes;
   ast-grep matches the syntax either way.
2. The row 3 targeted grep is right here by luck. `grep -A1` inspects one line
   after `catch`, so it finds a `return null` on the next line and misses one
   three lines down. The pattern does not generalize; the ast-grep query does.
3. Row 1's two extra grep lines are the definition and the export, which is
   exactly the noise a call-site query should drop.

That is a real but modest gain, and it is a *correctness* gain rather than a
token gain. Adopt ast-grep for structural queries where a regex would be
fragile. Do not expect it to cut search output by two orders of magnitude.

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
  smaller payload is re-read on every later turn, so it does help, and the
  research doc is explicit that headroom is *additive* to `rtk`, not redundant
  with it. The rejection rests on one thing only: a proxy in the model path puts
  the existing 98%+ cache hit ratio at risk, and a lost cache hit costs more than
  the compression saves. `rtk` covers "the cheap, safe half of the same problem
  with no model-path interposition", which is why it is the current answer — not
  because it captures most of the available gain. Revisit when headroom ships a
  no-proxy mode. Full reasoning and the three revisit conditions in
  [research/ponytail-headroom-evaluation.md](../research/ponytail-headroom-evaluation.md).
- **Output-style compression.** Most output is tool-call payload rather than
  prose, so restyling prose moves almost nothing. Spec 020 has the breakdown.
