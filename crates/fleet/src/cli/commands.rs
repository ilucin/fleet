//! One function per CLI verb. `watch` lives in its own module.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use colored::Colorize;

use crate::cli::render::{home_rel, plain_table, tail, term_width};
use crate::core::backend::{self, Prompt};
use crate::core::config;
use crate::core::discovery::{self, Backend, Session, claude_home};
use crate::core::naming;
use crate::error::{Error, Result};

pub use crate::core::config::{NamingConfig, UiConfig};

/// The config pieces the session verbs and the dashboard read.
pub struct FleetConfig {
    pub ui: UiConfig,
    pub naming: NamingConfig,
}

/// Everything one read of the config yields.
pub struct Loaded {
    pub cfg: FleetConfig,
    /// `Some(message)` when the file exists but doesn't parse. Loading degrades
    /// to defaults on purpose, so without this the user never learns why their
    /// settings stopped applying — or why `z` no longer sticks.
    pub problem: Option<String>,
}

pub fn load_all() -> Loaded {
    let l = config::load();
    Loaded {
        cfg: FleetConfig {
            ui: l.config.tui.clone(),
            naming: l.config.naming.clone(),
        },
        problem: l
            .problem
            .as_ref()
            .map(|p| format!("config not readable: {}", home_rel(p))),
    }
}

/// `tui` config, or all-defaults when there's no config file.
pub fn ui_config() -> UiConfig {
    config::get().tui.clone()
}

/// `naming` config, or all-defaults when there's no config file.
pub fn naming_config() -> NamingConfig {
    config::get().naming.clone()
}

/// Write one `tui` key back, leaving the rest of the file alone. Best-effort by
/// contract: the caller reports the error, a dashboard toggle never takes the TUI
/// down over an unwritable or malformed config.
pub fn persist_ui(key: &str, value: &str) -> std::result::Result<(), String> {
    config::patch(
        &format!("tui.{key}"),
        serde_json::Value::String(value.into()),
    )
    .map_err(|e| e.to_string())
}

/// Resolve the command used to launch Claude in a spawned session. Hosts differ:
/// some invoke `claude`, others a wrapper/alias. Precedence: `FLEET_CMD` env var
/// → `claude` in the config → `claude`.
fn resolve_launcher() -> String {
    if let Ok(cmd) = std::env::var("FLEET_CMD") {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            return cmd.to_string();
        }
    }
    if let Some(cmd) = config::get().claude.as_deref()
        && !cmd.trim().is_empty()
    {
        return cmd.trim().to_string();
    }
    "claude".to_string()
}

/// The name rows are tagged with: `--as-host` (set by the dispatcher), else
/// config `self`.
pub fn host_label() -> String {
    crate::core::hosts::as_host().unwrap_or_else(|| config::get().self_name())
}

/// The rows `list` prints: discovered, tab-enriched, titled, host-tagged.
pub fn list_rows() -> Vec<Session> {
    let mut rows = discovery::discover();
    // The terminal a session lives in is part of what `list` is for; without this
    // every iTerm-backed row renders as `-`.
    discovery::enrich_iterm_tabs(&mut rows);
    // Titles the dashboard has already paid for, so `--json` carries what a
    // session is *doing* and not only what it's called. Read-only: `list` never
    // generates one.
    naming::stamp_titles(&mut rows);
    let host = host_label();
    for r in rows.iter_mut() {
        r.host = Some(host.clone());
    }
    rows
}

pub fn list(json: bool) -> Result<()> {
    let rows = list_rows();
    if json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
    } else {
        println!("{}\n", plain_table(&rows));
    }
    Ok(())
}

pub fn peek(target: &str, lines: usize) -> Result<()> {
    let s = discovery::resolve(target).map_err(Error::Other)?;
    let text = backend::peek(&s)?;
    let where_ = s.cwd.as_deref().map(home_rel).unwrap_or_default();
    println!(
        "\n{} {} ({}, {}) — {}",
        "▼".cyan(),
        s.headline().bold(),
        s.backend.label(),
        s.status,
        where_.dimmed()
    );
    let rule = "─".repeat(term_width().clamp(40, 200));
    println!("{rule}");
    println!("{}", tail(&text, lines, term_width().saturating_sub(2)));
    println!("{rule}\n");
    Ok(())
}

