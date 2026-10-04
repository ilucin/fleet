//! `fleet restore` — the dormant sessions a reboot left behind (see
//! [`crate::core::snapshot`]): list them, bring one or all back, or forget them.
//!
//! Exit codes: 1 a restore failed, 2 ambiguous target, 3 no dormant session matches,
//! 127 tmux missing.

use colored::Colorize;
use serde_json::json;

use crate::cli::commands::{host_label, resolve_launcher};
use crate::cli::render::home_rel;
use crate::core::snapshot::{self, DormantView, Restored, Snapshot, Target};
use crate::error::{Error, Result};

pub struct RestoreOpts {
    pub target: Option<String>,
    pub all: bool,
    pub forget: Option<String>,
    pub forget_all: bool,
    pub json: bool,
}

pub fn run(o: RestoreOpts) -> Result<()> {
    if o.forget_all || o.forget.is_some() {
        return forget(o.forget.as_deref(), o.json);
    }
    // Record first: the first command after a reboot is what turns the old boot dormant.
    let snap = snapshot::refresh()?;
    match (o.target.as_deref(), o.all) {
        (Some(q), _) => {
            let t = snapshot::resolve(&snap, q)?;
            restore_all(&snap, vec![t], o.json)
        }
        (None, true) => {
            let targets = dormant_targets(&snap);
            if targets.is_empty() {
                if o.json {
                    return print(&json!({ "host": host_label(), "restored": [], "failed": [] }));
                }
                println!("nothing dormant on {}", host_label());
                return Ok(());
            }
            restore_all(&snap, targets, o.json)
        }
        (None, false) => list(&snap, o.json),
    }
}

fn print(v: &serde_json::Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

/// Every dormant entry as a restore target, in [`snapshot::dormant_views`] order.
fn dormant_targets(snap: &Snapshot) -> Vec<Target> {
    snapshot::dormant_views(snap)
        .into_iter()
        .map(|v| match v.kind {
            "tmux" => Target::Tmux(v.target),
            _ => Target::Claude(v.target),
        })
        .collect()
}

/// "3h ago" for an ISO time; empty when it doesn't parse.
fn ago(iso: Option<&str>) -> String {
    iso.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| crate::cli::tmux::rel(chrono::Utc::now().timestamp(), t.timestamp()))
        .unwrap_or_default()
}

/// The dormant list, one entry per line with its Claude sessions under it.
pub fn render(views: &[DormantView]) -> String {
    let w = views
        .iter()
        .map(|v| crate::cli::render::width_of(&v.name))
        .max()
        .unwrap_or(12)
        .clamp(12, 36);
    let mut out = Vec::new();
    for v in views {
        let shape = if v.kind == "tmux" {
            format!("{}w {}p", v.windows, v.panes)
        } else {
            "claude".into()
        };
        let claude = match (v.kind, v.sessions.len()) {
            ("claude", _) => String::new(),
            (_, 0) => "no claude".into(),
            (_, n) => format!("{n} claude"),
        };
        out.push(format!(
            "◌ {} {}  {}  {}",
            crate::cli::tmux::pad(&v.name, w),
            crate::cli::tmux::pad(&shape, 7),
            crate::cli::tmux::pad(&claude, 9),
            format!("since {}", ago(v.since.as_deref())).dimmed()
        ));
        if v.kind == "tmux" {
            for s in &v.sessions {
                let title = s
                    .title
                    .clone()
                    .or_else(|| s.name.clone())
                    .unwrap_or_else(|| s.session_id.chars().take(8).collect());
                out.push(
                    format!(
                        "    · {title}  {}",
                        s.cwd.as_deref().map(home_rel).unwrap_or_default()
                    )
                    .dimmed()
                    .to_string(),
                );
            }
        } else if let Some(cwd) = v.sessions.first().and_then(|s| s.cwd.as_deref()) {
            out.push(format!("    · {}", home_rel(cwd)).dimmed().to_string());
        }
    }
    out.join("\n")
}

fn list(snap: &Snapshot, json: bool) -> Result<()> {
    let views = snapshot::dormant_views(snap);
    if json {
        return print(&json!({
            "host": host_label(),
            "bootId": snap.boot_id,
            "dormant": views,
        }));
    }
    if views.is_empty() {
        println!("nothing dormant on {}", host_label());
        return Ok(());
    }
    println!(
        "dormant on {} — running before the last reboot:",
        host_label()
    );
    println!("{}", render(&views));
    println!(
        "{}",
        "bring back: fleet restore <name> | --all · drop: fleet restore --forget <name>".dimmed()
    );
    Ok(())
}

fn restore_all(snap: &Snapshot, targets: Vec<Target>, json: bool) -> Result<()> {
    let launcher = resolve_launcher();
    let mut done: Vec<Restored> = Vec::new();
    let mut failed = Vec::new();
    let single = targets.len() == 1;
    for t in &targets {
        match snapshot::restore(snap, t, &launcher) {
            Ok(r) => {
                if !json {
                    say(&r);
                }
                done.push(r);
            }
            // One target: its own exit code (2/3/127) is the answer.
            Err(e) if single && !json => return Err(e),
            Err(e) => {
                if !json {
                    eprintln!("{} {}: {e}", "fleet:".red(), t.label(snap));
                }
                failed.push(json!({ "target": t.label(snap), "error": e.to_string() }));
            }
        }
    }
    if json {
        print(&json!({ "host": host_label(), "restored": done, "failed": failed }))?;
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(Error::exit(1, ""))
    }
}

/// One restore, for a human.
fn say(r: &Restored) {
    for w in &r.warnings {
        eprintln!("{} {w}", "fleet:".yellow());
    }
    let shape = format!(
        "{} window{}, {} pane{}, {} Claude session{} resumed",
        r.windows,
        if r.windows == 1 { "" } else { "s" },
        r.panes,
        if r.panes == 1 { "" } else { "s" },
        r.launched.len(),
        if r.launched.len() == 1 { "" } else { "s" },
    );
    if r.dry_run {
        for c in &r.commands {
            println!("{c}");
        }
        println!(
            "dry-run: would restore {} as tmux session {} ({shape})",
            r.from, r.session
        );
        return;
    }
    let as_ = if r.renamed {
        format!(" as {}", r.session.bold())
    } else {
        String::new()
    };
    println!("restored {}{as_} ({shape})", r.from.bold());
    println!(
        "{}",
        format!(
            "attach: fleet enter {}",
            crate::core::tools::shq_min(&r.session)
        )
        .dimmed()
    );
}

fn forget(target: Option<&str>, json: bool) -> Result<()> {
    let t = match target {
        Some(q) => Some(snapshot::resolve(&snapshot::current()?, q)?),
        None => None,
    };
    let gone = snapshot::forget(t.as_ref())?;
    if json {
        return print(&json!({ "host": host_label(), "forgotten": gone }));
    }
    let dry = if crate::core::hosts::dry_run() {
        "dry-run: would forget"
    } else {
        "forgot"
    };
    if gone.is_empty() {
        println!("nothing dormant on {}", host_label());
    } else {
        for g in gone {
            println!("{dry}: {g}");
        }
    }
    Ok(())
}
