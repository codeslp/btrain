# Ponytail and Headroom Evaluation for the btrain Harness

## Question

Should btrain incorporate [ponytail](https://github.com/DietrichGebert/ponytail) (agent ruleset that
pushes for minimal code) or [headroom](https://github.com/headroomlabs-ai/headroom) (context
compression proxy) into the harness that runs `claude`, `codex`, `gemini`, and `app-developer`
across 12 lanes?

## Summary

**Ponytail: adopt selectively, as a repo-local rule — not as the machine-global plugin.**
The value is a 30-line ruleset that is trivially auditable and costs ~400 tokens per session. The
plugin's hook layer has a defect that specifically breaks btrain's multi-pane topology, and its
philosophy conflicts with two btrain skills. Take the text, skip the plugin.

**Headroom: do not adopt. Track it.**
It targets a real cost, but it works by putting a third-party proxy in the model path
(`ANTHROPIC_BASE_URL`), the failure modes it has shipped are silent-corruption class rather than
crash class, and its own checked-in audit says the architecture is wrong and needs ~13 weeks of
rework. btrain's concurrency pattern is the exact configuration its worst bugs target.

---

## Ponytail

### What it is

| | |
|---|---|
| Stars / forks | 138,444 / 7,436 |
| Created | 2026-06-12 (3 months old) |
| License | MIT |
| Version | 4.10.0, last push 2026-09-14 |
| Open issues | 270 |
| Core payload | **30 lines / 423 words** (`.agents/rules/ponytail.md`) |
| Hook layer | 758 lines of Node.js across 6 files |
| Network calls | **none** — grep for `fetch(`/`http`/`child_process` in `hooks/` returns only `process.env` reads |

The substance is a decision ladder the agent climbs before writing code: does this need to exist →
does it exist in this codebase → stdlib → native platform feature → installed dependency → one line
→ minimum that works. Plus a carve-out list of things laziness never applies to (trust-boundary
validation, data-loss handling, security, accessibility).

The ruleset is better than its marketing. It explicitly guards the obvious failure mode: *"The
ladder runs after you understand the problem, not instead of it"* and *"The smallest change in the
wrong place isn't lazy, it's a second bug."* It also mandates root-cause fixes over symptom patches,
which matches btrain's `bug-fix` skill.

### Evidence quality

The headline "54% less code" is from a defensible agentic benchmark (12 feature tickets on
`full-stack-fastapi-template`, Haiku 4.5, n=4) — not the single-shot generation benchmark, which the
maintainer retracted himself after issue #126 pointed out the baseline was padding with prose. That
self-correction is a good sign. The numbers are reproducible offline (`benchmarks/`).

Caveat: 138k stars in three months is anomalous velocity. It does not matter much here — the entire
adoptable surface is 30 lines you can read in two minutes — but it should not be read as three
months of production hardening.

### Fit with btrain

**Where it helps.** btrain's failure mode is agents over-building under a review gate that rewards
visible effort. A cheap pre-write ladder is a reasonable counterweight, and it costs ~400 tokens of
system prompt.

**Two direct conflicts with existing btrain skills:**

1. `code-simplifier` says *"Prefer clarity over compactness"* and optimizes for module depth,
   testability, and agent navigability. Ponytail says *"Shortest working diff wins."* These will
   pull in opposite directions during the same pre-handoff pass.
2. Ponytail's test stance is *"ONE runnable check... no frameworks, no fixtures."* btrain runs
   `node --test 'test/**/*.test.mjs'` with `fast-check` property tests and a TLA+ formal gate. The
   `bug-fix` skill requires a failing reproduction test before production code. Ponytail's minimum
   is below btrain's floor.

Neither is fatal, but both mean the ruleset needs editing before it lands, not a verbatim install.

### Concerns

