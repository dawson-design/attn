#!/usr/bin/env bash
#
# Opens the dashboard as a dedicated Chrome app window (no tabs/toolbar) so the
# page's client-side EventSource + Notification code (src/routes/+page.svelte)
# keeps running in the background after login. That code only fires macOS
# notifications while a window/tab has the page loaded -- there's no service
# worker / push subscription, so this window is what makes notifications
# actually happen.
#
# Waits for the backend LaunchAgent to start responding before opening, since
# both LaunchAgents are RunAtLoad with no ordering guarantee between them.
#
set -euo pipefail

URL="http://127.0.0.1:${GHE_WATCH_PORT:-8765}"
CHROME_APP="Google Chrome"

echo "==> Waiting for $URL to respond"
for _ in $(seq 1 30); do
    if curl -sS -o /dev/null -m 2 "$URL"; then
        break
    fi
    sleep 1
done

echo "==> Opening dashboard app window"
open -na "$CHROME_APP" --args --app="$URL"
