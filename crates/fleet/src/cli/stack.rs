//! `fleet stack`: session stacks — sessions that share one context file, the StackBrief
//! (docs/architecture.md → "Session stacks"). The logic lives in `core::stack`; this is argument
//! handling, the text / JSON output, the editor round trip and the sibling spawn.

use std::collections::HashSet;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use colored::Colorize;
use serde_json::{Value, json};

use crate::cli::commands::{self, SpawnOpts, host_label};
use crate::cli::config_cmd;
use crate::cli::render::home_rel;
use crate::core::backend::{self, Prompt};
use crate::core::brief;
use crate::core::config;
use crate::core::discovery::{self, Session};
use crate::core::hosts::{self, Remote, Target, Tty};
use crate::core::naming;
use crate::core::stack::{self, EXIT_AMBIGUOUS, EXIT_NOTHING, Paths, Stack};
use crate::core::title;
use crate::error::{Error, Result};

/// How long a sibling spawn waits for the new session to register (like `handoff`).
const AWAIT: Duration = Duration::from_secs(75);

/// One discovery and the paths, shared by every subcommand.
struct Ctx {
    dir: PathBuf,
    paths: Paths,
    rows: Vec<Session>,
    /// `false` when the registry could not be read: nothing may be marked closed then.
    rows_ok: bool,
    /// This machine's config `self` (what goes into the files).
    me: String,
    /// The name rows are tagged with (the caller's name for this host).
    label: String,
}

impl Ctx {
    fn new() -> Result<Self> {
        let (mut rows, rows_ok) = match discovery::discover_checked() {
            Ok(r) => (r, true),
            Err(e) => {
                eprintln!("{}", format!("warning: {e}").yellow());
                (Vec::new(), false)
            }
        };
        naming::stamp_titles(&mut rows);
        title::stamp_display_titles(&mut rows);
        Ok(Ctx {
            dir: stack::stacks_dir()?,
            paths: Paths::current(),
            rows,
            rows_ok,
            me: config::get().self_name(),
            label: host_label(),
        })
    }

    /// Reconcile members with the live sessions (writes only what changed; nothing on a
    /// dry run or when discovery failed). → the ids that changed.
    fn sync(&self) -> Result<Vec<String>> {
        if !self.rows_ok {
            return Ok(Vec::new());
        }
        stack::sync(
            &self.dir,
            &self.rows,
            &brief::iso_now(),
            &self.paths,
            !hosts::dry_run(),
        )
    }

    fn stacks(&self) -> Vec<Stack> {
        stack::load_all(&self.dir)
    }

    fn path_of(&self, s: &Stack) -> PathBuf {
        self.dir.join(format!("{}.md", s.id()))
    }

    fn view(&self, s: &Stack) -> Value {
        let path = self.path_of(s);
        stack::view(
            s,
            &stack::ViewCtx {
                host_label: &self.label,
                rows: &self.rows,
                paths: &self.paths,
                path: &path,
            },
        )
    }

    fn resolve(&self, q: &str) -> Result<Stack> {
        let all = self.stacks();
        stack::resolve(&all, &self.rows, q).cloned()
    }

    /// A live session target — an ambiguous one is exit 2 with the candidates.
    fn session(&self, target: &str) -> Result<Session> {
        let s = discovery::resolve_in(self.rows.clone(), target).map_err(|e| {
            if stack::is_ambiguous_session(&e) {
                Error::exit(EXIT_AMBIGUOUS, e)
            } else {
                Error::Other(e)
            }
        })?;
        if s.session_id
            .as_deref()
            .is_none_or(|id| !brief::is_session_id(id))
        {
            return Err(Error::Other(format!(
                "{} has no session id yet",
                s.headline()
            )));
        }
        Ok(s)
    }

