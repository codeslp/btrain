"""Tests for agentchattr launcher readiness checks."""

import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

# Add parent dir to path so we can import readiness
sys.path.insert(0, str(Path(__file__).parent.parent))

import readiness


class TestPythonRuntime:
    def test_parse_python_version(self):
        assert readiness.parse_python_version("Python 3.12.13") == (3, 12)
        assert readiness.parse_python_version("Python 3.11.9") == (3, 11)
        assert readiness.parse_python_version("not-a-version") is None

    def test_python_version_supported(self):
        assert readiness.python_version_supported((3, 11)) is True
        assert readiness.python_version_supported((3, 12)) is True
        assert readiness.python_version_supported((3, 10)) is False
        assert readiness.python_version_supported(None) is False

    def test_runtime_python_uses_supported_venv(self):
        with tempfile.TemporaryDirectory() as d:
            venv_python = Path(d) / ".venv" / "bin" / "python"
            venv_python.parent.mkdir(parents=True)
            venv_python.write_text("", "utf-8")
            with mock.patch("readiness.check_binary", return_value={"version": "Python 3.12.13"}):
                result = readiness.check_runtime_python(d)
                assert result["ok"] is True
                assert ".venv" in result["resolved"]

    def test_runtime_python_rejects_old_venv(self):
        with tempfile.TemporaryDirectory() as d:
            venv_python = Path(d) / ".venv" / "bin" / "python"
            venv_python.parent.mkdir(parents=True)
            venv_python.write_text("", "utf-8")
            with mock.patch("readiness.check_binary", return_value={"version": "Python 3.9.6"}):
                result = readiness.check_runtime_python(d)
                assert result["ok"] is False
                assert "unsupported Python" in result["message"]

    def test_runtime_python_finds_supported_system_python(self):
        completed = mock.Mock(stdout="Python 3.12.13\n", stderr="", returncode=0)
        with tempfile.TemporaryDirectory() as d:
            with mock.patch("readiness.shutil.which", side_effect=lambda name: "/usr/bin/py" if name == "py" else None):
                with mock.patch("readiness.subprocess.run", return_value=completed):
                    result = readiness.check_runtime_python(d)
                    assert result["ok"] is True
                    assert "3.12.13" in result["version"]

    def test_runtime_python_fails_without_supported_interpreter(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch("readiness.shutil.which", return_value=None):
                with mock.patch("readiness.subprocess.run", side_effect=FileNotFoundError):
                    result = readiness.check_runtime_python(d)
                    assert result["ok"] is False
                    assert "Python 3.11+" in result["message"]


class TestCheckBinary:
    def test_existing_binary(self):
        """python3 should always be found."""
        result = readiness.check_binary("python3")
        assert result["ok"] is True
        assert result["resolved"] is not None
        assert "python" in result["resolved"].lower()

    def test_missing_binary(self):
        result = readiness.check_binary("nonexistent-binary-xyz-123")
        assert result["ok"] is False
        assert result["resolved"] is None
        assert "not found" in result["message"]
        assert result.get("recovery")

    def test_version_output(self):
        result = readiness.check_binary("python3")
        assert "version" in result or result.get("version", "") != ""


class TestCheckCwd:
    def test_valid_directory(self):
        result = readiness.check_cwd(tempfile.gettempdir())
        assert result["ok"] is True

    def test_missing_directory(self):
        result = readiness.check_cwd("/nonexistent/path/xyz")
        assert result["ok"] is False
        assert "does not exist" in result["message"]
        assert result.get("recovery")

    def test_file_not_directory(self):
        with tempfile.NamedTemporaryFile() as f:
            result = readiness.check_cwd(f.name)
            assert result["ok"] is False
            assert "not a directory" in result["message"]


class TestCheckAuthClaude:
    def test_with_claude_dir(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(Path, "home", return_value=Path(d)):
                (Path(d) / ".claude").mkdir()
                result = readiness.check_auth_claude()
                assert result["ok"] is True

    def test_without_claude_dir(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(Path, "home", return_value=Path(d)):
                result = readiness.check_auth_claude()
                assert result["ok"] is False
                assert "recovery" in result


class TestCheckAuthCodex:
    def test_with_api_key(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
            result = readiness.check_auth_codex()
            assert result["ok"] is True

    def test_with_codex_dir(self):
        with tempfile.TemporaryDirectory() as d:
            # clear=True resets env; mock.patch.dict restores on exit
            with mock.patch.dict(os.environ, {}, clear=True):
                with mock.patch.object(Path, "home", return_value=Path(d)):
                    (Path(d) / ".codex").mkdir()
                    result = readiness.check_auth_codex()
                    assert result["ok"] is True

    def test_without_auth(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.dict(os.environ, {}, clear=True):
                with mock.patch.object(Path, "home", return_value=Path(d)):
                    result = readiness.check_auth_codex()
                    assert result["ok"] is False
                    assert "recovery" in result


class TestCheckAuthGemini:
    def test_with_api_key(self):
        with mock.patch.dict(os.environ, {"GOOGLE_API_KEY": "test-key"}):
            result = readiness.check_auth_gemini()
            assert result["ok"] is True

    def test_with_gemini_api_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}):
            result = readiness.check_auth_gemini()
            assert result["ok"] is True


class TestCheckGeminiExtras:
    def test_ripgrep_warning_when_missing(self):
        with mock.patch("readiness.shutil.which", return_value=None):
            warnings = readiness.check_gemini_extras()
            assert len(warnings) == 1
            assert "ripgrep" in warnings[0]["message"]

    def test_no_warning_when_present(self):
        with mock.patch("readiness.shutil.which", return_value="/usr/bin/rg"):
            warnings = readiness.check_gemini_extras()
            assert len(warnings) == 0


class TestCheckAgentReadiness:
    def test_ready_agent(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = {"command": "python3", "cwd": d}
            result = readiness.check_agent_readiness("python3", cfg, base_dir="/")
            assert result["ready"] is True
            assert result["binary"]["ok"] is True
            assert result["cwd"]["ok"] is True
            assert "ready" in result["summary"]

    def test_missing_binary(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = {"command": "nonexistent-xyz", "cwd": d}
            result = readiness.check_agent_readiness("nonexistent-xyz", cfg, base_dir="/")
            assert result["ready"] is False
            assert result["binary"]["ok"] is False
            assert "NOT READY" in result["summary"]

    def test_bad_cwd(self):
        cfg = {"command": "python3", "cwd": "/nonexistent/xyz"}
        result = readiness.check_agent_readiness("python3", cfg, base_dir="/")
        assert result["ready"] is False
        assert result["cwd"]["ok"] is False


class TestCheckAllAgents:
    def test_api_agent_skipped(self):
        cfg = {
            "minimax": {"type": "api", "model": "test"},
        }
        results = readiness.check_all_agents(cfg)
        assert len(results) == 1
        assert results[0]["ready"] is True
        assert "API agent" in results[0]["summary"]

    def test_mixed_agents(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = {
                "good": {"command": "python3", "cwd": d},
                "bad": {"command": "nonexistent-xyz-999", "cwd": d},
                "api": {"type": "api", "model": "test"},
            }
            results = readiness.check_all_agents(cfg, base_dir="/")
            assert len(results) == 3
            by_name = {r["name"]: r for r in results}
            assert by_name["good"]["ready"] is True
            assert by_name["bad"]["ready"] is False
            assert by_name["api"]["ready"] is True
