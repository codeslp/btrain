# Lane c Archived Handoff History

## Archived 2026-04-05T18:02:05.453Z

- 2026-04-03 — Massive ai_sales_brain_train code integration (GPT): Reviewed package.json: no actionable issues found. This lane is stale because the change is already merged on main and there is no remaining diff in the locked file.

## Archived 2026-04-05T18:09:53.258Z

- 2026-04-04 — Complete ai_sales_brain_train → btrain rename across package.json, README.md, docs/index.html, and both scripts (GPT): Review found a regression in the handoff-history launch-agent rename. scripts/install-handoff-history-launch-agent.sh now sources only ~/.codex/collab/btrain/handoff-history-agent.env, so existing installs under ~/.codex/collab/ai_sales_brain_train lose their saved HISTORY_PATH and reinstall can fail unless the user re-exports it. scripts/register-handoff-watch-path.sh also now writes/kickstarts only the new btrain slug+label, so existing old-label agents stop seeing watch-list updates. README/docs/package rename look fine; follow-up should preserve or migrate the legacy config dir/label before switching defaults.
