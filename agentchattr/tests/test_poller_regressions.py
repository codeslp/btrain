"""Regression tests for btrain poller notification and cleanup logic.

Bug 1: First btrain poll should not fire notifications (baseline snapshot).
Bug 2: Cleanup should only trim when exceeding 200 messages per channel,
       and retain the last 200.

Avoids importing app.py and store.py (Python 3.9 union-type compat issue)
by exercising the logic against a minimal in-memory mock.
"""

import threading
import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from btrain.notifications import build_btrain_notification_text


class MockStore:
    """Minimal store mock that mirrors MessageStore's channel-aware get/add."""

    def __init__(self):
        self._messages = []
        self._next_id = 0
        self._lock = threading.Lock()

    def add(self, sender, text, msg_type="chat", channel="general", **kwargs):
        with self._lock:
            msg = {"id": self._next_id, "sender": sender, "text": text,
                   "type": msg_type, "channel": channel}
            self._next_id += 1
            self._messages.append(msg)
            return msg

    def get_recent(self, count=50, channel=None):
        with self._lock:
            msgs = self._messages
            if channel:
                msgs = [m for m in msgs if m.get("channel", "general") == channel]
            return list(msgs[-count:])


class TestFirstPollBaseline(unittest.TestCase):
    """First btrain poll treats lane statuses as baseline — no notifications."""

    def setUp(self):
        self.store = MockStore()
        self.prev_statuses = {}  # simulates app._btrain_prev_statuses on cold start

    def _notify_if_transition(self, lane):
        """Mirror the notification logic from app.py _refresh_btrain_state."""
        lid = lane["_laneId"]
        new_status = lane["status"]
        old_status = self.prev_statuses.get(lid, "")
        owner = lane.get("owner", "")
        reviewer = lane.get("reviewer", "")

        # Fixed condition: old_status must be truthy (skip first-poll baseline)
        if new_status != old_status and old_status:
            if new_status == "needs-review" and reviewer:
                self.store.add("btrain", "@%s lane %s ready for review" % (reviewer, lid),
                               msg_type="system", channel="agents")
            elif new_status == "changes-requested" and owner:
                self.store.add("btrain", "@%s lane %s changes requested" % (owner, lid),
                               msg_type="system", channel="agents")
            elif new_status == "resolved" and old_status == "needs-review" and owner:
                self.store.add("btrain", "@%s lane %s resolved" % (owner, lid),
                               msg_type="system", channel="agents")

        self.prev_statuses[lid] = new_status

    def test_no_notifications_on_first_status_seen(self):
        """When old_status is empty (first poll), no notification should fire."""
        lanes = [
            {"_laneId": "a", "status": "needs-review", "owner": "claude", "reviewer": "codex"},
            {"_laneId": "b", "status": "in-progress", "owner": "codex", "reviewer": "claude"},
            {"_laneId": "c", "status": "changes-requested", "owner": "gemini", "reviewer": "claude",
             "reasonCode": "spec-mismatch"},
        ]

        for lane in lanes:
            self._notify_if_transition(lane)

        agents_msgs = self.store.get_recent(count=999, channel="agents")
        self.assertEqual(len(agents_msgs), 0,
                         "Expected 0 notifications on first poll, got %d: %s"
                         % (len(agents_msgs), [m["text"] for m in agents_msgs]))

    def test_notifications_fire_on_subsequent_transitions(self):
        """After baseline is set, real transitions should fire notifications."""
        # Set baseline (simulates first poll)
        self.prev_statuses["a"] = "in-progress"
        self.prev_statuses["b"] = "needs-review"

        self._notify_if_transition(
            {"_laneId": "a", "status": "needs-review", "owner": "claude", "reviewer": "codex"})
        self._notify_if_transition(
            {"_laneId": "b", "status": "resolved", "owner": "codex", "reviewer": "claude"})

        agents_msgs = self.store.get_recent(count=999, channel="agents")
        self.assertEqual(len(agents_msgs), 2, "Expected 2 notifications for real transitions")

    def test_same_status_no_notification(self):
        """Re-polling the same status should not fire duplicate notifications."""
        self.prev_statuses["a"] = "in-progress"
        self._notify_if_transition(
            {"_laneId": "a", "status": "in-progress", "owner": "claude", "reviewer": "codex"})

        agents_msgs = self.store.get_recent(count=999, channel="agents")
        self.assertEqual(len(agents_msgs), 0, "Same status should not notify")


