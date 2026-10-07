#!/usr/bin/env bash
#
# Patch the running service after iterating on the code: rebuild the bundle,
# then restart the LaunchAgent. The build runs BEFORE the restart, so a broken
# build aborts here and leaves the currently-running instance untouched.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

APP_DIR="$(gw_app_dir)"
LABEL="$(gw_label attn)"
DOMAIN="$(gw_domain)"
PORT="$(gw_port)"

if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "ERROR: $LABEL is not loaded. Run scripts/install-service.sh first." >&2
    exit 1
fi

echo "==> Rebuilding $APP_DIR"
( cd "$APP_DIR" && bun install --frozen-lockfile && bun run build )

echo "==> Restarting service with the new bundle"
launchctl kickstart -k "$DOMAIN/$LABEL"

# Give the new process a moment to bind, then health-check.
sleep 1
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT" || echo 000)"
echo "==> http://127.0.0.1:$PORT -> HTTP $CODE"
echo "--- tail service.err.log ---"
tail -n 15 "$APP_DIR/.local-state/logs/service.err.log" 2>/dev/null || true
