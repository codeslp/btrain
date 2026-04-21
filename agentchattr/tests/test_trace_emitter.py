"""Tests for agentchattr/btrain/trace_emitter.py and its Router integration.

Key invariant: tracing is best-effort. Failures in emitter code must never
break routing.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Add agentchattr to sys.path for direct test runs
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from btrain.trace_emitter import (
    emit_context_fetch,
    emit_routing_decision,
    emit_startup,
)
from router import Router


class TestEmitRoutingDecision(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="btrain-emit-test-")
        (Path(self.tmp) / ".btrain").mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _read_index_lines(self):
        index = Path(self.tmp) / ".btrain" / "traces" / "index.jsonl"
        if not index.exists():
            return []
        return [json.loads(line) for line in index.read_text().splitlines() if line.strip()]

    def test_writes_per_day_file_and_index(self):
        emit_routing_decision(
            self.tmp,
            sender="user",
            channel="general",
            mentions=["claude"],
            targets=["claude"],
            reason="human-mentions",
        )
        day_files = list((Path(self.tmp) / ".btrain" / "traces").glob("agentchattr-*.jsonl"))
        self.assertEqual(len(day_files), 1)
        self.assertEqual(len(self._read_index_lines()), 1)

    def test_index_line_has_expected_fields(self):
        emit_routing_decision(
            self.tmp,
            sender="user",
            channel="#lane-a",
            mentions=["claude"],
            targets=["claude"],
            reason="human-mentions",
            hop_count=0,
            paused=False,
        )
        index = self._read_index_lines()[0]
        self.assertEqual(index["kind"], "agentchattr")
        self.assertEqual(index["event"], "routing_decision")
        self.assertEqual(index["route"], "claude")
        self.assertEqual(index["agent"], "user")
        self.assertTrue(index["id"].startswith("ac-"))
        self.assertIn("human-mentions", index["summary"])

    def test_none_repo_root_is_noop(self):
        # Should not raise and must not create any file
        emit_routing_decision(
            None,
            sender="user",
            channel="general",
            mentions=[],
            targets=[],
            reason="human-no-mentions",
        )
        # Nothing to read because nothing was written anywhere
        self.assertFalse((Path(self.tmp) / ".btrain" / "traces").exists())

    def test_empty_repo_root_is_noop(self):
        emit_routing_decision(
            "",
            sender="user",
            channel="general",
            mentions=[],
            targets=[],
            reason="human-no-mentions",
        )
        self.assertFalse((Path(self.tmp) / ".btrain" / "traces").exists())

    def test_write_failure_is_swallowed(self):
        # Point at a path that cannot be created: a file where a directory
        # should go. trace_emitter must log a warning but not raise.
        blocker = Path(self.tmp) / ".btrain" / "traces"
        blocker.parent.mkdir(parents=True, exist_ok=True)
        blocker.write_text("not-a-dir", encoding="utf-8")  # a file, not a directory

        with self.assertLogs("btrain.trace_emitter", level="WARNING") as ctx:
            emit_routing_decision(
                self.tmp,
                sender="user",
                channel="general",
                mentions=["claude"],
                targets=["claude"],
                reason="human-mentions",
            )
        self.assertTrue(
            any("failed to append" in msg for msg in ctx.output),
            f"expected a warning about failed append, got {ctx.output}",
        )

    def test_targets_absent_produces_none_summary(self):
        emit_routing_decision(
            self.tmp,
            sender="user",
            channel="general",
            mentions=[],
            targets=[],
            reason="human-no-mentions",
        )
        index = self._read_index_lines()[0]
        self.assertIn("(none)", index["summary"])
        self.assertEqual(index["route"], "")


class TestEmitOtherEvents(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="btrain-emit-other-")
        (Path(self.tmp) / ".btrain").mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_context_fetch_records_agent_lane_and_ok(self):
        emit_context_fetch(self.tmp, agent="claude", lane="a", ok=True)
        emit_context_fetch(self.tmp, agent="codex", lane=None, ok=False, note="miss")
        index = Path(self.tmp) / ".btrain" / "traces" / "index.jsonl"
        lines = [json.loads(l) for l in index.read_text().splitlines() if l.strip()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["agent"], "claude")
        self.assertIn("ok", lines[0]["summary"])
        self.assertIn("miss", lines[1]["summary"])

    def test_startup_records_agents_and_lanes(self):
        emit_startup(
            self.tmp,
            agents=["claude", "codex"],
            lanes=["a", "b"],
            config_summary="6 lanes, 2 agents",
        )
        index = Path(self.tmp) / ".btrain" / "traces" / "index.jsonl"
        lines = [json.loads(l) for l in index.read_text().splitlines() if l.strip()]
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["event"], "startup")
        self.assertIn("claude,codex", lines[0]["summary"])


class TestRouterIntegrationBestEffort(unittest.TestCase):
    """Router must continue to route even when the trace_emitter explodes."""

    def test_emitter_exception_does_not_break_get_targets(self):
        def exploding(_payload):
            raise RuntimeError("boom")

        r = Router(
            agent_names=["claude", "codex"],
            default_mention="none",
            trace_emitter=exploding,
        )
        # Without the try/except in _emit_trace, this raises.
        targets = r.get_targets("user", "@claude hello")
        self.assertEqual(targets, ["claude"])

    def test_emitter_none_is_fine(self):
        r = Router(
            agent_names=["claude", "codex"],
            default_mention="none",
            trace_emitter=None,
        )
        self.assertEqual(r.get_targets("user", "@codex"), ["codex"])

    def test_emitter_sees_correct_reason_codes(self):
        seen = []
        r = Router(
            agent_names=["claude", "codex"],
            default_mention="none",
            max_hops=2,
            trace_emitter=lambda p: seen.append(p["reason"]),
        )
        r.get_targets("user", "@claude")            # human-mentions
        r.get_targets("user", "no mentions")         # human-no-mentions
        r.get_targets("claude", "@codex")            # agent-mentions
        r.get_targets("codex", "@claude")            # agent-mentions (hop 2)
        r.get_targets("claude", "@codex")            # hop-guard (hop 3 > max 2)
        r.get_targets("codex", "@claude")            # agent-paused
        self.assertEqual(
            seen,
            [
                "human-mentions",
                "human-no-mentions",
                "agent-mentions",
                "agent-mentions",
                "hop-guard",
                "agent-paused",
            ],
        )


if __name__ == "__main__":
    unittest.main()
