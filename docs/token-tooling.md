# Token tooling

Two command-line tools that btrain uses to see and reduce token spend. Neither
is a btrain dependency, and neither sits in the model request path.

Spec 020 measured where btrain's tokens actually go. Cache reads are 69.8
percent of cost, output is 16.1 percent, and fresh input is 0.1 percent. Cache
reads scale with context size multiplied by turn count, so the useful tools are
the ones that measure spend or keep context small. Payload compression targets
the 0.1 percent and is rejected. See
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

It reports `claude`, `codex`, and `gemini` separately, which covers every
runtime in `[agents].active`. Use `ccusage session` first: spec 020 found that
five sessions produced 89.9 percent of all cache reads, so the distribution
matters more than the total.

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

Measured on `src/brain_train/core.mjs` at commit `e220dd1`. Re-run these to
check the numbers against the current file:

```bash
# 1. Rare exact identifier - no difference
grep -c "failOpen" src/brain_train/core.mjs src/brain_train/cgraph_adapter.mjs
ast-grep run --lang js --pattern 'failOpen($$$)' \
  src/brain_train/core.mjs src/brain_train/cgraph_adapter.mjs | grep -cE '^src/'

# 2. Common word - grep over-matches comments, strings and unrelated code
grep -c "status" src/brain_train/core.mjs
ast-grep run --lang js --pattern 'metadata.status = $_' \
  src/brain_train/core.mjs | grep -cE '^src/'

# 3. Structural - grep cannot express this at all
grep -c "catch" src/brain_train/core.mjs
ast-grep run --lang js --pattern 'try { $$$ } catch { return null }' \
  src/brain_train/core.mjs | grep -cE '^src/'
```

| Query | grep | ast-grep |
|---|---:|---:|
| 1. Call sites of a rare name (`failOpen`) | 16 | 16 |
| 2. Occurrences of a common word (`status`) | 326 | **3** (assignments only) |
| 3. `catch` blocks that return null | 42 `catch` to read by hand | **13 matches** |

These counts move as `core.mjs` changes. Treat the *pattern* as the finding, not
the exact numbers: ast-grep ties grep on row 1 and wins on rows 2 and 3.

The honest summary: ast-grep gives **no** token saving when you already know an
exact, rare identifier. grep is fine there, and simpler. ast-grep wins in two
cases:

1. **The identifier is common.** `status` appears 326 times in comments,
   strings, and unrelated code. The structural query for assignments returns 3.
2. **The question is structural.** "Which `catch` blocks swallow the error by
   returning null" cannot be written as a text pattern. grep finds 42 `catch`
   occurrences and leaves an agent to read all of them. ast-grep returns the 13
   that match.

So reach for ast-grep when a text search would over-match, or when the question
is about code shape. Keep using grep and `rtk` for everything else.

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

- **Payload compression proxies.** They optimize the 0.1 percent above, and a
  proxy in the model path puts the existing cache hit ratio at risk. Rejected in
  [research/ponytail-headroom-evaluation.md](../research/ponytail-headroom-evaluation.md).
- **Output-style compression.** Most output is tool-call payload rather than
  prose, so restyling prose moves almost nothing. Spec 020 has the breakdown.
