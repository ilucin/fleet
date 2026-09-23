# Migrating from tb-fleet, ws or fleet-web

`fleet` replaces three tools:

- **tb-fleet** — the Rust CLI that sees and steers Claude sessions on one machine;
- **ws** — a shell script that managed tmux sessions on a remote workstation over ssh;
- **fleet-web** — the Node web app that showed the fleet on a phone.

Behavior and JSON output are kept; names, config and env vars changed.

## Steps

1. Install `fleet` on every machine (`cargo install --path crates/fleet` on one,
   `fleet install --host <name>` for the others).
2. Run `fleet init` on each machine. It replaces the old per-tool config (fleet-web's
   `config.json` next to `server.mjs`, ws's host variable and machine detection).
3. Replace scripts and aliases using the tables below; rename `WS_*` / `TB_FLEET_*` env vars.
4. Install the new skill and remove the old one: `fleet skill install`, then delete
   `~/.claude/skills/tb-fleet`.
5. Stop the old web server and start `fleet web serve` (or `fleet web install-service`).
6. Update tmux bindings that run `tb-fleet` (e.g. a `fleet` session running `tb-fleet watch`
   now runs `fleet watch`).
7. Remove the old binaries (`tb-fleet`, `ws`) and any shell function or alias named `ws` — an old
   shell function shadows a binary on `PATH` (check with `type ws`).

## tb-fleet → fleet

The session commands are identical; only the binary name changes. They now also accept `-H <host>`.

| tb-fleet | fleet |
| --- | --- |
| `tb-fleet` / `tb-fleet watch` | `fleet` / `fleet watch` |
| `tb-fleet list [--json]` | `fleet list [--json]` (+ `-a/--all-hosts`; rows now carry `host`) |
| `tb-fleet peek <t>` | `fleet peek <t>` |
| `tb-fleet send <t> <text>` | `fleet send <t> <text>` |
| `tb-fleet rename <t> <name>` | `fleet rename <t> <name>` |
| `tb-fleet name …` | `fleet name …` |
| `tb-fleet spawn …` | `fleet spawn …` |
| `tb-fleet handoff …` | `fleet handoff …` |
| `tb-fleet skill install` | `fleet skill install` |
| `TB_FLEET_FIXTURE` | `FLEET_FIXTURE` |

The `list --json` schema is unchanged except for the added `host` field. The naming cache (`~/.claude/fleet-names.json`) and handoff
briefs (`~/.claude/fleet-handoffs/`) keep their locations. Settings from tb-fleet's `config.toml` move into
`config.json` by hand: `[ui]` → `tui` (`rows`, `mouse`), `[naming]` → `naming` (`enabled`, `model`,
`syncTmux`, `autoTitle`), and `command` → `claude`. For example
`fleet config set naming.model haiku`.

Dropped: the toolbox version/update check.

## ws → fleet

`ws` ran commands on the workstation over ssh, or locally when run on it. `fleet` does the same
through the host model: tmux-session commands target `defaultHost` unless you pass `-H` or
`--local`, and "which machine am I" comes from `self` in the config instead of hostname or a
machine file.

| ws | fleet |
| --- | --- |
| `ws` / `ws list [-q]` | `fleet tmux` / `fleet tmux list [-q]` (alias `fleet t`) |
| `ws enter <query>` | `fleet enter <query>` |
| `ws last` | `fleet last` |
| `ws new [name] [-d] [-C dir] [-- cmd]` | `fleet new [name] [-d] [-C dir] [-- cmd]` |
| `ws kill <query> [-f]` | `fleet tmux kill <query> [-f]` |
| `ws rename <query> <name>` | `fleet tmux rename <query> <name>` |
| `ws stale [--kill] …` | `fleet tmux stale [--kill] …` |
| `ws f` / `ws fleet` | `fleet -H workstation list` |
| `ws f watch` | `fleet -H workstation watch` |
| `ws f <args…>` | `fleet -H workstation <args…>` |
| `ws f spawn …` (implied `--backend tmux`) | `fleet -H workstation spawn …` (tmux is the default over ssh) |
| `ws exec [-C dir] [-t] -- cmd` | `fleet exec [-C dir] [-t] -- cmd` |
| `ws ssh [cmd]` | `fleet ssh [cmd]` |
| `ws doctor` | `fleet doctor` |
| `ws --host <alias>` | `fleet -H <name>` (a config host name; its `ssh` field holds the alias) |
| `ws --local` / `--remote` | `fleet --local` / `fleet -H <name>` |
| `ws -n` | `fleet -n` / `FLEET_DRY_RUN=1` |

Note that `fleet rename` is the *Claude* rename (formerly `ws f rename`); the tmux rename is
`fleet tmux rename`.

### Environment variables

| old | new |
| --- | --- |
| `WS_HOST` | `FLEET_HOST` (a config host name, not an ssh alias) |
| `WS_LOCAL=1` | `--local` |
| `WS_DRY_RUN=1` | `FLEET_DRY_RUN=1` |
| `WS_DEBUG=1` | `FLEET_DEBUG=1` |
| `WS_CONNECT_TIMEOUT` | `FLEET_CONNECT_TIMEOUT` |
| `WS_MUX=0` | `FLEET_MUX=0` |
| `WS_FLEET_TIMEOUT` | dropped — the stale cross-check is in-process now (`FLEET_REMOTE_TIMEOUT` bounds remote calls) |
| `TB_FLEET_FIXTURE` | `FLEET_FIXTURE` |
| tb-fleet `command` config / wrapper | `FLEET_CMD` or config `claude` |
| `NO_COLOR` | `NO_COLOR` |

## fleet-web → fleet web

The server and UI moved into `web/` and are started by the CLI.

| fleet-web | fleet |
| --- | --- |
| `node server.mjs` / `bin/dev.sh` | `fleet web serve` |
| its tmux / launchd start scripts | `fleet web install-service`, or a tmux session running `fleet web serve` |
| its deploy-to-workstation script | `fleet install --host workstation` |
| `config.json` next to `server.mjs` | `~/.config/fleet/config.json` (shared with the CLI) |
| `self` | `self` |
| `port`, `bind` | `web.port`, `web.bind` |
| `peers: { name: url }` | `hosts.<name>.web` |
| `tbFleet` | `fleetBin` (optional; `fleet` is found on `PATH`) |
| `tmux` | `tmux` |
| quick-reply chips (hard-coded) | `web.quickReplies` |
| `autoName: { enabled, intervalMinutes }` | `web.autoName: { enabled, intervalMinutes }` (runs `fleet name --all --apply`) |
| `spawnDirs: [{ label, path }]` | `spawnDirs: [{ label, paths: { <host>: dir } }]` — one list for all hosts |
| `FLEET_WEB_CONFIG` | `FLEET_CONFIG` |
| `PORT` | `FLEET_WEB_PORT` (`PORT` still works) |

The HTTP API is unchanged; session objects are `fleet list --json` objects plus `host`.
