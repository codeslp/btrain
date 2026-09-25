"""Session store — persists active session runs to JSON."""

import json
import time
import threading
import logging
from pathlib import Path

log = logging.getLogger(__name__)

# Longest phase prompt or per-role prompt a template may carry.
MAX_PROMPT_CHARS = 200


class SessionStore:
    def __init__(self, path: str, templates_dir: str | None = None):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._sessions: list[dict] = []
        self._next_id = 1
        self._lock = threading.Lock()
        self._callbacks: list = []
        self._templates: dict[str, dict] = {}
        self._load()

        # Warn about legacy file
        legacy = self._path.parent / "sessions.json"
        if legacy.exists() and legacy != self._path:
            log.info("Ignoring legacy sessions.json; Sessions uses %s", self._path.name)

        if templates_dir:
            self._load_templates(Path(templates_dir))

        # Load custom (user/agent-created) templates
        custom_path = self._path.parent / "custom_templates.json"
        if custom_path.exists():
            try:
                custom = json.loads(custom_path.read_text("utf-8"))
                for tmpl in (custom if isinstance(custom, list) else []):
                    tid = tmpl.get("id", "")
                    if tid and self.is_builtin_template(tid):
                        log.warning("Ignoring custom template %s: it would replace a built-in template", tid)
                        continue
                    if tid:
                        tmpl["is_custom"] = True
                        self._templates[tid] = tmpl
                        log.info("Loaded custom template: %s", tid)
            except (json.JSONDecodeError, KeyError) as exc:
                log.warning("Failed to load custom templates: %s", exc)

    # --- Persistence ---

    def _load(self):
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text("utf-8"))
            if isinstance(raw, list):
                self._sessions = raw
                if self._sessions:
                    self._next_id = max(s["id"] for s in self._sessions) + 1
        except (json.JSONDecodeError, KeyError):
            self._sessions = []

    def _save(self):
        self._path.write_text(
            json.dumps(self._sessions, indent=2, ensure_ascii=False) + "\n",
            "utf-8",
        )

    # --- Templates ---

    def _load_templates(self, directory: Path):
        if not directory.exists():
            log.warning("Session templates directory not found: %s", directory)
            return
        for f in sorted(directory.glob("*.json")):
            try:
                tmpl = json.loads(f.read_text("utf-8"))
                tid = tmpl.get("id", f.stem)
                tmpl["id"] = tid
                tmpl.setdefault("is_custom", False)
                self._templates[tid] = tmpl
                log.info("Loaded session template: %s", tid)
            except (json.JSONDecodeError, KeyError) as exc:
                log.warning("Failed to load template %s: %s", f.name, exc)

    def get_templates(self) -> list[dict]:
        return list(self._templates.values())

    def get_template(self, template_id: str) -> dict | None:
        return self._templates.get(template_id)

    def is_builtin_template(self, template_id: str) -> bool:
        """True for a template shipped in session_templates/.

        Drafts and custom templates may not take its id: replacing it would
        drop its rules, such as code-review's distinct_roles.
        """
        tmpl = self._templates.get(template_id)
        return tmpl is not None and not tmpl.get("is_custom")

    def save_custom_template(self, tmpl: dict) -> dict:
        custom_path = self._path.parent / "custom_templates.json"
        custom = []
        if custom_path.exists():
            try:
                custom = json.loads(custom_path.read_text("utf-8"))
            except (json.JSONDecodeError, KeyError):
                custom = []

        saved = dict(tmpl)
        saved["is_custom"] = True
        custom = [t for t in custom if t.get("id") != saved.get("id")]
        custom.append(saved)
        custom_path.write_text(json.dumps(custom, indent=2, ensure_ascii=False) + "\n", "utf-8")
        self._templates[saved["id"]] = saved
        return saved

    def delete_custom_template(self, template_id: str) -> bool:
        tmpl = self._templates.get(template_id)
        if not tmpl or not tmpl.get("is_custom"):
            return False

        custom_path = self._path.parent / "custom_templates.json"
        custom = []
        if custom_path.exists():
            try:
                custom = json.loads(custom_path.read_text("utf-8"))
            except (json.JSONDecodeError, KeyError):
                custom = []

        new_custom = [t for t in custom if t.get("id") != template_id]
        if len(new_custom) != len(custom):
            custom_path.write_text(json.dumps(new_custom, indent=2, ensure_ascii=False) + "\n", "utf-8")

        self._templates.pop(template_id, None)
        return True

    # --- Callbacks ---

    def on_change(self, callback):
        """Register a callback(action, session) on any change.
        action: 'create', 'update', 'complete', 'interrupt'."""
        self._callbacks.append(callback)

    def _fire(self, action: str, session: dict):
        for cb in self._callbacks:
            try:
                cb(action, session)
            except Exception:
                pass

    # --- Session lifecycle ---

    def create(self, template_id: str, channel: str, cast: dict,
               started_by: str, goal: str = "") -> dict | None:
        """Create and persist a new session run."""
        tmpl = self._templates.get(template_id)
        if not tmpl:
            return None

        with self._lock:
            # One active session per channel
            for s in self._sessions:
                if s.get("channel") == channel and s.get("state") in ("active", "waiting", "paused"):
                    return None

            session = {
                "id": self._next_id,
                "template_id": template_id,
                "template_name": tmpl.get("name", template_id),
                "channel": channel,
                "cast": cast,
                "state": "active",
                "current_phase": 0,
                "current_turn": 0,
                "started_by": started_by,
                "started_at": time.time(),
                "updated_at": time.time(),
                "last_message_id": None,
                "output_message_id": None,
                "goal": goal.strip()[:500],
            }
            self._next_id += 1
            self._sessions.append(session)
            self._save()

        self._fire("create", session)
        return session

    def get(self, session_id: int) -> dict | None:
        with self._lock:
            for s in self._sessions:
                if s["id"] == session_id:
                    return dict(s)
            return None

    def get_active(self, channel: str) -> dict | None:
        """Get the active/waiting/paused session for a channel."""
        with self._lock:
            for s in self._sessions:
                if s.get("channel") == channel and s.get("state") in ("active", "waiting", "paused"):
                    return dict(s)
            return None

    def list_all(self, channel: str | None = None) -> list[dict]:
        with self._lock:
            result = list(self._sessions)
        if channel:
            result = [s for s in result if s.get("channel") == channel]
        return result

    def advance_turn(self, session_id: int, message_id: int | None = None) -> dict | None:
        """Advance to the next turn within the current phase."""
        with self._lock:
            session = self._find(session_id)
            if not session or session["state"] not in ("active", "waiting"):
                return None
            session["current_turn"] += 1
            session["state"] = "active"
            session["updated_at"] = time.time()
            if message_id is not None:
                session["last_message_id"] = message_id
            self._save()
            result = dict(session)
        self._fire("update", result)
        return result

    def advance_phase(self, session_id: int, message_id: int | None = None) -> dict | None:
        """Advance to the next phase, resetting turn to 0."""
        with self._lock:
            session = self._find(session_id)
            if not session or session["state"] not in ("active", "waiting"):
                return None
            session["current_phase"] += 1
            session["current_turn"] = 0
            session["state"] = "active"
            session["updated_at"] = time.time()
            if message_id is not None:
                session["last_message_id"] = message_id
            self._save()
            result = dict(session)
        self._fire("update", result)
        return result

    def set_waiting(self, session_id: int, agent: str) -> dict | None:
        """Mark session as waiting on a specific agent."""
        with self._lock:
            session = self._find(session_id)
            if not session:
                return None
            session["state"] = "waiting"
            session["waiting_on"] = agent
            session["updated_at"] = time.time()
            self._save()
            result = dict(session)
        self._fire("update", result)
        return result

    def pause(self, session_id: int) -> dict | None:
        """Pause session (human interruption)."""
        with self._lock:
            session = self._find(session_id)
            if not session or session["state"] not in ("active", "waiting"):
                return None
            session["state"] = "paused"
            session["updated_at"] = time.time()
            self._save()
            result = dict(session)
        self._fire("update", result)
        return result

    def resume(self, session_id: int) -> dict | None:
        """Resume a paused session."""
        with self._lock:
            session = self._find(session_id)
            if not session or session["state"] != "paused":
                return None
            session["state"] = "active"
            session["updated_at"] = time.time()
            self._save()
            result = dict(session)
        self._fire("update", result)
        return result

    def complete(self, session_id: int, output_message_id: int | None = None) -> dict | None:
        """Mark session as complete."""
        with self._lock:
            session = self._find(session_id)
            if not session:
                return None
            session["state"] = "complete"
            session["updated_at"] = time.time()
            if output_message_id is not None:
                session["output_message_id"] = output_message_id
            self._save()
            result = dict(session)
        self._fire("complete", result)
        return result

    def interrupt(self, session_id: int, reason: str = "ended by user") -> dict | None:
        """End session early."""
        with self._lock:
            session = self._find(session_id)
            if not session or session["state"] in ("complete", "interrupted"):
                return None
            session["state"] = "interrupted"
            session["interrupt_reason"] = reason
            session["updated_at"] = time.time()
            self._save()
            result = dict(session)
        self._fire("interrupt", result)
        return result

    def _find(self, session_id: int) -> dict | None:
        """Find session by ID (caller must hold lock)."""
        for s in self._sessions:
            if s["id"] == session_id:
                return s
        return None


