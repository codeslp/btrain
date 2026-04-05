---
name: frontend-tokens
description: Validate CSS custom property usage whenever editing shared frontend styles, a design-token stylesheet, or introducing new `var(--*)` references. Use it to catch undefined tokens, bad aliases, weak contrast, and semantic misuse like font-family tokens being used as colors.
---

# Frontend Tokens

Use this skill when editing a shared stylesheet or token file, or when adding new `var(--*)` references.

## Goal

Prevent undefined CSS variables and token misuse from shipping unreadable UI.

## Workflow

1. Extract the changed `var(--*)` references.
2. Cross-check each one against the repo's token source (`:root`, theme file, or design-token stylesheet).
3. For an undefined token:
   - map it to an existing alias if that is the intended token, or
   - add an explicit definition in `:root`.
4. Check semantic misuse:
   - color token used as font-family
   - font-family token used as color
   - text token used as a background without intent
5. Sanity-check contrast on dark surfaces before handoff.

## Constraints

- Do not reference a CSS variable without verifying it exists in `:root`.
- Do not use font-family variables as color values or color variables as font-family values.
- Add new aliases in the same change that introduces them.

## Default Output

- Changed token references
- Undefined or mismatched tokens
- New aliases or fixes added
- Remaining contrast or semantics risks

## Anti-Example

```css
color: var(--heading); /* --heading is a font-family token, not a color */
```

## Persistent Note

If token drift keeps recurring, update the repo's durable process or contributor notes.