**Issue [#809](https://github.com/DietrichGebert/ponytail/issues/809) is a direct btrain
hit** (open, reproduced, ponytail 4.9.0): the mode flag lives in a single file per
`CLAUDE_CONFIG_DIR` (`~/.claude/.ponytail-active`). Every Claude Code session on the machine shares
it. So:

- Running `/ponytail-review` in one pane switches *every other pane's subagents* to a "list
  deletions, apply nothing" persona until someone runs `/ponytail full`.
- Starting one session with `PONYTAIL_DEFAULT_MODE=off` **deletes the shared flag**, silently
  disabling ponytail everywhere else.

btrain is multiple concurrent panes on one checkout plus headless workers — precisely the topology
this breaks. The plugin is unsafe here until #809 is fixed.

Other open issues are packaging papercuts (Windows console flash, OpenCode V2 API, Hermes install)
rather than correctness. Issue #823 — "security-sensitive paths should not be capped at one runnable
check" — is worth watching.

---

## Headroom

### What it is

| | |
|---|---|
| Stars / forks | 72,149 / 5,526 |
| Created | 2026-01-07 |
| License | Apache-2.0 |
| Open issues | **643** |
| Size | 1,491 Python files + Rust crates + Docker + SQL + deploy tooling, ~78 MB |
| Last push | 2026-09-15 |

It compresses tool outputs, logs, files and RAG chunks before they reach the model. Three delivery
modes: library (`compress()`), MCP server, and a local proxy. For Claude Code the supported path is
`headroom wrap claude`, which sets `ANTHROPIC_BASE_URL` to a local proxy on `127.0.0.1:8787` and
also installs Serena at user scope in `~/.claude.json`.

Compression is genuinely local — no prompt content leaves the machine, and a scan of outbound hosts
found only provider APIs, GitHub, HuggingFace and PyPI. No telemetry endpoint.

### Fit with btrain — and the overlap with rtk

btrain already runs `rtk` for shell-command token reduction via a Claude Code hook. The overlap is
not hypothetical: **headroom shipped an rtk integration and then removed it.**
`REALIGNMENT/09-phase-G-rtk-observability.md` is marked SUPERSEDED —

> "RTK and lean-ctx were removed from Headroom entirely: the `headroom/rtk/` and
> `headroom/lean_ctx/` packages, all `--rtk` / `--context-tool` flags, the wrap-side hooks and
> hint-file injection, and the proxy-side `rtk gain` [surface]."

Their architecture note explains why the two are different layers: *"RTK rewrites commands not
outputs."* So headroom is additive to rtk rather than redundant — but it is additive at the cost of
a proxy in the model path, and btrain's current token story already covers the cheap half.

### Concerns

**1. Its own checked-in audit says the architecture is wrong.** `REALIGNMENT/00-overview.md`,
current in the tree:

> "Headroom is built on the wrong mental model... It has been wired into the Rust proxy on
> `/v1/messages` with `frozen_message_count: 0` hardcoded — so every compression event drops
> messages from index 0, busting the Anthropic prompt cache for every customer that triggers it."

The same document lists 5 top-tier cache-killer bugs, ~10K LOC of over-build slated for deletion,
"fake" Bedrock/Vertex parity, and a 9-phase / 40-PR / ~13-week realignment. Publishing that audit is
admirable engineering honesty. It is also a clear statement that the system is mid-rewrite.

**2. The concurrency bug class is btrain's exact topology.** From the current CHANGELOG, on the
prefix-cache tracker:

> "the fallback id hashes `model + system prompt` — identical across a Claude Code session and every
> one of its parallel subagents... reported as ~4.4x cache-creation inflation and a 2.5–3x net cost
> increase under Claude Code."

That specific instance is fixed in Unreleased. The class is not: issues
[#3549](https://github.com/headroomlabs-ai/headroom/issues/3549) and
[#3486](https://github.com/headroomlabs-ai/headroom/issues/3486) are both open, both "concurrent
requests cross-contaminate compression state via a shared `ContentRouter`." btrain runs 4 agents
across 12 lanes in one repo. A token-savings tool that inflates cost 2.5–3x under concurrency is a
net loss with extra steps.

**3. The failures are silent, not loud.** Open, current:

- [#3580](https://github.com/headroomlabs-ai/headroom/issues/3580) — `grep -A/-B/-C` context lines
  misdetected as prose, so **source code is routed to the text compressor and silently corrupted**.
- [#3545](https://github.com/headroomlabs-ai/headroom/issues/3545) — the search compressor fuses
  matches into single lines, **manufacturing false line↔content associations**.
- [#3561](https://github.com/headroomlabs-ai/headroom/issues/3561) — no content compressor runs at
  all on the Anthropic `/v1/messages` path, **versions 0.30.0 through 0.37.0**, while `headroom
  doctor` reports healthy.

An agent that silently receives corrupted grep output will write confidently wrong code. In btrain
that lands in a lane, passes a peer review whose reviewer reads the same corrupted context, and
reaches a PR. The review gate does not catch context corruption — it shares it.

**4. Subscription-auth risk, flagged by headroom itself.** From
`docs/context-mode-integration-analysis.md`:

> "The realignment flags 'fingerprint-class subscription-revocation risks' from `X-Headroom-*` header
> leakage, `anthropic-beta` mutation and re-serialization on OAuth/subscription CLIs."

And: *"a deployment mode that works under subscription auth, where the proxy is a revocation risk."*
That is their assessment of their own proxy, not an outside critique. Routing a Claude subscription
through it is not a risk btrain needs to take for a token optimization.

**5. No cheap trial path.** Library/MCP-only avoids the proxy, but their own verification says:
*"with the proxy down, `headroom_stats` returns all zeros and `headroom_compress` no-ops."* The
value requires the interposition. And the install is Python 3.13 + Rust + optional Docker into a
repo whose README advertises zero dependencies.

---

## Recommendation

### Ponytail — adopt the text, not the plugin

Do **not** run `/plugin install ponytail@ponytail` while
[#809](https://github.com/DietrichGebert/ponytail/issues/809) is open; the machine-global mode flag
will leak a review persona across panes and lanes.

Instead, port the ladder into btrain's own skill surface, where it is version-controlled, reviewable,
and lane-scoped like every other btrain rule:

- Fold the 7-rung ladder and the "not lazy about" carve-outs into `code-simplifier`, resolving the
  conflict explicitly — btrain's answer should be *clarity over compactness, but build less*, not
  *shortest diff wins*.
- Keep btrain's test floor. Drop ponytail's "no frameworks, no fixtures" line; it is below what
  `bug-fix` and the TLA+ gate require.
- Consider the `ponytail:` comment convention for deliberate shortcuts with a named ceiling and
  upgrade path. That is a genuinely good idea and maps onto the delegation packet's
  `Remaining gaps` field.

Cost: one skill edit. Risk: near zero. Reversible: fully.

### Headroom — track, do not adopt

Revisit when all three hold:

1. REALIGNMENT Phases A, B and E have landed (cache lockdown, live-zone engine, cache stabilization).
2. The concurrent-`ContentRouter` issues (#3486, #3549) are closed.
3. A no-proxy deployment mode exists — their own `context-mode` analysis names "Headroom No-Proxy
   Edition" as the fix for exactly the blocker btrain has.

Until then, rtk covers the cheap, safe half of the same problem with no model-path interposition.

---

## Verification

```bash
# metadata
gh api repos/DietrichGebert/ponytail  --jq '{stars:.stargazers_count,issues:.open_issues_count}'
gh api repos/headroomlabs-ai/headroom --jq '{stars:.stargazers_count,issues:.open_issues_count}'

# ponytail: audit the whole adoptable surface
git clone --depth 1 https://github.com/DietrichGebert/ponytail
cat ponytail/.agents/rules/ponytail.md          # 30 lines
grep -rE "fetch\(|https?://|child_process" ponytail/hooks/*.js   # no network calls

# headroom: read its own audit before its README
git clone --depth 1 https://github.com/headroomlabs-ai/headroom
sed -n '1,25p' headroom/REALIGNMENT/00-overview.md
sed -n '30,45p' headroom/docs/context-mode-integration-analysis.md
```

## References

- Ponytail repo: https://github.com/DietrichGebert/ponytail
- Ponytail agentic benchmark: `benchmarks/results/2026-06-18-agentic.md`
- Ponytail #809 (machine-global mode flag): https://github.com/DietrichGebert/ponytail/issues/809
- Headroom repo: https://github.com/headroomlabs-ai/headroom
- Headroom self-audit: `REALIGNMENT/00-overview.md`, `REALIGNMENT/09-phase-G-rtk-observability.md`
- Headroom proxy/subscription analysis: `docs/context-mode-integration-analysis.md`
- Headroom #3580, #3561, #3549, #3545, #3486

## Context receipt

- Organizational context tier: `none`. Both projects are external OSS with no btrain history; all
  evidence is from primary sources (GitHub API, shallow clones of both repos at
  `ponytail@4.10.0` / `headroom@dc28413`, and the issue trackers) as of 2026-09-14.
- Local grounding: `research/branchfs-evaluation.md` and `research/zvec-grep-evaluation.md` set the
  evaluation-doc convention followed here.