    /// Write `s` (stamps `updated`), or say what would be written on a dry run.
    fn save(&self, s: &mut Stack) -> Result<()> {
        let now = brief::iso_now();
        if hosts::dry_run() {
            s.meta.insert("updated".into(), Value::String(now));
            eprintln!("dry-run: would write {}", self.path_of(s).display());
            return Ok(());
        }
        stack::save(&self.dir, s, &now, &self.paths)
    }
}

fn print_json(v: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn with(mut v: Value, extra: Value) -> Value {
    if let (Value::Object(o), Value::Object(e)) = (&mut v, extra) {
        o.extend(e);
    }
    v
}

fn counts(s: &Stack) -> String {
    let (live, closed) = s.counts();
    if closed == 0 {
        format!("{live} live")
    } else {
        format!("{live} live · {closed} closed")
    }
}

// ------------------------------------------------------------------ list / show / sync

/// `fleet stack list`
pub fn list(json: bool) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let stacks = c.stacks();
    if json {
        return print_json(&json!({
            "host": c.label,
            "stacks": stacks.iter().map(|s| c.view(s)).collect::<Vec<_>>(),
        }));
    }
    if stacks.is_empty() {
        println!(
            "no stacks on {} — start one with `fleet stack spawn <session> \"<prompt>\"`",
            c.label
        );
        return Ok(());
    }
    let mut sorted = stacks;
    sorted.sort_by_key(|s| std::cmp::Reverse(s.meta_str("updated").unwrap_or_default()));
    for s in &sorted {
        println!(
            "{}  {}  {}  {}  {}",
            s.label().bold(),
            s.id().dimmed(),
            counts(s),
            s.meta_str("cwd").unwrap_or_else(|| "-".into()).dimmed(),
            s.meta_str("updated")
                .map(|u| u.chars().take(16).collect::<String>().replace('T', " "))
                .unwrap_or_default()
                .dimmed()
        );
    }
    Ok(())
}

/// `fleet stack show <stack> [--path]`
pub fn show(q: &str, json: bool, path_only: bool) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let s = c.resolve(q)?;
    if path_only {
        println!("{}", c.path_of(&s).display());
    } else if json {
        print_json(&c.view(&s))?;
    } else {
        print!("{}", stack::serialize_body(&s, &c.paths));
    }
    Ok(())
}

/// `fleet stack sync`
pub fn sync(json: bool) -> Result<()> {
    let c = Ctx::new()?;
    if !c.rows_ok {
        return Err(Error::Other(
            "cannot read the session registry — nothing synced".into(),
        ));
    }
    let changed = c.sync()?;
    if json {
        let stacks = c.stacks();
        return print_json(&json!({
            "host": c.label,
            "changed": changed,
            "stacks": stacks.iter().map(|s| c.view(s)).collect::<Vec<_>>(),
        }));
    }
    if changed.is_empty() {
        println!("stacks are in sync");
    } else {
        println!("updated {}", changed.join(", "));
    }
    Ok(())
}

// ------------------------------------------------------------------ new / ensure

/// What creating (or finding) a stack yielded.
struct Ensured {
    stack: Stack,
    created: bool,
    generated: bool,
    warning: Option<String>,
}

impl Ensured {
    /// `new` / `ensure --json`: the StackView with `created` (bool: made by this call),
    /// `generated`, `warning` — and, since `created` shadows the StackView's timestamp of the
    /// same name, that timestamp as `createdAt` and the untouched StackView as `stack`.
    fn json(&self, view: Value) -> Value {
        let created_at = view.get("created").cloned().unwrap_or(Value::Null);
        with(
            view.clone(),
            json!({
                "created": self.created,
                "createdAt": created_at,
                "generated": self.generated,
                "warning": self.warning,
                "stack": view,
            }),
        )
    }
}