pub fn send(target: &str, text: &str) -> Result<()> {
    let s = discovery::resolve(target).map_err(Error::Other)?;
    backend::send(&s, text)?;
    println!(
        "sent to {} ({}): {}",
        s.headline().bold(),
        s.backend.label(),
        text
    );
    Ok(())
}

/// How one rename should be applied.
#[derive(Clone, Copy, Default)]
pub struct RenameOpts {
    /// Bring the session's tmux session name along.
    pub sync_tmux: bool,
    /// Send `/rename` even to a busy or waiting session. The hold exists because
    /// a live turn would read `/rename foo` as its answer; a session that is
    /// *always* busy would otherwise be unrenameable by any path, so the escape
    /// hatch is explicit rather than absent.
    pub force: bool,
}

/// What [`apply_rename`] did.
pub enum RenameOutcome {
    /// `/rename` was typed into the session. The note, when present, describes
    /// what happened to its tmux session name.
    Sent(Option<String>),
    /// Nothing was sent, and why.
    Held(String),
}

/// Drive Claude's own `/rename` for one session, then (optionally) bring its
/// tmux session name along.
///
/// The single choke point for every rename: the CLI verbs, `name --apply` and
/// the dashboard's rename buffer all come through here, so the "never type into
/// a live turn" rule can't be forgotten in one of them. `backend::send` types
/// into a real Claude TUI — a session mid-turn, or sitting on a permission
/// prompt, would receive `/rename foo` as its *answer*.
pub fn apply_rename(s: &Session, name: &str, o: RenameOpts) -> Result<RenameOutcome> {
    if !o.force {
        if s.status == "busy" {
            return Ok(RenameOutcome::Held(format!(
                "{} is mid-turn — nothing sent (--force overrides)",
                s.headline()
            )));
        }
        if s.is_waiting() {
            return Ok(RenameOutcome::Held(format!(
                "{} is waiting on you — nothing sent (--force overrides)",
                s.headline()
            )));
        }
    }
    backend::send(s, &format!("/rename {name}"))?;
    if !o.sync_tmux {
        return Ok(RenameOutcome::Sent(None));
    }
    Ok(RenameOutcome::Sent(
        match backend::rename_tmux_session(s, name) {
            Ok(backend::TmuxSync::Renamed(msg)) => Some(msg),
            Ok(backend::TmuxSync::Skipped(why)) => Some(why),
            // The Claude rename already landed; a tmux failure is a footnote,
            // not a reason to report the whole thing as failed.
            Err(e) => Some(format!("tmux not renamed: {e}")),
        },
    ))
}

/// Rename a session by driving Claude's own `/rename` — the registry (and so
/// every fleet view) picks the new name up on its next status write.
pub fn rename(target: &str, name: &str, no_tmux_sync: bool, force: bool) -> Result<()> {
    let s = discovery::resolve(target).map_err(Error::Other)?;
    let name = clean_name(name)?;
    let was = s.label();
    let opts = RenameOpts {
        sync_tmux: !no_tmux_sync && naming_config().sync_tmux(),
        force,
    };
    match apply_rename(&s, &name, opts)? {
        RenameOutcome::Held(why) => return Err(Error::Other(why)),
        RenameOutcome::Sent(note) => {
            if let Some(note) = note {
                println!("{}", note.dimmed());
            }
        }
    }

    // Confirm from the registry rather than trusting the keystrokes landed.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(now) = discovery::discover().iter().find(|r| r.key() == s.key())
            && now.name.as_deref() == Some(name.as_str())
        {
            println!("{} → {}", was.dimmed(), name.bold());
            return Ok(());
        }
    }
    println!(
        "sent `/rename {name}` to {} — not reflected yet, check `fleet list`",
        was.bold()
    );
    Ok(())
}

// --- name ---------------------------------------------------------------------

/// How `fleet name` was asked to run.
#[derive(Default, Clone, Copy)]
pub struct NameOpts {
    /// Every session whose name is still Claude's cwd+hash fallback.
    pub all: bool,
    /// Actually send `/rename`. Without it this prints suggestions and stops.
    pub apply: bool,
    /// The explicit form of the default — suggest, touch nothing.
    pub dry_run: bool,
    pub no_tmux_sync: bool,
    /// Ignore the cached name and overwrite it with a fresh one.
    pub refresh: bool,
}

