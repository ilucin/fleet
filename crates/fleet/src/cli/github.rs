//! `fleet github`: GitHub links — a session follows one pull request, as the bridge host's `gh`
//! account.
//!
//! The bridge lives in the web server of the `github.host` machine (`web/lib/github.mjs`): it
//! polls that account's notifications and types what is for it (a review request, a reply in
//! its review thread, a mention) into the linked session. These commands are its client: they
//! ask this machine's web server, which proxies to that host. The session answers on GitHub
//! with `gh` itself.

use colored::Colorize;
use serde_json::{Value, json};

use crate::cli::slack::{ok_or_err, request};
use crate::core::discovery;
use crate::error::{Error, Result};

fn link_line(l: &Value) -> String {
    let who = l["sessionName"]
        .as_str()
        .or(l["session"].as_str())
        .unwrap_or("?");
    let mut extra = Vec::new();
    if l["asleep"].as_bool() == Some(true) {
        extra.push("asleep".to_string());
    }
    if let Some(k) = l["keep"].as_i64() {
        extra.push(format!("sleeps after {}", minutes(k)));
    }
    if let Some(n) = l["pending"].as_i64().filter(|n| *n > 0) {
        extra.push(format!("{n} waiting"));
    }
    if let Some(by) = l["startedBy"]["login"].as_str() {
        extra.push(format!("requested by @{by}"));
    }
    format!(
        "{}  {}  {}{}",
        l["id"].as_str().unwrap_or("?").bold(),
        who,
        l["url"].as_str().unwrap_or("?"),
        if extra.is_empty() {
            String::new()
        } else {
            format!("  ({})", extra.join(", "))
        }
    )
}

fn minutes(m: i64) -> String {
    match m {
        m if m % 1440 == 0 => format!("{}d", m / 1440),
        m if m % 60 == 0 => format!("{}h", m / 60),
        m => format!("{m}m"),
    }
}

/// `fleet github [list]`.
pub fn list(json: bool) -> Result<()> {
    let (status, v) = request("GET", "/api/github", None)?;
    ok_or_err(&status, &v)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&v)?);
        return Ok(());
    }
    if v["enabled"].as_bool() != Some(true) {
        let why = v["error"]
            .as_str()
            .unwrap_or("no host runs them — set github.host in the config");
        println!("GitHub links are off: {why}");
        return Ok(());
    }
    let poll = match v["error"].as_str() {
        Some(e) => format!("{} ({e})", "failing".red()),
        None => "polling".green().to_string(),
    };
    println!(
        "GitHub bridge on {} as @{}: {poll}",
        v["host"].as_str().unwrap_or("?"),
        v["login"].as_str().unwrap_or("?")
    );
    match v["spawn"]["from"].as_array() {
        Some(from) if !from.is_empty() => {
            let names: Vec<&str> = from.iter().filter_map(Value::as_str).collect();
            println!("review requests start sessions from: {}", names.join(", "));
        }
        _ => println!("review requests start no sessions (github.spawn)"),
    }
    let links = v["links"].as_array().cloned().unwrap_or_default();
    if links.is_empty() {
        println!("no active links");
    }
    for l in &links {
        println!("{}", link_line(l));
    }
    Ok(())
}

/// `fleet github link <pr> [--session <target>] [--task <text>] [--keep <duration>]`.
pub fn link(
    url: &str,
    session: Option<&str>,
    task: Option<&str>,
    keep: Option<&str>,
    json: bool,
) -> Result<()> {
    let mut body = json!({ "url": url });
    if let Some(t) = task {
        body["task"] = json!(t);
    }
    if let Some(k) = keep {
        body["keep"] = json!(k);
    }
    match session {
        Some(q) => {
            let s = discovery::resolve(q).map_err(Error::Other)?;
            let id = s
                .session_id
                .clone()
                .ok_or_else(|| Error::Other(format!("{} has no session id yet", s.headline())))?;
            body["session"] = json!(id);
        }
        None => {
            let pane = crate::core::done::own_pane_from_env(None).ok_or_else(|| {
                Error::Other(
                    "not inside a tmux session — name the session to link: --session <target>"
                        .into(),
                )
            })?;
            body["pane"] = json!(pane);
        }
    }
    body["host"] = json!(crate::core::config::get().self_name());
    let (status, v) = request("POST", "/api/github/link", Some(&body))?;
    ok_or_err(&status, &v)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        let verb = if v["renewed"].as_bool() == Some(true) {
            "renewed"
        } else {
            "linked"
        };
        println!("{verb}: {}", link_line(&v));
    }
    Ok(())
}

/// `fleet github unlink <link>`.
pub fn unlink(id: &str, json: bool) -> Result<()> {
    let (status, v) = request(
        "POST",
        &format!(
            "/api/github/links/{}/unlink",
            crate::cli::brief::path_segment(id)
        ),
        Some(&json!({})),
    )?;
    ok_or_err(&status, &v)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else {
        println!("unlinked {}", id.bold());
    }
    Ok(())
}
