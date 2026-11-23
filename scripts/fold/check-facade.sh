#!/bin/sh
set -eu

COUNCIL_HOME=${COUNCIL_HOME:-"$HOME/.council-tool"}
COUNCIL_HTTP_PORT=${COUNCIL_HTTP_PORT:-8790}
COUNCIL_PIDFILE=${COUNCIL_PIDFILE:-"$COUNCIL_HOME/facade.pid"}
STATEFILE=${STATEFILE:-"$COUNCIL_HOME/facade-watch.state"}
LOCKFILE=${LOCKFILE:-"$COUNCIL_PIDFILE.lock"}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$COUNCIL_HOME"
export COUNCIL_HOME COUNCIL_HTTP_PORT COUNCIL_PIDFILE

if command -v flock >/dev/null 2>&1; then
    exec 9>> "$LOCKFILE"
    flock -n 9 || exit 0
fi

utc_now() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

read_live_pid() {
    pid=
    [ -f "$COUNCIL_PIDFILE" ] || return 1
    pid=$(cat "$COUNCIL_PIDFILE") || return 1
    case $pid in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null
}

healthy() {
    read_live_pid &&
        curl --max-time 3 -fsS "http://127.0.0.1:$COUNCIL_HTTP_PORT/health" >/dev/null 2>&1
}

restarts=0
last_restart=
if [ -f "$STATEFILE" ]; then
    while IFS='=' read -r key value; do
        case $key in
            restarts)
                case $value in
                    ''|0?*|*[!0-9]*) ;;
                    *) restarts=$value ;;
                esac
                ;;
            last_restart) last_restart=$value ;;
        esac
    done < "$STATEFILE"
fi

last_check=$(utc_now)
status=0
if ! healthy; then
    sleep 3
    if ! healthy; then
        if read_live_pid; then
            kill "$pid" 2>/dev/null || :
            waited=0
            while kill -0 "$pid" 2>/dev/null; do
                if [ "$waited" -eq 10 ]; then
                    status=1
                    break
                fi
                sleep 1
                waited=$((waited + 1))
            done
            if [ "$status" -eq 0 ]; then
                rm -f "$COUNCIL_PIDFILE"
            fi
        fi
        if [ "$status" -eq 0 ]; then
            # Release the lock descriptor in the launcher so the daemon cannot inherit it.
            "$SCRIPT_DIR/start-facade.sh" 9>&- || status=$?
            restarts=$((restarts + 1))
            last_restart=$(utc_now)
        fi
    fi
fi

printf 'last_check=%s\nrestarts=%s\nlast_restart=%s\n' \
    "$last_check" "$restarts" "$last_restart" > "$STATEFILE"
exit "$status"
