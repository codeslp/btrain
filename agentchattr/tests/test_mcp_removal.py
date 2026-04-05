"""Regression tests for MCP phase-out (Workstream MCP-D).

Verifies that:
  - presence.py provides all functionality previously in mcp_bridge.py
  - No source files import mcp_bridge or mcp_proxy
  - requirements.txt no longer lists the mcp dependency
  - config.toml no longer contains an [mcp] section
  - New REST summary endpoints are wired in app.py
"""

import json
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

REPO_FILES = {
    "app": ROOT / "app.py",
    "run": ROOT / "run.py",
    "wrapper": ROOT / "wrapper.py",
    "agents": ROOT / "agents.py",
    "session_engine": ROOT / "session_engine.py",
    "requirements": ROOT / "requirements.txt",
    "config": ROOT / "config.toml",
}


class TestPresenceModule(unittest.TestCase):
    """presence.py must export all runtime identity functions formerly in mcp_bridge."""

    def setUp(self):
        import presence
        self.mod = presence
        # Reset module-level state between tests
        with self.mod._presence_lock:
            self.mod._presence.clear()
            self.mod._activity.clear()
            self.mod._activity_ts.clear()
            self.mod._renamed_from.clear()
        self.mod._roles.clear()

    # ── Presence ──────────────────────────────────────────────────────────

    def test_touch_and_is_online(self):
        self.mod.touch_presence("claude")
        self.assertTrue(self.mod.is_online("claude"))
        self.assertFalse(self.mod.is_online("codex"))

    def test_get_online_returns_recent(self):
        self.mod.touch_presence("claude")
        self.mod.touch_presence("codex")
        online = self.mod.get_online()
        self.assertIn("claude", online)
        self.assertIn("codex", online)

    def test_stale_presence_is_offline(self):
        with self.mod._presence_lock:
            self.mod._presence["stale"] = time.time() - self.mod.PRESENCE_TIMEOUT - 1
        self.assertFalse(self.mod.is_online("stale"))

    # ── Activity ──────────────────────────────────────────────────────────

    def test_set_active_and_is_active(self):
        self.mod.set_active("claude", True)
        self.assertTrue(self.mod.is_active("claude"))

    def test_inactive_agent_returns_false(self):
        self.mod.set_active("claude", False)
        self.assertFalse(self.mod.is_active("claude"))

    def test_activity_expires(self):
        self.mod.set_active("claude", True)
        with self.mod._presence_lock:
            self.mod._activity_ts["claude"] = time.time() - self.mod.ACTIVITY_TIMEOUT - 1
        self.assertFalse(self.mod.is_active("claude"))

    # ── Identity migration ────────────────────────────────────────────────

    def test_migrate_identity_moves_presence(self):
        self.mod.touch_presence("claude")
        self.mod.set_active("claude", True)
        self.mod.migrate_identity("claude", "claude-2")
        self.assertFalse(self.mod.is_online("claude"))
        self.assertTrue(self.mod.is_online("claude-2"))

    def test_purge_identity_removes_all_state(self):
        self.mod.touch_presence("claude")
        self.mod.set_active("claude", True)
        self.mod.set_role("claude", "reviewer")
        self.mod.purge_identity("claude")
        self.assertFalse(self.mod.is_online("claude"))
        self.assertFalse(self.mod.is_active("claude"))
        self.assertEqual(self.mod.get_role("claude"), "")

    # ── Roles ─────────────────────────────────────────────────────────────

    def test_set_and_get_role(self):
        self.mod.set_role("claude", "reviewer")
        self.assertEqual(self.mod.get_role("claude"), "reviewer")

    def test_clear_role_with_empty_string(self):
        self.mod.set_role("claude", "reviewer")
        self.mod.set_role("claude", "")
        self.assertEqual(self.mod.get_role("claude"), "")

    def test_get_all_roles(self):
        self.mod.set_role("claude", "writer")
        self.mod.set_role("codex", "reviewer")
        roles = self.mod.get_all_roles()
        self.assertEqual(roles, {"claude": "writer", "codex": "reviewer"})

    def test_get_all_roles_returns_copy(self):
        self.mod.set_role("claude", "writer")
        roles = self.mod.get_all_roles()
        roles["claude"] = "hacked"
        self.assertEqual(self.mod.get_role("claude"), "writer")

    # ── Cursor persistence ────────────────────────────────────────────────

    def test_load_cursors_from_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump({"claude": {"general": 42}}, f)
            f.flush()
            cursor_path = Path(f.name)
        try:
            self.mod.load_cursors(cursor_path)
            with self.mod._cursors_lock:
                self.assertEqual(self.mod._cursors.get("claude", {}).get("general"), 42)
        finally:
            cursor_path.unlink(missing_ok=True)

    def test_load_roles_from_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump({"claude": "writer"}, f)
            f.flush()
            roles_path = Path(f.name)
        try:
            self.mod.load_roles(roles_path)
            self.assertEqual(self.mod.get_role("claude"), "writer")
        finally:
            roles_path.unlink(missing_ok=True)


