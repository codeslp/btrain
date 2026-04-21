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
        lanes, agent_cards = _extract_rest_lane_payload(lane_data, repo_root)
        return _select_lane_context(
            lanes,
            agent_name,
            owner_key="owner",
            reviewer_key="reviewer",
            formatter=format_lane_context_from_json,
            agent_cards=agent_cards,
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


def format_lane_context_from_json(
    lane: dict, role: str = "writer", *, agent_card: dict | None = None
) -> str:
    """Format a compact btrain lane context block from JSON state."""
    return _render_lane_context(
        lane_id=lane.get("_laneId", "?"),
        task=lane.get("task", "(none)"),
        status=lane.get("status", "unknown"),
        owner=lane.get("owner", "(unassigned)"),
        reviewer=lane.get("reviewer", "(unassigned)"),
        locked=", ".join(lane.get("lockedFiles", [])) or "(none)",
        role=role,
        card_summary=format_agent_card_summary(agent_card),
    )


def format_lane_context(
    lane: dict, role: str = "writer", *, agent_card: dict | None = None
) -> str:
    """Format a compact btrain lane context block parsed from CLI text."""
    return _render_lane_context(
        lane_id=lane.get("_lane_id", "?"),
        task=lane.get("task", "(none)"),
        status=lane.get("status", "unknown"),
        owner=lane.get("active agent", "(unassigned)"),
        reviewer=lane.get("peer reviewer", "(unassigned)"),
        locked=lane.get("locked files", "(none)"),
        role=role,
        card_summary=format_agent_card_summary(agent_card),
    )


def format_agent_card_summary(card: dict | None) -> str:
    """Return a compact one-line Agent Card summary, or '' when nothing useful is set.

    Read-only renderer: empty fields are skipped so an unset card contributes
    nothing to lane context and nothing to callers that inject it elsewhere.
    """
    if not card:
        return ""
    parts: list[str] = []
    runner = card.get("runner") or ""
    role = card.get("role") or ""
    lane_affinity = card.get("lane_affinity") or ""
    readiness = card.get("readiness") or ""
    caps = _normalize_capability_list(card.get("capabilities"))
    if runner:
        parts.append(f"runner={runner}")
    if role:
        parts.append(f"role={role}")
    if lane_affinity:
        parts.append(f"lane={lane_affinity}")
    if caps:
        parts.append("caps=" + ",".join(caps))
    if readiness:
        parts.append(f"readiness={readiness}")
    if not parts:
        return ""
    return "CARD " + " ".join(parts)


def _normalize_capability_list(value) -> list[str]:
    """Normalize capability input for display.

    A scalar string like ``"review"`` must stay a single capability, not be
    iterated into one-character tokens. Falsy or non-iterable values render
    as an empty list.
    """
    if value is None or value == "":
        return []
    if isinstance(value, (str, bytes)):
        text = value.decode() if isinstance(value, bytes) else value
        return [text] if text else []
    if isinstance(value, (list, tuple, set, frozenset)):
        return [str(c) for c in value if str(c)]
    return [str(value)]


def _select_lane_context(
    lanes: list[dict],
    agent_name: str,
    *,
    owner_key: str,
    reviewer_key: str,
    formatter,
    agent_cards: dict[str, dict] | None = None,
) -> str:
    if not lanes:
        return ""

    agent_lower = agent_name.lower()
    agent_card = _resolve_agent_card(agent_cards, agent_name)

    for lane in lanes:
        if lane.get(owner_key, "").lower() == agent_lower and lane.get("status", "") in _ACTIVE_OWNER_STATUSES:
            return formatter(lane, "writer", agent_card=agent_card)

    for lane in lanes:
        if lane.get(reviewer_key, "").lower() == agent_lower and lane.get("status", "") == "needs-review":
            return formatter(lane, "reviewer", agent_card=agent_card)

    for lane in lanes:
        if lane.get(owner_key, "").lower() == agent_lower and lane.get("status", "") == "needs-review":
            return formatter(lane, "writer-waiting", agent_card=agent_card)

    return ""


def _extract_rest_lane_payload(payload: dict, repo_root: str) -> tuple[list[dict], dict[str, dict]]:
    """Normalize single-repo and multi-repo lane API payloads.

    The live wrapper already knows its repo root, so use it to select the right
    lane set when the dashboard is aggregating multiple repos.
    """
    agent_cards = payload.get("agentCards", {})
    repos = payload.get("repos")
    if isinstance(repos, list):
        target_repo = _normalize_repo_path(repo_root)
        for entry in repos:
            if _normalize_repo_path(entry.get("path", "")) == target_repo:
                return entry.get("lanes", []), agent_cards
        if len(repos) == 1:
            return repos[0].get("lanes", []), agent_cards
        return [], agent_cards
    return payload.get("lanes", []), agent_cards


def _resolve_agent_card(agent_cards: dict[str, dict] | None, agent_name: str) -> dict | None:
    """Resolve an Agent Card by exact or case-insensitive instance name."""
    if not agent_cards:
        return None
    if agent_name in agent_cards:
        return agent_cards[agent_name]

    agent_lower = agent_name.lower()
    if agent_lower in agent_cards:
        return agent_cards[agent_lower]

    for name, card in agent_cards.items():
        if str(name).lower() == agent_lower:
            return card
    return None


def _normalize_repo_path(repo_root: str) -> str:
    try:
        return str(Path(repo_root).resolve())
    except Exception:
        return repo_root


def _render_lane_context(
    *,
    lane_id: str,
    task: str,
    status: str,
    owner: str,
    reviewer: str,
    locked: str,
    role: str,
    card_summary: str = "",
) -> str:
    parts = [
        f"LANE {lane_id}: {status} | {task}",
        f"W={owner} R={reviewer} lock={locked}",
        _build_role_note(role, lane_id, owner, reviewer),
    ]
    if card_summary:
        parts.append(card_summary)
    return " ".join(parts)


def _build_role_note(role: str, lane_id: str, owner: str, reviewer: str) -> str:
    if role == "reviewer":
        return f"Reviewer. btrain handoff resolve --lane {lane_id} --summary '...' --actor '{reviewer}'"
    if role == "writer-waiting":
        return f"Waiting on {reviewer} to review."
    return f"Writer. When done: btrain handoff update --lane {lane_id} --status needs-review --actor '{owner}'"