/// Create a stack around the live session `s`: the model writes Summary / Resources (unless
/// told not to, or it fails — then the skeleton). Never fails over the model.
fn create_around(c: &Ctx, s: &Session, label: Option<&str>, no_llm: bool) -> Result<Ensured> {
    let sid = s.session_id.clone().unwrap_or_default();
    let cwd_abs = s
        .cwd
        .clone()
        .ok_or_else(|| Error::Other(format!("no working directory known for {}", s.headline())))?;
    let cwd = c.paths.tilde(&cwd_abs);
    let git = std::path::Path::new(&cwd_abs)
        .is_dir()
        .then(|| stack::git_line(&cwd_abs, &c.paths))
        .flatten();
    let cfg = &config::get().stacks;
    let allow_llm = !no_llm && !discovery::is_fixture() && cfg.enabled() && !hosts::dry_run();
    let mut warning = None;
    let mut generated = false;
    let content = if allow_llm {
        let input = stack::GenInput {
            title: s.headline(),
            cwd: cwd.clone(),
            host: c.me.clone(),
            git: git.clone(),
            first_prompt: s.title.clone(),
            brief: brief::briefs_dir()
                .ok()
                .and_then(|d| brief::read(&d, &sid).ok().flatten())
                .map(|t| brief::parse_frontmatter(&t).1),
            conversation: crate::core::context::locate_transcript(
                &c.paths.claude_home,
                s.cwd.as_deref(),
                &sid,
            )
            .map(|p| stack::conversation_tail(&p, stack::TAIL_CHARS))
            .unwrap_or_default(),
        };
        match stack::generate(&input, &cfg.model()) {
            Ok(g) => {
                generated = true;
                g
            }
            Err(e) => {
                warning = Some(format!(
                    "StackBrief generation failed ({e}) — wrote the skeleton; edit it with `fleet stack edit`"
                ));
                stack::skeleton(&s.headline(), &cwd, git.as_deref())
            }
        }
    } else {
        stack::skeleton(&s.headline(), &cwd, git.as_deref())
    };
    let label = label
        .and_then(stack::clean_label)
        .or_else(|| content.label.clone())
        .or_else(|| stack::clean_label(&s.headline()))
        .unwrap_or_else(|| "stack".into());
    let now = brief::iso_now();
    let id = stack::new_id(&c.dir);
    let member = stack::member_for(s, &c.me, &now, &c.paths)
        .ok_or_else(|| Error::Other(format!("{} has no session id yet", s.headline())))?;
    let mut st = stack::new_stack(stack::NewStack {
        id: &id,
        label: &label,
        host: &c.me,
        cwd: &cwd,
        now: &now,
        member,
        content: &content,
        generated,
    });
    c.save(&mut st)?;
    Ok(Ensured {
        stack: st,
        created: true,
        generated,
        warning,
    })
}

/// The session's stack, or a new one around it.
fn ensure_for(c: &Ctx, s: &Session, label: Option<&str>, no_llm: bool) -> Result<Ensured> {
    let all = c.stacks();
    let sid = s.session_id.as_deref().unwrap_or_default();
    if let Some(st) = stack::stack_of(&all, sid) {
        return Ok(Ensured {
            stack: st.clone(),
            created: false,
            generated: false,
            warning: None,
        });
    }
    create_around(c, s, label, no_llm)
}

fn report_ensured(c: &Ctx, e: &Ensured, s: &Session, json: bool) -> Result<()> {
    if json {
        return print_json(&e.json(c.view(&e.stack)));
    }
    if let Some(w) = &e.warning {
        eprintln!("{}", format!("warning: {w}").yellow());
    }
    let path = c.path_of(&e.stack);
    if e.created {
        println!(
            "created stack {} ({}) around {} — {}",
            e.stack.label().bold(),
            e.stack.id(),
            s.headline().bold(),
            home_rel(&path.display().to_string()).dimmed()
        );
    } else {
        println!(
            "{} is in stack {} ({}) — {}",
            s.headline().bold(),
            e.stack.label().bold(),
            e.stack.id(),
            home_rel(&path.display().to_string()).dimmed()
        );
    }
    Ok(())
}

