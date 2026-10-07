#!/usr/bin/env bash
#
# Package the run-only distribution artifact: a self-contained libexec/ tree
# (bundled server + bundled CLI + review-prompt seed) tarred into
# dist/attn-v<version>.tar.gz with a .sha256 alongside, ready to attach to
# a GitHub release for the Homebrew formula to consume.
#
# Requires a fresh `bun run build` first; the server bundle is produced from
# build/handler.js so it needs no node_modules at runtime (verified by the
# release smoke test).
#
# Usage: scripts/package-artifact.sh [version]
#   version defaults to `git describe --tags --always`, with any leading v
#   stripped.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${1:-$(git -C "$APP_DIR" describe --tags --always)}"
VERSION="${VERSION#v}"

command -v bun >/dev/null || { echo "ERROR: bun not found on PATH" >&2; exit 1; }
[[ -f "$APP_DIR/build/handler.js" ]] || { echo "ERROR: build/handler.js missing — run 'bun run build' first" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/libexec/server" "$STAGE/libexec/share"

echo "==> Bundling server"
# `attn serve` runs adapter-node's handler inside its own HTTPS server.
bun build --target=bun "$APP_DIR/build/handler.js" --outfile "$STAGE/libexec/server/handler.js" >/dev/null
cp -R "$APP_DIR/build/client" "$STAGE/libexec/server/client"

echo "==> Bundling CLI"
bun build --target=bun "$APP_DIR/src/cli/main.ts" --outfile "$STAGE/libexec/cli.js" >/dev/null

cp "$APP_DIR/prompts/review.md" "$STAGE/libexec/share/review.md"

mkdir -p "$APP_DIR/dist"
TARBALL_NAME="attn-v${VERSION}.tar.gz"
echo "==> Creating dist/$TARBALL_NAME"
tar -czf "$APP_DIR/dist/$TARBALL_NAME" -C "$STAGE" libexec
(cd "$APP_DIR/dist" && shasum -a 256 "$TARBALL_NAME" | tee "$TARBALL_NAME.sha256")
