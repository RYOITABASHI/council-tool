#!/bin/sh
set -eu

COUNCIL_HOME=${COUNCIL_HOME:-"$HOME/.council-tool"}
COUNCIL_HTTP_PORT=${COUNCIL_HTTP_PORT:-8790}
COUNCIL_PIDFILE=${COUNCIL_PIDFILE:-"$COUNCIL_HOME/facade.pid"}
COUNCIL_TERMUX_LIBS=${COUNCIL_TERMUX_LIBS:-/data/user/0/dev.shelly.terminal/files/termux-libs}

if [ -z "${COUNCIL_HTTP_TOKEN:-}" ]; then
    printf '%s\n' 'COUNCIL_HTTP_TOKEN must be set' >&2
    exit 1
fi

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$COUNCIL_HOME"
export COUNCIL_HOME COUNCIL_HTTP_PORT COUNCIL_PIDFILE

if [ -f "$COUNCIL_PIDFILE" ]; then
    pid=$(cat "$COUNCIL_PIDFILE")
    case $pid in
        ''|*[!0-9]*) ;;
        *)
            if [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null; then
                printf 'Facade already running (pid %s)\n' "$pid"
                exit 0
            fi
            ;;
    esac
fi

if curl --max-time 2 -fsS "http://127.0.0.1:$COUNCIL_HTTP_PORT/health" >/dev/null 2>&1; then
    printf 'Port %s is already served by another process; not starting\n' "$COUNCIL_HTTP_PORT" >&2
    exit 1
fi

if [ -d "$COUNCIL_TERMUX_LIBS" ]; then
    LD_LIBRARY_PATH=$COUNCIL_TERMUX_LIBS${LD_LIBRARY_PATH:+":$LD_LIBRARY_PATH"}
    export LD_LIBRARY_PATH
fi

# Fold profile default: on Shelly the Codex CLI is exposed as `codex_exec`
# (it already includes the `exec` subcommand, so the preset's leading
# `exec` argument must be dropped). Default to it when the operator has
# not configured a command, so watchdog restarts carry the same profile
# as an interactive start. An explicit COUNCIL_CODEX_COMMAND always wins.
if [ -z "${COUNCIL_CODEX_COMMAND:-}" ] && command -v codex_exec >/dev/null 2>&1; then
    COUNCIL_CODEX_COMMAND=codex_exec
    if [ -z "${COUNCIL_CODEX_ARGS+set}" ]; then
        # Legacy-client pin: codex_exec 0.142.x is served only the
        # codex-auto-review model by the ChatGPT-account catalog, and its
        # built-in default model is rejected (model_not_found). Pin the
        # one served model for that client only; remove this case once
        # the bundled Codex is updated to a served-default build.
        if codex_version=$(codex_exec --version 2>/dev/null); then
            case "$codex_version" in
                *0.142.*) COUNCIL_CODEX_ARGS="--skip-git-repo-check -m codex-auto-review -" ;;
                *) COUNCIL_CODEX_ARGS="--skip-git-repo-check -" ;;
            esac
        else
            COUNCIL_CODEX_ARGS="--skip-git-repo-check -"
        fi
    fi
    export COUNCIL_CODEX_COMMAND COUNCIL_CODEX_ARGS
fi

logfile=$COUNCIL_HOME/facade.log
# Keep relative operator paths anchored to the launcher's working directory.
COUNCIL_HOME=$(CDPATH= cd -- "$COUNCIL_HOME" && pwd)
(
    cd "$APP_DIR"
    exec nohup node dist/http/server.js
) </dev/null >> "$logfile" 2>&1 &
pid=$!
if ! printf '%s\n' "$pid" > "$COUNCIL_PIDFILE"; then
    kill "$pid" 2>/dev/null || :
    exit 1
fi

deadline=$(( $(date +%s) + 30 ))
while [ "$(date +%s)" -le $((deadline - 2)) ]; do
    sleep 1 &
    interval=$!
    if curl --max-time 1 -fsS "http://127.0.0.1:$COUNCIL_HTTP_PORT/health" >/dev/null 2>&1 &&
        kill -0 "$pid" 2>/dev/null &&
        [ "$(date +%s)" -le $((deadline - 4)) ]; then
        sleep 2
        if kill -0 "$pid" 2>/dev/null &&
            curl --max-time 1 -fsS "http://127.0.0.1:$COUNCIL_HTTP_PORT/health" >/dev/null 2>&1; then
            printf 'Facade started (pid %s)\nOK\n' "$pid"
            exit 0
        fi
    fi
    wait "$interval"
done

kill "$pid" 2>/dev/null || :
rm -f "$COUNCIL_PIDFILE"
printf '%s\n' 'Facade did not become healthy within 30 seconds' >&2
tail -n 20 "$logfile" >&2
exit 1
