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

code_of() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$@"; }
json_ack=(-X POST -H 'Content-Type: application/json' -d '{"ids":[]}')

check "foreign Host rejected" 403 "$(code_of -H "Host: evil.example" "$BASE_URL/")"

# The token is created on start, owner-only, in an owner-only state dir.
AGENT_FILE="$WORK/state/attn/agent.json"
[[ -f "$AGENT_FILE" ]] || { echo "FAIL: no agent.json under XDG state dir" >&2; exit 1; }
check "agent.json mode" 600 "$(stat -f '%Lp' "$AGENT_FILE")"
check "state dir mode" 700 "$(stat -f '%Lp' "$WORK/state/attn")"
TOKEN="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).token)' "$AGENT_FILE")"
AUTH=(-H "Authorization: Bearer $TOKEN")

# Without a credential: the locked page, and nothing else. Browser headers are
# trivial to fake, so they must not stand in for the token.
check "unauthenticated page is locked" 401 "$(code_of "$BASE_URL/")"
curl -s -m 5 "$BASE_URL/" | grep -q "attn is locked" || { echo "FAIL: locked page text missing" >&2; exit 1; }
check "unauthenticated items rejected" 401 "$(code_of "$BASE_URL/api/items")"
check "unauthenticated events rejected" 401 "$(code_of "$BASE_URL/events")"
check "tokenless POST rejected" 401 "$(code_of "${json_ack[@]}" "$BASE_URL/api/ack")"
check "spoofed Sec-Fetch-Site rejected" 401 "$(code_of "${json_ack[@]}" -H 'Sec-Fetch-Site: none' "$BASE_URL/api/ack")"
check "spoofed Origin rejected" 401 "$(code_of "${json_ack[@]}" -H "Origin: $BASE_URL" "$BASE_URL/api/ack")"
check "wrong token rejected" 401 "$(code_of "${json_ack[@]}" -H 'Authorization: Bearer wrong' "$BASE_URL/api/ack")"

# With the token.
check "token page" 200 "$(code_of "${AUTH[@]}" "$BASE_URL/")"
asset="$(curl -s -m 5 "${AUTH[@]}" "$BASE_URL/" | grep -o '_app/immutable/[^"]*\.js' | head -1)"
[[ -n "$asset" ]] || { echo "FAIL: no hashed asset reference found in the page" >&2; exit 1; }
check "hashed asset $asset (public)" 200 "$(code_of "$BASE_URL/$asset")"
check "token POST accepted" 200 "$(code_of "${json_ack[@]}" "${AUTH[@]}" "$BASE_URL/api/ack")"

# State is persisted once the first refresh settles (with or without gh auth),
# so trigger it and give it a moment.
curl -s -o /dev/null -m 30 "${AUTH[@]}" "$BASE_URL/api/items" || true
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
for file in "$WORK"/state/attn/*.json; do
    check "$(basename "$file") mode" 600 "$(stat -f '%Lp' "$file")"
done

# Browser sign-in: `attn open --print` gets a one-time code; the locked page
# trades it for the session cookie, which then reads data. A code works once.
SIGN_IN_URL="$(env -i HOME="$WORK/home" PATH="$PATH" ATTN_HOME="$WORK/libexec" \
    XDG_CONFIG_HOME="$WORK/config" XDG_STATE_HOME="$WORK/state" ATTN_PORT="$PORT" \
    bun "$WORK/libexec/cli.js" open --print 2>/dev/null)"
CODE="${SIGN_IN_URL##*#code=}"
[[ "$SIGN_IN_URL" == "$BASE_URL/#code="* && -n "$CODE" ]] || { echo "FAIL: open --print gave '$SIGN_IN_URL'" >&2; exit 1; }
echo "ok: open --print printed a one-time link"
JAR="$WORK/cookies.txt"
session() { code_of -X POST -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' -d "{\"code\":\"$2\"}" "$1" "$BASE_URL/api/session"; }
check "code exchanged for cookie" 200 "$(session "-c$JAR" "$CODE")"
check "code reuse rejected" 401 "$(session "-s" "$CODE")"
grep -q attn_session "$JAR" || { echo "FAIL: no session cookie set" >&2; exit 1; }
check "cookie reads items" 200 "$(code_of -b "$JAR" "$BASE_URL/api/items")"
check "cookie page" 200 "$(code_of -b "$JAR" "$BASE_URL/")"

[[ ! -e "$WORK/.local-state" ]] || { echo "FAIL: cwd-relative .local-state was created" >&2; exit 1; }
echo "ok: nothing written relative to cwd"

echo "PASS: artifact smoke"
