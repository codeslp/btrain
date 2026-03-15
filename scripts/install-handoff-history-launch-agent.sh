#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_BASE="${CODEX_HOME:-$HOME/.codex}"
REPO_SLUG="ai_sales_brain_train"
DEFAULT_LABEL="com.codeslp.handoff-history.ai-sales-brain-train"
CONFIG_DIR="${HANDOFF_AGENT_CONFIG_DIR_OVERRIDE:-$CODEX_BASE/collab/$REPO_SLUG}"
CONFIG_PATH="$CONFIG_DIR/handoff-history-agent.env"
WATCH_LIST_PATH="$CONFIG_DIR/handoff-watch-paths.txt"
NODE_PATH="${NODE_PATH_OVERRIDE:-$(command -v node)}"
STATE_PATH="${HANDOFF_HISTORY_STATE_PATH_OVERRIDE:-$CONFIG_DIR/handoff-history-state.json}"
LOG_DIR="$CONFIG_DIR"
STDOUT_LOG="$LOG_DIR/handoff-history-agent.log"
STDERR_LOG="$LOG_DIR/handoff-history-agent.err.log"
LABEL="${HANDOFF_HISTORY_AGENT_LABEL_OVERRIDE:-$DEFAULT_LABEL}"
PLIST_PATH="${HANDOFF_HISTORY_AGENT_PLIST_PATH_OVERRIDE:-$HOME/Library/LaunchAgents/$LABEL.plist}"
LEGACY_LABEL="${HANDOFF_HISTORY_AGENT_LEGACY_LABEL_OVERRIDE:-}"

mkdir -p "$LOG_DIR"

if [ -f "$CONFIG_PATH" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_PATH"
fi

HISTORY_PATH="${HANDOFF_HISTORY_PATH_OVERRIDE:-${HANDOFF_HISTORY_PATH:-}}"
WATCH_REPO_PATH="${WATCH_REPO_PATH_OVERRIDE:-$ROOT_DIR}"

if [ -z "$HISTORY_PATH" ]; then
  echo "HANDOFF_HISTORY_PATH_OVERRIDE or HANDOFF_HISTORY_PATH must be set." >&2
  exit 1
fi

bash "$ROOT_DIR/scripts/register-handoff-watch-path.sh" "$WATCH_REPO_PATH"

cat >"$CONFIG_PATH" <<ENVFILE
HANDOFF_HISTORY_PATH=$HISTORY_PATH
HANDOFF_WATCH_CONFIG_PATH=$WATCH_LIST_PATH
ENVFILE

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HANDOFF_HISTORY_PATH</key>
    <string>$HISTORY_PATH</string>
    <key>HANDOFF_WATCH_CONFIG_PATH</key>
    <string>$WATCH_LIST_PATH</string>
    <key>HANDOFF_HISTORY_STATE_PATH</key>
    <string>$STATE_PATH</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$ROOT_DIR/scripts/handoff-history-watcher.mjs</string>
  </array>
  <key>StandardOutPath</key>
  <string>$STDOUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_LOG</string>
</dict>
</plist>
PLIST

if [ -n "$LEGACY_LABEL" ]; then
  launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" >/dev/null 2>&1 || true
fi
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed and started $LABEL"
echo "Plist: $PLIST_PATH"
echo "History: $HISTORY_PATH"
echo "Watch list: $WATCH_LIST_PATH"
