# fleet — contributor & agent guide

Supervise Claude Code sessions across machines: a Rust CLI (`fleet`) and a zero-dependency Node web
app. Read [README.md](README.md) and [docs/architecture.md](docs/architecture.md) first.

## Layout

```
Cargo.toml             workspace
crates/fleet/          the `fleet` binary + library
  src/core/            discovery, backends (tmux/iTerm), naming, tmux sessions, hosts/config — no printing
  src/cli/             argument handling and text/JSON rendering
  src/tui/             the `watch` dashboard (ratatui)
  SKILL.md             Claude Code skill installed by `fleet skill install`
  tests/               integration tests
web/                   web server (server.mjs, lib/) + PWA (public/), Node >= 22, no npm deps
docs/                  setup, architecture, CLI reference, migration
```

Keep logic in `core`; the CLI, the TUI and any future UI (a second web UI, another TUI) are views
on it.

## Build & test

macOS: needs the Xcode Command Line Tools. If linking fails with an Xcode license error, prefix
cargo with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` (or accept the license).

```sh
cargo build                       # from the repo root
cargo test                        # Rust unit + integration tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo run -q -p fleet -- --help   # run the CLI from source

cd web && node --test tests/      # web tests (no network, child processes mocked)
cd web && node server.mjs         # run the web server against your local config
```

Tests use temp dirs and fixtures (`FLEET_CONFIG`, `FLEET_FIXTURE`, `HOME` pointing into a tempdir) —
never a real home directory, real config or live sessions.

## Rules

- **Privacy: this repo is public.** Never commit personal config, IP addresses (including
  Tailscale `100.x.y.z` addresses), hostnames, usernames, home paths (`/Users/<name>/…`), emails,
  ssh key names or tailnet names — not in code, tests, fixtures, docs or commit messages. Use
  placeholders: hosts `laptop` / `workstation`, `100.x.y.z`, `~/Code/project`, `$HOME`. Real values
  live only in the user's `~/.config/fleet/config.json`, which is never committed (`config.json` is
  gitignored).
- **JSON contracts are stable APIs**: `fleet list --json`, every other `--json` output, the config
  file shape and the web HTTP API. Adding fields is fine; renaming, removing or retyping one is a
  breaking change — bump the version and document it in `docs/`.
- **The config file is shared**: the CLI owns it, the web server only reads it. Preserve unknown
  keys on rewrite; a missing config must keep single-host local use working.
- **Commands that type into live agents** (`send`, `rename`, `name --apply`, `spawn`, `handoff`,
  web `send`/`keys`/`spawn`) must never resolve an ambiguous target — error with candidates.
- **Mutating tests against real tmux** use throwaway sessions named `fleet-test-*` and clean them
  up; never touch sessions you did not create.
- `web/` stays dependency-free (`node:` built-ins only) and build-free.
- Update `docs/cli.md` when you change a command or flag, and `docs/architecture.md` when you
  change a contract.
