"""btrain lane-drift validation for agentchattr messages."""

from __future__ import annotations

import re


class btrainValidator:
    """Detects drift or rule violations by checking message text against lane state."""

    def __init__(self):
        self._claim_patterns = [
            re.compile(r"\b(i'll|i will|i am|claiming|taking)\b.*\b(task|lane|work|issue)\b", re.I),
            re.compile(r"\b(starting|working on)\b.*\b(lane|task)\b", re.I),
        ]
        self._handoff_patterns = [
            re.compile(r"\b(handing off|ready for review|finished|completed)\b", re.I),
            re.compile(r"\bbtrain\s+handoff\b", re.I),
        ]
        self._review_patterns = [
            re.compile(r"\bbtrain\s+handoff\s+(resolve|request-changes)\b", re.I),
            re.compile(r"\b(reviewing|reviewed|approved?)\b", re.I),
            re.compile(r"\b(requesting changes|changes requested)\b", re.I),
        ]
        self._owner_progress_statuses = {"in-progress", "changes-requested", "repair-needed"}
        self._lane_flag_pattern = re.compile(r"\b--lane\s+([a-z0-9]+)\b", re.I)
        self._lane_text_pattern = re.compile(r"\blane\s+([a-z0-9]+)\b", re.I)

    def validate(self, sender: str, text: str, channel: str, btrain_lanes: list[dict]) -> list[str]:
        """Check for contradictions between chat claims and canonical btrain state."""
        warnings = []
        sender_lower = sender.lower()

        lane_id = self._extract_lane_id(text, channel)
        if not lane_id:
            return []

        lane = next((lane for lane in btrain_lanes if lane.get("_laneId", "").lower() == lane_id), None)
        if not lane:
            return []

        status = lane.get("status", "idle")
        owner = (lane.get("owner") or "").lower()
        reviewer = (lane.get("reviewer") or "").lower()

        if self._is_claiming(text) and owner and owner != sender_lower and status not in {"resolved", "idle"}:
            warnings.append(
                f"Conflict: @{sender} is claiming lane {lane_id}, but it is currently locked by @{owner}."
            )

        is_handoff = self._matches_any(self._handoff_patterns, text)
        is_review_action = self._matches_any(self._review_patterns, text)
        if not is_handoff and not is_review_action:
            return warnings

        if status == "needs-review":
            if is_review_action and reviewer and reviewer != sender_lower:
                warnings.append(self._reviewer_drift_warning(sender, lane_id, reviewer))
            if not is_review_action and owner and owner != sender_lower:
                warnings.append(self._owner_drift_warning(sender, lane_id, owner))
            return warnings

        if owner and owner != sender_lower and status in self._owner_progress_statuses:
            warnings.append(self._owner_drift_warning(sender, lane_id, owner))

        return warnings

    def _extract_lane_id(self, text: str, channel: str) -> str:
        explicit_match = self._lane_flag_pattern.search(text) or self._lane_text_pattern.search(text)
        if explicit_match:
            return explicit_match.group(1).lower()

        if channel.startswith("#") and len(channel) == 2:
            return channel.lstrip("#").lower()

        return ""

    def _is_claiming(self, text: str) -> bool:
        return self._matches_any(self._claim_patterns, text)

    def _matches_any(self, patterns: list[re.Pattern], text: str) -> bool:
        return any(pattern.search(text) for pattern in patterns)

    def _owner_drift_warning(self, sender: str, lane_id: str, owner: str) -> str:
        return f"Drift: @{sender} is reporting progress on lane {lane_id}, but the canonical owner is @{owner}."

    def _reviewer_drift_warning(self, sender: str, lane_id: str, reviewer: str) -> str:
        return f"Drift: @{sender} is acting on a review for lane {lane_id}, but the canonical reviewer is @{reviewer}."
