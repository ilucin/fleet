# fleet-web — architecture

A zero-dependency Node server that exposes the fleet over a small JSON HTTP API, plus a
mobile-first PWA (`public/`) built on that API. Every host runs the same server; any one of
them shows the whole fleet by merging in its peers. No auth — meant for a private network
(e.g. a Tailscale tailnet). No build step.

The API is the stable part. `public/` is just one UI; another UI can be pointed at the same
API (or served by it via `web.ui`, see Config).

## Topology

```
phone ──http──▶ workstation:7777 (self=workstation) ──http──▶ laptop:7777 (?local=1)
           or ▶ laptop:7777      (self=laptop)      ──http──▶ workstation:7777 (?local=1)
```

- Each instance serves its **own** sessions under its `self` name and knows its **peers**
  (other hosts in the config that have a `web` URL).
- A request for host X is served locally when X == self, proxied when X is a peer, otherwise 404.
- Proxied requests carry `?local=1` and are never proxied again (no chains, no loops).

## Modules

```
server.mjs            wiring: config → deps → API → HTTP server → listen
lib/config.mjs        shared fleet config loader + binary resolution
lib/fleet-cli.mjs     the ONLY place that invokes the `fleet` CLI (`fleet list --json`)
lib/fleet.mjs         local discovery: cache (2s TTL), in-flight de-dup, never throws
lib/backends.mjs      peek/send/keys straight to tmux / iTerm2 (osascript)
lib/transcript.mjs    Claude Code transcript JSONL → chat messages
lib/spawn.mjs         new tmux session + `claude -n <name> '<prompt>'`, auto-accept folder trust
lib/peers.mjs         peer fetch + one-hop proxy
lib/api.mjs           /api/* request handling (no UI knowledge)
lib/app.mjs           node:http server: /api/* → api, everything else → static UI dir
lib/http.mjs, util.mjs, run.mjs   helpers (body limit, static path safety, execFile wrapper)
public/               the bundled PWA (vanilla JS, hash routing)
```

`createApi(deps)` and `createHttpServer({ handleApi, uiDir })` take all I/O as injected
dependencies, so tests (and alternative servers) can mount the API with fakes.

## Config

The server reads the **shared fleet config** written by `fleet init`:
`$FLEET_CONFIG`, else `${XDG_CONFIG_HOME:-~/.config}/fleet/config.json`. See
[`config.example.json`](./config.example.json). Unknown keys are ignored.

| config | server meaning |
| --- | --- |
| `self` | this host's name (default `local`) |
| `hosts.<name>.web` | peer base URL for every host ≠ self; hosts without `web` are not peers |
| `web.port` | listen port (default 7777) |
| `web.bind` | listen address (default `0.0.0.0` with a config, `127.0.0.1` without one) |
| `web.ui` | static UI directory (default `web/public`); `null` → bundled UI |
| `web.quickReplies` | composer chips: `["text", { "label", "text" }]` (default Continue/Yes/No/1/2) |
| `tmux` | tmux binary; `null` → PATH, `/opt/homebrew/bin`, `/usr/local/bin` |
| `fleetBin` | `fleet` binary; `null` → PATH, fallbacks, `~/.local/bin`, `~/.cargo/bin` |
| `claude` | launcher typed by spawn (default `claude`) |
| `spawnDirs[]` | `{ label, paths: { <host>: dir } }` → this host offers `{ label, path: paths[self] }`; `{ label, path }` means the same dir on every host; `~` expanded; none → `[{ label: "Home", path: $HOME }]` |

Env overrides: `FLEET_CONFIG`, `FLEET_WEB_PORT` (or `PORT`), `FLEET_WEB_BIND`, `FLEET_WEB_UI`,
`FLEET_BIN`, `FLEET_TMUX`.

Missing config → runs as a single host `local` on 127.0.0.1 and logs a hint to run
`fleet init`. A config that exists but is not valid JSON / has a bad shape → exits with code
2 and a message naming the file and the key.

The server prepends `/opt/homebrew/bin:~/.local/bin:/usr/local/bin` to `PATH` for children,
because service managers (launchd) do not provide the user's PATH.

## The CLI contract

Local discovery is `fleet list --json` (timeout 8s), an array of:

```
pid, session_id (uuid), name, cwd, status ("busy"|"idle"|"waiting"|"unknown"), updated_at (ms),
tty, backend ("iterm"|"tmux"|"unknown"), handle (iTerm session id | tmux pane id like "%87"),
tab, tmux_session (string|null), name_source, waiting_for (string|null),
title (first prompt, may be long), gen_title (string|null)
```

Empty output → no sessions. Non-JSON, non-array, a timeout or a missing binary → the host
entry becomes `{ ok: false, error }`; the server never crashes on it.

Peek/send/keys do **not** go through `fleet peek/send` (those truncate to terminal width and
add a header). `lib/backends.mjs` drives the backends directly, mirroring the CLI:

- **tmux** (handle = pane id): peek `capture-pane -p -J -t <h> -S -<n>`; send
  `send-keys -t <h> -l -- <text>` then `send-keys -t <h> Enter`; keys `send-keys -t <h> <Key>`.
