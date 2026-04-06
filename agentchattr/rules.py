"""Rules store — shared working style for agents. Agents propose, humans approve."""

import json
import time
import threading
import uuid
import re
from pathlib import Path

MAX_ACTIVE_RULES = 10
MAX_TEXT_CHARS = 160
MAX_REASON_CHARS = 240
SOFT_WARNING_THRESHOLD = 7


class RuleStore:
    def __init__(self, path: str):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._rules: list[dict] = []
        self._next_id = 1
        self._epoch = 0
        self._agent_sync: dict[str, int] = {}  # agent_name -> last_epoch_seen
        self._lock = threading.Lock()
        self._callbacks: list = []
        self._load()

    def _load(self):
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text("utf-8"))
            # Support both legacy list format and new dict format
            if isinstance(raw, dict):
                self._rules = raw.get("rules", [])
                self._epoch = raw.get("epoch", 0)
            elif isinstance(raw, list):
                # Migration from decisions.json
                self._rules = raw
                self._migrate_legacy()
                self._epoch = 1
            if self._rules:
                self._next_id = max(d["id"] for d in self._rules) + 1
        except (json.JSONDecodeError, KeyError):
            self._rules = []

    def _migrate_legacy(self):
        """Migrate legacy decision format to rules format."""
        for r in self._rules:
            # Rename 'decision' field to 'text'
            if "decision" in r and "text" not in r:
                r["text"] = r.pop("decision")
            # Map statuses
            if r.get("status") == "approved":
                r["status"] = "active"
            elif r.get("status") == "proposed":
                r["status"] = "draft"
            # Ensure author field
            if "owner" in r and "author" not in r:
                r["author"] = r.pop("owner")
            elif "author" not in r:
                r["author"] = r.get("owner", "user")

    def _save(self):
        data = {
            "epoch": self._epoch,
            "rules": self._rules,
        }
        self._path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            "utf-8",
        )

    def on_change(self, callback):
        """Register a callback(action, rule) fired on any change.
        action is 'propose', 'activate', 'deactivate', 'edit', or 'delete'."""
        self._callbacks.append(callback)

    def _fire(self, action: str, rule: dict):
        for cb in self._callbacks:
            try:
                cb(action, rule)
            except Exception:
                pass

    def _bump_epoch(self):
        """Bump epoch when the active rule set changes."""
        self._epoch += 1

    # --- Reads ---

    def list_all(self) -> list[dict]:
        with self._lock:
            return list(self._rules)

    def get(self, rule_id: int) -> dict | None:
        with self._lock:
            for r in self._rules:
                if r["id"] == rule_id:
                    return dict(r)
            return None

    def active_list(self) -> dict:
        """Return compact active rules for agent injection."""
        with self._lock:
            rules = [r["text"] for r in self._rules if r.get("status") == "active"]
            return {
                "epoch": self._epoch,
                "rules": rules,
            }

    @property
    def epoch(self) -> int:
        return self._epoch

    # --- Writes ---

    def propose(self, text: str, author: str, reason: str = "") -> dict | None:
        with self._lock:
            total = len(self._rules)
            if total >= 50:  # generous total cap including all states
                return None
            r = {
                "id": self._next_id,
                "uid": str(uuid.uuid4()),
                "text": text.strip()[:MAX_TEXT_CHARS],
                "author": author.strip(),
                "reason": reason.strip()[:MAX_REASON_CHARS],
                "status": "pending",
                "created_at": time.time(),
            }
            self._next_id += 1
            self._rules.append(r)
            self._save()
        self._fire("propose", r)
        return r

    def activate(self, rule_id: int) -> dict | None:
        with self._lock:
            active_count = sum(1 for r in self._rules if r.get("status") == "active")
            if active_count >= MAX_ACTIVE_RULES:
                return None
            for r in self._rules:
                if r["id"] == rule_id:
                    r["status"] = "active"
                    self._bump_epoch()
                    self._save()
                    result = dict(r)
                    break
            else:
                return None
        self._fire("activate", result)
        return result

    def make_draft(self, rule_id: int) -> dict | None:
        with self._lock:
            for r in self._rules:
                if r["id"] == rule_id:
                    was_active = r.get("status") == "active"
                    r["status"] = "draft"
                    r.pop("archived_at", None)
                    if was_active:
                        self._bump_epoch()
                    self._save()
                    result = dict(r)
                    break
            else:
                return None
        self._fire("edit", result)
        return result

    def deactivate(self, rule_id: int) -> dict | None:
        with self._lock:
            for r in self._rules:
                if r["id"] == rule_id and r.get("status") in ("active", "proposed", "draft"):
                    was_active = r.get("status") == "active"
                    r["status"] = "archived"
                    r["archived_at"] = time.time()
                    if was_active:
                        self._bump_epoch()
                    self._save()
                    result = dict(r)
                    break
            else:
                return None
        self._fire("deactivate", result)
        return result

    def edit(self, rule_id: int, text: str | None = None,
             reason: str | None = None) -> dict | None:
        with self._lock:
            for r in self._rules:
                if r["id"] == rule_id:
                    was_active = r.get("status") == "active"
                    if text is not None:
                        r["text"] = text.strip()[:MAX_TEXT_CHARS]
                    if reason is not None:
                        r["reason"] = reason.strip()[:MAX_REASON_CHARS]
                    if was_active:
                        self._bump_epoch()
                    self._save()
                    result = dict(r)
                    break
            else:
                return None
        self._fire("edit", result)
        return result

    def delete(self, rule_id: int) -> dict | None:
        with self._lock:
            for i, r in enumerate(self._rules):
                if r["id"] == rule_id:
                    was_active = r.get("status") == "active"
                    removed = self._rules.pop(i)
                    if was_active:
                        self._bump_epoch()
                    self._save()
                    result = dict(removed)
                    break
            else:
                return None
        self._fire("delete", result)
        return result

    # --- Remind ---

    def set_remind(self):
        """Bump epoch so all agents re-inject rules on next trigger."""
        with self._lock:
            self._bump_epoch()

    def clear_remind(self):
        """No-op — remind is now epoch-based, not flag-based."""
        pass

    # --- Agent sync tracking ---

    def report_agent_sync(self, agent_name: str, epoch: int):
        """Record that an agent has seen rules at this epoch."""
        with self._lock:
            self._agent_sync[agent_name] = epoch

    def agent_freshness(self) -> dict:
        """Return per-agent sync status."""
        with self._lock:
            current = self._epoch
            result = {}
            for name, last_epoch in self._agent_sync.items():
                if last_epoch >= current:
                    result[name] = {"last_epoch": last_epoch, "status": "fresh"}
                else:
                    result[name] = {"last_epoch": last_epoch, "status": "stale"}
            return {"epoch": current, "agents": result}

    # --- Counts ---

    def count_active(self) -> int:
        with self._lock:
            return sum(1 for r in self._rules if r.get("status") == "active")

    def count_draft(self) -> int:
        with self._lock:
            return sum(1 for r in self._rules if r.get("status") == "draft")

    # Legacy compat
    def count_proposed(self) -> int:
        return self.count_draft()


