# fleet-web

HTTP API + mobile-first PWA for supervising and steering Claude Code sessions across your
hosts. Node ≥ 22, zero npm dependencies, no build step, no auth (keep it on a private network
such as a Tailscale tailnet). Design, config mapping and the full API: [ARCHITECTURE.md](./ARCHITECTURE.md).

Each host runs the same `server.mjs`. It lists its own sessions with `fleet list --json` and,
when asked for the whole fleet, merges in the other hosts' servers over HTTP — any host's URL
shows everything.

## Run

```sh
fleet web serve            # via the CLI (uses your fleet config)
bin/dev.sh                 # foreground, 127.0.0.1:7799
bin/dev.sh 7800            # another port
node server.mjs            # plain: config port/bind (default 7777)
```

Open `http://<host>:<port>/` on your phone and "Add to Home Screen". Health: `/api/health`.

## Config

Reads the shared fleet config (`$FLEET_CONFIG` or `~/.config/fleet/config.json`, written by
`fleet init`). Relevant keys: `self`, `hosts.<name>.web` (peers), `web.port`, `web.bind`,
`web.ui`, `web.quickReplies`, `tmux`, `fleetBin`, `spawnDirs` (spawn only accepts dirs inside these). Example:
[`config.example.json`](./config.example.json). Without a config it runs as a single local host
on 127.0.0.1.

Env overrides: `FLEET_CONFIG`, `FLEET_WEB_PORT` / `PORT`, `FLEET_WEB_BIND`, `FLEET_WEB_UI`,
`FLEET_BIN`, `FLEET_TMUX`.

## Another UI

The API is independent of `public/`. Point `web.ui` (or `FLEET_WEB_UI`) at a directory with
your own `index.html` and it is served instead, same origin as `/api/*`.

## Service / deploy

`fleet install --host <name>` copies the web app to a remote host and
`fleet web install-service` sets it up as a service (launchd, logs to
`~/Library/Logs/fleet.web.log`, node pinned via `web.node` or a stable Homebrew install); see the CLI docs. Prefer running it from
tmux or a user service with a normal PATH (see ARCHITECTURE.md → "Running as a service").

## Tests

```sh
node --test tests/         # fast, no network beyond 127.0.0.1, child processes faked
```
