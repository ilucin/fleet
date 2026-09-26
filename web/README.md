# fleet-web

HTTP API + mobile-first PWA for supervising and steering Claude Code sessions across your
hosts. The server is Node ≥ 22 with zero npm dependencies and no build step; no auth (keep it on
a private network such as a Tailscale tailnet). Two UIs:

- `ui/` — the new React + shadcn/ui app (**built**: `npm --prefix ui ci && npm --prefix ui run build`,
  or `fleet web build`; output `ui/dist/`, gitignored). See [ui/README.md](./ui/README.md).
- `public/` — the classic vanilla-JS UI, no build. Served when `ui/dist` is not built, or with
  `web.ui: "classic"` / `FLEET_WEB_UI=classic`. Design, config mapping and the full API: [ARCHITECTURE.md](./ARCHITECTURE.md).

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
`web.ui` (a path, or `"classic"`), `web.quickReplies`, `web.autoName`, `web.grouping`, `grouping.host`, `tmux`, `fleetBin`, `spawnDirs` (spawn only accepts dirs inside these). Example:
[`config.example.json`](./config.example.json). Without a config it runs as a single local host
on 127.0.0.1.

Env overrides: `FLEET_CONFIG`, `FLEET_WEB_PORT` / `PORT`, `FLEET_WEB_BIND`, `FLEET_WEB_UI`,
`FLEET_WEB_AUTONAME` (`0` / `1`), `FLEET_BIN`, `FLEET_TMUX`.

`web.autoName` (default off; opt in with `{ "enabled": true, "intervalMinutes": 5 }`) makes each server run
`fleet name --all --apply` on its own host every few minutes, so sessions started without a
name get a task-shaped one (tmux session included, when its name was generic). Set
`"enabled": false` to keep names manual.

`web.grouping` (default off; opt in on ONE host with `{ "enabled": true, "intervalMinutes": 10 }`,
and point the others at it with top-level `"grouping": { "host": "<that host>" }`) makes that
server run `fleet group` over the whole fleet and serve `GET /api/groups` for the Board view; the
others proxy to it. It only reads sessions and calls `claude -p`; nothing is sent to a session.

## Another UI

The API is independent of both bundled UIs. Point `web.ui` (or `FLEET_WEB_UI`) at a directory
with your own `index.html` and it is served instead, same origin as `/api/*`. Files under
`/assets/` with a content hash in the name (`index-R-dVrV7d.js`) are sent `immutable`; everything
else is `no-cache` + ETag.

## Service / deploy

`fleet install --host <name>` copies the web app to a remote host (the server, `public/` and
only the *built* `ui/dist` — never `ui/` sources or `node_modules`; build first) and
`fleet web install-service` sets it up as a service (launchd, logs to
`~/Library/Logs/fleet.web.log`, node pinned via `web.node` or a stable Homebrew install); see the CLI docs. Prefer running it from
tmux or a user service with a normal PATH (see ARCHITECTURE.md → "Running as a service").

## Tests

```sh
node --test tests/         # fast, no network beyond 127.0.0.1, child processes faked
npm --prefix ui test       # UI helper tests (vitest); also: run lint, run typecheck, run build
```
