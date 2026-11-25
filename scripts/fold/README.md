# Fold facade hosting

## One-command launcher

```sh
sh scripts/fold/run-facade.sh
```

The launcher uses `COUNCIL_HOME` if set, otherwise it prefers
`~/council-spike-home` when present and falls back to `~/.council-tool`.
It loads the token from `$COUNCIL_HOME/.http-token` when `COUNCIL_HTTP_TOKEN`
is unset or empty and defaults both principal settings to `host:operator`.
It finds Node on `PATH` or in Shelly's `termux-libs`, installs dependencies,
builds and starts the facade, then stays in the watchdog loop. It waits
`WATCH_INTERVAL` seconds between checks (default `300`).

## Manual launch and watchdog

Run `npm run build` from the repository root before launching. Export the same
profile in the launcher and watchdog environments.

```sh
export COUNCIL_HOME="$HOME/.council-tool"
export COUNCIL_HTTP_PORT=8790
export COUNCIL_HTTP_TOKEN='replace-with-your-token'
export COUNCIL_PRINCIPAL='host:operator'
export COUNCIL_HUMAN_PRINCIPALS='host:operator'
export COUNCIL_CODEX_COMMAND=codex_exec
export COUNCIL_CODEX_ARGS='--skip-git-repo-check -'
```

On Fold, `codex_exec` already runs `codex exec`, so drop the leading `exec`
argument. Make sure `codex_exec` is on the Shelly profile's `PATH`.
`start-facade.sh` applies this Codex profile automatically when
`COUNCIL_CODEX_COMMAND` is unset or empty and `codex_exec` is on `PATH`, so
watchdog restarts use the same profile without the exports above; an
explicit `COUNCIL_CODEX_COMMAND` always wins, and a `COUNCIL_CODEX_ARGS`
the operator set (even empty) is preserved — the default args apply only
when it is unset.

Legacy-client pin: when the default args are applied and
`codex_exec --version` reports a 0.142.x build, the args also pin
`-m codex-auto-review`. The ChatGPT-account model catalog no longer
serves any general model to that client generation — its built-in
default is rejected with `model_not_found`, and `codex-auto-review` is
the one model it is still served (verified on-device 2026-11-24). This
is a stopgap for the bundled client only: remove the pin once Shelly's
bundled Codex is updated to a build whose default model is served.

Use `sh scripts/fold/start-facade.sh` to launch or restart a stopped facade. It
records the PID in `$COUNCIL_HOME/facade.pid` and waits up to 30 seconds for
`/health`. A live PID already in the pidfile is reported as already running.
A startup timeout stops the child, removes the pidfile, and prints the last 20
lines of `$COUNCIL_HOME/facade.log`.

Run `sh scripts/fold/check-facade.sh` periodically, for example with a Shelly
scheduled agent. It checks the pidfile and `/health`, waits three seconds before
retrying an unhealthy check, then restarts a facade that is still unhealthy.
The default state file, `$COUNCIL_HOME/facade-watch.state`, records `last_check`
in UTC, the number of restart attempts in `restarts`, and the UTC time of the
last attempt in `last_restart` (empty until the first attempt).

## First-run pairing

`start-facade.sh` (and therefore `run-facade.sh` and watchdog restarts)
exports `COUNCIL_PAIRING_ARM=1` unless it is already set. The facade then
arms a one-shot `POST /pairing/claim` endpoint, but only when
`$COUNCIL_HOME/pairing-claimed/` holds no record for the current token. While
armed, the first claim made over loopback (loopback peer, loopback `Host`, no
browser `Origin`/`Sec-Fetch-Site`) receives `{"baseUrl": ..., "token": ...}`;
the claim is recorded, and later requests that pass the claim guards get
`404`, including after restarts and from a second facade on the same home.
Requests that fail the guards are handled like unknown paths (`401` without
valid Bearer credentials, `404` with valid credentials). A new token re-arms on
the next start. Each record is one file named by a one-way token fingerprint.
The claim record contains only the claimed flag and fingerprint. The facade
never automatically hands out the same token twice.

To recover pairing after reinstalling the app, the device owner resets the
pairing state by deleting the record for the current token from
`$COUNCIL_HOME/pairing-claimed/`. Then restart the facade and open the app.
If the filesystem cannot sync directories, use manual setup. Set
`COUNCIL_PAIRING_ARM=0` to opt out. On hosts without the app the arm is simply
never used.

When the Shelly `termux-libs` directory exists, the launcher prepends it to
`LD_LIBRARY_PATH` so the Android linker can find `libz.so.1` during detached
launches. Set `COUNCIL_TERMUX_LIBS` if the directory is installed elsewhere.

**TO BE VERIFIED on device.** The facade must respond to `/health` for 24 hours,
including with the screen off and Shelly in the background. Device residency
verification is pending.
