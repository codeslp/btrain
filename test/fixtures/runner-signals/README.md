# Runner signal samples

Spec 023 FR-4 classifies a reviewer runner's exit from its exit code and the
last lines of its output. `src/brain_train/review/runner-table.mjs` ships a
quota, authentication, or refusal pattern only when a real sample of that
message is here (implementation plan, "Runner table": no sample, no pattern).
`test/review-runner-table.test.mjs` checks every shipped pattern against its
sample.

| File | Executable | Class | Where it was captured |
| --- | --- | --- | --- |
| `codex-usage-limit.txt` | `codex` | `tool_unavailable` (quota) | The turn error the Codex CLI recorded in its local session log on 2026-11-23, when the account was out of usage. Copied verbatim, including the curly apostrophe. |
| `claude-not-logged-in.txt` | `claude` | `tool_unavailable` (authentication) | The `result` text of `claude -p --output-format json` run with an empty config directory on 2026-09-02 (`is_error: true`). |

No sample exists yet for:

- a Claude quota message;
- a refusal (`policy_blocked`) from any runner;
- a Gemini message of any class;
- the Codex `model_not_found` error (the plan names it, but only a config
  comment mentions it, not captured output);
- the Cursor Agent CLI (`agent`) weekly-usage message. `agent` has no runner
  table entry until PR #113 merges.

Add a sample here first, then its pattern. Until then those exits classify as
`failed`, and the request loop still tries the next reviewer; only the label
is less specific. A repository can add patterns without a release in
`[review.signals.<executable>]`.
