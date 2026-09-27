# Architecture

`fleet` has one core and several front-ends. The core knows how to find Claude Code sessions on a
machine, drive them, manage tmux sessions and reach other machines. The CLI, the TUI dashboard and
the web app are views on top of it.

```
                ┌────────────────────────── crates/fleet ──────────────────────────┐
                │  core (library)                                                  │
                │   discovery ── Claude registry + ps + tmux/iTerm → Session[]     │
                │   backend   ── peek / send / keys / focus / spawn (tmux, iTerm)  │
                │   naming    ── generated titles + cache                          │
                │   tmux      ── tmux-session management (list/new/kill/stale…)    │
                │   config    ── the shared config file                            │
                │   hosts     ── host resolution, ssh dispatch                     │
                ├──────────────────────────────────────────────────────────────────┤
                │  cli (clap + text/JSON rendering)      tui (ratatui dashboard)   │
                └──────────────────────────────────────────────────────────────────┘
                              ▲ `fleet list --json` etc.
                ┌─────────────┴──────────── web/ ──────────────────────────────────┐
                │  server.mjs (Node ≥ 22, zero deps) — HTTP API + static PWA       │
                │  peers with the same server on other hosts                       │
                └──────────────────────────────────────────────────────────────────┘
```

## Components

### Core library (`crates/fleet/src/core`)

Pure logic plus thin process wrappers; no printing. Everything a future front-end needs is here:

