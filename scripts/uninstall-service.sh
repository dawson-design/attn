#!/usr/bin/env bash
#
# Remove the notification-watch LaunchAgent. Leaves .local-state/ (your
# acks/mutes, cache, logs) untouched.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

LABEL="$(gw_label ghe-notification-watch)"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="$(gw_domain)"

echo "==> Unloading $LABEL from $DOMAIN"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "==> Removed $PLIST_DST. Local state under .local-state/ was kept."
