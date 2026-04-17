#!/usr/bin/env sh
# agentchattr — starts server (if not running) + API agent wrapper
# Usage: sh start_api_agent.sh <agent_name>
# Example: sh start_api_agent.sh qwen
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

if [ -z "$1" ]; then
    echo "Usage: start_api_agent.sh <agent_name>"
    echo "Example: start_api_agent.sh qwen"
    exit 1
fi

ensure_venv || exit 1
start_server_if_needed || exit 1

"$AGENTCHATTR_VENV_PYTHON" wrapper_api.py "$1"