class TestBtrainNotificationHelpers(unittest.TestCase):
    def setUp(self):
        self.agents_cfg = {
            "claude": {"label": "Claude"},
            "codex": {"label": "Codex"},
            "gemini": {"label": "Gemini"},
        }

    def test_in_progress_transition_notifies_owner(self):
        lane = {
            "_laneId": "a",
            "status": "in-progress",
            "owner": "claude",
            "reviewer": "codex",
            "task": "Fix the handoff wake-up",
        }

        notify_text = build_btrain_notification_text(
            lane,
            previous_status="resolved",
            agents_cfg=self.agents_cfg,
        )

        self.assertIn("@claude lane a", notify_text)
        self.assertIn("btrain handoff --lane a #", notify_text)

    def test_gpt_reviewer_alias_maps_to_codex(self):
        lane = {
            "_laneId": "b",
            "status": "needs-review",
            "owner": "Claude",
            "reviewer": "GPT",
            "task": "Review alias handling",
        }

        notify_text = build_btrain_notification_text(
            lane,
            previous_status="in-progress",
            agents_cfg=self.agents_cfg,
        )

        self.assertTrue(notify_text.startswith("@codex lane b ready for review."), notify_text)


def _run_cleanup(messages, channel, threshold=200):
    """Mirror the cleanup logic from app.py _cleanup_runner.

    Operates on a flat list of message dicts. Returns (remaining, trimmed_count).
    """
    ch_msgs = [m for m in messages if m.get("channel", "general") == channel]
    if len(ch_msgs) <= threshold:
        return messages, 0

    trimmed = len(ch_msgs) - threshold
    ids_to_keep = {m["id"] for m in ch_msgs[-threshold:]}
    remaining = [m for m in messages
                 if m.get("channel", "general") != channel
                 or m["id"] in ids_to_keep]
    return remaining, trimmed


class TestCleanupRetention(unittest.TestCase):
    """Cleanup should retain 200 messages per channel, only trim above 200."""

    @staticmethod
    def _make_msgs(count, channel="general", start_id=0):
        return [{"id": start_id + i, "text": "msg %d" % i, "channel": channel}
                for i in range(count)]

    def test_no_trim_at_101_messages(self):
        """101 messages should NOT trigger cleanup (old bug: trimmed at >100)."""
        msgs = self._make_msgs(101)
        remaining, trimmed = _run_cleanup(msgs, "general")
        self.assertEqual(trimmed, 0)
        self.assertEqual(len(remaining), 101)

    def test_no_trim_at_200_messages(self):
        """Exactly 200 messages should NOT trigger cleanup."""
        msgs = self._make_msgs(200)
        remaining, trimmed = _run_cleanup(msgs, "general")
        self.assertEqual(trimmed, 0)
        self.assertEqual(len(remaining), 200)

    def test_trim_at_201_retains_200(self):
        """201 messages should trigger cleanup, retaining exactly 200."""
        msgs = self._make_msgs(201)
        remaining, trimmed = _run_cleanup(msgs, "general")
        self.assertEqual(trimmed, 1)
        ch_remaining = [m for m in remaining if m["channel"] == "general"]
        self.assertEqual(len(ch_remaining), 200)

    def test_trim_at_300_retains_200(self):
        """300 messages should trim 100, retaining 200."""
        msgs = self._make_msgs(300)
        remaining, trimmed = _run_cleanup(msgs, "general")
        self.assertEqual(trimmed, 100)
        ch_remaining = [m for m in remaining if m["channel"] == "general"]
        self.assertEqual(len(ch_remaining), 200)
        texts = [m["text"] for m in ch_remaining]
        self.assertIn("msg 299", texts, "Most recent message should be retained")
        self.assertIn("msg 100", texts, "Message 100 should be retained (200th from end)")
        self.assertNotIn("msg 99", texts, "Message 99 should have been trimmed")

    def test_other_channels_unaffected_by_trim(self):
        """Trimming one channel should not affect messages in another."""
        general = self._make_msgs(250, channel="general", start_id=0)
        agents = self._make_msgs(50, channel="agents", start_id=1000)
        msgs = general + agents

        remaining, trimmed = _run_cleanup(msgs, "general")
        general_after = [m for m in remaining if m["channel"] == "general"]
        agents_after = [m for m in remaining if m["channel"] == "agents"]
        self.assertEqual(trimmed, 50)
        self.assertEqual(len(general_after), 200)
        self.assertEqual(len(agents_after), 50, "agents channel should be untouched")


if __name__ == "__main__":
    unittest.main()
