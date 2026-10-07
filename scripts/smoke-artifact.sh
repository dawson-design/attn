#!/usr/bin/env bash
#
# Boot the packaged artifact from a clean directory — no repo checkout, no
# node_modules — and prove the invariants a release must never break:
#
#   1. the server starts and answers 200 on loopback (page + a hashed asset)
#   2. a foreign Host header is rejected with 403 (DNS-rebinding guard)
#   3. state lands in the XDG state dir, not the cwd
#
# Run by the release workflow after scripts/package-artifact.sh; usable locally
# the same way.
#
# Usage: scripts/smoke-artifact.sh <tarball> [port]
#
set -euo pipefail

TARBALL="${1:?usage: smoke-artifact.sh <tarball> [port]}"
PORT="${2:-8791}"
BASE_URL="http://127.0.0.1:$PORT"

command -v bun >/dev/null || { echo "ERROR: bun not found on PATH" >&2; exit 1; }

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
    if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT

tar -xzf "$TARBALL" -C "$WORK"
mkdir -p "$WORK/home" "$WORK/config" "$WORK/state"

# env -i so nothing from the invoking shell (a real .env, ATTN_* vars)
# leaks in; only the artifact and the XDG dirs define behavior. cwd is the
# work dir so a cwd-relative path regression shows up as a stray .local-state
# here instead of silently landing in a checkout.
cd "$WORK"
env -i HOME="$WORK/home" PATH="$PATH" \
    ATTN_HOME="$WORK/libexec" \
    XDG_CONFIG_HOME="$WORK/config" \
    XDG_STATE_HOME="$WORK/state" \
    ATTN_PORT="$PORT" \
    bun "$WORK/libexec/cli.js" serve >"$WORK/serve.log" 2>&1 &
SERVER_PID=$!

echo "==> Waiting for $BASE_URL"
up=""
for _ in $(seq 1 30); do
    if curl -s -o /dev/null -m 2 "$BASE_URL/"; then
        up=1
        break
    fi
    sleep 1
done
if [[ -z "$up" ]]; then
    echo "ERROR: server never responded; serve.log:" >&2
    cat "$WORK/serve.log" >&2
    exit 1
fi

check() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$actual" != "$expected" ]]; then
        echo "FAIL: $desc — expected $expected, got $actual" >&2
        exit 1
    fi
    echo "ok: $desc ($actual)"
}

check "loopback page" 200 "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE_URL/")"

asset="$(curl -s -m 5 "$BASE_URL/" | grep -o '_app/immutable/[^"]*\.js' | head -1)"
[[ -n "$asset" ]] || { echo "FAIL: no hashed asset reference found in the page" >&2; exit 1; }
check "hashed asset $asset" 200 "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE_URL/$asset")"

check "foreign Host rejected" 403 \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Host: evil.example" "$BASE_URL/")"

# State is persisted once the first refresh settles (with or without gh auth),
# so trigger it and give it a moment.
curl -s -o /dev/null -m 30 "$BASE_URL/api/items" || true
state_written=""
for _ in $(seq 1 20); do
    if [[ -f "$WORK/state/attn/snapshot.json" || -f "$WORK/state/attn/state.json" ]]; then
        state_written=1
        break
    fi
    sleep 1
done
[[ -n "$state_written" ]] || { echo "FAIL: no state files under XDG_STATE_HOME" >&2; exit 1; }
echo "ok: state written under XDG state dir"

[[ ! -e "$WORK/.local-state" ]] || { echo "FAIL: cwd-relative .local-state was created" >&2; exit 1; }
echo "ok: nothing written relative to cwd"

echo "PASS: artifact smoke"
