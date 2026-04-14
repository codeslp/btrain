"""Unit and integration tests for btrain notification routing."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from btrain.notifications import build_btrain_notification_text, resolve_btrain_agent_handle
from registry import RuntimeRegistry


class TestResolveBtrainAgentHandle(unittest.TestCase):
    def setUp(self):
        self.agents_cfg = {
            "claude": {"label": "Claude"},
            "codex": {"label": "Codex"},
            "gemini": {"label": "Gemini"},
        }

    def test_maps_runtime_alias_to_codex_family(self):
        self.assertEqual(
            resolve_btrain_agent_handle("GPT", agents_cfg=self.agents_cfg),
            "codex",
        )

    def test_returns_normalized_name_when_no_alias_matches(self):
        self.assertEqual(
            resolve_btrain_agent_handle("Reviewer Alpha", agents_cfg=self.agents_cfg),
            "reviewer-alpha",
        )


class TestBtrainNotificationRoutingIntegration(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.registry = RuntimeRegistry(data_dir=self.tmpdir.name)
        self.agents_cfg = {
            "claude": {"label": "Claude", "color": "#da7756"},
            "codex": {"label": "Codex", "color": "#10a37f"},
            "gemini": {"label": "Gemini", "color": "#4285f4"},
        }
        self.registry.seed(self.agents_cfg)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_custom_registry_label_routes_back_to_codex_family(self):
        registration = self.registry.register("codex")
        self.assertIsNotNone(registration)
        renamed = self.registry.rename("codex", "codex-prime", "GPT Prime")
        self.assertIsInstance(renamed, dict)

        lane = {
            "_laneId": "a",
            "status": "needs-review",
            "owner": "claude",
            "reviewer": "GPT Prime",
            "task": "Review alias routing",
        }

        notify_text = build_btrain_notification_text(
            lane,
            previous_status="in-progress",
            agents_cfg=self.agents_cfg,
            registry=self.registry,
        )

        self.assertTrue(notify_text.startswith("@codex-prime lane a ready for review."), notify_text)
        self.assertEqual(self.registry.resolve_to_instances("codex-prime"), ["codex-prime"])

    def test_family_mention_resolves_to_active_instances_after_slot_split(self):
        first = self.registry.register("codex")
        second = self.registry.register("codex")
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)

        lane = {
            "_laneId": "b",
            "status": "needs-review",
            "owner": "claude",
            "reviewer": "Codex 2",
            "task": "Review multi-instance routing",
        }

        notify_text = build_btrain_notification_text(
            lane,
            previous_status="in-progress",
            agents_cfg=self.agents_cfg,
            registry=self.registry,
        )

        self.assertTrue(notify_text.startswith("@codex-2 lane b ready for review."), notify_text)
        self.assertCountEqual(self.registry.resolve_to_instances("codex"), ["codex-1", "codex-2"])


if __name__ == "__main__":
    unittest.main()
