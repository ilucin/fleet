# CLI reference

`fleet <command> [args]`. `fleet --help` and `fleet <command> --help` are authoritative; this page
explains the model and the semantics behind them.

## Global options

| option | meaning |
| --- | --- |
| `-H, --host <name>` | run against that host from the config (see [dispatch](#host-dispatch)) |
| `--local` | run on this machine, never over ssh |
| `-n, --dry-run` | print what would run, run nothing (also `FLEET_DRY_RUN=1`) |
| `--json` | machine-readable output, where the command supports it |
| `-h, --help`, `-V, --version` | |

Global options are accepted before or after the subcommand (`fleet -H workstation list` =
`fleet list -H workstation`).

### Host dispatch

The target host is `-H`, else `FLEET_HOST`, else a default: `defaultHost` from the config for
tmux-session commands (`tmux …`, `enter`, `last`, `new`, `exec`, `ssh`), this machine for everything
else. `self`, `local` and `localhost` always mean this machine. If the target is another machine,
`fleet` runs `fleet --local <same args>` there over `ssh <hosts.<name>.ssh>` (with a tty when both
stdin and stdout are terminals). A name that is not in the config is used as an ssh destination
as-is, so `fleet -H some-ssh-alias tmux list` works before `fleet init`.

On the remote, `fleet` is looked up as `hosts.<name>.fleetBin`, then `~/.local/bin/fleet` (where
`fleet install` puts it), then `PATH`. `--dir` / `-C` values under your `$HOME` are rewritten to
`~/…` so they mean the same place on the other machine; relative paths are refused.
`FLEET_CMD`, `FLEET_DEBUG` and `FLEET_DRY_RUN` are forwarded (exported, single-quoted, in the
remote `sh -c`); `FLEET_CONFIG` is not — the remote uses its own config.

## Claude sessions

`<target>` is a session's generated title, its Claude session name, a session-id prefix, or a pid.
Any unambiguous fragment works: matching tries exact → prefix → substring → characters-in-order and
the first rung with hits wins. Two hits on the same rung is an error that lists the candidates.

| command | does |
| --- | --- |
| `fleet` | `watch` on a terminal; a one-shot `list` when stdout is piped |
| `fleet list [--json] [-a, --all-hosts]` (alias `ls`) | live sessions: title, status, age, context usage (`ctx 62%`), terminal, cwd. `--json` is an array whose rows all carry `host`; `-a` queries every configured host in parallel |
| `fleet peek <target> [--lines N]` | what the session's terminal shows now (default 40 lines) |
| `fleet send <target> <text>` | type text into the session and press Enter |
| `fleet rename <target> <title> [--no-tmux-sync] [--force] [--json]` | rename the session's one title: Claude's `/rename` (the source of truth), then its tmux session follows as a slug of it (`Fix Login` → `fix-login`, `-2` on a collision) when the tmux session is that Claude session's own (one window, one pane). A session **waiting on a prompt** is held (exit 1; `--json`: exit 3) — typed keys would be its answer; busy sessions are fine (Claude runs `/rename` mid-turn without disturbing the turn). `--force` overrides the hold. `--json` prints `{ ok, result: renamed\|sent\|held, session_id, pid, host, from, title, held, tmux: { renamed, from, to, note }, message }` |
| `fleet name [<target> \| --all] [--apply] [--refresh] [--no-tmux-sync]` | suggest a name from what the session is doing; only `--apply` sends it (through the same path as `rename`, tmux included). `--all` = every session with a derived (cwd+hash) name. A derived-name session alone in a tmux session somebody named (`fleet new fix-login`) adopts that name (`(tmux)`, no model call) instead of getting a generated one. `--refresh` ignores the cache |
| `fleet group [-a, --all-hosts] [--json] [--apply] [--refresh] [--consolidate] [--input <file\|->] [--cached]` | sort sessions into work-stream groups (the web Board view) — see [Grouping](#grouping). Reads sessions and asks `claude -p`; never sends anything to a session |
| `fleet group --rename <group id> --label <l>` / `--move <host/id> (--to <group id> \| --label <l>)` | edit the stored groups by hand (the Board's rename / drag'n'drop) — see [Grouping](#grouping) |
| `fleet spawn [prompt] --dir <path> [--name <n>] [--model <id>] [--backend iterm\|tmux] [--tmux-session <s>] [--window]` | start a new Claude session in a new tab/pane. `--model <id>` runs `claude --model '<id>'` (letters, digits and `._[]-` only; blank = Claude's default). Default backend: tmux inside tmux, over ssh or off macOS; else iTerm. With tmux, each spawn gets its own tmux session (one session per job) named from `--name` or the dir's basename, sanitised like `fleet new`; a taken `--name` is an error, a taken basename is uniquified (`app-2`). `--tmux-session <s>` opens a window in `s` instead (created if missing) |
| `fleet spawn --from <target> [prompt] [--name <n>] [--model <id>] [--backend …]` | continue a session's work in a new one: same host (with `-H`, the host the session is on) and its cwd (`--dir` overrides), first prompt = its [brief](#briefs)'s continue prompt, then a blank line and `prompt`. The prompt goes through a file under `~/.claude/fleet-handoffs/`, like a handoff. Errors when the session has no brief yet. `-n` prints the launch command and the prompt and writes nothing |
| `fleet handoff [brief] [--file <f\|->] --dir <path> [--name <n>] [--model <id>] [--tmux-session <s>] [--tab] [--no-wait]` | start a new session in another window seeded with a brief (saved under `~/.claude/fleet-handoffs/`); waits until it registers. Same tmux placement as `spawn` |
| `fleet brief <target> [--json \| --prompt]` | print the session's [brief](#briefs) — its body (Summary / Resources / Todos, no frontmatter); `--json` the parsed shape; `--prompt` only the continue prompt |
| `fleet brief <target> --edit` / `--set [--expect-updated <iso>]` / `--regenerate` / `--open` | edit it in `$VISUAL`/`$EDITOR`; save markdown from stdin; ask the web server to regenerate it; open the session's checkout in VS Code — see [Briefs](#briefs) |
| `fleet watch [--interval 5] [--stuck 300] [--quiet] [--rows 1\|2\|auto] [--no-mouse]` | live dashboard + notifications on finished/stuck sessions |
| `fleet skill install [--force]\|show` | install / print the Claude Code skill (`~/.claude/skills/fleet/SKILL.md`; `--force` overwrites a different one) |

`send`, `rename --force`, `name --apply` and `spawn` change a live agent's state — scripts and agents
should confirm before running them.

### Briefs

A brief is a small markdown file per session — what it is doing, the resources it produced (PRs,
files, its git branch and checkout, artifacts, links) and its todos — kept by the web server on the host the session
lives on (`$FLEET_BRIEFS_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/fleet/briefs/<session_id>.md`;
format and merge rules in [architecture.md](architecture.md#session-briefs)). The CLI reads and
edits the same files; generating one (a `claude -p` call) is the web server's job.

`<target>` resolves like any other session target; a session that is gone still has its brief,
reachable by its **full** session id. With `-H <host>` every form runs on that host, where the file is.

| form | does |
| --- | --- |
| `fleet brief <target>` | the body as markdown (a skeleton, and a note on stderr, when there is none yet) |
| `--json` | `{ host, id, exists, markdown, body, parsed: { summary, resources: [{ kind, label, url, path, text, branch, linked }], todos: [{ done, text }], plan }, updated, editedAt, generatedAt, generatedThrough, continuePrompt, absCwd, gitRoot, path }` — the web API's GET shape (minus the server-only `generating` / `enabled` / `editor` / `editorUrl`), plus `body` (markdown without frontmatter) and `path`. `branch` / `linked` are set on the `Git` resource only; `absCwd` is the session's directory (absolute), `gitRoot` its checkout root (null outside git). `parsed.plan` is a **deprecated** alias of `parsed.todos` (same array; the section used to be `## Plan`), kept for one release |
| `--prompt` | only the continue prompt — the first prompt for a new session that picks the work up (`fleet spawn --from` uses it) |
| `--edit` | the body in `$VISUAL` / `$EDITOR` (default `vi`), saved as a human edit when changed. For a session on another host the brief is fetched over ssh (`fleet brief --json` there), edited here, and written back with `--set --expect-updated` |
| `--set` | the markdown on stdin, saved as a human edit — the same rules as the web UI's save (`PUT`): it is authoritative for the body, the stored frontmatter is kept (the machine keys stay the server's), resource lines it removes are added to `dismissed` so they are never re-added, `editedAt` is stamped. `--expect-updated <iso>` refuses (exit 3, nothing written) unless the stored `updated` still is that (`""` = no brief yet) — what `--edit` uses so a brief regenerated while you were editing isn't overwritten. `-n` prints the result instead of writing it |
| `--open` | open the session's git root (else its cwd) in VS Code: `code <path>`, or for a session on another host (`-H`) `code --remote ssh-remote+<its ssh dest> <path>` with the path from `fleet brief --json` there. `cursor` instead of `code` with `web.editor: "cursor"`. Needs the editor's command on `PATH`; `-n` prints the command |
| `--regenerate` | POST `/api/hosts/<self>/sessions/<id>/brief/regenerate` to this host's web server (`hosts.<self>.web`, else `http://127.0.0.1:<web.port>`) via `curl`; prints whether it started or was queued. The model call runs in the background — read the result with `fleet brief` a little later. At the server's hourly cap: exit 3 with the wait. Needs a live session and a running web server (`fleet web serve`) |

### Grouping

`fleet group` sorts the live sessions into a handful of work-stream groups (labels of 2–4 words,
an optional one-line description) with `claude -p --model <grouping.model>` (default `haiku`),
and keeps them stable across runs. State: `$FLEET_GROUPS_STATE`, else
`${XDG_STATE_HOME:-~/.local/state}/fleet/groups.json` on the machine that runs it.

- Sessions: this machine's by default; `-a` every configured host (over ssh); `--input <file|->`
  a `list --json` array or a `/api/fleet` body (what the web server pipes in — hosts with
  `ok: false` keep their assignments).
- Without `--apply` the result is printed and nothing is saved; `--apply` writes the state.
  `-n` builds the prompts and reports how many model calls a run would make, calling none.
- A run only calls the model for sessions it hasn't placed yet (new, renamed/retitled/moved, or
  parked in a fallback group while the model was down) — an unchanged fleet costs nothing. At
  most once an hour (`grouping.consolidateMinutes`), after changes, one consolidation call may
  merge ≤ 2 groups and rename ≤ 2. `--consolidate` forces it; `--refresh` starts from scratch.
- Model off (`grouping.enabled: false`), unavailable or unusable → sessions go to a group per
  repository (the cwd, worktree-aware), `source: "fallback"`.
- `--cached` prints the stored groups: no discovery, no model call.
- Hand edits (what the Board's rename and drag'n'drop run; they edit the state file, no discovery,
  no model call, then print like `--cached`; `-n` saves nothing):
  - `--rename <group id> --label <l>` — the label (one line, ≤ 48 characters, not another
    group's) is the user's from then on: consolidation never renames that group nor merges it
    away. A renamed repository group becomes `source: "manual"` and keeps its sessions when the
    model is back.
  - `--move <host/id> --to <group id>` — the session stays in that group for good (`manual`
    assignment: never reclassified, whatever changes about the session; its group is never
    merged away). `--label <l>` instead of `--to` moves it to a new group of that name
    (`source: "manual"`), or to the existing group that has it. A group left empty goes.

`--json` (stable contract):

```json
{ "version": 1, "applied": true, "updatedAt": 1790000000000,
  "lastRun": { "at": 0, "ms": 0, "mode": "noop|incremental|full|consolidate|fallback|dry-run", "ok": true,
               "modelCalls": 0, "classified": 0, "kept": 30, "pruned": 0, "created": 0, "merged": 0,
               "renamed": 0, "note": "…", "error": "…" },
  "groups": [ { "id": "g-1a2b3c4d", "label": "Fleet Board", "description": "…", "source": "llm",
                "members": [ { "host": "laptop", "id": "<session id>", "name": "board-view" } ] } ],
  "ungrouped": [ { "host": "laptop", "id": "…", "name": "…" } ],
  "hosts": { "laptop": "ok", "workstation": "unreachable: …" } }
```

Group ids never change once created (a merge keeps the target's id); empty groups are dropped.
`source` is `llm`, `fallback` or `manual` (made on the board).

### Dashboard keys (`watch`)

| key | does |
| --- | --- |
| `1`–`9`, `0` | jump to that row and focus it |
| Enter, space, `l`, `o` (and Ctrl-J) | focus the selected session's pane/tab |
| ↑/↓, `k`/`j`, scroll | move the selection |
| click / tap | select + focus (`--no-mouse` to disable) |
| `n` | rename the selected session |
| `N` | prefill the rename with the row's generated title |
| Ctrl-N | suggest names for every unnamed session |
| `r` | refresh now |
| `z` | compact one-line rows ⇄ full rows |
| `e` | toggle the events pane |
| `?` | help overlay |
| `q`, Esc, Ctrl-C | quit |

Run it in a tmux session named `fleet` and bind `prefix f` to `switch-client -t fleet` to jump back
after focusing a session (see [setup.md](setup.md#4-tmux)).

## tmux sessions

Manage tmux *sessions* (one per job) on the target host — `defaultHost` by default. `fleet tmux`
alone lists. Alias: `fleet t …`; `enter` (alias `e`), `last` and `new` also exist at the top level.

| command | does |
| --- | --- |
| `fleet tmux list [-q] [--json]` (alias `ls`) | sessions, most recently attached first (`-q`: names only) |
| `fleet tmux enter <query>` (alias `e`) | attach by exact > prefix > substring match (case-insensitive) |
| `fleet tmux last` | attach to the session you were in before the current one |
| `fleet tmux new [name] [-d] [-C <dir>] [-- cmd]` | attach to, or create, a session (default `main`). `-d` creates without attaching |
| `fleet tmux kill <query> [-f]` | kill a session (asks first; `-f` skips) |
| `fleet tmux rename <query> <name>` | rename a tmux session — when it hosts exactly one Claude session (one window, one pane), the rename goes through that session's title instead (`fleet rename`), so the two stay in sync |
| `fleet tmux stale [--kill] [--older-than 24h] [--no-fleet-check] [-f] [-q] [--json]` | idle shells nothing uses; lists only unless `--kill` |

Details:

- **`enter` looks on every host** when no host is named (no `-H`, no `FLEET_HOST`, no `--local`):
  the default host first; if nothing matches there (or it can't be reached), every other host with
  an `ssh` destination plus this machine, in parallel (web-only peers are skipped). Hits are ranked
  by the same tiers across hosts. One match → `→ laptop: <name>` on stderr, then it attaches there
  (`switch-client` inside tmux when it's this machine). Several → listed with their host, exit 2
  (pick one with `-H`). None → exit 3 naming the hosts searched. An unreachable host is a warning,
  not a failure, unless no host answered (exit 4). `kill` and `rename` don't fall back — they act on
  the target host only.
- **Names** are sanitized the same way by `new` and `rename`: anything outside `A-Za-z0-9_-`
  becomes `-`, runs collapse, leading/trailing `-` are dropped.
- One title per session (see [architecture → Session titles](architecture.md#session-titles)):
  `fleet rename` sets the Claude name and the tmux name follows. `tmux rename` of a single-Claude
  tmux session does the same (renames Claude, if it is waiting on a prompt only tmux is renamed,
  with a note); of any other tmux session it renames just the tmux session. A raw
  `tmux rename-session` is not watched — it sticks until the title next changes.
- **stale** = no Claude session in it, an idle shell with no background or suspended job, idle
  longer than `--older-than` (`30m`, `12h`, `7d`, or a number of hours; max `3650d`). Candidates
  are cross-checked against live Claude sessions (the same discovery as `fleet list`); if that
  check cannot be trusted (discovery fails, or a live session's handle matches no tmux pane),
  `--kill` refuses and `-q` prints nothing and exits non-zero.
  `--no-fleet-check` skips the cross-check but then confirms every kill individually (it cannot be
  combined with `-f`).

JSON shapes:

- `tmux list --json` — array of `{ name, attached, windows, last_attached, activity, created,
  current, host }` (times are Unix seconds; `current` = the session you are in).
- `tmux stale --json` — `{ candidates: [{ name, idle_secs, windows, command }], kept: [{ name,
  reason, class }], claude_checked, claude_problem }`; `class` is one of `here`, `attached`,
  `infra`, `claude`, `unknown`, `running`, `recent`.

## Hosts

| command | does |
| --- | --- |
| `fleet exec [-C <dir>] [-t] -- <cmd…>` | run a command on the host, outside tmux (cwd defaults to `$HOME`; `-t` allocates a tty) |
| `fleet ssh [cmd…]` | plain shell on the host, no tmux |
| `fleet doctor` | reachability, dispatch mode and why, tools and versions on both ends, config sanity |

## Setup

| command | does |
| --- | --- |
| `fleet init` | wizard: this machine's name, hosts (name, ssh target, web URL — can suggest from `tailscale status --json`), spawn dirs, web port. Never overwrites an existing config without confirmation (`--force`) |
| `fleet config path\|show\|get\|set\|edit` | where the config lives / print it (`--resolved` fills in defaults) / read or write one dotted key (`hosts.workstation.ssh`; values parse as JSON when they can) / open in `$VISUAL`/`$EDITOR` |
| `fleet install --host <name>` | copy this binary to `~/.local/bin/fleet` and the web app to `~/.local/share/fleet/web` on the host (rsync, or tar over ssh) — the host needs no Rust toolchain. Refuses when `uname -sm` differs between the machines unless `--force`; `--no-web` skips the web app. Of `web/ui` only the built `ui/dist` is copied (sources and `node_modules` never); when it is not built you get a warning (build with `fleet web build`) and the host serves only the API and a "not built" page |

Non-interactive `init` (scripts, tests):

```sh
fleet init --yes --self laptop \
  --add-host laptop,web=http://100.x.y.z:7777 \
  --add-host workstation,ssh=workstation,web=http://100.x.y.z:7777 \
  --default-host workstation \
  --spawn-dir Project=laptop:~/Code/project,workstation:~/Code/project \
  --web-port 7777 --web-bind 0.0.0.0
```

| flag | meaning |
| --- | --- |
| `-y, --yes` | take the flags (and defaults) as the answers, ask nothing |
| `--self <name>` | this machine's host name (default: the short hostname) |
| `--add-host NAME[,ssh=DEST][,web=URL]` | a host (repeatable); this machine needs no `ssh` |
| `--default-host <name>` | target for tmux-session commands |
| `--spawn-dir LABEL=HOST:PATH[,HOST:PATH…]` or `LABEL=PATH` | a spawn directory, per host or the same everywhere (repeatable) |
| `--web-port`, `--web-bind`, `--web-dir` | web server settings (`--web-dir` defaults to auto-detected) |
| `--force` | overwrite an existing config without asking |
| `--print` | print the config instead of writing it |

## Web

| command | does |
| --- | --- |
| `fleet web serve [--port N] [--bind ADDR] [--dir PATH]` | run `node <web.dir>/server.mjs` with this machine's config (needs Node ≥ 22) |
| `fleet web build [--dir PATH] [--install]` | build the React UI: `npm --prefix <web.dir>/ui ci` (when `node_modules` is missing, or `--install`) then `npm … run build` → `ui/dist`, which the server then serves by default. Needs a checkout (an installed web dir has only `ui/dist`) |
| `fleet web install-service` | macOS: write and load a launchd agent that keeps `fleet web serve` running (`--uninstall`, `--no-load`, `--print`); logs to `~/Library/Logs/fleet.web.log`, runs as `ProcessType=Interactive` so macOS does not throttle it like a background job (that made `fleet list` take 10s+ under Low Power Mode); elsewhere: print a systemd user unit. The agent pins one node (config `web.node`, else `/opt/homebrew/bin/node` or `/usr/local/bin/node`, else `PATH`) and leaves version-manager dirs (nvm/volta/fnm) out of its `PATH`; if the only node is version-managed it is used with a warning |

## Environment

| variable | meaning |
| --- | --- |
| `FLEET_CONFIG` | config file path (default `${XDG_CONFIG_HOME:-~/.config}/fleet/config.json`) |
| `FLEET_HOST` | default target host (same as `-H`) |
| `FLEET_DRY_RUN=1` | print what would run, run nothing |
| `FLEET_DEBUG=1` | trace what runs, on stderr |
| `FLEET_CONNECT_TIMEOUT` | ssh connect timeout in seconds (default 5) |
| `FLEET_REMOTE_TIMEOUT` | limit for one captured remote call, e.g. a host in `list --all-hosts` (default 15 s) |
| `FLEET_MUX=0` | disable ssh connection multiplexing (control socket `~/.ssh/fleet-mux-%C`) |
| `FLEET_TMUX` | tmux binary (over config `tmux`) |
| `FLEET_CMD` | command that launches Claude in spawned sessions (over config `claude`; default `claude`) |
| `FLEET_BIN` | `fleet` binary the web server calls |
| `FLEET_NODE` | `node` binary for `fleet web serve` (over config `web.node`; set by the launchd agent) |
| `FLEET_WEB_PORT`, `FLEET_WEB_BIND`, `FLEET_WEB_UI` | web server listen address / UI directory (over config `web.*`) |
| `FLEET_BRIEFS_DIR` | where [briefs](#briefs) live (default `${XDG_STATE_HOME:-~/.local/state}/fleet/briefs`); shared with the web server |
| `VISUAL`, `EDITOR` | the editor for `fleet brief --edit` and `fleet config edit` (default `vi`) |
| `FLEET_GROUPS_STATE` | `fleet group` state file (default `${XDG_STATE_HOME:-~/.local/state}/fleet/groups.json`) |
| `FLEET_FIXTURE=<sessions.json>` | read a canned fleet from a file instead of the live registry (demo/tests; backends are inert) |
| `NO_COLOR=1` | no colors |

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success |
| 1 | error, bad usage |
| 2 | tmux commands: ambiguous match (candidates are printed) |
| 3 | `rename --json`: held; `brief --set`/`--edit`: the brief changed since it was opened (nothing saved); `brief --regenerate`: hourly cap reached; tmux commands: nothing to act on — no sessions, no match, or a confirmation was needed but there is no terminal (use `-f`) |
| 4 | host unreachable |
| 127 | a required tool (tmux, node) was not found |

`exec` and `ssh` return the remote command's own exit code.