def validate_session_template(tmpl: dict) -> list[str]:
    """Validate a session template dict. Returns list of errors (empty = valid)."""
    errors = []

    if not isinstance(tmpl, dict):
        return ["Template must be a JSON object"]

    if not tmpl.get("name") or not isinstance(tmpl.get("name"), str):
        errors.append("Missing or invalid 'name' (string required)")

    roles = tmpl.get("roles", [])
    if not isinstance(roles, list) or len(roles) == 0:
        errors.append("'roles' must be a non-empty array")
    elif len(roles) > 6:
        errors.append(f"Too many roles ({len(roles)}, max 6)")

    phases = tmpl.get("phases", [])
    if not isinstance(phases, list) or len(phases) == 0:
        errors.append("'phases' must be a non-empty array")
    elif len(phases) > 6:
        errors.append(f"Too many phases ({len(phases)}, max 6)")

    roles_set = set(roles) if isinstance(roles, list) else set()
    output_count = 0

    for i, phase in enumerate(phases if isinstance(phases, list) else []):
        if not isinstance(phase, dict):
            errors.append(f"Phase {i + 1}: must be an object")
            continue
        if not phase.get("name"):
            errors.append(f"Phase {i + 1}: missing 'name'")
        participants = phase.get("participants", [])
        if not isinstance(participants, list) or len(participants) == 0:
            errors.append(f"Phase {i + 1}: 'participants' must be a non-empty array")
        elif len(participants) > 4:
            errors.append(f"Phase {i + 1}: too many participants ({len(participants)}, max 4)")
        for p in (participants if isinstance(participants, list) else []):
            if p not in roles_set:
                errors.append(f"Phase {i + 1}: participant '{p}' not in roles list")
        prompt = phase.get("prompt", "")
        if isinstance(prompt, str) and len(prompt) > MAX_PROMPT_CHARS:
            errors.append(f"Phase {i + 1}: prompt too long ({len(prompt)} chars, max {MAX_PROMPT_CHARS})")
        errors.extend(_role_prompt_errors(i, phase, participants))
        if phase.get("is_output"):
            output_count += 1

    if output_count == 0 and isinstance(phases, list) and len(phases) > 0:
        errors.append("No phase marked as 'is_output: true'")
    elif output_count > 1:
        errors.append(f"Multiple phases marked as output ({output_count}, expected 1)")

    errors.extend(_distinct_roles_errors(tmpl.get("distinct_roles"), roles_set))
    return errors


