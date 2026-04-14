#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_BASE="${CODEX_HOME:-$HOME/.codex}"

slugify_repo_name() {
  local value="${1:-repo}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g')"
  while [[ "$value" == *"__"* ]]; do
    value="${value//__/_}"
  done
  value="${value#_}"
  value="${value%_}"
  if [ -z "$value" ]; then
    value="repo"
  fi
  printf '%s' "$value"
}

REPO_NAME="$(basename "$ROOT_DIR")"
DEFAULT_REPO_SLUG="$(slugify_repo_name "$REPO_NAME")"
REPO_SLUG="${HANDOFF_AGENT_REPO_SLUG_OVERRIDE:-$DEFAULT_REPO_SLUG}"
DEFAULT_LABEL="com.codeslp.handoff-history.${REPO_SLUG//_/-}"
LEGACY_REPO_SLUG=""
LEGACY_DEFAULT_LABEL=""
if [ "$REPO_SLUG" = "btrain" ]; then
  LEGACY_REPO_SLUG="ai_sales_brain_train"
  LEGACY_DEFAULT_LABEL="com.codeslp.handoff-history.ai-sales-brain-train"
fi

CONFIG_DIR="${HANDOFF_AGENT_CONFIG_DIR_OVERRIDE:-$CODEX_BASE/collab/$REPO_SLUG}"
WATCH_LIST_PATH="$CONFIG_DIR/handoff-watch-paths.txt"
TARGET_INPUT="${1:-${WATCH_REPO_PATH_OVERRIDE:-$ROOT_DIR}}"
LABEL="${HANDOFF_HISTORY_AGENT_LABEL_OVERRIDE:-$DEFAULT_LABEL}"
LEGACY_LABEL="${HANDOFF_HISTORY_AGENT_LEGACY_LABEL_OVERRIDE:-$LEGACY_DEFAULT_LABEL}"
LEGACY_CONFIG_DIR=""
LEGACY_WATCH_LIST_PATH=""
if [ -n "$LEGACY_REPO_SLUG" ]; then
  LEGACY_CONFIG_DIR="$CODEX_BASE/collab/$LEGACY_REPO_SLUG"
  LEGACY_WATCH_LIST_PATH="$LEGACY_CONFIG_DIR/handoff-watch-paths.txt"
fi

if [ -d "$TARGET_INPUT" ]; then
  TARGET_PATH="$(cd "$TARGET_INPUT" && pwd)"
else
  TARGET_PATH="$(cd "$(dirname "$TARGET_INPUT")" && pwd)/$(basename "$TARGET_INPUT")"
fi

append_watch_path() {
  local watch_list_path="$1"
  mkdir -p "$(dirname "$watch_list_path")"
  touch "$watch_list_path"

  if ! grep -Fxq "$TARGET_PATH" "$watch_list_path"; then
    printf '%s\n' "$TARGET_PATH" >>"$watch_list_path"
  fi
}

kickstart_if_running() {
  local label="$1"
  if is_launch_agent_running "$label"; then
    launchctl kickstart -k "gui/$(id -u)/$label"
    echo "Restarted $label to pick up watch-list changes."
    return 0
  fi

  return 1
}

is_launch_agent_running() {
  local label="$1"
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1
}

append_watch_path "$WATCH_LIST_PATH"

if [ -n "$LEGACY_WATCH_LIST_PATH" ] && [ "$LEGACY_WATCH_LIST_PATH" != "$WATCH_LIST_PATH" ]; then
  if [ -d "$LEGACY_CONFIG_DIR" ] || [ -f "$LEGACY_WATCH_LIST_PATH" ] || is_launch_agent_running "$LEGACY_LABEL"; then
    append_watch_path "$LEGACY_WATCH_LIST_PATH"
    echo "Legacy watch list: $LEGACY_WATCH_LIST_PATH"
  fi
fi

echo "Registered handoff watch path: $TARGET_PATH"
echo "Watch list: $WATCH_LIST_PATH"

kickstart_if_running "$LABEL" >/dev/null || true
if [ "$LEGACY_LABEL" != "$LABEL" ]; then
  kickstart_if_running "$LEGACY_LABEL" >/dev/null || true
fi
