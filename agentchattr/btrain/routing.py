"""Repo-scoped @mention target resolution.

Split out of app.py so the logic is unit-testable without importing the
full FastAPI module. app.py keeps a thin wrapper that injects its global
``registry`` handle.

Two call sites share this:
  * user @mentions
  * automated btrain poller cues

Both are strict when a repo scope is known. A cue for one repo must not wake
an agent instance registered for another repo.
"""

from __future__ import annotations


def resolve_repo_agent(
    target: str,
    repo_path: str,
    *,
    registry,
) -> str | None:
    """Resolve a mention target to a concrete instance name.

    When ``repo_path`` is set, only an instance whose ``repo`` matches
    exactly is returned. Cross-repo mentions are rejected with ``None``.

    Unscoped channels retain the legacy family fallback behavior.
    """
    if registry is None:
        return target

    if repo_path:
        inst = registry.find_instance(target, repo=repo_path)
        if inst:
            return inst["name"]

        exact = registry.get_instance(target)
        if exact and exact.get("repo") == repo_path:
            return target

        return None

    # Unscoped (single-repo / non-repo channel): family fallback is allowed.
    inst = registry.find_instance(target, repo="")
    if inst:
        return inst["name"]
    family = registry.get_instances_for(target)
    if family:
        return family[0]["name"]
    return target


def resolve_poller_cue_targets(
    target: str,
    repo_path: str,
    *,
    registry,
) -> list[str]:
    """Return instance names the btrain poller should trigger for a cue.

    Repo-scoped cues are strict. Returning [] is preferable to waking an agent
    that is registered for a different repo.
    """
    resolved = resolve_repo_agent(
        target,
        repo_path,
        registry=registry,
    )
    return [resolved] if resolved else []
