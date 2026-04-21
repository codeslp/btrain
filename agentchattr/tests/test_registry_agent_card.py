"""Tests for repo-local Agent Card metadata plumbing.

Covers the shape defined in registry.py (AgentCard), the set/get/list
methods on RuntimeRegistry, and the consumption points in router.py and
btrain/context.py. The Agent Card fields are routing hints and context
summaries; they do not alter existing registration or routing decisions.
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from btrain.context import format_agent_card_summary, format_lane_context_from_json
from registry import AgentCard, RuntimeRegistry
from router import Router


class TestAgentCardRegistry(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.reg = RuntimeRegistry(data_dir=self.tmpdir)
        self.reg.seed({
            "claude": {"label": "Claude", "color": "#da7756"},
            "codex": {"label": "Codex", "color": "#10a37f"},
        })

    def test_register_default_card_is_empty(self):
        self.reg.register("claude")
        card = self.reg.get_card("claude")
        self.assertEqual(card, {
            "runner": "",
            "role": "",
            "lane_affinity": "",
            "capabilities": [],
            "readiness": "",
        })

    def test_inst_dict_includes_card(self):
        self.reg.register("claude")
        inst = self.reg.get_instance("claude")
        self.assertIn("card", inst)
        self.assertEqual(inst["card"]["runner"], "")

    def test_set_card_from_dict(self):
        self.reg.register("claude")
        ok = self.reg.set_card("claude", {
            "runner": "claude-opus",
            "role": "reviewer",
            "lane_affinity": "b",
            "capabilities": ["review", "test-author"],
            "readiness": "ready",
        })
        self.assertTrue(ok)
        card = self.reg.get_card("claude")
        self.assertEqual(card["runner"], "claude-opus")
        self.assertEqual(card["role"], "reviewer")
        self.assertEqual(card["lane_affinity"], "b")
        self.assertEqual(card["capabilities"], ["review", "test-author"])
        self.assertEqual(card["readiness"], "ready")

    def test_set_card_accepts_agent_card_instance(self):
        self.reg.register("codex")
        ok = self.reg.set_card("codex", AgentCard(runner="gpt-5-codex", role="writer"))
        self.assertTrue(ok)
        card = self.reg.get_card("codex")
        self.assertEqual(card["runner"], "gpt-5-codex")
        self.assertEqual(card["role"], "writer")

    def test_set_card_on_unknown_instance_returns_false(self):
        self.assertFalse(self.reg.set_card("ghost", {"runner": "unknown"}))

    def test_get_card_on_unknown_instance_returns_none(self):
        self.assertIsNone(self.reg.get_card("ghost"))

    def test_get_agent_cards_covers_all_registered(self):
        self.reg.register("claude")
        self.reg.register("codex")
        self.reg.set_card("claude", {"runner": "claude-opus"})
        cards = self.reg.get_agent_cards()
        self.assertEqual(set(cards.keys()), {"claude", "codex"})
        self.assertEqual(cards["claude"]["runner"], "claude-opus")
        self.assertEqual(cards["codex"]["runner"], "")

    def test_set_card_partial_dict_fills_defaults(self):
        self.reg.register("claude")
        self.reg.set_card("claude", {"role": "writer"})
        card = self.reg.get_card("claude")
        self.assertEqual(card["role"], "writer")
        self.assertEqual(card["runner"], "")
        self.assertEqual(card["capabilities"], [])

    def test_set_card_replaces_previous(self):
        self.reg.register("claude")
        self.reg.set_card("claude", {"role": "writer", "runner": "claude-opus"})
        self.reg.set_card("claude", {"role": "reviewer"})
        card = self.reg.get_card("claude")
        self.assertEqual(card["role"], "reviewer")
        self.assertEqual(card["runner"], "")

    def test_register_behavior_unchanged_by_card_fields(self):
        result = self.reg.register("claude", repo="/x/btrain")
        self.assertEqual(result["name"], "claude")
        self.assertEqual(result["repo"], "/x/btrain")
        # Card still appears in the registration result for consumers that want it.
        self.assertIn("card", result)

    def test_ignores_invalid_card_payload(self):
        self.reg.register("claude")
        ok = self.reg.set_card("claude", "not-a-card")
        self.assertTrue(ok)
        self.assertEqual(self.reg.get_card("claude")["runner"], "")

    def test_scalar_string_capabilities_stays_single_item(self):
        """Regression: 'review' must not iterate into ('r','e','v','i','e','w')."""
        self.reg.register("claude")
        self.reg.set_card("claude", {"capabilities": "review"})
        card = self.reg.get_card("claude")
        self.assertEqual(card["capabilities"], ["review"])

    def test_bytes_capabilities_stays_single_item(self):
        self.reg.register("claude")
        self.reg.set_card("claude", {"capabilities": b"test-author"})
        card = self.reg.get_card("claude")
        self.assertEqual(card["capabilities"], ["test-author"])

    def test_none_capabilities_becomes_empty(self):
        self.reg.register("claude")
        self.reg.set_card("claude", {"capabilities": None})
        self.assertEqual(self.reg.get_card("claude")["capabilities"], [])

    def test_set_capabilities_preserves_list_order(self):
        self.reg.register("claude")
        self.reg.set_card("claude", {"capabilities": ["review", "test-author", "repair"]})
        card = self.reg.get_card("claude")
        self.assertEqual(card["capabilities"], ["review", "test-author", "repair"])

    def test_non_iterable_capabilities_becomes_single_item(self):
        """Numbers and other oddball payloads coerce to a single string capability."""
        self.reg.register("claude")
        self.reg.set_card("claude", {"capabilities": 42})
        self.assertEqual(self.reg.get_card("claude")["capabilities"], ["42"])


class TestRouterCardConsumption(unittest.TestCase):
    def test_describe_target_returns_none_without_lookup(self):
        router = Router(agent_names=["claude", "codex"])
        self.assertIsNone(router.describe_target("claude"))

    def test_describe_target_uses_lookup(self):
        router = Router(
            agent_names=["claude", "codex"],
            card_lookup=lambda name: {"runner": f"{name}-runtime"} if name == "claude" else None,
        )
        self.assertEqual(router.describe_target("claude"), {"runner": "claude-runtime"})
        self.assertIsNone(router.describe_target("codex"))

    def test_describe_target_swallows_lookup_errors(self):
        def boom(_name):
            raise RuntimeError("lookup failed")
        router = Router(agent_names=["claude"], card_lookup=boom)
        self.assertIsNone(router.describe_target("claude"))

    def test_set_card_lookup_installs_after_construction(self):
        router = Router(agent_names=["claude"])
        router.set_card_lookup(lambda name: {"runner": "x"})
        self.assertEqual(router.describe_target("claude"), {"runner": "x"})

    def test_card_lookup_does_not_alter_routing(self):
        router = Router(
            agent_names=["claude", "codex"],
            card_lookup=lambda name: {"readiness": "blocked"},
        )
        # A human @mention still routes to the mentioned agent even when the
        # card reports a non-ready readiness: the router is read-only here.
        targets = router.get_targets("human", "hey @claude ping", channel="#c1")
        self.assertEqual(targets, ["claude"])


class TestAgentCardContextSummary(unittest.TestCase):
    def test_empty_card_returns_empty_string(self):
        self.assertEqual(format_agent_card_summary(None), "")
        self.assertEqual(format_agent_card_summary({}), "")
        self.assertEqual(
            format_agent_card_summary({
                "runner": "", "role": "", "lane_affinity": "",
                "capabilities": [], "readiness": "",
            }),
            "",
        )

    def test_summary_scalar_string_capabilities_renders_once(self):
        """Regression: summary must not render 'review' as caps=r,e,v,i,e,w."""
        summary = format_agent_card_summary({"capabilities": "review"})
        self.assertEqual(summary, "CARD caps=review")

    def test_summary_bytes_capabilities_renders_once(self):
        summary = format_agent_card_summary({"capabilities": b"review"})
        self.assertEqual(summary, "CARD caps=review")

    def test_summary_includes_only_set_fields(self):
        summary = format_agent_card_summary({
            "runner": "claude-opus",
            "role": "",
            "lane_affinity": "b",
            "capabilities": ["review"],
            "readiness": "",
        })
        self.assertEqual(summary, "CARD runner=claude-opus lane=b caps=review")

    def test_summary_threads_into_lane_context(self):
        lane = {
            "_laneId": "b",
            "task": "Refocus spec",
            "status": "needs-review",
            "owner": "codex",
            "reviewer": "claude",
            "lockedFiles": ["specs/009.md"],
        }
        rendered = format_lane_context_from_json(
            lane,
            role="reviewer",
            agent_card={"runner": "claude-opus", "role": "reviewer"},
        )
        self.assertIn("LANE b: needs-review", rendered)
        self.assertIn("CARD runner=claude-opus role=reviewer", rendered)

    def test_lane_context_without_card_is_unchanged(self):
        lane = {
            "_laneId": "a",
            "task": "",
            "status": "idle",
            "owner": "claude",
            "reviewer": "codex",
            "lockedFiles": [],
        }
        baseline = format_lane_context_from_json(lane, role="writer")
        with_empty_card = format_lane_context_from_json(lane, role="writer", agent_card={})
        self.assertEqual(baseline, with_empty_card)


if __name__ == "__main__":
    unittest.main()
