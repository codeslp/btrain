#!/usr/bin/env sh
# agentchattr — starts server (if not running) + MiniMax API agent wrapper
# Usage: sh start_minimax.sh
# Requires MINIMAX_API_KEY environment variable.
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

# Check API key
if [ -z "$MINIMAX_API_KEY" ]; then
    echo "Error: MINIMAX_API_KEY environment variable is not set."
    echo "Get an API key at https://platform.minimax.io"
    echo "Then: export MINIMAX_API_KEY=your-key-here"
    exit 1
fi

ensure_venv || exit 1

start_server_if_needed || exit 1

"$AGENTCHATTR_VENV_PYTHON" wrapper_api.py minimax
