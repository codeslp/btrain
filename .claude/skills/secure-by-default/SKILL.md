---
name: secure-by-default
description: Run a server-side trust-boundary check whenever a change touches auth, rate limits, permissions, entitlements, payments, admin actions, or any mutating API route. Use it to catch client-only security controls before handoff, especially when the frontend appears to enforce the rule already.
---

# Secure By Default

Use this skill when a lane touches auth routes, rate limits, permissions, entitlements, payment flows, admin actions, or any `POST`/`PUT`/`DELETE` endpoint that mutates state.

## Goal

Catch security logic that only exists in the client and force enforcement at the API boundary.

## Workflow

1. List each new or changed mutating endpoint.
2. For each endpoint, answer:
   - Can this API be called directly to bypass the frontend guard?
   - Is there server-side proof of the qualifying action?
   - Is the operation idempotent or replay-safe?
   - Is rate limiting enforced server-side rather than in browser state?
3. If any answer is `no` or `unclear`, treat it as a blocking issue before handoff.
4. Add a short `Trust Boundary` note to the handoff context naming the endpoints and their enforcement status.

## Constraints

- Do not treat `localStorage`, `sessionStorage`, or React state as security enforcement.
- Do not skip this for authenticated “internal” routes.
- Every rate limit must have a server-side counter.
- Every entitlement or privileged action must require server-observed qualifying evidence.

## Default Output

- Endpoints checked
- Trust-boundary status for each endpoint
- Blocking gaps
- Verification run

## Anti-Example

```ts
const attempts = parseInt(localStorage.getItem('exportAttempts') || '0', 10);
if (attempts >= 5) return;
// API has no throttle, so clearing storage bypasses the limit.
```

## Persistent Note

If this catches a recurring pattern, update the repo's durable process or contributor notes.
