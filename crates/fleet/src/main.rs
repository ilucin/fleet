use std::io::IsTerminal;

use clap::{Parser, Subcommand};
use colored::Colorize;

use fleet::cli::{
    commands, config_cmd, group, hosts as host_cmds, init, skill, tmux as tmux_cmds, web,
};
use fleet::core::config;
use fleet::core::discovery::Backend;
use fleet::core::hosts::{self, Scope, Target};
use fleet::error::{Error, Result};
use fleet::tui::watch;

#[derive(Parser)]
#[command(
    name = "fleet",
    version,
    about = "See, steer and spawn Claude Code sessions and tmux sessions — on this machine or any host you can ssh to",
    after_help = "Bare `fleet` opens the dashboard on a terminal (a one-shot `list` when piped).\n\
Host: -H <name> runs the command on that host over ssh (it needs fleet installed there).\n\
tmux-session and machine commands (tmux, enter, last, new, exec, ssh) default to `defaultHost`; everything else to this machine.\n\
Env: FLEET_CONFIG FLEET_HOST FLEET_DRY_RUN FLEET_DEBUG FLEET_CONNECT_TIMEOUT FLEET_MUX FLEET_REMOTE_TIMEOUT FLEET_CMD FLEET_TMUX NO_COLOR"
)]
struct Cli {
    /// Target host (a configured name, or any ssh destination); env FLEET_HOST
    #[arg(short = 'H', long, global = true, value_name = "NAME")]
    host: Option<String>,

    /// Run on this machine, never over ssh
    #[arg(long, global = true)]
    local: bool,

    /// Print what would run, run nothing
    #[arg(short = 'n', long, global = true)]
    dry_run: bool,

    /// The name the caller knows this machine by (set by remote dispatch)
    #[arg(long, global = true, hide = true, value_name = "NAME")]
    as_host: Option<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

/// Shared by the `watch` flags and the bare-`fleet` default, so they can't drift.
const DEFAULT_INTERVAL: u64 = 5;
const DEFAULT_STUCK: i64 = 300;

/// `--rows`: how tall one session's item is.
#[derive(Clone, Copy, clap::ValueEnum)]
enum RowsArg {
    #[value(name = "1", alias = "compact")]
    One,
    #[value(name = "2", alias = "full")]
    Two,
    Auto,
}

impl From<RowsArg> for Option<bool> {
    fn from(r: RowsArg) -> Self {
        match r {
            RowsArg::One => Some(false),
            RowsArg::Two => Some(true),
            RowsArg::Auto => None,
        }
    }
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum BackendArg {
    Iterm,
    Tmux,
}

impl From<BackendArg> for Backend {
    fn from(b: BackendArg) -> Self {
        match b {
            BackendArg::Iterm => Backend::Iterm,
            BackendArg::Tmux => Backend::Tmux,
        }
    }
}

#[derive(Subcommand)]
enum Commands {
    /// List the live Claude sessions
    #[command(visible_alias = "ls")]
    List {
        /// Machine-readable output (a JSON array; every row carries `host`)
        #[arg(long)]
        json: bool,
        /// Every configured host, in parallel
        #[arg(long, short = 'a')]
        all_hosts: bool,
    },

    /// Read what a session is currently showing
    Peek {
        /// generated title, session name (e.g. app-f9), sessionId prefix, or pid
        target: String,
        /// How many trailing lines to show
        #[arg(long, default_value_t = 40)]
        lines: usize,
    },

    /// Type text into a session and submit it
    Send {
        /// sessionId prefix, derived name, or pid
        target: String,
        /// The message to send
        text: String,
    },

    /// Rename a Claude session (drives Claude's own /rename)
    Rename {
        /// sessionId prefix, derived name, or pid
        target: String,
        /// The new display name
        name: String,
        /// Leave the session's tmux session name alone
        #[arg(long)]
        no_tmux_sync: bool,
        /// Rename even a busy session (types into its live turn — be sure)
        #[arg(long)]
        force: bool,
    },

