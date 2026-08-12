#!/usr/bin/env bash
#
# Thin delegator: removes the window LaunchAgent via src/cli/main.ts
# (uninstall-window). Does not close any already-open Chrome window or affect
# the backend service.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/../src/cli/main.ts" uninstall-window
