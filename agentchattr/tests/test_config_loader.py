"""Tests for multi-repo config parsing in config_loader.py."""

import unittest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config_loader import get_repos, is_multi_repo


class TestGetRepos(unittest.TestCase):
    def test_repos_section_returns_all(self):
        cfg = {"repos": [
            {"label": "btrain", "path": "/a", "poll_interval": 5},
            {"label": "cgraph", "path": "/b"},
        ]}
        repos = get_repos(cfg)
        self.assertEqual(len(repos), 2)
        self.assertEqual(repos[0]["label"], "btrain")
        self.assertEqual(repos[0]["path"], "/a")
        self.assertEqual(repos[0]["poll_interval"], 5)
        # Second entry should get default poll_interval
        self.assertEqual(repos[1]["poll_interval"], 15)

    def test_repos_inherits_btrain_poll_interval(self):
        cfg = {
            "btrain": {"poll_interval": 7},
            "repos": [
                {"label": "btrain", "path": "/a"},
            ],
        }
        repos = get_repos(cfg)
        self.assertEqual(repos[0]["poll_interval"], 7)

    def test_btrain_fallback(self):
        cfg = {"btrain": {"repo_path": "..", "poll_interval": 10}}
        repos = get_repos(cfg)
        self.assertEqual(len(repos), 1)
        self.assertEqual(repos[0]["path"], "..")
        self.assertEqual(repos[0]["poll_interval"], 10)

    def test_btrain_fallback_label_from_path(self):
        cfg = {"btrain": {"repo_path": "/Users/me/myproject"}}
        repos = get_repos(cfg)
        self.assertEqual(repos[0]["label"], "myproject")

    def test_btrain_fallback_dotdot_label(self):
        cfg = {"btrain": {"repo_path": ".."}}
        repos = get_repos(cfg)
        self.assertEqual(repos[0]["label"], "repo")

    def test_empty_config(self):
        self.assertEqual(get_repos({}), [])

    def test_repos_skips_entries_without_label(self):
        cfg = {"repos": [
            {"path": "/a"},
            {"label": "valid", "path": "/b"},
        ]}
        repos = get_repos(cfg)
        self.assertEqual(len(repos), 1)
        self.assertEqual(repos[0]["label"], "valid")

    def test_repos_skips_entries_without_path(self):
        cfg = {"repos": [
            {"label": "nope"},
            {"label": "valid", "path": "/b"},
        ]}
        repos = get_repos(cfg)
        self.assertEqual(len(repos), 1)

    def test_repos_takes_priority_over_btrain(self):
        cfg = {
            "btrain": {"repo_path": "/old"},
            "repos": [
                {"label": "new", "path": "/new"},
            ],
        }
        repos = get_repos(cfg)
        self.assertEqual(len(repos), 1)
        self.assertEqual(repos[0]["path"], "/new")


class TestIsMultiRepo(unittest.TestCase):
    def test_single_btrain_is_not_multi(self):
        cfg = {"btrain": {"repo_path": ".."}}
        self.assertFalse(is_multi_repo(cfg))

    def test_single_repos_is_not_multi(self):
        cfg = {"repos": [{"label": "a", "path": "/a"}]}
        self.assertFalse(is_multi_repo(cfg))

    def test_two_repos_is_multi(self):
        cfg = {"repos": [
            {"label": "a", "path": "/a"},
            {"label": "b", "path": "/b"},
        ]}
        self.assertTrue(is_multi_repo(cfg))

    def test_empty_is_not_multi(self):
        self.assertFalse(is_multi_repo({}))


if __name__ == "__main__":
    unittest.main()
