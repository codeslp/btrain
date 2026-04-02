---
name: test-writer
description: Write or expand unit, integration, and component tests. Use when adding tests to untested modules, expanding coverage for existing test files, writing regression tests for bugs, or when the user asks to "add tests", "expand coverage", "write tests for X", or "test this". Triggers on any test-writing request — not E2E browser tests (use webapp-testing for those).
---

# Test Writer

Use this skill when writing tests for backend or frontend modules. Covers unit tests, integration tests, and component or hook tests.

## Philosophy

Follow the **Testing Trophy** (Kent C. Dodds) — prioritize integration tests over pure unit tests:

1. **Static analysis** (TypeScript + ESLint) catches type bugs automatically
2. **Unit tests** for pure logic: calculations, transforms, validators
3. **Integration tests** for module interactions: stores, routes, multi-component flows
4. **E2E tests** sparingly (use `webapp-testing` skill instead)

**Core principle:** "The more your tests resemble the way your software is used, the more confidence they can give you." Test behavior and contracts, not implementation details.

## Workflow

### 1. Assess Before Writing

- Read the source file to identify **critical paths**: state mutations, error handling, edge cases, security boundaries
- Check for existing tests near the implementation and follow the repo's current naming pattern (`*.test.*`, `*.spec.*`, or equivalent)
- Identify the right test level:
  - Pure functions → unit test
  - Store/route interactions → integration test with the repo's existing harness or fixture helpers
  - React hooks → `jsdom` harness with `createRoot`/`act`
  - React components → `jsdom` + component render harness
- **Skip trivial code**: type definitions, re-exports, simple getters, config objects

### 2. Structure Every Test with AAA

```
test('descriptive name expressing expected behavior', () => {
  // Arrange — set up data, mocks, fixtures
  // Act — call the function or trigger the behavior
  // Assert — verify the outcome
});
```

### 3. Write Tests Using Project Conventions

Use the patterns in [references/project-patterns.md](references/project-patterns.md).

### 4. Prioritize What to Test

**Always test (high-value):**
- Security boundaries (auth, access control, input validation)
- State mutations (store writes, database operations)
- Error paths (what happens when things fail)
- Business logic and policy rules
- Edge cases (empty inputs, null/undefined, boundary values)

**Skip (low-value):**
- Getter-only functions with no logic
- Type re-exports
- Simple pass-through wrappers
- UI layout details (test behavior, not appearance)

### 5. Verify

- Run the narrowest repo-native command that exercises the new test first
- If the repo compiles tests before execution, build first and run the compiled test target
- Use broader package or workspace test commands only after the focused target passes

## Constraints

- **Never use `any` for mock types** when a proper interface exists — use `Partial<T>` with factory helpers
- **Never test implementation details** — don't assert on internal state, private methods, or call order unless it's the contract
- **Never leave mocks dirty** — always restore in `afterEach`
- **Never write tests that pass when the code is broken** — a test should fail if you break the behavior it covers
- **Always use `try/finally` for cleanup** in integration tests that start servers or create resources
- **Keep test names behavioral** — describe what happens, not what the function is called

## Anti-Examples

❌ `test('calls processMessage')` — tests implementation detail
✅ `test('rejectRequest blocks malformed payloads regardless of casing')` — tests behavior

❌ `assert.equal(store._internal.count, 5)` — reaches into private state
✅ `assert.equal(store.listUsers().length, 5)` — tests through the public API

❌ Mocking every dependency of a function → fragile, low confidence
✅ Using real dependencies with a factory helper → resilient, high confidence

## Default Output

- Test file(s) created or expanded
- Run command and pass/fail results
- Coverage gaps still remaining (if any)
- Whether integration-test-check skill should also run

## Trigger Prompts

1. "Add tests for pricing-rules.ts" → Read source, identify critical paths, write tests using the repo's backend test stack and factory helpers
2. "Test the useAutosave hook" → Set up the repo's component or hook harness, mock browser APIs as needed, test the lifecycle that matters
3. "We need regression tests for this bug fix" → Write a test that would have caught the bug, then verify the fix makes it pass
