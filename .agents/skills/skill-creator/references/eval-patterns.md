# Eval Patterns

Read this only when a skill needs more than a quick readback review.

## Use This When

- the skill has objective pass/fail behavior
- the skill keeps under-triggering or mis-triggering
- you are comparing an old skill against a revised one
- a recent failure suggests the skill needs a measurable regression check

## Lightweight Loop

1. Write 2-3 realistic prompts a user would actually say.
2. For each prompt, note:
   - what should trigger
   - what the skill should cause the agent to do
   - what a clear failure would look like
3. Run or mentally read back the skill against those prompts.
4. Tighten the description first if the trigger feels ambiguous.
5. Tighten the body only after the trigger is clear.

## Heavier Benchmark Loop

If the skill is high-value or repeatedly failing, compare:

- with the revised skill
- with no skill, or with the prior skill version

Track only the metrics that matter:

- did the skill trigger
- did the workflow follow the intended steps
- did the output match the promised format
- what remained wrong or unverified

Prefer simple, human-readable notes over a complex harness unless the skill is used often enough to justify one.

## What To Improve First

1. Trigger description
2. Missing constraints
3. Missing anti-example or failure mode
4. Missing default output
5. Bulky body content that should move into `references/`