def _distinct_roles_errors(groups, roles_set: set) -> list[str]:
    """Errors for the optional ``distinct_roles`` list of role groups."""
    if groups is None:
        return []
    if not isinstance(groups, list):
        return ["'distinct_roles' must be an array of role groups"]
    errors = []
    for j, group in enumerate(groups):
        names = [r for r in group if isinstance(r, str)] if isinstance(group, list) else []
        if len(set(names)) < 2:
            errors.append(f"distinct_roles group {j + 1}: must list at least two different roles")
            continue
        for role in group:
            if not isinstance(role, str) or role not in roles_set:
                errors.append(f"distinct_roles group {j + 1}: '{role}' not in roles list")
    return errors


def _role_prompt_errors(index: int, phase: dict, participants) -> list[str]:
    """Errors for a phase's optional ``role_prompts`` map of role -> prompt.

    A role prompt replaces the phase prompt for that one participant, so it
    must name a participant of the same phase and obey the same length cap.
    """
    role_prompts = phase.get("role_prompts")
    if role_prompts is None:
        return []
    label = f"Phase {index + 1}"
    if not isinstance(role_prompts, dict):
        return [f"{label}: 'role_prompts' must be an object mapping role to prompt"]

    members = {p for p in participants if isinstance(p, str)} if isinstance(participants, list) else set()
    errors = []
    for role, text in role_prompts.items():
        if role not in members:
            errors.append(f"{label}: role prompt for '{role}', which is not a participant in this phase")
        if not isinstance(text, str) or not text.strip():
            errors.append(f"{label}: role prompt for '{role}' must be a non-empty string")
        elif len(text) > MAX_PROMPT_CHARS:
            errors.append(
                f"{label}: role prompt for '{role}' too long ({len(text)} chars, max {MAX_PROMPT_CHARS})"
            )
    return errors


