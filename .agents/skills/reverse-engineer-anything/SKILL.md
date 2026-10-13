---
name: reverse-engineer-anything
description: "Study how a shipped binary, package, Electron or JavaScript bundle, APK, firmware image, or page you own behaves, using REA's evidence-first method (observation, inference, unknown) to explain a feature, compare versions, or decompile code. Only for software you are authorized to analyze. Not for rebuilding, reimplementing, cloning, or replicating what you studied, and not when the request includes building our own version: use clean-room-rebuild for those, which runs a legal gate first. Skip for ordinary source-repository architecture analysis."
metadata:
  version: "40"
  upstream: morluto/rea c9aecde580d26d4e7745c2623a4efa327a27367e
---

# Reverse engineer anything (study only)

This skill is for study of software you are authorized to analyze: your own
builds, software whose license or terms permit analysis, or a target where a
human has confirmed the authorization in writing. It explains what an artifact
does and ties every claim to evidence. It does not build anything.

**Not for rebuilds.** If the request asks to rebuild, reimplement, clone,
replicate, or "make our own version of" what you are studying, stop and use
`clean-room-rebuild` instead, even if the request also asks to reverse engineer.
That skill runs a legal gate before any observation and keeps study and build in
separate sessions. REA is used only on its study side, and nothing you read
here (decompiled code, bundled JavaScript, extracted strings) may cross into a
build session.

Before you start, confirm the user is authorized to analyze the target. If the
target's terms of service or license forbid reverse engineering, or the study
would require bypassing auth, rate limits, bot detection, DRM, or a license
check, stop and say so.

## Method

Follow the pinned upstream text in [references/upstream-SKILL.md](references/upstream-SKILL.md).
It is vendored verbatim from morluto/rea, so its `references/...` links are
relative to this skill's root, not to `references/`. Where the upstream text
says to build with normal coding tools when the user asks to build something,
this btrain copy overrides it: hand the request to `clean-room-rebuild`.

The REA MCP tools the upstream text names (`open_binary`,
`analyze_javascript_application`, `inspect_web_network_capture`, and others)
are not installed by btrain; `VENDORED.md` says how an operator registers them.
Without them, the evidence rules still apply.
