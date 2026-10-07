#!/usr/bin/env bash
#
# Boot the packaged artifact from a clean directory (no repo checkout, no
# node_modules) and prove the invariants a release must never break:
#
#   1. the server answers only over TLS at https://attn.localhost:<port>,
#      with its own owner-only certificate, and rejects a foreign Host
#   2. data needs a session token sent as a bearer header (never a cookie),
#      which ends on `attn signout` and on any restart
#   3. agents reach the server over the owner-only Unix socket
#   4. the server holds its port on [::1] too, and refuses to run when
#      another program holds it
#   5. state lands in the XDG state dir, owner-only, not the cwd
#
# Run by the release workflow after scripts/package-artifact.sh; usable locally
# the same way. It never touches the keychain: curl trusts attn's certificate
# through --cacert instead.
#
# Usage: scripts/smoke-artifact.sh <tarball> [port]
#
set -euo pipefail

TARBALL="${1:?usage: smoke-artifact.sh <tarball> [port]}"
PORT="${2:-8791}"
DASHBOARD="https://attn.localhost:$PORT"

command -v bun >/dev/null || { echo "ERROR: bun not found on PATH" >&2; exit 1; }

WORK="$(mktemp -d)"
SERVER_PID=""
SQUATTER_PID=""
cleanup() {
    if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
    if [[ -n "$SQUATTER_PID" ]]; then kill "$SQUATTER_PID" 2>/dev/null || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT

tar -xzf "$TARBALL" -C "$WORK"
mkdir -p "$WORK/home" "$WORK/config" "$WORK/state"
STATE_DIR="$WORK/state/attn"
SOCKET="$STATE_DIR/attn.sock"
CA="$WORK/attn-cert.pem"

# env -i so nothing from the invoking shell (a real .env, ATTN_* vars)
# leaks in; only the artifact and the XDG dirs define behavior. cwd is the
# work dir so a cwd-relative path regression shows up as a stray .local-state
# here instead of silently landing in a checkout.
cd "$WORK"
# An array, not a function, so `"${ATTN[@]}" serve &` gives the server's own
# PID (env execs bun) and SIGTERM reaches the server.
ATTN=(env -i HOME="$WORK/home" PATH="$PATH"
    ATTN_HOME="$WORK/libexec"
    XDG_CONFIG_HOME="$WORK/config"
    XDG_STATE_HOME="$WORK/state"
    ATTN_PORT="$PORT"
    bun "$WORK/libexec/cli.js")

start_server() {
    "${ATTN[@]}" serve >>"$WORK/serve.log" 2>&1 &
    SERVER_PID=$!
    echo "==> Waiting for $DASHBOARD"
    for _ in $(seq 1 30); do
        if [[ -S "$SOCKET" && -f "$STATE_DIR/tls.pem" ]]; then
            awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' "$STATE_DIR/tls.pem" >"$CA"
            if curl -s -o /dev/null -m 2 --cacert "$CA" "$DASHBOARD/"; then return 0; fi
        fi
        sleep 1
    done
    echo "ERROR: server never responded; serve.log:" >&2
    cat "$WORK/serve.log" >&2
    exit 1
}

stop_server() {
    kill -TERM "$SERVER_PID"
    for _ in $(seq 1 20); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            SERVER_PID=""
            return 0
        fi
        sleep 0.5
    done
    echo "FAIL: server still running 10s after SIGTERM" >&2
    exit 1
}

check() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$actual" != "$expected" ]]; then
        echo "FAIL: $desc: expected $expected, got $actual" >&2
        exit 1
    fi
    echo "ok: $desc ($actual)"
}

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

code_of() { curl -s -o /dev/null -w '%{http_code}' -m 5 --cacert "$CA" "$@"; }
json_ack=(-X POST -H 'Content-Type: application/json' -d '{"ids":[]}')
LOOPBACK_HOST=(-H "Host: 127.0.0.1:$PORT")

