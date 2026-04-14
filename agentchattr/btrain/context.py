"""Helpers for btrain lane context selection and formatting."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path

_ACTIVE_OWNER_STATUSES = {"in-progress", "changes-requested", "repair-needed"}
_LANE_HEADER_RE = re.compile(r"^--- lane (\S+) ---$")
_KV_RE = re.compile(r"^([a-z][a-z ]+):\s*(.*)$", re.IGNORECASE)


def resolve_repo_root(cwd: str, root: Path) -> str | None:
    """Resolve agent cwd to an absolute repo root path."""
    try:
        path = Path(cwd)
        resolved = path.resolve() if path.is_absolute() else (root / cwd).resolve()
        if resolved.is_dir():
            return str(resolved)
    except Exception:
        pass
    return None


def fetch_btrain_context(
    server_port: int,
    agent_name: str,
    repo_root: str,
    timeout: float = 3.0,
    *,
    run=subprocess.run,
    which=shutil.which,
) -> str:
    """Fetch formatted lane context for this agent via REST API with CLI fallback."""
    try:
        url = f"http://127.0.0.1:{server_port}/api/btrain/lanes"
        with urllib.request.urlopen(url, timeout=2) as response:
            lane_data = json.loads(response.read())
        return _select_lane_context(
            lane_data.get("lanes", []),
            agent_name,
            owner_key="owner",
            reviewer_key="reviewer",
            formatter=format_lane_context_from_json,
        )
    except Exception:
        pass

    btrain_bin = which("btrain")
    if not btrain_bin:
        return ""

    try:
        result = run(
            [btrain_bin, "handoff", "--repo", repo_root],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""

    if result.returncode != 0:
        return ""

    return parse_btrain_output(result.stdout, agent_name)


def parse_btrain_output(output: str, agent_name: str) -> str:
    """Parse btrain handoff output and return formatted context for agent_name's lane."""
    return _select_lane_context(
        split_lane_blocks(output),
        agent_name,
        owner_key="active agent",
        reviewer_key="peer reviewer",
        formatter=format_lane_context,
    )


def split_lane_blocks(output: str) -> list[dict]:
    """Split btrain handoff output into per-lane key-value blocks."""
    lines = output.splitlines()
    blocks: list[dict] = []
    current: dict | None = None

    for line in lines:
        header_match = _LANE_HEADER_RE.match(line.strip())
        if header_match:
            if current is not None:
                blocks.append(current)
            current = {"_lane_id": header_match.group(1)}
            continue

        if current is None:
            continue

        kv_match = _KV_RE.match(line.strip())
        if kv_match:
            key = kv_match.group(1).strip().lower()
            current[key] = kv_match.group(2).strip()

    if current is not None:
        blocks.append(current)

    return blocks


def format_lane_context_from_json(lane: dict, role: str = "writer") -> str:
    """Format a compact btrain lane context block from JSON state."""
    return _render_lane_context(
        lane_id=lane.get("_laneId", "?"),
        task=lane.get("task", "(none)"),
        status=lane.get("status", "unknown"),
        owner=lane.get("owner", "(unassigned)"),
        reviewer=lane.get("reviewer", "(unassigned)"),
        locked=", ".join(lane.get("lockedFiles", [])) or "(none)",
        role=role,
    )


def format_lane_context(lane: dict, role: str = "writer") -> str:
    """Format a compact btrain lane context block parsed from CLI text."""
    return _render_lane_context(
        lane_id=lane.get("_lane_id", "?"),
        task=lane.get("task", "(none)"),
        status=lane.get("status", "unknown"),
        owner=lane.get("active agent", "(unassigned)"),
        reviewer=lane.get("peer reviewer", "(unassigned)"),
        locked=lane.get("locked files", "(none)"),
        role=role,
    )


def _select_lane_context(
    lanes: list[dict],
    agent_name: str,
    *,
    owner_key: str,
    reviewer_key: str,
    formatter,
) -> str:
    if not lanes:
        return ""

    agent_lower = agent_name.lower()

    for lane in lanes:
        if lane.get(owner_key, "").lower() == agent_lower and lane.get("status", "") in _ACTIVE_OWNER_STATUSES:
            return formatter(lane, "writer")

    for lane in lanes:
        if lane.get(reviewer_key, "").lower() == agent_lower and lane.get("status", "") == "needs-review":
            return formatter(lane, "reviewer")

    for lane in lanes:
        if lane.get(owner_key, "").lower() == agent_lower and lane.get("status", "") == "needs-review":
            return formatter(lane, "writer-waiting")

    return ""


def _render_lane_context(
    *,
    lane_id: str,
    task: str,
    status: str,
    owner: str,
    reviewer: str,
    locked: str,
    role: str,
) -> str:
    parts = [
        f"LANE {lane_id}: {status} | {task}",
        f"W={owner} R={reviewer} lock={locked}",
        _build_role_note(role, lane_id, owner, reviewer),
    ]
    return " ".join(parts)


def _build_role_note(role: str, lane_id: str, owner: str, reviewer: str) -> str:
    if role == "reviewer":
        return f"Reviewer. btrain handoff resolve --lane {lane_id} --summary '...' --actor '{reviewer}'"
    if role == "writer-waiting":
        return f"Waiting on {reviewer} to review."
    return f"Writer. When done: btrain handoff update --lane {lane_id} --status needs-review --actor '{owner}'"