# ---------------------------------------------------------------------------
# btrain Conflict Detection (Workstream 6)
# ---------------------------------------------------------------------------

class btrainValidator:
    """Detects drift or rule violations by checking message text against lane state."""

    def __init__(self):
        # Keywords that suggest an agent is claiming a task or role
        self._claim_patterns = [
            re.compile(r"\b(i'll|i will|i am|claiming|taking)\b.*\b(task|lane|work|issue)\b", re.I),
            re.compile(r"\b(starting|working on)\b.*\b(lane|task)\b", re.I),
        ]
        # Keywords that suggest an agent is requesting or performing a handoff
        self._handoff_patterns = [
            re.compile(r"\b(handing off|ready for review|finished|completed)\b", re.I),
            re.compile(r"\bbtrain\s+handoff\b", re.I),
        ]

    def validate(self, sender: str, text: str, channel: str, btrain_lanes: list[dict]) -> list[str]:
        """Check for contradictions between chat claims and canonical btrain state.
        
        Returns a list of warning strings.
        """
        warnings = []
        sender_lower = sender.lower()
        
        # Determine target lane from channel (#a, #b, etc.)
        lane_id = ""
        if channel.startswith("#") and len(channel) == 2:
            lane_id = channel.lstrip("#").lower()
        
        # If not a lane channel, check if the text mentions a specific lane
        if not lane_id:
            lane_match = re.search(r"\blane\s+([a-i])\b", text, re.I)
            if lane_match:
                lane_id = lane_match.group(1).lower()
        
        if not lane_id:
            return []

        lane = next((l for l in btrain_lanes if l.get("_laneId", "").lower() == lane_id), None)
        if not lane:
            return []

        status = lane.get("status", "idle")
        owner = (lane.get("owner") or "").lower()
        reviewer = (lane.get("reviewer") or "").lower()

        # 1. Check for 'claim' drift (agent claiming someone else's lane)
        is_claiming = any(p.search(text) for p in self._claim_patterns)
        if is_claiming:
            if owner and owner != sender_lower and status != "resolved" and status != "idle":
                warnings.append(
                    f"Conflict: @{sender} is claiming lane {lane_id}, but it is currently locked by @{owner}."
                )

        # 2. Check for 'handoff' drift (agent acting as owner when they aren't)
        is_handoff = any(p.search(text) for p in self._handoff_patterns)
        if is_handoff:
            if owner and owner != sender_lower and status == "in-progress":
                warnings.append(
                    f"Drift: @{sender} is reporting progress on lane {lane_id}, but the canonical owner is @{owner}."
                )
            if reviewer and reviewer != sender_lower and status == "needs-review":
                warnings.append(
                    f"Drift: @{sender} is acting on a review for lane {lane_id}, but the canonical reviewer is @{reviewer}."
                )

        return warnings
