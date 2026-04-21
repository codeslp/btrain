"""Regression tests for btrain poller notification and cleanup logic.

Bug 1: First btrain poll should not fire notifications (baseline snapshot).
Bug 2: Cleanup should only trim when exceeding 200 messages per channel,
       and retain the last 200.

Avoids importing app.py and store.py (Python 3.9 union-type compat issue)
by exercising the logic against a minimal in-memory mock.
"""

import json
import tempfile
import threading
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from btrain.notifications import (
    acknowledge_btrain_delivery,
    advance_btrain_deliveries,
    build_btrain_notification_text,
    create_btrain_delivery,
)
from agents import AgentTrigger
from wrapper import _extract_delivery_ids, _queue_watcher, _report_btrain_delivery_ack


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


class MockAgents:
    """Track trigger_sync calls."""

    def __init__(self):
        self.triggers = []

    def trigger_sync(self, agent_name, message="", channel="general", **kwargs):
        self.triggers.append({"agent": agent_name, "message": message, "channel": channel, "kwargs": kwargs})

    def is_available(self, name):
        return True


class TestPollerTriggersAgentOnNotification(unittest.TestCase):
    """btrain poller must trigger agents when it writes @mention notifications."""

    def setUp(self):
        self.store = MockStore()
        self.agents = MockAgents()
        self.prev_statuses = {}
        self.deliveries = {}

    def _notify_and_trigger(self, lane):
        """Mirror the notification + trigger logic that should exist in the poller."""
        lid = lane["_laneId"]
        new_status = lane["status"]
        old_status = self.prev_statuses.get(lid, "")
        self.prev_statuses[lid] = new_status

        notify_text = build_btrain_notification_text(
            lane,
            previous_status=old_status,
            agents_cfg={"claude": {"label": "Claude"}, "codex": {"label": "Codex"}},
        )

        if notify_text and self.store:
            recent = self.store.get_recent(count=30, channel="agents")
            lane_fingerprint = notify_text.rsplit("#", 1)[-1]
            exists = any(
                m.get("sender") == "btrain" and ("#%s" % lane_fingerprint) in m.get("text", "")
                for m in recent
            )
            if not exists:
                self.store.add("btrain", notify_text, channel="agents")
                # Extract @mentioned agent and trigger
                if notify_text.startswith("@"):
                    target = notify_text.split()[0][1:]  # strip @
                    if self.agents.is_available(target):
                        delivery = create_btrain_delivery(
                            lane,
                            notify_text=notify_text,
                            target=target,
                            channel="agents",
                            now=0,
                        )
                        self.deliveries[delivery["id"]] = delivery
                        self.agents.trigger_sync(
                            target,
                            message="btrain: %s" % notify_text,
                            channel="agents",
                            delivery_id=delivery["id"],
                        )

    def test_needs_review_triggers_reviewer(self):
        self.prev_statuses["a"] = "in-progress"
        self._notify_and_trigger({
            "_laneId": "a", "status": "needs-review",
            "owner": "claude", "reviewer": "codex",
        })
        self.assertEqual(len(self.agents.triggers), 1)
        self.assertEqual(self.agents.triggers[0]["agent"], "codex")
        delivery_id = self.agents.triggers[0]["kwargs"].get("delivery_id", "")
        self.assertTrue(delivery_id)
        self.assertIn(delivery_id, self.deliveries)

    def test_in_progress_triggers_owner(self):
        self.prev_statuses["b"] = "resolved"
        self._notify_and_trigger({
            "_laneId": "b", "status": "in-progress",
            "owner": "claude", "reviewer": "codex",
        })
        self.assertEqual(len(self.agents.triggers), 1)
        self.assertEqual(self.agents.triggers[0]["agent"], "claude")

    def test_no_trigger_on_first_poll(self):
        self._notify_and_trigger({
            "_laneId": "c", "status": "needs-review",
            "owner": "claude", "reviewer": "codex",
        })
        self.assertEqual(len(self.agents.triggers), 0)

    def test_no_duplicate_trigger_on_repoll(self):
        self.prev_statuses["a"] = "in-progress"
        self._notify_and_trigger({
            "_laneId": "a", "status": "needs-review",
            "owner": "claude", "reviewer": "codex",
        })
        # Second poll with same state
        self._notify_and_trigger({
            "_laneId": "a", "status": "needs-review",
            "owner": "claude", "reviewer": "codex",
        })
        self.assertEqual(len(self.agents.triggers), 1, "Should not re-trigger on same fingerprint")
        self.assertEqual(len(self.deliveries), 1, "Should not create duplicate delivery records")


