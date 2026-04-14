"""Unit tests for btrain conflict detection (Workstream 6)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rules import btrainValidator

class TestBtrainConflict(unittest.TestCase):

    def setUp(self):
        self.validator = btrainValidator()
        self.lanes = [
            {
                "_laneId": "a",
                "task": "Fix bug",
                "status": "in-progress",
                "owner": "claude",
                "reviewer": "codex"
            },
            {
                "_laneId": "b",
                "task": "Review UI",
                "status": "needs-review",
                "owner": "codex",
                "reviewer": "claude"
            },
            {
                "_laneId": "c",
                "task": "(none)",
                "status": "idle",
                "owner": "",
                "reviewer": ""
            }
        ]

    def test_detects_claim_conflict(self):
        # gemini tries to claim lane a which is locked by claude
        warnings = self.validator.validate("gemini", "I will start working on lane a", "#a", self.lanes)
        self.assertTrue(any("Conflict" in w and "@claude" in w for w in warnings))

    def test_allows_valid_claim(self):
        # gemini claims idle lane c
        warnings = self.validator.validate("gemini", "I'm taking task for lane c", "#c", self.lanes)
        self.assertEqual(len(warnings), 0)

    def test_detects_progress_drift(self):
        # gemini reports progress on lane a which is owned by claude
        warnings = self.validator.validate("gemini", "I have completed the work on lane a", "#a", self.lanes)
        self.assertTrue(any("Drift" in w and "@claude" in w for w in warnings))

    def test_detects_review_drift(self):
        # gemini acting as reviewer for lane b which is assigned to claude
        warnings = self.validator.validate("gemini", "btrain handoff resolve --lane b", "#b", self.lanes)
        self.assertTrue(any("Drift" in w and "@claude" in w for w in warnings))

    def test_allows_owner_ready_for_review_follow_up(self):
        warnings = self.validator.validate("codex", "ready for review on lane b", "#b", self.lanes)
        self.assertEqual(warnings, [])

    def test_explicit_lane_target_overrides_channel_lane(self):
        warnings = self.validator.validate("codex", "btrain handoff resolve --lane b", "#a", self.lanes)
        self.assertEqual(len(warnings), 1)
        self.assertIn("lane b", warnings[0])
        self.assertIn("@claude", warnings[0])

    def test_plain_lane_mention_overrides_channel_lane(self):
        warnings = self.validator.validate("gemini", "reviewing lane b now", "#a", self.lanes)
        self.assertEqual(len(warnings), 1)
        self.assertIn("lane b", warnings[0])
        self.assertIn("@claude", warnings[0])

    def test_lane_mention_in_general(self):
        # Detection works in #general if lane is explicitly mentioned
        warnings = self.validator.validate("gemini", "I am starting lane a", "general", self.lanes)
        self.assertTrue(any("Conflict" in w and "lane a" in w for w in warnings))

if __name__ == "__main__":
    unittest.main()