/// `fleet stack new --from <target>`
pub fn new(from: &str, label: Option<&str>, no_llm: bool, json: bool) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let s = c.session(from)?;
    let all = c.stacks();
    if let Some(st) = stack::stack_of(&all, s.session_id.as_deref().unwrap_or_default()) {
        return Err(Error::Other(format!(
            "{} is already in stack {} ({}) — `fleet stack show {}`, or spawn a sibling with `fleet stack spawn`",
            s.headline(),
            st.label(),
            st.id(),
            st.id()
        )));
    }
    let e = create_around(&c, &s, label, no_llm)?;
    report_ensured(&c, &e, &s, json)
}

/// `fleet stack ensure <target>`
pub fn ensure(target: &str, label: Option<&str>, no_llm: bool, json: bool) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let s = c.session(target)?;
    let e = ensure_for(&c, &s, label, no_llm)?;
    report_ensured(&c, &e, &s, json)
}

// ------------------------------------------------------------------ add / remove

/// Add live session `s` to the stack with id `id` (re-read from disk). Refuses when `s` is in
/// another stack.
fn add_to(c: &Ctx, id: &str, s: &Session) -> Result<Stack> {
    let sid = s.session_id.clone().unwrap_or_default();
    let all = c.stacks();
    if let Some(other) = all
        .iter()
        .find(|st| st.id() != id && st.member(&sid).is_some_and(|m| m.is_live()))
    {
        return Err(Error::Other(format!(
            "{} is already in stack {} ({}) — `fleet stack remove {} {}` first",
            s.headline(),
            other.label(),
            other.id(),
            other.id(),
            sid
        )));
    }
    let mut st = stack::load(&c.dir, id)?
        .ok_or_else(|| Error::exit(EXIT_NOTHING, format!("stack {id} is gone")))?;
    let m = stack::member_for(s, &c.me, &brief::iso_now(), &c.paths)
        .ok_or_else(|| Error::Other(format!("{} has no session id yet", s.headline())))?;
    if stack::add_member(&mut st, m) {
        c.save(&mut st)?;
    }
    Ok(st)
}

/// `fleet stack add <stack> <target>`
pub fn add(q: &str, target: &str, json: bool) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let st = c.resolve(q)?;
    let s = c.session(target)?;
    let st = add_to(&c, &st.id(), &s)?;
    if json {
        return print_json(&c.view(&st));
    }
    println!(
        "added {} to stack {} ({}, {})",
        s.headline().bold(),
        st.label().bold(),
        st.id(),
        counts(&st)
    );
    Ok(())
}

/// `fleet stack remove <stack> <target|session_id>`
pub fn remove(q: &str, target: &str, json: bool) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let mut st = c.resolve(q)?;
    let t = target.trim().to_lowercase();
    let by_id: Vec<String> = st
        .members
        .iter()
        .filter(|m| {
            let id = m.session.to_lowercase();
            id == t || (t.len() >= 4 && id.starts_with(&t))
        })
        .map(|m| m.session.clone())
        .collect();
    let sid = match by_id.len() {
        1 => by_id[0].clone(),
        n if n > 1 => {
            return Err(Error::exit(
                EXIT_AMBIGUOUS,
                format!(
                    "\"{target}\" matches {n} members: {} — be more specific",
                    by_id.join(", ")
                ),
            ));
        }
        _ => {
            let by_name: Vec<String> = st
                .members
                .iter()
                .filter(|m| m.name.as_deref().is_some_and(|n| n.to_lowercase() == t))
                .map(|m| m.session.clone())
                .collect();
            if by_name.len() == 1 {
                by_name[0].clone()
            } else {
                let s = c.session(target)?;
                s.session_id.unwrap_or_default()
            }
        }
    };
    let Some(pos) = st.members.iter().position(|m| m.session == sid) else {
        return Err(Error::exit(
            EXIT_NOTHING,
            format!(
                "{target} is not a member of stack {} ({})",
                st.label(),
                st.id()
            ),
        ));
    };
    let gone = st.members.remove(pos);
    c.save(&mut st)?;
    if json {
        return print_json(&c.view(&st));
    }
    println!(
        "removed {} from stack {} ({})",
        gone.name.unwrap_or(gone.session).bold(),
        st.label().bold(),
        counts(&st)
    );
    Ok(())
}

