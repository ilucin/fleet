//! `fleet tmux …` — tmux sessions on the local server. Remote hosts are handled
//! by the dispatcher before any of this runs, so "local" here means "the host
//! that owns the sessions".
//!
//! Exit codes: 1 usage/refusal, 2 ambiguous match, 3 nothing to act on (no
//! sessions, no match, no terminal), 127 tmux missing.

use std::io::{BufRead, Write};

use colored::Colorize;

use crate::cli::commands::host_label;
use crate::core::title;
use crate::core::tmux::{self, KeptClass, Resolve, StaleReport, TmuxSession};
use crate::error::{Error, Result};

/// "this machine", or the host name when running on behalf of another machine.
fn where_label() -> String {
    match crate::core::hosts::as_host() {
        Some(h) => h,
        None => {
            let me = host_label();
            if me == crate::core::config::DEFAULT_SELF {
                "this machine".into()
            } else {
                me
            }
        }
    }
}

fn note(msg: &str) {
    eprintln!("fleet: {msg}");
}

fn sessions() -> Result<Vec<TmuxSession>> {
    tmux::list_sessions().map_err(|e| Error::exit(127, e.to_string()))
}

fn no_sessions() -> Error {
    Error::exit(
        3,
        format!(
            "no tmux sessions on {} — try: fleet new <name>",
            where_label()
        ),
    )
}

/// Relative age: just now / 12m ago / 3h ago / 2d ago / never.
fn rel(now: i64, t: i64) -> String {
    if t <= 0 {
        return "never".into();
    }
    let s = (now - t).max(0);
    if s < 60 {
        "just now".into()
    } else if s < 3600 {
        format!("{}m ago", s / 60)
    } else if s < 86400 {
        format!("{}h ago", s / 3600)
    } else {
        format!("{}d ago", s / 86400)
    }
}

fn pad(s: &str, w: usize) -> String {
    let n = crate::cli::render::width_of(s);
    if n >= w {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(w - n))
    }
}

