"""Agent wrapper - runs the real interactive CLI with auto-trigger on @mentions.

Usage:
    python wrapper.py claude
    python wrapper.py codex
    python wrapper.py gemini
    python wrapper.py kimi
    python wrapper.py qwen

Cross-platform:
  - Windows: injects keystrokes via Win32 WriteConsoleInput (wrapper_windows.py)
  - Mac/Linux: injects keystrokes via tmux send-keys (wrapper_unix.py)

How it works:
  1. Starts the agent CLI in an interactive terminal.
  2. Watches the queue file in the background for @mentions from the chat room.
  3. When triggered, injects a context prompt with recent messages via the REST API.
  4. The agent picks up the prompt as if the user typed it.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).parent


# ---------------------------------------------------------------------------
# btrain lane context injection (FR-5, FR-6)
# ---------------------------------------------------------------------------

def _resolve_repo_root(cwd: str) -> str | None:
    """Resolve agent cwd to an absolute repo root path."""
    try:
        resolved = (ROOT / cwd).resolve()
        if resolved.is_dir():
            return str(resolved)
    except Exception:
        pass
    return None


def _fetch_btrain_context(repo_root: str, agent_name: str, timeout: float = 3.0) -> str:
    """Shell out to btrain handoff and return formatted lane context for this agent.

    Returns empty string on any failure (missing binary, timeout, parse error).
    """
    btrain_bin = shutil.which("btrain")
    if not btrain_bin:
        return ""
    try:
        result = subprocess.run(
            [btrain_bin, "handoff", "--repo", repo_root],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            return ""
        return _parse_btrain_output(result.stdout, agent_name)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""


_LANE_HEADER_RE = re.compile(r"^--- lane (\S+) ---$")
_KV_RE = re.compile(r"^([a-z][a-z ]+):\s*(.*)$", re.IGNORECASE)


def _parse_btrain_output(output: str, agent_name: str) -> str:
    """Parse btrain handoff output and return formatted context for agent_name's lane."""
    blocks = _split_lane_blocks(output)
    if not blocks:
        return ""

    agent_lower = agent_name.lower()

    # Priority 1: agent is owner of an active lane (in-progress, changes-requested, repair-needed)
    active_statuses = {"in-progress", "changes-requested", "repair-needed"}
    for block in blocks:
        if block.get("active agent", "").lower() == agent_lower and block.get("status", "") in active_statuses:
            return _format_lane_context(block, "writer")

    # Priority 2: agent is reviewer of a needs-review lane
    for block in blocks:
        if block.get("peer reviewer", "").lower() == agent_lower and block.get("status", "") == "needs-review":
            return _format_lane_context(block, "reviewer")

    # Priority 3: agent is owner of a needs-review lane (waiting on reviewer)
    for block in blocks:
        if block.get("active agent", "").lower() == agent_lower and block.get("status", "") == "needs-review":
            return _format_lane_context(block, "writer-waiting")

    return ""


def _split_lane_blocks(output: str) -> list[dict]:
    """Split btrain handoff output into per-lane key-value blocks."""
    lines = output.splitlines()
    blocks: list[dict] = []
    current: dict | None = None

    for line in lines:
        header_match = _LANE_HEADER_RE.match(line.strip())
        if header_match:
            if current is not None:
                blocks.append(current)
            current = {"_lane_id": header_match.group(1)}
            continue
        if current is None:
            continue
        kv_match = _KV_RE.match(line.strip())
        if kv_match:
            key = kv_match.group(1).strip().lower()
            value = kv_match.group(2).strip()
            current[key] = value

    if current is not None:
        blocks.append(current)

    return blocks