// ------------------------------------------------------------------ set / edit / rm

/// Save `text` as a human edit of the stack `id`. `expect_updated`: refuse (exit 3, nothing
/// written) unless the stored `updated` still is this.
fn save_edit(c: &Ctx, id: &str, text: &str, expect_updated: Option<&str>) -> Result<Stack> {
    let before = stack::load(&c.dir, id)?
        .ok_or_else(|| Error::exit(EXIT_NOTHING, format!("stack {id} is gone")))?;
    let current = before.meta_str("updated").unwrap_or_default();
    if let Some(want) = expect_updated
        && want != current
    {
        return Err(Error::exit(
            EXIT_NOTHING,
            format!(
                "stack {} ({id}) changed since it was opened (updated {}) — not saved",
                before.label(),
                if current.is_empty() { "-" } else { &current }
            ),
        ));
    }
    let now = brief::iso_now();
    let mut st = stack::human_edit(&before, text, &now)?;
    if hosts::dry_run() {
        st.meta.insert("updated".into(), Value::String(now));
        eprintln!("dry-run: would write {}:", c.path_of(&st).display());
        print!("{}", stack::serialize_stack(&st, &c.paths));
        return Ok(st);
    }
    stack::save(&c.dir, &mut st, &now, &c.paths)?;
    Ok(st)
}

fn report_saved(c: &Ctx, st: &Stack, json: bool) -> Result<()> {
    if hosts::dry_run() {
        return Ok(());
    }
    if json {
        return print_json(&c.view(st));
    }
    println!("saved stack {} ({})", st.label().bold(), st.id());
    Ok(())
}

/// `fleet stack set <stack> [--expect-updated <iso>]` — markdown on stdin.
pub fn set(q: &str, expect_updated: Option<&str>, json: bool) -> Result<()> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    if text.trim().is_empty() {
        return Err(Error::Other(
            "empty StackBrief on stdin — nothing saved (pipe the markdown in)".into(),
        ));
    }
    let c = Ctx::new()?;
    let st = c.resolve(q)?;
    let id = st.id();
    match save_edit(&c, &id, &text, expect_updated) {
        Ok(saved) => report_saved(&c, &saved, json),
        Err(Error::Exit(EXIT_NOTHING, msg)) if json => {
            // A conflict (or the file vanished): the stored `updated` on stdout, so a caller
            // (the web PUT → 409 `{ error, updated }`) can reload and retry.
            let updated = stack::load(&c.dir, &id)
                .ok()
                .flatten()
                .and_then(|s| s.meta_str("updated"));
            print_json(&json!({ "error": msg, "id": id, "updated": updated }))?;
            Err(Error::Exit(EXIT_NOTHING, msg))
        }
        Err(e) => Err(e),
    }
}

/// Put `body` in a temp file, open the editor, read it back. → (text, temp path).
fn edit_text(body: &str, id: &str) -> Result<(String, PathBuf)> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = std::env::temp_dir().join(format!(
        "fleet-{id}-{}-{}.md",
        std::process::id(),
        chrono::Local::now().format("%H%M%S")
    ));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    f.write_all(body.as_bytes())?;
    drop(f);
    config_cmd::open_editor(&path)?;
    let text = std::fs::read_to_string(&path)?;
    Ok((text, path))
}

fn kept(path: &Path) -> String {
    format!("your edit is kept in {}", path.display())
}