pub fn format_sessions(v: &[TmuxSession], now: i64) -> String {
    let w = v
        .iter()
        .map(|s| crate::cli::render::width_of(&s.name))
        .max()
        .unwrap_or(12)
        .clamp(12, 28);
    v.iter()
        .map(|s| {
            let dot = if s.attached > 0 {
                "●".green()
            } else {
                "○".dimmed()
            };
            let when = if s.attached > 0 {
                "attached".to_string()
            } else {
                rel(now, s.last_attached)
            };
            format!(
                "{dot} {} {} {}",
                pad(&s.name, w),
                pad(&format!("{}w", s.windows), 4),
                when.dimmed()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn list(quiet: bool, json: bool) -> Result<()> {
    let v = sessions()?;
    if json {
        let cur = tmux::current_session();
        let rows: Vec<serde_json::Value> = v
            .iter()
            .map(|s| {
                let mut j = serde_json::to_value(s).unwrap_or_default();
                j["current"] = serde_json::Value::Bool(cur.as_deref() == Some(&s.name));
                j["host"] = serde_json::Value::String(host_label());
                j
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }
    if v.is_empty() {
        if !quiet {
            note(&format!(
                "no tmux sessions on {} — try: fleet new <name>",
                where_label()
            ));
        }
        return Ok(());
    }
    if quiet {
        for s in &v {
            println!("{}", s.name);
        }
    } else {
        println!("{}", format_sessions(&v, chrono::Utc::now().timestamp()));
    }
    Ok(())
}

fn need_tty(what: &str) -> Result<()> {
    if crate::core::hosts::dry_run() || crate::core::tools::interactive() {
        return Ok(());
    }
    Err(Error::exit(
        3,
        format!("'{what}' needs a terminal (stdin/stdout is not a tty)"),
    ))
}

/// Resolve a query to one session name, or exit with the documented codes (2 ambiguous, 3 no match).
fn resolve(q: &str) -> Result<String> {
    let v = sessions()?;
    if v.is_empty() {
        return Err(no_sessions());
    }
    match tmux::resolve_in(&v, q) {
        Resolve::One(n) => Ok(n),
        Resolve::None => {
            eprintln!("{} no session matching '{q}'", "fleet:".red());
            eprintln!("{}", format_sessions(&v, chrono::Utc::now().timestamp()));
            Err(Error::exit(3, ""))
        }
        Resolve::Many(m) => {
            eprintln!("{} '{q}' matches {} sessions:", "fleet:".red(), m.len());
            for n in &m {
                eprintln!("    {n}");
            }
            eprintln!("{}", "hint: fleet enter <full-name>".dimmed());
            Err(Error::exit(2, ""))
        }
    }
}

pub fn enter(q: &str) -> Result<()> {
    if q.is_empty() {
        return Err(Error::exit(1, "usage: fleet enter <query>"));
    }
    let name = resolve(q)?;
    need_tty(&format!("fleet enter {q}"))?;
    tmux::attach(&name)
}

// --- enter across hosts ----------------------------------------------------------

/// One host's tmux sessions, or why they could not be listed.
pub type HostList = std::result::Result<Vec<TmuxSession>, String>;

/// Where a query landed across hosts.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    /// Exactly one session. `elsewhere`: not on the default host.
    One {
        host: String,
        name: String,
        elsewhere: bool,
    },
    /// Several at the best tier, as (host, name).
    Many {
        hits: Vec<(String, String)>,
        elsewhere: bool,
    },
    None,
}

#[derive(Debug)]
pub struct Search {
    pub found: Found,
    /// Hosts that answered, with their sessions, in search order.
    pub listed: Vec<(String, Vec<TmuxSession>)>,
    /// Hosts that did not, with why.
    pub failed: Vec<(String, String)>,
}

/// Resolve `q` on `default` first; only when nothing matches there (or it
/// can't be reached) ask `others`, in parallel, and rank their hits by the
/// same tiers (exact > case-folded exact > prefix > substring) across hosts.
pub fn search_hosts<F>(q: &str, default: &str, others: &[String], fetch: F) -> Search
where
    F: Fn(&str) -> HostList + Sync,
{
    let mut listed = Vec::new();
    let mut failed = Vec::new();
    match fetch(default) {
        Ok(v) => {
            let hit = tmux::match_tier(&v, q);
            listed.push((default.to_string(), v));
            if let Some((_, mut names)) = hit {
                let found = if names.len() == 1 {
                    Found::One {
                        host: default.to_string(),
                        name: names.remove(0),
                        elsewhere: false,
                    }
                } else {
                    Found::Many {
                        hits: names
                            .into_iter()
                            .map(|n| (default.to_string(), n))
                            .collect(),
                        elsewhere: false,
                    }
                };
                return Search {
                    found,
                    listed,
                    failed,
                };
            }
        }
        Err(e) => failed.push((default.to_string(), e)),
    }
    let answers: Vec<(String, HostList)> = std::thread::scope(|sc| {
        let handles: Vec<_> = others
            .iter()
            .map(|h| {
                let fetch = &fetch;
                sc.spawn(move || (h.clone(), fetch(h)))
            })
            .collect();
        handles
            .into_iter()
            .zip(others)
            .map(|(t, h)| {
                t.join()
                    .unwrap_or_else(|_| (h.clone(), Err("lookup panicked".into())))
            })
            .collect()
    });
    let mut best: Option<usize> = None;
    let mut hits: Vec<(usize, String, String)> = Vec::new();
    for (host, r) in answers {
        match r {
            Ok(v) => {
                if let Some((tier, names)) = tmux::match_tier(&v, q) {
                    best = Some(best.map_or(tier, |b| b.min(tier)));
                    hits.extend(names.into_iter().map(|n| (tier, host.clone(), n)));
                }
                listed.push((host, v));
            }
            Err(e) => failed.push((host, e)),
        }
    }
    let mut hits: Vec<(String, String)> = hits
        .into_iter()
        .filter(|(t, _, _)| Some(*t) == best)
        .map(|(_, h, n)| (h, n))
        .collect();
    let found = match hits.len() {
        0 => Found::None,
        1 => {
            let (host, name) = hits.remove(0);
            Found::One {
                host,
                name,
                elsewhere: true,
            }
        }
        _ => Found::Many {
            hits,
            elsewhere: true,
        },
    };
    Search {
        found,
        listed,
        failed,
    }
}

/// One host's sessions, locally or over ssh (`fleet tmux list --json` there).
fn fetch_host(name: &str) -> HostList {
    use crate::core::hosts::{self, Scope, Target};
    match hosts::resolve(
        crate::core::config::get(),
        Some(name),
        false,
        Scope::SelfHost,
    ) {
        Err(e) => Err(e.to_string()),
        Ok(Target::Local { .. }) => tmux::list_sessions().map_err(|e| e.to_string()),
        Ok(Target::Remote(r)) => {
            let args = ["tmux".to_string(), "list".into(), "--json".into()];
            match hosts::capture_remote(&r, &args, hosts::remote_timeout()) {
                Err(e) => Err(e.to_string()),
                Ok(c) if !c.ok() => Err(c.why(&r)),
                Ok(c) => serde_json::from_str(&c.stdout).map_err(|e| format!("bad JSON: {e}")),
            }
        }
    }
}

/// Attach to `name` on `host`: here, or by re-running `tmux enter` there.
fn attach_on(host: &str, name: &str, q: &str) -> Result<i32> {
    use crate::core::hosts::{self, Scope, Target};
    match hosts::resolve(
        crate::core::config::get(),
        Some(host),
        false,
        Scope::SelfHost,
    )? {
        Target::Local { .. } => {
            need_tty(&format!("fleet enter {q}"))?;
            tmux::attach(name)?;
            Ok(0)
        }
        Target::Remote(r) => {
            hosts::run_remote(&r, &["tmux".into(), "enter".into(), name.into()], false)
        }
    }
}

/// `fleet enter <q>` with no host named: the default host first, then every
/// other host fleet can reach over ssh (web-only peers are skipped).
pub fn enter_anywhere(q: &str) -> Result<i32> {
    use crate::core::hosts::{self, Scope, Target};
    if q.is_empty() {
        return Err(Error::exit(1, "usage: fleet enter <query>"));
    }
    let cfg = crate::core::config::get();
    let dt = hosts::resolve(cfg, None, false, Scope::DefaultHost)?;
    let default = dt.name().to_string();
    let others: Vec<String> = cfg
        .ssh_host_names()
        .into_iter()
        .filter(|n| *n != default)
        .collect();
    if others.is_empty() {
        // Nowhere else to look: exactly the single-host behaviour.
        return match dt {
            Target::Local { .. } => enter(q).map(|_| 0),
            Target::Remote(r) => {
                hosts::run_remote(&r, &["tmux".into(), "enter".into(), q.into()], false)
            }
        };
    }
    let s = search_hosts(q, &default, &others, fetch_host);
    for (h, why) in &s.failed {
        eprintln!("{} {h}: {why} — skipped", "fleet:".yellow());
    }
    match s.found {
        Found::One {
            host,
            name,
            elsewhere,
        } => {
            if elsewhere {
                eprintln!("→ {host}: {name}");
            }
            attach_on(&host, &name, q)
        }
        Found::Many { hits, elsewhere } => {
            eprintln!("{} '{q}' matches {} sessions:", "fleet:".red(), hits.len());
            let w = hits.iter().map(|(h, _)| h.len()).max().unwrap_or(0);
            for (h, n) in &hits {
                if elsewhere {
                    eprintln!("    {}  {n}", pad(h, w));
                } else {
                    eprintln!("    {n}");
                }
            }
            let hint = if elsewhere {
                "hint: fleet -H <host> enter <full-name>"
            } else {
                "hint: fleet enter <full-name>"
            };
            eprintln!("{}", hint.dimmed());
            Err(Error::exit(2, ""))
        }
        Found::None if s.listed.is_empty() => Err(Error::exit(
            hosts::EXIT_UNREACHABLE,
            "no host answered — see: fleet doctor",
        )),
        Found::None => {
            let names: Vec<&str> = s.listed.iter().map(|(h, _)| h.as_str()).collect();
            eprintln!(
                "{} no session matching '{q}' on {}",
                "fleet:".red(),
                names.join(", ")
            );
            let now = chrono::Utc::now().timestamp();
            for (h, v) in s.listed.iter().filter(|(_, v)| !v.is_empty()) {
                eprintln!("{}", format!("{h}:").dimmed());
                eprintln!("{}", format_sessions(v, now));
            }
            Err(Error::exit(3, ""))
        }
    }
}

pub fn last() -> Result<()> {
    let v = sessions()?;
    if v.is_empty() {
        return Err(no_sessions());
    }
    let cur = tmux::current_session();
    match tmux::last_target(&v, cur.as_deref()) {
        Some(t) => {
            need_tty("fleet last")?;
            tmux::attach(&t)
        }
        None => {
            note(&format!(
                "already in the only session ({})",
                cur.unwrap_or_default()
            ));
            Ok(())
        }
    }
}

pub fn new(name: Option<&str>, detach: bool, dir: Option<&str>, cmd: &[String]) -> Result<()> {
    let name = tmux::sanitize_name(name.unwrap_or("main"));
    if name.is_empty() {
        return Err(Error::exit(
            1,
            "new: session name is empty after sanitising",
        ));
    }
    if let Some(d) = dir
        && !(d.starts_with('/') || d == "~" || d.starts_with("~/"))
    {
        // Resolve a relative dir here, where it means something.
        let abs = std::env::current_dir()?.join(d);
        return new(Some(&name), detach, Some(&abs.display().to_string()), cmd);
    }
    if !detach {
        need_tty(&format!("fleet new {name}"))?;
    }
    if tmux::has_session(&name) {
        if !cmd.is_empty() {
            note(&format!(
                "session '{name}' already exists — ignoring the command"
            ));
        } else if detach {
            note(&format!("session '{name}' already exists"));
        }
    } else {
        tmux::new_session(&name, dir, cmd)?;
        if detach {
            println!("created (detached): {name}");
        }
    }
    if detach {
        return Ok(());
    }
    tmux::attach(&name)
}

/// Ask on the controlling terminal. `Err` when there is none.
fn confirm(prompt: &str) -> Result<bool> {
    let tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| Error::exit(3, "no terminal to confirm on (use -f)"))?;
    let mut w = &tty;
    write!(w, "{prompt} [y/N] ")?;
    w.flush()?;
    let mut line = String::new();
    std::io::BufReader::new(&tty).read_line(&mut line)?;
    Ok(matches!(line.trim(), "y" | "Y" | "yes" | "YES" | "Yes"))
}

pub fn kill(q: &str, force: bool) -> Result<()> {
    let name = resolve(q)?;
    if !force && !crate::core::hosts::dry_run() {
        let ok = confirm(&format!("kill session {name} on {}?", where_label())).map_err(
            |e| match e {
                Error::Exit(c, m) => Error::exit(c, format!("kill: {m}")),
                e => e,
            },
        )?;
        if !ok {
            note("aborted");
            return Ok(());
        }
    }
    tmux::kill_session(&name)?;
    if !crate::core::hosts::dry_run() {
        println!("killed: {name}");
    }
    Ok(())
}

/// Renames a tmux session. When it is one Claude session's own (one window, one
/// pane, Claude in it) the rename goes through the *title* instead — Claude's
/// `/rename`, then the tmux name follows as its slug — because the tmux name is
/// derived from the title and would otherwise be overwritten on the next title
/// change. A busy/waiting Claude session can't take `/rename`, so then only tmux
/// is renamed, with a note. Any other tmux session is renamed as asked.
pub fn rename(q: &str, new: &str) -> Result<()> {
    let name = tmux::sanitize_name(new);
    if name.is_empty() {
        return Err(Error::exit(
            1,
            "rename: session name is empty after sanitising",
        ));
    }
    let old = resolve(q)?;
    if old.eq_ignore_ascii_case("fleet") {
        note("renaming 'fleet' breaks anything bound to it (e.g. a switch-client key binding)");
    }
    if old != name && tmux::has_session(&name) {
        return Err(Error::exit(
            1,
            format!(
                "a session named '{name}' already exists on {}",
                where_label()
            ),
        ));
    }
    if !crate::core::hosts::dry_run()
        && let Some(s) = title::sole_claude_in(&old)
    {
        let t = title::clean_title(new)?;
        let opts = title::RenameOpts {
            sync_tmux: true,
            force: false,
        };
        match title::apply_rename(&s, &t, opts) {
            Ok(outcome @ title::RenameOutcome::Sent(_)) => {
                println!("renamed Claude session {} → {t}", s.headline());
                if let Some(n) = outcome.tmux_note() {
                    println!("{n}");
                }
                return Ok(());
            }
            Ok(title::RenameOutcome::Held(_, why)) => note(&format!(
                "Claude title unchanged ({why}); renaming tmux only — the next title change overwrites it"
            )),
            Err(e) => note(&format!("Claude title unchanged ({e}); renaming tmux only")),
        }
    }
    tmux::rename_session(&old, &name)?;
    if !crate::core::hosts::dry_run() {
        println!("renamed: {old} → {name}");
    }
    Ok(())
}

pub struct StaleOpts {
    pub kill: bool,
    pub force: bool,
    pub quiet: bool,
    pub json: bool,
    pub claude_check: bool,
    pub older_than: String,
}

fn span_label(v: &str) -> String {
    if v.ends_with(['m', 'h', 'd']) {
        v.to_string()
    } else {
        format!("{v}h")
    }
}

pub fn render_stale(r: &StaleReport, label: &str, killing: bool) -> String {
    if r.candidates.is_empty() {
        return "no stale sessions".into();
    }
    let mut out = Vec::new();
    out.push(format!(
        "stale candidates (idle > {label}, {}):",
        if r.claude_checked {
            "no Claude session"
        } else {
            "CLAUDE CHECK SKIPPED"
        }
    ));
    let w = r
        .candidates
        .iter()
        .map(|c| crate::cli::render::width_of(&c.name))
        .max()
        .unwrap_or(12)
        .clamp(12, 28);
    for c in &r.candidates {
        out.push(format!(
            "  {} {} {}",
            pad(&c.name, w),
            pad(&format!("{}w", c.windows), 4),
            format!(
                "{}  {}",
                pad(&format!("idle {}", tmux::dur(c.idle_secs)), 8),
                c.command
            )
            .dimmed()
        ));
    }
    let mut kept: Vec<String> = r
        .kept
        .iter()
        .filter(|k| matches!(k.class, KeptClass::Claude | KeptClass::Infra))
        .map(|k| format!("{} ({})", k.name, k.reason))
        .collect();
    let rest: Vec<_> = r
        .kept
        .iter()
        .filter(|k| !matches!(k.class, KeptClass::Claude | KeptClass::Infra))
        .collect();
    if r.kept.len() <= 6 {
        kept.extend(rest.iter().map(|k| format!("{} ({})", k.name, k.reason)));
    } else {
        for (class, what) in [
            (KeptClass::Here, "you are here"),
            (KeptClass::Attached, "attached"),
            (KeptClass::Running, "running work"),
            (KeptClass::Recent, "recently used"),
            (KeptClass::Unknown, "no pane info"),
        ] {
            let n = rest.iter().filter(|k| k.class == class).count();
            if n > 0 {
                kept.push(format!("{n} {what}"));
            }
        }
    }
    if !kept.is_empty() {
        out.push(format!("kept: {}", kept.join(", ")).dimmed().to_string());
    }
    if !killing {
        let n = r.candidates.len();
        out.push(format!(
            "{n} candidate{} — close {} with: fleet tmux stale --kill",
            if n == 1 { "" } else { "s" },
            if n == 1 { "it" } else { "them" }
        ));
    }
    out.join("\n")
}

pub fn stale(o: StaleOpts) -> Result<()> {
    let thr = tmux::parse_span(&o.older_than).map_err(|e| Error::exit(1, format!("stale: {e}")))?;
    let label = span_label(o.older_than.trim());
    // Skipping the cross-check turns --force into an unattended mass kill.
    if !o.claude_check && o.kill && o.force {
        return Err(Error::exit(
            1,
            "--no-fleet-check with -f would kill unattended with no live-Claude check\n     drop one of them — without the check every kill is confirmed by hand",
        ));
    }
    let input = tmux::stale_input(o.claude_check).map_err(|e| Error::exit(127, e.to_string()))?;
    if input.sessions.is_empty() {
        if !o.quiet && !o.json {
            note(&format!("no tmux sessions on {}", where_label()));
        }
        if o.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&tmux::classify(&input, thr))?
            );
        }
        return Ok(());
    }
    let report = tmux::classify(&input, thr);
    let why = report.claude_problem.clone().unwrap_or_default();
    // Without a trustworthy cross-check a busy Claude session is
    // indistinguishable from junk — refuse the kill, and the kill-safe-looking
    // -q list too.
    if !report.claude_checked && o.claude_check && (o.kill || o.quiet) {
        return Err(Error::exit(
            1,
            format!(
                "refusing to {}: cannot check for live Claude sessions ({why})\n     re-run with --no-fleet-check to override (kills are confirmed one by one)",
                if o.kill { "kill" } else { "list" }
            ),
        ));
    }
    if o.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        if !o.kill {
            return Ok(());
        }
    } else if o.quiet {
        for c in &report.candidates {
            println!("{}", c.name);
        }
    } else {
        if !report.claude_checked {
            note(&format!(
                "live-Claude check SKIPPED ({why}) — a listed session may be doing real work"
            ));
        }
        println!("{}", render_stale(&report, &label, o.kill));
    }
    if !o.kill || report.candidates.is_empty() {
        return Ok(());
    }

    // Confirm everything first, then kill in one pass with a fresh re-check per
    // session at the moment of the kill.
    let warn = if report.claude_checked {
        ""
    } else {
        ", CLAUDE CHECK SKIPPED"
    };
    let mut chosen = Vec::new();
    for c in &report.candidates {
        if o.force || crate::core::hosts::dry_run() {
            chosen.push(c.name.clone());
            continue;
        }
        let yes = confirm(&format!(
            "kill '{}' (idle {}{warn})?",
            c.name,
            tmux::dur(c.idle_secs)
        ))
        .map_err(|e| match e {
            Error::Exit(code, m) => Error::exit(code, format!("stale: {m}")),
            e => e,
        })?;
        if yes {
            chosen.push(c.name.clone());
        }
    }
    let mut killed = 0;
    for name in chosen {
        if crate::core::hosts::dry_run() {
            tmux::kill_session(&name)?;
            continue;
        }
        match tmux::kill_if_still_stale(&name) {
            tmux::KillOutcome::Killed => {
                killed += 1;
                println!("killed: {name}");
            }
            tmux::KillOutcome::Skipped(why) => {
                note(&format!("'{name}' {why} — skipped"));
                println!("skipped: {name}");
            }
        }
    }
    if killed == 0 && !crate::core::hosts::dry_run() {
        note("nothing killed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_ages() {
        assert_eq!(rel(1000, 0), "never");
        assert_eq!(rel(1000, 990), "just now");
        assert_eq!(rel(10_000, 10_000 - 180), "3m ago");
        assert_eq!(rel(100_000, 100_000 - 7200), "2h ago");
        assert_eq!(rel(1_000_000, 1_000_000 - 3 * 86400), "3d ago");
    }

    #[test]
    fn span_labels() {
        assert_eq!(span_label("24"), "24h");
        assert_eq!(span_label("30m"), "30m");
    }

    fn ses(names: &[&str]) -> HostList {
        Ok(names
            .iter()
            .map(|n| TmuxSession {
                name: n.to_string(),
                ..Default::default()
            })
            .collect())
    }

    fn others(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// A fake host table; `calls` records which hosts were asked.
    fn fake<'a>(
        table: Vec<(&'static str, HostList)>,
        calls: &'a std::sync::Mutex<Vec<String>>,
    ) -> impl Fn(&str) -> HostList + Sync + 'a {
        move |h: &str| {
            calls.lock().unwrap().push(h.to_string());
            table
                .iter()
                .find(|(n, _)| *n == h)
                .map(|(_, r)| r.clone())
                .unwrap_or_else(|| Err("unknown".into()))
        }
    }

    #[test]
    fn a_match_on_the_default_host_never_asks_the_others() {
        let calls = std::sync::Mutex::new(Vec::new());
        let f = fake(
            vec![("ws", ses(&["api", "web"])), ("laptop", ses(&["api"]))],
            &calls,
        );
        let s = search_hosts("api", "ws", &others(&["laptop"]), f);
        assert_eq!(
            s.found,
            Found::One {
                host: "ws".into(),
                name: "api".into(),
                elsewhere: false
            }
        );
        assert_eq!(*calls.lock().unwrap(), vec!["ws".to_string()]);

        // Ambiguous on the default host stays ambiguous there.
        let calls = std::sync::Mutex::new(Vec::new());
        let f = fake(vec![("ws", ses(&["api-1", "api-2"]))], &calls);
        let s = search_hosts("api", "ws", &others(&["laptop"]), f);
        assert!(matches!(s.found, Found::Many { elsewhere: false, ref hits } if hits.len() == 2));
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn no_match_on_the_default_host_falls_back_to_the_others() {
        let calls = std::sync::Mutex::new(Vec::new());
        let f = fake(
            vec![
                ("ws", ses(&["web"])),
                ("laptop", ses(&["update-school-schedule"])),
                ("box", ses(&["other"])),
            ],
            &calls,
        );
        let s = search_hosts("school", "ws", &others(&["laptop", "box"]), f);
        assert_eq!(
            s.found,
            Found::One {
                host: "laptop".into(),
                name: "update-school-schedule".into(),
                elsewhere: true
            }
        );
        assert_eq!(s.listed.len(), 3);
    }

    #[test]
    fn tiers_rank_across_hosts() {
        let calls = std::sync::Mutex::new(Vec::new());
        // exact on one host beats a prefix on another
        let f = fake(
            vec![
                ("ws", ses(&[])),
                ("laptop", ses(&["foo-bar"])),
                ("box", ses(&["foo"])),
            ],
            &calls,
        );
        let s = search_hosts("foo", "ws", &others(&["laptop", "box"]), f);
        assert_eq!(
            s.found,
            Found::One {
                host: "box".into(),
                name: "foo".into(),
                elsewhere: true
            }
        );
        // same tier on two hosts → ambiguous, with hosts
        let f = fake(
            vec![
                ("ws", ses(&[])),
                ("laptop", ses(&["dup"])),
                ("box", ses(&["dup"])),
            ],
            &calls,
        );
        let s = search_hosts("dup", "ws", &others(&["laptop", "box"]), f);
        assert_eq!(
            s.found,
            Found::Many {
                hits: vec![
                    ("laptop".into(), "dup".into()),
                    ("box".into(), "dup".into())
                ],
                elsewhere: true
            }
        );
    }

    #[test]
    fn unreachable_hosts_are_reported_not_fatal() {
        let calls = std::sync::Mutex::new(Vec::new());
        let f = fake(
            vec![
                ("ws", Err("timed out after 5s".into())),
                ("laptop", ses(&["app"])),
                ("box", Err("unreachable".into())),
            ],
            &calls,
        );
        let s = search_hosts("app", "ws", &others(&["laptop", "box"]), f);
        assert!(matches!(s.found, Found::One { ref host, .. } if host == "laptop"));
        let failed: Vec<&str> = s.failed.iter().map(|(h, _)| h.as_str()).collect();
        assert_eq!(failed, vec!["ws", "box"]);

        let f = fake(vec![("ws", ses(&["x"])), ("laptop", ses(&["y"]))], &calls);
        let s = search_hosts("zzz", "ws", &others(&["laptop"]), f);
        assert_eq!(s.found, Found::None);
        assert_eq!(s.listed.len(), 2);
    }

    #[test]
    fn listing_marks_attached_sessions() {
        colored::control::set_override(false);
        let v = vec![
            TmuxSession {
                name: "app".into(),
                attached: 1,
                windows: 2,
                ..Default::default()
            },
            TmuxSession {
                name: "old".into(),
                windows: 1,
                last_attached: 100,
                ..Default::default()
            },
        ];
        let out = format_sessions(&v, 100 + 7200);
        assert!(out.contains("● app"), "{out}");
        assert!(out.contains("attached"), "{out}");
        assert!(out.contains("○ old"), "{out}");
        assert!(out.contains("2h ago"), "{out}");
    }
}
