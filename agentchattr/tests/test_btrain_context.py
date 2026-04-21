"""Unit tests for btrain lane context injection helpers.

Tests parsing, formatting, repo resolution, first-touch reminders,
and btrain context fetching from wrapper.py.
"""

import sys
import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from wrapper import (
    _apply_btrain_context_or_reminder,
    _build_btrain_first_touch_reminder,
    _parse_btrain_output,
    _format_lane_context,
    _fetch_btrain_context,
    _resolve_repo_root,
    _split_lane_blocks,
)

# Sample btrain handoff output (multi-lane)
SAMPLE_OUTPUT = """\
repo: btrain
agent check: claude (runtime hints (claude, opus))

--- lane a ---
task: Fix auth bug in login flow
status: in-progress
active agent: claude
peer reviewer: codex
mode: manual
locked files: src/auth.py, src/utils.py
lock state: active
next: Work within the locked files, keep the lane in-progress, and hand off for review when ready.

--- lane b ---
task: Review dashboard rendering
status: needs-review
active agent: codex
peer reviewer: claude
mode: manual
locked files: scripts/serve-dashboard.js
lock state: active
next: Waiting on claude to review the lane.

--- lane c ---
task: (none)
status: idle
active agent: (unassigned)
peer reviewer: (unassigned)
mode: manual
locked files: (none)
lock state: clear
next: Claim the next task for btrain (lane c).
"""

SAMPLE_CHANGES_REQUESTED = """\
repo: btrain
agent check: claude (runtime hints (claude, opus))

--- lane a ---
task: Update specs for REST-only migration
status: changes-requested
active agent: claude
peer reviewer: codex
mode: manual
locked files: specs/
lock state: active
reason code: spec-mismatch
reason tags: sequencing, consistency
next: Address codex's review findings in the same lane and re-handoff for review.
"""


class TestSplitLaneBlocks(unittest.TestCase):

    def test_splits_multi_lane_output(self):
        blocks = _split_lane_blocks(SAMPLE_OUTPUT)
        self.assertEqual(len(blocks), 3)
        self.assertEqual(blocks[0]["_lane_id"], "a")
        self.assertEqual(blocks[1]["_lane_id"], "b")
        self.assertEqual(blocks[2]["_lane_id"], "c")

    def test_extracts_key_values(self):
        blocks = _split_lane_blocks(SAMPLE_OUTPUT)
        lane_a = blocks[0]
        self.assertEqual(lane_a["task"], "Fix auth bug in login flow")
        self.assertEqual(lane_a["status"], "in-progress")
        self.assertEqual(lane_a["active agent"], "claude")
        self.assertEqual(lane_a["peer reviewer"], "codex")
        self.assertEqual(lane_a["locked files"], "src/auth.py, src/utils.py")
        self.assertEqual(lane_a["lock state"], "active")

    def test_empty_output_returns_empty(self):
        self.assertEqual(_split_lane_blocks(""), [])

    def test_no_lane_markers_returns_empty(self):
        self.assertEqual(_split_lane_blocks("some random text\nno lanes here"), [])


class TestParseBtrainOutput(unittest.TestCase):

    def test_matches_writer_on_active_lane(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "claude")
        self.assertIn("LANE a", result)
        self.assertIn("writer", result.lower())
        self.assertIn("Fix auth bug", result)

    def test_matches_reviewer_on_needs_review_lane(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "claude")
        # claude is owner of lane a (in-progress) — that takes priority over reviewer of lane b
        self.assertIn("LANE a", result)

    def test_reviewer_priority_when_not_owner(self):
        # codex is owner of lane b which is needs-review — so codex gets writer-waiting
        result = _parse_btrain_output(SAMPLE_OUTPUT, "codex")
        self.assertIn("LANE b", result)
        self.assertIn("Waiting on claude", result)

    def test_case_insensitive_matching(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "Claude")
        self.assertIn("LANE a", result)

    def test_no_match_returns_empty(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "gemini")
        self.assertEqual(result, "")

    def test_changes_requested_matches_as_writer(self):
        result = _parse_btrain_output(SAMPLE_CHANGES_REQUESTED, "claude")
        self.assertIn("LANE a", result)
        self.assertIn("writer", result.lower())
        self.assertIn("changes-requested", result)


