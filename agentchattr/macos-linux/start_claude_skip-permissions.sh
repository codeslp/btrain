#!/usr/bin/env sh
# agentchattr - starts server (if not running) + Claude wrapper (auto-approve mode)
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

ensure_venv || exit 1
start_server_if_needed || exit 1

"$AGENTCHATTR_VENV_PYTHON" wrapper.py claude --dangerously-skip-permissions
