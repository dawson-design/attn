#!/usr/bin/env bash
#
# Shared helpers for the notification-watch LaunchAgent scripts. Sourced, not
# executed. Everything machine- or deployment-specific is DERIVED here so the
# plists ship as host-agnostic templates rather than hardcoded files.
#
# shellcheck shell=bash

# Absolute path to this repo checkout (scripts/ is one level below the root).
gw_app_dir() {
    cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

# LaunchAgent label. Namespaced by the current user so it is unique per account
# yet stable across runs (idempotent install/uninstall). $1 is the suffix, e.g.
# "attn" or "attn-window".
gw_label() {
    echo "com.$(id -un).$1"
}

gw_domain() {
    echo "gui/$(id -u)"
}

# Locate an executable by name, honouring PATH first. Fails loudly if missing.
gw_require_bin() {
    local name="$1" path
    path="$(command -v "$name" 2>/dev/null || true)"
    if [[ -z "$path" || ! -x "$path" ]]; then
        echo "ERROR: required executable not found on PATH: $name" >&2
        return 1
    fi
    echo "$path"
}

# PATH for the launchd-spawned process: the dirs holding the tools we depend on
# (bun, gh) plus the standard system dirs. launchd inherits none of this.
gw_launchd_path() {
    local extra dirs="/usr/bin:/bin:/usr/sbin:/sbin"
    for extra in "$@"; do
        [[ -n "$extra" ]] && dirs="$(dirname "$extra"):$dirs"
    done
    echo "$dirs"
}

# Value of KEY from the repo-root .env, or empty if absent. These scripts and
# launchd read the process environment, but bun only loads .env at runtime —
# so without this, a value set solely in .env is invisible at install time and
# the DEFAULT gets baked into the plist, where it then overrides .env for the
# installed service. Commented lines are ignored; the last assignment wins.
gw_env_file_value() {
    local key="$1" file line
    file="$(gw_app_dir)/.env"
    [[ -f "$file" ]] || return 0
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" | tail -n 1 || true)"
    [[ -n "$line" ]] || return 0
    line="${line#*=}"
    # Trim surrounding whitespace and one layer of paired quotes.
    printf '%s' "$line" | sed \
        -e 's/^[[:space:]]*//' \
        -e 's/[[:space:]]*$//' \
        -e 's/^"\(.*\)"$/\1/' \
        -e "s/^'\(.*\)'\$/\1/"
}

gw_host() {
    local value="${ATTN_HOST:-$(gw_env_file_value ATTN_HOST)}"
    echo "${value:-github.com}"
}

gw_port() {
    local value="${ATTN_PORT:-$(gw_env_file_value ATTN_PORT)}"
    echo "${value:-8765}"
}

# Escape a value for safe substitution into an XML plist via sed: first
# XML-escape the markup metacharacters (so a value cannot inject plist elements
# such as a rogue ProgramArguments), then escape the characters sed treats
# specially in the replacement text (backslash, ampersand, and the | delimiter).
# Order matters: XML-escape, then backslashes, then & and | that we introduce.
gw_sed_replacement() {
    local value="$1"
    value="${value//&/&amp;}"
    value="${value//</&lt;}"
    value="${value//>/&gt;}"
    value="${value//\\/\\\\}"
    value="${value//&/\\&}"
    value="${value//|/\\|}"
    printf '%s' "$value"
}

# Render a plist template to a destination, substituting __PLACEHOLDER__ values.
# Usage: gw_render_template SRC DST LABEL APP_DIR BUN PATH HOST PORT
gw_render_template() {
    local src="$1" dst="$2" label app_dir bun launch_path host port
    label="$(gw_sed_replacement "$3")"
    app_dir="$(gw_sed_replacement "$4")"
    bun="$(gw_sed_replacement "$5")"
    launch_path="$(gw_sed_replacement "$6")"
    host="$(gw_sed_replacement "$7")"
    port="$(gw_sed_replacement "$8")"
    sed \
        -e "s|__LABEL__|${label}|g" \
        -e "s|__APP_DIR__|${app_dir}|g" \
        -e "s|__BUN__|${bun}|g" \
        -e "s|__PATH__|${launch_path}|g" \
        -e "s|__HOST__|${host}|g" \
        -e "s|__PORT__|${port}|g" \
        "$src" >"$dst"
}
