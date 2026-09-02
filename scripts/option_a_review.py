#!/usr/bin/env python3
"""Multi-model diff review with parallel and hybrid routing.

Supports two modes:
- parallel: 3 independent reviewers run concurrently (Option A from doc 11)
- hybrid:   parallel track always runs + sequential chain triggers when
            the diff touches sensitive files/patterns (Option D from doc 11)

Every reviewer runs through an agent CLI and uses that CLI's own login; no
provider API keys are involved. Claude-backed reviewers use the Claude Code
CLI (`claude -p`), GPT-backed reviewers use the Codex CLI (`codex exec`).

Expected environment:
- `claude` and `codex` on PATH and logged in (override with CLAUDE_BIN / CODEX_BIN)

Optional environment:
- CLAUDE_LOGIC_MODEL, CLAUDE_TYPE_MODEL, CLAUDE_SYNTHESIS_MODEL (default claude-opus-5)
- CODEX_SECURITY_MODEL (default: the Codex CLI's own configured model; a ChatGPT
  login rejects models it does not offer, e.g. gpt-5)
- REVIEW_CLI_TIMEOUT seconds per reviewer run (default 600)

Confinement: reviewer CLIs receive only the variables in CLI_ENV_ALLOWLIST;
claude runs with tools, settings sources, MCP servers, and skills disabled;
codex runs with its shell tools disabled and the user's config ignored; every
prompt has `@path` mentions neutralized before it reaches a CLI (Claude Code
would otherwise inline the file client-side). An injected diff therefore has
no route to host files or credentials, and no user/project hook, plugin, or
CLAUDE.md memory enters a reviewer's context. Regression: python3 scripts/test_option_a_review.py
(set REVIEW_LIVE_TESTS=1 to also run the real-CLI sentinel checks).

No Python dependencies beyond the standard library.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
# Per-reviewer wall-clock cap for one CLI run; a hung CLI degrades to a
# failed-reviewer finding instead of hanging `btrain review run`.
CLI_TIMEOUT_SECONDS = float(os.environ.get("REVIEW_CLI_TIMEOUT", "600"))
# The only parent-environment variables handed to a reviewer CLI. Everything
# else (provider keys, session tokens, CLAUDECODE, tool credentials) is dropped,
# so an injected diff cannot read them back. Both CLIs authenticate from their
# own config under HOME (or CODEX_HOME / CLAUDE_CONFIG_DIR when set).
CLI_ENV_ALLOWLIST = (
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
)


def reviewer_env() -> dict[str, str]:
  return {key: os.environ[key] for key in CLI_ENV_ALLOWLIST if key in os.environ}


# Claude Code expands `@path` mentions in the prompt client-side, outside the
# tool system, so an untrusted diff containing `@/etc/passwd` would inline that
# file even with --tools "". Every prompt passes through this before reaching a
# CLI: an `@` that starts a path-like token becomes a fullwidth `＠`, which no
# CLI treats as a mention. Diff hunk headers (`@@ -1 +1 @@`) are untouched
# because their `@`s are followed by `@` or a space.
MENTION_RE = re.compile(r"@(?=[\w./~\\-])")


def neutralize_mentions(text: str) -> str:
  return MENTION_RE.sub("\uff20", text)


# ──────────────────────────────────────────────
# Prompts
# ──────────────────────────────────────────────

PARALLEL_PROMPT = """You are {reviewer_name}, reviewing a git diff for {focus}.

Rules:
- Focus on bugs, security issues, regressions, and incorrect technical claims.
- Ignore formatting, naming, and subjective style unless they hide a defect.
- If you cite a file, use the path from the diff.
- Return valid JSON only.

Return exactly this shape:
{{
  "reviewer": "{reviewer_name}",
  "focus": "{focus}",
  "summary": "one short paragraph",
  "findings": [
    {{
      "severity": "P0|P1|P2|P3",
      "file": "path/to/file",
      "title": "short title",
      "body": "one paragraph explaining the issue and why it matters"
    }}
  ]
}}