def _format_lane_context(lane: dict, role: str = "writer") -> str:
    """Format a compact btrain lane context block for prompt injection.

    Covers spec 004 FR-5 (8 required fields) and FR-6 (protocol reinforcement).
    """
    lane_id = lane.get("_lane_id", "?")
    task = lane.get("task", "(none)")
    status = lane.get("status", "unknown")
    owner = lane.get("active agent", "(unassigned)")
    reviewer = lane.get("peer reviewer", "(unassigned)")
    locked = lane.get("locked files", "(none)")
    next_action = lane.get("next", "")
    handoff_doc = f".claude/collab/HANDOFF_{lane_id.upper()}.md"

    if role == "reviewer":
        role_note = f"You are the peer reviewer ({reviewer}). The writer is {owner}."
    elif role == "writer-waiting":
        role_note = f"You are the writer ({owner}) but this lane is waiting on review from {reviewer}."
    else:
        role_note = f"You are the active writer ({owner})."

    parts = [
        f'BTRAIN LANE CONTEXT: lane={lane_id} task="{task}" status={status}',
        f"agent={owner} reviewer={reviewer} locked={locked}",
        f'next="{next_action}" docs={handoff_doc}.',
        role_note,
        "PROTOCOL: Use btrain CLI for handoff transitions (do not edit handoff files directly).",
        "Respect lock boundaries.",
        "Treat handoff/spec/plan docs as source of truth.",
        "Run `btrain handoff` before major transitions.",
    ]
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Per-instance provider config
# ---------------------------------------------------------------------------

def _build_provider_launch(
    agent: str,
    agent_cfg: dict,
    extra_args: list[str],
    env: dict[str, str],
) -> tuple[list[str], dict[str, str], dict[str, str]]:
    """Return provider-specific launch args, env, and inject_env (no MCP).

    inject_env: env vars that must propagate INTO the agent process.
    """
    launch_args = list(extra_args)
    launch_env = dict(env)
    inject_env: dict[str, str] = {}
    return launch_args, launch_env, inject_env


