#!/usr/bin/env bash
set -euo pipefail

LABEL="ai.perplexity-direct.gateway"
SOURCE="$(cd "$(dirname "$0")/.." && pwd)/ops/launchd/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/perplexity-direct"
ln -sfn "$SOURCE" "$TARGET"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi
launchctl bootstrap "$DOMAIN" "$TARGET"
printf 'installed %s (RunAtLoad=true, KeepAlive=false)\n' "$LABEL"
