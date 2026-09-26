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
