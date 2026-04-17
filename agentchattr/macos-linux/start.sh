#!/usr/bin/env sh
# agentchattr - starts the server only
cd "$(dirname "$0")/.."
if ! . "./macos-linux/bootstrap.sh"; then
    echo "Error: failed to load launcher helper."
    exit 1
fi

ensure_venv || exit 1

"$AGENTCHATTR_VENV_PYTHON" run.py
code=$?
echo ""
echo "=== Server exited with code $code ==="
exit "$code"
