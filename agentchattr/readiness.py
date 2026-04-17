"""Launcher readiness checks for agentchattr agent CLIs.

Pre-flight validation that CLI binaries exist, auth is configured,
and working directories are accessible. Returns structured results
with concrete recovery messages.
"""

import os
import shutil
import subprocess
from pathlib import Path

MIN_RUNTIME_PYTHON = (3, 11)


def parse_python_version(version_text: str) -> tuple[int, int] | None:
    """Extract major/minor Python version from `python --version` style output."""
    text = (version_text or "").strip()
    for token in text.split():
        parts = token.split(".")
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            return int(parts[0]), int(parts[1])
    return None


def python_version_supported(version: tuple[int, int] | None, minimum: tuple[int, int] = MIN_RUNTIME_PYTHON) -> bool:
    if version is None:
        return False
    return version >= minimum


def check_binary(command: str, timeout: float = 5.0) -> dict:
    """Check that a CLI binary exists on PATH and can execute --version."""
    resolved = shutil.which(command)
    if not resolved:
        return {
            "ok": False,
            "resolved": None,
            "message": f"'{command}' not found on PATH.",
            "recovery": f"Install {command}, then add it to your PATH.",
        }

    # Try running --version to verify it's actually executable
    try:
        result = subprocess.run(
            [resolved, "--version"],
            capture_output=True, text=True, timeout=timeout,
        )
        version = result.stdout.strip().split("\n")[0] if result.stdout else ""
        return {
            "ok": True,
            "resolved": resolved,
            "version": version,
            "message": f"{command} found at {resolved}",
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": True,  # binary exists, just slow
            "resolved": resolved,
            "version": "(timeout)",
            "message": f"{command} found but --version timed out after {timeout}s",
        }
    except (OSError, PermissionError) as e:
        return {
            "ok": False,
            "resolved": resolved,
            "message": f"{command} found at {resolved} but not executable: {e}",
            "recovery": f"Check permissions on {resolved}.",
        }


def check_cwd(cwd_path: str) -> dict:
    """Check that a working directory exists and is accessible."""
    p = Path(cwd_path).resolve()
    if not p.exists():
        return {
            "ok": False,
            "path": str(p),
            "message": f"Working directory does not exist: {p}",
            "recovery": "Create the directory or update cwd in config.toml.",
        }
    if not p.is_dir():
        return {
            "ok": False,
            "path": str(p),
            "message": f"Working directory is not a directory: {p}",
            "recovery": "Fix the cwd path in config.toml.",
        }
    if not os.access(str(p), os.R_OK):
        return {
            "ok": False,
            "path": str(p),
            "message": f"Working directory is not readable: {p}",
            "recovery": f"Fix permissions on {p}.",
        }
    return {
        "ok": True,
        "path": str(p),
        "message": f"Working directory accessible: {p}",
    }


def check_runtime_python(base_dir: str = ".") -> dict:
    """Check that agentchattr can bootstrap with a Python 3.11+ runtime."""
    base = Path(base_dir).resolve()
    venv_candidates = [
        base / ".venv" / "bin" / "python",
        base / ".venv" / "Scripts" / "python.exe",
    ]

    for candidate in venv_candidates:
        if not candidate.exists():
            continue
        result = check_binary(str(candidate))
        version = parse_python_version(result.get("version", ""))
        if python_version_supported(version):
            return {
                "ok": True,
                "resolved": str(candidate),
                "version": result.get("version", ""),
                "message": f"Bootstrap runtime ready: {candidate}",
            }
        return {
            "ok": False,
            "resolved": str(candidate),
            "version": result.get("version", ""),
            "message": f"Existing virtualenv uses an unsupported Python: {result.get('version', '(unknown)')}",
            "recovery": "Delete .venv and relaunch with Python 3.11, 3.12, or 3.13 available.",
        }

    command_candidates: list[list[str]] = []
    if shutil.which("py"):
        command_candidates.extend([["py", "-3.13"], ["py", "-3.12"], ["py", "-3.11"]])
    command_candidates.extend([[name] for name in ("python3.13", "python3.12", "python3.11", "python3", "python")])

    for args in command_candidates:
        try:
            result = subprocess.run(
                [*args, "--version"],
                capture_output=True, text=True, timeout=5,
            )
        except (FileNotFoundError, OSError, PermissionError, subprocess.TimeoutExpired):
            continue
        version_text = (result.stdout or result.stderr or "").strip()
        version = parse_python_version(version_text)
        if python_version_supported(version):
            return {
                "ok": True,
                "resolved": " ".join(args),
                "version": version_text,
                "message": f"Compatible bootstrap Python found: {' '.join(args)}",
            }

    return {
        "ok": False,
        "resolved": None,
        "version": "",
        "message": "No compatible Python 3.11+ runtime found for agentchattr bootstrap.",
        "recovery": "Install Python 3.11, 3.12, or 3.13, or point AGENTCHATTR_PYTHON at a compatible interpreter before launching.",
    }


