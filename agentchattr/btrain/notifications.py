"""btrain handoff notification helpers for agentchattr."""

import hashlib
import json
import re
import time
import uuid


_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_RUNTIME_ALIASES = {
    "claude": ("claude", "opus", "anthropic"),
    "codex": ("codex", "gpt", "openai"),
    "gemini": ("gemini", "google"),
}
_ACTIVE_DELIVERY_STATUSES = {"queued", "retrying"}
DEFAULT_BTRAIN_DELIVERY_ACK_TIMEOUT_SEC = 15
DEFAULT_BTRAIN_DELIVERY_MAX_ATTEMPTS = 2


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


def create_btrain_delivery(
    lane,
    *,
    notify_text,
    target,
    channel="agents",
    now=None,
    ack_timeout_sec=DEFAULT_BTRAIN_DELIVERY_ACK_TIMEOUT_SEC,
    max_attempts=DEFAULT_BTRAIN_DELIVERY_MAX_ATTEMPTS,
):
    """Create an in-memory delivery record for a delegated wakeup."""
    created_at = float(time.time() if now is None else now)
    attempts = max(1, int(max_attempts or DEFAULT_BTRAIN_DELIVERY_MAX_ATTEMPTS))
    lane_id = lane.get("_laneId") or lane.get("_lane_id") or "?"
    fingerprint = _lane_fingerprint(lane)
    return {
        "id": uuid.uuid4().hex[:12],
        "laneId": lane_id,
        "fingerprint": fingerprint,
        "notifyText": notify_text,
        "target": target,
        "channel": channel or "agents",
        "status": "queued",
        "attempts": 1,
        "maxAttempts": attempts,
        "ackTimeoutSec": max(1, int(ack_timeout_sec or DEFAULT_BTRAIN_DELIVERY_ACK_TIMEOUT_SEC)),
        "createdAt": created_at,
        "lastAttemptAt": created_at,
        "acknowledgedAt": None,
        "failureReason": "",
    }


def acknowledge_btrain_delivery(deliveries, delivery_id, *, agent_name="", now=None):
    """Mark a queued/retrying wakeup as acknowledged by the wrapper."""
    delivery = (deliveries or {}).get(delivery_id)
    if not delivery:
        return None

    if delivery.get("status") not in _ACTIVE_DELIVERY_STATUSES:
        return delivery

    normalized_target = _normalize_token(delivery.get("target"))
    normalized_agent = _normalize_token(agent_name)
    if normalized_target and normalized_agent and normalized_target != normalized_agent:
        return None

    delivery["status"] = "acknowledged"
    delivery["acknowledgedAt"] = float(time.time() if now is None else now)
    if agent_name:
        delivery["acknowledgedBy"] = agent_name
    delivery["failureReason"] = ""
    return delivery


def advance_btrain_deliveries(deliveries, *, lanes=None, now=None):
    """Advance queued wakeups to retry/failed/superseded states as needed."""
    actions = {"retry": [], "failed": [], "superseded": []}
    if not deliveries:
        return actions

    current_time = float(time.time() if now is None else now)
    lane_fingerprints = {}
    for lane in lanes or []:
        lane_id = lane.get("_laneId") or lane.get("_lane_id")
        if lane_id:
            lane_fingerprints[str(lane_id)] = _lane_fingerprint(lane)

    for delivery in deliveries.values():
        if delivery.get("status") not in _ACTIVE_DELIVERY_STATUSES:
            continue

        lane_id = str(delivery.get("laneId") or "")
        current_fingerprint = lane_fingerprints.get(lane_id)
        if current_fingerprint and current_fingerprint != delivery.get("fingerprint"):
            delivery["status"] = "superseded"
            delivery["supersededAt"] = current_time
            actions["superseded"].append(dict(delivery))
            continue

        last_attempt = delivery.get("lastAttemptAt")
        if last_attempt is None:
            last_attempt = delivery.get("createdAt")
        if last_attempt is None:
            last_attempt = current_time
        last_attempt = float(last_attempt)
        ack_timeout_sec = max(
            1,
            int(delivery.get("ackTimeoutSec") or DEFAULT_BTRAIN_DELIVERY_ACK_TIMEOUT_SEC),
        )
        if current_time - last_attempt < ack_timeout_sec:
            continue

        attempts = max(1, int(delivery.get("attempts") or 1))
        max_attempts = max(attempts, int(delivery.get("maxAttempts") or DEFAULT_BTRAIN_DELIVERY_MAX_ATTEMPTS))
        if attempts < max_attempts:
            delivery["status"] = "retrying"
            delivery["attempts"] = attempts + 1
            delivery["lastAttemptAt"] = current_time
            actions["retry"].append(dict(delivery))
            continue

        delivery["status"] = "failed"
        delivery["failedAt"] = current_time
        delivery["failureReason"] = delivery.get("failureReason") or "ack-timeout"
        actions["failed"].append(dict(delivery))

    return actions


def build_btrain_delivery_retry_text(delivery):
    lane_id = delivery.get("laneId") or "?"
    target = delivery.get("target") or "unknown"
    attempts = delivery.get("attempts") or 1
    max_attempts = delivery.get("maxAttempts") or attempts
    fingerprint = delivery.get("fingerprint") or "unknown"
    return (
        f"btrain delivery retry for lane {lane_id} -> @{target}: "
        f"no acknowledgement yet; retrying ({attempts}/{max_attempts}). #{fingerprint}"
    )


def build_btrain_delivery_failure_text(delivery):
    lane_id = delivery.get("laneId") or "?"
    target = delivery.get("target") or "unknown"
    fingerprint = delivery.get("fingerprint") or "unknown"
    reason = delivery.get("failureReason") or "delivery-failed"
    attempts = delivery.get("attempts") or 0
    attempt_suffix = f" after {attempts} attempt" if attempts == 1 else f" after {attempts} attempts"
    return (
        f"btrain delivery failed for lane {lane_id} -> @{target}: "
        f"{reason}{attempt_suffix}. #{fingerprint}"
    )


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
