"""Unit tests for btrain lane context injection (Workstream 6).

Tests _parse_btrain_output, _format_lane_context, _fetch_btrain_context,
and _resolve_repo_root from wrapper.py.
"""

import sys
import tempfile
import unittest
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
agent check: Claude (runtime hints (claude, opus))

--- lane a ---
task: Fix auth bug in login flow
status: in-progress
active agent: Claude
peer reviewer: GPT
mode: manual
locked files: src/auth.py, src/utils.py
lock state: active
next: Work within the locked files, keep the lane in-progress, and hand off for review when ready.

--- lane b ---
task: Review dashboard rendering
status: needs-review
active agent: GPT
peer reviewer: Claude
mode: manual
locked files: scripts/serve-dashboard.js
lock state: active
next: Waiting on Claude to review the lane.

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
agent check: Claude (runtime hints (claude, opus))

--- lane a ---
task: Update specs for REST-only migration
status: changes-requested
active agent: Claude
peer reviewer: GPT
mode: manual
locked files: specs/
lock state: active
reason code: spec-mismatch
reason tags: sequencing, consistency
next: Address GPT's review findings in the same lane and re-handoff for review.
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
        self.assertEqual(lane_a["active agent"], "Claude")
        self.assertEqual(lane_a["peer reviewer"], "GPT")
        self.assertEqual(lane_a["locked files"], "src/auth.py, src/utils.py")
        self.assertEqual(lane_a["lock state"], "active")

    def test_empty_output_returns_empty(self):
        self.assertEqual(_split_lane_blocks(""), [])

    def test_no_lane_markers_returns_empty(self):
        self.assertEqual(_split_lane_blocks("some random text\nno lanes here"), [])


class TestParseBtrainOutput(unittest.TestCase):

    def test_matches_writer_on_active_lane(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "Claude")
        self.assertIn("lane=a", result)
        self.assertIn("active writer", result)
        self.assertIn("Fix auth bug", result)

    def test_matches_reviewer_on_needs_review_lane(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "Claude")
        # Claude is owner of lane a (in-progress) — that takes priority over reviewer of lane b
        self.assertIn("lane=a", result)

    def test_reviewer_priority_when_not_owner(self):
        # GPT is reviewer of no lane in needs-review, but is owner of lane b in needs-review
        # Actually GPT is owner of lane b which is needs-review — so GPT gets writer-waiting
        result = _parse_btrain_output(SAMPLE_OUTPUT, "GPT")
        self.assertIn("lane=b", result)
        self.assertIn("waiting on review", result)

    def test_case_insensitive_matching(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "claude")
        self.assertIn("lane=a", result)

    def test_no_match_returns_empty(self):
        result = _parse_btrain_output(SAMPLE_OUTPUT, "Gemini")
        self.assertEqual(result, "")

    def test_changes_requested_matches_as_writer(self):
        result = _parse_btrain_output(SAMPLE_CHANGES_REQUESTED, "Claude")
        self.assertIn("lane=a", result)
        self.assertIn("active writer", result)
        self.assertIn("changes-requested", result)


class TestFormatLaneContext(unittest.TestCase):

    def setUp(self):
        self.lane = {
            "_lane_id": "a",
            "task": "Fix auth bug",
            "status": "in-progress",
            "active agent": "Claude",
            "peer reviewer": "GPT",
            "locked files": "src/auth.py",
            "next": "Work within the locked files.",
        }

    def test_contains_all_fr5_fields(self):
        result = _format_lane_context(self.lane, "writer")
        self.assertIn("lane=a", result)
        self.assertIn("Fix auth bug", result)
        self.assertIn("in-progress", result)
        self.assertIn("Claude", result)
        self.assertIn("GPT", result)
        self.assertIn("src/auth.py", result)
        self.assertIn("Work within the locked files.", result)
        self.assertIn("HANDOFF_A.md", result)

    def test_contains_fr6_protocol(self):
        result = _format_lane_context(self.lane, "writer")
        self.assertIn("PROTOCOL:", result)
        self.assertIn("btrain CLI", result)
        self.assertIn("lock boundaries", result)
        self.assertIn("source of truth", result)

    def test_writer_role_note(self):
        result = _format_lane_context(self.lane, "writer")
        self.assertIn("active writer (Claude)", result)

    def test_reviewer_role_note(self):
        result = _format_lane_context(self.lane, "reviewer")
        self.assertIn("peer reviewer (GPT)", result)
        self.assertIn("writer is Claude", result)

    def test_writer_waiting_role_note(self):
        result = _format_lane_context(self.lane, "writer-waiting")
        self.assertIn("waiting on review from GPT", result)

    def test_handoff_doc_path_uses_uppercase_lane_id(self):
        result = _format_lane_context(self.lane, "writer")
        self.assertIn("HANDOFF_A.md", result)

    def test_multi_char_lane_id(self):
        self.lane["_lane_id"] = "ids"
        result = _format_lane_context(self.lane, "writer")
        self.assertIn("HANDOFF_IDS.md", result)


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

    @patch("wrapper.shutil.which", return_value=None)
    def test_returns_empty_when_btrain_not_installed(self, _mock_which):
        result = _fetch_btrain_context("/some/repo", "Claude")
        self.assertEqual(result, "")

    @patch("wrapper.subprocess.run")
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_returns_empty_on_nonzero_exit(self, _mock_which, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="error")
        result = _fetch_btrain_context("/some/repo", "Claude")
        self.assertEqual(result, "")

    @patch("wrapper.subprocess.run")
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_returns_context_on_success(self, _mock_which, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout=SAMPLE_OUTPUT)
        result = _fetch_btrain_context("/some/repo", "Claude")
        self.assertIn("lane=a", result)
        self.assertIn("BTRAIN LANE CONTEXT", result)

    @patch("wrapper.subprocess.run", side_effect=FileNotFoundError)
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_returns_empty_on_file_not_found(self, _mock_which, _mock_run):
        result = _fetch_btrain_context("/some/repo", "Claude")
        self.assertEqual(result, "")

    @patch("wrapper.subprocess.run")
    @patch("wrapper.shutil.which", return_value="/usr/local/bin/btrain")
    def test_passes_correct_args(self, _mock_which, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        _fetch_btrain_context("/my/repo", "Claude", timeout=5.0)
        mock_run.assert_called_once_with(
            ["/usr/local/bin/btrain", "handoff", "--repo", "/my/repo"],
            capture_output=True, text=True, timeout=5.0,
        )


if __name__ == "__main__":
    unittest.main()
