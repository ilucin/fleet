use std::io::IsTerminal;

use clap::{Parser, Subcommand};
use colored::Colorize;

use fleet::cli::{
    brief as brief_cmd, commands, config_cmd, group, hosts as host_cmds, init, skill,
    stack as stack_cmds, tmux as tmux_cmds, web,
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

    /// Rename a session: Claude's own /rename (the title), then its tmux session follows
    Rename {
        /// sessionId prefix, derived name, or pid
        target: String,
        /// The new display name
        name: String,
        /// Leave the session's tmux session name alone
        #[arg(long)]
        no_tmux_sync: bool,
        /// Rename even a session waiting on a prompt (the keys land in the prompt — be sure)
        #[arg(long)]
        force: bool,
        /// Print one JSON object (result renamed/sent/held, tmux sync); held exits 3
        #[arg(long)]
        json: bool,
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
        /// Rename a stored group (by id) to --label; the model never renames it again
        #[arg(long, value_name = "GROUP_ID", requires = "label", conflicts_with_all = ["apply", "refresh", "consolidate", "all_hosts", "input", "cached", "move_session"])]
        rename: Option<String>,
        /// Move a session (`host/sessionId`) to --to <group id>, or to a new group named --label; it stays there
        #[arg(long = "move", value_name = "HOST/ID", conflicts_with_all = ["apply", "refresh", "consolidate", "all_hosts", "input", "cached"])]
        move_session: Option<String>,
        /// With --move: the target group's id
        #[arg(
            long,
            value_name = "GROUP_ID",
            requires = "move_session",
            conflicts_with = "label"
        )]
        to: Option<String>,
        /// With --rename: the new label; with --move: the label of a new group (reused when one has it)
        #[arg(long)]
        label: Option<String>,
    },

    /// A session's brief: what it is doing, what it produced, its todos (read, edit, regenerate, open)
    Brief {
        /// generated title, session name, sessionId prefix, or pid — or the full id of a gone
        /// session whose brief is still there
        target: String,
        /// The parsed brief as JSON (the web API's shape, plus `body` and `path`)
        #[arg(long, conflicts_with = "prompt")]
        json: bool,
        /// Only the prompt that continues this session's work in a new one (for piping)
        #[arg(long)]
        prompt: bool,
        /// Edit the body in $VISUAL / $EDITOR (saved as a human edit)
        #[arg(long, conflicts_with_all = ["set", "regenerate", "prompt"])]
        edit: bool,
        /// Save the markdown on stdin as a human edit
        #[arg(long, conflicts_with_all = ["regenerate", "prompt"])]
        set: bool,
        /// With --set: refuse (exit 3) unless the stored brief's `updated` is this ("" = none yet)
        #[arg(long, requires = "set", value_name = "ISO")]
        expect_updated: Option<String>,
        /// Ask this host's web server to regenerate it (in the background; capped per hour)
        #[arg(long, conflicts_with = "prompt")]
        regenerate: bool,
        /// Open the session's git root (else cwd) in VS Code (`code`; `cursor` with
        /// web.editor "cursor") — through Remote-SSH for a session on another host
        #[arg(long, conflicts_with_all = ["json", "prompt", "edit", "set", "regenerate"])]
        open: bool,
    },

    /// Spawn a new Claude session in a fresh tab/pane
    Spawn {
        /// Initial prompt (optional; with --from, added after the continue prompt)
        prompt: Option<String>,
        /// Continue this session's work: same host and cwd, its brief's continue prompt first
        #[arg(long, value_name = "SESSION")]
        from: Option<String>,
        /// Working directory (defaults to the current directory)
        #[arg(long)]
        dir: Option<String>,
        /// Backend to spawn into (default: tmux inside tmux, over ssh or off macOS; else iterm)
        #[arg(long, value_enum)]
        backend: Option<BackendArg>,
        /// Display name for the new session (as shown by `list`/`watch`)
        #[arg(long)]
        name: Option<String>,
        /// Model for the new session (`claude --model <id>`; default: Claude's own)
        #[arg(long, value_name = "ID")]
        model: Option<String>,
        /// Open a window in this tmux session instead of a new session per job (tmux only)
        #[arg(long)]
        tmux_session: Option<String>,
        /// Open a new window instead of a tab (iterm backend only)
        #[arg(long)]
        window: bool,
    },

    /// Session stacks: sessions sharing one context file (the StackBrief); spawn siblings
    Stack {
        #[command(subcommand)]
        cmd: StackCmd,
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
        /// Model for the new session (`claude --model <id>`; default: Claude's own)
        #[arg(long, value_name = "ID")]
        model: Option<String>,
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
enum StackCmd {
    /// Stacks on this host (after a membership sync)
    #[command(visible_alias = "ls")]
    List {
        /// `{ host, stacks: [StackView…] }`
        #[arg(long)]
        json: bool,
    },
    /// Print a stack's StackBrief (body, no frontmatter)
    Show {
        /// stack id, label (or a fragment of it), or a member session target
        stack: String,
        /// The StackView JSON
        #[arg(long, conflicts_with = "path")]
        json: bool,
        /// Only the file's path
        #[arg(long)]
        path: bool,
    },
    /// Create a stack around a live session (one model call writes Summary / Resources)
    New {
        /// The session the stack starts from
        #[arg(long, value_name = "TARGET")]
        from: String,
        /// Stack label (default: the model's, else the session's title)
        #[arg(long)]
        label: Option<String>,
        /// Skip the model call: write the skeleton StackBrief
        #[arg(long)]
        no_llm: bool,
        #[arg(long)]
        json: bool,
    },
    /// The session's stack, created like `new` when it has none
    Ensure {
        target: String,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        no_llm: bool,
        #[arg(long)]
        json: bool,
    },
    /// Spawn a sibling: a new session in <target>'s stack (created if needed), same cwd
    Spawn {
        /// The session whose stack the sibling joins
        target: String,
        /// The sibling's first prompt (after the stack's context line)
        prompt: Option<String>,
        /// Display name for the new session
        #[arg(long)]
        name: Option<String>,
        /// Model for the new session (`claude --model <id>`)
        #[arg(long, value_name = "ID")]
        model: Option<String>,
        /// Working directory (default: <target>'s cwd)
        #[arg(long)]
        dir: Option<String>,
        /// Backend to spawn into (same default as spawn)
        #[arg(long, value_enum)]
        backend: Option<BackendArg>,
        /// Open a window in this tmux session instead of a new session (tmux only)
        #[arg(long)]
        tmux_session: Option<String>,
        /// Open a new window instead of a tab (iterm only)
        #[arg(long)]
        window: bool,
        /// Don't wait for the new session to register (prints the `fleet stack add` to run)
        #[arg(long)]
        no_wait: bool,
        /// Label for a stack created by this spawn
        #[arg(long)]
        label: Option<String>,
        /// Skip the model call when a stack is created
        #[arg(long)]
        no_llm: bool,
        #[arg(long)]
        json: bool,
    },
    /// Add a live session to a stack
    Add {
        stack: String,
        target: String,
        #[arg(long)]
        json: bool,
    },
    /// Drop a member (a session target, or a full session id for a gone one)
    Remove {
        stack: String,
        target: String,
        #[arg(long)]
        json: bool,
    },
    /// Edit the StackBrief in $VISUAL / $EDITOR (saved as a human edit)
    Edit {
        stack: String,
        #[arg(long)]
        json: bool,
    },
    /// Save the markdown on stdin as a human edit
    Set {
        stack: String,
        /// Refuse (exit 3) unless the stored `updated` is this
        #[arg(long, value_name = "ISO")]
        expect_updated: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Reconcile members with the live sessions (gone → closed)
    Sync {
        #[arg(long)]
        json: bool,
    },
    /// Delete a stack's file
    Rm {
        stack: String,
        /// Don't ask
        #[arg(short, long)]
        force: bool,
        /// `{ removed: id }` (needs -f)
        #[arg(long)]
        json: bool,
    },
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
        Commands::Brief { edit: true, .. }
        | Commands::Brief { open: true, .. }
        | Commands::Stack {
            cmd: StackCmd::Edit { .. },
        } => Placement::Here,
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

    // `enter` with no host named looks on the default host, then everywhere else.
    let host_named = cli.host.is_some()
        || cli.local
        || cli.as_host.is_some()
        || std::env::var("FLEET_HOST").is_ok_and(|h| !h.trim().is_empty());
    if !host_named
        && let Commands::Enter { query }
        | Commands::Tmux {
            cmd: Some(TmuxCmd::Enter { query }),
        } = &command
    {
        return tmux_cmds::enter_anywhere(query);
    }

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
            json,
        } => commands::rename(&target, &name, no_tmux_sync, force, json)?,
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
            rename,
            move_session,
            to,
            label,
        } => {
            let edit = match (rename, move_session) {
                (Some(id), _) => Some(group::Edit::Rename {
                    id,
                    label: label.unwrap_or_default(),
                }),
                (None, Some(session)) => Some(group::Edit::Move {
                    session,
                    to: match (to, label) {
                        (Some(g), _) => fleet::core::grouping::MoveTo::Group(g),
                        (None, Some(l)) => fleet::core::grouping::MoveTo::New(l),
                        (None, None) => {
                            return Err(Error::Other(
                                "--move needs --to <group id> or --label <new group>".into(),
                            ));
                        }
                    },
                }),
                _ => None,
            };
            group::run(group::GroupOpts {
                all_hosts,
                json,
                apply,
                refresh,
                consolidate,
                cached,
                input,
                dry_run: cli.dry_run,
                edit,
            })?
        }
        Commands::Brief {
            target: session,
            json,
            prompt,
            edit,
            set,
            expect_updated,
            regenerate,
            open,
        } => {
            if open {
                let t = target(cli.host.as_deref(), cli.local, Scope::SelfHost)?;
                brief_cmd::open(&t, &session)?
            } else if edit {
                let t = target(cli.host.as_deref(), cli.local, Scope::SelfHost)?;
                return brief_cmd::edit(&t, &session, json);
            } else if set {
                brief_cmd::set(&session, json, expect_updated.as_deref())?
            } else if regenerate {
                brief_cmd::regenerate(&session, json)?
            } else {
                brief_cmd::show(&session, json, prompt)?
            }
        }
        Commands::Spawn {
            prompt,
            from,
            dir,
            backend,
            name,
            model,
            tmux_session,
            window,
        } => commands::spawn(
            prompt,
            from,
            commands::SpawnOpts {
                dir,
                backend: backend.map(Into::into),
                name,
                model,
                tmux_session,
                window,
            },
        )?,
        Commands::Stack { cmd } => match cmd {
            StackCmd::List { json } => stack_cmds::list(json)?,
            StackCmd::Show { stack, json, path } => stack_cmds::show(&stack, json, path)?,
            StackCmd::New {
                from,
                label,
                no_llm,
                json,
            } => stack_cmds::new(&from, label.as_deref(), no_llm, json)?,
            StackCmd::Ensure {
                target,
                label,
                no_llm,
                json,
            } => stack_cmds::ensure(&target, label.as_deref(), no_llm, json)?,
            StackCmd::Spawn {
                target,
                prompt,
                name,
                model,
                dir,
                backend,
                tmux_session,
                window,
                no_wait,
                label,
                no_llm,
                json,
            } => stack_cmds::spawn(stack_cmds::SpawnArgs {
                target,
                prompt,
                label,
                no_llm,
                opts: commands::SpawnOpts {
                    dir,
                    backend: backend.map(Into::into),
                    name,
                    model,
                    tmux_session,
                    window,
                },
                wait: !no_wait,
                json,
            })?,
            StackCmd::Add {
                stack,
                target,
                json,
            } => stack_cmds::add(&stack, &target, json)?,
            StackCmd::Remove {
                stack,
                target,
                json,
            } => stack_cmds::remove(&stack, &target, json)?,
            StackCmd::Edit { stack, json } => {
                let t = target(cli.host.as_deref(), cli.local, Scope::SelfHost)?;
                return stack_cmds::edit(&t, &stack, json);
            }
            StackCmd::Set {
                stack,
                expect_updated,
                json,
            } => stack_cmds::set(&stack, expect_updated.as_deref(), json)?,
            StackCmd::Sync { json } => stack_cmds::sync(json)?,
            StackCmd::Rm { stack, force, json } => stack_cmds::rm(&stack, force, json)?,
        },
        Commands::Handoff {
            brief,
            file,
            dir,
            backend,
            name,
            model,
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
                model,
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
