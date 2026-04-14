"""Unit tests for btrain lane context injection (Workstream 6).

Tests _parse_btrain_output, _format_lane_context, _fetch_btrain_context,
and _resolve_repo_root from wrapper.py.
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


class TestFetchBtrainContext(unittest.TestCase):

    @patch("wrapper.subprocess.run")
    @patch("urllib.request.urlopen")
    def test_prefers_rest_api_writer_context(self, mock_urlopen, mock_run):
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
        }).encode("utf-8")
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        result = _fetch_btrain_context(8300, "Claude", "/some/repo")

        self.assertIn("LANE a", result)
        self.assertIn("writer", result.lower())
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
