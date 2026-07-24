#!/usr/bin/env bash
#
# One-time install of the dashboard-window LaunchAgent, which opens a dedicated
# Chrome app window to the dashboard at login (see open-dashboard-window.sh).
# This only opens a window -- run scripts/install-service.sh first to have a
# backend to point it at.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_DIR="$(gw_app_dir)"
LABEL="$(gw_label ghe-notification-watch-window)"
DOMAIN="$(gw_domain)"
PLIST_SRC="$SCRIPT_DIR/window.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

# The window launcher runs a shell script, not bun/gh, but keep gh on PATH so
# the launched process matches the service environment; port drives the URL.
GH="$(gw_require_bin gh 2>/dev/null || true)"
LAUNCH_PATH="$(gw_launchd_path "$GH")"
PORT="$(gw_port)"

echo "==> Installing $LABEL"

chmod +x "$SCRIPT_DIR/open-dashboard-window.sh"
[[ -d "/Applications/Google Chrome.app" ]] || echo "WARNING: Google Chrome.app not found in /Applications" >&2

mkdir -p "$APP_DIR/.local-state/logs"
echo "==> Rendering plist -> $PLIST_DST"
gw_render_template "$PLIST_SRC" "$PLIST_DST" "$LABEL" "$APP_DIR" "" "$LAUNCH_PATH" "" "$PORT"

echo "==> Loading LaunchAgent into $DOMAIN"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "==> Done. A Chrome app window should open shortly (once http://127.0.0.1:$PORT responds)."
echo "    First time only: click 'Enable notifications' in the dashboard header and Allow"
echo "    the Chrome permission prompt so new items trigger a macOS notification."
