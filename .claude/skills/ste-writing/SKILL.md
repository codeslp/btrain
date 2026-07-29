---
name: ste-writing
description: Write or rewrite non-code prose in Simplified Technical English (adapted from ASD-STE100). TRIGGER whenever you draft or edit READMEs, PR descriptions, handoff summaries, reviewer context, error messages, release notes, deprecation notices, getting-started guides, or user-facing docs — and whenever the user says "STE", "slop", "tighten this", "make this concise", or "rewrite this cleanly". DO NOT TRIGGER for code, identifiers, command syntax, commit subject lines, marketing copy, or anything under research/ (argumentative trade-off writing is exempt).
---

# STE Writing

Adapted from ASD-STE100 Simplified Technical English via woosal1337's ep01 experiment
(https://github.com/woosal1337/blog/tree/main/videos/ep01-the-cure-for-ai-slop).
Upstream code is MIT-licensed; see the NOTICE file in this skill's directory.
The evidence, expressiveness-risk analysis, adoption decision, and known
limitations live in `research/ste-writing-evaluation.md` — ground any change
to this skill in that doc.

## Goal

Produce prose that keeps every fact, constraint, and hedge, and drops the decoration.
Complexity survives through organization (lists, short paragraphs), not through deletion.

## Modes and scope

Pick the mode first. When in doubt, use flavored.

- **Strict** — error messages, CLI output, procedures, safety-critical steps, release
  notes. Apply every rule, including the word limits.
- **Flavored** — READMEs, PR descriptions, handoff summaries, guides, code-adjacent
  docs. Apply sentence discipline, active voice, and the naming rules. Relax the
  vocabulary limits when the natural word is the precise word.
- **Exempt** — everything under `research/`, design rationale, and trade-off analysis.
  These need nested argument structure that word caps damage. Never lint-gate them.

## Core rules

Words:
1. One name per thing. Never rotate synonyms for the same item.
2. Prefer the short common word: "start" not "commence", "use" not "utilize",
   "help" not "facilitate".
3. No marketing adjectives: seamless, robust, powerful, cutting-edge, elegant.
4. No filler hedges: "it is important to note", "it's worth noting", "as mentioned".

Verbs:
5. Active voice when the actor is known.
6. Use the verb, not its nominalization: "analyze the log", not "perform an
   analysis of the log".
7. No stacked auxiliaries. Avoid "-ing" as the main verb when a simple tense works.

Sentences:
8. One instruction per sentence.
9. Strict mode: max 20 words per instruction, 25 for description. Flavored mode:
   treat these as targets, not caps.
10. No contractions. Keep articles (a, an, the).
11. Replace semicolons with periods.

Structure:
12. One topic per paragraph, max six sentences.
13. Steps go in numbered lists, imperative form, one action per item.

## Escape hatch

If splitting a sentence would sever a logical dependency (nested conditionals,
"unless"-clauses, cause-effect chains), keep the sentence and accept the lint hit.
Prefer restructuring into a list before you drop nuance. Never delete a hedge or a
qualifier to satisfy a word count.

## Workflow

1. Draft (or take the input text). Decide the mode.
2. Self-lint pass:
   - Split sentences over the limit, unless the escape hatch applies.
   - Replace semicolons. Expand contractions.
   - Convert passive to active where the actor is known.
   - Replace nominalizations and phrasal verbs with plain verbs.
   - Check one-name-per-thing across the whole text.
3. Run the advisory linter and report the score:
   `python3 .claude/skills/ste-writing/scripts/ste-lint.py [--strict] <file>`
   (or pipe text on stdin).
4. Fix what the linter flags only when the fix keeps meaning. The score is a
   signal, not a gate — it always exits 0.

## Constraints

- The linter is advisory. Never block a handoff, PR, or review on its score.
- Never optimize for the score by chopping prose into fragments. The API-docs task
  in the source experiment regressed exactly this way.
- Never apply this skill to `research/` docs or to quoted text from other authors.
- The skill fixes form only. It cannot make a hollow paragraph true — verify facts
  separately.

## Failure mode (anti-example)

Bad: "Configured the retry. Uses backoff. It helps." — three fragments, actor
lost, meaning damaged, but a great lint score.
Good: "The client retries failed requests with exponential backoff, up to the
`max_retries` limit." — 14 words, one topic, every fact intact.

## Validation prompts

- "Rewrite this README intro in STE" → output keeps all facts, drops marketing
  adjectives, linter score improves versus input.
- "Draft an error message for a rate-limited API" → strict mode, imperative
  recovery steps as a numbered list, zero contractions/semicolons.
- "Tighten this PR description" → flavored mode, 30-40 word sentences restructured
  into one-action lines, no technical detail lost.