/// `fleet stack edit <stack>`: the body in `$VISUAL` / `$EDITOR`, saved as a human edit. On
/// another host: fetched with `fleet stack show --json` there, edited here, written back with
/// `fleet stack set <id> --expect-updated <updated>`.
pub fn edit(t: &Target, q: &str, json: bool) -> Result<i32> {
    match t {
        Target::Local { .. } => edit_local(q, json).map(|_| 0),
        Target::Remote(r) => edit_remote(r, q, json),
    }
}

fn edit_local(q: &str, json: bool) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let st = c.resolve(q)?;
    if hosts::dry_run() {
        println!(
            "dry-run: would open {} on stack {} ({})",
            config_cmd::editor(),
            st.label(),
            c.path_of(&st).display()
        );
        return Ok(());
    }
    let opened = st.meta_str("updated").unwrap_or_default();
    let body = stack::serialize_body(&st, &c.paths);
    let (text, tmp) = edit_text(&body, &st.id())?;
    if text == body {
        let _ = std::fs::remove_file(&tmp);
        println!("no changes");
        return Ok(());
    }
    match save_edit(&c, &st.id(), &text, Some(&opened)) {
        Ok(saved) => {
            let _ = std::fs::remove_file(&tmp);
            report_saved(&c, &saved, json)
        }
        Err(Error::Exit(code, msg)) => Err(Error::Exit(code, format!("{msg}; {}", kept(&tmp)))),
        Err(e) => Err(Error::Other(format!("{e}; {}", kept(&tmp)))),
    }
}

fn edit_remote(r: &Remote, q: &str, json: bool) -> Result<i32> {
    let fetch = vec![
        "stack".to_string(),
        "show".into(),
        q.to_string(),
        "--json".into(),
    ];
    if hosts::dry_run() {
        let c = hosts::ssh_command(&r.dest, &hosts::remote_fleet_command(r, &fetch), Tty::Never);
        println!("{}", hosts::display_command(&c));
        println!(
            "dry-run: then {} on the body here, and `fleet stack set <id>` on {} with it on stdin",
            config_cmd::editor(),
            r.name
        );
        return Ok(0);
    }
    let got = hosts::capture_remote(r, &fetch, hosts::remote_timeout())?;
    if !got.ok() {
        let code = got
            .code
            .filter(|c| [EXIT_AMBIGUOUS, EXIT_NOTHING].contains(c));
        return Err(Error::exit(
            code.unwrap_or(1),
            format!("{}: {}", r.name, got.why(r)),
        ));
    }
    let v: Value = serde_json::from_str(&got.stdout).map_err(|e| {
        Error::Other(format!(
            "{}: unexpected `fleet stack show --json` output ({e}) — is fleet up to date there? (fleet install --host {})",
            r.name, r.name
        ))
    })?;
    let id = v["id"].as_str().unwrap_or_default().to_string();
    if !stack::is_stack_id(&id) {
        return Err(Error::Other(format!(
            "{}: no stack id in the answer",
            r.name
        )));
    }
    let body = v["body"].as_str().unwrap_or_default().to_string();
    let opened = v["updated"].as_str().unwrap_or_default().to_string();
    let (text, tmp) = edit_text(&body, &id)?;
    if text == body {
        let _ = std::fs::remove_file(&tmp);
        println!("no changes");
        return Ok(0);
    }
    let mut args = vec![
        "stack".to_string(),
        "set".into(),
        id.clone(),
        "--expect-updated".into(),
        opened,
    ];
    if json {
        args.push("--json".into());
    }
    let c = hosts::ssh_command(&r.dest, &hosts::remote_fleet_command(r, &args), Tty::Never);
    hosts::debug(&format!("[{} set] {}", r.name, hosts::display_command(&c)));
    let put = hosts::capture_input(c, Some(text.as_bytes()), hosts::remote_timeout())?;
    if !put.ok() {
        let code = if put.code == Some(EXIT_NOTHING) {
            EXIT_NOTHING
        } else {
            1
        };
        return Err(Error::exit(
            code,
            format!("{}: {}; {}", r.name, put.why(r), kept(&tmp)),
        ));
    }
    let _ = std::fs::remove_file(&tmp);
    print!("{}", put.stdout);
    Ok(0)
}

