"""Tests for repo-scoped registration and deregistration in registry.py."""

import unittest
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from registry import RuntimeRegistry


class TestRegistryRepoField(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.reg = RuntimeRegistry(data_dir=self.tmpdir)
        self.reg.seed({
            "claude": {"label": "Claude", "color": "#da7756"},
            "codex": {"label": "Codex", "color": "#10a37f"},
        })

    def test_register_with_repo(self):
        result = self.reg.register("claude", repo="/Users/x/btrain")
        self.assertEqual(result["repo"], "/Users/x/btrain")

    def test_register_without_repo_defaults_empty(self):
        result = self.reg.register("claude")
        self.assertEqual(result["repo"], "")

    def test_two_repos_same_family(self):
        r1 = self.reg.register("claude", repo="/Users/x/btrain")
        r2 = self.reg.register("claude", repo="/Users/x/cgraph")
        self.assertEqual(r1["name"], "claude")
        self.assertEqual(r2["name"], "claude-2")
        all_inst = self.reg.get_all()
        self.assertEqual(len(all_inst), 2)
        repos = {i["repo"] for i in all_inst.values()}
        self.assertEqual(repos, {"/Users/x/btrain", "/Users/x/cgraph"})

    def test_deregister_by_repo(self):
        self.reg.register("claude", repo="/a")
        self.reg.register("claude", repo="/b")
        result = self.reg.deregister("claude", repo="/a")
        self.assertIsNotNone(result)
        self.assertTrue(result["ok"])
        remaining = self.reg.get_all()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(list(remaining.values())[0]["repo"], "/b")

    def test_deregister_by_repo_not_found(self):
        self.reg.register("claude", repo="/a")
        result = self.reg.deregister("claude", repo="/nonexistent")
        self.assertIsNone(result)
        self.assertEqual(len(self.reg.get_all()), 1)

    def test_deregister_without_repo_uses_exact_name(self):
        self.reg.register("claude", repo="/a")
        result = self.reg.deregister("claude")
        self.assertIsNotNone(result)
        self.assertEqual(len(self.reg.get_all()), 0)

    def test_find_instance(self):
        self.reg.register("claude", repo="/a")
        self.reg.register("claude", repo="/b")
        inst = self.reg.find_instance("claude", repo="/a")
        self.assertIsNotNone(inst)
        self.assertEqual(inst["repo"], "/a")
        self.assertIsNone(self.reg.find_instance("claude", repo="/c"))

    def test_get_instances_for_repo(self):
        self.reg.register("claude", repo="/a")
        self.reg.register("codex", repo="/a")
        self.reg.register("claude", repo="/b")
        instances = self.reg.get_instances_for_repo("/a")
        self.assertEqual(len(instances), 2)
        names = {i["name"] for i in instances}
        self.assertTrue(any("claude" in n for n in names))
        self.assertTrue(any("codex" in n for n in names))

    def test_deregister_result_includes_name(self):
        self.reg.register("claude", repo="/a")
        self.reg.register("claude", repo="/b")
        result = self.reg.deregister("claude", repo="/b")
        self.assertIn("name", result)

    def test_inst_dict_includes_repo(self):
        self.reg.register("claude", repo="/my/repo")
        all_inst = self.reg.get_all()
        inst = list(all_inst.values())[0]
        self.assertEqual(inst["repo"], "/my/repo")


if __name__ == "__main__":
    unittest.main()
