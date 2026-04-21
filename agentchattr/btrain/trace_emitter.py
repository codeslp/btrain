"""Best-effort decision-trace emitter for agentchattr.

Writes routing decisions, context fetches, and startup events to
`.btrain/traces/` so they show up in `btrain traces list`. Failures are
logged but never raised — tracing must not break routing.

See spec 013-unified-trace-discovery.md for the record schema and the
reason this lives in agentchattr/btrain/ instead of the Node harness
side: the agentchattr router is Python and needs to emit inline.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_TRACE_SUBDIR = "traces"
_INDEX_NAME = "index.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _today_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _new_id() -> str:
    return f"ac-{secrets.token_hex(4)}"


def _traces_dir(repo_root: str | os.PathLike[str] | None) -> Path | None:
    if not repo_root:
        return None
    root = Path(repo_root)
    return root / ".btrain" / _TRACE_SUBDIR


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, separators=(",", ":"), default=str))
        fh.write("\n")


def _emit(repo_root: str | os.PathLike[str] | None, record: dict[str, Any], summary: str) -> None:
    dir_path = _traces_dir(repo_root)
    if dir_path is None:
        return
    try:
        full_path = dir_path / f"agentchattr-{_today_stamp()}.jsonl"
        _append_jsonl(full_path, record)
        index_entry = {
            "ts": record["ts"],
            "kind": "agentchattr",
            "id": record["id"],
            "event": record["event"],
            "lane": record.get("lane", ""),
            "agent": record.get("agent") or record.get("sender") or "",
            "route": record.get("route", ""),
            "summary": summary,
        }
        _append_jsonl(dir_path / _INDEX_NAME, index_entry)
    except Exception as exc:
        log.warning("trace_emitter: failed to append record (%s)", exc)


def emit_routing_decision(
    repo_root: str | os.PathLike[str] | None,
    *,
    sender: str,
    channel: str,
    mentions: list[str] | None,
    targets: list[str],
    reason: str,
    hop_count: int | None = None,
    paused: bool | None = None,
    context: dict[str, Any] | None = None,
) -> None:
    """Record a router.get_targets decision.

    `reason` should be one of: "human-no-mentions", "human-mentions",
    "agent-mentions", "agent-paused", "agent-no-mentions", "hop-guard".
    """
    record = {
        "ts": _now_iso(),
        "id": _new_id(),
        "kind": "agentchattr",
        "event": "routing_decision",
        "sender": sender,
        "channel": channel,
        "mentions": list(mentions or []),
        "targets": list(targets or []),
        "reason": reason,
        "hop_count": hop_count,
        "paused": paused,
        "context": dict(context or {}),
        "route": ",".join(targets or []),
    }
    summary_targets = ",".join(targets) if targets else "(none)"
    summary = f"{sender} @{channel}: {reason} → {summary_targets}"
    _emit(repo_root, record, summary)


def emit_context_fetch(
    repo_root: str | os.PathLike[str] | None,
    *,
    agent: str,
    lane: str | None,
    ok: bool,
    note: str | None = None,
) -> None:
    """Record a btrain-context fetch attempt (lane summary + agent card)."""
    record = {
        "ts": _now_iso(),
        "id": _new_id(),
        "kind": "agentchattr",
        "event": "context_fetch",
        "agent": agent,
        "lane": lane or "",
        "ok": bool(ok),
        "note": note or "",
    }
    summary = f"context fetch for {agent}@{lane or '-'}: {'ok' if ok else 'miss'}"
    if note:
        summary += f" ({note})"
    _emit(repo_root, record, summary)


def emit_startup(
    repo_root: str | os.PathLike[str] | None,
    *,
    agents: list[str],
    lanes: list[str] | None = None,
    config_summary: str = "",
) -> None:
    """Record agentchattr startup: which agents are active, which lanes exist."""
    record = {
        "ts": _now_iso(),
        "id": _new_id(),
        "kind": "agentchattr",
        "event": "startup",
        "agents": list(agents or []),
        "lanes": list(lanes or []),
        "config_summary": config_summary,
    }
    agent_list = ",".join(agents) if agents else "(none)"
    summary = f"agentchattr startup: agents=[{agent_list}]"
    _emit(repo_root, record, summary)
