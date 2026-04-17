#!/usr/bin/env sh
# agentchattr - starts server (if not running) + Codex wrapper
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

ensure_venv || exit 1

# Pre-flight readiness check
echo "  Checking codex readiness..."
if ! command -v codex >/dev/null 2>&1; then
    echo ""
    echo "  FAIL: 'codex' not found on PATH."
    echo "  Install Codex CLI: npm install -g @openai/codex"
    echo ""
    exit 1
fi
echo "  OK: codex found at $(command -v codex)"

start_server_if_needed || exit 1

"$AGENTCHATTR_VENV_PYTHON" wrapper.py codex