class TestBtrainDeliveryTracking(unittest.TestCase):
    def test_matching_wrapper_acknowledges_delivery(self):
        lane = {"_laneId": "a", "status": "needs-review", "owner": "claude", "reviewer": "codex"}
        delivery = create_btrain_delivery(lane, notify_text="@codex lane a ready for review. btrain handoff --lane a #abc", target="codex", now=10)
        deliveries = {delivery["id"]: delivery}

        acknowledged = acknowledge_btrain_delivery(deliveries, delivery["id"], agent_name="codex", now=12)

        self.assertIsNotNone(acknowledged)
        self.assertEqual(acknowledged["status"], "acknowledged")
        self.assertEqual(acknowledged["acknowledgedAt"], 12)

    def test_unacknowledged_delivery_retries_then_fails(self):
        lane = {"_laneId": "a", "status": "needs-review", "owner": "claude", "reviewer": "codex"}
        delivery = create_btrain_delivery(
            lane,
            notify_text="@codex lane a ready for review. btrain handoff --lane a #abc",
            target="codex",
            now=0,
            ack_timeout_sec=5,
            max_attempts=2,
        )
        deliveries = {delivery["id"]: delivery}

        retry_actions = advance_btrain_deliveries(deliveries, lanes=[lane], now=6)
        self.assertEqual(len(retry_actions["retry"]), 1)
        self.assertEqual(deliveries[delivery["id"]]["status"], "retrying")
        self.assertEqual(deliveries[delivery["id"]]["attempts"], 2)

        failure_actions = advance_btrain_deliveries(deliveries, lanes=[lane], now=12)
        self.assertEqual(len(failure_actions["failed"]), 1)
        self.assertEqual(deliveries[delivery["id"]]["status"], "failed")
        self.assertEqual(deliveries[delivery["id"]]["failureReason"], "ack-timeout")

    def test_lane_change_supersedes_pending_delivery(self):
        original_lane = {"_laneId": "a", "status": "needs-review", "owner": "claude", "reviewer": "codex"}
        updated_lane = {"_laneId": "a", "status": "resolved", "owner": "claude", "reviewer": "codex"}
        delivery = create_btrain_delivery(
            original_lane,
            notify_text="@codex lane a ready for review. btrain handoff --lane a #abc",
            target="codex",
            now=0,
            ack_timeout_sec=5,
            max_attempts=2,
        )
        deliveries = {delivery["id"]: delivery}

        actions = advance_btrain_deliveries(deliveries, lanes=[updated_lane], now=6)

        self.assertEqual(len(actions["superseded"]), 1)
        self.assertEqual(deliveries[delivery["id"]]["status"], "superseded")


