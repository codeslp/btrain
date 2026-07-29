# STE Writing Skill Evaluation and Adoption Decision

**Date**: 2026-07-29
**Status**: Adopted (trial) — PR #25
**Source**: [woosal1337/blog ep01 "The Cure for AI Slop"](https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop) | [ASD-STE100](https://asd-ste100.org)

## What Was Evaluated

An adaptation of ASD-STE100 Simplified Technical English (the aircraft-maintenance
writing standard) as a repo skill for agent-written prose, based on woosal1337's
ep01 experiment: a skill file of writing rules plus a heuristic linter scoring
violations per 100 words.

## Upstream Evidence

The ep01 experiment tested 6 engineering writing tasks (README, PR description,
API docs, error message, getting-started guide, deprecation notice) across two
models under four conditions (baseline, banned-words list, Orwell's rules, STE
skill):

- STE cut lint violations **74% on Claude Sonnet** and **50% on GPT**, beating
  both simpler interventions.
- The upstream retention analysis found no factual or hedging loss in its
  before/after samples; compression came from removing decoration and
  restructuring, not deletion.
- **Caveats the upstream authors state themselves**: n=6 tasks and two models is
  directional evidence, not proof; the linter measures form only ("it cannot
  make a hollow paragraph true"); one task (API docs on GPT) regressed because
  the model chopped prose into fragments to satisfy the linter.

## Expressiveness Risk and Local Adaptations

The main adoption concern was that word caps could prevent full expression of
complex ideas (nested conditionals, trade-off arguments). The local adaptation
addresses this with four guardrails, all encoded in the skill:

1. **Strict mode is narrow**: only error messages, CLI output, procedures, and
   release notes get the full rule set with word limits.
2. **Flavored mode** for general prose treats word limits as targets, not caps.
3. **`research/` is exempt** (including this doc): argumentative writing needs
   nested structure that sentence caps damage.
4. **Escape hatch**: a sentence whose split would sever a logical dependency
   stays whole; hedges and qualifiers are never deleted to satisfy a count.
5. **The linter is advisory only**: it always exits 0 and the skill forbids
   gating handoffs or PRs on the score, which removes the incentive that caused
   the upstream API-docs regression.

## Local Trial Results (this repo, 2026-07-29)

- Deliberately sloppy 88-word marketing sample: **27.27 violations/100w**; all
  planted violation classes detected.
- STE rewrite of the same sample: **0.0/100w in strict mode**, 51 words, with
  every fact and the "close enough in meaning" hedge preserved.
- Repo README baseline: 2.42/100w at first measurement, falling to **1.73/100w**
  purely from linter false-positive fixes (markdown lists, tables, headings,
  code spans, links) during PR #25 review — the README itself was not edited.
- The linter carries a regression suite (60+ checks) covering the practical
  markdown surface: fences, code spans, lists with wrapped and lazy
  continuations, headings, tables, blockquotes, links, indented code,
  abbreviations, and the advisory exit contract.

## Decision

Adopt as the `ste-writing` skill on both agent surfaces
(`.claude/skills/ste-writing/`, `.agents/skills/ste-writing/`), with the linter
at `.claude/skills/ste-writing/scripts/ste-lint.py`. Trial period: observe how
codex and gemini agents write under it across upcoming lanes before considering
any tightening (for example, wiring the score into pre-handoff as an advisory
line).

## Known Limitations

- The linter is a heuristic, not a CommonMark parser; exotic markdown edge
  cases may still miscount sentences. Record new ones as limitations here
  rather than growing the script toward a full parser.
- Word lists are adapted, not identical to upstream, so scores are not directly
  comparable to the ep01 published numbers.
- Strict mode applies the 20-word instruction limit to every sentence because a
  heuristic cannot classify instructions vs. descriptions; it over-flags
  conservatively by design.
- The 50-74% upstream improvement has not yet been reproduced locally on live
  agent output; the trial period exists to gather that evidence.
- Open markdown edge cases from PR #25 review, accepted rather than fixed
  (each fix in this area traded one corner case for another):
  - Lazy blockquote continuations (a quote line wrapped without a `>` marker)
    are linted as prose instead of being exempt.
  - GitHub footnote definitions (`[^1]: note text`) match the reference-link
    definition pattern and are excluded, though their text is prose.
  - A list item's indented follow-on paragraph after a blank line can be
    misread as an indented code block and excluded.
  - Table rows written without a leading pipe (`a | b`) are linted as prose
    instead of being excluded as table data.