    /// Suggest a name for a session from what it is actually working on
    Name {
        /// sessionId prefix, derived name, or pid (omit with --all)
        target: Option<String>,
        /// Every session still carrying Claude's cwd+hash name
        #[arg(long)]
        all: bool,
        /// Send the suggestion as /rename instead of only printing it
        /// (the default is to print what would be renamed; -n/--dry-run says so explicitly)
        #[arg(long)]
        apply: bool,
        /// Leave the session's tmux session name alone
        #[arg(long)]
        no_tmux_sync: bool,
        /// Ignore the cached name and generate (and store) a fresh one
        #[arg(long, alias = "no-cache")]
        refresh: bool,
    },

    /// Sort sessions into work-stream groups (the web Board view) — reads sessions, asks `claude -p`, sends nothing
    Group {
        /// Every configured host, in parallel
        #[arg(long, short = 'a')]
        all_hosts: bool,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
        /// Save the result to the state file (without it: print only)
        #[arg(long)]
        apply: bool,
        /// Forget all groups and regroup every session from scratch
        #[arg(long)]
        refresh: bool,
        /// Run the merge/rename consolidation pass now, even if not due
        #[arg(long)]
        consolidate: bool,
        /// Print the stored groups; no discovery, no model call
        #[arg(long, conflicts_with_all = ["apply", "refresh", "consolidate", "all_hosts", "input"])]
        cached: bool,
        /// Read sessions from a file ("-" = stdin): a `list --json` array or a `/api/fleet` body
        #[arg(long, value_name = "FILE", conflicts_with = "all_hosts")]
        input: Option<String>,
    },

    /// Spawn a new Claude session in a fresh tab/pane
    Spawn {
        /// Initial prompt (optional)
        prompt: Option<String>,
        /// Working directory (defaults to the current directory)
        #[arg(long)]
        dir: Option<String>,
        /// Backend to spawn into (default: tmux inside tmux, over ssh or off macOS; else iterm)
        #[arg(long, value_enum)]
        backend: Option<BackendArg>,
        /// Display name for the new session (as shown by `list`/`watch`)
        #[arg(long)]
        name: Option<String>,
        /// Open a window in this tmux session instead of a new session per job (tmux only)
        #[arg(long)]
        tmux_session: Option<String>,
        /// Open a new window instead of a tab (iterm backend only)
        #[arg(long)]
        window: bool,
    },

    /// Hand the current work off to a fresh session in another window
    Handoff {
        /// The brief for the new session (or use --file / stdin)
        brief: Option<String>,
        /// Read the brief from a file ("-" for stdin)
        #[arg(long)]
        file: Option<String>,
        /// Working directory for the new session (defaults to the current directory)
        #[arg(long)]
        dir: Option<String>,
        /// Backend to hand off into (same default as spawn)
        #[arg(long, value_enum)]
        backend: Option<BackendArg>,
        /// Display name for the new session (as shown by `list`/`watch`)
        #[arg(long)]
        name: Option<String>,
        /// Open a window in this tmux session instead of a new session per job (tmux only)
        #[arg(long)]
        tmux_session: Option<String>,
        /// Open a tab instead of a new window (iterm backend only)
        #[arg(long)]
        tab: bool,
        /// Return immediately instead of waiting for the new session to register
        #[arg(long)]
        no_wait: bool,
    },

    /// Live dashboard + macOS notifications on finished/stuck sessions (default)
    Watch {
        /// Poll interval in seconds
        #[arg(long, default_value_t = DEFAULT_INTERVAL)]
        interval: u64,
        /// Seconds a session must sit idle-on-a-prompt before it counts as stuck
        #[arg(long, default_value_t = DEFAULT_STUCK)]
        stuck: i64,
        /// Notifications only, no TUI (backgroundable)
        #[arg(long)]
        quiet: bool,
        /// Item height: 2/full (default; 3 lines on a phone), 1/compact, or auto (`z` persists it)
        #[arg(long, value_enum)]
        rows: Option<RowsArg>,
        /// Capture mouse/tap input in the TUI (default; a tap selects and focuses)
        #[arg(long)]
        mouse: bool,
        /// Leave the mouse to the terminal, so selection and copy behave normally
        #[arg(long, conflicts_with = "mouse")]
        no_mouse: bool,
    },

    /// tmux sessions: list, enter, last, new, kill, rename, stale (default: list)
    #[command(visible_alias = "t")]
    Tmux {
        #[command(subcommand)]
        cmd: Option<TmuxCmd>,
    },