# `attn open` needs a trusted certificate, which the smoke run must not
# install, so mint links over the agent socket the way `attn open` does.
# Prints the one-time code.
sign_in_code() {
    local url
    url="$(curl -s -m 5 --unix-socket "$SOCKET" -X POST http://attn/sign-in | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).url)')"
    [[ "$url" =~ ^https://attn\.localhost:$PORT/#code=([A-Za-z0-9_-]+)$ ]] || fail "sign-in link was '$url'"
    echo "${BASH_REMATCH[1]}"
}

# Trades a code for a session token the way the page does. Prints the HTTP
# status, and writes the token to $WORK/token on success.
session() {
    local code="$1"
    shift
    local body status
    body="$(curl -s -m 5 --cacert "$CA" -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' \
        -H 'Sec-Fetch-Site: same-origin' -d "{\"code\":\"$code\"}" "$@" "$DASHBOARD/api/session")"
    status="${body##*$'\n'}"
    if [[ "$status" == 200 ]]; then
        bun -e 'console.log(JSON.parse(process.argv[1]).token)' "${body%$'\n'*}" >"$WORK/token"
    fi
    echo "$status"
}
token_header() { echo "Authorization: Bearer $(cat "$WORK/token")"; }

# Credentials from earlier attn versions are deleted on start.
mkdir -p "$STATE_DIR"
echo '{"token":"old"}' >"$STATE_DIR/agent.json"
echo '{"sessions":{}}' >"$STATE_DIR/sessions.json"

start_server

[[ ! -e "$STATE_DIR/agent.json" && ! -e "$STATE_DIR/sessions.json" ]] || fail "old credential files survived a start"
echo "ok: old credential files removed on start"

# TLS with attn's own certificate, and nothing else.
check "tls.pem mode" 600 "$(stat -f '%Lp' "$STATE_DIR/tls.pem")"
check "state dir mode" 700 "$(stat -f '%Lp' "$STATE_DIR")"
check "agent socket mode" 600 "$(stat -f '%Lp' "$SOCKET")"
check "a client that does not trust attn's certificate stops at TLS" 000 \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$DASHBOARD/" || true)"
check "plain http gets nothing" 000 \
    "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/" || true)"
curl -s -m 5 -D - -o /dev/null --cacert "$CA" "$DASHBOARD/" | grep -qi '^strict-transport-security: max-age=' \
    || fail "no HSTS header"
echo "ok: HSTS header sent"
check "foreign Host rejected" 403 "$(code_of -H "Host: evil.example" "$DASHBOARD/")"

# Other loopback names only ever show the locked page.
check "Host 127.0.0.1 is locked" 401 "$(code_of "${LOOPBACK_HOST[@]}" "$DASHBOARD/")"
curl -s -m 5 --cacert "$CA" "${LOOPBACK_HOST[@]}" "$DASHBOARD/" | grep -q "attn is locked" || fail "locked page text missing"
check "[::1] is held by attn" 401 "$(code_of --resolve "attn.localhost:$PORT:[::1]" "$DASHBOARD/api/items")"
squat_v6="$(bun -e "require('node:net').createServer().once('error', (e) => { console.log(e.code); process.exit(0) }).listen({ host: '::1', port: $PORT, ipv6Only: true }, () => { console.log('bound'); process.exit(0) })")"
check "another program cannot bind [::1] on the port" EADDRINUSE "$squat_v6"

# Agents use the socket.
check "agent socket serves items" 200 "$(code_of --unix-socket "$SOCKET" http://attn/items)"
open_output="$("${ATTN[@]}" open --print 2>&1 || true)"
[[ "$open_output" == *"attn setup https"* ]] || fail "attn open did not refuse an untrusted certificate: $open_output"
echo "ok: attn open refuses until the certificate is trusted"

# Without a session: an empty page shell, and nothing else. Browser headers
# are trivial to fake, so they must not stand in for a session.
check "page shell is public" 200 "$(code_of "$DASHBOARD/")"
curl -s -m 5 --cacert "$CA" "$DASHBOARD/" | grep -q "acme\|\"items\":\[{" && fail "the page shell carries data"
curl -s -m 5 --cacert "$CA" -D - -o /dev/null "$DASHBOARD/" | grep -qi '^content-security-policy:.*script-src' \
    || fail "no Content-Security-Policy on the page"
echo "ok: page shell carries no data and sends a CSP"
check "unauthenticated page data rejected" 401 "$(code_of "$DASHBOARD/__data.json")"
check "unauthenticated items rejected" 401 "$(code_of "$DASHBOARD/api/items")"
check "unauthenticated events rejected" 401 "$(code_of "$DASHBOARD/events")"
check "spoofed Sec-Fetch-Site rejected" 401 "$(code_of "${json_ack[@]}" -H 'Sec-Fetch-Site: same-origin' "$DASHBOARD/api/ack")"
check "spoofed Origin rejected" 401 "$(code_of "${json_ack[@]}" -H "Origin: $DASHBOARD" "$DASHBOARD/api/ack")"

# A code redeems only on attn.localhost, and only once, for a token and no cookie.
CODE="$(sign_in_code)"
check "code rejected for Host 127.0.0.1" 401 "$(session "$CODE" "${LOOPBACK_HOST[@]}")"
CODE="$(sign_in_code)"
check "code exchanged for a token" 200 "$(session "$CODE" -D "$WORK/session-headers")"
check "no cookie is set" 0 "$(grep -ci '^set-cookie' "$WORK/session-headers" || true)"
check "code reuse rejected" 401 "$(session "$CODE")"
check "token reads items" 200 "$(code_of -H "$(token_header)" "$DASHBOARD/api/items")"
asset="$(curl -s -m 5 --cacert "$CA" "$DASHBOARD/" | grep -o '_app/immutable/[^"]*\.js' | head -1)"
[[ -n "$asset" ]] || fail "no hashed asset reference found in the page"
check "hashed asset $asset (public)" 200 "$(code_of "$DASHBOARD/$asset")"
check "token with Host 127.0.0.1 rejected" 401 "$(code_of -H "$(token_header)" "${LOOPBACK_HOST[@]}" "$DASHBOARD/api/items")"
check "token POST without browser headers rejected" 403 "$(code_of "${json_ack[@]}" -H "$(token_header)" "$DASHBOARD/api/ack")"
check "token same-origin POST accepted" 200 \
    "$(code_of "${json_ack[@]}" -H "$(token_header)" -H 'Sec-Fetch-Site: same-origin' "$DASHBOARD/api/ack")"

