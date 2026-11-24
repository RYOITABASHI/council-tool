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

When the Shelly `termux-libs` directory exists, the launcher prepends it to
`LD_LIBRARY_PATH` so the Android linker can find `libz.so.1` during detached
launches. Set `COUNCIL_TERMUX_LIBS` if the directory is installed elsewhere.

**TO BE VERIFIED on device.** The facade must respond to `/health` for 24 hours,
including with the screen off and Shelly in the background. Device residency
verification is pending.
