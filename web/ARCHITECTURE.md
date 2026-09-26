# fleet-web — architecture

A zero-dependency Node server that exposes the fleet over a small JSON HTTP API, plus a
mobile-first PWA built on that API. Every host runs the same server; any one of
them shows the whole fleet by merging in its peers. No auth — meant for a private network
(e.g. a Tailscale tailnet). The server has no build step and no npm dependencies.

The API is the stable part. Two UIs ship with it: `ui/` (React + shadcn/ui, built to `ui/dist/`,
the default when built — see [ui/README.md](./ui/README.md)) and `public/` (the classic vanilla-JS
UI, the fallback). Another UI can be pointed at the same API (or served by it via `web.ui`, see
Config).

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
lib/fleet-cli.mjs     the ONLY place that invokes the `fleet` CLI (`list --json`, `name --all --apply`)
lib/fleet.mjs         local discovery: cache (2s TTL), in-flight de-dup, never throws
lib/backends.mjs      peek/send/keys straight to tmux / iTerm2 (osascript)
lib/transcript.mjs    Claude Code transcript JSONL → chat messages
lib/spawn.mjs         new tmux session + `claude [-n <name>] '<prompt>'`, auto-accept folder trust
lib/kill.mjs          close a session: SIGTERM/SIGKILL Claude, then its tmux session/window or iTerm tab
lib/autoname.mjs      periodic `fleet name --all --apply` + generic-tmux-name sync
lib/grouping.mjs      periodic `fleet group` over the merged fleet (the grouping host only)
lib/snapshot.mjs      warm stale-while-revalidate snapshot of the merged /api/fleet
lib/peers.mjs         peer fetch + one-hop proxy
lib/api.mjs           /api/* request handling (no UI knowledge)
lib/app.mjs           node:http server: /api/* → api, everything else → static UI dir
lib/http.mjs, util.mjs, run.mjs   helpers (body limit, static path safety, execFile wrapper)
ui/                   the React UI (Vite + TS + Tailwind v4 + shadcn/ui); only ui/dist is served/installed
public/               the classic PWA (vanilla JS, hash routing, no build)
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
| `web.ui` | static UI: a directory path, or `"classic"` (= `web/public`); unset/`null` → `web/ui/dist` when built (has `index.html`), else `web/public` |
| `web.quickReplies` | composer chips: `["text", { "label", "text" }]` (default Continue/Yes/No/1/2); `{ label, kind: "text", value }` is accepted too, `kind: "key"` entries are skipped (the key chips are built in) |
| `web.autoName` | `{ enabled, intervalMinutes }`, default `{ false, 5 }` (opt-in): the periodic naming pass (see Auto-naming); `false` also makes a nameless spawn pass `-n fw-hhmmss` |
| `web.grouping` | `{ enabled, intervalMinutes }`, default `{ false, 10 }` (opt-in): run the grouping pass here for the whole fleet (see Smart grouping) |
| `grouping.host` | the host whose server runs grouping; set, it is the only one (a `web.grouping.enabled` elsewhere is ignored) and every other server proxies `/api/groups` to it |
| `tmux` | tmux binary; `null` → PATH, `/opt/homebrew/bin`, `/usr/local/bin` |
| `fleetBin` | `fleet` binary; `null` → PATH, fallbacks, `~/.local/bin`, `~/.cargo/bin` |
| `claude` | launcher typed by spawn (default `claude`) |
| `spawnDirs[]` | `{ label, paths: { <host>: dir } }` → this host offers `{ label, path: paths[self] }`; `{ label, path }` means the same dir on every host; `~` expanded; none → `[{ label: "Home", path: $HOME }]` |

Env overrides: `FLEET_CONFIG`, `FLEET_WEB_PORT` (or `PORT`), `FLEET_WEB_BIND`, `FLEET_WEB_UI`,
`FLEET_WEB_AUTONAME` / `FLEET_WEB_GROUPING` (`0`/`false`/`off` disables, anything else enables), `FLEET_BIN`, `FLEET_TMUX`.

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
title (first prompt, may be long), gen_title (string|null),
display_title (string — THE title to draw, see docs/architecture.md → Session titles),
context ({ used, window, pct, model } | null — context-window usage, see docs/architecture.md)
```

Empty output → no sessions. Non-JSON, non-array, a timeout or a missing binary → the host
entry becomes `{ ok: false, error }`; the server never crashes on it. `title` is trimmed to 300
chars (+ `…`) for transport: the first prompt can run to 10 KB and the list shows one line.
Every other field, `context` included, is passed through untouched (older CLIs omit `context`;
UIs treat a missing one as unknown).

The naming pass is `fleet name --all --apply` (timeout 5 min, `NO_COLOR=1`); its human output is
parsed line by line: `<from>  →  <to>` renamed, `⏸ …` held (waiting on a prompt), `✕ …` error,
`⧉ …` tmux note (the CLI renames the tmux session with the title).

A rename is `fleet rename <session_id> <title> --json` (timeout 20s): the report
`{ ok, result: renamed|sent|held, held, tmux: { renamed, from, to, note }, message, … }` on
stdout; a held session exits 3 with the report still on stdout (`lib/fleet-cli.mjs#rename`
resolves it), anything else non-zero is an error.

The grouping pass is `fleet group --input - --apply --json` (timeout 5 min, the merged
`/api/fleet` body on stdin; `lib/run.mjs` takes `opts.input`); at start the server reads the stored
groups with `fleet group --cached --json`. Both answer the JSON report in docs/cli.md → Grouping.

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
| GET | `/api/health` | | `{ name, version, apiVersion, self, uptime, now, autoName: { enabled, intervalMinutes, lastRun } }` |
| GET | `/api/settings` | | `{ apiVersion, self, hosts: [names], quickReplies: [{ label, text }] }` |
| GET | `/api/fleet` | `?local=1` = this host only | `{ self, hosts: [Host], snapshotAt }` — self first, then peers (`snapshotAt` only on the merged view) |
| GET | `/api/hosts/:host/sessions/:id/peek` | `?lines=200` (10..2000) | `{ host, id, backend, lines, text, capturedAt }` |
| GET | `/api/hosts/:host/sessions/:id/messages` | `?limit=60` (1..500) | `{ host, id, status, backend, name, limit, messages: [Message], total, truncated, updatedAt, capturedAt }` |
| POST | `/api/hosts/:host/sessions/:id/send` | `{ text }` (1..8000 chars, not blank) | `{ ok: true }` |
| POST | `/api/hosts/:host/sessions/:id/keys` | `{ key }`, one of `Enter`, `Escape`, `Up`, `Down` | `{ ok: true }` |
| POST | `/api/hosts/:host/sessions/:id/rename` | `{ title }` (trimmed, 1..64 chars, one line) | `{ ok: true, host, id, result, title, from, tmux, message, … }` — the `fleet rename --json` report. **409** `{ error, result: "held", held: "waiting", … }` when the session is waiting on a prompt (nothing typed); 400 bad title; 404 unknown session; 502/504 CLI failure / timeout. Proxied once to a peer like the other session actions |
| POST | `/api/hosts/:host/spawn` | `{ name?, dir?, prompt? }` | `{ ok, host, name, dir, tmuxSession, command, trusted }` |
| POST | `/api/hosts/:host/sessions/:id/kill` | `{}` | `{ ok: true, host, id, name, process, terminal }` |
| GET | `/api/groups` | | `{ enabled, host, intervalMinutes, running, updatedAt, lastRun: { at, ms, ok, reason, mode, modelCalls, classified, note?, error? } \| null, groups: [{ id, label, description, source, members: [{ host, id }] }], error? }` — `enabled: false` (and `groups: []`) when no host runs grouping or the grouping host is unreachable |
| POST | `/api/groups/run` | `{}` | the same shape after the run (502 when it failed, 501 when grouping is off) |
| POST | `/api/hosts/:host/autoname` | `{}` | `{ host, ok, at, ms, reason, dryRun, renamed: [{ from, to }], tmux: ["a → b"], held: [..], errors: [..], error? }` (502 when the pass failed) |

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
answers a first-run "trust this folder" dialog with "Yes" (`trusted: true` when it did). With no
`name` (and auto-naming on) it types plain `claude '<prompt>'`: Claude derives `<cwd>-9d`, and the
next naming pass replaces it, and the CLI renames the `fw-hhmmss` tmux session to match.
The session shows up in `/api/fleet` once Claude registers it; clients poll for a session whose
`tmux_session` equals `tmuxSession`.

**kill** closes a session for good: SIGTERM to Claude's `pid` (SIGKILL after 4s), then the
terminal that hosted it. tmux: the whole tmux session when Claude's window was its only window
(`terminal: "tmux-session-killed"`), else just that window (`"tmux-window-killed"`). The pane's
session/window ids (`$3`, `@7`, never names) are resolved *before* the signal, because when Claude
is the pane's own command its pane, window or session vanish with it (a target that already
closed itself counts as done); a pane that was already gone is `"tmux-pane-gone"`. iTerm: the tab is closed best-effort (`"iterm-tab-closed"` |
`"iterm-tab-left"`); `unknown` backend: `"left"`. `process` is `terminated` | `killed` | `gone` |
`skipped`. It lives here (lib/kill.mjs, next to the backends) rather than in the CLI: everything
it needs is already in the `list --json` row. The UI exposes it in the ⋯ menu as a two-tap
"Close… → Confirm close" button that returns to the list.

**Statuses**: 400 bad input, 404 unknown host/session/route (also a `?local=1` request for a
non-self host), 405 wrong method, 409 existing tmux session or uncontrollable backend,
413 body over 64 KB, 502 peer unreachable / non-JSON, 503 local discovery failed, 504 peer timeout.

**Timeouts / caching**: local list cached 2s; peer `/api/fleet` fetch 6s; proxied session and
spawn calls 20s (a proxied `autoname` can outlast that and then answers 504, while the pass still
finishes on the peer).

**Warm snapshot**: the merged `/api/fleet` (local discovery + every peer) is kept warm
(lib/snapshot.mjs). While anyone asked in the last 90s the server rebuilds it every 3s in the
background and serves the last result immediately (stale-while-revalidate; `snapshotAt` says
when it was built). Only the first request ever waits for a build; after idling, the next one gets
the old snapshot at once and wakes the refresher. Spawn, kill and autoname rebuild it right away.
`?local=1` (what peers poll) bypasses it and uses the 2s local cache. Without this a page load
waited ~1–2s on `fleet list` (one `ps` per session plus an osascript for iTerm tab titles).

**Static**: every non-`/api/` GET/HEAD is served from the UI dir with a weak ETag
(`W/"<size>-<mtime>"`, hex) and `cache-control: no-cache`, so a reload revalidates and gets `304`
(path traversal rejected) — except content-hashed build assets (`/assets/…/<name>-<hash ≥ 8>.<ext>`,
what Vite emits), which get `public, max-age=31536000, immutable`. No SPA fallback: both UIs use
hash routing, so only `/` is ever loaded; a missing file is a 404. No UI dir / no `index.html` →
a placeholder page at `/`.

## Auto-naming

Sessions started without a name keep Claude's cwd+hash fallback (`project-9d`). `fleet name`
generates task-shaped names (`claude -p`, cached) and applies them with Claude's own `/rename`,
holding sessions waiting on a prompt, but only when someone runs it. The web server is the
scheduler: each host's server runs `fleet name --all --apply` every
`web.autoName.intervalMinutes` (default 5, first run 60s after start) and on
`POST /api/hosts/:host/autoname` (⋯ menu → Run now). It already runs on every host, inside tmux,
which on a headless machine is often the one place `claude -p` can reach a logged-in keychain (a
plain ssh shell may not).

There is one rename path: the CLI renames the Claude session (the title) and the tmux session
follows as a slug of it, only for a tmux session that is that one Claude session's own. A tmux
session somebody named by hand (`fleet new fix-login`) is not clobbered — the CLI adopts its name
as the title instead of generating one. The server touches no tmux names itself (docs/architecture.md
→ Session titles). Runs are de-duplicated; `/api/health` reports `autoName.lastRun`.

## Smart grouping

The Board view's groups come from `fleet group` (docs/architecture.md → Smart grouping). Exactly
one server runs it: `grouping.host`, else the one with `web.grouping.enabled`. `lib/grouping.mjs`
there reads the stored groups at start (`--cached`), runs the pass 20s later and then every
`web.grouping.intervalMinutes`, feeding it a freshly built merged fleet (`handleApi.buildFleet()`,
which doesn't warm the snapshot), and checks every 60s whether the *warm* snapshot (only there
while someone is watching; never triggers discovery) holds live sessions no group has — if so, and
the last run is ≥ 2 min old, it runs early. The CLI decides whether the model is called, so a
scheduled run over an unchanged fleet costs one `fleet group` process and no model call. Runs are
de-duplicated; `/api/health` reports `grouping: { enabled, host, lastRun }`.

Other servers answer `/api/groups` by proxying to `grouping.host` (or the first peer whose
`/api/groups?local=1` says `enabled: true`, cached 5 min); `?local=1` is never forwarded again.

## UI (`ui/`, React)

Feature parity with the classic UI below, plus a host filter, theme choice and session details:
same routes (hash routing `#/`, `#/s/<host>/<id>`), same polling (fleet 5s, messages 3s, peek 2s,
paused while hidden) and the same `fleet.*` localStorage keys (`fleet.snapshot`, `fleet.filter`,
`fleet.detailMode`, `fleet.termFont`, `fleet.termLines`, `fleet.chatFont`, `fleet.chatHideNotes`,
`fleet.spawnHost`, `fleet.spawnDirLabel.<host>`), so switching UIs keeps preferences. Built with
React 19 + Tailwind v4 + shadcn/ui; markdown is parsed to an AST and rendered as React elements
(no `innerHTML`, only `http(s)` links). A 404 whose error starts with `unknown session` means the
session is gone; any other 404 from `messages` means there is no transcript yet. Structure and conventions: [ui/README.md](./ui/README.md). Dev: `npm --prefix ui run dev`
proxies `/api` to a running server (`FLEET_WEB_URL`, default `http://127.0.0.1:7777`).

## Classic UI (`public/`)

- Dark theme, system font for chrome, monospace for terminal text, safe-area insets, PWA manifest.
- **List** (`#/`): all sessions across hosts, filter chips (All / Needs you / Busy / Idle), search,
  unreachable-host banner, `+` opens the New-session sheet (host, directory radio built from that
  host's `spawnDirs` labels, name, first prompt). Polls `/api/fleet` every 5s while visible. The
  last fleet is kept in `localStorage` (`fleet.snapshot`, ignored after 6h) and painted before the
  first poll returns.
- **Detail** (`#/s/<host>/<id>`): Chat | Term toggle (choice in `localStorage`), one poll loop at a
  time. Chat polls `messages` every 3s and renders markdown (`public/markdown.js`, DOM-only, no
  `innerHTML`, only `http(s)` links). Term polls `peek` every 2s. Shared composer with quick-reply
  chips from `/api/settings` plus Esc / Enter / ↑ / ↓ keys. The ⋯ menu also has
  "Auto-name (host) → Run now" (`POST …/autoname`) and "Close session" (two taps, `POST …/kill`).

## Running as a service

Run the server from a tmux session or a user service, not a bare launchd agent: under launchd
every `ps` call can take ~0.3–0.5s and discovery runs one per session, which can exceed the 8s
list timeout; on macOS a tmux server started from iTerm2 also inherits the Automation
permission `osascript` needs for iTerm sessions. `fleet web serve` / `fleet web install-service`
in the CLI own this; `bin/dev.sh` runs it in the foreground for development.

## Non-goals (v1)

Auth, HTTPS, tmux sessions without Claude, ANSI colors, xterm.js, websockets, multi-user.