    /// Attach to a tmux session by exact > prefix > substring match (= tmux enter)
    #[command(visible_alias = "e")]
    Enter {
        /// Session name or fragment (case-insensitive)
        query: String,
    },

    /// Attach to the tmux session you were in before this one (= tmux last)
    Last,

    /// Attach to, or create, a tmux session (= tmux new)
    New(NewArgs),

    /// Run a command on a host — default: defaultHost (exit code passes through)
    Exec {
        /// Working directory (absolute or ~/…; default ~)
        #[arg(short = 'C', long)]
        dir: Option<String>,
        /// Give the command a terminal
        #[arg(short = 't', long)]
        tty: bool,
        /// The command and its arguments (after --)
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        argv: Vec<String>,
    },

    /// A plain login shell on a host — default: defaultHost (or one command), no tmux
    Ssh {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        argv: Vec<String>,
    },

    /// Reachability, tools and versions on this machine and every host, config sanity
    Doctor,

    /// Write this machine's config (interactive, or --yes with flags)
    Init(init::InitArgs),

    /// Read or change the config
    Config {
        #[command(subcommand)]
        action: config_cmd::ConfigAction,
    },

    /// Copy this binary (and the web app) to a remote host's ~/.local
    Install {
        /// Skip the web app
        #[arg(long)]
        no_web: bool,
        /// Install even when the remote OS/CPU differs
        #[arg(long)]
        force: bool,
    },

    /// The web UI: serve it, or install it as a login service
    Web {
        #[command(subcommand)]
        action: WebCmd,
    },

    /// Manage the Claude Code skill file
    Skill {
        #[command(subcommand)]
        action: skill::SkillAction,
    },