# State is persisted once the first refresh settles (with or without gh auth).
state_written=""
for _ in $(seq 1 20); do
    if [[ -f "$STATE_DIR/snapshot.json" || -f "$STATE_DIR/state.json" ]]; then
        state_written=1
        break
    fi
    sleep 1
done
[[ -n "$state_written" ]] || fail "no state files under XDG_STATE_HOME"
echo "ok: state written under XDG state dir"
for file in "$STATE_DIR"/*.json "$STATE_DIR/tls.pem"; do
    check "$(basename "$file") mode" 600 "$(stat -f '%Lp' "$file")"
done
[[ ! -e "$STATE_DIR/sessions.json" ]] || fail "sessions were written to disk"
echo "ok: no session file on disk"

# `attn signout` ends the session and closes its open event stream.
curl -s -N -m 30 --cacert "$CA" -H "$(token_header)" "$DASHBOARD/events" >/dev/null &
SIGNOUT_STREAM_PID=$!
sleep 1
"${ATTN[@]}" signout >/dev/null
check "token rejected after signout" 401 "$(code_of -H "$(token_header)" "$DASHBOARD/api/items")"
stream_closed=""
for _ in $(seq 1 10); do
    if ! kill -0 "$SIGNOUT_STREAM_PID" 2>/dev/null; then
        stream_closed=1
        break
    fi
    sleep 0.5
done
[[ -n "$stream_closed" ]] || { kill "$SIGNOUT_STREAM_PID"; fail "an event stream kept running after signout"; }
echo "ok: signout closed the open event stream"

# A restart keeps the certificate and ends every session. SIGTERM ends open
# event streams, so the server exits promptly.
CODE="$(sign_in_code)"
check "signed in again" 200 "$(session "$CODE")"
fingerprint="$(shasum "$CA")"
curl -s -m 30 --cacert "$CA" -H "$(token_header)" "$DASHBOARD/events" >/dev/null &
STREAM_PID=$!
sleep 1
stop_server
kill "$STREAM_PID" 2>/dev/null || true
echo "ok: server exited after SIGTERM with an open event stream"
[[ ! -e "$SOCKET" ]] || fail "agent socket left behind after SIGTERM"
echo "ok: agent socket removed on shutdown"
start_server
[[ "$(shasum "$CA")" == "$fingerprint" ]] || fail "the certificate changed across a restart"
echo "ok: certificate kept across a restart"
check "a restart ends the session" 401 "$(code_of -H "$(token_header)" "$DASHBOARD/api/items")"
stop_server

# A program that holds the port, on either loopback address, while attn is
# stopped keeps attn from running at all, and no agent socket appears.
for address in 127.0.0.1 ::1; do
    bun -e "require('node:net').createServer().listen({ host: '$address', port: $PORT, ipv6Only: true })" &
    SQUATTER_PID=$!
    sleep 1
    "${ATTN[@]}" serve >>"$WORK/serve.log" 2>&1 &
    SERVER_PID=$!
    exited=""
    for _ in $(seq 1 20); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            exited=1
            break
        fi
        sleep 0.5
    done
    [[ -n "$exited" ]] || fail "attn kept running while another program held $address:$PORT"
    SERVER_PID=""
    echo "ok: attn refuses to run when another program holds $address:$PORT"
    if curl -s -m 2 --unix-socket "$SOCKET" http://attn/items >/dev/null; then fail "the agent socket answered with attn down"; fi
    echo "ok: no agent socket while attn is down"
    kill "$SQUATTER_PID"
    wait "$SQUATTER_PID" 2>/dev/null || true
    SQUATTER_PID=""
done

[[ ! -e "$WORK/.local-state" ]] || fail "cwd-relative .local-state was created"
echo "ok: nothing written relative to cwd"

echo "PASS: artifact smoke"