class TestFormatLaneContext(unittest.TestCase):

    def setUp(self):
        self.lane = {
            "_lane_id": "a",
            "task": "Fix auth bug",
            "status": "in-progress",
            "active agent": "claude",
            "peer reviewer": "codex",
            "locked files": "src/auth.py",
            "next": "Work within the locked files.",
        }

    def test_contains_lane_fields(self):
        result = _format_lane_context(self.lane, "writer")
        self.assertIn("LANE a", result)
        self.assertIn("Fix auth bug", result)
        self.assertIn("in-progress", result)
        self.assertIn("claude", result)
        self.assertIn("codex", result)
        self.assertIn("src/auth.py", result)

    def test_writer_role_includes_review_instruction(self):
        result = _format_lane_context(self.lane, "writer")
        self.assertIn("writer", result.lower())
        self.assertIn("needs-review", result)

    def test_reviewer_role_includes_resolve_command(self):
        result = _format_lane_context(self.lane, "reviewer")
        self.assertIn("reviewer", result.lower())
        self.assertIn("btrain handoff resolve", result)

    def test_writer_waiting_mentions_reviewer(self):
        result = _format_lane_context(self.lane, "writer-waiting")
        self.assertIn("codex", result)

    def test_compact_format(self):
        """New format should be under 50 words."""
        result = _format_lane_context(self.lane, "writer")
        word_count = len(result.split())
        self.assertLess(word_count, 50, f"Format too verbose: {word_count} words")