- **iterm** (handle = iTerm session id): one AppleScript written to a temp file, values passed
  as argv (never interpolated). Send = `write text … without newline`, 0.2s, `write text ""`
  (bracketed paste would swallow a trailing newline).
- **unknown** → 409.

## HTTP API

JSON everywhere, same origin, no auth. Errors are `{ "error": "message" }`.
`:host` is a host name (self or a peer). `:id` is a `session_id` or a unique prefix of ≥ 8 chars.

| method | path | request | response |
| --- | --- | --- | --- |
| GET | `/api/health` | | `{ name, version, apiVersion, self, uptime, now }` |
| GET | `/api/settings` | | `{ apiVersion, self, hosts: [names], quickReplies: [{ label, text }] }` |
| GET | `/api/fleet` | `?local=1` = this host only | `{ self, hosts: [Host] }` — self first, then peers |
| GET | `/api/hosts/:host/sessions/:id/peek` | `?lines=200` (10..2000) | `{ host, id, backend, lines, text, capturedAt }` |
| GET | `/api/hosts/:host/sessions/:id/messages` | `?limit=60` (1..500) | `{ host, id, status, backend, name, limit, messages: [Message], total, truncated, updatedAt, capturedAt }` |
| POST | `/api/hosts/:host/sessions/:id/send` | `{ text }` (1..8000 chars, not blank) | `{ ok: true }` |
| POST | `/api/hosts/:host/sessions/:id/keys` | `{ key }`, one of `Enter`, `Escape`, `Up`, `Down` | `{ ok: true }` |
| POST | `/api/hosts/:host/spawn` | `{ name?, dir?, prompt? }` | `{ ok, host, name, dir, tmuxSession, command, trusted }` |

**Host** = `{ name, ok, error?, fetchedAt, spawnDirs?: [{ label, path }], sessions: [Session] }`.
Each host advertises its own `spawnDirs` (absolute paths on that host).

**Session** = the `fleet list --json` object + `host`. Sorted `waiting` → `busy` → `idle` →
`unknown`, then `updated_at` descending.

**Message** = `{ role: "user"|"assistant"|"system", kind: "user"|"assistant"|"command"|"system", text, ts, final? }`.
Conversation only: tool calls, tool results, thinking, hooks and sidechains are dropped.
Assistant text that ends a turn is `final: true`; narration between tool calls is `final: false`.
Last `limit` messages, oldest first; `truncated` when older ones exist.

**spawn**: `name` is sanitized (lowercase, `[a-z0-9_-]`, ≤ 40, default `fw-hhmmss`); `dir`
defaults to the host's first `spawnDirs` entry and must be an existing absolute directory that,
after `realpath` (symlinks and `..` resolved), is one of this host's `spawnDirs` or beneath one
(`$HOME` when none are configured) — anything else is a 400. A taken name is a 409.
Runs `tmux new-session -d -s <name> -c <dir>`, types `claude -n '<name>' '<prompt>'`, and
answers a first-run "trust this folder" dialog with "Yes" (`trusted: true` when it did).
The session shows up in `/api/fleet` once Claude registers it; clients poll for a session whose
`tmux_session` equals `tmuxSession`.

**Statuses**: 400 bad input, 404 unknown host/session/route (also a `?local=1` request for a
non-self host), 405 wrong method, 409 existing tmux session or uncontrollable backend,
413 body over 64 KB, 502 peer unreachable / non-JSON, 503 local discovery failed, 504 peer timeout.

**Timeouts / caching**: local list cached 2s; peer `/api/fleet` fetch 6s; proxied session and
spawn calls 20s.

**Static**: every non-`/api/` GET/HEAD is served from the UI dir with `cache-control: no-cache`
(path traversal rejected). No UI dir / no `index.html` → a placeholder page at `/`.

## UI (`public/`)

- Dark theme, system font for chrome, monospace for terminal text, safe-area insets, PWA manifest.
- **List** (`#/`): all sessions across hosts, filter chips (All / Needs you / Busy / Idle), search,
  unreachable-host banner, `+` opens the New-session sheet (host, directory radio built from that
  host's `spawnDirs` labels, name, first prompt). Polls `/api/fleet` every 5s while visible.
- **Detail** (`#/s/<host>/<id>`): Chat | Term toggle (choice in `localStorage`), one poll loop at a
  time. Chat polls `messages` every 3s and renders markdown (`public/markdown.js`, DOM-only, no
  `innerHTML`, only `http(s)` links). Term polls `peek` every 2s. Shared composer with quick-reply
  chips from `/api/settings` plus Esc / Enter / ↑ / ↓ keys.

## Running as a service

Run the server from a tmux session or a user service, not a bare launchd agent: under launchd
every `ps` call can take ~0.3–0.5s and discovery runs one per session, which can exceed the 8s
list timeout; on macOS a tmux server started from iTerm2 also inherits the Automation
permission `osascript` needs for iTerm sessions. `fleet web serve` / `fleet web install-service`
in the CLI own this; `bin/dev.sh` runs it in the foreground for development.

## Non-goals (v1)

Auth, HTTPS, killing sessions, tmux sessions without Claude, ANSI colors, xterm.js, websockets,
multi-user.
