#!/bin/sh
set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$APP_DIR"

if [ "${COUNCIL_HOME+x}" != x ]; then
    if [ -d "$HOME/council-spike-home" ]; then
        COUNCIL_HOME=$HOME/council-spike-home
    else
        COUNCIL_HOME=$HOME/.council-tool
    fi
fi
if ! mkdir -p "$COUNCIL_HOME"; then
    printf 'Cannot create COUNCIL_HOME directory: %s\n' "$COUNCIL_HOME" >&2
    exit 1
fi
export COUNCIL_HOME

if [ -z "${COUNCIL_HTTP_TOKEN:-}" ] && [ -f "$COUNCIL_HOME/.http-token" ]; then
    if loaded_token=$(cat "$COUNCIL_HOME/.http-token" 2>/dev/null); then
        COUNCIL_HTTP_TOKEN=$loaded_token
    fi
fi
if [ -z "${COUNCIL_HTTP_TOKEN:-}" ]; then
    printf 'COUNCIL_HTTP_TOKEN is empty or unset and no token was loaded from %s\n' \
        "$COUNCIL_HOME/.http-token" >&2
    exit 1
fi

COUNCIL_PRINCIPAL=${COUNCIL_PRINCIPAL:-host:operator}
COUNCIL_HUMAN_PRINCIPALS=${COUNCIL_HUMAN_PRINCIPALS:-host:operator}
export COUNCIL_HTTP_TOKEN COUNCIL_PRINCIPAL COUNCIL_HUMAN_PRINCIPALS

WATCH_INTERVAL=${WATCH_INTERVAL:-300}
if case "$WATCH_INTERVAL" in
    *[!0-9]*) true ;;
    *[1-9]*) false ;;
    *) true ;;
esac; then
    printf 'Invalid WATCH_INTERVAL "%s"; resetting to 300\n' "$WATCH_INTERVAL" >&2
    WATCH_INTERVAL=300
fi

NODE=
NPM_CLI=
if command -v node >/dev/null 2>&1; then
    NODE=node
    if ! command -v npm >/dev/null 2>&1; then
        NPM_CLI="$(dirname "$(command -v node)")/../lib/node_modules/npm/bin/npm-cli.js"
    fi
else
    for dir in "$(dirname "$HOME")/termux-libs" /data/user/0/dev.shelly.terminal/files/termux-libs; do
        if [ -x "$dir/node" ]; then
            NODE="$dir/node"
            NPM_CLI="$dir/node_modules/npm/bin/npm-cli.js"
            # The start script invokes node by name, including on watchdog restarts.
            PATH="$dir${PATH:+:$PATH}"
            export PATH
            break
        fi
    done
fi

if [ -z "$NODE" ]; then
    printf '%s\n' 'Could not find node on PATH or in Shelly termux-libs' >&2
    exit 1
fi
if [ -n "$NPM_CLI" ] && [ ! -f "$NPM_CLI" ]; then
    printf 'Could not find npm CLI at %s\n' "$NPM_CLI" >&2
    exit 1
fi

printf '%s\n' '==> Installing dependencies'
if [ -n "$NPM_CLI" ]; then
    "$NODE" "$NPM_CLI" install --ignore-scripts
else
    npm install --ignore-scripts
fi

printf '%s\n' '==> Building facade'
"$NODE" node_modules/typescript/bin/tsc -p tsconfig.json

printf '%s\n' '==> Starting facade'
sh scripts/fold/start-facade.sh || {
    printf '%s\n' 'Facade start did not complete. The watchdog loop will keep attempting restarts.' >&2
}

printf '%s\n' '==> Starting watchdog loop'
while true; do
    sh scripts/fold/check-facade.sh || true
    sleep "$WATCH_INTERVAL" || true
done
