#!/usr/bin/env sh
# agentchattr - starts server (if not running) + Gemini wrapper
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

# Warn if ripgrep is missing (Gemini CLI can hang on init - upstream bug)
if ! command -v rg >/dev/null 2>&1; then
    echo ""
    echo "  Warning: ripgrep (rg) not found on PATH."
    echo "  Gemini CLI can hang on \"Initializing...\" for several minutes."
    echo "  Fix: apt install ripgrep (Linux) or brew install ripgrep (macOS)"
    echo "  See: https://github.com/google-gemini/gemini-cli/issues/13986"
    echo ""
fi

ensure_venv || exit 1

# Pre-flight readiness check
echo "  Checking gemini readiness..."
if ! command -v gemini >/dev/null 2>&1; then
    echo ""
    echo "  FAIL: 'gemini' not found on PATH."
    echo "  Install Gemini CLI: npm install -g @google/gemini-cli"
    echo ""
    exit 1
fi
echo "  OK: gemini found at $(command -v gemini)"

start_server_if_needed || exit 1

"$AGENTCHATTR_VENV_PYTHON" wrapper.py gemini
