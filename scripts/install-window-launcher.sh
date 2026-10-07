#!/usr/bin/env bash
#
# Thin delegator: the window-agent logic lives in src/cli/main.ts
# (install-window) so the dev checkout and the packaged `attn` CLI share
# one implementation. Kept for muscle memory; run scripts/install-service.sh
# first to have a backend to point the window at.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/../src/cli/main.ts" install-window
