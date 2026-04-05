"""Agent presence, activity, cursor, and role tracking.

Extracted from mcp_bridge.py during MCP phase-out (Workstream MCP-D).
This module owns all runtime agent identity state that app.py and
the wrapper rely on for presence detection, activity indicators,
cursor tracking, and role management.
"""

import json
import logging
import os
import threading
import time

log = logging.getLogger(__name__)

# --- Presence & activity ---
PRESENCE_TIMEOUT = 10   # ~2 missed heartbeats (5s interval) = offline
ACTIVITY_TIMEOUT = 8    # auto-expire activity after 8s without fresh active=True

_presence: dict[str, float] = {}
_activity: dict[str, bool] = {}
_activity_ts: dict[str, float] = {}
_presence_lock = threading.Lock()
_renamed_from: set[str] = set()

# --- Cursors ---
_cursors: dict[str, dict[str, int]] = {}
_cursors_lock = threading.Lock()
_CURSORS_FILE = None

# --- Roles ---
_roles: dict[str, str] = {}
_ROLES_FILE = None


# ── Presence ──────────────────────────────────────────────────────────────

def touch_presence(name: str):
    with _presence_lock:
        _presence[name] = time.time()


def get_online() -> list[str]:
    now = time.time()
    with _presence_lock:
        return [n for n, ts in _presence.items() if now - ts < PRESENCE_TIMEOUT]


def is_online(name: str) -> bool:
    now = time.time()
    with _presence_lock:
        return name in _presence and now - _presence.get(name, 0) < PRESENCE_TIMEOUT


# ── Activity ──────────────────────────────────────────────────────────────

def set_active(name: str, active: bool):
    with _presence_lock:
        _activity[name] = active
        if active:
            _activity_ts[name] = time.time()


def is_active(name: str) -> bool:
    now = time.time()
    with _presence_lock:
        if not _activity.get(name, False):
            return False
        ts = _activity_ts.get(name, 0)
        if now - ts > ACTIVITY_TIMEOUT:
            _activity[name] = False
            return False
        return True


# ── Identity migration ────────────────────────────────────────────────────

def migrate_identity(old_name: str, new_name: str):
    """Migrate all runtime state when an agent is renamed."""
    with _presence_lock:
        if old_name in _presence:
            _presence[new_name] = _presence.pop(old_name)
        if old_name in _activity:
            _activity[new_name] = _activity.pop(old_name)
        if old_name in _activity_ts:
            _activity_ts[new_name] = _activity_ts.pop(old_name)
        _renamed_from.add(old_name)
    with _cursors_lock:
        if old_name in _cursors:
            _cursors[new_name] = _cursors.pop(old_name)
    if old_name in _roles:
        _roles[new_name] = _roles.pop(old_name)
        _save_roles()
    _save_cursors()


def purge_identity(name: str):
    """Remove all runtime state for a deregistered agent."""
    with _presence_lock:
        _presence.pop(name, None)
        _activity.pop(name, None)
        _activity_ts.pop(name, None)
    with _cursors_lock:
        _cursors.pop(name, None)
    if name in _roles:
        del _roles[name]
        _save_roles()
    _save_cursors()


# ── Cursors ───────────────────────────────────────────────────────────────

def load_cursors(cursors_file):
    global _CURSORS_FILE, _cursors
    _CURSORS_FILE = cursors_file
    if _CURSORS_FILE is None or not _CURSORS_FILE.exists():
        return
    try:
        data = json.loads(_CURSORS_FILE.read_text("utf-8"))
        with _cursors_lock:
            _cursors.update(data)
    except Exception:
        log.warning("Failed to load cursor state from %s", _CURSORS_FILE)


def _save_cursors():
    if _CURSORS_FILE is None:
        return
    try:
        with _cursors_lock:
            snapshot = dict(_cursors)
        _CURSORS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _CURSORS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot), "utf-8")
        os.replace(tmp, _CURSORS_FILE)
    except Exception:
        log.warning("Failed to save cursor state to %s", _CURSORS_FILE)


def migrate_cursors_rename(old_name: str, new_name: str):
    with _cursors_lock:
        for agent_cursors in _cursors.values():
            if old_name in agent_cursors:
                agent_cursors[new_name] = agent_cursors.pop(old_name)
    _save_cursors()


def migrate_cursors_delete(channel: str):
    with _cursors_lock:
        for agent_cursors in _cursors.values():
            agent_cursors.pop(channel, None)
    _save_cursors()


# ── Roles ─────────────────────────────────────────────────────────────────

def load_roles(roles_file):
    global _ROLES_FILE, _roles
    _ROLES_FILE = roles_file
    if _ROLES_FILE is None or not _ROLES_FILE.exists():
        return
    try:
        _roles = json.loads(_ROLES_FILE.read_text("utf-8"))
    except Exception:
        log.warning("Failed to load roles from %s", _ROLES_FILE)


def _save_roles():
    if _ROLES_FILE is None:
        return
    try:
        _ROLES_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _ROLES_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_roles), "utf-8")
        os.replace(tmp, _ROLES_FILE)
    except Exception:
        log.warning("Failed to save roles to %s", _ROLES_FILE)


def set_role(name: str, role: str):
    if role:
        _roles[name] = role
    else:
        _roles.pop(name, None)
    _save_roles()


def get_role(name: str) -> str:
    return _roles.get(name, "")


def get_all_roles() -> dict[str, str]:
    return dict(_roles)
