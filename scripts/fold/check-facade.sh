#!/bin/sh
set -eu

COUNCIL_HOME=${COUNCIL_HOME:-"$HOME/.council-tool"}
COUNCIL_HTTP_PORT=${COUNCIL_HTTP_PORT:-8790}
COUNCIL_PIDFILE=${COUNCIL_PIDFILE:-"$COUNCIL_HOME/facade.pid"}
STATEFILE=${STATEFILE:-"$COUNCIL_HOME/facade-watch.state"}
LOCKFILE=${LOCKFILE:-"$COUNCIL_PIDFILE.lock"}
LOCKDIR="$LOCKFILE.d"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$COUNCIL_HOME"
export COUNCIL_HOME COUNCIL_HTTP_PORT COUNCIL_PIDFILE

classify_token() {
    if [ ! -e "$LOCKDIR/token" ] && [ ! -L "$LOCKDIR/token" ]; then
        printf '%s\n' missing
        return
    fi
    if ! snap=$(cat "$LOCKDIR/token" 2>/dev/null && printf '.'); then
        printf '%s\n' invalid
        return
    fi
    raw=${snap%.}
    stripped=0
    case $raw in
        *'
') raw=${raw%?}; stripped=1 ;;
    esac
    if ! size=$(stat -Lc %s "$LOCKDIR/token" 2>/dev/null); then
        printf '%s\n' invalid
        return
    fi
    expected=$((${#raw} + stripped))
    if [ "$size" -ne "$expected" ]; then
        printf '%s\n' invalid
        return
    fi
    case $raw in
        ''|*[!0123456789-]*|-*|*-|*-*-*) printf '%s\n' invalid ;;
        *-*) printf '%s\n' "$raw" ;;
        *) printf '%s\n' invalid ;;
    esac
}

if [ -d "$LOCKDIR" ]; then
    first=$(classify_token) || first=invalid
    case $first in
        invalid) exit 0 ;;
        missing) ;;
        *) if kill -0 "${first%%-*}" 2>/dev/null; then exit 0; fi ;;
    esac
    first_inode=$(stat -c %i "$LOCKDIR" 2>/dev/null) || exit 0
    lock_mtime=$(stat -c %Y "$LOCKDIR" 2>/dev/null) &&
        now=$(date +%s 2>/dev/null) &&
        [ "$((now - lock_mtime))" -gt 120 ] || exit 0

    second=$(classify_token) || second=invalid
    [ "$second" = "$first" ] || exit 0
    if [ "$first" != missing ] && kill -0 "${first%%-*}" 2>/dev/null; then
        exit 0
    fi
    second_inode=$(stat -c %i "$LOCKDIR" 2>/dev/null) || exit 0
    [ "$second_inode" = "$first_inode" ] || exit 0
    lock_mtime=$(stat -c %Y "$LOCKDIR" 2>/dev/null) &&
        now=$(date +%s 2>/dev/null) &&
        [ "$((now - lock_mtime))" -gt 120 ] || exit 0
    rm -rf "$LOCKDIR" || exit 0
fi

mkdir "$LOCKDIR" 2>/dev/null || exit 0
if ! MYTOKEN="$$-$(date +%s)" || ! printf '%s\n' "$MYTOKEN" > "$LOCKDIR/token"; then
    rm -rf "$LOCKDIR" || exit 0
    exit 0
fi
trap 'if [ "$(classify_token)" = "$MYTOKEN" ]; then rm -rf "$LOCKDIR"; fi' EXIT

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
            "$SCRIPT_DIR/start-facade.sh" || status=$?
            restarts=$((restarts + 1))
            last_restart=$(utc_now)
        fi
    fi
fi

printf 'last_check=%s\nrestarts=%s\nlast_restart=%s\n' \
    "$last_check" "$restarts" "$last_restart" > "$STATEFILE"
exit "$status"
