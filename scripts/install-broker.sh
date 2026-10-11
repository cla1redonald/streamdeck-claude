#!/usr/bin/env bash
# Install the streamdeck-claude broker as a launchd LaunchAgent (always-on, auto-restart).
set -euo pipefail

LABEL="com.streamdeck-claude.broker"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$REPO_DIR/scripts/broker.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/streamdeck-broker.log"
NODE_BIN="$(command -v node)"
BROKER_JS="$REPO_DIR/dist/broker.js"
PORT="${STREAMDECK_PORT:-7777}"
UID_NUM="$(id -u)"
# Optional shared secret (recommended). Export it before running this script.
SECRET="${STREAMDECK_BROKER_SECRET:-}"
SECRET_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/streamdeck-claude/secret"

if [ -n "$SECRET" ] && ! [[ "$SECRET" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: STREAMDECK_BROKER_SECRET may only contain letters, digits, '.', '_' and '-'." >&2
  echo "       Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

echo "==> Building"
( cd "$REPO_DIR" && npm run build )
[ -f "$BROKER_JS" ] || { echo "ERROR: $BROKER_JS missing after build" >&2; exit 1; }

# Warn if the port is held by something that isn't our broker (e.g. an old per-session server)
if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if ! curl -s -m 1 "http://127.0.0.1:$PORT/status" | grep -q queueLength; then
    echo "WARNING: port $PORT is in use by a non-broker process."
    echo "         If it's a stale per-session server, kill it first:"
    echo "         pkill -f streamdeck-claude/dist/index.js"
  fi
fi

echo "==> Writing LaunchAgent: $PLIST_DST"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__BROKER_JS__|$BROKER_JS|g" \
    -e "s|__LOG__|$LOG|g" \
    -e "s|__PORT__|$PORT|g" \
    "$PLIST_SRC" > "$PLIST_DST"

if [ -n "$SECRET" ]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:STREAMDECK_BROKER_SECRET string $SECRET" "$PLIST_DST"
  chmod 600 "$PLIST_DST"
  # Stream Deck buttons do not inherit your shell, so approve.command and
  # deny.command read the secret from this file.
  mkdir -p "$(dirname "$SECRET_FILE")"
  ( umask 077 && printf '%s' "$SECRET" > "$SECRET_FILE" )
  echo "==> Shared secret enabled (stored in the LaunchAgent and $SECRET_FILE, mode 600)"
else
  rm -f "$SECRET_FILE"
  echo "==> No STREAMDECK_BROKER_SECRET set: broker will accept unauthenticated local requests"
fi

echo "==> Loading via launchctl"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"
launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true

echo "==> Waiting for broker"
for _ in $(seq 1 20); do
  if curl -s -m 1 "http://127.0.0.1:$PORT/status" | grep -q queueLength; then
    echo "OK: broker live on http://127.0.0.1:$PORT"
    curl -s "http://127.0.0.1:$PORT/status"; echo
    exit 0
  fi
  sleep 0.3
done
echo "ERROR: broker did not respond, check log: $LOG" >&2
exit 1