class TestWrapperDeliveryAckHelpers(unittest.TestCase):
    def test_extract_delivery_ids_deduplicates(self):
        lines = [
            json.dumps({"delivery_id": "abc123", "channel": "agents"}),
            json.dumps({"delivery_id": "abc123", "channel": "agents"}),
            "not-json",
            json.dumps({"delivery_id": "def456", "channel": "agents"}),
        ]

        delivery_ids = _extract_delivery_ids(lines)

        self.assertEqual(delivery_ids, ["abc123", "def456"])

    @patch("urllib.request.urlopen")
    def test_report_btrain_delivery_ack_posts_expected_payload(self, mock_urlopen):
        _report_btrain_delivery_ack(8300, "codex", ["abc123", "def456"], token="test-token")

        request = mock_urlopen.call_args[0][0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8300/api/btrain/delivery-ack")
        self.assertEqual(json.loads(request.data.decode("utf-8")), {"agent": "codex", "delivery_ids": ["abc123", "def456"]})
        headers = dict(request.header_items())
        self.assertEqual(headers.get("Authorization"), "Bearer test-token")


class TestQueueWatcherFirstTouchReminder(unittest.TestCase):
    def test_queue_watcher_injects_reminder_when_btrain_context_is_missing(self):
        injected = []

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            (tmp_path / "data").mkdir()
            queue_file = tmp_path / "codex_queue.jsonl"
            queue_file.write_text(json.dumps({"channel": "agents"}) + "\n", "utf-8")

            def fake_sleep(seconds):
                if seconds == 1:
                    raise KeyboardInterrupt()

            with patch("wrapper.ROOT", tmp_path), \
                    patch("wrapper._fetch_recent_messages", return_value="  user: ping"), \
                    patch("wrapper._fetch_role", return_value=""), \
                    patch("wrapper._fetch_active_rules", return_value=None), \
                    patch("wrapper._resolve_repo_root", return_value="/tmp/repo"), \
                    patch("wrapper._fetch_btrain_context", return_value=""), \
                    patch("wrapper.time.sleep", side_effect=fake_sleep):
                with self.assertRaises(KeyboardInterrupt):
                    _queue_watcher(
                        lambda: ("codex", queue_file),
                        injected.append,
                        agent_name="codex",
                        get_token_fn=lambda: "",
                        cwd=tmpdir,
                    )

        self.assertEqual(len(injected), 1)
        self.assertIn("Run btrain handoff.", injected[0])
        self.assertIn("REMINDER: No recent btrain context was found for this repo.", injected[0])
        self.assertIn("btrain startup --repo /tmp/repo", injected[0])


class TestDeliveryIdComposition(unittest.TestCase):
    def test_delivery_id_round_trips_from_trigger_to_ack(self):
        lane = {"_laneId": "a", "status": "needs-review", "owner": "claude", "reviewer": "codex"}
        delivery = create_btrain_delivery(
            lane,
            notify_text="@codex lane a ready for review. btrain handoff --lane a #abc",
            target="codex",
            now=0,
        )
        deliveries = {delivery["id"]: delivery}

        with tempfile.TemporaryDirectory() as tmpdir:
            trigger = AgentTrigger(registry=object(), data_dir=tmpdir)
            trigger.trigger_sync(
                "codex",
                message="btrain: @codex lane a ready for review. btrain handoff --lane a #abc",
                channel="agents",
                delivery_id=delivery["id"],
            )

            queue_file = Path(tmpdir) / "codex_queue.jsonl"
            queue_lines = queue_file.read_text("utf-8").splitlines()

        self.assertEqual(_extract_delivery_ids(queue_lines), [delivery["id"]])

        acknowledged = acknowledge_btrain_delivery(deliveries, delivery["id"], agent_name="codex", now=3)
        self.assertIsNotNone(acknowledged)
        self.assertEqual(acknowledged["status"], "acknowledged")


class MockRegistry:
    """Minimal registry mock for repo-scoped resolution tests."""

    def __init__(self, instances):
        # instances: list of dicts with name, base, repo, state
        self._instances = {i["name"]: i for i in instances}

    def find_instance(self, base, repo=""):
        for inst in self._instances.values():
            if inst["base"] == base and inst["repo"] == repo:
                return inst
        return None

    def get_instance(self, name):
        return self._instances.get(name)

    def get_instances_for(self, base):
        return [i for i in self._instances.values() if i["base"] == base]

    def resolve_to_instances(self, name):
        if name in self._instances:
            return [name]
        members = [i["name"] for i in self._instances.values()
                   if i["base"] == name and i.get("state") == "active"]
        return members if members else [name]


def _resolve_repo_agent(target, repo_path, registry):
    """Mirror _resolve_repo_agent from app.py."""
    if not registry:
        return target

    if repo_path:
        inst = registry.find_instance(target, repo=repo_path)
        if inst:
            return inst["name"]
        exact = registry.get_instance(target)
        if exact:
            return target if exact.get("repo") == repo_path else None
        return None

    inst = registry.find_instance(target, repo="")
    if inst:
        return inst["name"]
    instances = registry.get_instances_for(target)
    if instances:
        return instances[0]["name"]
    return target


def _target_matches_repo(target, repo_path, registry):
    """Mirror the final dispatch-time repo guard from app.py."""
    if not repo_path or not registry:
        return True
    inst = registry.get_instance(target)
    return bool(inst and inst.get("repo") == repo_path)


class TestRepoScopedMentionRouting(unittest.TestCase):
    """@mentions in repo-scoped channels must route to the repo-matched instance,
    not fan out to all instances across repos."""

    def setUp(self):
        self.registry = MockRegistry([
            {"name": "claude-1", "base": "claude", "repo": "/repos/btrain", "state": "active"},
            {"name": "claude-2", "base": "claude", "repo": "/repos/cgraph", "state": "active"},
            {"name": "codex-1", "base": "codex", "repo": "/repos/btrain", "state": "active"},
        ])
        self.agents = MockAgents()

    def _resolve_targets(self, raw_targets, repo_path):
        """Mirror the fixed resolution logic from _handle_new_message."""
        targets = []
        for t in raw_targets:
            if repo_path:
                resolved = _resolve_repo_agent(t, repo_path, self.registry)
                if resolved:
                    targets.append(resolved)
            else:
                targets.extend(self.registry.resolve_to_instances(t))
        return list(dict.fromkeys(targets))

    def _dispatch_targets(self, raw_targets, repo_path):
        targets = self._resolve_targets(raw_targets, repo_path)
        return [t for t in targets if _target_matches_repo(t, repo_path, self.registry)]

    def test_repo_scoped_mention_routes_to_matched_instance(self):
        """@claude in cgraph/agents should resolve to claude-2, not both."""
        targets = self._resolve_targets(["claude"], "/repos/cgraph")
        self.assertEqual(targets, ["claude-2"])

    def test_repo_scoped_mention_btrain(self):
        """@claude in btrain/agents should resolve to claude-1."""
        targets = self._resolve_targets(["claude"], "/repos/btrain")
        self.assertEqual(targets, ["claude-1"])

    def test_non_repo_channel_fans_out_to_all_instances(self):
        """@claude in general (no repo) should resolve to both instances."""
        targets = self._resolve_targets(["claude"], "")
        self.assertIn("claude-1", targets)
        self.assertIn("claude-2", targets)

    def test_repo_scoped_multiple_mentions(self):
        """@claude @codex in btrain/agents should resolve to repo-matched instances."""
        targets = self._resolve_targets(["claude", "codex"], "/repos/btrain")
        self.assertEqual(targets, ["claude-1", "codex-1"])

    def test_repo_scoped_missing_repo_instance_is_rejected(self):
        """@claude in mech_ai/agents should not fall back to another repo instance."""
        targets = self._resolve_targets(["claude"], "/repos/mech_ai")
        self.assertEqual(targets, [])

    def test_repo_scoped_explicit_local_instance_allowed(self):
        """Exact instance mentions still work when the instance belongs to the channel repo."""
        targets = self._dispatch_targets(["claude-1"], "/repos/btrain")
        self.assertEqual(targets, ["claude-1"])

    def test_repo_scoped_explicit_foreign_instance_is_rejected(self):
        """Exact instance mentions from another repo must be dropped before dispatch."""
        self.assertFalse(_target_matches_repo("claude-2", "/repos/btrain", self.registry))
        targets = self._dispatch_targets(["claude-2"], "/repos/btrain")
        self.assertEqual(targets, [])

    def test_old_bug_expand_then_resolve_triggers_all(self):
        """Demonstrates the old bug: resolve_to_instances expands to all instances,
        then _resolve_repo_agent on instance names can't filter by repo."""
        # Old behavior: expand first, then try to re-resolve
        old_targets = []
        for t in ["claude"]:
            old_targets.extend(self.registry.resolve_to_instances(t))
        # The buggy path passed those instance names straight through to dispatch,
        # so both repos would be triggered from a repo-scoped channel.
        self.assertEqual(old_targets, ["claude-1", "claude-2"])

        # New behavior: resolve family name directly with repo context
        new_targets = self._resolve_targets(["claude"], "/repos/cgraph")
        self.assertEqual(new_targets, ["claude-2"], "Fixed path triggers only repo-matched instance")


if __name__ == "__main__":
    unittest.main()
