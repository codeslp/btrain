# Project Test Patterns

## Backend - `node:test` + `node:assert/strict`

### Imports

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
```

### Factory Helpers

Build minimal valid objects, override only what matters:

```typescript
function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@example.com',
    role: 'member',
    active: true,
    ...overrides,
  };
}

function request(overrides: Partial<RequestPayload> = {}): RequestPayload {
  return {
    id: 'req-1',
    userId: 'user-1',
    status: 'pending',
    createdAt: 1,
    ...overrides,
  };
}
```

### Time Control

```typescript
function withNow<T>(value: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}
```

### Environment Variable Control

```typescript
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
```

### Integration Harness Pattern

For route, service, or API-level integration tests:

```typescript
import { createTestHarness } from './test-harness';

test('feature under test', async () => {
  const h = await createTestHarness();
  try {
    const response = await h.request('/api/example', {
      method: 'POST',
      body: JSON.stringify({ name: 'Example' }),
    });
    assert.equal(response.status, 201);
  } finally {
    await h.cleanup();
  }
});
```

### Running Backend Tests

```bash
# Single file
node --test path/to/file.test.js

# If the repo compiles before testing
npm run build && node --test dist/path/to/file.test.js

# Repo-native suite
npm test
```

---

## Frontend - `vitest` + `jsdom`

### Imports

```typescript
import { afterEach, expect, test, vi } from 'vitest';
```

For `jsdom`, add the pragma at the top of the file:

```typescript
// @vitest-environment jsdom
```

### API Mocking

Mock the repo's HTTP client or API wrapper for network-free tests:

```typescript
vi.mock('../api-client', () => ({
  apiFetch: vi.fn(),
  authHeaders: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
  jsonHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-token',
  })),
}));
```

### React Hook Test Harness

Use `createRoot` + `act` for hook testing when the repo does not already provide a helper:

```typescript
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

function renderUseExample(options = {}) {
  let latest: ReturnType<typeof useExample> | null = null;

  function Harness() {
    latest = useExample(options);
    return null;
  }

  const container = document.createElement('div');
  const root = createRoot(container);

  act(() => {
    root.render(createElement(Harness));
  });

  return {
    getApi() {
      if (!latest) throw new Error('Hook harness did not initialize');
      return latest;
    },
    unmount() {
      act(() => {
        root.unmount();
      });
    },
  };
}
```

### Browser API Mocking

Common patterns for mocking browser APIs:

```typescript
// MediaDevices
const getUserMediaMock = vi.fn();
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: getUserMediaMock },
});

// ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

// matchMedia
vi.stubGlobal('matchMedia', vi.fn(() => ({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})));
```

### Cleanup

Always restore globals in `afterEach`:

```typescript
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});
```

### Running Frontend Tests

```bash
# Single file
npx vitest run path/to/file.test.ts

# Repo-native suite
npm test
```

---

## Test Naming Convention

Use behavioral descriptions:

```text
test('<subject> <behavior> <condition>')
```

Examples:

- `test('rejectRequest returns 400 for malformed payloads')`
- `test('session store invalidates expired tokens on read')`
- `test('useAutosave flushes pending changes on blur')`
- `test('permissions service denies admin routes for non-admin users')`
