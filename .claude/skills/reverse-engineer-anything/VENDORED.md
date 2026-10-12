# Vendored skill

This skill is vendored unchanged from [morluto/rea](https://github.com/morluto/rea),
path `.agents/skills/reverse-engineer-anything/`, commit
`c9aecde580d26d4e7745c2623a4efa327a27367e` (2026-10-12). It is MIT licensed; the
upstream notice is in `LICENSE` next to this file and must stay with every copy.

Do not edit `SKILL.md` or `references/` here. To update, copy the upstream files at a
new commit into both `.claude/skills/` and `.agents/skills/`, then update the commit
above. btrain's own guidance for this skill lives in `clean-room-rebuild`.

## What this skill needs

The skill tells the agent how to use REA's MCP tools (`open_binary`,
`analyze_javascript_application`, `inspect_web_network_capture`, and others). Installing
the skill does not install those tools. btrain does not install REA. An operator who
wants it registers it once per client (`claude_code`, `codex`, ...), after reading the
setup plan that the dry run prints:

```bash
npx -y rea-agents@latest setup --client claude_code --dry-run --json
```

Without REA, the skill's evidence rules (observation, inference, unknown; a question
checklist that is revisited before finishing) still apply, and `clean-room-rebuild`
covers the web-product case with Playwright and ordinary tools.

## When to use which

- `reverse-engineer-anything`: explain how a shipped artifact or a page you own behaves.
  It is a study tool. It reads decompiled and bundled code.
- `clean-room-rebuild`: build our own version of a product's behavior. Study and build
  happen in separate sessions, and only a reviewed behavior spec crosses between them.
  Use REA only on the study side of that wall.
