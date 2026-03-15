#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_BASE="${CODEX_HOME:-$HOME/.codex}"
REPO_SLUG="ai_sales_brain_train"
DEFAULT_LABEL="com.codeslp.handoff-history.ai-sales-brain-train"
CONFIG_DIR="${HANDOFF_AGENT_CONFIG_DIR_OVERRIDE:-$CODEX_BASE/collab/$REPO_SLUG}"
WATCH_LIST_PATH="$CONFIG_DIR/handoff-watch-paths.txt"
TARGET_INPUT="${1:-${WATCH_REPO_PATH_OVERRIDE:-$ROOT_DIR}}"
LABEL="${HANDOFF_HISTORY_AGENT_LABEL_OVERRIDE:-$DEFAULT_LABEL}"

if [ -d "$TARGET_INPUT" ]; then
  TARGET_PATH="$(cd "$TARGET_INPUT" && pwd)"
else
  TARGET_PATH="$(cd "$(dirname "$TARGET_INPUT")" && pwd)/$(basename "$TARGET_INPUT")"
fi

mkdir -p "$CONFIG_DIR"
touch "$WATCH_LIST_PATH"

if ! grep -Fxq "$TARGET_PATH" "$WATCH_LIST_PATH"; then
  printf '%s\n' "$TARGET_PATH" >>"$WATCH_LIST_PATH"
fi

echo "Registered handoff watch path: $TARGET_PATH"
echo "Watch list: $WATCH_LIST_PATH"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo "Restarted $LABEL to pick up watch-list changes."
fi
