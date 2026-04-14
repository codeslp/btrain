"""btrain handoff notification helpers for agentchattr."""

import hashlib
import json
import re


_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_RUNTIME_ALIASES = {
    "claude": ("claude", "opus", "anthropic"),
    "codex": ("codex", "gpt", "openai"),
    "gemini": ("gemini", "google"),
}


def build_btrain_notification_text(lane, previous_status="", agents_cfg=None, registry=None):
    """Return the #agents notification text for a lane transition, or empty string."""
    new_status = _normalize_token(lane.get("status"))
    previous_status = _normalize_token(previous_status)
    if not new_status or not previous_status or new_status == previous_status:
        return ""

    lane_id = lane.get("_laneId") or lane.get("_lane_id") or "?"
    owner = resolve_btrain_agent_handle(
        lane.get("owner") or lane.get("active agent"),
        agents_cfg=agents_cfg,
        registry=registry,
    )
    reviewer = resolve_btrain_agent_handle(
        lane.get("reviewer") or lane.get("peer reviewer"),
        agents_cfg=agents_cfg,
        registry=registry,
    )
    fingerprint = _lane_fingerprint(lane)

    if new_status == "in-progress" and owner:
        return "@%s lane %s assigned. btrain handoff --lane %s #%s" % (
            owner,
            lane_id,
            lane_id,
            fingerprint,
        )

    if new_status == "needs-review" and reviewer:
        return "@%s lane %s ready for review. btrain handoff --lane %s #%s" % (
            reviewer,
            lane_id,
            lane_id,
            fingerprint,
        )

    if new_status == "changes-requested" and owner:
        reason = lane.get("reasonCode") or lane.get("reason code") or ""
        suffix = " (%s)" % reason if reason else ""
        return "@%s lane %s changes requested%s. btrain handoff --lane %s #%s" % (
            owner,
            lane_id,
            suffix,
            lane_id,
            fingerprint,
        )

    if new_status == "repair-needed":
        repair_owner = resolve_btrain_agent_handle(
            lane.get("repairOwner") or lane.get("repair owner") or lane.get("owner"),
            agents_cfg=agents_cfg,
            registry=registry,
        )
        if repair_owner:
            return "@%s lane %s needs repair. btrain doctor --repair #%s" % (
                repair_owner,
                lane_id,
                fingerprint,
            )

    if new_status == "resolved" and previous_status == "needs-review" and owner:
        return "@%s lane %s resolved. btrain handoff --lane %s #%s" % (
            owner,
            lane_id,
            lane_id,
            fingerprint,
        )

    return ""


def resolve_btrain_agent_handle(raw_name, agents_cfg=None, registry=None):
    """Map a btrain owner/reviewer label to an agentchattr family name when possible."""
    normalized = _normalize_token(raw_name)
    if not normalized:
        return ""

    direct_instance = _resolve_registry_instance_name(normalized, registry)
    if direct_instance:
        return direct_instance

    available = _collect_agent_aliases(agents_cfg=agents_cfg, registry=registry)
    if normalized in available:
        return _resolve_single_active_instance(normalized, registry) or normalized

    for base_name, aliases in available.items():
        if normalized in aliases:
            return _resolve_single_active_instance(base_name, registry) or base_name

    for base_name, alias_tokens in _RUNTIME_ALIASES.items():
        if base_name not in available:
            continue
        if _matches_alias(normalized, alias_tokens):
            return _resolve_single_active_instance(base_name, registry) or base_name

    return normalized


def _collect_agent_aliases(agents_cfg=None, registry=None):
    aliases = {}

    for name, cfg in (agents_cfg or {}).items():
        base_name = _normalize_token(name)
        if not base_name:
            continue
        agent_aliases = aliases.setdefault(base_name, set([base_name]))
        label = _normalize_token((cfg or {}).get("label"))
        if label:
            agent_aliases.add(label)

    if registry is not None:
        try:
            for name, cfg in (registry.get_bases() or {}).items():
                base_name = _normalize_token(name)
                if not base_name:
                    continue
                agent_aliases = aliases.setdefault(base_name, set([base_name]))
                label = _normalize_token((cfg or {}).get("label"))
                if label:
                    agent_aliases.add(label)
        except Exception:
            pass

        try:
            for inst in (registry.get_all() or {}).values():
                base_name = _normalize_token(inst.get("base"))
                if not base_name:
                    continue
                agent_aliases = aliases.setdefault(base_name, set([base_name]))
                for field_name in ("name", "label"):
                    value = _normalize_token(inst.get(field_name))
                    if value:
                        agent_aliases.add(value)
        except Exception:
            pass

    return aliases


def _resolve_registry_instance_name(normalized_name, registry):
    if registry is None:
        return ""

    try:
        for inst_name, inst in (registry.get_all() or {}).items():
            if normalized_name == _normalize_token(inst_name):
                return inst_name
            if normalized_name == _normalize_token(inst.get("label")):
                return inst_name
    except Exception:
        return ""

    return ""


def _resolve_single_active_instance(base_name, registry):
    if registry is None:
        return ""

    try:
        matches = registry.resolve_to_instances(base_name)
    except Exception:
        return ""

    if len(matches) == 1:
        return matches[0]
    return ""


def _matches_alias(normalized_name, alias_tokens):
    words = set(token for token in normalized_name.split("-") if token)
    if words.intersection(alias_tokens):
        return True
    return any(token in normalized_name for token in alias_tokens)


def _lane_fingerprint(lane):
    payload = json.dumps(lane, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:8]


def _normalize_token(value):
    if not isinstance(value, str):
        return ""
    value = value.strip().lower()
    if not value:
        return ""
    return _NON_ALNUM_RE.sub("-", value).strip("-")