class TestNoMcpImports(unittest.TestCase):
    """No production source file should import mcp_bridge or mcp_proxy."""

    _IMPORT_PATTERN = re.compile(
        r"^\s*(?:import|from)\s+(?:mcp_bridge|mcp_proxy)\b",
        re.MULTILINE,
    )

    def _assert_no_mcp_import(self, filepath: Path):
        content = filepath.read_text("utf-8")
        matches = self._IMPORT_PATTERN.findall(content)
        self.assertEqual(
            matches, [],
            f"{filepath.name} still imports mcp_bridge or mcp_proxy: {matches}",
        )

    def test_app_no_mcp_import(self):
        self._assert_no_mcp_import(REPO_FILES["app"])

    def test_run_no_mcp_import(self):
        self._assert_no_mcp_import(REPO_FILES["run"])

    def test_wrapper_no_mcp_import(self):
        self._assert_no_mcp_import(REPO_FILES["wrapper"])

    def test_agents_no_mcp_import(self):
        self._assert_no_mcp_import(REPO_FILES["agents"])

    def test_session_engine_no_mcp_import(self):
        self._assert_no_mcp_import(REPO_FILES["session_engine"])


class TestMcpDependencyRemoved(unittest.TestCase):
    """requirements.txt must not list mcp as a dependency."""

    def test_requirements_has_no_mcp(self):
        content = REPO_FILES["requirements"].read_text("utf-8")
        for line in content.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                self.assertFalse(
                    stripped.startswith("mcp"),
                    f"requirements.txt still lists mcp dependency: {stripped}",
                )


class TestMcpConfigRemoved(unittest.TestCase):
    """config.toml must not contain an [mcp] section or mcp_inject keys."""

    def test_no_mcp_section(self):
        content = REPO_FILES["config"].read_text("utf-8")
        self.assertNotIn("[mcp]", content, "config.toml still has an [mcp] section")

    def test_no_mcp_inject_keys(self):
        content = REPO_FILES["config"].read_text("utf-8")
        # Check active config lines (not comments)
        for line in content.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                self.assertNotIn(
                    "mcp_inject",
                    stripped,
                    f"config.toml still has mcp_inject config: {stripped}",
                )


class TestSummaryEndpointsExist(unittest.TestCase):
    """app.py must define GET /api/summaries and POST /api/summaries routes."""

    def setUp(self):
        self.content = REPO_FILES["app"].read_text("utf-8")

    def test_get_summaries_endpoint(self):
        self.assertIn(
            '@app.get("/api/summaries")',
            self.content,
            "GET /api/summaries endpoint missing from app.py",
        )

    def test_post_summaries_endpoint(self):
        self.assertIn(
            '@app.post("/api/summaries")',
            self.content,
            "POST /api/summaries endpoint missing from app.py",
        )


if __name__ == "__main__":
    unittest.main()