- **discovery** — builds the list of live sessions (see [below](#session-discovery)).
- **backend** — per-backend control: read the screen, type text, press keys, focus, spawn.
  - tmux: `capture-pane -p -J`, `send-keys -l <text>` + `Enter`, `new-session` / `new-window`.
  - iTerm: AppleScript via `osascript`; values are passed as argv, never interpolated into the
    script. Text is written without a newline, then an empty write submits it (a trailing newline
    would be swallowed by bracketed paste).
- **naming** — generates short kebab-case titles by asking `claude -p --model haiku` what a
  session is working on (falls back to git branch / first prompt); cached across runs.
- **tmux** — tmux-*session* management inherited from `ws`: matching, sanitizing, stale detection.
- **config** — reads and patches the shared config file.
- **hosts** — resolves the target host and dispatches over ssh.
- **tools** — binary lookup (`PATH` plus Homebrew fallbacks), `~` expansion.

### CLI and TUI

`crates/fleet/src/cli` parses arguments and renders text or JSON; `crates/fleet/src/tui` is the
`watch` dashboard (ratatui). Neither contains discovery or backend logic.

### Host dispatch

Every command has a target host: `-H/--host <name>`, else `FLEET_HOST`, else a default
(`defaultHost` for tmux-session commands, this machine for everything else). `--local` forces the
local machine.

- target == `self` → run locally;
- otherwise → `ssh <hosts.<name>.ssh> fleet <same args>`.

The remote runs `fleet --local <args>` (so it never hops again), found as `hosts.<name>.fleetBin`,
then `~/.local/bin/fleet`, then `PATH` (with `FLEET_CMD`/`FLEET_DEBUG`/`FLEET_DRY_RUN` exported, never
`FLEET_CONFIG`) — install it with `fleet install --host <name>`. ssh is
invoked with a connect timeout (`FLEET_CONNECT_TIMEOUT`, default 5 s), keepalives and ControlMaster
multiplexing (off with `FLEET_MUX=0`); a tty (`-t`) is requested when both stdin and stdout are
terminals, otherwise `-T` with `BatchMode`. Directory arguments under `$HOME` are rewritten to `~/…`
so they resolve on the remote. An ssh failure (exit 255) becomes a friendly message and exit code 4.
`FLEET_DRY_RUN=1` prints what would run.

There is no chained hopping: a host dispatches only to hosts in its own config.

### Web server (`web/`)

Every machine runs the same `server.mjs`. It:

- serves the static UI, installable as a PWA: the React app built to `web/ui/dist/` when present
  (`fleet web build`), else the classic vanilla-JS `web/public/`;
- exposes **its own** sessions, discovered with `fleet list --json` (cached ~2 s);
- drives its own backends directly for peek/send/keys (it needs untruncated, header-free output);
- reads chat transcripts from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`;
- for the whole-fleet view, fetches each peer's local list over HTTP and merges.

Requests for another host are proxied once to that peer with `?local=1`, and requests carrying
`?local=1` are never proxied again, so there are no loops. Either machine's URL shows everything.

The server has no auth; it relies on the network (tailnet) for access control. The files
endpoints (chat file links → preview) therefore only serve paths that, after `realpath`, are
inside that host's `$HOME` or the session's cwd, and never secret stores like `~/.ssh` or `.env`.

## Config

One JSON file per machine, owned by the CLI (`fleet init`, `fleet config set`) and read by the web
server. Path: `$FLEET_CONFIG`, else `${XDG_CONFIG_HOME:-~/.config}/fleet/config.json`.

```json
{
  "version": 1,
  "self": "laptop",
  "defaultHost": "workstation",
  "hosts": {
    "laptop":      { "ssh": null,          "web": "http://100.x.y.z:7777" },
    "workstation": { "ssh": "workstation", "web": "http://100.x.y.z:7777" }
  },
  "web":  { "port": 7777, "bind": "0.0.0.0", "dir": null },
  "tmux": null,
  "spawnDirs": [
    { "label": "Project", "paths": { "laptop": "~/Code/project", "workstation": "~/Code/project" } }
  ]
}
```

| key | meaning |
| --- | --- |
| `self` | which `hosts` entry this machine is |
| `defaultHost` | target for tmux-session commands when no `-H` is given |
| `hosts.<name>.ssh` | ssh destination (an `~/.ssh/config` alias or `user@host`); `null` for `self` |
| `hosts.<name>.web` | that host's web server URL; hosts without one are not web peers |
| `web.port` / `web.bind` | web server listen address; with no config at all it binds `127.0.0.1` only |
| `web.dir` | where the web app lives (repo checkout or install dir), detected by `init` |
| `web.node` | `node` binary that runs the web app; `null` → `/opt/homebrew/bin/node`, `/usr/local/bin/node`, then `PATH` |
| `web.ui` | static UI directory to serve instead of the bundled one, or `"classic"` for `web/public`; unset → `web/ui/dist` when built, else `web/public` |
| `web.quickReplies` | composer chips: strings or `{ label, text }` |
| `web.models` | New session model picker: `[{ id, label }]` or bare ids (`""` = Claude's default, no `--model`); default Default, Fable 5.1, Opus 5.5, Sonnet 5, Haiku 4.5 |
| `web.autoName` | `{ enabled, intervalMinutes }` (default off, 5 — opt in with `enabled: true`): the web server runs `fleet name --all --apply` on its host on that schedule (tmux names follow the titles, see [Session titles](#session-titles)); a web spawn with a first prompt also gets a targeted `fleet name <id> --apply` once it has replied |
| `web.grouping` | `{ enabled, intervalMinutes }` (default off, 10): this host's web server runs `fleet group` over the whole fleet on that schedule and serves `/api/groups` (see [Smart grouping](#smart-grouping)) |
| `web.uploads` | `{ dir, maxMB, retentionDays }` (default `~/.local/share/fleet/uploads`, 100, 14): files dropped / pasted / picked in the web UI are stored there on the session's host as `YYYY-MM-DD/<rand>-<name>`, and their absolute path goes into the prompt; day dirs older than `retentionDays` are removed (`0` keeps them) |
| `web.briefs` | `{ enabled, model, idleMs, minIntervalMs, maxDeltaChars, maxCallsPerHour, minNewTurns, minNewChars, maxBriefChars }` (default off, `haiku`, 60 s, 15 min, 12000, 12, 2, 2000, 3000): background generation of [session briefs](#session-briefs) on this host; reading and editing briefs (and a manual regenerate) work either way |
| `web.files.roots` | array of dirs (`~` expanded, default `[]`): extra roots a relative file path in chat may be under. A relative path missing under the session cwd first matches files the session touched (from its transcript), then ancestors of those, then these roots; the sandbox stays `$HOME` + cwd |
| `tmux` | tmux binary; `null` → `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` |
| `hosts.<name>.fleetBin` | path to `fleet` on that host; `null` → `~/.local/bin/fleet`, then `PATH` |
| `fleetBin` | this machine's `fleet` binary (used by the web server) |
| `claude` | command that launches Claude Code in spawned sessions (default `claude`) |
| `spawnDirs` | directories offered for new sessions, per host (`paths.<host>`) |
| `tui` | dashboard preferences: `rows` (`"1"`, `"2"`, `"auto"`), `mouse` |
| `naming` | generated names: `enabled`, `model` (default `haiku`), `syncTmux` (tmux name follows the title, default on), `autoTitle` |
| `grouping` | smart grouping: `enabled` (default `true` — `false` = repository fallback only), `model` (default `haiku`), `host` (the one host whose web server runs it; peers proxy `/api/groups` there), `consolidateMinutes` (default 60) |

Rules: `~` is expanded at use time; unknown keys are preserved when the CLI rewrites the file
(writes go through the raw JSON, never the typed view); a missing file is fine — this machine is
the single host `local`, and remote features say "run `fleet init`"; a present but invalid file is
an error.

Env overrides for the web server: `FLEET_WEB_PORT` (or `PORT`), `FLEET_WEB_BIND`, `FLEET_WEB_UI`,
`FLEET_WEB_AUTONAME`, `FLEET_WEB_GROUPING`, `FLEET_WEB_BRIEFS`, `FLEET_BRIEFS_DIR`, `FLEET_BIN`, `FLEET_TMUX` — see [web/README.md](../web/README.md).

## Session discovery

Claude Code keeps a live registry: one `~/.claude/sessions/<pid>.json` per running interactive
session with its session id, cwd, name, status (`busy` / `idle` / `waiting`) and what it waits for.
That is the source of truth; `fleet` enriches each entry:

1. **pid → tty** via `ps`.
2. **tty → terminal**: match against `tmux list-panes -a` (pane id, window name, tmux session) and,
   on macOS, iTerm's sessions (session id, tab title). The match decides the **backend**
   (`tmux` / `iterm` / `unknown`) and the **handle** used to control it (tmux pane id like `%87`,
   or the iTerm session id).
3. **titles** from the naming cache (never generated by `list` itself).

Headless runs (`claude -p`, SDK and CI entrypoints) register too and are filtered out.

Targets (`peek <target>`, `send <target>` …) resolve against title, name, session-id prefix or pid,
walking exact → prefix → substring → characters-in-order; two matches on the same rung is an error
listing the candidates, so a loose fragment can never type into the wrong session.

## Session titles

One title per session, one source of truth (`core::title`):

- **The Claude session name is the truth.** `/rename` sets it and Claude persists it in its
  session registry (`name`, `name_source: "user"`).
- **`display_title`** is derived once, in core, and shipped in `list --json`: the Claude name when
  someone chose it (`name_source` ≠ `derived`), else the generated title (`gen_title`), else a
  slug of the first prompt, else Claude's derived `<cwd>-9d` name, else the short session id / pid.
  The CLI, TUI and web UIs draw only this; the tmux name is at most metadata (details panel, the
  TUI's terminal column).
- **The tmux session name is derived**: a slug of the title (lowercase kebab, common Latin
  accents folded, ≤ 48 chars), `-2`, `-3`… on a collision; a name already derived from the title
  (with or without its suffix) is left as is. It is synced on **every** rename — `fleet rename`,
  `fleet name --apply` (auto-naming), the TUI rename buffer, the web UI — but only when the tmux
  session is that Claude session's own: one window, one pane. Shared sessions, `fleet` and the
  dashboard's own session are left alone, with a note saying so. `naming.syncTmux = false` or
  `--no-tmux-sync` opts out.
- **Reverse edge**: `fleet tmux rename` of a single-Claude tmux session renames the Claude session
  (and so the title); raw `tmux rename-session` is not watched and is overwritten the next time the
  title changes. Auto-naming never clobbers a hand-picked tmux name: a derived-name session alone in
  a non-generic tmux session (not `fw-hhmmss`, digits or `<cwd>-xx`) adopts that name as its title.
- **iTerm** tab titles are not touched: Claude already puts its session name in the terminal title,
  and a tab title set by hand is the user's.
- **When `/rename` may be typed**: `/rename <title>` + Enter goes into the live Claude TUI. A
  session **waiting** on a permission prompt or question is held (the keys would answer it; `--force`
  overrides). A **busy** session is renamed: Claude Code runs `/rename` as a local command the moment
  it is submitted, mid-turn, and the turn carries on untouched (verified live; an older Claude that
  queues input would run it after the turn). Nothing is queued by fleet — a held rename is refused
  with a message and retried by the caller. Known gap: text half-typed into the session's prompt
  box would be prefixed to `/rename`.

## JSON contracts

These are stable APIs — the web app, scripts and future UIs depend on them. Add fields freely;
never rename, remove or change the type of an existing one without a version bump.

### `fleet list --json`

An array of sessions; every row carries `host` (the name the *caller's* config knows that machine
by — with no config, `local`):

| field | type | notes |
| --- | --- | --- |
| `pid` | number | Claude process id |
| `session_id` | string \| null | Claude session UUID |
| `name` | string \| null | Claude session name |
| `name_source` | string \| null | `"derived"` = Claude's cwd+hash fallback |
| `cwd` | string \| null | working directory |
| `status` | string | `busy` \| `idle` \| `waiting` \| `unknown` |
| `waiting_for` | string \| null | what a `waiting` session is blocked on |
| `updated_at` | number \| null | last status change, ms since epoch |
| `tty` | string \| null | |
| `backend` | string | `tmux` \| `iterm` \| `unknown` |
| `handle` | string \| null | tmux pane id or iTerm session id |
| `tab` | string \| null | tmux window name / iTerm tab title |
| `tmux_session` | string \| null | tmux session the pane lives in |
| `title` | string \| null | first prompt (can be long) |
| `gen_title` | string \| null | generated title, if cached |
| `display_title` | string | **the** title every view draws — see [Session titles](#session-titles) |
| `context` | object \| null | context-window usage (below); `null` when no transcript usage is found |
| `host` | string | which machine the row came from |

`list --all-hosts --json` is the same array across every configured host.

#### Context usage

`context` is `{ used, window, pct, model }`, computed in `core::context` from the tail of the
session's transcript (`~/.claude/projects/<cwd with / and . as ->/<session_id>.jsonl`, falling
back to a scan of the project dirs when the session's cwd changed):

- **`used`** (number): prompt tokens of the **last main-thread assistant entry** with real usage —
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Sidechain (subagent)
  entries, API-error entries, `<synthetic>` and all-zero usage are skipped. Output tokens are not
  counted (the same sum Claude Code's statusline context percentage uses); the reply is counted as
  input on the next turn.
- **`window`** (number): `200000` or `1000000`, inferred — transcripts don't record it. 1M when the
  model id ends in `[1m]`, when `used` already exceeds 200k, when `settings.json` pins a `[1m]`
  model of that family, when Claude Code's `~/.claude.json` has recorded that exact model id as
  `<id>[1m]`, or when another live session on the same model id is past 200k without a suffix
  (the model is natively 1M). Otherwise 200k — so a 1M session under 200k with none of these
  signals over-reports its percentage.
- **`pct`** (number): `round(used / window * 100)`; can exceed 100.
- **`model`** (string \| null): `message.model` of that entry.

Only the tail is read (256 KiB, widened to 2 MiB then 8 MiB if no usable entry is in it), and the
result is cached in-process per `(path, size, mtime)`, so the `watch` dashboard re-reads a
transcript only after it has grown. Views colour `pct` in the same bands: under 60 dim, 60–85
amber, over 85 red.

### `fleet group --json`

See [cli.md](cli.md#grouping) for the shape. State file: `groups.json` (below).

### `fleet tmux list --json` / `fleet tmux stale --json`

See [cli.md](cli.md#tmux-sessions) for the shapes.

### Web API

JSON over HTTP, errors as `{ "error": "..." }`. At a high level:

| method | path | purpose |
| --- | --- | --- |
| GET | `/api/health` | name, version, apiVersion, self, uptime, autoName (`lastRun`) |
| GET | `/api/settings` | apiVersion, self, host names, quick replies |
| GET | `/api/fleet[?local=1]` | `{ self, hosts: [{ name, ok, error?, sessions, spawnDirs }], snapshotAt }` — sessions are `list --json` objects + `host` (`title` capped at 300 chars); the merged view is a warm background-refreshed snapshot |
| GET | `/api/hosts/:host/sessions/:id/peek?lines=N` | plain-text screen |
| GET | `/api/hosts/:host/sessions/:id/messages?limit=N` | conversation (no tool calls) from the transcript |
| POST | `/api/hosts/:host/sessions/:id/send` | `{ text }` → typed + Enter |
| POST | `/api/hosts/:host/sessions/:id/keys` | `{ key }` (Enter, Escape, …) |
| POST | `/api/hosts/:host/sessions/:id/rename` | `{ title }` (1–64 chars, one line) → `fleet rename <session_id> <title> --json`; 200 with the report, **409** when held (waiting on a prompt, nothing typed), 400 bad title, 502 CLI failure |
| POST | `/api/hosts/:host/spawn` | `{ name?, dir?, prompt? }` → new tmux session running claude; `dir` must resolve inside one of the host's `spawnDirs` (else 400) |
| POST | `/api/hosts/:host/sessions/:id/kill` | `{}` → SIGTERM (then SIGKILL) Claude, then kill its tmux session (or just its window when the session has others) / close its iTerm tab |
| GET | `/api/groups` | the Board view's groups: `{ enabled, host, intervalMinutes, running, updatedAt, lastRun, groups: [{ id, label, description, source, members: [{ host, id }] }] }`; served by the grouping host, proxied by every other server (`enabled: false` when nobody runs it) |
| POST | `/api/groups/run` | `{}` → run the grouping pass now (on the grouping host) → the same shape; 501 when grouping is off |
| POST | `/api/hosts/:host/uploads?name=<file>` | raw file body → stored under that host's `web.uploads.dir` → `{ host, path, name, size }` (absolute `path`; 413 over `web.uploads.maxMB`); streamed through to a peer |
| POST | `/api/hosts/:host/autoname` | `{}` → run the naming pass on that host now → `{ renamed: [{ from, to }], tmux, held, errors }` |
| POST | `/api/hosts/:host/sessions/:id/files/stat` | `{ paths }` (≤ 200, as written in chat, `:line` allowed) → per path: resolved absolute path, `exists`, `isFile`, size, mtime, `kind` (markdown/text/image/pdf/other); the UI links only existing files |
| GET | `/api/hosts/:host/sessions/:id/files/raw?path=…[&download=1]` | the file itself, streamed (also through a peer); text/markdown over 5 MB only as a download |
| POST | `/api/hosts/:host/sessions/:id/files/open` | `{ path }` → opens it with its default app **on that host** (`open` / `xdg-open`; runnable files are revealed in their folder instead) |
| GET | `/api/hosts/:host/sessions/:id/brief` | the session's [brief](#session-briefs): `{ host, id, exists, markdown, parsed: { summary, resources, plan }, updated, editedAt, generatedAt, generatedThrough, generating, enabled, continuePrompt }` — an empty skeleton (`exists: false`) before there is one; a gone session's brief is still served by its full id |
| PUT | `/api/hosts/:host/sessions/:id/brief` | `{ markdown }` → a human edit (sets `editedAt`) → the same shape |
| POST | `/api/hosts/:host/sessions/:id/brief/regenerate` | `{}` → **202** `{ host, id, started, queued, generating: true }`, the model call runs in the background (poll GET); **429** `{ error, retryAfterMs }` at the hourly cap |

`:host` is `self` or a configured peer; `:id` is a session id or a unique prefix (≥ 8 chars). The
full contract (status codes, limits, timeouts) lives with the server: [web/README.md](../web/README.md),
[web/ARCHITECTURE.md](../web/ARCHITECTURE.md).

## Smart grouping

The web Board view shows sessions as columns of work streams, and nobody maintains those groups:
`core::grouping` (the `fleet group` verb) does, with one source of truth for the whole fleet.

- **Where it runs.** One host: `grouping.host`, or — without it — the host whose server has
  `web.grouping.enabled`. That server runs `fleet group --input - --apply --json` every
  `web.grouping.intervalMinutes` (default 10, first run 20s after start) with its merged
  `/api/fleet` body on stdin — so it needs no ssh to its peers, only their web servers — and early
  (≥ 2 min after the last run) when the warm snapshot shows live sessions no group knows. Every
  other server proxies `/api/groups` to it (and finds it by asking peers when `grouping.host` is
  unset). The state lives on that host (`~/.local/state/fleet/groups.json`).
- **Input per session**: display name (generated title, else name), name, the last two cwd
  segments (worktree paths carry the branch-ish name; the git branch itself is not read — a
  remote session's branch isn't cheaply known), host, the first prompt's first 160 characters.
  Prompts are capped at 12k characters per call; overflow goes to another call, at most 4 per run.
- **Stability.** Assignments persist per `host/sessionId` with a fingerprint of those inputs; an
  unchanged session is never re-sent. New or changed sessions are classified into the existing
  groups (the model sees their labels and a few member names and is told never to rename them) or
  a new group; a new label equal to an existing one reuses that group. Consolidation — merge
  clearly identical streams, fix a clearly wrong label — runs at most hourly, only after changes,
  and is capped at 2 merges + 2 renames per pass. Group ids never change; empty groups vanish;
  sessions of a host that didn't answer keep their group.
- **Fallback.** Model disabled, missing, logged out, or answering garbage (one retry on an
  unparseable answer, none on a failed call): group by repository, marked `fallback`, reclassified
  once the model is back. The UI does the same grouping client-side when no server runs grouping.
- **Cost.** A run with nothing new makes no model call; a typical run after one new session makes
  one (haiku, ~2–8k prompt characters, 10–45s wall clock with `claude -p` start-up).

## Session briefs

A brief is a small markdown doc per session: 1–2 sentences on exactly what the session is doing and
where (repo/cwd, branch, host), every resource it produced, and a short plan with progress — enough
to start a **new** session from it and just continue (`continuePrompt` in the API is that first
prompt). The user can edit it; their edits are authoritative.

**Storage.** One file per session on the host the session lives on:
`$FLEET_BRIEFS_DIR/<session_id>.md`, else `${XDG_STATE_HOME:-~/.local/state}/fleet/briefs/<session_id>.md`
(dir `0700`, files `0600`), always written atomically (temp file + rename). The web server owns
generation (`web/lib/briefs.mjs`); any other reader/writer — `fleet brief` (`core::brief`, a port
of `web/lib/brief-format.mjs` and the PUT rules) — uses the same files and must follow the same
format and merge rules. Both implementations pin the shared fixtures in `testdata/briefs/`
(regenerate the expected outputs from the server code with `node testdata/briefs/gen.mjs`).

**Format** (a contract, like the JSON outputs — add keys freely, never rename or retype one):

```markdown
---
session: <session_id>
host: laptop
cwd: ~/Code/project
updated: 2026-01-02T03:04:05.000Z
generatedThrough: 48213
generatedAt: 2026-01-02T03:04:05.000Z
editedAt: 2026-01-02T03:10:00.000Z
todos: 3f2a9c01b7de
dismissed: ["https://github.com/owner/repo/pull/9"]
---
## Summary
Fixing the login redirect loop in ~/Code/project on branch fix-login; the fix is in review.

## Resources
- Branch: `fix-login`
- PR: [owner/repo#12](https://github.com/owner/repo/pull/12)
- File: `src/login.ts`
- Spec: `specs/login/SPEC.md`
- Artifact: [Login report](https://claude.ai/code/artifact/…)
- Link: [docs.example.dev/auth](https://docs.example.dev/auth)

## Plan
- [x] reproduce the loop
- [ ] fix the redirect (in progress)
```

- Frontmatter: `key: value` lines between `---` fences. Numbers are bare, arrays/objects are
  one-line JSON, a string that would read back as another type is a JSON string. Keys:
  `session`, `host`, `cwd` (informational, written by the server); `updated` (last write of any
  kind, ISO 8601); **`generatedThrough`** — the **byte offset** into the session's transcript JSONL
  (`~/.claude/projects/<encoded cwd>/<session_id>.jsonl`) up to which the conversation has been
  summarised, always at a line boundary (a transcript smaller than it was replaced: start over);
  `generatedAt` (last model generation); `editedAt` (last human edit, absent until one);
  `todos` (hash of the todo list last copied into Plan); `dismissed` (resource keys a human
  deleted — never added back; at most 200). Unknown keys are preserved.
- Body: exactly three `## ` sections, written in this order — `Summary`, `Resources`, `Plan`.
  Parsers are tolerant: headings case-insensitive, sections in any order or missing, text before
  the first heading and other `## ` sections are kept (written after Plan), `*`/`+` bullets,
  `[X]`.
- Resources: one bullet per item, `- <Kind>: <value>`, value a markdown link `[label](url)` or a
  code span `` `path` ``. Kinds: `PR`, `Issue`, `Artifact`, `Spec`, `File`, `Branch`, `Worktree`,
  `Link`. Any other bullet (no kind, free text) is a hand-written line and kept as is. An item's
  **key** is its URL (fragment and trailing `/` dropped), else its path (`branch:<name>` /
  `worktree:<path>` for those two kinds). Paths are relative to the session's cwd when inside it,
  else `~/…`, else absolute.
- Plan: `- [ ] step` / `- [x] step` lines; other lines in the section are kept.

**Merge rules** (every writer): never drop a line a human wrote; new auto items are appended
unless their key is already present or in `dismissed`; a human edit (PUT) that removes a
resource line adds its key to `dismissed`; the machine keys (`generatedThrough`, `generatedAt`,
`todos`, `dismissed`) are the writer's, not taken from an edited body.

**Generation** (hybrid, `web/lib/brief-extract.mjs` + `web/lib/briefs.mjs`):

1. *Resources without a model*, read incrementally from the transcript: files the session wrote
   (Edit / Write / MultiEdit / NotebookEdit targets, shell redirects and `tee`; temp dirs skipped;
   `SPEC.md`, `FINAL.md` and files under `specs/` are `Spec`), PR/issue URLs printed by
   `gh pr|issue create`, artifact URLs returned by an Artifact publish, PR/issue/artifact/other
   links in the assistant's text, PR/issue/artifact links in the user's prompts; branch and
   worktree from one `git rev-parse` in the cwd. Links to this machine or the private network (IP
   literals, dotless or `.local`/`.ts.net` hosts), schema hosts, templated or `…`-truncated URLs are
   dropped. Read-only tool output (a file that lists PRs) never counts.
2. *Plan without a model* when the session keeps todos: the latest `TodoWrite` list, or the task
   list from `TaskCreate`/`TaskUpdate`, is the Plan (rewritten only when the list changes, so a
   hand edit stands until the next todo change).
3. *Summary* (and the Plan when there are no todos) from `claude -p --model <model>` — flags as in
   `core::naming` (prompt on stdin, `--strict-mcp-config`, tools disallowed, a neutral cwd) plus
   `--no-session-persistence`, 2 min timeout. Input: the current Summary + Plan (≤ `maxBriefChars`)
   and ONLY the conversation since `generatedThrough` — user prompts and turn-ending assistant
   text, each clipped, newest kept, ≤ `maxDeltaChars` — told that hand-edited content is
   authoritative and to update, not rewrite. The answer must be a `## Summary` (≤ 1200 chars) and
   optionally a `## Plan` of checkboxes; anything else keeps the old brief. An edit that lands
   while the model runs wins (the answer is discarded).

**Budget** — model calls are what costs, so every automatic one has to pass all of:

- the session is `idle` or `waiting`, and has been for `idleMs` (registry `updated_at`);
- its transcript grew past `generatedThrough` by ≥ `minNewTurns` user prompts or ≥
  `minNewChars` characters of conversation;
- ≥ `minIntervalMs` since that session's last call (a gated update stays pending and runs when the
  gate opens, without needing more growth);
- no other brief call is running on this host (one at a time), and fewer than
  `maxCallsPerHour` calls in the last hour.

The background pass checks this host's live sessions every 30 s (the 2 s discovery cache — no
extra `fleet list` while a UI is polling) and forgets sessions that are gone. Resource and plan
extraction (no model) runs whenever the transcript grew — in the background pass and on GET. A
manual regenerate skips the idle, interval and new-content gates (with nothing new it re-reads the
recent conversation) but waits for the one-at-a-time slot and counts against the hourly cap. Each
call is logged with its input size (`[briefs] idle 1a2b3c4d: claude -p --model haiku, 12 msg(s) /
3 user turn(s), 8123 chars in (4/12 this hour)`); `/api/health` reports `briefs: { enabled, model,
callsLastHour, maxCallsPerHour, generating, lastRun }`.

## Extension points

- **Another web UI.** The HTTP API is the contract; point `web.ui` (or `FLEET_WEB_UI`) at a
  directory with its own `index.html` and it is served same-origin with `/api/*`, or build a
  separate app against the same API.
- **A different TUI or native app.** Link the core library (`fleet::core`) directly, or shell out
  to `fleet list --json` and the other commands.
- **Integrations** (notifications, chat bots, status bars): poll `fleet list --all-hosts --json`
  or `GET /api/fleet`; act through `fleet send` / `POST …/send`. Treat anything that can send as
  having the agent's full permissions.
- **New backends** (another terminal emulator): implement discovery matching (tty → handle) and
  the control operations in `core::backend`; everything above picks it up.
- **The Claude Code skill** (`fleet skill install`) teaches an agent to use `fleet` itself —
  e.g. to hand work off to another session.