If you find no issues, return an empty findings array.

Git diff:
```diff
{diff_text}
```
"""

SEQUENTIAL_PROMPT = """You are {reviewer_name}, performing a {focus} review.

You are part of a sequential review chain. The previous reviewer's findings are below.
Build on their work: confirm, refute, or escalate findings. Add new findings they missed.

Previous reviewer findings:
{prior_findings}

Rules:
- Focus on {focus}.
- Confirm whether prior findings are real or false positives.
- Add new findings the prior reviewer may have missed.
- Return valid JSON only.

Return exactly this shape:
{{
  "reviewer": "{reviewer_name}",
  "focus": "{focus}",
  "chain_position": {chain_position},
  "summary": "one short paragraph",
  "findings": [
    {{
      "severity": "P0|P1|P2|P3",
      "file": "path/to/file",
      "title": "short title",
      "body": "one paragraph explaining the issue and why it matters",
      "confirmed_from_prior": true|false
    }}
  ]
}}

Git diff:
```diff
{diff_text}
```
"""

SYNTHESIS_PROMPT = """You are the SynthesisAgent. Your job is to produce the final verdict from
the sequential review chain.

You receive findings from the SecurityReviewer and LogicReviewer. Your tasks:
1. Deduplicate findings that describe the same underlying issue.
2. Confirm severity — escalate if both reviewers flagged the same issue.
3. Produce a prioritized, actionable list.

Prior chain findings:
{prior_findings}

Return valid JSON only:
{{
  "reviewer": "SynthesisAgent",
  "focus": "final verdict from sequential chain",
  "summary": "one short paragraph with the overall assessment",
  "findings": [
    {{
      "severity": "P0|P1|P2|P3",
      "file": "path/to/file",
      "title": "short title",
      "body": "one paragraph with the synthesized finding and recommended fix",
      "sources": ["SecurityReviewer", "LogicReviewer"]
    }}
  ]
}}