/// Ask on the controlling terminal. `Err` (exit 3) when there is none.
fn confirm(prompt: &str) -> Result<bool> {
    let tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| Error::exit(EXIT_NOTHING, "no terminal to confirm on (use -f)"))?;
    let mut w = &tty;
    write!(w, "{prompt} [y/N] ")?;
    w.flush()?;
    let mut line = String::new();
    std::io::BufReader::new(&tty).read_line(&mut line)?;
    Ok(matches!(line.trim(), "y" | "Y" | "yes" | "YES" | "Yes"))
}

/// `fleet stack rm <stack> [-f]`
pub fn rm(q: &str, force: bool, json: bool) -> Result<()> {
    if json && !force {
        return Err(Error::Other(
            "`fleet stack rm --json` does not prompt — pass -f".into(),
        ));
    }
    let c = Ctx::new()?;
    let st = c.resolve(q)?;
    let id = st.id();
    if hosts::dry_run() {
        println!("dry-run: would delete {}", c.path_of(&st).display());
        return Ok(());
    }
    if !force
        && !confirm(&format!(
            "delete stack {} ({id}, {})?",
            st.label(),
            counts(&st)
        ))?
    {
        println!("kept");
        return Ok(());
    }
    stack::remove(&c.dir, &id)?;
    if json {
        return print_json(&json!({ "removed": id }));
    }
    println!("deleted stack {} ({id})", st.label().bold());
    Ok(())
}

// ------------------------------------------------------------------ spawn a sibling

pub struct SpawnArgs {
    pub target: String,
    pub prompt: Option<String>,
    pub label: Option<String>,
    pub no_llm: bool,
    pub opts: SpawnOpts,
    pub wait: bool,
    pub json: bool,
}

