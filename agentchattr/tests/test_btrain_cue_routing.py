"""Regression tests for btrain cue target resolution.

Bug: repo-scoped channels can watch multiple repos at once. A cue or message
for one repo (for example "btrain/agents") must not wake a same-family agent
registered for another repo (for example a claude serving "cgraph"). The
wrapper must preserve repo isolation for automated btrain cues and user
@mentions alike.
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from btrain.routing import resolve_poller_cue_targets, resolve_repo_agent
from registry import RuntimeRegistry


class TestBtrainCueRepoIsolation(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.registry = RuntimeRegistry(data_dir=self.tmpdir.name)
        self.registry.seed({
            "claude": {"label": "Claude", "color": "#da7756"},
            "codex": {"label": "Codex", "color": "#10a37f"},
        })

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_cue_does_not_fall_back_to_other_repo_family_instance(self):
        """btrain poller cue for one repo must not wake a family instance elsewhere."""
        self.registry.register("claude", repo="/abs/cgraph")

        target = resolve_repo_agent(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )

        self.assertIsNone(target)

    def test_cue_prefers_repo_match_when_both_exist(self):
        """An exact repo match wins when another family instance also exists."""
        self.registry.register("claude", repo="/abs/cgraph")
        self.registry.register("claude", repo="/abs/btrain")

        target = resolve_repo_agent(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )

        inst = self.registry.get_instance(target)
        self.assertIsNotNone(inst)
        self.assertEqual(inst["repo"], "/abs/btrain")

    def test_cue_does_not_use_unbound_instance_for_repo_scoped_channel(self):
        """Unbound instances are only valid for unscoped channels."""
        self.registry.register("claude", repo="")

        target = resolve_repo_agent(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )

        self.assertIsNone(target)

    def test_cue_returns_none_when_no_family_instance_anywhere(self):
        """No registered repo match means no delivery."""
        target = resolve_repo_agent(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )

        self.assertIsNone(target)


class TestUserMentionRemainsStrict(unittest.TestCase):
    """Regression guard: human @mentions must not leak across repos."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.registry = RuntimeRegistry(data_dir=self.tmpdir.name)
        self.registry.seed({
            "claude": {"label": "Claude", "color": "#da7756"},
        })

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_strict_resolver_rejects_cross_repo_mention(self):
        """A user typing @claude in btrain/agents must not wake cgraph's claude."""
        self.registry.register("claude", repo="/abs/cgraph")

        target = resolve_repo_agent(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )

        self.assertIsNone(target)

    def test_strict_resolver_returns_repo_match(self):
        self.registry.register("claude", repo="/abs/cgraph")

        target = resolve_repo_agent(
            "claude",
            "/abs/cgraph",
            registry=self.registry,
        )

        inst = self.registry.get_instance(target)
        self.assertEqual(inst["repo"], "/abs/cgraph")

    def test_strict_resolver_without_repo_scope_picks_family_instance(self):
        """Single-repo mode (repo_path='') falls back to family as before."""
        self.registry.register("claude", repo="/abs/cgraph")

        target = resolve_repo_agent(
            "claude",
            "",
            registry=self.registry,
        )

        inst = self.registry.get_instance(target)
        self.assertEqual(inst["base"], "claude")


class TestPollerWiringIntegration(unittest.TestCase):
    """Mirror the exact path _refresh_btrain_state_for_repo takes when a
    btrain lane transition generates a cue.
    """

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.registry = RuntimeRegistry(data_dir=self.tmpdir.name)
        self.registry.seed({
            "claude": {"label": "Claude", "color": "#da7756"},
            "codex": {"label": "Codex", "color": "#10a37f"},
        })

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_poller_cue_does_not_deliver_to_cross_repo_family_instance(self):
        """The observed leak: @claude cue in btrain/agents with all claude
        instances registered for cgraph. The poller must not deliver to those
        cgraph instances.
        """
        self.registry.register("claude", repo="/abs/cgraph")
        self.registry.register("claude", repo="/abs/cgraph")

        targets = resolve_poller_cue_targets(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )

        self.assertEqual(targets, [])

    def test_poller_cue_returns_empty_when_no_instances_at_all(self):
        """With no claude anywhere, delivery truly can't happen — empty list."""
        targets = resolve_poller_cue_targets(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )
        self.assertEqual(targets, [])

    def test_poller_cue_picks_repo_match_when_available(self):
        """Don't wake the wrong agent if a correct one is available."""
        self.registry.register("claude", repo="/abs/cgraph")
        self.registry.register("claude", repo="/abs/btrain")

        targets = resolve_poller_cue_targets(
            "claude",
            "/abs/btrain",
            registry=self.registry,
        )

        self.assertEqual(len(targets), 1)
        inst = self.registry.get_instance(targets[0])
        self.assertEqual(inst["repo"], "/abs/btrain")


if __name__ == "__main__":
    unittest.main()