Git diff:
```diff
{diff_text}
```
"""


# ──────────────────────────────────────────────
# Data structures
# ──────────────────────────────────────────────

@dataclass(frozen=True)
class Reviewer:
  name: str
  provider: str
  model: str
  focus: str
  # JSON schema for the reviewer's final answer: `claude -p --json-schema` or
  # `codex exec --output-schema`. The prompt's shape text stays as the human-
  # readable contract; extract_json() handles the returned text.
  output_schema: dict[str, Any] | None = None


@dataclass
class ClassificationResult:
  needs_sequential: bool
  triggered_paths: list[str] = field(default_factory=list)
  triggered_patterns: list[str] = field(default_factory=list)


# ──────────────────────────────────────────────
# Diff classifier (two-layer router)
# ──────────────────────────────────────────────

DEFAULT_PATH_TRIGGERS = [
  "routes", "auth", "middleware", "validation", "sanitiz",
  "engine", "scoring", "synthesizer", "orchestrator", "coach",
  "prompt", "user-store", "pocket-store", "session-store",
]

DEFAULT_CONTENT_TRIGGERS = [
  r"(req\.body|req\.query|req\.params)",
  r"(password|secret|token|api_key)",
  r"(permission|role|access|deny|allow)",
  r"(score|weight|rank|framework)",
  r"(prompt|system_message|model=)",
]


def classify_diff(
  changed_files: list[str],
  diff_text: str,
  path_triggers: list[str] | None = None,
  content_triggers: list[str] | None = None,
) -> ClassificationResult:
  """Classify a diff to determine whether the sequential chain should run."""
  path_triggers = path_triggers or DEFAULT_PATH_TRIGGERS
  content_triggers = content_triggers or DEFAULT_CONTENT_TRIGGERS

  triggered_paths = []
  for filepath in changed_files:
    lower = filepath.lower()
    for trigger in path_triggers:
      if trigger.lower() in lower:
        triggered_paths.append(f"{filepath} (matched '{trigger}')")
        break

  triggered_patterns = []
  for pattern in content_triggers:
    if re.search(pattern, diff_text):
      triggered_patterns.append(pattern)

  return ClassificationResult(
    needs_sequential=bool(triggered_paths or triggered_patterns),
    triggered_paths=triggered_paths,
    triggered_patterns=triggered_patterns,
  )


def extract_changed_files(diff_text: str) -> list[str]:
  """Extract file paths from a unified diff."""
  files = []
  for line in diff_text.splitlines():
    if line.startswith("+++ b/"):
      files.append(line[6:])
    elif line.startswith("--- a/"):
      files.append(line[6:])
  return sorted(set(files))


# ──────────────────────────────────────────────
# Output schemas (mirror the shapes in the prompts above)
# ──────────────────────────────────────────────

_FINDING_BASE_PROPS: dict[str, Any] = {
  "severity": {"type": "string", "enum": ["P0", "P1", "P2", "P3"]},
  "file": {"type": "string"},
  "title": {"type": "string"},
  "body": {"type": "string"},
}


def _review_schema(
  top_extra: dict[str, Any] | None = None,
  finding_extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
  finding_props = {**_FINDING_BASE_PROPS, **(finding_extra or {})}
  top_props: dict[str, Any] = {
    "reviewer": {"type": "string"},
    "focus": {"type": "string"},
    **(top_extra or {}),
    "summary": {"type": "string"},
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": finding_props,
        "required": list(finding_props),
        "additionalProperties": False,
      },
    },
  }
  return {
    "type": "object",
    "properties": top_props,
    "required": list(top_props),
    "additionalProperties": False,
  }


PARALLEL_SCHEMA = _review_schema()
SEQUENTIAL_SCHEMA = _review_schema(
  top_extra={"chain_position": {"type": "integer"}},
  finding_extra={"confirmed_from_prior": {"type": "boolean"}},
)
SYNTHESIS_SCHEMA = _review_schema(
  finding_extra={"sources": {"type": "array", "items": {"type": "string"}}},
)


# ──────────────────────────────────────────────
# Reviewer setup
# ──────────────────────────────────────────────

def build_parallel_reviewers() -> list[Reviewer]:
  return [
    Reviewer(
      name="LogicReviewer",
      provider="claude-code",
      model=os.environ.get("CLAUDE_LOGIC_MODEL", "claude-opus-5"),
      focus="logic correctness, behavioral regressions, product reasoning",
      output_schema=PARALLEL_SCHEMA,
    ),
    Reviewer(
      name="SecurityReviewer",
      provider="codex-cli",
      model=os.environ.get("CODEX_SECURITY_MODEL", ""),  # "" -> CLI default
      focus="security, auth, input validation, injection, and unsafe defaults",
      output_schema=PARALLEL_SCHEMA,
    ),
    Reviewer(
      name="TypeReviewer",
      provider="claude-code",
      model=os.environ.get("CLAUDE_TYPE_MODEL", "claude-opus-5"),
      focus="type mismatches, schema drift, and runtime/compile-time inconsistencies",
      output_schema=PARALLEL_SCHEMA,
    ),
  ]


def build_sequential_reviewers() -> list[Reviewer]:
  return [
    Reviewer(
      name="SecurityReviewer-Seq",
      provider="codex-cli",
      model=os.environ.get("CODEX_SECURITY_MODEL", ""),  # "" -> CLI default
      focus="deep security analysis: input validation, auth bypass, injection, OWASP top 10",
      output_schema=SEQUENTIAL_SCHEMA,
    ),
    Reviewer(
      name="LogicReviewer-Seq",
      provider="claude-code",
      model=os.environ.get("CLAUDE_LOGIC_MODEL", "claude-opus-5"),
      focus="business logic correctness, state bugs, reachability of security findings",
      output_schema=SEQUENTIAL_SCHEMA,
    ),
  ]


def build_synthesis_reviewer() -> Reviewer:
  return Reviewer(
    name="SynthesisAgent",
    provider="claude-code",
    model=os.environ.get("CLAUDE_SYNTHESIS_MODEL", "claude-opus-5"),
    focus="final verdict: deduplicate, prioritize, and synthesize findings",
    output_schema=SYNTHESIS_SCHEMA,
  )


# ──────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Run multi-model diff review.")
  parser.add_argument("--base", default="HEAD~1", help="Base git ref for the diff.")
  parser.add_argument("--head", default="HEAD", help="Head git ref for the diff.")
  parser.add_argument(
    "--output",
    default="review-report.md",
    help="Markdown file to write the merged report to.",
  )
  parser.add_argument(
    "--repo",
    default=".",
    help="Repository root to diff. Defaults to the current directory.",
  )
  parser.add_argument(
    "--file",
    action="append",
    default=[],
    help="Limit the diff to this path. Repeat for multiple lane-locked paths.",
  )
  parser.add_argument(
    "--mode",
    default="parallel",
    choices=["parallel", "hybrid"],
    help="Review mode: 'parallel' (default) or 'hybrid' (parallel + conditional sequential).",
  )
  parser.add_argument(
    "--path-triggers",
    default=None,
    help="Comma-separated path trigger keywords for hybrid mode.",
  )
  parser.add_argument(
    "--content-triggers",
    default=None,
    help="Comma-separated content trigger regexes for hybrid mode.",
  )
  return parser.parse_args()


# ──────────────────────────────────────────────
# Git helpers
# ──────────────────────────────────────────────

def get_diff(repo_root: str, base: str, head: str, files: list[str] | None = None) -> str:
  command = ["git", "-C", repo_root, "diff", "--unified=0", f"{base}...{head}"]
  if files:
    command.extend(["--", *files])
  result = subprocess.run(
    command,
    check=True,
    capture_output=True,
    text=True,
  )
  if not result.stdout.strip():
    raise SystemExit("No diff found for the requested revision range.")
  return result.stdout


# ──────────────────────────────────────────────
# JSON extraction and normalization
# ──────────────────────────────────────────────

def extract_json(text: str) -> dict[str, Any]:
  match = re.search(r"```json\s*(\{.*\})\s*```", text, re.DOTALL)
  candidate = match.group(1) if match else text.strip()
  return json.loads(candidate)


def normalize_result(
  reviewer: Reviewer,
  raw_text: str | None = None,
  error: str | None = None,
) -> dict[str, Any]:
  if error:
    return {
      "reviewer": reviewer.name,
      "focus": reviewer.focus,
      "summary": f"{reviewer.name} failed before returning a review.",
      "findings": [
        {
          "severity": "P1",
          "file": "(review infrastructure)",
          "title": "Reviewer request failed",
          "body": error,
        }
      ],
    }

  if raw_text is None:
    return {
      "reviewer": reviewer.name,
      "focus": reviewer.focus,
      "summary": f"{reviewer.name} returned no output.",
      "findings": [],
    }

  try:
    parsed = extract_json(raw_text)
    parsed.setdefault("reviewer", reviewer.name)
    parsed.setdefault("focus", reviewer.focus)
    parsed.setdefault("summary", "")
    parsed.setdefault("findings", [])
    return parsed
  except Exception as exc:
    return {
      "reviewer": reviewer.name,
      "focus": reviewer.focus,
      "summary": f"{reviewer.name} returned non-JSON output.",
      "findings": [
        {
          "severity": "P2",
          "file": "(review infrastructure)",
          "title": "Reviewer output could not be parsed",
          "body": f"{exc}: {raw_text[:1200]}",
        }
      ],
    }


# ──────────────────────────────────────────────
# API calls
# ──────────────────────────────────────────────

async def run_cli(args: list[str], stdin_text: str, cwd: str) -> tuple[int, str, str]:
  """Run an agent CLI with the prompt on stdin; returns (exit code, stdout, stderr).

  `cwd` should be a per-call scratch directory (holding at most the schema and
  output files the caller writes) so project-level agent config (CLAUDE.md,
  AGENTS.md, hooks, rules) does not load into the reviewer's context. The
  environment is reduced to CLI_ENV_ALLOWLIST. Auth is whatever each CLI
  resolves from its own config (its login by default).
  """
  env = reviewer_env()
  proc = await asyncio.create_subprocess_exec(
    *args,
    stdin=asyncio.subprocess.PIPE,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE,
    cwd=cwd,
    env=env,
  )
  try:
    stdout, stderr = await asyncio.wait_for(
      proc.communicate(stdin_text.encode("utf-8")), timeout=CLI_TIMEOUT_SECONDS
    )
  except asyncio.TimeoutError:
    proc.kill()
    await proc.wait()
    raise TimeoutError(f"{args[0]} exceeded {CLI_TIMEOUT_SECONDS:g}s") from None
  return proc.returncode, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


def _cli_failure(reviewer: Reviewer, label: str, code: int, stdout: str, stderr: str) -> dict[str, Any]:
  # Prefer explicit error lines: codex echoes the prompt to stdout, so a raw
  # tail would show the diff instead of the cause.
  error_lines = [
    line.strip() for line in (stderr + "\n" + stdout).splitlines()
    if "ERROR" in line or "error:" in line.lower()
  ]
  detail = "\n".join(dict.fromkeys(error_lines)) if error_lines else (stderr or stdout).strip()
  return normalize_result(reviewer, error=f"{label} exited {code}: {detail[-1200:]}")


async def call_claude_code(reviewer: Reviewer, prompt: str) -> dict[str, Any]:
  # Confinement: no tools, no settings from any source (so no user/project/local
  # hooks, plugins, or CLAUDE.md memory), no MCP servers, no skills. Login still
  # resolves from the CLI's own config dir. Verified by
  # scripts/test_option_a_review.py (sentinel + hostile-config tests).
  args = [
    CLAUDE_BIN, "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--model", reviewer.model,
  ]
  if reviewer.output_schema is not None:
    args.extend(["--json-schema", json.dumps(reviewer.output_schema)])
  try:
    with tempfile.TemporaryDirectory() as workdir:
      code, stdout, stderr = await run_cli(args, prompt, workdir)
    if code != 0:
      return _cli_failure(reviewer, "claude -p", code, stdout, stderr)
    # --output-format json envelope: structured_output holds the schema-validated
    # object; result holds the plain text; is_error flags a failed run.
    envelope = json.loads(stdout)
    if envelope.get("is_error"):
      detail = str(envelope.get("result", "claude -p reported an error"))[:1200]
      return normalize_result(reviewer, error=detail)
    structured = envelope.get("structured_output")
    if isinstance(structured, dict):
      return normalize_result(reviewer, raw_text=json.dumps(structured))
    return normalize_result(reviewer, raw_text=envelope.get("result"))
  except Exception as exc:
    return normalize_result(reviewer, error=str(exc))


async def call_codex(reviewer: Reviewer, prompt: str) -> dict[str, Any]:
  try:
    with tempfile.TemporaryDirectory() as workdir:
      last_message = Path(workdir) / "last-message.json"
      # Confinement: the reviewer must have no route from the prompt (an untrusted
      # diff) to the host. --ignore-user-config drops the user's MCP servers and
      # sandbox settings; disabling shell_tool and unified_exec removes the shell,
      # which a read-only sandbox alone does not (it can still read any file).
      # Verified by scripts/test_option_a_review.py (sentinel exfiltration test).
      args = [
        CODEX_BIN, "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--sandbox", "read-only",
        "--disable", "shell_tool",
        "--disable", "unified_exec",
        "--color", "never",
        "--cd", workdir,
        "--output-last-message", str(last_message),
      ]
      if reviewer.model:
        args.extend(["--model", reviewer.model])
      if reviewer.output_schema is not None:
        schema_path = Path(workdir) / "schema.json"
        schema_path.write_text(json.dumps(reviewer.output_schema), encoding="utf-8")
        args.extend(["--output-schema", str(schema_path)])
      args.append("-")  # prompt on stdin
      code, stdout, stderr = await run_cli(args, prompt, workdir)
      if code != 0:
        return _cli_failure(reviewer, "codex exec", code, stdout, stderr)
      if not last_message.exists():
        return normalize_result(reviewer, error="codex exec finished without a final message")
      # --output-last-message holds the final answer, constrained by --output-schema.
      return normalize_result(reviewer, raw_text=last_message.read_text(encoding="utf-8"))
  except Exception as exc:
    return normalize_result(reviewer, error=str(exc))


async def call_reviewer(reviewer: Reviewer, prompt: str) -> dict[str, Any]:
  prompt = neutralize_mentions(prompt)
  if reviewer.provider == "claude-code":
    return await call_claude_code(reviewer, prompt)
  elif reviewer.provider == "codex-cli":
    return await call_codex(reviewer, prompt)
  else:
    raise ValueError(f"Unsupported provider: {reviewer.provider}")


# ──────────────────────────────────────────────
# Parallel track
# ──────────────────────────────────────────────

async def run_parallel(
  reviewers: list[Reviewer],
  diff_text: str,
) -> list[dict[str, Any]]:
  coroutines = []
  for reviewer in reviewers:
    prompt = PARALLEL_PROMPT.format(
      reviewer_name=reviewer.name,
      focus=reviewer.focus,
      diff_text=diff_text,
    )
    coroutines.append(call_reviewer(reviewer, prompt))

  if hasattr(asyncio, "TaskGroup"):
    tasks: list[asyncio.Task[dict[str, Any]]] = []
    async with asyncio.TaskGroup() as tg:
      for coroutine in coroutines:
        tasks.append(tg.create_task(coroutine))
    return [task.result() for task in tasks]

  return await asyncio.gather(*coroutines)


# ──────────────────────────────────────────────
# Sequential track
# ──────────────────────────────────────────────

async def run_sequential(
  reviewers: list[Reviewer],
  synthesis_reviewer: Reviewer,
  diff_text: str,
) -> list[dict[str, Any]]:
  """Run the sequential chain: each reviewer builds on the prior one's findings."""
  results = []
  prior_findings_text = "(No prior findings — you are the first reviewer in the chain.)"

  for position, reviewer in enumerate(reviewers, start=1):
    prompt = SEQUENTIAL_PROMPT.format(
      reviewer_name=reviewer.name,
      focus=reviewer.focus,
      prior_findings=prior_findings_text,
      chain_position=position,
      diff_text=diff_text,
    )
    result = await call_reviewer(reviewer, prompt)
    result["chain_position"] = position
    result["track"] = "sequential"
    results.append(result)

    # Format this reviewer's findings as context for the next
    prior_findings_text = json.dumps(result.get("findings", []), indent=2)

  # Synthesis step
  synthesis_prompt = SYNTHESIS_PROMPT.format(
    prior_findings=prior_findings_text,
    diff_text=diff_text,
  )
  synthesis_result = await call_reviewer(synthesis_reviewer, synthesis_prompt)
  synthesis_result["track"] = "sequential"
  synthesis_result["chain_position"] = len(reviewers) + 1
  results.append(synthesis_result)

  return results


