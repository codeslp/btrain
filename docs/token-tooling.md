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

Measured on `src/brain_train/core.mjs`:

| Query | grep | ast-grep |
|---|---:|---:|
| Call sites of a rare name (`failOpen`) | 16 lines | 16 lines |
| Occurrences of a common word (`status`) | 326 hits | **3 hits** (assignments only) |
| `catch` blocks that return null | not expressible | **13 matches** |

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

- **Payload compression proxies.** Rejected in
  [research/ponytail-headroom-evaluation.md](../research/ponytail-headroom-evaluation.md).
  They target fresh input, which is 0.1 percent of cost, and a proxy in the
  model path risks the 98.4 percent cache hit ratio that btrain already has.
- **Output-style compression.** Output is 83.5 percent tool-call inputs and 11.1
  percent prose, so prose is about 1.8 percent of total spend. Spec 020 records
  the full reasoning.