/// Suggest (and optionally apply) LLM-generated names.
///
/// The scriptable half of the `N` / `Ctrl-N` keys: same generator, same cache,
/// same guards, usable from a skill or a shell without opening the dashboard.
/// What the `name` verb is allowed to do, from the config and the flags.
///
/// The only thing that stops `naming.enabled = false` from spawning a
/// `claude` per session: the headline it prints says nothing will happen, and
/// for a while that was all it was.
fn gen_opts(cfg: &NamingConfig, o: NameOpts, fixture: bool) -> naming::GenOpts {
    naming::GenOpts {
        allow_llm: cfg.enabled() && !fixture,
        refresh: o.refresh,
    }
}

pub fn name(target: Option<String>, o: NameOpts) -> Result<()> {
    let cfg = naming_config();
    let how = gen_opts(&cfg, o, discovery::is_fixture());
    let targets: Vec<Session> = match (&target, o.all) {
        (Some(t), false) => vec![discovery::resolve(t).map_err(Error::Other)?],
        (None, true) => discovery::discover()
            .into_iter()
            .filter(Session::is_derived_name)
            .collect(),
        (Some(_), true) => {
            return Err(Error::Other("pass a target or --all, not both".into()));
        }
        (None, false) => {
            return Err(Error::Other(
                "name what? pass a session target (sessionId prefix, name, or pid) or --all".into(),
            ));
        }
    };
    if targets.is_empty() {
        println!("no sessions still carry a Claude-derived name — nothing to rename");
        return Ok(());
    }

    let apply = o.apply && !o.dry_run;
    let rename_opts = RenameOpts {
        sync_tmux: !o.no_tmux_sync && cfg.sync_tmux(),
        force: false,
    };
    // Off in config, or a canned fleet: the heuristic answers and no child is
    // ever spawned — `how.allow_llm` is what carries that all the way to
    // `naming::suggest`, which is the only thing that can actually enforce it.
    if !how.allow_llm {
        println!(
            "{}",
            "naming is inert here (fixture mode or naming.enabled = false) — showing the branch/title guess"
                .dimmed()
        );
    }

    for (s, result) in generate(&targets, &cfg, how) {
        let was = s.label();
        let suggestion = match result {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{} {}: {}", "✕".red(), was.bold(), e.dimmed());
                continue;
            }
        };
        let new = &suggestion.name;
        if !apply {
            println!(
                "{}  →  {}   {}",
                was.dimmed(),
                new.bold(),
                format!("({})", suggestion.source.label()).dimmed()
            );
            continue;
        }
        match apply_rename(&s, new, rename_opts) {
            Ok(RenameOutcome::Sent(note)) => {
                println!("{}  →  {}", was.dimmed(), new.bold());
                if let Some(note) = note {
                    println!("   {}", note.dimmed());
                }
            }
            Ok(RenameOutcome::Held(why)) => println!("{} {}", "⏸".yellow(), why.dimmed()),
            Err(e) => eprintln!("{} {was}: {e}", "✕".red()),
        }
    }
    Ok(())
}

/// Generate a suggestion per session, two model calls in flight at a time.
/// Order follows `targets` so the output is stable.
fn generate(
    targets: &[Session],
    cfg: &NamingConfig,
    how: naming::GenOpts,
) -> Vec<(Session, std::result::Result<naming::Suggestion, String>)> {
    let (pool, rx) = naming::NamePool::start(cfg.model(), how);
    for s in targets {
        pool.enqueue(naming::NameJob {
            key: s.key(),
            session: s.clone(),
            purpose: naming::Purpose::Bulk,
        });
    }
    let mut by_key: HashMap<String, std::result::Result<naming::Suggestion, String>> =
        HashMap::new();
    // Counted by answers collected, not by messages read: `Unavailable` is a
    // one-off aside and must not consume a session's slot.
    while by_key.len() < targets.len() {
        match rx.recv() {
            Ok(naming::NameMsg::Named {
                key, name, source, ..
            }) => {
                by_key.insert(
                    key,
                    Ok(naming::Suggestion {
                        name,
                        source,
                        note: None,
                    }),
                );
            }
            Ok(naming::NameMsg::Failed { key, err, .. }) => {
                by_key.insert(key, Err(err));
            }
            // Said once per run by contract; the per-session lines carry the
            // detail that matters here.
            Ok(naming::NameMsg::Unavailable(_)) => continue,
            // Every worker is gone — nothing more is coming.
            Err(_) => break,
        }
    }
    drop(pool);
    targets
        .iter()
        .map(|s| {
            let r = by_key
                .remove(&s.key())
                .unwrap_or_else(|| Err("no answer from the naming worker".into()));
            (s.clone(), r)
        })
        .collect()
}