def _register_instance(server_port: int, base: str, label: str | None = None) -> dict:
    import urllib.request

    reg_body = json.dumps({"base": base, "label": label}).encode()
    reg_req = urllib.request.Request(
        f"http://127.0.0.1:{server_port}/api/register",
        method="POST",
        data=reg_body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(reg_req, timeout=5) as reg_resp:
        return json.loads(reg_resp.read())


def _auth_headers(token: str, *, include_json: bool = False) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    if include_json:
        headers["Content-Type"] = "application/json"
    return headers


# ---------------------------------------------------------------------------
# Queue watcher
# ---------------------------------------------------------------------------

def _notify_recovery(data_dir: Path, agent_name: str):
    """Write a flag file that the server picks up and broadcasts as a system message."""
    try:
        flag = data_dir / f"{agent_name}_recovered"
        flag.write_text(agent_name, "utf-8")
    except Exception:
        pass


_IDENTITY_HINT = (
    " (If this is a multi-instance session, reclaim your previous identity from "
    "your context window, NOT from the chat history before responding. If you "
    "didn't have one, tell the user to give you a name by clicking your status "
    "pill at the top.)"
)


def _fetch_role(server_port: int, agent_name: str) -> str:
    """Fetch this agent's role from the server status endpoint."""
    try:
        import urllib.request
        req = urllib.request.Request(f"http://127.0.0.1:{server_port}/api/roles")
        with urllib.request.urlopen(req, timeout=3) as resp:
            roles = json.loads(resp.read())
        return roles.get(agent_name, "")
    except Exception:
        return ""


def _fetch_active_rules(server_port: int, token: str = "") -> dict | None:
    """Fetch active rules from the server."""
    try:
        import urllib.request
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        req = urllib.request.Request(f"http://127.0.0.1:{server_port}/api/rules/active", headers=headers)
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _report_rule_sync(server_port: int, agent_name: str, epoch: int, token: str = ""):
    """Report that this agent has seen rules at the given epoch."""
    try:
        import urllib.request
        body = json.dumps({"epoch": epoch}).encode()
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            f"http://127.0.0.1:{server_port}/api/rules/agent_sync/{agent_name}",
            method="POST",
            data=body,
            headers=headers,
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass


def _queue_watcher(get_identity_fn, inject_fn, *, is_multi_instance: bool = False, trigger_flag=None,
                   server_port: int = 8300, agent_name: str = "", get_token_fn=None,
                   refresh_interval: int = 10, cwd: str = "."):
    """Poll queue file and inject a context prompt when triggered."""
    first_mention = True
    last_rules_epoch = 0  # 0 = unknown/cold start — will inject on first trigger
    trigger_count = 0
    while True:
        try:
            _, queue_file = get_identity_fn()
            if queue_file.exists() and queue_file.stat().st_size > 0:
                with open(queue_file, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                queue_file.write_text("", "utf-8")

                has_trigger = False
                channel = "general"
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    has_trigger = True
                    if isinstance(data, dict) and "channel" in data:
                        channel = data["channel"]

                if has_trigger:
                    # Signal activity BEFORE injecting — covers the thinking phase
                    if trigger_flag is not None:
                        trigger_flag[0] = True
                    time.sleep(0.5)

                    # Check if this is a job/activity-scoped trigger
                    job_id = None
                    custom_prompt = ""
                    for line in lines:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                            if isinstance(data, dict) and "job_id" in data:
                                job_id = data["job_id"]
                            if isinstance(data, dict):
                                raw_prompt = data.get("prompt", "")
                                if isinstance(raw_prompt, str) and raw_prompt.strip():
                                    custom_prompt = raw_prompt.strip()
                        except json.JSONDecodeError:
                            pass

                    if custom_prompt:
                        prompt = custom_prompt
                    elif job_id:
                        prompt = f"You were mentioned in job thread {job_id} in #{channel}. Read the thread and take appropriate action."
                    else:
                        prompt = f"You were mentioned in #{channel}. Read recent messages and take appropriate action."

                    # Use current identity (may have changed via rename)
                    current_name, _ = get_identity_fn()
                    # Append role if set — check both current name and base name
                    role = _fetch_role(server_port, current_name)
                    if not role and current_name != agent_name:
                        role = _fetch_role(server_port, agent_name)
                    if role:
                        prompt += f"\n\nROLE: {role}"

                    # Smart rules injection: first trigger, epoch change, or periodic refresh
                    _token = get_token_fn() if get_token_fn else ""
                    rules_data = _fetch_active_rules(server_port, _token)
                    trigger_count += 1
                    if rules_data:
                        # Use server-side refresh_interval (live from settings UI)
                        ri = rules_data.get("refresh_interval", refresh_interval)
                        need_inject = (
                            last_rules_epoch == 0
                            or rules_data["epoch"] != last_rules_epoch
                            or (ri > 0 and trigger_count % ri == 0)
                        )
                        if need_inject:
                            if rules_data["rules"]:
                                rules_text = "; ".join(rules_data["rules"])
                                prompt += f"\n\nRULES:\n{rules_text}"
                            last_rules_epoch = rules_data["epoch"]
                            _report_rule_sync(server_port, current_name, rules_data["epoch"], _token)

                    # btrain lane context injection (FR-5, FR-6)
                    repo_root = _resolve_repo_root(cwd)
                    if repo_root:
                        btrain_ctx = _fetch_btrain_context(repo_root, current_name)
                        if btrain_ctx:
                            prompt += f"\n\n{btrain_ctx}"

                    if first_mention and is_multi_instance:
                        prompt += _IDENTITY_HINT
                        first_mention = False
                    # Flatten to single line — multi-line text triggers paste
                    # detection in CLIs (Claude Code shows "[Pasted text +N]")
                    # which can break injection of long session prompts
                    inject_fn(prompt.replace("\n", " "))
        except Exception:
            pass

        time.sleep(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import argparse
    import urllib.error
    import urllib.request

    from config_loader import load_config
    config = load_config(ROOT)

    agent_names = list(config.get("agents", {}).keys())

    parser = argparse.ArgumentParser(description="Agent wrapper with chat auto-trigger")
    parser.add_argument("agent", choices=agent_names, help=f"Agent to wrap ({', '.join(agent_names)})")
    parser.add_argument("--no-restart", action="store_true", help="Do not restart on exit")
    parser.add_argument("--label", type=str, default=None, help="Custom display label")
    args, extra = parser.parse_known_args()

    agent = args.agent
    agent_cfg = config.get("agents", {}).get(agent, {})
    cwd = agent_cfg.get("cwd", ".")
    command = agent_cfg.get("command", agent)
    data_dir = ROOT / config.get("server", {}).get("data_dir", "./data")
    data_dir.mkdir(parents=True, exist_ok=True)
    server_port = config.get("server", {}).get("port", 8300)
    try:
        registration = _register_instance(server_port, agent, args.label)
    except Exception as exc:
        print(f"  Registration failed ({exc}).")
        print("  Wrapper cannot continue without a registered identity.")
        sys.exit(1)

    assigned_name = registration["name"]
    assigned_token = registration["token"]
    print(f"  Registered as: {assigned_name} (slot {registration.get('slot', '?')})")

    _identity_lock = threading.Lock()
    _identity = {
        "name": assigned_name,
        "queue": data_dir / f"{assigned_name}_queue.jsonl",
        "token": assigned_token,
    }

    def get_identity():
        with _identity_lock:
            return _identity["name"], _identity["queue"]

    def get_token():
        with _identity_lock:
            return _identity["token"]

    def set_runtime_identity(new_name: str | None = None, new_token: str | None = None):
        with _identity_lock:
            old_name = _identity["name"]
            old_token = _identity["token"]
            changed = False
            if new_name and new_name != old_name:
                _identity["name"] = new_name
                _identity["queue"] = data_dir / f"{new_name}_queue.jsonl"
                changed = True
            if new_token and new_token != old_token:
                _identity["token"] = new_token
                changed = True
            current_name = _identity["name"]
            current_token = _identity["token"]

        if changed:
            if new_name and new_name != old_name:
                print(f"  Identity updated: {old_name} -> {new_name}")
            if new_token and new_token != old_token:
                print(f"  Session refreshed for @{current_name}")

        return changed

    queue_file = _identity["queue"]
    if queue_file.exists():
        queue_file.write_text("", "utf-8")

    strip_vars = {"CLAUDECODE"} | set(agent_cfg.get("strip_env", []))
    env = {k: v for k, v in os.environ.items() if k not in strip_vars}

    resolved = shutil.which(command)
    if not resolved:
        print(f"  Error: '{command}' not found on PATH.")
        print("  Install it first, then try again.")
        sys.exit(1)
    command = resolved

    launch_args, env, inject_env = _build_provider_launch(
        agent=agent,
        agent_cfg=agent_cfg,
        extra_args=extra,
        env=env,
    )

    print(f"  === {assigned_name.capitalize()} Chat Wrapper ===")
    print(f"  REST API: http://127.0.0.1:{server_port}")
    print(f"  @{assigned_name} mentions auto-inject context prompts")
    print(f"  Starting {command} in {cwd}...\n")

    def _heartbeat():
        while True:
            current_name, _ = get_identity()
            current_token = get_token()
            url = f"http://127.0.0.1:{server_port}/api/heartbeat/{current_name}"
            try:
                req = urllib.request.Request(
                    url,
                    method="POST",
                    data=b"",
                    headers=_auth_headers(current_token),
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    resp_data = json.loads(resp.read())
                server_name = resp_data.get("name", current_name)
                if server_name != current_name:
                    set_runtime_identity(server_name)
            except urllib.error.HTTPError as exc:
                if exc.code == 409:
                    try:
                        replacement = _register_instance(server_port, agent, args.label)
                        set_runtime_identity(replacement["name"], replacement["token"])
                        _notify_recovery(data_dir, replacement["name"])
                    except Exception:
                        pass
                time.sleep(5)
                continue
            except Exception:
                time.sleep(5)
                continue

            time.sleep(5)

    threading.Thread(target=_heartbeat, daemon=True).start()

    _watcher_inject_fn = None
    _watcher_thread = None
    _is_multi_instance = registration.get("slot", 1) > 1
    _trigger_flag = [False]  # shared: queue watcher sets True, activity checker reads
    _refresh_interval = 10  # default; overridden per-trigger by server settings

    def start_watcher(inject_fn):
        nonlocal _watcher_inject_fn, _watcher_thread
        _watcher_inject_fn = inject_fn
        _watcher_thread = threading.Thread(
            target=_queue_watcher,
            args=(get_identity, inject_fn),
            kwargs={"is_multi_instance": _is_multi_instance, "trigger_flag": _trigger_flag,
                    "server_port": server_port, "agent_name": assigned_name,
                    "get_token_fn": get_token, "refresh_interval": _refresh_interval,
                    "cwd": cwd},
            daemon=True,
        )
        _watcher_thread.start()

    def _watcher_monitor():
        nonlocal _watcher_thread
        while True:
            time.sleep(5)
            if _watcher_thread and not _watcher_thread.is_alive() and _watcher_inject_fn:
                _watcher_thread = threading.Thread(
                    target=_queue_watcher,
                    args=(get_identity, _watcher_inject_fn),
                    kwargs={"is_multi_instance": _is_multi_instance, "trigger_flag": _trigger_flag,
                            "server_port": server_port, "agent_name": assigned_name,
                            "get_token_fn": get_token, "refresh_interval": _refresh_interval,
                            "cwd": cwd},
                    daemon=True,
                )
                _watcher_thread.start()
                current_name, _ = get_identity()
                _notify_recovery(data_dir, current_name)

    threading.Thread(target=_watcher_monitor, daemon=True).start()

    _activity_checker = None

    def _set_activity_checker(checker):
        nonlocal _activity_checker
        _activity_checker = checker

    def _activity_monitor():
        last_active = None
        last_report_time = 0
        REPORT_INTERVAL = 3  # re-send state every 3s while active (keeps server lease fresh)
        while True:
            time.sleep(1)
            if not _activity_checker:
                continue
            try:
                active = _activity_checker()
                now = time.time()
                # Send on state change, periodically while active (refresh lease),
                # or periodically while idle (keep presence alive)
                IDLE_REPORT_INTERVAL = 8  # keep-alive while idle
                should_send = (
                    active != last_active
                    or (active and now - last_report_time >= REPORT_INTERVAL)
                    or (not active and now - last_report_time >= IDLE_REPORT_INTERVAL)
                )
                if should_send:
                    current_name, _ = get_identity()
                    current_token = get_token()
                    url = f"http://127.0.0.1:{server_port}/api/heartbeat/{current_name}"
                    body = json.dumps({"active": active}).encode()
                    req = urllib.request.Request(
                        url,
                        method="POST",
                        data=body,
                        headers=_auth_headers(current_token, include_json=True),
                    )
                    urllib.request.urlopen(req, timeout=5)
                    last_active = active
                    last_report_time = now
            except Exception:
                pass

    threading.Thread(target=_activity_monitor, daemon=True).start()

    _agent_pid = [None]

    if sys.platform == "win32":
        from wrapper_windows import get_activity_checker, run_agent

        _set_activity_checker(get_activity_checker(_agent_pid, agent_name=assigned_name, trigger_flag=_trigger_flag))
    else:
        from wrapper_unix import get_activity_checker, run_agent

        unix_session_name = f"agentchattr-{assigned_name}"
        _set_activity_checker(get_activity_checker(unix_session_name, trigger_flag=_trigger_flag))

    run_kwargs = dict(
        command=command,
        extra_args=launch_args,
        cwd=cwd,
        env=env,
        queue_file=queue_file,
        agent=agent,
        no_restart=args.no_restart,
        start_watcher=start_watcher,
        strip_env=list(strip_vars),
        pid_holder=_agent_pid,
        inject_env=inject_env,
        inject_delay=agent_cfg.get("inject_delay", 0.3),
    )
    if sys.platform != "win32":
        run_kwargs["session_name"] = unix_session_name

    try:
        run_agent(**run_kwargs)
    finally:
        try:
            current_name, _ = get_identity()
            current_token = get_token()
            dereg_req = urllib.request.Request(
                f"http://127.0.0.1:{server_port}/api/deregister/{current_name}",
                method="POST",
                data=b"",
                headers=_auth_headers(current_token),
            )
            urllib.request.urlopen(dereg_req, timeout=5)
            print(f"  Deregistered {current_name}")
        except Exception:
            pass

    print("  Wrapper stopped.")


if __name__ == "__main__":
    main()