# ---------------------------------------------------------------------------
# Agent-specific auth checks
# ---------------------------------------------------------------------------

def check_auth_claude() -> dict:
    """Check Claude Code CLI auth readiness."""
    # Claude Code stores session in ~/.claude/ or ~/.claude.json
    claude_dir = Path.home() / ".claude"
    claude_json = Path.home() / ".claude.json"

    if claude_dir.exists() or claude_json.exists():
        return {
            "ok": True,
            "message": "Claude session config found.",
        }

    return {
        "ok": False,
        "message": "No Claude session found (~/.claude/ or ~/.claude.json missing).",
        "recovery": "Run 'claude' and complete the login flow, or run 'claude /login'.",
    }


def check_auth_codex() -> dict:
    """Check Codex CLI auth readiness."""
    # Codex uses OPENAI_API_KEY env var or ~/.codex/ session
    if os.environ.get("OPENAI_API_KEY"):
        return {
            "ok": True,
            "message": "OPENAI_API_KEY is set.",
        }

    codex_dir = Path.home() / ".codex"
    if codex_dir.exists():
        return {
            "ok": True,
            "message": "Codex session config found (~/.codex/).",
        }

    return {
        "ok": False,
        "message": "No Codex auth found (OPENAI_API_KEY not set, ~/.codex/ missing).",
        "recovery": "Set OPENAI_API_KEY in your environment, or run 'codex' and log in.",
    }