    /// Machine facts as JSON, for `doctor` (internal)
    #[command(name = "_probe", hide = true)]
    Probe,
}

#[derive(clap::Args, Clone)]
struct NewArgs {
    /// Session name (default: main); sanitised to [A-Za-z0-9_-]
    name: Option<String>,
    /// Create it and stay where you are
    #[arg(short = 'd', long)]
    detach: bool,
    /// Start it in this directory (absolute or ~/… for another host)
    #[arg(short = 'C', long)]
    dir: Option<String>,
    /// Command to run in the new session (after --)
    #[arg(last = true)]
    cmd: Vec<String>,
}

#[derive(Subcommand, Clone)]
enum TmuxCmd {
    /// Sessions, most recently attached first
    #[command(visible_alias = "ls")]
    List {
        /// Names only
        #[arg(short, long)]
        quiet: bool,
        /// JSON array of sessions
        #[arg(long)]
        json: bool,
    },
    /// Attach by exact > prefix > substring match (case-insensitive)
    #[command(visible_alias = "e")]
    Enter { query: String },
    /// Attach to the session you were in before this one
    Last,
    /// Attach to, or create, a session
    New(NewArgs),
    /// Kill a session (asks first)
    Kill {
        query: String,
        /// Don't ask
        #[arg(short, long)]
        force: bool,
    },
    /// Rename a tmux session (a Claude session's own name: `fleet rename`)
    Rename { query: String, new_name: String },
    /// Idle shells nothing is using (lists only, without --kill)
    Stale {
        /// Kill the candidates (each confirmed, unless -f)
        #[arg(long)]
        kill: bool,
        /// Kill without asking per session
        #[arg(short, long)]
        force: bool,
        /// Candidate names only
        #[arg(short, long)]
        quiet: bool,
        /// The report as JSON
        #[arg(long)]
        json: bool,
        /// Skip the live-Claude cross-check
        #[arg(long)]
        no_fleet_check: bool,
        /// Idle threshold: 30m, 12h, 7d, or hours
        #[arg(long, default_value = "24h")]
        older_than: String,
    },
}

#[derive(Subcommand, Clone)]
enum WebCmd {
    /// Run the web server here (node <web.dir>/server.mjs, with this config)
    Serve {
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        bind: Option<String>,
        /// Web app directory (default: config web.dir, else auto-detected)
        #[arg(long)]
        dir: Option<String>,
    },
    /// Build the React UI (<web.dir>/ui → ui/dist): npm ci when needed, then npm run build
    Build {
        /// Web app directory (default: config web.dir, else auto-detected)
        #[arg(long)]
        dir: Option<String>,
        /// Reinstall dependencies (npm ci) even if node_modules exists
        #[arg(long)]
        install: bool,
    },
    /// Keep `fleet web serve` running at login (launchd; prints a systemd unit elsewhere)
    InstallService {
        /// Remove the service instead
        #[arg(long)]
        uninstall: bool,
        /// Write the file but don't load/unload it
        #[arg(long)]
        no_load: bool,
        /// Only print the service definition
        #[arg(long)]
        print: bool,
    },
}

/// Bare `fleet` opens the dashboard for a human at a terminal, but stays a
/// one-shot `list` when stdout is piped — scripts and agents read that output.
fn default_command() -> Commands {
    if std::io::stdout().is_terminal() {
        Commands::Watch {
            interval: DEFAULT_INTERVAL,
            stuck: DEFAULT_STUCK,
            quiet: false,
            rows: None,
            mouse: false,
            no_mouse: false,
        }
    } else {
        Commands::List {
            json: false,
            all_hosts: false,
        }
    }
}

/// How a command relates to hosts.
enum Placement {
    /// Re-run on the target host when it isn't this machine.
    Dispatch(Scope),
    /// Handles `--host` itself (or ignores it).
    Here,
}

fn placement(c: &Commands) -> Placement {
    match c {
        Commands::Tmux { .. } | Commands::Enter { .. } | Commands::Last | Commands::New(_) => {
            Placement::Dispatch(Scope::DefaultHost)
        }
        Commands::List {
            all_hosts: true, ..
        }
        | Commands::Doctor
        | Commands::Install { .. }
        | Commands::Exec { .. }
        | Commands::Ssh { .. }
        | Commands::Probe => Placement::Here,
        _ => Placement::Dispatch(Scope::SelfHost),
    }
}

fn target(cli_host: Option<&str>, local: bool, scope: Scope) -> Result<Target> {
    let env_host = std::env::var("FLEET_HOST")
        .ok()
        .filter(|h| !h.trim().is_empty());
    let requested = cli_host.map(str::to_string).or(env_host);
    hosts::resolve(config::get(), requested.as_deref(), local, scope)
}

fn run(cli: Cli) -> Result<i32> {
    if cli.dry_run {
        hosts::set_dry_run();
    }
    if let Some(h) = &cli.as_host {
        hosts::set_as_host(h);
    }
    let command = cli.command.unwrap_or_else(default_command);

    if let Placement::Dispatch(scope) = placement(&command) {
        let t = target(cli.host.as_deref(), cli.local, scope)?;
        hosts::debug(&format!("target: {t:?}"));
        if let Target::Remote(r) = t {
            let raw: Vec<String> = std::env::args().skip(1).collect();
            let args = hosts::remap_dir_args(&hosts::strip_host_flags(&raw))?;
            return hosts::run_remote(&r, &args, false);
        }
    }

    match command {
        Commands::List { json, all_hosts } => {
            if all_hosts {
                host_cmds::list_all_hosts(json)?;
            } else {
                commands::list(json)?;
            }
        }
        Commands::Peek { target, lines } => commands::peek(&target, lines)?,
        Commands::Send { target, text } => commands::send(&target, &text)?,
        Commands::Rename {
            target,
            name,
            no_tmux_sync,
            force,
        } => commands::rename(&target, &name, no_tmux_sync, force)?,
        Commands::Name {
            target,
            all,
            apply,
            no_tmux_sync,
            refresh,
        } => commands::name(
            target,
            commands::NameOpts {
                all,
                apply,
                dry_run: cli.dry_run,
                no_tmux_sync,
                refresh,
            },
        )?,
        Commands::Group {
            all_hosts,
            json,
            apply,
            refresh,
            consolidate,
            cached,
            input,
        } => group::run(group::GroupOpts {
            all_hosts,
            json,
            apply,
            refresh,
            consolidate,
            cached,
            input,
            dry_run: cli.dry_run,
        })?,
        Commands::Spawn {
            prompt,
            dir,
            backend,
            name,
            tmux_session,
            window,
        } => commands::spawn(
            prompt,
            commands::SpawnOpts {
                dir,
                backend: backend.map(Into::into),
                name,
                tmux_session,
                window,
            },
        )?,
        Commands::Handoff {
            brief,
            file,
            dir,
            backend,
            name,
            tmux_session,
            tab,
            no_wait,
        } => commands::handoff(
            brief,
            file,
            commands::SpawnOpts {
                dir,
                backend: backend.map(Into::into),
                name,
                tmux_session,
                // A handoff means "over there, out of my way" — a window unless told otherwise.
                window: !tab,
            },
            !no_wait,
        )?,
        Commands::Watch {
            interval,
            stuck,
            quiet,
            rows,
            mouse,
            no_mouse,
        } => watch::run(watch::WatchOpts {
            interval_secs: interval,
            stuck_secs: stuck,
            quiet,
            rows: rows.map(Into::into),
            // Neither flag given means "whatever the config says".
            mouse: if no_mouse {
                Some(false)
            } else if mouse {
                Some(true)
            } else {
                None
            },
        })?,
        Commands::Tmux { cmd } => match cmd.unwrap_or(TmuxCmd::List {
            quiet: false,
            json: false,
        }) {
            TmuxCmd::List { quiet, json } => tmux_cmds::list(quiet, json)?,
            TmuxCmd::Enter { query } => tmux_cmds::enter(&query)?,
            TmuxCmd::Last => tmux_cmds::last()?,
            TmuxCmd::New(a) => {
                tmux_cmds::new(a.name.as_deref(), a.detach, a.dir.as_deref(), &a.cmd)?
            }
            TmuxCmd::Kill { query, force } => tmux_cmds::kill(&query, force)?,
            TmuxCmd::Rename { query, new_name } => tmux_cmds::rename(&query, &new_name)?,
            TmuxCmd::Stale {
                kill,
                force,
                quiet,
                json,
                no_fleet_check,
                older_than,
            } => tmux_cmds::stale(tmux_cmds::StaleOpts {
                kill,
                force,
                quiet,
                json,
                claude_check: !no_fleet_check,
                older_than,
            })?,
        },
        Commands::Enter { query } => tmux_cmds::enter(&query)?,
        Commands::Last => tmux_cmds::last()?,
        Commands::New(a) => tmux_cmds::new(a.name.as_deref(), a.detach, a.dir.as_deref(), &a.cmd)?,
        Commands::Exec { dir, tty, argv } => {
            let t = target(cli.host.as_deref(), cli.local, Scope::DefaultHost)?;
            return host_cmds::exec(&t, dir.as_deref(), tty, &argv);
        }
        Commands::Ssh { argv } => {
            let t = target(cli.host.as_deref(), cli.local, Scope::DefaultHost)?;
            return host_cmds::ssh(&t, &argv);
        }
        Commands::Doctor => {
            let only = cli.host.clone().or_else(|| {
                std::env::var("FLEET_HOST")
                    .ok()
                    .filter(|h| !h.trim().is_empty())
            });
            host_cmds::doctor(only.as_deref())?
        }
        Commands::Init(a) => init::run(a)?,
        Commands::Config { action } => config_cmd::run(&action)?,
        Commands::Install { no_web, force } => {
            if cli.host.is_none() && std::env::var("FLEET_HOST").is_err() {
                return Err(Error::exit(1, "usage: fleet install --host <name>"));
            }
            let t = target(cli.host.as_deref(), false, Scope::SelfHost)?;
            host_cmds::install(
                &t,
                host_cmds::InstallOpts {
                    web: !no_web,
                    force,
                },
            )?
        }
        Commands::Web { action } => match action {
            WebCmd::Serve { port, bind, dir } => web::serve(web::ServeOpts { port, bind, dir })?,
            WebCmd::Build { dir, install } => web::build(web::BuildOpts { dir, install })?,
            WebCmd::InstallService {
                uninstall,
                no_load,
                print,
            } => web::install_service(web::ServiceOpts {
                uninstall,
                no_load,
                print,
            })?,
        },
        Commands::Skill { action } => skill::run(&action)?,
        Commands::Probe => host_cmds::probe()?,
    }
    Ok(0)
}

fn main() {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            let msg = e.to_string();
            if !msg.is_empty() {
                eprintln!("{} {msg}", "Error:".red().bold());
            }
            std::process::exit(e.code());
        }
    }
}
