# Vendored skill

This directory vendors the `reverse-engineer-anything` skill from
[morluto/rea](https://github.com/morluto/rea), path
`.agents/skills/reverse-engineer-anything/`, commit
`c9aecde580d26d4e7745c2623a4efa327a27367e` (2026-10-12). It is MIT licensed; the
upstream notice is in `LICENSE` next to this file and must stay with every copy.

## What is upstream and what is btrain's

- Verbatim upstream, pinned by git blob hash in
  `test/reverse-engineering-skills.test.mjs`: `LICENSE`,
  `references/upstream-SKILL.md` (upstream's `SKILL.md`, moved so its links stay
  relative to this skill's root), and the six guides
  `references/android-applications.md`, `references/connection-and-recovery.md`,
  `references/evidence-workflows.md`, `references/javascript-applications.md`,
  `references/native-and-artifacts.md`, `references/runtime-observation.md`.
- btrain-owned: `SKILL.md` and this file. `SKILL.md` is the frontmatter the harness
  reads when it picks a skill. It excludes rebuilds and reimplementations (those go
  to `clean-room-rebuild`, which runs a legal gate first), states that the skill is
  for software you are authorized to analyze, and then defers to the upstream text.
  Upstream's own description triggers on "guide a reconstruction" and its close-out
  says to build with normal coding tools, which would let "reverse engineer X and
  rebuild it" skip the gate.

Do not edit the verbatim files. To update, copy the upstream files at a new commit
into `references/` (upstream `SKILL.md` becomes `references/upstream-SKILL.md`) on
both `.claude/skills/` and `.agents/skills/`, refresh the blob hashes in the test,
and update the commit above. Re-read the new upstream description and close-out
and keep btrain's `SKILL.md` exclusion current with them.

## What this skill needs

The skill tells the agent how to use REA's MCP tools (`open_binary`,
`analyze_javascript_application`, `inspect_web_network_capture`, and others).
Installing the skill does not install those tools. btrain does not install REA.

An operator, not an agent, registers it once per client (`claude_code`, `codex`,
...), after reading the setup plan that the dry run prints. Pin the npm version;
`npx -y` with the `@latest` tag runs whatever npm serves at that moment, so the
commit pin above would say nothing about what ran:

```bash
npx -y rea-agents@6.4.0 setup --client claude_code --dry-run --json
```

`6.4.0` is the newest npm release as of the pinned commit (upstream `package.json`
at `c9aecde` still reads `6.4.0`, and the release tag `rea-agents-6.4.0` is
`a56f7bb`, 284 commits earlier). No npm release corresponds to `c9aecde` exactly:
the release's bundled skill text differs from the vendored text in `SKILL.md` and
four of the six guides. The vendored text is what btrain's agents follow; the
release only supplies the MCP server. When upstream publishes a release that
contains `c9aecde`, move the pin to it.

**`rea setup` installs a second, ungated copy of this skill.** `rea setup --client
claude_code` does not touch the repo: upstream `docs/installation.md` at `c9aecde`
("Skill destinations") installs the bundled skill to the personal directory
`~/.claude/skills/reverse-engineer-anything/` (or `$CLAUDE_CONFIG_DIR/skills/`) and
leaves other copies untouched, so the two repo surfaces stay in sync and the blob-pin
test still passes. The problem is the personal copy itself: it carries the 6.4.0
release's upstream `SKILL.md`, whose description triggers on "guide a reconstruction"
and whose close-out says to build with normal coding tools, under the same skill name
as this project copy. The harness may list both or prefer the personal one, which
reopens the rebuild path that btrain's `SKILL.md` closes. After setup, remove the
personal copy, or run setup without the skill:

```bash
rm -r ~/.claude/skills/reverse-engineer-anything      # or $CLAUDE_CONFIG_DIR/skills/...
npx -y rea-agents@6.4.0 setup --client claude_code --skill=false
```

The MCP registration is unaffected either way; only the project copy should supply
the instructions.

Without REA, the skill's evidence rules (observation, inference, unknown; a question
checklist that is revisited before finishing) still apply, and `clean-room-rebuild`
covers the web-product case with Playwright and ordinary tools.

## When to use which

- `reverse-engineer-anything`: explain how a shipped artifact or a page you own behaves.
  It is a study tool. It reads decompiled and bundled code.
- `clean-room-rebuild`: build our own version of a product's behavior. Study and build
  happen in separate sessions, and only a reviewed behavior spec crosses between them.
  Use REA only on the study side of that wall.
