#!/usr/bin/env python3
"""Multi-model diff review with parallel and hybrid routing.

Supports two modes:
- parallel: 3 independent reviewers run concurrently (Option A from doc 11)
- hybrid:   parallel track always runs + sequential chain triggers when
            the diff touches sensitive files/patterns (Option D from doc 11)

Expected environment:
- ANTHROPIC_API_KEY
- OPENAI_API_KEY

Optional environment:
- CLAUDE_LOGIC_MODEL
- OPENAI_SECURITY_MODEL
- CLAUDE_TYPE_MODEL
- CLAUDE_SYNTHESIS_MODEL

Install before running:
    pip install anthropic openai
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI


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
# Reviewer setup
# ──────────────────────────────────────────────

def build_parallel_reviewers() -> list[Reviewer]:
  return [
    Reviewer(
      name="LogicReviewer",
      provider="anthropic",
      model=os.environ.get("CLAUDE_LOGIC_MODEL", "claude-opus-4-1"),
      focus="logic correctness, behavioral regressions, product reasoning",
    ),
    Reviewer(
      name="SecurityReviewer",
      provider="openai",
      model=os.environ.get("OPENAI_SECURITY_MODEL", "gpt-5"),
      focus="security, auth, input validation, injection, and unsafe defaults",
    ),
    Reviewer(
      name="TypeReviewer",
      provider="anthropic",
      model=os.environ.get("CLAUDE_TYPE_MODEL", "claude-sonnet-4-5-20250929"),
      focus="type mismatches, schema drift, and runtime/compile-time inconsistencies",
    ),
  ]


def build_sequential_reviewers() -> list[Reviewer]:
  return [
    Reviewer(
      name="SecurityReviewer-Seq",
      provider="openai",
      model=os.environ.get("OPENAI_SECURITY_MODEL", "gpt-5"),
      focus="deep security analysis: input validation, auth bypass, injection, OWASP top 10",
    ),
    Reviewer(
      name="LogicReviewer-Seq",
      provider="anthropic",
      model=os.environ.get("CLAUDE_LOGIC_MODEL", "claude-opus-4-1"),
      focus="business logic correctness, state bugs, reachability of security findings",
    ),
  ]


def build_synthesis_reviewer() -> Reviewer:
  return Reviewer(
    name="SynthesisAgent",
    provider="anthropic",
    model=os.environ.get("CLAUDE_SYNTHESIS_MODEL", "claude-opus-4-1"),
    focus="final verdict: deduplicate, prioritize, and synthesize findings",
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

def get_diff(repo_root: str, base: str, head: str) -> str:
  result = subprocess.run(
    ["git", "-C", repo_root, "diff", "--unified=0", f"{base}...{head}"],
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

async def call_anthropic(
  client: AsyncAnthropic,
  reviewer: Reviewer,
  prompt: str,
) -> dict[str, Any]:
  try:
    message = await client.messages.create(
      model=reviewer.model,
      max_tokens=2400,
      messages=[{"role": "user", "content": prompt}],
    )
    raw_text = "\n".join(
      block.text for block in message.content if getattr(block, "type", None) == "text"
    ).strip()
    return normalize_result(reviewer, raw_text=raw_text)
  except Exception as exc:
    return normalize_result(reviewer, error=str(exc))


async def call_openai(
  client: AsyncOpenAI,
  reviewer: Reviewer,
  prompt: str,
) -> dict[str, Any]:
  try:
    response = await client.responses.create(
      model=reviewer.model,
      input=prompt,
    )
    return normalize_result(reviewer, raw_text=response.output_text)
  except Exception as exc:
    return normalize_result(reviewer, error=str(exc))


async def call_reviewer(
  anthropic_client: AsyncAnthropic,
  openai_client: AsyncOpenAI,
  reviewer: Reviewer,
  prompt: str,
) -> dict[str, Any]:
  if reviewer.provider == "anthropic":
    return await call_anthropic(anthropic_client, reviewer, prompt)
  elif reviewer.provider == "openai":
    return await call_openai(openai_client, reviewer, prompt)
  else:
    raise ValueError(f"Unsupported provider: {reviewer.provider}")


# ──────────────────────────────────────────────
# Parallel track
# ──────────────────────────────────────────────

async def run_parallel(
  anthropic_client: AsyncAnthropic,
  openai_client: AsyncOpenAI,
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
    coroutines.append(call_reviewer(anthropic_client, openai_client, reviewer, prompt))

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
  anthropic_client: AsyncAnthropic,
  openai_client: AsyncOpenAI,
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
    result = await call_reviewer(anthropic_client, openai_client, reviewer, prompt)
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
  synthesis_result = await call_reviewer(
    anthropic_client, openai_client, synthesis_reviewer, synthesis_prompt
  )
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
  diff_text = get_diff(args.repo, args.base, args.head)

  path_triggers = args.path_triggers.split(",") if args.path_triggers else None
  content_triggers = args.content_triggers.split(",") if args.content_triggers else None

  anthropic_client = AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
  openai_client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

  async with anthropic_client, openai_client:
    # Parallel track always runs
    parallel_results = await run_parallel(
      anthropic_client, openai_client, build_parallel_reviewers(), diff_text
    )

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
          anthropic_client,
          openai_client,
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
