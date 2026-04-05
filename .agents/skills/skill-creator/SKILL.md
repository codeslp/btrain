---
name: skill-creator
description: Create or revise repo-local skills under `.Codex/skills/`. Use this whenever the user wants to add a skill, turn a repeated workflow into a skill, tighten an existing skill's trigger description, or backfill validation after a skill caused drift or under-triggered.
---

# Skill Creator

Use this skill when creating a new project skill or improving one that already exists.

## Goal

Ship a skill that triggers reliably, stays concise, and includes enough validation guidance to catch drift.

## Workflow

1. Capture intent from the current conversation before drafting:
   - what capability the skill should add
   - what user phrases or contexts should trigger it
   - what output, checklist, or decision the skill should produce
   - whether the skill needs objective test prompts or only a readback review
2. Prefer editing an existing skill over creating a new one if the workflow already fits.
3. Write or tighten the frontmatter first:
   - `name`: stable hyphen-case folder name
   - `description`: say what the skill does and when to use it; put trigger cues here and make it a little pushy so the skill does not under-trigger
4. Keep `SKILL.md` lean:
   - keep the main workflow in the body
   - move bulky schemas, eval details, or domain branches into `references/`
   - add `scripts/` only for repetitive or deterministic steps
5. Add the minimum durable structure:
   - goal
   - workflow
   - constraints
   - default output
   - anti-example or failure mode when misuse is common
6. Define 2-3 realistic trigger prompts for a new or changed skill. If behavior is objective, also define what a pass looks like. For a heavier benchmark loop, read [eval-patterns](references/eval-patterns.md).
7. Run a readback pass:
   - the description alone should explain when the skill fires
   - the body should be imperative and repo-specific
   - reference files should be one level deep and explicitly linked
   - paths should point at canonical files, not archived snapshots, unless the archive is the explicit target

## Constraints

- Do not create a new skill when a small edit to an existing skill will do.
- Do not hide trigger cues in the body; put them in `description`.
- Do not stuff long schemas or examples into `SKILL.md` when `references/` would keep the skill lean.
- Do not add process lore or changelog-style history to a skill.
- Do not leave a new skill without at least a light validation plan.

## Default Output

- Skill files added or updated
- Trigger description changes
- Validation prompts or benchmark plan
- Remaining gaps or unverified behavior

## Persistent Note

If a creation pattern or failure mode should become team process, update the repo's durable process or contributor notes.