# ──────────────────────────────────────────────
# Report rendering
# ──────────────────────────────────────────────

def render_markdown(
  parallel_results: list[dict[str, Any]],
  sequential_results: list[dict[str, Any]] | None = None,
  classification: ClassificationResult | None = None,
) -> str:
  lines = [
    "# Multi-Model Review Report",
    "",
  ]

  if classification and sequential_results:
    lines.extend([
      "## Review Mode: Hybrid",
      "",
      "Sequential chain was **triggered** by:",
      "",
    ])
    for tp in classification.triggered_paths:
      lines.append(f"- Path: `{tp}`")
    for tp in classification.triggered_patterns:
      lines.append(f"- Content: `{tp}`")
    lines.append("")
  elif classification and not classification.needs_sequential:
    lines.extend([
      "## Review Mode: Hybrid (parallel only)",
      "",
      "Sequential chain was **not triggered** — no sensitive paths or patterns detected.",
      "",
    ])

  # Parallel track
  lines.extend(["## Parallel Track", ""])
  for result in parallel_results:
    lines.extend([
      f"### {result['reviewer']}",
      "",
      f"Focus: {result['focus']}",
      "",
      result.get("summary", "").strip() or "No summary provided.",
      "",
    ])
    findings = result.get("findings", [])
    if not findings:
      lines.extend(["- No findings.", ""])
      continue
    for finding in findings:
      lines.append(
        f"- [{finding.get('severity', 'P2')}] `{finding.get('file', '(unknown)')}`: "
        f"{finding.get('title', 'Untitled')} — {finding.get('body', '').strip()}"
      )
    lines.append("")

  # Sequential track
  if sequential_results:
    lines.extend(["## Sequential Track", ""])
    for result in sequential_results:
      lines.extend([
        f"### {result['reviewer']} (chain position {result.get('chain_position', '?')})",
        "",
        f"Focus: {result['focus']}",
        "",
        result.get("summary", "").strip() or "No summary provided.",
        "",
      ])
      findings = result.get("findings", [])
      if not findings:
        lines.extend(["- No findings.", ""])
        continue
      for finding in findings:
        confirmed = " ✅ confirmed" if finding.get("confirmed_from_prior") else ""
        sources = finding.get("sources", [])
        source_tag = f" (via {', '.join(sources)})" if sources else ""
        lines.append(
          f"- [{finding.get('severity', 'P2')}] `{finding.get('file', '(unknown)')}`: "
          f"{finding.get('title', 'Untitled')}{confirmed}{source_tag} — "
          f"{finding.get('body', '').strip()}"
        )
      lines.append("")

  return "\n".join(lines).strip() + "\n"


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

