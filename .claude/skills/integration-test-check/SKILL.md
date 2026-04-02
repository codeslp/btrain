---
name: integration-test-check
description: Add a composition check whenever a fix spans multiple components, hooks, providers, shared resources, or event consumers. Use it to catch bugs that pass isolated unit tests but still fail in the real user path.
---

# Integration Test Check

Use this skill when a change touches 2 or more components that share state, context, events, or a resource like a cache client, event bus, or browser API handle.

## Goal

Make sure the full user path works, not just the individual parts.

## Workflow

1. Identify the shared resource or contract.
2. List the components that create, own, or consume it.
3. Ask whether the current tests exercise the full user flow from trigger to outcome.
4. If not, define the smallest integration test that:
   - mounts the parent or owner,
   - simulates the user action,
   - asserts the final behavior across consumers.
5. Check for the “separate instance” bug: a consumer silently creating its own instance instead of using the shared one.

## Constraints

- Do not stop at unit tests when the bug spans multiple components.
- Prefer the smallest end-to-end composition test that proves the real path.
- Keep the test focused on the shared contract, not every edge case.

## Default Output

- Shared contract or resource under test
- Smallest integration path chosen
- Test added or exact reason no integration test was feasible
- Remaining unverified surfaces

## Anti-Example

Unit tests pass for a hook and a view separately, but production still fails because one consumer creates a fresh shared resource instead of using the provider-owned instance.

## Persistent Note

If composition failures keep recurring, update the repo's durable process or contributor notes.