/// The longest name any path may send. Generated names are capped at
/// [`naming::MAX_NAME`]; this is the looser cap for one a human typed, and it
/// exists because the name goes out as `/rename <name>` into a live TUI *and*
/// becomes a tmux session name.
pub const MAX_RENAME: usize = 64;

/// A session name has to survive being typed into a TUI prompt as one line.
/// Over-long names are cropped rather than refused — the user typed something,
/// and a 300-character tmux session name helps nobody.
pub fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Other("empty name".into()));
    }
    if name.contains(['\n', '\r']) {
        return Err(Error::Other("name must be a single line".into()));
    }
    Ok(name.chars().take(MAX_RENAME).collect::<String>())
}

/// Everything `spawn` and `handoff` share about *where* the new session lands.
#[derive(Default)]
pub struct SpawnOpts {
    pub dir: Option<String>,
    pub backend: Option<Backend>,
    /// Claude display name for the new session (`claude -n`).
    pub name: Option<String>,
    pub tmux_session: Option<String>,
    pub window: bool,
}

impl SpawnOpts {
    /// Fill in the defaults that need the environment: cwd, and the backend we're
    /// sitting in. Also validates, so a bad dir/name fails before anything opens.
    fn resolve(&self) -> Result<(String, Backend, Option<String>)> {
        let dir = self
            .dir
            .as_deref()
            .map(crate::core::tools::expand_tilde)
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| ".".into())
            });
        if !Path::new(&dir).exists() {
            return Err(Error::Other(format!("dir does not exist: {dir}")));
        }
        let backend = self.backend.unwrap_or_else(default_backend);
        let name = self.name.as_deref().map(clean_name).transpose()?;
        Ok((dir, backend, name))
    }
}

/// Where a new session goes when nobody said: tmux when we are inside tmux, or
/// reached over ssh (a remote host's iTerm is on a screen nobody is looking
/// at), or not on macOS; iTerm otherwise.
fn default_backend() -> Backend {
    if std::env::var_os("TMUX").is_some()
        || std::env::var_os("SSH_CONNECTION").is_some()
        || !cfg!(target_os = "macos")
    {
        Backend::Tmux
    } else {
        Backend::Iterm
    }
}

pub fn spawn(prompt: Option<String>, opts: SpawnOpts) -> Result<()> {
    let (dir, backend_kind, name) = opts.resolve()?;
    let prompt = prompt.unwrap_or_default();
    let launcher = resolve_launcher();
    let desc = backend::spawn(
        backend_kind,
        &dir,
        Prompt::Inline(&prompt),
        name.as_deref(),
        opts.tmux_session.as_deref(),
        opts.window,
        &launcher,
    )?;
    if prompt.is_empty() {
        println!("{desc} in {}", home_rel(&dir));
    } else {
        println!("{desc} in {} — \"{prompt}\"", home_rel(&dir));
    }
    Ok(())
}

// --- handoff -----------------------------------------------------------------

/// Where handoff briefs are kept. They outlive the spawn on purpose: the record
/// of what was handed off, and a file the new session can re-read at any point.
fn handoff_dir() -> PathBuf {
    claude_home().join("fleet-handoffs")
}

/// A filename-safe stem from the brief's first line. Shares its slugger with
/// the name generator — two spellings of "make this safe to use as a name" is
/// one too many.
fn slug(text: &str) -> String {
    let out = naming::slugify(text, 40);
    if out.is_empty() {
        "handoff".into()
    } else {
        out
    }
}

