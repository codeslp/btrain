#!/usr/bin/env sh
# agentchattr - starts server (if not running) + Claude wrapper
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

ensure_venv || exit 1

# Pre-flight readiness check
echo "  Checking claude readiness..."
if ! command -v claude >/dev/null 2>&1; then
    echo ""
    echo "  FAIL: 'claude' not found on PATH."
    echo "  Install Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code"
    echo ""
    exit 1
fi
echo "  OK: claude found at $(command -v claude)"

start_server_if_needed || exit 1

"$AGENTCHATTR_VENV_PYTHON" wrapper.py claude
