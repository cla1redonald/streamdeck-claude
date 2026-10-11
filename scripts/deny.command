#!/bin/bash
# Stream Deck button: POST /deny to the local broker.
# Sends the shared secret if one is configured, taken from the environment or
# from the file written by install-broker.sh. Stream Deck does not inherit your
# shell environment, so the file is the usual route.
SECRET_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/streamdeck-claude/secret"
SECRET="${STREAMDECK_BROKER_SECRET:-}"
if [ -z "$SECRET" ] && [ -r "$SECRET_FILE" ]; then
  SECRET="$(cat "$SECRET_FILE")"
fi

if [ -n "$SECRET" ]; then
  curl -s -X POST -H "x-broker-secret: $SECRET" "http://127.0.0.1:${STREAMDECK_PORT:-7777}/deny" > /dev/null
else
  curl -s -X POST "http://127.0.0.1:${STREAMDECK_PORT:-7777}/deny" > /dev/null
fi
exit 0