def check_auth_gemini() -> dict:
    """Check Gemini CLI auth readiness."""
    # Gemini uses GOOGLE_API_KEY, GEMINI_API_KEY, gcloud auth, or local subscription login (~/.gemini/)
    if os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"):
        return {
            "ok": True,
            "message": "Gemini API key is set.",
        }

    # Check subscription-based local login (~/.gemini/ or ~/.config/gemini/)
    gemini_dir = Path.home() / ".gemini"
    gemini_config = Path.home() / ".config" / "gemini"
    if gemini_dir.exists() or gemini_config.exists():
        return {
            "ok": True,
            "message": "Gemini session config found (subscription login).",
        }

    # Check gcloud auth
    try:
        result = subprocess.run(
            ["gcloud", "auth", "list", "--format=value(account)", "--filter=status:ACTIVE"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return {
                "ok": True,
                "message": f"gcloud authenticated as {result.stdout.strip().split(chr(10))[0]}.",
            }
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return {
        "ok": False,
        "message": "No Gemini auth found (no API key, no ~/.gemini/ session, no gcloud account).",
        "recovery": "Run 'gemini' and complete the login flow, set GOOGLE_API_KEY, or run 'gcloud auth login'.",
    }


def check_gemini_extras() -> list[dict]:
    """Check Gemini-specific soft dependencies."""
    warnings = []
    if not shutil.which("rg"):
        warnings.append({
            "ok": True,  # non-blocking warning
            "level": "warning",
            "message": "ripgrep (rg) not found — Gemini CLI may hang on initialization.",
            "recovery": "Install ripgrep: brew install ripgrep (macOS) or apt install ripgrep (Linux).",
        })
    return warnings


# ---------------------------------------------------------------------------
# Auth dispatch by agent name
# ---------------------------------------------------------------------------

_AUTH_CHECKS = {
    "claude": check_auth_claude,
    "codex": check_auth_codex,
    "gemini": check_auth_gemini,
}

_EXTRA_CHECKS = {
    "gemini": check_gemini_extras,
}


def check_agent_readiness(name: str, agent_cfg: dict, base_dir: str = ".") -> dict:
    """Run all readiness checks for a single agent.

    Returns:
        {
            "name": str,
            "ready": bool,
            "binary": {ok, resolved, version, message, recovery?},
            "cwd": {ok, path, message, recovery?},
            "auth": {ok, message, recovery?},
            "warnings": [{message, recovery}],
            "summary": str,
        }
    """
    command = agent_cfg.get("command", name)
    cwd_raw = agent_cfg.get("cwd", ".")
    cwd_resolved = str((Path(base_dir) / cwd_raw).resolve())

    binary = check_binary(command)
    cwd = check_cwd(cwd_resolved)

    # Auth check — match by base agent name
    auth_fn = _AUTH_CHECKS.get(name, _AUTH_CHECKS.get(command))
    auth = auth_fn() if auth_fn else {"ok": True, "message": "No auth check for this agent."}

    # Extra checks (soft warnings)
    extra_fn = _EXTRA_CHECKS.get(name, _EXTRA_CHECKS.get(command))
    warnings = extra_fn() if extra_fn else []

    ready = binary["ok"] and cwd["ok"] and auth["ok"]

    # Build summary
    if ready:
        summary = f"{name}: ready"
        if warnings:
            summary += f" ({len(warnings)} warning{'s' if len(warnings) != 1 else ''})"
    else:
        issues = []
        if not binary["ok"]:
            issues.append(binary.get("recovery", binary["message"]))
        if not cwd["ok"]:
            issues.append(cwd.get("recovery", cwd["message"]))
        if not auth["ok"]:
            issues.append(auth.get("recovery", auth["message"]))
        summary = f"{name}: NOT READY — " + "; ".join(issues)

    return {
        "name": name,
        "ready": ready,
        "binary": binary,
        "cwd": cwd,
        "auth": auth,
        "warnings": warnings,
        "summary": summary,
    }


def check_all_agents(agents_cfg: dict, base_dir: str = ".") -> list[dict]:
    """Run readiness checks for all configured agents.

    Args:
        agents_cfg: dict from config.toml [agents] section
        base_dir: base directory for resolving relative cwd paths

    Returns:
        List of per-agent readiness results.
    """
    results = []
    for name, cfg in agents_cfg.items():
        # Skip API-type agents (they don't use local CLI binaries)
        if cfg.get("type") == "api":
            results.append({
                "name": name,
                "ready": True,
                "binary": {"ok": True, "message": "API agent (no local binary)."},
                "cwd": {"ok": True, "message": "N/A"},
                "auth": {"ok": True, "message": "API key managed separately."},
                "warnings": [],
                "summary": f"{name}: API agent (readiness N/A)",
            })
            continue
        results.append(check_agent_readiness(name, cfg, base_dir))
    return results


# ---------------------------------------------------------------------------
# CLI entry point (for launcher script pre-flight)
# ---------------------------------------------------------------------------

def _print_check(label: str, check: dict, indent: str = "        "):
    """Print a failed check's message and recovery hint."""
    if check["ok"]:
        return
    print(f"{indent}{label}: {check['message']}")
    if check.get("recovery"):
        print(f"{indent}Fix: {check['recovery']}")


def main():
    """Run readiness checks and print results. Exit 1 if any agent is not ready."""
    import json
    import sys

    try:
        from config_loader import load_config
        cfg = load_config()
    except Exception as e:
        print(f"Failed to load config: {e}")
        sys.exit(1)

    runtime = check_runtime_python(str(Path(__file__).parent))
    runtime_icon = "OK" if runtime["ok"] else "FAIL"
    print(f"  [{runtime_icon}] runtime: {runtime['message']}")
    if runtime.get("version"):
        print(f"        Version: {runtime['version']}")
    if not runtime["ok"] and runtime.get("recovery"):
        print(f"        Fix: {runtime['recovery']}")
    print()

    results = check_all_agents(cfg.get("agents", {}), str(Path(__file__).parent))

    any_not_ready = not runtime["ok"]
    for r in results:
        icon = "OK" if r["ready"] else "FAIL"
        print(f"  [{icon}] {r['summary']}")
        for w in r.get("warnings", []):
            print(f"        Warning: {w['message']}")
            if w.get("recovery"):
                print(f"        Fix: {w['recovery']}")
        if not r["ready"]:
            any_not_ready = True
            _print_check("Binary", r["binary"])
            _print_check("CWD", r["cwd"])
            _print_check("Auth", r["auth"])
        print()

    if "--json" in sys.argv:
        print(json.dumps(results, indent=2))

    sys.exit(1 if any_not_ready else 0)


if __name__ == "__main__":
    main()
