#!/usr/bin/env bash
#
# Remove the dashboard-window LaunchAgent. Does not close any already-open
# Chrome window or affect the backend service.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

LABEL="$(gw_label ghe-notification-watch-window)"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="$(gw_domain)"

echo "==> Unloading $LABEL from $DOMAIN"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "==> Removed $PLIST_DST."
