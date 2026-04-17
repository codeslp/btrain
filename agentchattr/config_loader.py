"""Shared config loader — merges config.toml + config.local.toml.

Used by run.py, wrapper.py, and wrapper_api.py so the server and all
wrappers see the same agent definitions.
"""

import tomllib
from pathlib import Path

ROOT = Path(__file__).parent


def load_config(root: Path | None = None) -> dict:
    """Load config.toml and merge config.local.toml if it exists.

    config.local.toml is gitignored and intended for user-specific agents
    (e.g. local LLM endpoints) that shouldn't be committed.
    Only the [agents] section is merged — local entries are added alongside
    (not replacing) the agents defined in config.toml.
    """
    root = root or ROOT
    config_path = root / "config.toml"

    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    local_path = root / "config.local.toml"
    if local_path.exists():
        with open(local_path, "rb") as f:
            local = tomllib.load(f)
        
        # Merge [agents] section — local agents are added ONLY if they don't already exist.
        # This protects the "holy trinity" (claude, codex, gemini) from being overridden.
        local_agents = local.get("agents", {})
        config_agents = config.setdefault("agents", {})
        for name, agent_cfg in local_agents.items():
            if name not in config_agents:
                config_agents[name] = agent_cfg
            else:
                print(f"  Warning: Ignoring local agent '{name}' (already defined in config.toml)")

    return config


def get_repos(cfg: dict) -> list[dict]:
    """Extract the list of monitored repos from a loaded config.

    Returns list of {"label": str, "path": str, "poll_interval": int}.

    Priority:
    1. ``[[repos]]`` TOML array-of-tables.
    2. ``[btrain].repo_path`` synthesized as a single entry (backward compat).
    3. Empty list.
    """
    repos_section = cfg.get("repos")
    if repos_section and isinstance(repos_section, list):
        default_interval = int(cfg.get("btrain", {}).get("poll_interval", 15))
        result = []
        for entry in repos_section:
            label = entry.get("label", "")
            path = entry.get("path", "")
            if not label or not path:
                continue
            result.append({
                "label": label,
                "path": path,
                "poll_interval": int(entry.get("poll_interval", default_interval)),
            })
        return result

    btrain_cfg = cfg.get("btrain", {})
    repo_path = btrain_cfg.get("repo_path", "")
    if repo_path:
        return [{
            "label": Path(repo_path).name if repo_path != ".." else "repo",
            "path": repo_path,
            "poll_interval": int(btrain_cfg.get("poll_interval", 15)),
        }]

    return []


def is_multi_repo(cfg: dict) -> bool:
    """True when more than one repo is configured."""
    return len(get_repos(cfg)) > 1