# --- Casting ---
#
# A template's ``distinct_roles`` lists groups of roles that must go to
# different agents, e.g. ``[["builder", "red_team"]]`` so that nobody
# red-teams their own build. static/sessions.js mirrors auto_cast and the
# conflict check (``_autoCast`` / ``_castConflicts``) for the launcher.


class CastError(ValueError):
    """The template's roles cannot be given to the agents that are online."""


def _distinct_groups(tmpl: dict) -> list[list[str]]:
    """``distinct_roles`` as groups of unique role names, skipping malformed entries.

    validate_session_template reports malformed groups for drafts; this only
    has to keep casting from crashing on a template that was never validated.
    """
    groups = tmpl.get("distinct_roles") if isinstance(tmpl, dict) else None
    if not isinstance(groups, list):
        return []
    return [
        list(dict.fromkeys(role for role in group if isinstance(role, str)))
        for group in groups
        if isinstance(group, list)
    ]


def auto_cast(tmpl: dict, online_agents: list[str]) -> dict:
    """Give each of the template's roles to an online agent.

    Round-robin in role order, reusing agents when roles outnumber them,
    except that two roles in one ``distinct_roles`` group never share an
    agent: a candidate that would repeat one is passed over for the next
    agent in the rotation. Raises CastError when a role cannot be cast.
    """
    roles = tmpl.get("roles") if isinstance(tmpl, dict) else None
    if not isinstance(roles, list) or not roles:
        raise CastError("template has no roles to cast")
    agents = list(dict.fromkeys(online_agents))
    if not agents:
        raise CastError("not enough agents online to fill all roles")

    groups = _distinct_groups(tmpl)
    cast: dict[str, str] = {}
    turn = 0
    for role in roles:
        rival_roles = {other for group in groups if role in group for other in group if other != role}
        rivals = [other for other in dict.fromkeys(roles) if other in rival_roles and other in cast]
        taken = {cast[other] for other in rivals}
        pick = next(
            (i % len(agents) for i in range(turn, turn + len(agents)) if agents[i % len(agents)] not in taken),
            None,
        )
        if pick is None:
            online = f"{len(agents)} agent is" if len(agents) == 1 else f"{len(agents)} agents are"
            raise CastError(
                f"Cannot auto-cast '{role}': it needs a different agent than "
                f"{' and '.join(repr(r) for r in rivals)}, but only {online} online ({', '.join(agents)}). "
                "Bring another agent online or choose the cast by hand."
            )
        cast[role] = agents[pick]
        turn = (pick + 1) % len(agents)
    return cast


def validate_cast(tmpl: dict, cast) -> list[str]:
    """Check a role -> agent cast against the template. Returns errors (empty = valid).

    Roles in one ``distinct_roles`` group may not share an agent (or a human).
    Roles left uncast are not checked here.
    """
    if not isinstance(cast, dict):
        return ["'cast' must be an object mapping role to agent"]
    errors = [
        f"Cast for '{role}' must be an agent name"
        for role, agent in cast.items()
        if agent and not isinstance(agent, str)
    ]
    if errors:
        return errors

    for group in _distinct_groups(tmpl):
        first_role_by_agent: dict[str, str] = {}
        for role in group:
            agent = cast.get(role)
            if not agent:
                continue
            if agent in first_role_by_agent:
                errors.append(
                    f"Cast conflict: '{first_role_by_agent[agent]}' and '{role}' "
                    f"must be different agents, but both are '{agent}'."
                )
            else:
                first_role_by_agent[agent] = role
    return errors