/// The text the receiving session wakes up to: a line of provenance, then the brief.
fn compose(brief: &str, dir: &str, from: Option<&Session>, stamp: &str) -> String {
    let origin = match from {
        Some(s) => format!(
            "another Claude session ({}, in {})",
            s.label(),
            s.cwd.as_deref().map(home_rel).unwrap_or_else(|| "?".into())
        ),
        None => "another Claude session".to_string(),
    };
    let reply = from
        .map(|s| {
            format!(
                "\nWhen you're done (or blocked), report back with: `fleet send {} \"<your update>\"`.\n",
                s.label()
            )
        })
        .unwrap_or_default();
    format!(
        "You're picking up work handed off from {origin} at {stamp}. \
You're running in {}. Work autonomously within the brief below — where it sets a \
scope or a constraint, that wins over your defaults.\n{reply}\n--- Brief ---\n\n{}\n",
        home_rel(dir),
        brief.trim()
    )
}

/// Read the brief from an explicit argument, a file (`-` = stdin), or piped stdin.
fn read_brief(brief: Option<String>, file: Option<String>) -> Result<String> {
    let text = match (brief, file) {
        (Some(b), _) => b,
        (None, Some(f)) if f == "-" => read_stdin()?,
        (None, Some(f)) => std::fs::read_to_string(&f)
            .map_err(|e| Error::Other(format!("cannot read brief from {f}: {e}")))?,
        (None, None) => read_stdin()?,
    };
    if text.trim().is_empty() {
        return Err(Error::Other(
            "empty brief — pass it as an argument, via --file, or on stdin".into(),
        ));
    }
    Ok(text)
}

fn read_stdin() -> Result<String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf)?;
    Ok(buf)
}

/// Same directory, whether or not symlinks and trailing slashes agree.
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| PathBuf::from(p))
            .display()
            .to_string()
    };
    norm(a) == norm(b)
}

/// Poll the registry for the session that just appeared in `dir`. Claude takes a
/// few seconds to register, so this is worth waiting on — it gives the caller a
/// name to `peek`/`send` with instead of "go look for it".
fn await_new_session(before: &HashSet<String>, dir: &str, timeout: Duration) -> Option<Session> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(700));
        if let Some(s) = discovery::discover().into_iter().find(|s| {
            !before.contains(&s.key()) && s.cwd.as_deref().is_some_and(|c| same_dir(c, dir))
        }) {
            return Some(s);
        }
    }
    None
}

