#!/usr/bin/env sh
# agentchattr - starts server (if not running) + Kilo wrapper
# Usage: sh start_kilo.sh [provider/model]
#   e.g. sh start_kilo.sh anthropic/claude-sonnet-4-20250514
#   Omit the model to use Kilo's configured default.
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

ensure_venv || exit 1
start_server_if_needed || exit 1

if [ -n "$1" ]; then
    "$AGENTCHATTR_VENV_PYTHON" wrapper.py kilo -- -m "$1"
else
    "$AGENTCHATTR_VENV_PYTHON" wrapper.py kilo
fi
