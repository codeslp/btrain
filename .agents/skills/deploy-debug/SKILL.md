---
name: deploy-debug
description: Classify deployment failures before debugging. Use this whenever a deploy target is unhealthy, a healthcheck fails, or logs hint at startup trouble. Separate build, startup, readiness, and runtime failures, require one concrete log line before hypothesizing, then use context-scout for related incidents, deploy PRs, and runbooks.
---

# Deploy Debug

Use this skill when a deploy fails, the hosting platform reports unhealthy, or deployment logs are being analyzed.

## Goal

Debug the correct layer first.

## Workflow

1. Classify the failure as exactly one of:
   - `build`
   - `startup`
   - `readiness`
   - `runtime`
2. Require one concrete log line that proves the classification before proposing a cause.
3. **Invoke `context-scout` at `targeted` tier** — after you have the decisive log line,
   search for recent deploy PRs, incidents, or team discussion around the same service/error:
   ```bash
   .claude/scripts/unblocked-context.sh research \
     "<service/deploy target> <decisive log line> deploy incident startup readiness" \
     --effort low --limit 5
   ```
   - Use matching incidents or PRs to choose the next validation step.
   - If the result has `_skipped`, record `Unblocked deploy context skipped: <reason>` and continue from logs. Do not hypothesize without the concrete log line from step 2.
   - Escalate to `deep` when the failure is recurring, cross-service, or the first pass leaves
     multiple plausible causes.
4. Use the matching platform surface:
   - build: build logs for the failed deployment
   - startup: deployment or container startup logs
   - readiness: public health or readiness check plus runtime logs
   - runtime: app or HTTP logs for the failing route
   - if the repo uses Railway, `railway logs --build` and `railway logs --deployment <id> --lines <n>` are the preferred shortcuts
5. Record deployment ID, timestamp, route, decisive error text, and any relevant Unblocked source URLs in the handoff or incident note.

## Constraints

- Do not jump to readiness or runtime debugging before proving the process started.
- Do not hypothesize without a concrete log line.
- Prefer exact deployment IDs and timestamps once an incident is in flight.

## Default Output

- Failure class
- Deployment ID and timestamp
- Decisive log line
- Unblocked deploy context sources or skip reason
- Next validation step

## Persistent Note

If the same classification mistakes recur, update the repo's durable process or contributor notes.
