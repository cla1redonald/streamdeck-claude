#!/usr/bin/env bash
# Remove the streamdeck-claude broker LaunchAgent.
set -euo pipefail

LABEL="com.streamdeck-claude.broker"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "Uninstalled $LABEL (LaunchAgent removed). The broker is no longer running."
