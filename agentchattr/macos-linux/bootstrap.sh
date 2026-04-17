#!/usr/bin/env sh

MIN_PYTHON_MAJOR=3
MIN_PYTHON_MINOR=11
AGENTCHATTR_VENV_PYTHON=".venv/bin/python"

python_meets_minimum() {
    candidate="$1"
    "$candidate" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (${MIN_PYTHON_MAJOR}, ${MIN_PYTHON_MINOR}) else 1)" >/dev/null 2>&1
}

resolve_python_bin() {
    for candidate in "${AGENTCHATTR_PYTHON:-}" python3.13 python3.12 python3.11 python3 python; do
        [ -n "$candidate" ] || continue

        if [ -x "$candidate" ]; then
            resolved="$candidate"
        else
            resolved="$(command -v "$candidate" 2>/dev/null || true)"
        fi

        [ -n "$resolved" ] || continue
        if python_meets_minimum "$resolved"; then
            printf '%s\n' "$resolved"
            return 0
        fi
    done

    return 1
}

requirements_hash() {
    python_bin="$1"
    "$python_bin" -c 'import hashlib, pathlib; print(hashlib.sha256(pathlib.Path("requirements.txt").read_bytes()).hexdigest())'
}

ensure_venv() {
    if [ -d ".venv" ] && [ ! -x "$AGENTCHATTR_VENV_PYTHON" ]; then
        echo "Recreating .venv for this platform..."
        rm -rf .venv
    fi

    if [ -x "$AGENTCHATTR_VENV_PYTHON" ] && ! python_meets_minimum "$AGENTCHATTR_VENV_PYTHON"; then
        echo "Recreating .venv for a Python ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}+ runtime..."
        rm -rf .venv
    fi

    if [ ! -x "$AGENTCHATTR_VENV_PYTHON" ]; then
        PYTHON_BIN="$(resolve_python_bin)" || {
            echo "Python ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}+ is required but no compatible interpreter was found."
            echo "Install python3.11, python3.12, or python3.13, or set AGENTCHATTR_PYTHON to a compatible interpreter."
            return 1
        }
        echo "Creating virtual environment with $("$PYTHON_BIN" --version 2>&1)..."
        "$PYTHON_BIN" -m venv .venv || {
            echo "Error: failed to create .venv with $PYTHON_BIN."
            return 1
        }
    fi

    expected_hash="$(requirements_hash "$AGENTCHATTR_VENV_PYTHON")" || {
        echo "Error: failed to read requirements.txt."
        return 1
    }
    hash_file=".venv/.requirements.sha256"
    current_hash="$(cat "$hash_file" 2>/dev/null || true)"

    if [ "$current_hash" != "$expected_hash" ]; then
        echo "Syncing Python dependencies from requirements.txt..."
        "$AGENTCHATTR_VENV_PYTHON" -m pip install -q -r requirements.txt || {
            echo "Error: failed to install Python dependencies."
            return 1
        }
        printf '%s\n' "$expected_hash" > "$hash_file"
    fi
}

is_server_running() {
    lsof -i :8300 -sTCP:LISTEN >/dev/null 2>&1 || \
    ss -tlnp 2>/dev/null | grep -q ':8300 '
}

start_server_if_needed() {
    if is_server_running; then
        return 0
    fi

    if [ "$(uname -s)" = "Darwin" ]; then
        osascript -e "tell app \"Terminal\" to do script \"cd '$(pwd)' && $AGENTCHATTR_VENV_PYTHON run.py\"" > /dev/null 2>&1
    else
        if command -v gnome-terminal >/dev/null 2>&1; then
            gnome-terminal -- sh -c "cd '$(pwd)' && $AGENTCHATTR_VENV_PYTHON run.py; printf 'Press Enter to close... '; read _"
        elif command -v xterm >/dev/null 2>&1; then
            xterm -e sh -c "cd '$(pwd)' && $AGENTCHATTR_VENV_PYTHON run.py" &
        else
            "$AGENTCHATTR_VENV_PYTHON" run.py > data/server.log 2>&1 &
        fi
    fi

    i=0
    while [ "$i" -lt 30 ]; do
        if is_server_running; then
            return 0
        fi
        sleep 0.5
        i=$((i + 1))
    done

    echo "Error: agentchattr server did not start within 15 seconds."
    return 1
}