pub fn handoff(
    brief: Option<String>,
    file: Option<String>,
    opts: SpawnOpts,
    wait: bool,
) -> Result<()> {
    let brief = read_brief(brief, file)?;
    let (dir, backend_kind, name) = opts.resolve()?;

    let from = discovery::origin();
    let now = chrono::Local::now();
    let text = compose(
        &brief,
        &dir,
        from.as_ref(),
        &now.format("%Y-%m-%d %H:%M").to_string(),
    );

    let path = handoff_dir().join(format!(
        "{}-{}.md",
        now.format("%Y%m%d-%H%M%S"),
        slug(&brief)
    ));
    std::fs::create_dir_all(handoff_dir())?;
    std::fs::write(&path, &text)?;

    let before: HashSet<String> = discovery::discover().iter().map(Session::key).collect();
    let launcher = resolve_launcher();
    let desc = backend::spawn(
        backend_kind,
        &dir,
        Prompt::File(&path.display().to_string()),
        name.as_deref(),
        opts.tmux_session.as_deref(),
        opts.window,
        &launcher,
    )?;
    println!(
        "{} {desc} in {} — brief: {}",
        "→".cyan(),
        home_rel(&dir),
        home_rel(&path.display().to_string()).dimmed()
    );

    if wait {
        // Returns as soon as the session appears; the ceiling only bites when the
        // spawn failed. A cold Claude boot behind a profile that loads secrets is
        // comfortably past 30s, so don't set this tight.
        match await_new_session(&before, &dir, Duration::from_secs(75)) {
            Some(s) => println!(
                "  picked up as {} — steer it with `fleet send {} \"…\"`",
                s.label().bold(),
                s.label()
            ),
            None => println!("  (not registered yet — `fleet list` in a moment)"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `enabled = false` printed "nothing will happen here" and then spawned a
    // `claude` per session anyway: nothing carried the setting past this point.
    #[test]
    fn naming_disabled_in_config_never_allows_the_model() {
        let off = NamingConfig {
            enabled: Some(false),
            ..Default::default()
        };
        assert!(!gen_opts(&off, NameOpts::default(), false).allow_llm);
        // A fixture is the other way to make it inert.
        assert!(!gen_opts(&NamingConfig::default(), NameOpts::default(), true).allow_llm);
        // The default is the feature doing its job.
        assert!(gen_opts(&NamingConfig::default(), NameOpts::default(), false).allow_llm);
        // …and `--refresh` rides along.
        let refresh = NameOpts {
            refresh: true,
            ..Default::default()
        };
        assert!(gen_opts(&NamingConfig::default(), refresh, false).refresh);
        assert!(!gen_opts(&NamingConfig::default(), NameOpts::default(), false).refresh);
    }

    // A name goes out as `/rename <name>` into a live TUI and then becomes a
    // tmux session name, so neither end wants 300 characters of it.
    #[test]
    fn names_are_trimmed_validated_and_capped() {
        assert_eq!(clean_name("  cache-warmup  ").unwrap(), "cache-warmup");
        assert!(clean_name("   ").is_err());
        assert!(clean_name("two\nlines").is_err());
        let long = clean_name(&"a".repeat(300)).unwrap();
        assert_eq!(long.chars().count(), MAX_RENAME);
        // Character-counted: a multi-byte name must not be split mid-codepoint.
        let wide = clean_name(&"é".repeat(300)).unwrap();
        assert_eq!(wide.chars().count(), MAX_RENAME);
    }

    // The hold protects a live turn from reading `/rename foo` as its answer.
    // A session that is essentially always busy still has to be renameable.
    #[test]
    fn a_busy_session_is_held_unless_forced() {
        let busy = Session {
            pid: 1,
            status: "busy".into(),
            name: Some("auth-spike".into()),
            ..Default::default()
        };
        let held = apply_rename(&busy, "x", RenameOpts::default()).unwrap();
        match held {
            RenameOutcome::Held(why) => assert!(why.contains("--force"), "{why}"),
            RenameOutcome::Sent(_) => panic!("a busy session must not be typed into"),
        }
        // Forced, the hold is gone: this fixture has no handle, so the send
        // fails — what matters is that it got as far as trying.
        let forced = apply_rename(
            &busy,
            "x",
            RenameOpts {
                sync_tmux: false,
                force: true,
            },
        );
        assert!(
            !matches!(forced, Ok(RenameOutcome::Held(_))),
            "--force must bypass the hold"
        );
    }

    #[test]
    fn slugs_come_from_the_first_meaningful_line() {
        assert_eq!(
            slug("# Fix the flaky login test\n\nmore"),
            "fix-the-flaky-login-test"
        );
        assert_eq!(slug("\n\nCache warmup: scale it"), "cache-warmup-scale-it");
        assert_eq!(slug("!!! ???"), "handoff");
        assert!(slug(&"word ".repeat(50)).len() <= 40);
    }

    #[test]
    fn brief_carries_provenance_and_the_reply_path() {
        let text = compose("Do the thing.", "/tmp", None, "2026-08-17 10:00");
        assert!(text.contains("handed off from another Claude session"));
        assert!(text.contains("Do the thing."));
        // No known origin -> nothing to report back to.
        assert!(!text.contains("fleet send"));
    }

    #[test]
    fn known_origin_gets_a_report_back_instruction() {
        let from = Session {
            pid: 1,
            session_id: Some("abcdef123".into()),
            name: Some("app-f9".into()),
            cwd: Some("/tmp".into()),
            status: "busy".into(),
            updated_at: None,
            tty: None,
            backend: Backend::Iterm,
            handle: None,
            tab: None,
            tmux_session: None,
            name_source: None,
            waiting_for: None,
            title: None,
            gen_title: None,
            host: None,
            context: None,
        };
        let text = compose("Do it.", "/tmp", Some(&from), "2026-08-17 10:00");
        assert!(text.contains("(app-f9, in /tmp)"));
        assert!(text.contains("fleet send app-f9"));
    }

    #[test]
    fn brief_sources_are_ordered_and_validated() {
        assert_eq!(
            read_brief(Some("inline".into()), Some("/nope".into())).unwrap(),
            "inline"
        );
        assert!(read_brief(Some("   ".into()), None).is_err());
        assert!(read_brief(None, Some("/definitely/not/here.md".into())).is_err());
    }
}
