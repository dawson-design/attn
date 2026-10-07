#!/usr/bin/env bash
#
# One-time install of the notification-watch macOS LaunchAgent.
# Renders the plist template with paths/host derived from this machine + env,
# builds the app, installs the plist into ~/Library/LaunchAgents, and loads it.
# Re-running is safe (idempotent): it boots out any existing instance first.
#
# Deployment config comes from the environment (or a .env in the repo root):
#   ATTN_HOST  target GitHub (Enterprise) host   (default github.com)
#   ATTN_PORT  local dashboard port              (default 8765)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_DIR="$(gw_app_dir)"
LABEL="$(gw_label attn)"
DOMAIN="$(gw_domain)"
PLIST_SRC="$SCRIPT_DIR/service.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

BUN="$(gw_require_bin bun)"
GH="$(gw_require_bin gh)"
LAUNCH_PATH="$(gw_launchd_path "$BUN" "$GH")"
HOST="$(gw_host)"
PORT="$(gw_port)"

echo "==> Installing $LABEL"
echo "    app dir: $APP_DIR"
echo "    host:    $HOST   port: $PORT"

# gh auth is per-host; warn (don't fail) if the target host isn't logged in.
if ! "$GH" auth status --hostname "$HOST" >/dev/null 2>&1; then
    echo "WARNING: 'gh auth status --hostname $HOST' is not green. The service will" >&2
    echo "         run but show empty/stale data until you 'gh auth login --hostname $HOST'." >&2
fi

# Ensure log dir and a fresh build exist (build/ is gitignored).
mkdir -p "$APP_DIR/.local-state/logs"
echo "==> Building (bun install + bun run build)"
( cd "$APP_DIR" && "$BUN" install --frozen-lockfile && "$BUN" run build )

# Render the template and (re)load the LaunchAgent.
echo "==> Rendering plist -> $PLIST_DST"
gw_render_template "$PLIST_SRC" "$PLIST_DST" "$LABEL" "$APP_DIR" "$BUN" "$LAUNCH_PATH" "$HOST" "$PORT"

echo "==> Loading LaunchAgent into $DOMAIN"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "==> Done. Open the dashboard with: bun run cli open"
echo "    status: launchctl print $DOMAIN/$LABEL"
echo "    logs:   $APP_DIR/.local-state/logs/service.{out,err}.log"