/// `... (attach: tmux attach -t <session>)` → `<session>`.
fn tmux_session_of(desc: &str) -> Option<String> {
    let rest = desc.split("tmux attach -t ").nth(1)?;
    let s = rest.split(')').next()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// `fleet stack spawn <target> [prompt]`: `ensure` on the target, then a new session in its
/// cwd whose first prompt is the context line + `prompt` (through a prompt file), then wait for
/// it to register and add it.
pub fn spawn(a: SpawnArgs) -> Result<()> {
    let c = Ctx::new()?;
    c.sync()?;
    let src = c.session(&a.target)?;
    let mut opts = a.opts;
    if opts.dir.is_none() {
        opts.dir = Some(src.cwd.clone().ok_or_else(|| {
            Error::Other(format!(
                "no working directory known for {} — pass --dir",
                src.headline()
            ))
        })?);
    }
    // Validate where it lands before creating anything.
    let (dir, backend_kind, name) = opts.resolve()?;
    let model = opts
        .model
        .as_deref()
        .map(commands::clean_model)
        .transpose()?
        .flatten();
    let e = ensure_for(&c, &src, a.label.as_deref(), a.no_llm)?;
    let id = e.stack.id();
    let path = c.path_of(&e.stack);
    let text = stack::stack_prompt(&path, a.prompt.as_deref().unwrap_or_default());
    let hex = id.trim_start_matches("st-");
    let prompt_file = commands::handoff_dir().join(format!(
        "{}-stack-{hex}.md",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    let pf = prompt_file.display().to_string();
    let launcher = commands::with_model(&commands::resolve_launcher(), model.as_deref());
    if hosts::dry_run() {
        let line = backend::launch_command(&dir, Prompt::File(&pf), name.as_deref(), &launcher);
        if a.json {
            return print_json(&json!({
                "dryRun": true,
                "stack": c.view(&e.stack),
                "created": e.created,
                "generated": e.generated,
                "warning": e.warning,
                "spawned": { "desc": format!("dry-run: {line}"), "dir": dir, "promptFile": pf, "tmuxSession": null },
                "session": null,
                "prompt": text,
                "contextLine": stack::context_line(&path),
            }));
        }
        if e.created {
            println!(
                "dry-run: would create stack {} ({}) around {} — not written",
                e.stack.label(),
                id,
                src.headline()
            );
        }
        println!(
            "dry-run: would spawn a {} sibling in stack {}: {line}",
            backend_kind.label(),
            e.stack.label()
        );
        println!(
            "dry-run: first prompt ({} — not written):\n{text}",
            home_rel(&pf)
        );
        return Ok(());
    }
    if let Some(w) = &e.warning
        && !a.json
    {
        eprintln!("{}", format!("warning: {w}").yellow());
    }
    std::fs::create_dir_all(commands::handoff_dir())?;
    std::fs::write(&prompt_file, &text)?;
    let before: HashSet<String> = discovery::discover().iter().map(Session::key).collect();
    let desc = backend::spawn(
        backend_kind,
        &dir,
        Prompt::File(&pf),
        name.as_deref(),
        opts.tmux_session.as_deref(),
        opts.window,
        &launcher,
    )?;
    if !a.json {
        println!(
            "{} {desc} in {} — sibling in stack {} ({}) (prompt: {})",
            "→".cyan(),
            home_rel(&dir),
            e.stack.label().bold(),
            id,
            home_rel(&pf).dimmed()
        );
    }
    let mut joined: Option<Session> = None;
    let mut add_error = None;
    if a.wait {
        match commands::await_new_session(&before, &dir, AWAIT) {
            Some(mut s) => {
                let mut one = vec![s.clone()];
                naming::stamp_titles(&mut one);
                title::stamp_display_titles(&mut one);
                s = one.remove(0);
                match add_to(&c, &id, &s) {
                    Ok(_) => {}
                    Err(err) => add_error = Some(err.to_string()),
                }
                joined = Some(s);
            }
            None => {
                add_error = Some(format!(
                    "the new session has not registered yet — add it later: fleet stack add {id} <session>"
                ));
            }
        }
    }
    let hint = format!(
        "fleet stack add {id} {}",
        name.clone().unwrap_or_else(|| "<new session>".into())
    );
    // Fresh state for the report (the new member, synced names).
    let c = Ctx::new()?;
    c.sync()?;
    let st = stack::load(&c.dir, &id)?.unwrap_or(e.stack.clone());
    if a.json {
        return print_json(&json!({
            "stack": c.view(&st),
            "created": e.created,
            "generated": e.generated,
            "warning": e.warning,
            "spawned": {
                "desc": desc,
                "dir": dir,
                "promptFile": pf,
                "tmuxSession": tmux_session_of(&desc),
            },
            "session": joined.as_ref().map(|s| json!({
                "session_id": s.session_id, "pid": s.pid, "display_title": s.headline(),
            })),
            "addError": add_error,
            "addCommand": (!a.wait).then_some(hint.clone()),
            "contextLine": stack::context_line(&path),
        }));
    }
    match (&joined, &add_error) {
        (Some(s), None) => println!(
            "  joined as {} — steer it with `fleet send {} \"…\"`",
            s.headline().bold(),
            s.label()
        ),
        (_, Some(err)) => println!("  {}", err.yellow()),
        (None, None) => println!("  once it has registered, add it: {}", hint.bold()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmux_session_is_read_off_the_spawn_description() {
        assert_eq!(
            tmux_session_of(
                "spawned tmux session login-tests  (attach: tmux attach -t login-tests)"
            )
            .as_deref(),
            Some("login-tests")
        );
        assert_eq!(tmux_session_of("spawned iTerm tab"), None);
    }
}