class TestResolveRepoRoot(unittest.TestCase):

    def test_resolves_valid_cwd(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = _resolve_repo_root(tmpdir)
            self.assertIsNotNone(result)
            self.assertTrue(Path(result).is_dir())

    def test_returns_none_for_nonexistent(self):
        result = _resolve_repo_root("/nonexistent/path/that/does/not/exist")
        self.assertIsNone(result)


class TestFirstTouchReminder(unittest.TestCase):

    def test_builds_handoff_and_startup_reminder(self):
        reminder = _build_btrain_first_touch_reminder("/tmp/repo")

        self.assertIn("REMINDER:", reminder)
        self.assertIn("btrain handoff --repo /tmp/repo", reminder)
        self.assertIn("btrain startup --repo /tmp/repo", reminder)

    def test_missing_context_appends_reminder_once(self):
        prompt, reminder_sent = _apply_btrain_context_or_reminder(
            "Message in #agents:",
            "/tmp/repo",
            "",
            False,
        )

        self.assertTrue(reminder_sent)
        self.assertIn("Message in #agents:", prompt)
        self.assertIn("REMINDER:", prompt)

    def test_second_missing_context_does_not_repeat_reminder(self):
        first_prompt, reminder_sent = _apply_btrain_context_or_reminder(
            "Message in #agents:",
            "/tmp/repo",
            "",
            False,
        )
        second_prompt, second_reminder_sent = _apply_btrain_context_or_reminder(
            "Message in #agents:",
            "/tmp/repo",
            "",
            reminder_sent,
        )

        self.assertIn("REMINDER:", first_prompt)
        self.assertNotIn("REMINDER:", second_prompt)
        self.assertTrue(second_reminder_sent)

    def test_present_context_appends_lane_context_and_resets_state(self):
        prompt, reminder_sent = _apply_btrain_context_or_reminder(
            "Message in #agents:",
            "/tmp/repo",
            "LANE a | writer | Fix auth bug",
            True,
        )

        self.assertFalse(reminder_sent)
        self.assertIn("LANE a | writer | Fix auth bug", prompt)
        self.assertNotIn("REMINDER:", prompt)

    def test_context_rearms_reminder_for_future_missing_context(self):
        _prompt, reminder_sent = _apply_btrain_context_or_reminder(
            "Message in #agents:",
            "/tmp/repo",
            "",
            False,
        )
        _prompt, reminder_sent = _apply_btrain_context_or_reminder(
            "Message in #agents:",
            "/tmp/repo",
            "LANE a | writer | Fix auth bug",
            reminder_sent,
        )
        prompt, reminder_sent = _apply_btrain_context_or_reminder(
            "Message in #agents:",
            "/tmp/repo",
            "",
            reminder_sent,
        )

        self.assertTrue(reminder_sent)
        self.assertIn("REMINDER:", prompt)


class TestFetchBtrainContext(unittest.TestCase):

    @patch("wrapper.subprocess.run")
    @patch("urllib.request.urlopen")
    def test_prefers_rest_api_writer_context_with_agent_card(self, mock_urlopen, mock_run):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "lanes": [
                {
                    "_laneId": "a",
                    "task": "Fix auth bug in login flow",
                    "status": "in-progress",
                    "owner": "claude",
                    "reviewer": "codex",
                    "lockedFiles": ["src/auth.py", "src/utils.py"],
                },
            ],
            "agentCards": {
                "claude": {
                    "runner": "claude-opus",
                    "role": "writer",
                    "capabilities": ["review"],
                }
            },
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        result = _fetch_btrain_context(8300, "Claude", "/some/repo")

        self.assertIn("LANE a", result)
        self.assertIn("writer", result.lower())
        self.assertIn("CARD runner=claude-opus role=writer caps=review", result)
        mock_run.assert_not_called()

    @patch("wrapper.subprocess.run")
    @patch("urllib.request.urlopen")
    def test_prefers_rest_api_reviewer_context(self, mock_urlopen, mock_run):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "lanes": [
                {
                    "_laneId": "b",
                    "task": "Review dashboard rendering",
                    "status": "needs-review",
                    "owner": "codex",
                    "reviewer": "claude",
                    "lockedFiles": ["scripts/serve-dashboard.js"],
                },
            ],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        result = _fetch_btrain_context(8300, "Claude", "/some/repo")

        self.assertIn("LANE b", result)
        self.assertIn("reviewer", result.lower())
        mock_run.assert_not_called()

    @patch("wrapper.subprocess.run")
    @patch("urllib.request.urlopen")
    def test_rest_api_without_agent_cards_preserves_existing_output(self, mock_urlopen, mock_run):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "lanes": [
                {
                    "_laneId": "a",
                    "task": "Fix auth bug in login flow",
                    "status": "in-progress",
                    "owner": "claude",
                    "reviewer": "codex",
                    "lockedFiles": ["src/auth.py"],
                },
            ],
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        result = _fetch_btrain_context(8300, "Claude", "/some/repo")

        self.assertIn("LANE a", result)
        self.assertNotIn("CARD ", result)
        mock_run.assert_not_called()

    @patch("wrapper.subprocess.run")
    @patch("urllib.request.urlopen")
    def test_prefers_matching_repo_from_multi_repo_payload(self, mock_urlopen, mock_run):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "repos": [
                {
                    "name": "other",
                    "path": "/other/repo",
                    "lanes": [
                        {
                            "_laneId": "z",
                            "task": "Other repo task",
                            "status": "in-progress",
                            "owner": "claude",
                            "reviewer": "codex",
                            "lockedFiles": ["elsewhere.txt"],
                        },
                    ],
                    "repurposeReady": [],
                },
                {
                    "name": "target",
                    "path": "/some/repo",
                    "lanes": [
                        {
                            "_laneId": "b",
                            "task": "Review dashboard rendering",
                            "status": "needs-review",
                            "owner": "codex",
                            "reviewer": "claude",
                            "lockedFiles": ["scripts/serve-dashboard.js"],
                        },
                    ],
                    "repurposeReady": [],
                },
            ],
            "agentCards": {
                "claude": {
                    "runner": "claude-opus",
                    "role": "reviewer",
                    "lane_affinity": "b",
                }
            },
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        result = _fetch_btrain_context(8300, "Claude", "/some/repo")

        self.assertIn("LANE b", result)
        self.assertNotIn("LANE z", result)
        self.assertIn("CARD runner=claude-opus role=reviewer lane=b", result)
        mock_run.assert_not_called()

    @patch("wrapper.shutil.which", return_value=None)
    def test_returns_empty_when_btrain_not_installed(self, _mock_which):
        result = _fetch_btrain_context(8300, "Claude", "/some/repo")
        self.assertEqual(result, "")

    @patch("wrapper.subprocess.run")
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_returns_empty_on_nonzero_exit(self, _mock_which, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="error")
        result = _fetch_btrain_context(8300, "Claude", "/some/repo")
        self.assertEqual(result, "")

    @patch("wrapper.subprocess.run")
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_returns_context_on_success(self, _mock_which, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout=SAMPLE_OUTPUT)
        result = _fetch_btrain_context(8300, "Claude", "/some/repo")
        self.assertIn("LANE a", result)
        self.assertIn("Fix auth bug", result)

    @patch("wrapper.subprocess.run", side_effect=FileNotFoundError)
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_returns_empty_on_file_not_found(self, _mock_which, _mock_run):
        result = _fetch_btrain_context(8300, "Claude", "/some/repo")
        self.assertEqual(result, "")

    @patch("wrapper.subprocess.run")
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_passes_correct_args(self, _mock_which, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        _fetch_btrain_context(8300, "Claude", "/my/repo", timeout=5.0)
        mock_run.assert_called_once_with(
            ["/usr/local/bin/btrain", "handoff", "--repo", "/my/repo"],
            capture_output=True, text=True, timeout=5.0,
        )


if __name__ == "__main__":
    unittest.main()