async def main() -> None:
  args = parse_args()
  diff_text = get_diff(args.repo, args.base, args.head, args.file)

  path_triggers = args.path_triggers.split(",") if args.path_triggers else None
  content_triggers = args.content_triggers.split(",") if args.content_triggers else None

  # A missing CLI degrades its reviewers to "Reviewer request failed" findings
  # (create_subprocess_exec raises inside call_*); abort only when neither CLI
  # exists, since then no reviewer could run at all.
  missing = [name for name in (CLAUDE_BIN, CODEX_BIN) if shutil.which(name) is None]
  if len(missing) == 2:
    raise SystemExit(
      f"No agent CLI found ({', '.join(missing)}). Install and log in, or set CLAUDE_BIN / CODEX_BIN."
    )
  for name in missing:
    print(f"Agent CLI not found: {name}. Its reviewers will be reported as failed.", file=sys.stderr)

  # Parallel track always runs
  parallel_results = await run_parallel(build_parallel_reviewers(), diff_text)

  sequential_results = None
  classification = None

  if args.mode == "hybrid":
    changed_files = extract_changed_files(diff_text)
    classification = classify_diff(changed_files, diff_text, path_triggers, content_triggers)

    if classification.needs_sequential:
      print(
        f"Sequential chain triggered: "
        f"{len(classification.triggered_paths)} path matches, "
        f"{len(classification.triggered_patterns)} content matches"
      )
      sequential_results = await run_sequential(
        build_sequential_reviewers(),
        build_synthesis_reviewer(),
        diff_text,
      )
    else:
      print("Hybrid mode: no sequential triggers matched. Parallel-only report.")

  output_path = Path(args.output)
  report = render_markdown(parallel_results, sequential_results, classification)
  output_path.write_text(report, encoding="utf-8")
  print(f"Wrote review report to {output_path}")


if __name__ == "__main__":
  asyncio.run(main())
